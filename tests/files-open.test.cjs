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

function load(overrides = {}) {
  const calls = [], notices = [];
  const context = vm.createContext({ View: class {}, window: () => ({ platform: 'windows' }), appHome: () => 'C:/app',
    exec: async (...args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; },
    notify: n => notices.push(n), ...overrides });
  vm.runInContext(source, context);
  return { context, calls, notices };
}
function fakeCx() {
  const tasks = [];
  return { tasks, cx: { spawn: f => tasks.push(f), notify() {}, timer: { after: (_ms, f) => tasks.push(f) } } };
}

test('a file opens only on double click, with the exact Windows path and no preview', async () => {
  const { context, calls, notices } = load();
  const view = new context.Files(); view.root = "D:\\한글 ' $folder"; view.on = null; view.context = {};
  const { tasks, cx } = fakeCx();
  view.entryClick({ name: 'a & b.txt', dir: false }, { click_count: 1 }, cx);
  assert.equal(tasks.length, 0, 'single click does nothing');
  view.entryClick({ name: 'a & b.txt', dir: false }, { click_count: 2 }, cx);
  await tasks.shift()();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].at(-1), "D:\\한글 ' $folder\\a & b.txt");
  assert.equal(notices.length, 0);
  assert.equal(typeof view.show, 'undefined', 'preview is removed');
});

test('opening failures notify the user and remote files are not opened locally', async () => {
  const { context, notices, calls } = load({ exec: async () => ({ code: 1, stderr: 'association unavailable' }) });
  const view = new context.Files(); view.root = 'D:/x';
  const { tasks, cx } = fakeCx();
  view.entryClick({ name: 'bad.xyz', dir: false }, { click_count: 2 }, cx); await tasks.shift()();
  assert.equal(notices[0].level, 'error'); assert.match(notices[0].body, /association unavailable/);
  view.on = 'remote';
  view.entryClick({ name: 'remote.txt', dir: false }, { click_count: 2 }, cx);
  assert.equal(tasks.length, 0); assert.equal(calls.length, 0);
});

test('a folder is selected on single click and entered on double click', () => {
  const { context } = load();
  const view = new context.Files(); view.root = 'D:\\SW_Project';
  const navigated = []; view.navigate = p => navigated.push(p);
  const { cx } = fakeCx();
  view.entryClick({ name: '5_VibeCording', dir: true }, { click_count: 1 }, cx);
  assert.equal(view.selected, '5_VibeCording'); assert.deepEqual(navigated, []);
  view.entryClick({ name: '5_VibeCording', dir: true }, { click_count: 2 }, cx);
  assert.deepEqual(navigated, ['D:\\SW_Project\\5_VibeCording']);
});

test('path crumbs navigate to every ancestor, including the drive root', () => {
  const { context } = load();
  const crumbs = (p, w = true) => JSON.parse(JSON.stringify(context.pathCrumbs(p, w)));
  assert.deepEqual(crumbs('D:\\SW_Project\\5_VibeCording\\Herdr_Upgrade'), [
    { label: 'D:', path: 'D:\\' }, { label: 'SW_Project', path: 'D:\\SW_Project' },
    { label: '5_VibeCording', path: 'D:\\SW_Project\\5_VibeCording' },
    { label: 'Herdr_Upgrade', path: 'D:\\SW_Project\\5_VibeCording\\Herdr_Upgrade' }]);
  assert.deepEqual(crumbs('d:/OneDrive/연구개발/'), [{ label: 'D:', path: 'D:/' },
    { label: 'OneDrive', path: 'D:/OneDrive' }, { label: '연구개발', path: 'D:/OneDrive/연구개발' }]);
  assert.deepEqual(crumbs('C:\\'), [{ label: 'C:', path: 'C:\\' }]);
  assert.deepEqual(crumbs('\\\\nas\\share\\docs'), [{ label: '\\\\nas\\share', path: '\\\\nas\\share' },
    { label: 'docs', path: '\\\\nas\\share\\docs' }]);
  assert.deepEqual(crumbs('/home/u', false), [{ label: '/', path: '/' }, { label: 'home', path: '/home' }, { label: 'u', path: '/home/u' }]);
  assert.deepEqual(crumbs(null), []);
});

test('git marks match whatever separators and case the folder path uses', () => {
  const { context } = load();
  assert.equal(context.markKey('D:/Repo/a.txt', true), context.markKey(context.joinPath('d:\\repo', 'A.TXT'), true));
  assert.notEqual(context.markKey('/r/A', false), context.markKey('/r/a', false));
});

