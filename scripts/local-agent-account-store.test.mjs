import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { accountHome, accountStatus, activateAccount as activate, prepareAccount, acquireSwitchLease, releaseSwitchLease, recoverAccount, assertNoNativeProcesses, checkAccount } from './local-agent-account-store.mjs';
const activateAccount = (provider, name, env) => activate(provider, name, env, { assertStopped() {} });

function fixture(t, provider = 'claude') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-accounts-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home, OPENRIG_HOME: path.join(home, '.openrig') };
  const native = path.join(home, provider === 'claude' ? '.claude' : '.codex');
  fs.mkdirSync(native, { mode: 0o700 });
  return { env, native, provider };
}

test('enrolling an account leaves the existing login and conversations untouched', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.native, '.credentials.json'), 'fixture-primary-credential');
  const next = prepareAccount(f.provider, 'second', f.env);
  assert.equal(fs.lstatSync(f.native).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(f.native, '.credentials.json'), 'utf8'), 'fixture-primary-credential');
  assert.notEqual(next.home, f.native);
  assert.equal(fs.existsSync(path.join(next.home, '.credentials.json')), false);
  assert.equal(accountStatus(f.provider, f.env).active, 'primary');
});

test('switching away and back retains native refresh updates in the original account', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.native, '.credentials.json'), 'fixture-primary-v1');
  const next = prepareAccount(f.provider, 'second', f.env);
  fs.writeFileSync(path.join(next.home, '.credentials.json'), 'fixture-second-v1');
  activateAccount(f.provider, 'second', f.env);
  fs.writeFileSync(path.join(f.native, '.credentials.json'), 'fixture-second-refreshed');
  activateAccount(f.provider, 'primary', f.env);
  assert.equal(fs.readFileSync(path.join(f.native, '.credentials.json'), 'utf8'), 'fixture-primary-v1');
  activateAccount(f.provider, 'second', f.env);
  assert.equal(fs.readFileSync(path.join(f.native, '.credentials.json'), 'utf8'), 'fixture-second-refreshed');
  assert(!JSON.stringify(accountStatus(f.provider, f.env)).includes('credential'));
});

for (const provider of ['claude', 'openai']) {
  test(`${provider} keeps the same native conversation store across account changes`, t => {
    const f = fixture(t, provider);
    const history = provider === 'claude' ? 'projects' : 'sessions';
    const credential = provider === 'claude' ? '.credentials.json' : 'auth.json';
    fs.mkdirSync(path.join(f.native, history));
    fs.writeFileSync(path.join(f.native, history, 'conversation.jsonl'), 'fixture-history');
    fs.writeFileSync(path.join(f.native, credential), '{}');
    if (provider === 'openai') fs.writeFileSync(path.join(f.native, 'state_5.sqlite'), 'fixture-database');
    const next = prepareAccount(provider, 'second', f.env);
    fs.writeFileSync(path.join(next.home, credential), '{}');
    const switched = activateAccount(provider, 'second', f.env);
    assert.equal(switched.active, 'second');
    assert.equal(fs.readFileSync(path.join(f.native, history, 'conversation.jsonl'), 'utf8'), 'fixture-history');
    fs.writeFileSync(path.join(f.native, history, 'answer.jsonl'), 'fixture-answer');
    activateAccount(provider, 'primary', f.env);
    assert.equal(fs.readFileSync(path.join(f.native, history, 'answer.jsonl'), 'utf8'), 'fixture-answer');
    if (provider === 'openai') assert.equal(fs.readFileSync(path.join(f.native, 'state_5.sqlite'), 'utf8'), 'fixture-database');
  });
}

test('rejects unsafe names, missing logins and unowned native-home links', t => {
  const f = fixture(t);
  assert.throws(() => prepareAccount('claude', '../outside', f.env), /invalid_account/);
  prepareAccount('claude', 'second', f.env);
  assert.throws(() => activateAccount('claude', 'second', f.env), /account_not_signed_in/);
  assert.equal(fs.lstatSync(f.native).isSymbolicLink(), false);
  fs.rmSync(f.native, { recursive: true });
  fs.symlinkSync(os.tmpdir(), f.native, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => accountStatus('claude', f.env), /unsafe_account_directory/);
});

test('leaves independent enrollment history alone and never relocates native history', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.native, 'projects'));
  const next = prepareAccount('claude', 'second', f.env);
  fs.mkdirSync(path.join(next.home, 'projects'));
  fs.writeFileSync(path.join(next.home, '.credentials.json'), '{}');
  fs.writeFileSync(path.join(next.home, 'projects', 'enrollment.jsonl'), 'fixture-independent');
  activateAccount('claude', 'second', f.env);
  assert.equal(fs.lstatSync(f.native).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(next.home, 'projects', 'enrollment.jsonl'), 'utf8'), 'fixture-independent');
  assert.equal(fs.existsSync(path.join(f.native, 'projects', 'enrollment.jsonl')), false);
});

