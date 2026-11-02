'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { addHooks } = require('../scripts/install-session-restore.cjs');

test('session hook installation preserves existing settings and is idempotent', () => {
  const existing = { type:'command', command:'existing-hook', timeout:10 };
  const config = { permissions:{ defaultMode:'default' }, hooks:{ SessionStart:[{matcher:'startup',hooks:[existing]}] } };
  const command = addHooks(config, 'codex', 'C:\\Users\\test\\Herdr\\hook.ps1');
  const once = JSON.stringify(config);
  addHooks(config, 'codex', 'C:\\Users\\test\\Herdr\\hook.ps1');
  assert.equal(JSON.stringify(config),once);
  assert.equal(config.hooks.SessionStart[0].hooks[0],existing);
  assert.equal(config.permissions.defaultMode,'default');
  for (const event of ['SessionStart','UserPromptSubmit','Stop','SessionEnd']) {
    assert.equal(config.hooks[event].filter(g=>g.hooks.some(h=>h.command===command)).length,1);
    assert.equal(config.hooks[event].find(g=>g.hooks.some(h=>h.command===command)).hooks.find(h=>h.command===command).timeout,event==='SessionEnd'?3:10);
  }
  config.hooks.Stop[0].hooks[0].timeout=3;
  addHooks(config,'codex','C:\\Users\\test\\Herdr\\hook.ps1');
  assert.equal(config.hooks.Stop[0].hooks[0].timeout,10);
});
