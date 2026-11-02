'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runJob, validatePatch, assertLease, inside, applyProposal, hash } = require('../scripts/repair-herdr.cjs');
function git(repo, ...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-repair-test-'));
  const repo = path.join(root, 'repo'), diag = path.join(root, 'diagnostics');
  fs.mkdirSync(path.join(repo, 'mods/panel'), { recursive: true });
  fs.mkdirSync(path.join(diag, 'incidents'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'mods/panel/main.js'), 'export const count = 1;\n');
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Repair test');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'test fixture');
  fs.writeFileSync(path.join(diag, 'auto-repair.json'), JSON.stringify({ enabled: true, repository: repo }));
  const incident = path.join(diag, 'incidents/0123456789abcdef.json');
  fs.writeFileSync(incident, JSON.stringify({ id: '0123456789abcdef', category: 'mod_render', error: 'TypeError' }));
  return { root, repo, diag, options: { repository: repo, diagnostics: diag, incident } };
}
const edit = worktree => fs.writeFileSync(path.join(worktree, 'mods/panel/main.js'), 'export const count = 2;\n');
const remove = f => fs.rmSync(f.root, { recursive: true, force: true });
test('repair boundary rejects protected paths, traversal, binary and unsafe operations', () => {
  for (const file of ['../outside.js', 'scripts/repair-herdr.cjs', 'native/herdr-app/src/diagnostics.rs', 'native/herdr-app/src/main.rs', 'mods/a/../../key.js']) assert.throws(() => validatePatch([file], '+safe'));
  for (const patch of ['+fetch(url)', 'GIT binary patch', 'new file mode 120000', '+spawn(command)', '+fs.writeFileSync(target, data)', '+std::fs::write(path, bytes)', '+process.exit(0)', 'deleted file mode 100644']) assert.throws(() => validatePatch(['mods/panel/main.js'], patch));
  validatePatch(['mods/panel/main.js'], '+const safe = values?.length ?? 0;');
  assert.equal(inside('C:/safe', 'C:/safe-other/file'), false);
});
test('verified proposal commits and applies only after checks', async () => {
  const f = fixture();
  try {
    let checked = false, applied = false;
    const result = await runJob(f.options, { propose: edit, verify() { checked = true; return null; }, deploy() { assert.ok(checked); applied = true; return []; } });
    assert.equal(result.state, 'applied'); assert.ok(applied);
    assert.match(fs.readFileSync(path.join(f.repo, 'mods/panel/main.js'), 'utf8'), /count = 2/);
    assert.equal(git(f.repo, 'status', '--porcelain'), '');
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), result.commit);
  } finally { remove(f); }
});
test('failed verification leaves source and deployment unchanged', async () => {
  const f = fixture(); const before = git(f.repo, 'rev-parse', 'HEAD');
  try {
    await assert.rejects(runJob(f.options, { propose: edit, verify() { throw new Error('regression'); }, deploy() { assert.fail('must not deploy'); } }), /regression/);
    assertLease(f.repo, before);
  } finally { remove(f); }
});
test('source changes during model work invalidate the lease', async () => {
  const f = fixture();
  try {
    await assert.rejects(runJob(f.options, { propose(worktree) { edit(worktree); fs.writeFileSync(path.join(f.repo, 'owner-edit.txt'), 'keep'); }, verify() { return null; }, deploy() { assert.fail('must not deploy'); } }), /local edits/);
    assert.equal(fs.readFileSync(path.join(f.repo, 'owner-edit.txt'), 'utf8'), 'keep');
  } finally { remove(f); }
});
test('empty model result is reported without changing source', async () => {
  const f = fixture(); const before = git(f.repo, 'rev-parse', 'HEAD');
  try {
    assert.equal((await runJob(f.options, { propose() {} })).state, 'reported'); assertLease(f.repo, before);
  } finally { remove(f); }
});
test('worktree ownership is checked before any private reset', async () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.diag, 'source-worktree')); fs.writeFileSync(path.join(f.diag, 'source-worktree/owner.txt'), 'preserve');
    await assert.rejects(runJob(f.options, { propose: edit }));
    assert.equal(fs.readFileSync(path.join(f.diag, 'source-worktree/owner.txt'), 'utf8'), 'preserve');
  } finally { remove(f); }
});
test('a concurrent worker lock prevents a second proposal', async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.diag, 'repair-worker.lock'), 'existing');
    await assert.rejects(runJob(f.options, { propose() { assert.fail('must not call model'); } }), /Another repair/);
    assert.equal(fs.readFileSync(path.join(f.diag, 'repair-worker.lock'), 'utf8'), 'existing');
  } finally { remove(f); }
});

test('structured proposals require exact unique source and a new regression test', () => {
  const f=fixture();
  try {
    const sources=[{path:'mods/panel/main.js',content:'export const count = 1;\n'}];
    assert.throws(()=>applyProposal(f.repo,sources,{edits:[{path:'mods/panel/main.js',find:'missing',replace:'x'}],tests:[]}));
    assert.throws(()=>applyProposal(f.repo,sources,{edits:[{path:'mods/panel/main.js',find:'count = 1',replace:'count = 2'}],tests:[]}),/regression test/);
    assert.throws(()=>applyProposal(f.repo,sources,{edits:[],tests:[{path:'../outside.test.cjs',content:'x'}]}));
    assert.match(fs.readFileSync(path.join(f.repo,'mods/panel/main.js'),'utf8'),/count = 1/);
  } finally {remove(f);}
});

test('native installer verifies source/binary leases and retains a backup after parent exit', {skip:process.platform!=='win32'}, () => {
  const f=fixture();
  try {
    const job=path.join(f.diag,'jobs/1234567890123-0123456789abcdef'); fs.mkdirSync(job,{recursive:true});
    const executable=path.join(f.root,'installed.exe'), candidate=path.join(job,'herdr-app.exe');
    fs.writeFileSync(executable,'MZ-old-test-fixture');fs.writeFileSync(candidate,'MZ-new-test-fixture');
    const config={enabled:true,repository:f.repo,executable};fs.writeFileSync(path.join(f.diag,'auto-repair.json'),JSON.stringify(config));
    const pending={candidate,executable,repository:f.repo,commit:git(f.repo,'rev-parse','HEAD'),sha256:hash(candidate),expected_sha256:hash(executable)};
    const file=path.join(f.diag,'pending-native.json');fs.writeFileSync(file,JSON.stringify({...pending,sha256:'wrong'}));
    const invoke=()=>spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.resolve(__dirname,'../scripts/apply-native-repair.ps1'),'-Diagnostics',f.diag,'-Executable',executable,'-ParentPid','2147483647'],{encoding:'utf8',windowsHide:true});
    assert.notEqual(invoke().status,0);assert.equal(fs.readFileSync(executable,'utf8'),'MZ-old-test-fixture');
    fs.writeFileSync(file,JSON.stringify(pending));const result=invoke();assert.equal(result.status,0,result.stderr);
    assert.equal(fs.readFileSync(executable,'utf8'),'MZ-new-test-fixture');assert.equal(fs.readFileSync(path.join(job,'before-herdr-app.exe'),'utf8'),'MZ-old-test-fixture');
    assert.equal(fs.existsSync(file),false);
  }finally{remove(f);}
});
