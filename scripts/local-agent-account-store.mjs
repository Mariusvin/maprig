import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Login data stays CLI-local. Native history never moves between account homes.
const PROVIDERS = {
  openai: { command: 'codex', variable: 'CODEX_HOME', directory: '.codex', credential: 'auth.json' },
  claude: { command: 'claude', variable: 'CLAUDE_CONFIG_DIR', directory: '.claude', credential: '.credentials.json' },
};
const validName = name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name);
const fixedError = error => /^[a-z_]+$/.test(error.message) ? error : Error('account_storage_unavailable');
function stat(file) { try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw Error('account_storage_unavailable'); } }
function directory(file, create = false) {
  const parent = path.dirname(file);
  if (parent !== file) directory(parent, create);
  const value = stat(file);
  if (value && (!value.isDirectory() || value.isSymbolicLink())) throw Error('unsafe_account_directory');
  if (!value && create) fs.mkdirSync(file, { mode: 0o700 });
}
export function accountLayout(provider, env = process.env) {
  const spec = PROVIDERS[provider];
  if (!spec) throw Error('unsupported_provider');
  const home = env.HOME || os.homedir();
  const nativeHome = env[spec.variable] || path.join(home, spec.directory);
  const instance = env.OPENRIG_HOME || path.join(home, '.openrig');
  if (!path.isAbsolute(nativeHome) || !path.isAbsolute(instance)) throw Error('absolute_account_home_required');
  const root = path.join(instance, 'account-homes', provider);
  if (nativeHome === root || nativeHome.startsWith(root + path.sep) || root.startsWith(nativeHome + path.sep)) throw Error('overlapping_account_homes');
  return { ...spec, provider, nativeHome, root, statePath: provider === 'claude' ? path.join(env.CLAUDE_CONFIG_DIR ? nativeHome : home, '.claude.json') : null };
}
export function accountHome(provider, name, env = process.env) {
  if (!validName(name)) throw Error('invalid_account');
  return path.join(accountLayout(provider, env).root, name);
}
function safeFile(file, required = false) {
  const value = stat(file);
  if (value && (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1)) throw Error('unsafe_credential_file');
  if (!value && required) throw Error('account_not_signed_in');
  return value;
}
function readPrivate(file) {
  const expected = safeFile(file, true);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fs.fstatSync(fd);
    if (!actual.isFile() || actual.nlink !== 1 || actual.ino !== expected.ino || actual.dev !== expected.dev || actual.size > 1024 * 1024) throw Error('unsafe_credential_file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function writePrivate(file, bytes) {
  directory(path.dirname(file), true);
  safeFile(file);
  const temporary = `${file}.pending-${randomUUID()}`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    safeFile(file); fs.renameSync(temporary, file);
  }
  finally { if (stat(temporary)) fs.unlinkSync(temporary); }
}
function activeName(layout) {
  directory(layout.root);
  directory(layout.nativeHome);
  const file = path.join(layout.root, '.active-account');
  if (!stat(file)) return 'primary';
  const name = readPrivate(file).toString('utf8').trim();
  if (!validName(name)) throw Error('invalid_active_account');
  return name;
}
export function accountStatus(provider, env = process.env) {
  const layout = accountLayout(provider, env), active = activeName(layout);
  const names = stat(layout.root) ? fs.readdirSync(layout.root).filter(validName) : [];
  const accounts = [...new Set([active, ...names])].filter(name => name === active || stat(path.join(layout.root, name))?.isDirectory()).map(name => {
    const home = name === active ? layout.nativeHome : path.join(layout.root, name);
    directory(home);
    return { name, active: name === active, loginPresent: Boolean(safeFile(path.join(home, layout.credential))) };
  });
  return { provider, active, nativeHome: layout.nativeHome, recoveryRequired: Boolean(stat(path.join(layout.root, '.switch-pending'))), accounts };
}
function processIdentity(pid) {
  // Linux start ticks distinguish a living owner from a reused process ID.
  try {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
    return fields[0] === 'Z' ? null : fields[19];
  } catch (error) {
    if (error.code === 'ENOENT' && process.platform === 'linux') return null;
    throw Error('lock_owner_unavailable');
  }
}
function lockOwner(file) {
  // The Linux lock's target is metadata, never a path to follow. Creating this
  // symlink is atomic, including its owner data, even if killed immediately.
  if (process.platform === 'linux') {
    if (!stat(file)?.isSymbolicLink()) throw Error('invalid_lock_owner');
    try { return JSON.parse(fs.readlinkSync(file)); } catch { throw Error('invalid_lock_owner'); }
  }
  return state(file);
}
function lockFile(file, busy) {
  directory(path.dirname(file), true);
  const leaseId = randomUUID();
  const owner = { leaseId, pid: process.pid, start: process.platform === 'linux' ? processIdentity(process.pid) : null };
  const create = () => {
    if (process.platform === 'linux') fs.symlinkSync(JSON.stringify(owner), file);
    else {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  };
  try { create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw Error('account_storage_unavailable');
    const previous = lockOwner(file);
    if (!Number.isInteger(previous.pid) || typeof previous.start !== 'string' || process.platform !== 'linux') throw Error(busy);
    if (processIdentity(previous.pid) === previous.start) throw Error(busy);
    // Only reclaim a dead owner's unchanged file, never a live operation.
    if (lockOwner(file).leaseId !== previous.leaseId) throw Error(busy);
    fs.unlinkSync(file);
    try { create(); } catch { throw Error(busy); }
  }
  return { leaseId };
}
export function acquireSwitchLease(provider, env = process.env) {
  return lockFile(path.join(accountLayout(provider, env).root, '.operation-lock'), 'account_operation_in_progress');
}
export function releaseSwitchLease(provider, leaseId, env = process.env) {
  const layout = accountLayout(provider, env), file = path.join(layout.root, '.operation-lock');
  if (lockOwner(file).leaseId !== leaseId) throw Error('account_operation_owner_changed');
  fs.unlinkSync(file);
  return { released: true };
}
export function prepareAccount(provider, name, env = process.env) {
  const layout = accountLayout(provider, env), home = accountHome(provider, name, env);
  if (name === 'primary') throw Error('primary_reserved_for_original_login');
  directory(layout.root, true);
  const active = activeName(layout);
  if (name === active && safeFile(path.join(layout.nativeHome, layout.credential))) throw Error('account_already_signed_in');
  directory(home, true);
  if (safeFile(path.join(home, layout.credential))) throw Error('account_already_signed_in');
  fs.chmodSync(home, 0o700);
  return { home, command: layout.command, variable: layout.variable };
}
export function checkAccount(provider, name, env = process.env) {
  const layout = accountLayout(provider, env), active = activeName(layout);
  const enrolled = accountHome(provider, name, env);
  const home = name === active && safeFile(path.join(layout.nativeHome, layout.credential)) ? layout.nativeHome : enrolled;
  directory(home);
  if (!safeFile(path.join(home, layout.credential))) return { provider, name, loggedIn: false };
  const childEnv = { ...env };
  // An unset Claude selection reads state from HOME/.claude.json. Explicitly
  // setting its default directory would select a different state file.
  if (provider === 'claude' && home === layout.nativeHome && !env.CLAUDE_CONFIG_DIR) delete childEnv.CLAUDE_CONFIG_DIR;
  else childEnv[layout.variable] = home;
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) delete childEnv[key];
  const result = spawnSync(layout.command, provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], { env: childEnv, encoding: 'utf8', timeout: 15_000, maxBuffer: 128 * 1024, windowsHide: true });
  if (result.error || result.signal) throw Error('native_auth_status_unavailable');
  let loggedIn = result.status === 0, identity;
  if (provider === 'claude') {
    try {
      const data = JSON.parse(result.stdout);
      loggedIn = loggedIn && data.loggedIn === true && data.authMethod === 'claude.ai';
      if (loggedIn && typeof data.email === 'string' && data.email) identity = [data.email, data.orgId ?? ''];
    }
    catch { throw Error('native_auth_status_unavailable'); }
  } else {
    loggedIn = loggedIn && /ChatGPT/i.test(result.stdout + result.stderr);
    if (loggedIn) {
      try {
        const data = JSON.parse(readPrivate(path.join(home, layout.credential)));
        const tokens = data.tokens;
        if (typeof tokens?.account_id === 'string' && tokens.account_id) identity = [tokens.account_id];
      } catch { throw Error('native_auth_status_unavailable'); }
    }
  }
  if (loggedIn && !identity) throw Error('account_identity_unavailable');
  return { provider, name, loggedIn, fingerprint: identity ? createHash('sha256').update(JSON.stringify(identity)).digest('hex') : null };
}
export function assertNoNativeProcesses(provider) {
  const spec = PROVIDERS[provider];
  if (!spec) throw Error('unsupported_provider');
  const result = spawnSync('ps', ['-eo', 'comm=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) throw Error('native_processes_unknown');
  const pattern = new RegExp(`(?:^|[\\s/])${spec.command}(?:[\\s]|$)`);
  if (result.stdout.split('\n').some(line => pattern.test(line))) throw Error('native_processes_still_running');
  return { stopped: true };
}
function state(file) {
  if (!stat(file)) return {};
  try { const value = JSON.parse(readPrivate(file)); if (value && !Array.isArray(value) && typeof value === 'object') return value; }
  catch { throw Error('native_state_unreadable'); }
  throw Error('native_state_unreadable');
}

export function activateAccount(provider, name, env = process.env, deps = {}) {
  const layout = accountLayout(provider, env);
  if (!validName(name)) throw Error('invalid_account');
  directory(layout.root, true);
  directory(layout.nativeHome, true);
  const lock = path.join(layout.root, '.switch-lock');
  lockFile(lock, 'account_switch_in_progress');
  try {
    const active = activeName(layout);
    const journal = path.join(layout.root, '.switch-pending');
    if (stat(journal)) throw Error('previous_switch_requires_recovery');
    if (active === name && safeFile(path.join(layout.nativeHome, layout.credential))) return { provider, active: name, changed: false };
    const selected = accountHome(provider, name, env);
    directory(selected);
    const incoming = readPrivate(path.join(selected, layout.credential));
    const activeFile = path.join(layout.nativeHome, layout.credential);
    safeFile(activeFile);
    (deps.assertStopped ?? assertNoNativeProcesses)(provider);
    // Validate both state files before any mutation. Only account identity is
    // selected; project trust, history and other active settings stay in place.
    const activeState = layout.statePath ? state(layout.statePath) : null;
    const incomingState = layout.statePath ? state(path.join(selected, '.claude.json')) : null;
    const previous = accountHome(provider, active, env);
    directory(previous, true);
    if (stat(activeFile)) writePrivate(path.join(previous, layout.credential), readPrivate(activeFile));
    if (activeState) writePrivate(path.join(previous, '.claude.json'), JSON.stringify(activeState));
    // Keep an explicit recovery journal until all private writes are complete.
    writePrivate(journal, JSON.stringify({ from: active, to: name, hadLogin: Boolean(stat(activeFile)), hadState: Boolean(layout.statePath && stat(layout.statePath)) }));
    if (activeState) {
      const updated = { ...activeState };
      if (Object.hasOwn(incomingState, 'oauthAccount')) updated.oauthAccount = incomingState.oauthAccount;
      else delete updated.oauthAccount;
      writePrivate(layout.statePath, JSON.stringify(updated));
    }
    writePrivate(activeFile, incoming);
    writePrivate(path.join(layout.root, '.active-account'), name + '\n');
    fs.unlinkSync(journal);
    return { provider, active: name, changed: true };
  } catch (error) { throw fixedError(error); }
  finally { fs.unlinkSync(lock); }
}

export function recoverAccount(provider, env = process.env, deps = {}) {
  const layout = accountLayout(provider, env), journal = path.join(layout.root, '.switch-pending');
  const lease = acquireSwitchLease(provider, env);
  const lock = path.join(layout.root, '.switch-lock');
  try {
    lockFile(lock, 'account_switch_in_progress');
    try {
    if (!stat(journal)) return { provider, outcome: 'no_recovery_needed' };
    const pending = state(journal);
    if (!validName(pending.from) || !validName(pending.to) || typeof pending.hadLogin !== 'boolean' || typeof pending.hadState !== 'boolean') throw Error('invalid_recovery_journal');
    (deps.assertStopped ?? assertNoNativeProcesses)(provider);
    const previous = accountHome(provider, pending.from, env);
    const activeFile = path.join(layout.nativeHome, layout.credential);
    const saved = pending.hadLogin ? readPrivate(path.join(previous, layout.credential)) : null;
    const savedState = pending.hadState ? readPrivate(path.join(previous, '.claude.json')) : null;
    if (saved) writePrivate(activeFile, saved);
    else if (safeFile(activeFile)) fs.unlinkSync(activeFile);
    if (layout.statePath) {
      if (savedState) writePrivate(layout.statePath, savedState);
      else if (safeFile(layout.statePath)) fs.unlinkSync(layout.statePath);
    }
    writePrivate(path.join(layout.root, '.active-account'), pending.from + '\n');
    fs.unlinkSync(journal);
    return { provider, active: pending.from, outcome: 'rolled_back' };
    } finally { fs.unlinkSync(lock); }
  } catch (error) { throw fixedError(error); }
  finally { releaseSwitchLease(provider, lease.leaseId, env); }
}
