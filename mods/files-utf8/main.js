// A folder browser with a clickable path, drive/parent navigation and new folders.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Button, Popover, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, appHome, notify } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const PER_FOLDER = 500, TOTAL = 5000;

function parentFolder(path, windows) {
  if (!path) return null;
  const normalized = windows ? path.replaceAll("\\", "/") : path;
  const root = windows ? normalized.match(/^(?:[a-z]:|\/\/[^/]+\/[^/]+)(?=\/|$)/i)?.[0] : "";
  if (windows && !root) return null;
  const clean = normalized.replace(/\/+$/, "");
  if (!clean || clean === root) return null;
  let parent = clean.slice(0, clean.lastIndexOf("/")) || "/";
  if (windows && parent === root) parent += "/";
  return windows && path.includes("\\") ? parent.replaceAll("/", "\\") : parent;
}

// The folder's path as clickable segments; each path keeps the folder's own separator style.
function pathCrumbs(path, windows) {
  if (!path) return [];
  const sep = windows && path.includes("\\") ? "\\" : "/";
  const unc = windows ? path.match(/^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)/) : null;
  const drive = windows ? path.match(/^([a-z]):/i) : null;
  let base, rest;
  if (unc) { base = { label: `${sep}${sep}${unc[1]}${sep}${unc[2]}`, path: `${sep}${sep}${unc[1]}${sep}${unc[2]}` }; rest = path.slice(unc[0].length); }
  else if (drive) { base = { label: `${drive[1].toUpperCase()}:`, path: `${drive[1].toUpperCase()}:${sep}` }; rest = path.slice(2); }
  else if (!windows && path.startsWith("/")) { base = { label: "/", path: "/" }; rest = path; }
  else { base = null; rest = path; }
  const out = base ? [base] : [];
  let at = base ? base.path.replace(/[\\/]+$/, "") : null;
  for (const part of rest.split(/[\\/]+/).filter(Boolean)) {
    at = at === null ? part : `${at}${sep}${part}`;
    out.push({ label: part, path: at });
  }
  return out;
}

