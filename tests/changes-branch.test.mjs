// node --test  (from the repo root) — exercises mods/changes-branch/git.js with real git.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { collectBranch, collectWorking, diffAgainst } = await import(new URL("../mods/changes-branch/git.js", import.meta.url).href);

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