test('new folder names are checked before anything is created', () => {
  const { context } = load();
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'x:y', 'what?', 'dot.', 'space ', 'CON', 'lpt1.txt', 'a\u0001b'])
    assert.ok(context.folderNameError(bad, true), `rejects ${JSON.stringify(bad)}`);
  for (const good of ['새 폴더', "[x] 한글 ' $폴더", '.config'])
    assert.equal(context.folderNameError(good, true), null, good);
  assert.equal(context.folderNameError('what?', false), null, 'POSIX allows ?');
});

test('a new folder goes in the selected folder captured when the box opened, which is then shown', async () => {
  const { context, calls } = load();
  context.spaces = () => []; context.focused = () => null; context.panes = () => [];
  const view = new context.Files();
  view.root = 'D:\\work'; view.on = null; view.context = { key: 'null' }; view.selected = 'docs';
  let value = '', focused = false;
  view.nameInput = { set_value: v => { value = v; }, value: () => value, focus: () => { focused = true; } };
  const refreshed = []; view.refresh = (_cx, p) => refreshed.push(p);
  view.current = c => c === view.context;
  const { tasks, cx } = fakeCx();
  view.startCreate(cx);
  assert.equal(focused, true); assert.equal(value, '');
  focused = false; await tasks.shift()(cx); assert.equal(focused, true, 'focus again once the box is drawn');
  view.selected = null; value = '  -회의록  ';
  view.createFolder(cx); await tasks.shift()(cx);
  assert.deepEqual([...calls[0][1].slice(-2)], ['-Parent:D:\\work\\docs', '-Name:-회의록']);
  assert.deepEqual(refreshed, ['D:\\work\\docs']);
  assert.equal(view.selected, '-회의록'); assert.equal(view.creating, null);
  view.selected = null; view.startCreate(cx); tasks.length = 0; value = '   ';
  view.createFolder(cx); await tasks.shift()(cx);
  assert.equal(calls[1][1].at(-1), '-Name:새 폴더', 'an empty name uses the default');
  assert.deepEqual(refreshed, ['D:\\work\\docs', 'D:\\work'], 'the same folder is listed afresh even mid-refresh');
});

const helperEnv = (extra) => ({ ...process.env, ...extra });
function runPs(script, env) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, env: helperEnv(env) });
}

test('Windows helper passes special-character paths as a single literal argument', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-open-'));
  try {
    const file = path.join(dir, "한글 ' $ & 파일.txt"); fs.writeFileSync(file, 'test');
    const script = `function Start-Process { param($FilePath) if ($FilePath -cne $env:HERDR_OPEN_TEST_FILE) { throw 'path mismatch' }; Write-Output 'path-ok' }; & $env:HERDR_OPEN_TEST_HELPER -Path $env:HERDR_OPEN_TEST_FILE`;
    const result = runPs(script, { HERDR_OPEN_TEST_FILE: file, HERDR_OPEN_TEST_HELPER: path.resolve(__dirname, '../mods/files-utf8/open-windows.ps1') });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /path-ok/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(fs.existsSync(dir), false);
});

test('Windows new-folder helper creates literal names and refuses existing or invalid ones', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-newfolder-'));
  const helper = path.resolve(__dirname, '../mods/files-utf8/new-folder-windows.ps1');
  const make = (parent, name) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helper, `-Parent:${parent}`, `-Name:${name}`],
    { encoding: 'utf8', windowsHide: true });
  try {
    const parent = path.join(dir, "상위 ' $폴더"); fs.mkdirSync(parent);
    const name = "[x] 한글 ' $폴더";
    let r = make(parent, name);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.statSync(path.join(parent, name)).isDirectory());
    assert.deepEqual(fs.readdirSync(parent), [name]);
    r = make(parent, '-draft');
    assert.equal(r.status, 0, r.stderr); assert.ok(fs.statSync(path.join(parent, '-draft')).isDirectory());
    r = make(parent, name);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /이미 있습니다/);
    r = make(parent, '..\\escape');
    assert.notEqual(r.status, 0); assert.match(r.stderr, /사용할 수 없는/);
    r = make(path.join(dir, 'missing'), 'x');
    assert.notEqual(r.status, 0); assert.match(r.stderr, /위치가 없습니다/);
    assert.deepEqual(fs.readdirSync(dir), ["상위 ' $폴더"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(fs.existsSync(dir), false);
});
