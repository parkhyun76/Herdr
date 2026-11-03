const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync, spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '../mods/spaces-foldable/main.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export default class Spaces', 'globalThis.Spaces = class Spaces');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function mount(folder, execute, machine = null) {
  const row = { id: 'target', name: 'Target project', folder, machine, tabs: [] };
  const key = JSON.stringify([machine, folder]), repo = JSON.stringify([machine, folder.replace(/\\/g, '/') + '/.git']);
  const info = { branch: 'main', name: 'repo', ahead: 1, behind: 0, repo };
  const queue = [], notifications = [], refreshes = [];
  const context = vm.createContext({
    View: class {}, spaces: () => [row], panes: () => [], props: () => ({}),
    shared: () => null, setShared() {}, localStorage: { getItem: () => null },
    exec: execute, notify: n => notifications.push(n),
  });
  vm.runInContext(source, context);
  const view = new context.Spaces();
  view.init(undefined, { spawn() {}, timer: { every() {} } });
  view.git[key] = info;
  view.refreshGit = keys => refreshes.push(Array.from(keys));
  const cx = { spawn: fn => queue.push(fn), notify() {} };
  const flush = async () => { while (queue.length) await queue.shift()(cx); };
  return { view, row, info, key, repo, cx, queue, flush, notifications, refreshes, context };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-push-'));
  const local = path.join(root, 'local'), remote = path.join(root, 'remote.git');
  fs.mkdirSync(local); fs.mkdirSync(remote);
  git(remote, 'init', '--bare', '-q');
  git(local, 'init', '-q', '-b', 'main');
  git(local, 'config', 'user.name', 'Test'); git(local, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(local, 'work.txt'), 'base\n');
  git(local, 'add', '-A'); git(local, 'commit', '-qm', 'base');
  git(local, 'remote', 'add', 'origin', remote);
  git(local, 'push', '-qu', 'origin', 'main:review');
  fs.writeFileSync(path.join(local, 'work.txt'), 'work\n');
  git(local, 'add', '-A'); git(local, 'commit', '-qm', 'work');
  return { root, local, remote, close() { fs.rmSync(root, { recursive: true, force: true }); } };
}

