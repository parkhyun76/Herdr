'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { rpc } = require('./install-session-restore.cjs');
const { MODEL, loadConfig } = require('./jev/jev.cjs');

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'SessionEnd'];
function commandFor(helper, agent, powershell) {
  const source = `& '${helper.replaceAll("'", "''")}' -Agent ${agent}`;
  // A quoted executable alone is a string expression in PowerShell, not a call.
  // This whitespace-free absolute Windows path is executable in both PS and Bash.
  const executable = powershell.replaceAll('\\', '/');
  if (/[\s"'`$;&|<>]/.test(executable)) throw new Error('PowerShell executable requires a whitespace-free absolute path');
  return `${executable} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(source, 'utf16le').toString('base64')}`;
}
function mergeHooks(config, command, agent, remove = false) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Settings must be a JSON object');
  config.hooks ??= {};
  if (typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('Invalid hooks object');
  for (const event of EVENTS) {
    const groups = config.hooks[event] ?? [];
    if (!Array.isArray(groups) || groups.some(g => !g || !Array.isArray(g.hooks))) throw new Error(`Invalid ${event} hooks`);
    const remaining = groups.map(group => ({ ...group, hooks: group.hooks.filter(hook => hook.command !== command) })).filter(group => group.hooks.length);
    if (!remove) remaining.push({ hooks: [{ type: 'command', command, timeout: event === 'SessionEnd' ? 3 : 10,
      ...(agent === 'codex' ? { statusMessage: 'Herdr Jev' } : {}) }] });
    config.hooks[event] = remaining;
  }
  return config;
}
function readObject(file, fallback = {}) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : fallback;
}
function findCodex(home) {
  const pkg = path.join(home, 'AppData/Roaming/npm/node_modules/@openai/codex/package.json');
  const req = createRequire(pkg);
  const target = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const native = req.resolve(`@openai/codex-win32-${process.arch}/package.json`);
  const exe = path.join(path.dirname(native), 'vendor', `${target}-pc-windows-msvc`, 'bin/codex.exe');
  if (!fs.existsSync(exe)) throw new Error('Cannot locate codex.exe; pass --codex-exe with its absolute path');
  return exe;
}
function findGit() {
  try { return execFileSync('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]; }
  catch { return null; }
}
async function trustHooks(executable, command, factory = rpc) {
  const client = factory(executable);
  try {
    await client.call('initialize', { clientInfo: { name: 'herdr-jev-installer', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    const own = async () => {
      const result = await client.call('hooks/list', { cwds: [process.cwd()] });
      return result.data.flatMap(item => item.hooks).filter(h => h.command === command);
    };
    const entries = await own();
    const eventNames = EVENTS.map(event => event[0].toLowerCase() + event.slice(1));
    if (entries.length !== EVENTS.length || new Set(entries.map(h => h.eventName)).size !== EVENTS.length
      || entries.some(h => !eventNames.includes(h.eventName) || h.isManaged || !h.enabled || !h.currentHash)) throw new Error('Unexpected Jev hook trust metadata');
    for (const hook of entries) if (hook.trustStatus !== 'trusted') {
      await client.call('config/value/write', { keyPath: `hooks.state.${JSON.stringify(hook.key)}.trusted_hash`, value: hook.currentHash, mergeStrategy: 'replace' });
    }
    const verified = await own();
    if (verified.length !== EVENTS.length || verified.some(h => h.trustStatus !== 'trusted')) throw new Error('Jev hooks are not trusted');
    return verified.map(h => ({ event: h.eventName, trusted: h.trustStatus }));
  } finally { client.close(); }
}

// Preflight every JSON file before mutations. Roll back only files we wrote and
// only if nobody edited them concurrently; credentials are never part of this list.
async function install(options = {}) {
  const repo = options.repo ?? path.resolve(__dirname, '..'), home = options.home ?? os.homedir();
  const local = options.local ?? process.env.LOCALAPPDATA, appHome = options.appHome ?? path.join(home, '.config/herdr-app');
  if (!local || !path.isAbsolute(local) || !path.isAbsolute(appHome)) throw new Error('Absolute installation paths required');
  const base = path.join(local, 'Herdr/jev'), backup = path.join(local, 'herdr-app-backups', `jev-${Date.now()}-${randomUUID()}`);
  const powershell = options.powershell ?? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const codex = options.codex ?? findCodex(home);
  const commands = Object.fromEntries(['claude', 'codex'].map(agent => [agent, commandFor(path.join(base, 'hook.ps1'), agent, powershell)]));
  const previousCommands = readObject(path.join(base, 'runtime.json')).commands ?? {};
  const files = [];
  const add = (file, data) => files.push({ file, data: Buffer.isBuffer(data) ? data : Buffer.from(data), before: fs.existsSync(file) ? fs.readFileSync(file) : null });
  const runtime = { version: 1, node: process.execPath, git: options.git ?? findGit(), hc: path.join(local, 'Programs/herdr-core/hc.exe'), commands };
  if (!fs.existsSync(runtime.hc)) runtime.hc = null;
  for (const agent of ['claude', 'codex']) {
    const file = path.join(home, `.${agent}`, agent === 'claude' ? 'settings.json' : 'hooks.json');
    const config = readObject(file);
    if (config.disableAllHooks === true) throw new Error(`${agent} has disableAllHooks enabled`);
    if (typeof previousCommands[agent] === 'string' && previousCommands[agent] !== commands[agent]) mergeHooks(config, previousCommands[agent], agent, true);
    add(file, `${JSON.stringify(mergeHooks(config, commands[agent], agent), null, 2)}\n`);
  }
  if (fs.existsSync(path.join(base, 'config.json'))) loadConfig(base);
  else add(path.join(base, 'config.json'), `${JSON.stringify({ enabled: true, model: MODEL }, null, 2)}\n`);
  for (const name of ['jev.cjs', 'hook.ps1', 'set-key.ps1']) add(path.join(base, name), fs.readFileSync(path.join(repo, 'scripts/jev', name)));
  add(path.join(base, 'runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`);
  add(path.join(appHome, 'data/jev/runtime.json'), `${JSON.stringify({ version: 1, directory: base })}\n`);
  // Only the new dialog and the modified status bar are deployed, never all user mods/layouts.
  for (const [mod, names] of [['jev-status', ['main.js', 'mod.json']], ['workspace-status-progress', ['main.js', 'jev.js']]]) {
    for (const name of names) add(path.join(appHome, 'mods', mod, name), fs.readFileSync(path.join(repo, 'mods', mod, name)));
  }
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(files.map((f, i) => ({ file: f.file, backup: f.before ? `${i}.bak` : null })), null, 2));
  const written = [];
  const replace = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  };
  try {
    for (const [index, entry] of files.entries()) {
      const current = fs.existsSync(entry.file) ? fs.readFileSync(entry.file) : null;
      if ((current === null) !== (entry.before === null) || current && !current.equals(entry.before)) throw new Error(`File changed during install: ${entry.file}`);
      if (entry.before) fs.writeFileSync(path.join(backup, `${index}.bak`), entry.before);
      replace(entry.file, entry.data); written.push(entry);
    }
    const trust = await (options.trust ?? trustHooks)(codex, commands.codex);
    return { base, backup, files: written.length, codexHooks: trust, claudeHooks: EVENTS.length };
  } catch (error) {
    const conflicts = [];
    for (const entry of written.reverse()) {
      try {
        if (!fs.readFileSync(entry.file).equals(entry.data)) { conflicts.push(entry.file); continue; }
        if (entry.before) replace(entry.file, entry.before); else fs.unlinkSync(entry.file);
      } catch { conflicts.push(entry.file); }
    }
    throw new Error(`${error.message}. File rollback ${conflicts.length ? `needs review: ${conflicts.join(', ')}` : 'completed'}. Backup: ${backup}`);
  }
}
module.exports = { commandFor, mergeHooks, install, trustHooks, findCodex };
if (require.main === module) {
  if (process.platform !== 'win32') throw new Error('This installer targets Windows');
  const args = process.argv.slice(2), index = args.indexOf('--codex-exe');
  install({ ...(index >= 0 ? { codex: args[index + 1] } : {}) }).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
