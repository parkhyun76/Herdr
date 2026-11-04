const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '../mods/files-utf8/main.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export default class Files', 'globalThis.Files = class Files');

test('double click opens the exact Windows path once and cancels the preview', async () => {
  const calls = [], tasks = [], timers = [], notices = [], previews = [];
  const context = vm.createContext({ View: class {}, window: () => ({ platform: 'windows' }),
    appHome: () => 'C:/app', exec: async (...args) => { calls.push(args); return { code: 0 }; },
    notify: n => notices.push(n) });
  vm.runInContext(source, context);
  const view = new context.Files();
  view.root = "D:/한글 ' $folder"; view.on = null; view.doubleClickMs = 800; view.context = {};
  view.current = c => c === view.context; view.show = p => previews.push(p);
  const cx = { spawn: f => tasks.push(f), notify() {}, timer: { after(ms, f) {
    const timer = { ms, f, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer;
  } } };
  view.fileClick('a & b.txt', { click_count: 1 }, cx);
  assert.equal(timers[0].ms, 850);
  view.fileClick('a & b.txt', { click_count: 2 }, cx);
  assert.equal(timers[0].cancelled, true);
  await tasks.shift()();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].at(-1), "D:/한글 ' $folder/a & b.txt");
  assert.equal(previews.length, 0);
  assert.equal(notices.length, 0);
  view.fileClick('one.txt', { click_count: 1 }, cx);
  timers.at(-1).f(cx);
  assert.deepEqual(previews, ['one.txt']);
  view.fileClick('stale.txt', { click_count: 1 }, cx);
  view.context = {};
  timers.at(-1).f(cx);
  assert.deepEqual(previews, ['one.txt']);
});

test('opening failures notify the user and remote files retain preview behavior', async () => {
  const tasks = [], notices = [], previews = [];
  const context = vm.createContext({ View: class {}, window: () => ({ platform: 'windows' }), appHome: () => 'C:/app',
    exec: async () => ({ code: 1, stderr: 'association unavailable' }), notify: n => notices.push(n) });
  vm.runInContext(source, context);
  const view = new context.Files(); view.root = 'D:/x'; view.show = p => previews.push(p);
  view.lastClickedFile = 'bad.xyz'; view.lastClickedContext = view.context;
  const cx = { spawn: f => tasks.push(f), timer: { after() {} } };
  view.fileClick('bad.xyz', { click_count: 2 }, cx); await tasks.shift()();
  assert.equal(notices[0].level, 'error'); assert.match(notices[0].body, /association unavailable/);
  view.on = 'remote'; view.fileClick('remote.txt', { click_count: 1 }, cx);
  assert.deepEqual(previews, ['remote.txt']);
});

test('Windows helper passes special-character paths as a single literal argument', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-open-'));
  try {
    const file = path.join(dir, "한글 ' $ & 파일.txt"); fs.writeFileSync(file, 'test');
    const script = `function Start-Process { param($FilePath) if ($FilePath -cne $env:HERDR_OPEN_TEST_FILE) { throw 'path mismatch' }; Write-Output 'path-ok' }; & $env:HERDR_OPEN_TEST_HELPER -Path $env:HERDR_OPEN_TEST_FILE`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, HERDR_OPEN_TEST_FILE: file, HERDR_OPEN_TEST_HELPER: path.resolve(__dirname, '../mods/files-utf8/open-windows.ps1') }
    });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /path-ok/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(fs.existsSync(dir), false);
});
