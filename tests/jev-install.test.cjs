'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { mergeHooks, commandFor, install, trustHooks } = require('../scripts/install-jev.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-jev-install-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); assert.equal(fs.existsSync(root), false); });
  for (const agent of ['claude', 'codex']) fs.mkdirSync(path.join(root, `.${agent}`));
  return { root, options: { home: root, local: path.join(root, 'local'), appHome: path.join(root, 'herdr'),
    codex: process.execPath, powershell: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', git: process.execPath,
    trust: async () => [{ event: 'UserPromptSubmit', trusted: 'trusted' }] } };
}
test('hook merge preserves other hooks and permissions and is idempotent', () => {
  const config = { permissions: { allow: ['safe'] }, model: 'user-choice', hooks: { UserPromptSubmit: [{ matcher: 'all', hooks: [{ type: 'command', command: 'identity-hook' }] }] } };
  mergeHooks(config, 'jev-command', 'codex'); mergeHooks(config, 'jev-command', 'codex');
  assert.equal(config.hooks.UserPromptSubmit.flatMap(g => g.hooks).length, 2);
  assert.equal(config.hooks.UserPromptSubmit[0].hooks[0].command, 'identity-hook');
  assert.equal(config.model, 'user-choice'); assert.deepEqual(config.permissions.allow, ['safe']);
  mergeHooks(config, 'jev-command', 'codex', true);
  assert.equal(config.hooks.UserPromptSubmit.length, 1);
});
test('encoded command preserves spaces, Korean and shell metacharacters literally', () => {
  const command = commandFor("C:/사용자/$() & ' folder/hook.ps1", 'codex', 'C:/Windows/powershell.exe');
  const encoded = command.split(' ').at(-1), decoded = Buffer.from(encoded, 'base64').toString('utf16le');
  assert.equal(decoded, "& 'C:/사용자/$() & '' folder/hook.ps1' -Agent codex");
});
test('hook command runs from a PowerShell host, not just cmd.exe', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t), script = path.join(f.root, '한글 entry.ps1');
  fs.writeFileSync(script, 'param([string]$Agent)\n[Console]::WriteLine("entry-" + $Agent)');
  const command = commandFor(script, 'codex', f.options.powershell);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /entry-codex/);
});
test('install backs up and preserves settings and credentials, and repeat install does not duplicate hooks', async t => {
  const f = fixture(t), file = path.join(f.root, '.claude/settings.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'retain-me', permissions: { allow: ['existing'] } }));
  const base = path.join(f.options.local, 'Herdr/jev'); fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(path.join(base, 'credential.dpapi'), 'ENCRYPTED_PLACEHOLDER');
  const result = await install(f.options); assert.ok(fs.existsSync(path.join(result.backup, 'manifest.json')));
  await install(f.options);
  const config = JSON.parse(fs.readFileSync(file)); assert.equal(config.model, 'retain-me');
  assert.deepEqual(config.permissions.allow, ['existing']); assert.equal(config.hooks.UserPromptSubmit.length, 1);
  assert.equal(fs.readFileSync(path.join(base, 'credential.dpapi'), 'utf8'), 'ENCRYPTED_PLACEHOLDER');
  assert.ok(fs.existsSync(path.join(f.options.appHome, 'mods/jev-status/main.js')));
});
test('malformed preflight and failed trust cannot leave partial hook installations', async t => {
  const f = fixture(t), claude = path.join(f.root, '.claude/settings.json'), codex = path.join(f.root, '.codex/hooks.json');
  fs.writeFileSync(claude, '{"model":"keep"}'); fs.writeFileSync(codex, '{broken');
  await assert.rejects(install(f.options)); assert.equal(fs.readFileSync(claude, 'utf8'), '{"model":"keep"}');
  assert.equal(fs.existsSync(f.options.local), false);
  fs.writeFileSync(codex, '{}');
  await assert.rejects(install({ ...f.options, trust: async () => { throw new Error('trust failed'); } }), /rollback completed/);
  assert.equal(fs.readFileSync(claude, 'utf8'), '{"model":"keep"}'); assert.equal(fs.readFileSync(codex, 'utf8'), '{}');
  assert.equal(fs.existsSync(path.join(f.options.local, 'Herdr/jev/hook.ps1')), false);
});
test('upgrading a command replaces only the previously owned handlers', async t => {
  const f = fixture(t); const installed = await install(f.options);
  const runtimeFile = path.join(installed.base, 'runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimeFile));
  for (const agent of ['claude', 'codex']) {
    const file = path.join(f.root, `.${agent}`, agent === 'claude' ? 'settings.json' : 'hooks.json');
    const config = JSON.parse(fs.readFileSync(file));
    const previous = `old-owned-${agent}`;
    for (const groups of Object.values(config.hooks)) for (const group of groups) for (const hook of group.hooks) if (hook.command === runtime.commands[agent]) hook.command = previous;
    config.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'preserve-identity-hook' }] });
    runtime.commands[agent] = previous;
    fs.writeFileSync(file, JSON.stringify(config));
  }
  fs.writeFileSync(runtimeFile, JSON.stringify(runtime));
  await install(f.options);
  for (const agent of ['claude', 'codex']) {
    const file = path.join(f.root, `.${agent}`, agent === 'claude' ? 'settings.json' : 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(file)).hooks.UserPromptSubmit.flatMap(g => g.hooks);
    assert.equal(hooks.length, 2); assert.ok(hooks.some(h => h.command === 'preserve-identity-hook'));
    assert.ok(!hooks.some(h => h.command.startsWith('old-owned-')));
  }
});
test('trust registration writes only the exact three reviewed handlers', async () => {
  const writes = [], events = ['sessionStart', 'userPromptSubmit', 'sessionEnd']; let trusted = false, closed = false;
  const factory = () => ({ close() { closed = true; }, async call(method, params) {
    if (method === 'hooks/list') return { data: [{ hooks: [...events.map((eventName, i) => ({ eventName, command: 'own', key: `key${i}`, enabled: true, currentHash: `hash${i}`, trustStatus: trusted ? 'trusted' : 'untrusted' })), { command: 'unrelated' }] }] };
    if (method === 'config/value/write') { writes.push(params); if (writes.length === 3) trusted = true; }
    return {};
  } });
  assert.equal((await trustHooks('unused', 'own', factory)).length, 3);
  assert.equal(closed, true); assert.equal(writes.length, 3);
  assert.ok(writes.every(w => w.keyPath.startsWith('hooks.state.') && w.mergeStrategy === 'replace'));
});
