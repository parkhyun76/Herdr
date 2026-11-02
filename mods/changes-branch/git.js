// Git reads for the Changes panel. `git(args)` runs git in the repo root and resolves
// to { code, stdout, stderr }, so this module runs the same in Herdr and in Node tests.

// "vs main" compares against the first of these that exists in the repo.
export const BASES = ["main", "master", "origin/main", "origin/master"];
export const MAX_FILES = 1000;

const statusOf = (code) => code.includes("U") ? "U" : code.includes("D") ? "D" : code.includes("A") ? "A" : "M";

// `git diff --numstat -z --no-renames` → { path: {add, del, binary} }, summed over results.
export function numstats(results) {
  const stats = {};
  for (const result of results) {
    if (result.code !== 0) throw new Error(result.stderr);
    for (const entry of result.stdout.split("\0")) {
      const [a, d, ...parts] = entry.split("\t");
      if (!parts.length) continue;
      const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
      stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
    }
  }
  return stats;
}

// Uncommitted changes: the working tree and index against HEAD.
export async function collectWorking(git) {
  const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  if (status.code !== 0) throw new Error(status.stderr);
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  const stats = numstats(head.code === 0
    ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
    : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])]);
  const entries = status.stdout.split("\0").filter(Boolean);
  const files = entries.slice(0, MAX_FILES).map((entry) => {
    const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
    const s = xy === "AA" || xy === "DD" ? "U" : fresh ? "A" : statusOf(xy);
    return { path, status: s, fresh, ...(stats[path] ?? { add: 0, del: 0 }) };
  });
  return { files, limited: entries.length > MAX_FILES, hasHead: head.code === 0, branchInfo: null };
}

// Committed work on this branch since it left the base: `git diff <base>...HEAD`.
export async function collectBranch(git) {
  const branch = (await git(["branch", "--show-current"])).stdout.trim();
  let base = null;
  for (const name of BASES) {
    if ((await git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`])).code === 0) { base = name; break; }
  }
  if (!base) throw new Error(`No ${BASES.join(" / ")} branch to compare with`);
  const range = `${base}...HEAD`;
  const counts = await git(["rev-list", "--left-right", "--count", range]);
  if (counts.code !== 0) throw new Error(counts.stderr);
  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
  const names = await git(["diff", "--name-status", "-z", "--no-renames", range]);
  if (names.code !== 0) throw new Error(names.stderr);
  const stats = numstats([await git(["diff", "--numstat", "-z", "--no-renames", range])]);
  const parts = names.stdout.split("\0").filter(Boolean), files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const path = parts[i + 1];
    files.push({ path, status: statusOf(parts[i]), fresh: false, ...(stats[path] ?? { add: 0, del: 0 }) });
  }
  return { files: files.slice(0, MAX_FILES), limited: files.length > MAX_FILES, hasHead: true, branchInfo: { branch, base, ahead, behind } };
}

// What one file's diff is taken against: the branch base, HEAD, or (no commits yet) the index.
export function diffAgainst(branchInfo, hasHead) {
  return branchInfo ? [`${branchInfo.base}...HEAD`] : hasHead ? ["HEAD"] : [];
}
