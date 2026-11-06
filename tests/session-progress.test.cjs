'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../mods/workspace-status-progress/main.js'), 'utf8')
  .replace(/^import .*;\r?$/gm, '').replace('export default class', 'class');

function draw(progress, now = 100000) {
  const nodes = [];
  const make = () => {
    const node = { children: [] };
    nodes.push(node);
    const proxy = new Proxy(node, { get(target, name) {
      if (name in target) return target[name];
      return (...args) => {
        if (name === 'child') target.children.push(args[0]);
        else if (name === 'when') { if (args[0]) args[1](proxy); }
        else if (name === 'w') target.width = args[0];
        return proxy;
      };
    } });
    return proxy;
  };
  const FakeDate = class extends Date { static now() { return now; } };
  const Class = vm.runInNewContext(`${source}\nWorkspaceStatus;`, {
    View: class {}, div: make, h_flex: make, shared: () => progress, Date: FakeDate,
  });
  const output = new Class().progress({ input: 'track', accent: 'fill', blocked: 'error' });
  return { output, nodes, labels: nodes.flatMap(n => n.children.filter(x => typeof x === 'string')) };
}

test('progress bar reflects actual save and restore stages and expires after completion', () => {
  const saving = draw({ action: 'save', step: 1, updated_ms: 100000 });
  assert.ok(saving.labels.includes('대화 저장 · 대화 확인'));
  assert.ok(saving.labels.includes('1/3'));
  assert.ok(saving.nodes.some(n => n.width === 24));
  const restoring = draw({ action: 'restore', step: 2, updated_ms: 100000 });
  assert.ok(restoring.labels.includes('대화 복원 검사 · 재개 요청'));
  assert.ok(restoring.nodes.some(n => n.width === 48));
  assert.equal(draw({ action: 'save', step: 3, updated_ms: 94000 }).output, null);
  assert.equal(draw({ action: 'save', step: 0, updated_ms: 39000 }).output, null);
});

test('failure is labeled without a misleading completion fraction; invalid states are ignored', () => {
  const failed = draw({ action: 'restore', step: 3, failed: true, updated_ms: 100000 });
  assert.ok(failed.labels.includes('대화 복원 검사 · 실패'));
  assert.ok(!failed.labels.includes('3/3'));
  assert.equal(draw({ action: 'other', step: 1, updated_ms: 100000 }).output, null);
  assert.equal(draw({ action: 'save', updated_ms: 100000 }).output, null);
});
