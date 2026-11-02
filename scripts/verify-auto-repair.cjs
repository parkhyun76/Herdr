'use strict';
// Explicit integration probe: one real Codex turn in a disposable source repo.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runJob } = require('./repair-herdr.cjs');
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim();
}
async function main() {
  const codex = process.argv[2];
  if (!codex || !fs.existsSync(codex)) throw new Error('Pass the native codex.exe path.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-real-repair-probe-'));
  const repository = path.join(root, 'source'), diagnostics = path.join(root, 'diagnostics');
  fs.mkdirSync(path.join(repository, 'mods/probe'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'tests')); fs.mkdirSync(path.join(diagnostics, 'incidents'), { recursive: true });
  fs.writeFileSync(path.join(repository, 'AGENTS.md'), 'Disposable Herdr repair fixture. The owner authorizes a small automatic fix and regression test. Never access other projects, home, network or user terminals. Do not run title commands.\n');
  fs.writeFileSync(path.join(repository, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(repository, 'mods/probe/main.js'), 'export function itemCount(items) { return items.length; }\n');
  fs.writeFileSync(path.join(repository, 'tests/baseline.test.mjs'), "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { itemCount } from '../mods/probe/main.js'; test('array length',()=>assert.equal(itemCount([1,2]),2));\n");
  git(repository, ['init', '-b', 'main']); git(repository, ['config', 'user.email', 'test@example.invalid']); git(repository, ['config', 'user.name', 'Herdr integration probe']);
  git(repository, ['add', '.']); git(repository, ['commit', '-m', 'test: isolated null-list defect']);
  fs.writeFileSync(path.join(diagnostics, 'auto-repair.json'), JSON.stringify({ enabled: true, repository, codex }));
  const incident = path.join(diagnostics, 'incidents/0123456789abcdef.json');
  fs.writeFileSync(incident, JSON.stringify({ id: '0123456789abcdef', category: 'mod_render', source: 'probe', error: 'TypeError: cannot read properties of null (reading length)', sample: { file: 'mods/probe/main.js', function: 'itemCount', expected: 'Loading state supplies null or undefined: display count zero. Real arrays retain their length.' } }));
  console.log(JSON.stringify({ probe: root, state: 'started' }));
  const result = await runJob({ repository, diagnostics, incident }, { deploy() { return []; } });
  if (result.state !== 'applied') throw new Error(`Probe did not apply a fix: ${result.state}`);
  const check = spawnSync(process.execPath, ['--input-type=module', '-e', "import {itemCount} from './mods/probe/main.js'; if(itemCount(null)!==0||itemCount(undefined)!==0||itemCount([1,2])!==2)process.exit(1);"], { cwd: repository, encoding: 'utf8', windowsHide: true });
  if (check.status !== 0) throw new Error(`Independent regression probe failed: ${check.stderr}`);
  console.log(JSON.stringify({ ...result, independent_check: 'pass', user_app_changed: false }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