const runner = async (command, args, options) => {
  assert.equal(command, 'git');
  const r = spawnSync(command, Array.from(args), { cwd: options.cwd, encoding: 'utf8', windowsHide: true });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

test('arrow push sends only the clicked branch to its tracking ref despite push defaults, mirror and tags', async () => {
  const repo = fixture();
  try {
    const trap = path.join(repo.root, 'trap.git'); fs.mkdirSync(trap); git(trap, 'init', '--bare', '-q');
    git(repo.local, 'remote', 'add', 'trap', trap);
    git(repo.local, 'config', 'branch.main.pushRemote', 'trap');
    git(repo.local, 'config', 'remote.origin.mirror', 'true');
    git(repo.local, 'config', 'push.followTags', 'true');
    git(repo.local, 'tag', '-am', 'do not push this tag', 'local-tag');
    git(repo.local, 'branch', 'local-only');
    fs.writeFileSync(path.join(repo.local, 'work.txt'), 'not committed\n');
    const before = git(repo.local, 'status', '--porcelain');
    const mounted = mount(repo.local, runner);
    mounted.view.push(mounted.row, mounted.info, mounted.cx); await mounted.flush();
    assert.equal(mounted.notifications.at(-1).level, 'success', mounted.notifications.at(-1).body);
    assert.equal(git(repo.remote, 'rev-parse', 'refs/heads/review'), git(repo.local, 'rev-parse', 'HEAD'));
    assert.equal(git(repo.remote, 'for-each-ref', '--format=%(refname)'), 'refs/heads/review');
    assert.equal(git(trap, 'for-each-ref', '--format=%(refname)'), '');
    assert.equal(git(repo.local, 'status', '--porcelain'), before);
    assert.equal(git(repo.local, 'rev-list', '--count', 'origin/review..HEAD'), '0');
    assert.equal(mounted.view.pushing.size, 0);
    assert.deepEqual(mounted.refreshes.at(-1), [mounted.key]);
  } finally { repo.close(); }
});

test('a non-fast-forward push is rejected without changing the remote or enabling force', async () => {
  const repo = fixture();
  try {
    const other = path.join(repo.root, 'other');
    git(repo.root, 'clone', '-q', '--branch', 'review', repo.remote, other);
    git(other, 'config', 'user.name', 'Other'); git(other, 'config', 'user.email', 'other@example.com');
    git(other, 'commit', '--allow-empty', '-qm', 'remote change'); git(other, 'push', '-q');
    const expected = git(repo.remote, 'rev-parse', 'refs/heads/review');
    const mounted = mount(repo.local, runner);
    mounted.view.push(mounted.row, mounted.info, mounted.cx); await mounted.flush();
    assert.equal(git(repo.remote, 'rev-parse', 'refs/heads/review'), expected);
    assert.equal(mounted.notifications.at(-1).level, 'error');
    assert.match(mounted.notifications.at(-1).body, /reject|fetch first|non-fast-forward/i);
    assert.equal(mounted.view.pushing.size, 0);
  } finally { repo.close(); }
});

test('stale branch clicks are refused and pending pushes block duplicate clicks across shared roles', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const mounted = mount('/repo', async (command, args, options) => {
    calls.push({ command, args: Array.from(args), options }); await gate;
    return { code: 0, stdout: 'different-branch\n', stderr: '' };
  }, 'server');
  mounted.view.push(mounted.row, mounted.info, mounted.cx);
  mounted.view.push(mounted.row, mounted.info, mounted.cx);
  mounted.view.push({ ...mounted.row, id: 'shared-role' }, mounted.info, mounted.cx);
  assert.equal(mounted.queue.length, 1);
  const pending = mounted.queue.shift()(mounted.cx);
  release(); await pending;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.on, 'server');
  assert.equal(mounted.notifications.at(-1).level, 'error');
  assert.match(mounted.notifications.at(-1).body, /브랜치/);
  assert.equal(mounted.view.pushing.size, 0);
});

test('missing upstream and process failure are reported and leave the button usable', async () => {
  const repo = fixture();
  try {
    git(repo.local, 'branch', '--unset-upstream');
    const missing = mount(repo.local, runner);
    missing.view.push(missing.row, missing.info, missing.cx); await missing.flush();
    assert.equal(missing.notifications.at(-1).level, 'error');
    assert.match(missing.notifications.at(-1).body, /추적|upstream|원격/);
    const failed = mount(repo.local, async () => { throw new Error('git could not start'); });
    failed.view.push(failed.row, failed.info, failed.cx); await failed.flush();
    assert.match(failed.notifications.at(-1).body, /git could not start/);
    assert.equal(failed.view.pushing.size, 0);
  } finally { repo.close(); }
});

test('up-arrow click stops row selection and invokes push for the clicked workspace', () => {
  const elements = [];
  function element() {
    const state = { events: {} };
    const proxy = new Proxy(state, { get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => {
        if (prop === 'when') { if (args[0]) args[1](proxy); }
        else if (prop.startsWith('on_')) target.events[prop + (typeof args[0] === 'string' ? ':' + args[0] : '')] = args.at(-1);
        else if (prop === 'id') target.idValue = args[0];
        return proxy;
      };
    } });
    elements.push(state); return proxy;
  }
  const mounted = mount('/repo', runner);
  mounted.context.div = element; mounted.context.h_flex = element;
  let target = null;
  mounted.view.push = row => { target = row; };
  mounted.view.gitTail(mounted.info, null, mounted.row.name, { ansi2: 'green' }, mounted.row);
  const button = elements.find(e => e.idValue === 'space-push-target');
  assert.ok(button, 'the up-arrow itself is a push control');
  let stopped = 0;
  const cx = { stop_propagation() { stopped++; } };
  button.events['on_mouse_down:left']({}, cx);
  button.events['on_mouse_up:left']({}, cx);
  button.events.on_click({}, cx);
  assert.equal(stopped, 3);
  assert.equal(target.id, 'target');
});
