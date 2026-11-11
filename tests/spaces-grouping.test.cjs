const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../mods/spaces-foldable/main.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export default class Spaces', 'globalThis.Spaces = class Spaces');
const space = (id, repo, linked = false, machine = null) => ({ id, name: id, folder: '/' + id, repo, linked, machine, tabs: [{ id: 'tab-' + id }], active: id === 'role' });

function mount(rows, parents = {}, storage = new Map(), sharedStore = new Map(), paneRows = []) {
  const context = vm.createContext({
    View: class {}, spaces: () => rows, panes: () => paneRows,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    props: () => ({ parents }), shared: key => sharedStore.get(key), setShared: (key, value) => sharedStore.set(key, value),
    run: () => assert.fail('Grouping must not change terminals, workspaces or files'),
  });
  vm.runInContext(source, context);
  const view = new context.Spaces();
  const cx = { spawn() {}, timer: { every() {} }, notify() {} };
  view.init(undefined, cx);
  for (const row of rows) view.git[JSON.stringify([row.machine, row.folder])] = row.repo
    ? { repo: JSON.stringify([row.machine, row.repo]), linked: row.linked } : null;
  const ordered = () => Array.from(view.ordered(), row => ({ id: row.w.id, nested: Boolean(row.tree), depth: row.depth, group: row.group, status: row.status }));
  return { view, cx, ordered, storage, sharedStore };
}

test('role spaces sharing one checkout stay under their explicit project after reordering', () => {
  const rows = [space('role', '/project/.git'), space('other', '/other/.git'), space('master', '/project/.git'), space('verify', '/project/.git')];
  const before = JSON.stringify(rows);
  const { ordered } = mount(rows, { role: 'master', verify: 'master' });
  assert.deepEqual(ordered().map(row => [row.id, row.nested]), [['other', false], ['master', false], ['role', true], ['verify', true]]);
  assert.equal(JSON.stringify(rows), before, 'IDs, selected space, tabs and paths remain unchanged');
});

test('working agent colors follow the active pane and the folded status winner', () => {
  const rows = [space('master', null), space('role', null), space('verify', null)];
  rows[0].status = 'idle'; rows[1].status = 'working'; rows[2].status = 'working';
  const panes = [
    { tab: 'tab-master', status: 'idle', program: { key: 'claude' } },
    { tab: 'tab-role', status: 'working', program: { key: 'codex' } },
    { tab: 'tab-verify', status: 'working', program: { key: 'gemini' } },
  ];
  const mounted = mount(rows, { role: 'master', verify: 'master' }, new Map(), new Map(), panes);
  assert.deepEqual(Array.from(mounted.view.ordered(), r => r.agent), [null, 'codex', 'gemini']);
  mounted.view.toggleWorktrees(mounted.ordered()[0].group, mounted.cx);
  assert.equal(mounted.view.ordered()[0].agent, 'codex');
  rows[2].status = 'blocked';
  assert.equal(mounted.view.ordered()[0].status, 'blocked');
});

test('working spinner uses blue for Codex, existing orange for Claude, purple otherwise', () => {
  let color;
  const element = () => new Proxy({}, { get: (_target, method) => (...args) => {
    if (method === 'text_color') color = args[0];
    return element();
  } });
  const context = vm.createContext({ View: class {}, h_flex: element, svg: element });
  vm.runInContext(source, context);
  const view = new context.Spaces();
  const theme = { ansi4: '#blue', working: '#orange', ansi5: '#purple' };
  for (const [agent, expected] of [['codex', '#blue'], ['claude', '#orange'], ['gemini', '#purple'], [null, '#purple']]) {
    view.statusIndicator(theme, 'working', agent);
    assert.equal(color, expected);
  }
});

test('explicit role groups survive unavailable Git information and restore folded status', () => {
  const rows = [space('master', null), space('role', null), space('verify', null)];
  rows[0].status = 'idle'; rows[1].status = 'working'; rows[2].status = 'blocked';
  const parents = { role: 'master', verify: 'master' };
  const mounted = mount(rows, parents);
  assert.deepEqual(mounted.ordered().map(row => row.nested), [false, true, true]);
  mounted.view.toggleWorktrees(mounted.ordered()[0].group, mounted.cx);
  assert.deepEqual(mounted.ordered().map(row => [row.id, row.status]), [['master', 'blocked']]);
  const restored = mount(rows, parents, new Map(), mounted.sharedStore);
  assert.deepEqual(restored.ordered().map(row => [row.id, row.status]), [['master', 'blocked']]);
});

test('orphan, cyclic and cross-machine parent declarations never hide spaces', () => {
  const rows = [space('orphan', null), space('a', null), space('b', null), space('local', null), space('remote', null, false, 'server')];
  const { ordered } = mount(rows, { orphan: 'missing', a: 'b', b: 'a', remote: 'local' });
  assert.deepEqual(ordered().map(row => [row.id, row.nested]), rows.map(row => [row.id, false]));
});

