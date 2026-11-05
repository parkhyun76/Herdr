const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../mods/agents-colored/main.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export default class Agents', 'globalThis.Agents = class Agents');

test('agent and sub-agent working indicators use the agent program color', () => {
  let color;
  const element = () => new Proxy({}, { get: (_target, method) => (...args) => {
    if (method === 'text_color') color = args[0];
    return element();
  } });
  const context = vm.createContext({ View: class {}, svg: element, div: element, h_flex: element });
  vm.runInContext(source, context);
  const view = new context.Agents();
  const theme = { ansi4: 'blue', working: 'orange', ansi5: 'purple', foreground: 'fg', muted: 'muted' };
  for (const [key, expected] of [['codex', 'blue'], ['claude', 'orange'], ['gemini', 'purple'], [undefined, 'purple']]) {
    view.status(theme, { status: 'working', program: { key } }, true);
    assert.equal(color, expected);
    view.listed = new Map();
    view.subRow(theme, { t: { address: 'sub', status: 'working', program: { key } }, lines: [] }, null, true);
    assert.equal(color, expected);
  }
});
