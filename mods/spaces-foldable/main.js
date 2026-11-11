// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state follows the Agents list. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, props, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, notify } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

const STATUS_RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

export default class Spaces extends View {
  init(_props, cx) {
    const config = props();
    this.parents = config?.parents && typeof config.parents === "object" && !Array.isArray(config.parents) ? config.parents : {};
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    this.pushing = new Set(); // common repos with a push already in flight
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    const folds = shared("spaces-foldable.folds");
    this.folded = new Set(folds?.machines ?? JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.foldedWorktrees = new Set(folds?.worktrees ?? JSON.parse(localStorage.getItem("worktrees.folded") ?? "[]"));
    if (!folds) this.saveFolds();
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      this.forgetGone();
      this.refreshing = false;
      cx.notify();
    });
  }

  // Places no space is at any more are forgotten, and repos only they used stop
  // being watched: a watch holds the folder open, and Windows then refuses to move it.
  forgetGone() {
    const ps = panes();
    const live = new Set(spaces().map((s) => where(s, ps)));
    for (const k of Object.keys(this.git)) {
      if (live.has(k)) continue;
      delete this.git[k];
      delete this.checked[k];
      this.unsure.delete(k);
    }
    const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
    for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  toggleWorktrees(repo, cx) {
    this.foldedWorktrees.has(repo) ? this.foldedWorktrees.delete(repo) : this.foldedWorktrees.add(repo);
    this.saveFolds();
    cx.notify();
  }

  push(w, g, cx) {
    if (!g?.branch || g.ahead < 1 || this.pushing.has(g.repo)) return;
    const key = where(w, panes()), [on, cwd] = JSON.parse(key);
    if (!cwd) return;
    this.pushing.add(g.repo);
    cx.notify();
    cx.spawn(async (cx) => {
      const git = async args => {
        const result = await exec("git", args, { cwd, on });
        if (result.code !== 0) throw new Error((result.stderr || result.stdout || "Git command failed").trim());
        return result.stdout.trim();
      };
      try {
        const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
        if (branch !== g.branch) throw new Error("브랜치가 변경되었습니다. 갱신된 화살표를 다시 클릭하세요.");
        const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        if (JSON.stringify([on, common]) !== g.repo) throw new Error("저장소 경로가 변경되었습니다. 갱신된 화살표를 다시 클릭하세요.");
        const [remote, ref] = (await git(["for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", "--", `refs/heads/${branch}`])).split("\0");
        if (!remote || remote === "." || !ref?.startsWith("refs/heads/")) throw new Error("추적 원격 브랜치가 없습니다. upstream 설정을 확인하세요.");
        const hash = await git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
        if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(hash)) throw new Error("푸시할 커밋을 확인할 수 없습니다.");
        // Explicit tracking ref: push defaults, mirror mode and tags cannot expand this click.
        await git(["-c", `remote.${remote}.mirror=false`, "-c", "push.followTags=false", "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no", "--", remote, `${hash}:${ref}`]);
        notify({ title: `${w.name} 푸시 완료`, body: `${branch} → ${remote}/${ref.slice(11)}`, level: "success" });
      } catch (e) {
        const body = String(e).replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@");
        notify({ title: `${w.name} 푸시 실패`, body, level: "error", timeout: 15000 });
      } finally {
        this.pushing.delete(g.repo);
        this.refreshGit(new Set(this.sameRepo(key, new Set(Object.keys(this.git)))), cx);
        cx.notify();
      }
    });
  }

  saveFolds() {
    setShared("spaces-foldable.folds", { machines: [...this.folded], worktrees: [...this.foldedWorktrees] });
  }

  // Explicit groups nest level under level (a business, its projects, their roles)
  // and survive sharing one checkout; Git worktrees still group automatically.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => {
      const tabs = new Set((w.tabs ?? []).map((tab) => tab.id));
      const working = ps.find((p) => tabs.has(p.tab) && p.status === "working");
      return { w, i, status: w.status ?? null, agent: working?.program?.key ?? null, g: this.git[where(w, ps)] ?? null };
    }).filter((r) => this.shown.has(r.w.id));
    const byId = new Map(list.map((r) => [r.w.id, r]));
    const explicitOf = (r) => {
      const parent = byId.get(this.parents[r.w.id]);
      return parent && parent !== r && (parent.w.machine ?? null) === (r.w.machine ?? null) ? parent : null;
    };
    // A repo's main checkout: not a worktree, nor a role placed inside its own project.
    const mains = new Map();
    for (const r of list) {
      const up = explicitOf(r);
      if (r.g && !r.g.linked && up?.g?.repo !== r.g.repo && !mains.has(r.g.repo)) mains.set(r.g.repo, r);
    }
    const parentOf = new Map();
    for (const r of list) {
      const up = explicitOf(r) ?? (r.g?.linked ? mains.get(r.g.repo) : null);
      if (up && up !== r) parentOf.set(r, up);
    }
    // Declarations that loop would hide each other: those spaces stay on top.
    const looped = list.filter((r) => {
      let up = parentOf.get(r);
      for (let n = 0; up && n < list.length; n++, up = parentOf.get(up)) if (up === r) return true;
      return false;
    });
    for (const r of looped) parentOf.delete(r);
    const kids = new Map();
    for (const r of list) if (parentOf.has(r)) kids.set(parentOf.get(r), [...(kids.get(parentOf.get(r)) ?? []), r]);
    const below = (r) => (kids.get(r) ?? []).flatMap((k) => [k, ...below(k)]);
    const out = [];
    const emit = (r, depth, tree) => {
      const row = { ...r, depth, tree };
      out.push(row);
      const mine = kids.get(r);
      if (!mine) return;
      const explicit = mine.some((k) => explicitOf(k) === r);
      const group = explicit ? JSON.stringify([r.w.machine ?? null, "space", r.w.id]) : r.g?.repo;
      if (explicit && r.g?.repo && this.foldedWorktrees.has(r.g.repo)) {
        this.foldedWorktrees.delete(r.g.repo);
        this.foldedWorktrees.add(group);
        this.saveFolds();
      }
      row.group = group;
      if (this.foldedWorktrees.has(group)) {
        // Hidden levels still surface the most urgent agent state.
        const top = below(r).reduce((best, k) => (STATUS_RANK[k.status] ?? 0) > (STATUS_RANK[best.status] ?? 0) ? k : best, row);
        row.status = top.status;
        row.agent = top.agent;
        return;
      }
      mine.forEach((k, n) => emit(k, depth + 1, n === mine.length - 1 ? "└─" : "├─"));
    };
    for (const r of list) if (!parentOf.has(r)) emit(r, 0, null);
    return out;
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const draw = (r) => (collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          this.saveFolds();
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      return [head, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t, w) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    const pushing = this.pushing.has(g.repo);
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0 || pushing, (el) => el.child(div().id(`space-push-${w.id}`).flex_none().px(3).rounded(4).text_color(t.ansi2)
        .tooltip(pushing ? "푸시 중…" : `${name}: 추적 원격 브랜치로 푸시`)
        .when(!pushing, button => button.cursor_pointer().hover(s => s.bg(t.hover)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.push(w, g, cx); })
        .child(pushing ? "↑…" : `\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  // A shell-only space stays blank; working agents have distinct colors.
  statusIndicator(t, status, agent) {
    const slot = h_flex().w(14).h(18).flex_none().items_center().justify_center();
    if (status === "working") return slot.child(svg("mods/workspace-chrome/spinner.svg").size(12).text_color(agent === "codex" ? t.ansi4 : agent === "claude" ? t.working : t.ansi5).spin(900));
    if (status === "blocked") return slot.child(div().size(14).rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!"));
    if (status === "done") return slot.child(div().size(7).rounded(4).bg(t.done));
    if (status === "idle") return slot.child(div().size(7).rounded(4).border(1.5).border_color(t.idle ?? t.dim));
    return slot;
  }

  // "+" left of a repo space's avatar: the shipped New worktree dialog for that space.
  // Every row keeps the slot, so names and the worktree rows' indent stay aligned.
  worktreeAdd(w, shown, t) {
    const slot = div().w(16).h(20).flex_none();
    if (!shown) return slot;
    const stop = (_e, cx) => cx.stop_propagation();
    return slot.id(`worktree-add-${w.id}`).flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_mouse_up("left", stop)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: w.id, action: "new" } });
      })
      .child(svg("mods/workspace-chrome/plus.svg").size(12));
  }

  row({ w, i, g, tree, depth, group, status, agent }, t) {
    const on = w.active;
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .child(this.worktreeAdd(w, g && !tree, t))
          .when(Boolean(tree), el => el.pl(22 * depth).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().min_w(0).flex_shrink(1).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .when(Boolean(group), el => el.child(div().id(`worktrees-toggle-${w.id}`).w(20).h(22).flex_none()
            .flex().items_center().justify_center().rounded(4).cursor_pointer().text_size(10).text_color(t.muted)
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.toggleWorktrees(group, cx); })
            .child(this.foldedWorktrees.has(group) ? "▶" : "▼")))
          .child(g ? this.gitTail(g, tree, w.name, t, w) : div().flex_1())
          .child(this.statusIndicator(t, status, agent)),
      );
  }

  compact({ w, i, status, agent }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(this.statusIndicator(t, status, agent));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
