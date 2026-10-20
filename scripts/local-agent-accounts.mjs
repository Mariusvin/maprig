#!/usr/bin/env node
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const LIVE = new Set(['running', 'idle', 'unknown']);
const RUNTIME = { openai: 'codex', claude: 'claude-code' };

export async function switchLocalAccount(options, deps) {
  const { provider, account } = options;
  if (!RUNTIME[provider] || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(account ?? '')) throw Error('invalid_provider_or_account');
  const lease = await deps.store('acquireSwitchLease', [provider]);
  if (!lease?.leaseId) throw Error('account_operation_lock_unavailable');
  try {
    const before = await deps.store('accountStatus', [provider]);
    if (before.recoveryRequired) throw Error('previous_switch_requires_recovery');
    if (before.active === account && before.accounts?.some(a => a.name === account && a.loginPresent)) return { outcome: 'unchanged', provider, active: account };
    return await switchWithLease(options, deps, before);
  }
  finally { await deps.store('releaseSwitchLease', [provider, lease.leaseId]); }
}

async function switchWithLease(options, deps, before) {
  const { provider, account, plan = false, interrupt = false } = options;
  const target = await deps.store('checkAccount', [provider, account]);
  if (!target.loggedIn) throw Error('target_not_signed_in');
  if (!target.fingerprint) throw Error('account_identity_unavailable');
  const nodes = await deps.rig(['ps', '--nodes', '-A', '--json']);
  if (!Array.isArray(nodes)) throw Error('seat_inventory_unavailable');
  const affected = nodes.filter(n => n.runtime === RUNTIME[provider] && LIVE.has(n.sessionStatus));
  const rigs = [...new Set(affected.map(n => n.rigId))];
  const names = new Map(rigs.map(id => [id, nodes.find(n => n.rigId === id)?.rigName]));
  if (rigs.some(id => typeof names.get(id) !== 'string' || !names.get(id) || nodes.some(n => n.rigId !== id && n.rigName === names.get(id)))) throw Error('rig_name_unavailable_or_ambiguous');
  const peers = nodes.filter(n => rigs.includes(n.rigId) && n.runtime !== 'terminal' && LIVE.has(n.sessionStatus));
  if (peers.some(n => !n.resumeTokenPresent)) throw Error('conversation_unavailable');
  if (!interrupt && peers.some(n => !['idle', 'needs_input'].includes(n.agentActivity?.state))) throw Error('seat_working_or_unknown');
  const summary = { provider, from: before.active, active: account, rigs, affectedSeats: peers.map(n => n.canonicalSessionName), sharedRigRestart: true };
  if (plan) return { ...summary, outcome: 'plan' };
  const stopped = [];
  let activated = false;
  let activationAttempted = false;
  let stopping = null;
  try {
    for (const rig of rigs) {
      stopping = rig;
      const down = await deps.rig(['down', rig, '--snapshot', '--json']);
      stopped.push(rig);
      stopping = null;
      if (!down.snapshotId || down.errors?.length) throw Error('snapshot_or_stop_incomplete');
    }
    await deps.store('assertNoNativeProcesses', [provider]);
    // Recheck after stopping: a concurrent selection must never be overwritten.
    if ((await deps.store('accountStatus', [provider])).active !== before.active) throw Error('account_selection_changed');
    activationAttempted = true;
    await deps.store('activateAccount', [provider, account]);
    activated = true;
    const selected = await deps.store('checkAccount', [provider, account]);
    if (!selected.loggedIn || selected.fingerprint !== target.fingerprint) throw Error('selected_account_unverified');
    const restored = [];
    for (const rig of stopped) {
      const up = await deps.rig(['up', names.get(rig), '--existing', '--json']);
      const expected = peers.filter(n => n.rigId === rig);
      if (up.rigId !== rig || !Array.isArray(up.nodes) || expected.some(old => !up.nodes.some(n => n.logicalId === old.logicalId && n.status === 'resumed'))) throw Error('native_continuity_unconfirmed');
      restored.push(rig);
    }
    return { ...summary, outcome: 'resumed', restored };
  } catch (error) {
    // Writes and restore timeouts have unknown outcomes. Do not retry or silently
    // restore with another account. Keep every native home for explicit recovery.
    let observed = activated ? account : before.active;
    if (activationAttempted) {
      try { const status = await deps.store('accountStatus', [provider]); observed = status.recoveryRequired ? null : status.active; }
      catch { observed = null; }
    }
    return { ...summary, active: observed, outcome: 'incomplete',
      reason: /^[a-z_]+$/.test(error.message) ? error.message : 'operation_outcome_unknown',
      stoppedRigs: stopped, stopOutcomeUnknown: stopping, rigNames: Object.fromEntries(names), recovery: 'Inspect account status and rig ps before retrying. Resume stopped rigs with rig up <rig-name> --existing; never use a fresh launch to recover this switch.' };
  }
}

