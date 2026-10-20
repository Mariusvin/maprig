import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main, switchLocalAccount } from './local-agent-accounts.mjs';

function harness(overrides = {}) {
  const effects = [];
  const deps = {
    store: async (method, args) => {
      effects.push(['store', method, args]);
      if (method === 'accountStatus') return { active: 'primary', accounts: [{ name: 'second', loginPresent: true }] };
      if (method === 'checkAccount') return { loggedIn: true, fingerprint: 'fixture-identity' };
      if (method === 'acquireSwitchLease') return { leaseId: 'fixture-lease' };
      if (method === 'activateAccount') return { active: 'second', changed: true };
    },
    rig: async args => {
      effects.push(['rig', args]);
      if (args[0] === 'ps') return [{ rigId: 'rig-1', rigName: 'test-team', logicalId: 'build.agent', runtime: 'claude-code', canonicalSessionName: 'build@test-team', sessionStatus: 'running', resumeTokenPresent: true, agentActivity: { state: 'idle' } }];
      if (args[0] === 'down') return { sessionsKilled: 1, snapshotId: 'snapshot-1', errors: [] };
      if (args[0] === 'up') return { status: 'restored', rigId: 'rig-1', nodes: [{ logicalId: 'build.agent', status: 'resumed' }] };
    },
    ...overrides,
  };
  return { deps, effects };
}

test('one switch stops with a snapshot before selection, then resumes existing rigs', async () => {
  const { deps, effects } = harness();
  const result = await switchLocalAccount({ provider: 'claude', account: 'second' }, deps);
  assert.equal(result.active, 'second');
  assert.equal(result.outcome, 'resumed');
  const down = effects.findIndex(e => e[0] === 'rig' && e[1][0] === 'down');
  const activate = effects.findIndex(e => e[0] === 'store' && e[1] === 'activateAccount');
  const up = effects.findIndex(e => e[0] === 'rig' && e[1][0] === 'up');
  assert(down < activate && activate < up);
  assert(effects[up][1].includes('--existing'));
  assert.equal(effects[up][1][1], 'test-team');
  assert(effects.find(e => e[0] === 'rig' && e[1][0] === 'ps')[1].includes('-A'));
  assert(!JSON.stringify(effects).includes('logout'));
});

test('a plan has no stop, login, selection or restore effects', async () => {
  const { deps, effects } = harness();
  const result = await switchLocalAccount({ provider: 'claude', account: 'second', plan: true }, deps);
  assert.equal(result.outcome, 'plan');
  assert(!effects.some(e => e[0] === 'rig' && ['down', 'up'].includes(e[1][0])));
  assert(!effects.some(e => e[1] === 'activateAccount'));
});

test('a missing login does not stop any team', async () => {
  const { deps, effects } = harness({ store: async method => method === 'accountStatus' ? { active: 'primary' } : method === 'acquireSwitchLease' ? { leaseId: 'fixture-lease' } : { loggedIn: false } });
  await assert.rejects(switchLocalAccount({ provider: 'claude', account: 'second' }, deps), /target_not_signed_in/);
  assert.equal(effects.length, 0);
});

test('busy peers and missing native conversation IDs refuse before stopping', async () => {
  for (const change of [{ agentActivity: { state: 'running' } }, { resumeTokenPresent: false }, { agentActivity: { state: 'unknown' } }]) {
    const { deps, effects } = harness();
    const base = await deps.rig(['ps']);
    deps.rig = async args => { effects.push(['rig', args]); return base.map(n => ({ ...n, ...change })); };
    await assert.rejects(switchLocalAccount({ provider: 'claude', account: 'second' }, deps), /working_or_unknown|conversation_unavailable/);
    assert(!effects.some(e => e[0] === 'rig' && e[1][0] === 'down'));
  }
});

test('a snapshot failure leaves account selection unchanged', async () => {
  const { deps, effects } = harness();
  const base = deps.rig;
  deps.rig = async args => args[0] === 'down' ? { snapshotId: null, errors: ['fixture-snapshot-failure'] } : base(args);
  const result = await switchLocalAccount({ provider: 'claude', account: 'second' }, deps);
  assert.equal(result.outcome, 'incomplete');
  assert(!effects.some(e => e[1] === 'activateAccount'));
});

test('an unconfirmed restore is reported without rerunning it or claiming success', async () => {
  const { deps, effects } = harness();
  const base = deps.rig;
  deps.rig = async args => { if (args[0] === 'up') { effects.push(['rig', args]); throw Error('fixture-timeout'); } return base(args); };
  const result = await switchLocalAccount({ provider: 'claude', account: 'second' }, deps);
  assert.equal(result.outcome, 'incomplete');
  assert.equal(effects.filter(e => e[0] === 'rig' && e[1][0] === 'up').length, 1);
});

test('an activation response loss reports the observed account, never assumes nondelivery', async () => {
  const { deps, effects } = harness();
  const base = deps.store;
  let selected = false;
  deps.store = async (method, args) => {
    if (method === 'activateAccount') { selected = true; throw Error('fixture-response-lost'); }
    if (method === 'accountStatus' && selected) return { active: 'second', recoveryRequired: false };
    return base(method, args);
  };
  const result = await switchLocalAccount({ provider: 'claude', account: 'second' }, deps);
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.active, 'second');
  assert(!effects.some(e => e[0] === 'rig' && e[1][0] === 'up'));
});