test('account locations respect explicit native homes and refuse linked vault directories', t => {
  const f = fixture(t);
  f.env.CLAUDE_CONFIG_DIR = path.join(f.env.HOME, 'custom-claude');
  fs.mkdirSync(f.env.CLAUDE_CONFIG_DIR);
  const next = prepareAccount('claude', 'second', f.env);
  assert.equal(accountHome('claude', 'second', f.env), next.home);
  assert.equal(accountStatus('claude', f.env).nativeHome, f.env.CLAUDE_CONFIG_DIR);
  const root = path.join(f.env.OPENRIG_HOME, 'account-homes', 'claude');
  fs.renameSync(root, `${root}-outside`);
  fs.symlinkSync(`${root}-outside`, root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareAccount('claude', 'third', f.env), /unsafe_account_directory/);
});

test('Claude selection changes account identity but preserves active trust and history settings', t => {
  const f = fixture(t);
  const original = { oauthAccount: { accountUuid: 'fixture-one' }, projects: { '/fixture': { trusted: true } } };
  fs.writeFileSync(path.join(f.env.HOME, '.claude.json'), JSON.stringify(original));
  fs.writeFileSync(path.join(f.native, '.credentials.json'), 'fixture-one-login');
  const second = prepareAccount('claude', 'second', f.env);
  fs.writeFileSync(path.join(second.home, '.credentials.json'), 'fixture-two-login');
  fs.writeFileSync(path.join(second.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'fixture-two' }, projects: { '/unrelated': {} } }));
  activateAccount('claude', 'second', f.env);
  const active = JSON.parse(fs.readFileSync(path.join(f.env.HOME, '.claude.json'), 'utf8'));
  assert.equal(active.oauthAccount.accountUuid, 'fixture-two');
  assert.deepEqual(active.projects, original.projects);
  activateAccount('claude', 'primary', f.env);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.env.HOME, '.claude.json'), 'utf8')), original);
});

test('process guards and pending journals stop selection before any auth writes', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.native, '.credentials.json'), 'fixture-primary');
  const second = prepareAccount('claude', 'second', f.env);
  fs.writeFileSync(path.join(second.home, '.credentials.json'), 'fixture-second');
  assert.throws(() => activate('claude', 'second', f.env, { assertStopped() { throw Error('native_processes_still_running'); } }), /native_processes_still_running/);
  assert.equal(fs.readFileSync(path.join(f.native, '.credentials.json'), 'utf8'), 'fixture-primary');
  fs.writeFileSync(path.join(f.env.OPENRIG_HOME, 'account-homes', 'claude', '.switch-pending'), '{}');
  assert.throws(() => activateAccount('claude', 'second', f.env), /previous_switch_requires_recovery/);
  assert.equal(fs.readFileSync(path.join(f.native, '.credentials.json'), 'utf8'), 'fixture-primary');
});

test('operation lease serializes concurrent switch commands and validates its owner', t => {
  const f = fixture(t);
  const lease = acquireSwitchLease('claude', f.env);
  assert.throws(() => acquireSwitchLease('claude', f.env), /account_operation_in_progress/);
  assert.throws(() => releaseSwitchLease('claude', 'wrong-owner', f.env), /account_operation_owner_changed/);
  releaseSwitchLease('claude', lease.leaseId, f.env);
  const next = acquireSwitchLease('claude', f.env);
  releaseSwitchLease('claude', next.leaseId, f.env);
});

test('recovery rolls an interrupted multi-file switch back without logging either account out', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.native, '.credentials.json'), 'fixture-primary');
  fs.writeFileSync(path.join(f.env.HOME, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'fixture-primary' }, projects: {} }));
  const second = prepareAccount('claude', 'second', f.env);
  fs.writeFileSync(path.join(second.home, '.credentials.json'), 'fixture-second');
  fs.writeFileSync(path.join(second.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'fixture-second' } }));
  activateAccount('claude', 'second', f.env);
  const root = path.dirname(second.home);
  fs.writeFileSync(path.join(root, '.switch-pending'), JSON.stringify({ from: 'primary', to: 'second', hadLogin: true, hadState: true }));
  assert.equal(accountStatus('claude', f.env).recoveryRequired, true);
  const recovered = recoverAccount('claude', f.env, { assertStopped() {} });
  assert.equal(recovered.active, 'primary');
  assert.equal(fs.readFileSync(path.join(f.native, '.credentials.json'), 'utf8'), 'fixture-primary');
  assert.equal(fs.readFileSync(path.join(second.home, '.credentials.json'), 'utf8'), 'fixture-second');
  assert.equal(accountStatus('claude', f.env).recoveryRequired, false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.native, '.credentials.json')).mode & 0o777, 0o600);
});

test('unsafe hardlinked incoming credentials are rejected without exposing their bytes', t => {
  const f = fixture(t);
  const second = prepareAccount('claude', 'second', f.env);
  const sentinel = 'fixture-private-login-material';
  const external = path.join(f.env.HOME, 'external-login');
  fs.writeFileSync(external, sentinel);
  fs.linkSync(external, path.join(second.home, '.credentials.json'));
  assert.throws(() => activateAccount('claude', 'second', f.env), error => !error.message.includes(sentinel) && /unsafe_credential_file/.test(error.message));
});