function jsonProcess(command, args, input, timeout = 20_000) {
  const result = spawnSync(command, args, { input, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (result.error || result.signal) throw Error('operation_outcome_unknown');
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw Error('operation_response_unreadable'); }
  if (result.status !== 0) {
    const message = typeof data.error === 'string' && /^[a-z_]+$/.test(data.error) ? data.error : 'operation_failed';
    throw Error(message);
  }
  return data;
}

export function dockerDependencies(container = 'openrig-isolated') {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) throw Error('invalid_container');
  const source = fs.readFileSync(new URL('./local-agent-account-store.mjs', import.meta.url), 'utf8');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const managerUrl = `data:text/javascript;base64,${Buffer.from(fs.readFileSync(new URL('./local-agent-accounts.mjs', import.meta.url))).toString('base64')}`;
  const allowed = new Set(['accountStatus', 'prepareAccount', 'checkAccount', 'activateAccount', 'assertNoNativeProcesses', 'recoverAccount', 'acquireSwitchLease', 'releaseSwitchLease']);
  return {
    switch: async options => {
      // Keep the lease owner alive in one container process for the entire
      // operation. A dead owner is then recoverable without a time-based lease.
      const script = `try { const store=await import(${JSON.stringify(moduleUrl)}); const manager=await import(${JSON.stringify(managerUrl)}); const result=await manager.switchLocalAccount(${JSON.stringify(options)}, {store:async(method,args)=>store[method](...args),rig:async args=>manager.localRig(args)}); console.log(JSON.stringify(result)); } catch(e) { console.log(JSON.stringify({error:/^[a-z_]+$/.test(e.message)?e.message:'account_operation_failed'})); process.exitCode=1; }`;
      return jsonProcess('docker', ['exec', '-i', container, 'node', '--input-type=module'], script, 600_000);
    },
    store: async (method, args) => {
      if (!allowed.has(method)) throw Error('invalid_account_operation');
      const script = `try { const store=await import(${JSON.stringify(moduleUrl)}); const result=store[${JSON.stringify(method)}](...${JSON.stringify(args)}); console.log(JSON.stringify(result)); } catch(e) { console.log(JSON.stringify({error:/^[a-z_]+$/.test(e.message)?e.message:'account_operation_failed'})); process.exitCode=1; }`;
      return jsonProcess('docker', ['exec', '-i', container, 'node', '--input-type=module'], script);
    },
    rig: async args => jsonProcess('docker', ['exec', container, 'rig', ...args], undefined, ['up', 'down'].includes(args[0]) ? 150_000 : 20_000),
    login: async (provider, prepared, browser) => {
      const flags = process.stdin.isTTY && process.stdout.isTTY ? ['-it'] : ['-i'];
      const command = provider === 'claude' ? ['claude', 'auth', 'login', '--claudeai'] : ['codex', 'login', ...(browser ? [] : ['--device-auth'])];
      // Native login owns its browser prompt and private token writes. This
      // process never captures or persists the login's output.
      await new Promise((resolve, reject) => {
        const unset = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].flatMap(key => ['-u', key]);
        const child = spawn('docker', ['exec', ...flags, '-e', `${prepared.variable}=${prepared.home}`, container, 'env', ...unset, ...command], { stdio: 'inherit', windowsHide: true });
        child.on('error', () => reject(Error('native_login_unavailable')));
        child.on('exit', code => code === 0 ? resolve() : reject(Error('native_login_incomplete')));
      });
    },
  };
}

export function localRig(args) {
  return jsonProcess('rig', args, undefined, ['up', 'down'].includes(args[0]) ? 150_000 : 20_000);
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    provider: { type: 'string' }, container: { type: 'string', default: 'openrig-isolated' },
    plan: { type: 'boolean' }, interrupt: { type: 'boolean' }, browser: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) {
    console.log('Local subscription accounts for the existing Docker installation.\nUsage: node scripts/local-agent-accounts.mjs <list|add|switch|recover> [account] --provider <openai|claude> [--container <name>] [--plan] [--interrupt]\nAdd signs in once in an isolated native home. Switch uses saved logins, snapshots affected rigs and resumes their conversations. It never logs an account out. Recover rolls an interrupted credential selection back while native processes are stopped. --interrupt explicitly allows stopping busy or unknown peers. --browser selects ordinary browser login for the first provider.');
    return;
  }
  const [action, account] = positionals;
  if (!RUNTIME[values.provider] || !['list', 'add', 'switch', 'recover'].includes(action)) throw Error('invalid_provider_or_action');
  if (positionals.length !== (['add', 'switch'].includes(action) ? 2 : 1)) throw Error('invalid_arguments');
  if (((values.plan || values.interrupt) && action !== 'switch') || (values.browser && action !== 'add')) throw Error('invalid_action_option');
  const deps = dockerDependencies(values.container);
  let result;
  if (action === 'list') result = await deps.store('accountStatus', [values.provider]);
  else if (action === 'recover') result = await deps.store('recoverAccount', [values.provider]);
  else if (action === 'add') {
    const prepared = await deps.store('prepareAccount', [values.provider, account]);
    await deps.login(values.provider, prepared, values.browser);
    const checked = await deps.store('checkAccount', [values.provider, account]);
    if (!checked.loggedIn) throw Error('native_subscription_login_unverified');
    result = { provider: values.provider, name: account, outcome: 'signed_in', activeAccountUnchanged: true };
  } else result = await deps.switch({ provider: values.provider, account, plan: values.plan, interrupt: values.interrupt });
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome === 'incomplete') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ error: /^[a-z_]+$/.test(error.message) ? error.message : 'account_command_failed' }));
    process.exitCode = 1;
  });
}