function joinPath(folder, name) {
  const sep = folder.includes("\\") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}${name}`;
}

// Git reports forward slashes; Windows paths compare without case or separator differences.
function markKey(path, windows) {
  const clean = path.replaceAll("\\", "/").replace(/\/{2,}/g, (m, i) => i === 0 ? m : "/");
  return windows ? clean.toLowerCase() : clean;
}

function folderNameError(name, windows) {
  if (!name) return "폴더 이름을 입력하세요.";
  if (name === "." || name === ".." || name.length > 255) return "사용할 수 없는 폴더 이름입니다.";
  if (/[\x00-\x1f/]/.test(name)) return "폴더 이름에 / 또는 제어 문자는 사용할 수 없습니다.";
  if (windows && /[\\:*?"<>|]/.test(name)) return '폴더 이름에 \\ / : * ? " < > | 는 사용할 수 없습니다.';
  if (windows && /[ .]$/.test(name)) return "폴더 이름은 공백이나 마침표로 끝날 수 없습니다.";
  if (windows && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) return "Windows 예약 이름은 사용할 수 없습니다.";
  return null;
}

async function drives() {
  const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @([IO.Directory]::GetLogicalDrives()) | ConvertTo-Json -Compress"]);
  if (r.code !== 0) throw new Error(r.stderr || "드라이브 목록을 읽을 수 없습니다");
  const result = JSON.parse(r.stdout || "[]");
  return (Array.isArray(result) ? result : [result]).filter(p => typeof p === "string" && /^[a-z]:\\$/i.test(p)).sort();
}

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    // Herdr reads stdout as UTF-8; Windows PowerShell otherwise uses the legacy console encoding.
    const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-File", `${appHome()}/mods/files-utf8/list-windows.ps1`, "-Folder", path, "-AppHome", appHome()]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

async function makeFolder(parent, name, on) {
  const r = !on && window()?.platform === "windows"
    ? await exec("powershell", ["-NoProfile", "-NonInteractive", "-File", `${appHome()}/mods/files-utf8/new-folder-windows.ps1`, "-Parent", parent, "-Name", name])
    : await exec("mkdir", [joinPath(parent, name)], { on });
  if (r.code !== 0) throw new Error(r.stderr?.trim() || "폴더를 만들 수 없습니다");
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.drives = []; this.driveMenu = false; this.driveAt = 0; this.driveFocus = cx.focus_handle();
    this.entries = []; this.marks = {}; this.selected = null; this.creating = null;
    this.nameInput = InputState.new({ placeholder: "새 폴더 이름" });
    this.nameInput.on("submit", (_e, cx) => this.createFolder(cx));
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  refresh(cx, browseRoot) {
    const source = location(), next = key();
    if (next !== this.context?.key || browseRoot !== undefined) {
      if (this.context) this.saved.set(this.context.key, { root: this.root });
      const saved = browseRoot === undefined ? this.saved.get(next) : null;
      const cwd = browseRoot ?? saved?.root ?? source.cwd, on = source.on;
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = [];
      this.marks = {}; this.selected = null; this.creating = null; this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.driveMenu = false; this.drivesLoading = false;
    }
    const { cwd, on } = this.context;
    if (!cwd || this.loading) return;
    const context = this.context, windows = !on && window()?.platform === "windows";
    this.loading = true;
    this.iconError = null;
    cx.spawn(async cx => {
      try {
        const entries = await directory(cwd, on);
        if (!this.current(context)) return;
        const iconError = entries.find(entry => entry.iconError)?.iconError;
        if (iconError) this.iconError = `Windows 아이콘을 읽지 못해 기본 아이콘을 표시합니다: ${iconError}`;
        this.limited = entries.length > PER_FOLDER;
        this.entries = entries.slice(0, PER_FOLDER).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
        if (this.selected && !this.entries.some(e => e.dir && e.name === this.selected)) this.selected = null;
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[markKey(`${top.stdout.trim()}/${entry.slice(3)}`, windows)] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  navigate(path, cx) {
    this.driveMenu = false;
    if (path && path !== this.root) this.refresh(cx, path);
    cx.notify();
  }

  loadDrives(cx) {
    if (this.on || window()?.platform !== "windows" || this.drivesLoading) return;
    const context = this.context;
    this.drivesLoading = true; this.driveError = null; this.drives = []; this.driveAt = 0;
    cx.spawn(async cx => {
      try { const list = await drives(); if (this.current(context)) this.drives = list; }
      catch (e) { if (this.current(context)) this.driveError = String(e); }
      finally { if (this.context === context) this.drivesLoading = false; cx.notify(); }
    });
  }

  drivePicker(t) {
    const label = this.root?.match(/^[a-z]:/i)?.[0].toUpperCase() ?? "드라이브";
    return Popover.new("files-drive-picker").open(this.driveMenu).anchor("top_left").track_focus(this.driveFocus)
      .on_open_change((open, cx) => { this.driveMenu = open; if (open) this.loadDrives(cx); cx.notify(); })
      .trigger(Button.new("files-drive").h(26).px(6).rounded(5).text_size(12).text_color(t.muted).hover(s => s.bg(t.hover)).tooltip("드라이브 선택").child(`${label} ▾`))
      .content(v_flex().id("files-drive-list").w(160).max_h(260).overflow_y_scrollbar().p(5).gap(2).bg(t.popover).rounded(6).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
        .on_key_down((e, cx) => {
          if (!this.drives.length) return;
          if (e.key === "down") this.driveAt = (this.driveAt + 1) % this.drives.length;
          else if (e.key === "up") this.driveAt = (this.driveAt + this.drives.length - 1) % this.drives.length;
          else if (e.key === "enter") this.navigate(this.drives[this.driveAt], cx);
          else return;
          cx.notify();
        })
        .children(this.drives.map((path, i) => Button.new(`files-drive-${path[0]}`).w_full().h(28).px(8).rounded(4).text_left()
          .bg(i === this.driveAt ? t.hover : t.popover).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.navigate(path, cx)).child(path)))
        .when(!this.drives.length, el => el.child(div().p(8).child(this.driveError || (this.drivesLoading ? "드라이브 읽는 중…" : "드라이브 없음")))));
  }

  // One click selects a folder; a double click enters it or opens a file in its Windows program.
  entryClick(entry, e, cx) {
    if (entry.dir) {
      if (e.click_count === 2) this.navigate(joinPath(this.root, entry.name), cx);
      else { this.selected = entry.name; cx.notify(); }
      return;
    }
    if (e.click_count !== 2 || this.on || window()?.platform !== "windows") return;
    const fullPath = joinPath(this.root, entry.name);
    cx.spawn(async () => {
      try {
        const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-File", `${appHome()}/mods/files-utf8/open-windows.ps1`, "-Path", fullPath]);
        if (r.code !== 0) throw new Error(r.stderr || "기본 프로그램을 실행할 수 없습니다");
      } catch (error) { notify({ title: "파일 열기 실패", body: String(error), level: "error", timeout: 15000 }); }
    });
  }

  // The target is fixed when the name box opens, so a pane switch cannot redirect it.
  startCreate(cx) {
    if (!this.root) return;
    const parent = this.selected ? joinPath(this.root, this.selected) : this.root;
    this.creating = { parent, context: this.context, label: this.selected ?? pathCrumbs(this.root, !this.on && window()?.platform === "windows").at(-1)?.label ?? this.root };
    this.nameInput.set_value("새 폴더");
    this.nameInput.focus();
    cx.notify();
  }

  cancelCreate(cx) {
    this.creating = null;
    cx.notify();
  }

  createFolder(cx) {
    const creating = this.creating;
    if (!creating || creating.busy) return;
    const name = this.nameInput.value().trim(), windows = !creating.context.on && window()?.platform === "windows";
    const problem = folderNameError(name, windows);
    if (problem) { notify({ title: "새 폴더", body: problem, level: "error", timeout: 8000 }); return; }
    creating.busy = true;
    cx.spawn(async cx => {
      try {
        await makeFolder(creating.parent, name, creating.context.on);
        if (this.creating === creating) this.creating = null;
        if (!this.current(creating.context)) return;
        // Show the new folder: enter the selected folder it was made in, then select it.
        if (creating.parent !== this.root) this.refresh(cx, creating.parent);
        else this.refresh(cx);
        this.selected = name;
      } catch (error) {
        creating.busy = false;
        notify({ title: "새 폴더를 만들지 못했습니다", body: String(error.message ?? error), level: "error", timeout: 15000 });
      } finally { cx.notify(); }
    });
  }

  breadcrumbs(t, windows) {
    const crumbs = pathCrumbs(this.root, windows), sep = windows ? "\\" : "/";
    return h_flex().id("files-path").flex_none().flex_wrap().px(10).py(5).gap(1).items_center().border_b(1).border_color(t.border).text_size(12).text_color(t.muted)
      .children(crumbs.flatMap((crumb, i) => {
        const last = i === crumbs.length - 1;
        const part = div().id(`files-crumb-${i}`).px(3).py(1).rounded(4).cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
          .when(last, el => el.text_color(t.foreground).font_semibold())
          .tooltip(crumb.path).on_click((_e, cx) => this.navigate(crumb.path, cx)).child(crumb.label);
        return i === 0 || (i === 1 && crumbs[0].label === "/") ? [part] : [div().text_color(t.dim).child(sep), part];
      }));
  }

  createRow(t) {
    return h_flex().id("files-new-folder").h(32).flex_none().pl(8).pr(6).gap(7).items_center().rounded(7).bg(t.hover)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.cancelCreate(cx); cx.stop_propagation(); } })
      .child(svg("mods/files-utf8/folder.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).h(24).px(6).flex().items_center().rounded(5).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.nameInput).h_full().text_size(12).text_color(t.foreground)))
      .child(Button.new("files-new-folder-ok").h(24).px(6).rounded(5).text_size(12).text_color(t.foreground).hover(s => s.bg(t.background)).tooltip(`${this.creating.parent} 안에 만들기 (Enter)`)
        .on_click((_e, cx) => this.createFolder(cx)).child("만들기"))
      .child(Button.new("files-new-folder-cancel").size(24).rounded(5).text_color(t.muted).hover(s => s.bg(t.background)).tooltip("취소 (Esc)")
        .on_click((_e, cx) => this.cancelCreate(cx)).child("✕"));
  }

  rows(t, windows) {
    return this.entries.map(entry => {
      const mark = this.marks[markKey(joinPath(this.root, entry.name), windows)], selected = entry.dir && entry.name === this.selected;
      return h_flex().id(`file-${entry.name}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(selected, el => el.bg(t.hover))
        .on_click((e, cx) => this.entryClick(entry, e, cx))
        .child(entry.icon ? image(selected && entry.openIcon ? entry.openIcon : entry.icon).size(16).flex_none()
          : svg(`mods/files-utf8/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
    });
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), windows = !this.on && window()?.platform === "windows", parent = parentFolder(this.root, windows);
    const target = this.selected ? `선택한 폴더 '${this.selected}'` : "현재 폴더";
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().child("Files"))
        .when(windows, el => el.child(this.drivePicker(t)))
        .child(Button.new("files-up").size(26).flex_none().rounded(5).disabled(!parent).text_color(parent ? t.muted : t.dim).hover(s => s.bg(t.hover))
          .tooltip("상위 폴더").on_click((_e, cx) => this.navigate(parent, cx)).child("↑"))
        .child(div().flex_1())
        .child(Button.new("files-new-folder-button").h(26).px(6).flex_none().rounded(5).disabled(!this.root).text_size(12).text_color(t.muted).hover(s => s.bg(t.hover))
          .tooltip(`${target} 안에 새 폴더`).on_click((_e, cx) => this.startCreate(cx))
          .child(h_flex().gap(3).items_center().child(svg("mods/files-utf8/folder.svg").size(13).text_color(t.muted)).child("+ 새 폴더"))))
      .when(Boolean(this.root), el => el.child(this.breadcrumbs(t, windows)))
      .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .when(Boolean(this.creating), el => el.child(this.createRow(t)))
        .children(this.rows(t, windows))
        .when(Boolean(this.error) || !this.entries.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(Boolean(this.iconError), el => el.child(div().p(8).text_size(11).text_color(t.dim).child(this.iconError)))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder"))));
  }
}
