// Install only the session identity hooks owned by the Herdr restoration feature.
// No model turn is started. Existing hooks, permissions and integrations are preserved.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

function addHooks(config, agent, helper) {
  config.hooks ??= {};
  const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${helper}" -Agent ${agent}`;
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) {
    const groups = config.hooks[event] ??= [];
    const timeout = agent === 'codex' && event === 'SessionEnd' ? 3 : 10;
    const owned = groups.flatMap(group => group.hooks ?? []).filter(hook => hook.command === command);
    if (owned.length) { for (const hook of owned) hook.timeout = timeout; continue; }
    groups.push({ hooks: [{ type: 'command', command, timeout }] });
  }
  return command;
}

function rpc(executable) {
  const child = spawn(executable, ['app-server', '--stdio'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 0;
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value;
    try { value = JSON.parse(line); } catch { return; }
    const callback = pending.get(value.id);
    if (!callback) return;
    pending.delete(value.id);
    clearTimeout(callback.timer);
    if (value.error) callback.reject(new Error(JSON.stringify(value.error)));
    else callback.resolve(value.result);
  });
  child.stderr.resume();
  child.on('error', error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); });
  child.on('exit', () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex protocol exited')); } pending.clear(); });
  return {
    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    close() { lines.close(); child.stdin.end(); child.kill(); },
  };
}

async function main() {
  const source = process.argv[2];
  const executable = process.argv[3];
  if (!source || !executable) throw new Error('Usage: node install-session-restore.cjs <native source root> <codex.exe>');
  const base = path.join(process.env.LOCALAPPDATA, 'Herdr', 'session-restore');
  const backup = path.join(process.env.LOCALAPPDATA, 'herdr-app-backups', `before-session-restore-${Date.now()}`);
  fs.mkdirSync(backup, { recursive: true });
  fs.mkdirSync(base, { recursive: true });
  const helper = path.join(base, 'hook.ps1');
  for (const name of ['hook.ps1', 'scan.ps1']) {
    const target = path.join(base, name);
    if (fs.existsSync(target)) fs.copyFileSync(target, path.join(backup, name));
    fs.copyFileSync(path.join(source, 'src', 'session_restore', name), target);
  }
  const commands = {};
  for (const agent of ['codex', 'claude']) {
    const file = path.join(os.homedir(), `.${agent}`, agent === 'codex' ? 'hooks.json' : 'settings.json');
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}';
    const config = JSON.parse(original.replace(/^\uFEFF/, ''));
    fs.writeFileSync(path.join(backup, `${agent}-hooks.json`), original);
    commands[agent] = addHooks(config, agent, helper);
    const temporary = `${file}.herdr-session-restore.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`);
    fs.renameSync(temporary, file);
  }
  // Trust only these exact, locally reviewed handler definitions using Codex's own
  // current hashes and config writer. Never bypass or alter any other hook's trust.
  const configFile = path.join(os.homedir(), '.codex', 'config.toml');
  fs.copyFileSync(configFile, path.join(backup, 'codex-config.toml'));
  const client = rpc(executable);
  try {
    await client.call('initialize', { clientInfo: { name: 'herdr-session-restore-installer', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    const result = await client.call('hooks/list', { cwds: [process.cwd()] });
    const entries = result.data.flatMap(item => item.hooks).filter(hook => hook.command === commands.codex);
    if (entries.length !== 4) throw new Error(`Expected four Herdr identity hooks; found ${entries.length}`);
    for (const hook of entries) {
      if (hook.isManaged || !hook.enabled || !hook.currentHash) throw new Error('Unexpected hook trust metadata');
      if (hook.trustStatus !== 'trusted') {
        await client.call('config/value/write', {
          keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`,
          value: hook.currentHash, mergeStrategy: 'replace',
        });
      }
    }
    const verified = await client.call('hooks/list', { cwds: [process.cwd()] });
    const own = verified.data.flatMap(item => item.hooks).filter(hook => hook.command === commands.codex);
    if (own.length !== 4 || own.some(hook => hook.trustStatus !== 'trusted')) throw new Error('Herdr hooks did not become trusted');
    console.log(JSON.stringify({ backup, codexHooks: own.map(h => ({ event: h.eventName, trusted: h.trustStatus })), claudeHooks: 4 }));
  } finally { client.close(); }
}
module.exports = { addHooks };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
