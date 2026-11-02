'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function dialog(available = true) {
  const run = [], closed = [];
  const make = (id) => {
    const node = { id, children: [], events: {} };
    const proxy = new Proxy(node, { get(target, name) {
      if (name in target) return target[name];
      return (...args) => {
        if (name === 'child') node.children.push(args[0]);
        else if (name === 'on_click' || name === 'on_key_down') node.events[name] = args[0];
        else if (name === 'disabled') node.disabled = args[0];
        else if (name === 'id') node.id = args[0];
        return proxy;
      };
    } });
    // id() is a builder method too; retain IDs separately for assertions.
    delete node.id;
    node.key = id;
    return proxy;
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../mods/conversation-memory/main.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '').replace('export default class', 'class');
  const Class = vm.runInNewContext(`${source}\nConversationMemory;`, {
    View: class {}, div: () => make(), v_flex: () => make(), h_flex: () => make(), Button: { new: make },
    theme: () => ({}), commands: () => available ? [{ name: 'session.save' }] : [],
    props: () => ({ overlay: 'test-dialog' }), closeOverlay: id => closed.push(id),
    run: command => run.push(command),
  });
  const instance = new Class();
  instance.init({}, { focus_handle: () => ({ focus() {} }) });
  const root = instance.render();
  const find = (id, node = root) => typeof node === 'object' && node !== null
    ? node.key === id ? node : node.children?.map(n => find(id, n)).find(Boolean) : undefined;
  return { root, find, run, closed };
}

test('choice dialog routes save/restore exactly once and cancel never runs a command', () => {
  for (const [button, command] of [['conversation-save', 'session.save'], ['conversation-restore', 'session.restore']]) {
    const view = dialog();
    view.find(button).events.on_click();
    view.find(button).events.on_click();
    assert.deepEqual(view.run, [command]);
    assert.deepEqual(view.closed, ['test-dialog']);
  }
  const cancelled = dialog();
  cancelled.find('conversation-cancel').events.on_click();
  assert.deepEqual(cancelled.run, []);
  assert.deepEqual(cancelled.closed, ['test-dialog']);
});

test('unsupported binaries disable actions; Escape cancels without saving', () => {
  const unavailable = dialog(false);
  assert.equal(unavailable.find('conversation-save').disabled, true);
  assert.equal(unavailable.find('conversation-restore').disabled, true);
  const view = dialog();
  let stopped = false;
  view.root.events.on_key_down({ key: 'escape' }, { stop_propagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(view.run, []);
  assert.deepEqual(view.closed, ['test-dialog']);
});
