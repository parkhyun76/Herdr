// node --test  (from the repo root) — exercises mods/changes-branch/git.js with real git.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { collectBranch, collectWorking, collectUnpushed, collectCommit, commitDiffArgs, diffAgainst } = await import(new URL("../mods/changes-branch/git.js", import.meta.url).href);

const runner = (cwd) => async (args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const count = (cwd, range) => sh(cwd, "rev-list", "--left-right", "--count", range).split(/\s+/).map(Number);

function tempRepo(defaultBranch) {
  const dir = mkdtempSync(join(tmpdir(), "chg-"));
  sh(dir, "init", "-q", "-b", defaultBranch);
  sh(dir, "config", "user.email", "t@example.com"); sh(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "keep.txt"), "a\nb\n"); writeFileSync(join(dir, "gone.txt"), "x\n");
  sh(dir, "add", "-A"); sh(dir, "commit", "-qm", "base");
  return dir;
}

test("feature branch vs master: A/M/D, line counts, Korean file name, ahead/behind", async () => {
  const dir = tempRepo("master");
  try {
    sh(dir, "checkout", "-qb", "feat");
    writeFileSync(join(dir, "keep.txt"), "a\nB\nc\n"); rmSync(join(dir, "gone.txt"));
    writeFileSync(join(dir, "한글 파일.md"), "1\n2\n");
    sh(dir, "add", "-A"); sh(dir, "commit", "-qm", "work");
    sh(dir, "checkout", "-q", "master"); writeFileSync(join(dir, "m.txt"), "m\n"); sh(dir, "add", "-A"); sh(dir, "commit", "-qm", "m");
    sh(dir, "checkout", "-q", "feat");
    const r = await collectBranch(runner(dir));
    assert.deepEqual(r.branchInfo, { branch: "feat", base: "master", ahead: 1, behind: 1 });
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    assert.equal(r.files.length, 3, "m.txt from master must not appear (three-dot diff)");
    assert.deepEqual([by["keep.txt"].status, by["keep.txt"].add, by["keep.txt"].del], ["M", 2, 1]);
    assert.deepEqual([by["gone.txt"].status, by["gone.txt"].del], ["D", 1]);
    assert.deepEqual([by["한글 파일.md"].status, by["한글 파일.md"].add], ["A", 2]);
    assert.deepEqual(diffAgainst(r.branchInfo, true), ["master...HEAD"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("on the base branch itself: branch === base, nothing ahead", async () => {
  const dir = tempRepo("main");
  try {
    const r = await collectBranch(runner(dir));
    assert.deepEqual(r.branchInfo, { branch: "main", base: "main", ahead: 0, behind: 0 });
    assert.equal(r.files.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no main/master: clear error", async () => {
  const dir = tempRepo("trunk");
  try { await assert.rejects(collectBranch(runner(dir)), /No main \/ master/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("working mode unchanged: untracked is fresh A, modified is M, against HEAD", async () => {
  const dir = tempRepo("main");
  try {
    writeFileSync(join(dir, "keep.txt"), "a\n"); writeFileSync(join(dir, "new.txt"), "n\n");
    const r = await collectWorking(runner(dir));
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    assert.equal(r.branchInfo, null);
    assert.deepEqual([by["keep.txt"].status, by["keep.txt"].del], ["M", 1]);
    assert.deepEqual([by["new.txt"].status, by["new.txt"].fresh], ["A", true]);
    assert.deepEqual(diffAgainst(null, true), ["HEAD"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function trackedRepo() {
  const dir = tempRepo("main"), remote = mkdtempSync(join(tmpdir(), "chg-remote-"));
  sh(remote, "init", "--bare", "-q");
  sh(dir, "remote", "add", "origin", remote);
  sh(dir, "push", "-qu", "origin", "main");
  return { dir, remote, close() { rmSync(dir, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); } };
}

test("unpublished commits on main are separate from Working and vs main, with per-commit changes", async () => {
  const repo = trackedRepo(), { dir } = repo;
  try {
    writeFileSync(join(dir, "한글 파일.md"), "first\n");
    sh(dir, "add", "-A"); sh(dir, "commit", "-qm", "첫 번째 변경");
    const first = sh(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "keep.txt"), "new\n");
    sh(dir, "add", "-A"); sh(dir, "commit", "-qm", "두 번째 변경");
    const second = sh(dir, "rev-parse", "HEAD");
    writeFileSync(join(dir, "keep.txt"), "uncommitted\n");
    const history = await collectUnpushed(runner(dir));
    assert.deepEqual([history.upstream, history.ahead, history.behind], ["origin/main", 2, 0]);
    assert.deepEqual(history.commits.map(c => [c.hash, c.subject]), [[second, "두 번째 변경"], [first, "첫 번째 변경"]]);
    assert.match(history.commits[0].date, /^\d{4}-\d\d-\d\dT/);
    assert.equal(history.limited, false);
    const selected = await collectCommit(runner(dir), first);
    assert.deepEqual(selected.files.map(f => [f.path, f.status, f.add, f.fresh]), [["한글 파일.md", "A", 1, false]]);
    const newest = await collectCommit(runner(dir), second);
    assert.deepEqual(newest.files.map(f => [f.path, f.add, f.del]), [["keep.txt", 1, 2]]);
    const preview = await runner(dir)([...commitDiffArgs(second), "--", "keep.txt"]);
    assert.match(preview.stdout, /\+new/);
    assert.doesNotMatch(preview.stdout, /uncommitted/);
    assert.equal((await collectWorking(runner(dir))).files[0].path, "keep.txt");
    assert.equal((await collectBranch(runner(dir))).files.length, 0);
    sh(dir, "push", "-q");
    assert.equal((await collectUnpushed(runner(dir))).commits.length, 0);
  } finally { repo.close(); }
});

test("unpublished history follows the configured upstream, includes empty commits, and reports divergence", async () => {
  const repo = trackedRepo(), { dir } = repo;
  try {
    sh(dir, "checkout", "-qb", "server-change");
    sh(dir, "commit", "--allow-empty", "-qm", "remote only");
    sh(dir, "update-ref", "refs/remotes/origin/main", sh(dir, "rev-parse", "HEAD"));
    sh(dir, "checkout", "-q", "main");
    sh(dir, "commit", "--allow-empty", "-qm", "local only");
    const result = await collectUnpushed(runner(dir));
    assert.deepEqual([result.ahead, result.behind, result.commits[0].subject], [1, 1, "local only"]);
    assert.equal((await collectCommit(runner(dir), result.commits[0].hash)).files.length, 0);
  } finally { repo.close(); }
});

test("unpublished history distinguishes missing upstream, missing remote ref, and detached HEAD", async () => {
  const dir = tempRepo("main");
  try {
    await assert.rejects(() => collectUnpushed(runner(dir)), /원격.*미설정/);
    sh(dir, "config", "branch.main.remote", "origin");
    sh(dir, "config", "branch.main.merge", "refs/heads/main");
    sh(dir, "remote", "add", "origin", dir + "-absent");
    await assert.rejects(() => collectUnpushed(runner(dir)), /원격.*(없|찾|확인)/);
    sh(dir, "checkout", "--detach", "-q");
    await assert.rejects(() => collectUnpushed(runner(dir)), /브랜치.*선택/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("commit preview supports root commits, deletions and first-parent merge changes", async () => {
  const dir = tempRepo("main");
  try {
    const root = sh(dir, "rev-parse", "HEAD");
    assert.equal((await collectCommit(runner(dir), root)).files.length, 2);
    sh(dir, "checkout", "-qb", "feature");
    writeFileSync(join(dir, "feature.txt"), "feature\n");
    sh(dir, "add", "-A"); sh(dir, "commit", "-qm", "feature");
    sh(dir, "checkout", "-q", "main");
    rmSync(join(dir, "gone.txt")); sh(dir, "add", "-A"); sh(dir, "commit", "-qm", "delete");
    const deletion = await collectCommit(runner(dir), sh(dir, "rev-parse", "HEAD"));
    assert.deepEqual(deletion.files.map(f => [f.path, f.status, f.del]), [["gone.txt", "D", 1]]);
    sh(dir, "merge", "--no-ff", "-qm", "merge", "feature");
    const hash = sh(dir, "rev-parse", "HEAD"), result = await collectCommit(runner(dir), hash);
    assert.deepEqual(result.files.map(f => f.path), ["feature.txt"]);
    assert.match((await runner(dir)([...commitDiffArgs(hash), "--", "feature.txt"])).stdout, /\+feature/);
    assert.throws(() => commitDiffArgs("--output=oops"), /commit/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unpublished history reports query failure instead of showing an empty list", async () => {
  const repo = trackedRepo();
  try {
    const git = runner(repo.dir);
    await assert.rejects(() => collectUnpushed(args => args[0] === "log"
      ? Promise.resolve({ code: 1, stdout: "", stderr: "object database read failure" }) : git(args)), /object database read failure/);
  } finally { repo.close(); }
});

// The real PHM-VB-BT worktrees on this PC: the panel must agree with git asked directly.
const WT = "D:/SW_Project/Worktrees/PHM-VB-BT";
for (const name of ["41-APP-MOBILE", "00-DP", "90-VERIFY"]) {
  test(`real worktree ${name} matches git`, { skip: !existsSync(join(WT, name)) && "worktree not on this PC" }, async () => {
    const dir = join(WT, name);
    const r = await collectBranch(runner(dir));
    const [behind, ahead] = count(dir, "main...HEAD");
    const files = sh(dir, "diff", "--name-only", "main...HEAD").split("\n").filter(Boolean).length;
    assert.deepEqual(r.branchInfo, { branch: sh(dir, "branch", "--show-current"), base: "main", ahead, behind });
    assert.equal(r.files.length, files);
    console.log(`  ${name}: ${ahead} ahead, ${behind} behind, ${files} files`);
  });
}