test('pending recovery and concurrent operations refuse before any seat stops', async () => {
  for (const code of ['previous_switch_requires_recovery', 'account_operation_in_progress']) {
    const { deps, effects } = harness();
    const base = deps.store;
    deps.store = async (method, args) => {
      if (code === 'previous_switch_requires_recovery' && method === 'accountStatus') return { active: 'primary', recoveryRequired: true };
      if (code === 'account_operation_in_progress' && method === 'acquireSwitchLease') throw Error(code);
      return base(method, args);
    };
    await assert.rejects(switchLocalAccount({ provider: 'claude', account: 'second' }, deps), new RegExp(code));
    assert(!effects.some(e => e[0] === 'rig'));
  }
});

test('selection is read under the lease, including an unchanged selection', async () => {
  const { deps, effects } = harness();
  const base = deps.store;
  deps.store = async (method, args) => method === 'accountStatus' ? { active: 'second', accounts: [{ name: 'second', loginPresent: true }] } : base(method, args);
  const result = await switchLocalAccount({ provider: 'claude', account: 'second' }, deps);
  assert.equal(result.outcome, 'unchanged');
  assert.equal(effects[0][1], 'acquireSwitchLease');
  assert(!effects.some(e => e[0] === 'rig'));
  assert.equal(effects.at(-1)[1], 'releaseSwitchLease');
});

test('an account fingerprint mismatch prevents native resume', async () => {
  const { deps, effects } = harness();
  const base = deps.store;
  let probes = 0;
  deps.store = async (method, args) => method === 'checkAccount' ? { loggedIn: true, fingerprint: ++probes === 1 ? 'fixture-one' : 'fixture-other' } : base(method, args);
  const result = await switchLocalAccount({ provider: 'claude', account: 'second' }, deps);
  assert.equal(result.outcome, 'incomplete');
  assert.equal(result.reason, 'selected_account_unverified');
  assert(!effects.some(e => e[0] === 'rig' && e[1][0] === 'up'));
});

test('ambiguous down responses identify the rig whose stop outcome is unknown', async () => {
  const { deps } = harness();
  const base = deps.rig;
  deps.rig = async args => { if (args[0] === 'down') throw Error('operation_outcome_unknown'); return base(args); };
  const result = await switchLocalAccount({ provider: 'claude', account: 'second' }, deps);
  assert.equal(result.stopOutcomeUnknown, 'rig-1');
  assert.equal(result.outcome, 'incomplete');
});

test('invalid option/action combinations fail before connecting to Docker', async () => {
  for (const args of [['add', 'work', '--plan'], ['recover', '--interrupt'], ['list', 'extra'], ['switch', 'work', '--browser']]) {
    await assert.rejects(main([...args, '--provider', 'claude']), /invalid_action_option|invalid_arguments/);
  }
});

test('Docker transport keeps a live lock owner through native selection and rig resume', { skip: process.platform !== 'linux' }, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'account-transport-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  const native = path.join(home, '.codex');
  const selected = path.join(home, '.openrig', 'account-homes', 'openai', 'second');
  fs.mkdirSync(bin);
  fs.mkdirSync(native);
  fs.mkdirSync(selected, { recursive: true });
  const credential = name => JSON.stringify({ tokens: { account_id: name, access_token: 'fixture-private-transport-token' } });
  fs.writeFileSync(path.join(native, 'auth.json'), credential('fixture-one'));
  fs.writeFileSync(path.join(selected, 'auth.json'), credential('fixture-two'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nshift\nif [ "$1" = "-i" ]; then shift; fi\nshift\nexec "$@"\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}\nconsole.log('Logged in using ChatGPT');`, { mode: 0o700 });
  const rig = `#!${process.execPath}
    const fs=require('node:fs'), path=require('node:path');
    const action=process.argv[2];
    fs.appendFileSync(path.join(process.env.HOME,'rig-calls'),action+'\\n');
    let result;
    if(action==='ps') { if(!process.argv.includes('-A')) process.exit(1); result=[{rigId:'fixture-rig',rigName:'fixture-team',logicalId:'build.agent',runtime:'codex',canonicalSessionName:'build@fixture',sessionStatus:'running',resumeTokenPresent:true,agentActivity:{state:'idle'}}]; }
    if(action==='down') result={snapshotId:'fixture-snapshot',errors:[]};
    if(action==='up') {
      if(!process.argv.includes('--existing')||process.argv[3]!=='fixture-team') process.exit(1);
      result={rigId:'fixture-rig',nodes:[{logicalId:'build.agent',status:'resumed'}]};
    }
    console.log(JSON.stringify(result));`;
  fs.writeFileSync(path.join(bin, 'rig'), rig, { mode: 0o700 });
  const script = `import {dockerDependencies} from ${JSON.stringify(new URL('./local-agent-accounts.mjs', import.meta.url).href)};
    console.log(JSON.stringify(await dockerDependencies().switch({provider:'openai',account:'second'})));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, OPENRIG_HOME: path.join(home, '.openrig'), CODEX_HOME: native, PATH: `${bin}:/usr/bin:/bin` },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome, 'resumed');
  assert.equal(fs.readFileSync(path.join(home, 'rig-calls'), 'utf8'), 'ps\ndown\nup\n');
  assert.equal(fs.readFileSync(path.join(native, 'auth.json'), 'utf8'), credential('fixture-two'));
  assert(!result.stdout.includes('fixture-private-transport-token'));
  assert.equal(fs.existsSync(path.join(path.dirname(selected), '.operation-lock')), false);
});