test('primary is reserved even before the first native login exists', t => {
  const f = fixture(t);
  assert.throws(() => prepareAccount('claude', 'primary', f.env), /primary_reserved_for_original_login/);
  const second = prepareAccount('claude', 'work', f.env);
  fs.writeFileSync(path.join(second.home, '.credentials.json'), 'fixture-first-login');
  fs.writeFileSync(path.join(second.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'fixture-first' } }));
  activateAccount('claude', 'work', f.env);
  assert.equal(accountStatus('claude', f.env).active, 'work');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.env.HOME, '.claude.json'))).oauthAccount.accountUuid, 'fixture-first');
});

test('a killed owner leaves recoverable locks and a journal, without losing either login', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.native, '.credentials.json'), 'fixture-before');
  const second = prepareAccount('claude', 'second', f.env);
  fs.writeFileSync(path.join(second.home, '.credentials.json'), 'fixture-after');
  const script = `import fs from 'node:fs';
    import { acquireSwitchLease, activateAccount } from ${JSON.stringify(new URL('./local-agent-account-store.mjs', import.meta.url).href)};
    const env=${JSON.stringify(f.env)};
    acquireSwitchLease('claude',env);
    const original=fs.renameSync;
    fs.renameSync=(from,to)=>{ original(from,to); if(to===${JSON.stringify(path.join(f.native, '.credentials.json'))}) process.kill(process.pid,'SIGKILL'); };
    activateAccount('claude','second',env,{assertStopped(){}});`;
  const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
  assert.equal(killed.signal, 'SIGKILL');
  assert.equal(accountStatus('claude', f.env).recoveryRequired, true);
  assert.equal(recoverAccount('claude', f.env, { assertStopped() {} }).outcome, 'rolled_back');
  assert.equal(fs.readFileSync(path.join(f.native, '.credentials.json'), 'utf8'), 'fixture-before');
  assert.equal(fs.readFileSync(path.join(second.home, '.credentials.json'), 'utf8'), 'fixture-after');
  assert.equal(fs.existsSync(path.join(path.dirname(second.home), '.operation-lock')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(second.home), '.switch-lock')), false);
  activateAccount('claude', 'second', f.env);
});

test('dead operation owners are recoverable even before a journal exists', { skip: process.platform !== 'linux' }, t => {
  const f = fixture(t);
  const script = `import {acquireSwitchLease} from ${JSON.stringify(new URL('./local-agent-account-store.mjs', import.meta.url).href)}; acquireSwitchLease('claude',${JSON.stringify(f.env)});`;
  assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', script]).status, 0);
  assert.equal(recoverAccount('claude', f.env).outcome, 'no_recovery_needed');
  const lease = acquireSwitchLease('claude', f.env);
  releaseSwitchLease('claude', lease.leaseId, f.env);
});

test('the actual Linux process scan detects a running provider', { skip: process.platform !== 'linux' }, async t => {
  const child = spawn(process.execPath, ['-e', "process.title='claude'; console.log('ready'); setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => child.kill('SIGKILL'));
  await once(child.stdout, 'data');
  assert.throws(() => assertNoNativeProcesses('claude'), /native_processes_still_running/);
});

for (const provider of ['claude', 'openai']) {
  test(`${provider} auth probes suppress secrets and return a stable identity fingerprint`, { skip: process.platform === 'win32' }, t => {
    const f = fixture(t, provider);
    const bin = path.join(f.env.HOME, 'bin');
    fs.mkdirSync(bin);
    const name = provider === 'claude' ? 'claude' : 'codex';
    const sentinel = 'fixture-secret-output-must-stay-private';
    const output = provider === 'claude' ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'fixture@example.invalid', orgId: 'fixture-org' }) : 'Logged in using ChatGPT';
    fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\nif(process.env.OPENAI_API_KEY||process.env.ANTHROPIC_AUTH_TOKEN) process.exit(1); console.log(${JSON.stringify(output)}); console.error(${JSON.stringify(sentinel)});`, { mode: 0o700 });
    f.env.PATH = bin;
    f.env.OPENAI_API_KEY = sentinel;
    f.env.ANTHROPIC_AUTH_TOKEN = sentinel;
    fs.writeFileSync(path.join(f.native, provider === 'claude' ? '.credentials.json' : 'auth.json'), JSON.stringify({ tokens: { account_id: 'fixture-account', access_token: sentinel } }));
    const checked = checkAccount(provider, 'primary', f.env);
    assert.equal(checked.loggedIn, true);
    assert.match(checked.fingerprint, /^[a-f0-9]{64}$/);
    assert(!JSON.stringify(checked).includes(sentinel));
    assert(!JSON.stringify(checked).includes('example.invalid'));
    assert(!JSON.stringify(accountStatus(provider, f.env)).includes(sentinel));
  });
}
