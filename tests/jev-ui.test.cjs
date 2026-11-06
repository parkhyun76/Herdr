'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../mods/workspace-status-progress/jev.js'), 'utf8').replaceAll('export ', '');
const { statusView, readStatus } = vm.runInNewContext(`${source}\n({statusView,readStatus})`);
test('UI never turns stale, wrong-terminal, missing or unfinished records into current success', () => {
  const record = { version: 1, terminal: 't1', updated_ms: 100000, status: 'applied' };
  assert.equal(statusView(record, 't2', 100001).status, 'unconfirmed');
  assert.match(statusView(record, 't1', 90000000).label, /이전 기록/);
  assert.equal(statusView({ ...record, status: 'pending' }, 't1', 120000).status, 'timeout');
  assert.equal(statusView(record, 't1', 0).status, 'unconfirmed');
});
test('missing installation, disabled mode and missing session receipts are distinct', async () => {
  assert.equal((await readStatus(async () => { throw new Error('missing'); }, 'home', 't1')).status, 'not_installed');
  const values = { 'home/data/jev/runtime.json': JSON.stringify({ version: 1, directory: 'C:/state' }), 'C:/state/config.json': '{"enabled":false}' };
  const read = async p => { if (!(p in values)) throw new Error('missing'); return values[p]; };
  assert.equal((await readStatus(read, 'home', 't1')).status, 'disabled');
  values['C:/state/config.json'] = '{"enabled":true}';
  assert.equal((await readStatus(read, 'home', 't1')).status, 'unconfirmed');
});