test('automatic Git worktree groups and remote isolation remain unchanged', () => {
  const rows = [space('master', '/repo/.git'), space('linked', '/repo/.git', true), space('remote', '/repo/.git', true, 'server'), space('plain', null)];
  const mounted = mount(rows);
  assert.deepEqual(mounted.ordered().map(row => [row.id, row.nested]), [['master', false], ['linked', true], ['remote', false], ['plain', false]]);
  mounted.view.toggleWorktrees(mounted.ordered()[0].group, mounted.cx);
  assert.deepEqual(mounted.ordered().map(row => row.id), ['master', 'remote', 'plain']);
});

test('a role targeting an automatically nested worktree remains visible under its project', () => {
  const rows = [space('master', '/repo/.git'), space('linked', '/repo/.git', true), space('role', null)];
  const { ordered } = mount(rows, { role: 'linked' });
  assert.deepEqual(ordered().map(row => [row.id, row.nested]), [['master', false], ['linked', true], ['role', true]]);
});

test('role fold identity survives Git discovery and migrates the existing project fold', () => {
  const rows = [space('master', null), space('role', null)];
  const mounted = mount(rows, { role: 'master' });
  const initialGroup = mounted.ordered()[0].group;
  mounted.view.toggleWorktrees(initialGroup, mounted.cx);
  const repoKey = JSON.stringify([null, '/repo/.git']);
  mounted.view.git[JSON.stringify([null, '/master'])] = { repo: repoKey, linked: false };
  assert.equal(mounted.ordered()[0].group, initialGroup);
  assert.deepEqual(mounted.ordered().map(row => row.id), ['master']);
  const storage = new Map([['worktrees.folded', JSON.stringify([repoKey])]]);
  rows[0].repo = '/repo/.git';
  const migrated = mount(rows, { role: 'master' }, storage);
  assert.deepEqual(migrated.ordered().map(row => row.id), ['master']);
  migrated.view.toggleWorktrees(initialGroup, migrated.cx);
  assert.deepEqual(migrated.ordered().map(row => row.id), ['master', 'role']);
});

test('a business group nests projects that keep their own role spaces', () => {
  const rows = [space('bt-fw', '/bt/.git'), space('bt', '/bt/.git'), space('factory', '/work/.git'), space('mb', '/mb/.git'), space('mb-ee', '/mb/.git'), space('other', null)];
  const before = JSON.stringify(rows);
  const { ordered } = mount(rows, { bt: 'factory', mb: 'factory', 'bt-fw': 'bt', 'mb-ee': 'mb' });
  assert.deepEqual(ordered().map(row => [row.id, row.depth]), [['factory', 0], ['bt', 1], ['bt-fw', 2], ['mb', 1], ['mb-ee', 2], ['other', 0]]);
  assert.equal(JSON.stringify(rows), before, 'IDs, selected space, tabs and paths remain unchanged');
});

test('folding a business group hides every level and surfaces the most urgent grandchild', () => {
  const rows = [space('factory', null), space('bt', null), space('bt-fw', null), space('mb', null)];
  rows[0].status = 'idle'; rows[1].status = 'idle'; rows[2].status = 'blocked'; rows[3].status = 'working';
  const mounted = mount(rows, { bt: 'factory', mb: 'factory', 'bt-fw': 'bt' });
  mounted.view.toggleWorktrees(mounted.ordered()[1].group, mounted.cx);
  assert.deepEqual(mounted.ordered().map(row => [row.id, row.status]), [['factory', 'idle'], ['bt', 'blocked'], ['mb', 'working']]);
  mounted.view.toggleWorktrees(mounted.ordered()[0].group, mounted.cx);
  assert.deepEqual(mounted.ordered().map(row => [row.id, row.status]), [['factory', 'blocked']]);
});

test('a project under a business group still gathers its automatic Git worktrees', () => {
  const rows = [space('factory', null), space('mb', '/mb/.git'), space('mb-role', '/mb/.git'), space('mb-me', '/mb/.git', true)];
  const { ordered } = mount(rows, { mb: 'factory', 'mb-role': 'mb' });
  assert.deepEqual(ordered().map(row => [row.id, row.depth]), [['factory', 0], ['mb', 1], ['mb-role', 2], ['mb-me', 2]]);
});

test('longer parent cycles never hide spaces while a space pointing into them stays nested', () => {
  const rows = [space('a', null), space('b', null), space('c', null), space('d', null)];
  const { ordered } = mount(rows, { a: 'b', b: 'c', c: 'a', d: 'a' });
  assert.deepEqual(ordered().map(row => [row.id, row.depth]), [['a', 0], ['d', 1], ['b', 0], ['c', 0]]);
});

test('changing native layout props preserves legacy folds despite a new localStorage namespace', () => {
  const rows = [space('master', null), space('role', null), space('verify', null)];
  const group = JSON.stringify([null, 'space', 'master']);
  const legacy = new Map([['worktrees.folded', JSON.stringify([group])], ['machines.folded', JSON.stringify(['server'])]]);
  const initial = mount(rows, {}, legacy);
  const changed = mount(rows, { role: 'master', verify: 'master' }, new Map(), initial.sharedStore);
  assert.deepEqual(changed.ordered().map(row => row.id), ['master']);
  assert.equal(changed.view.folded.has('server'), true);
  changed.view.toggleWorktrees(group, changed.cx);
  const changedAgain = mount(rows, { role: 'master' }, new Map(), initial.sharedStore);
  assert.deepEqual(changedAgain.ordered().map(row => row.id), ['master', 'role', 'verify']);
});
