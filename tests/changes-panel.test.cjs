const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../mods/changes-branch/main.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export default class Changes', 'globalThis.Changes = class Changes');
const hashes = ['a'.repeat(40), 'b'.repeat(40)];
const result = name => ({ files: [{ path: name, add: 1, del: 0 }], hasHead: true, limited: false, branchInfo: null });

function mount(mode = 'unpushed', overrides = {}) {
  const queue = [], storage = new Map([['changes.mode', mode]]);
  const history = { commits: hashes.map((hash, i) => ({ hash, subject: `commit ${i}`, date: '2026-11-03T12:00:00+09:00' })), ahead: 2, behind: 0, upstream: 'origin/main' };
  const api = {
    View: class {}, spaces: () => [{ active: true, folder: '/repo' }], panes: () => [], focused: () => null,
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    InputState: { new: () => ({ on() {}, value: () => '', set_value() {} }) },
    collectUnpushed: async () => history,
    collectCommit: async (_git, hash) => result(hash === hashes[0] ? 'new.txt' : 'old.txt'),
    collectWorking: async () => result('working.txt'), collectBranch: async () => result('branch.txt'),
    commitDiffArgs: hash => ['show', hash], diffAgainst: () => ['HEAD'],
    exec: async (_cmd, args) => ({ code: 0, stdout: args.includes('--show-toplevel') ? '/repo\n' : '@@ -0,0 +1 @@\n+preview\n', stderr: '' }),
    watchFolder: () => new Promise(() => {}), ...overrides,
  };
  const cx = { focus_handle() {}, spawn: fn => queue.push(fn), timer: { every() {} }, notify() {} };
  const context = vm.createContext(api);
  vm.runInContext(source, context);
  const view = new context.Changes();
  view.init(undefined, cx);
  queue.pop(); // the command receiver stays idle until a real app command arrives
  view.watch = () => {};
  const flush = async () => { while (queue.length) await queue.shift()(cx); };
  return { view, cx, queue, flush, storage, context };
}

test('saved unpublished tab opens newest commit and selecting another shows its own files', async () => {
  const { view, cx, flush, storage } = mount();
  await flush();
  assert.equal(view.selectedCommit, hashes[0]);
  assert.equal(view.files[0].path, 'new.txt');
  view.pickCommit(hashes[1], cx);
  await flush();
  assert.equal(view.selectedCommit, hashes[1]);
  assert.equal(view.files[0].path, 'old.txt');
  view.message = 'keep my draft';
  view.setMode('working', cx); await flush();
  assert.equal(view.files[0].path, 'working.txt');
  assert.equal(view.message, 'keep my draft');
  view.setMode('unpushed', cx); await flush();
  assert.equal(storage.get('changes.mode'), 'unpushed');
  assert.equal(view.selectedCommit, hashes[0]);
});

test('late diff for the previous commit cannot replace a newly selected commit with the same path', async () => {
  let release, started;
  const held = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const mounted = mount('unpushed', {
    collectCommit: async () => result('same.txt'),
    exec: async (_cmd, args) => {
      if (args.includes('--show-toplevel')) return { code: 0, stdout: '/repo\n' };
      if (args.includes(hashes[0])) { started(); await held; }
      return { code: 0, stdout: `@@ -0,0 +1 @@\n+${args.includes(hashes[0]) ? 'old result' : 'new result'}\n` };
    },
  });
  const previous = mounted.queue.shift()(mounted.cx);
  await ready;
  mounted.view.pickCommit(hashes[1], mounted.cx);
  await mounted.flush();
  release(); await previous;
  assert.equal(mounted.view.selectedCommit, hashes[1]);
  assert.equal(mounted.view.rows.at(-1).text, 'new result');
});

test('upstream failures clear previous files and display an error instead of no unpublished commits', async () => {
  const { view, cx, flush } = mount('working', {
    collectUnpushed: async () => { throw new Error('추적 원격 브랜치 미설정'); },
  });
  await flush();
  assert.equal(view.files.length, 1);
  view.setMode('unpushed', cx); await flush();
  assert.equal(view.files.length, 0);
  assert.equal(view.rows.length, 0);
  assert.match(view.emptyText(), /원격 브랜치 미설정/);
});

test('late failure from a previous commit preview cannot add an error to the new commit', async () => {
  let fail = false, release, started;
  const held = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const mounted = mount('unpushed', {
    collectCommit: async () => result('same.txt'),
    exec: async (_cmd, args) => {
      if (args.includes('--show-toplevel')) return { code: 0, stdout: '/repo\n' };
      if (args.includes(hashes[0]) && fail) { started(); await held; throw new Error('old preview failed'); }
      return { code: 0, stdout: '@@ -0,0 +1 @@\n+valid preview\n' };
    },
  });
  await mounted.flush();
  mounted.view.pick('same.txt', mounted.cx); // close, then reopen the preview
  fail = true;
  mounted.view.pick('same.txt', mounted.cx);
  const previous = mounted.queue.shift()(mounted.cx);
  await ready;
  mounted.view.pickCommit(hashes[1], mounted.cx); await mounted.flush();
  release(); await previous;
  assert.equal(mounted.view.rows.at(-1).text, 'valid preview');
  assert.equal(mounted.view.note, null);
});

test('empty commits remain selectable and successful zero history has a distinct message', async () => {
  const { view, cx, flush, context } = mount('unpushed', { collectCommit: async () => ({ ...result(''), files: [] }) });
  await flush();
  assert.equal(view.selectedCommit, hashes[0]);
  assert.match(view.emptyText(), /이 커밋에는 파일 변경이 없습니다/);
  context.collectUnpushed = async () => ({ commits: [], ahead: 0, behind: 3, upstream: 'origin/main' });
  view.refresh(cx); await flush();
  assert.equal(view.selectedCommit, null);
  assert.match(view.emptyText(), /미푸시 커밋이 없습니다/);
  assert.equal(view.unpushed.behind, 3);
});
