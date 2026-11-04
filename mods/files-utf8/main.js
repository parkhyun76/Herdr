// A lazy file browser with drive/parent navigation and bounded read-only previews.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Button, Popover, Editor, EditorState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, appHome, notify } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
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

export default class Files extends View {
  init(_props, cx) {
    this.doubleClickMs = 500;
    if (window()?.platform === "windows") cx.spawn(async () => {
      try {
        const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SystemInformation]::DoubleClickTime"]);
        const ms = Number(r.stdout.trim());
        if (r.code === 0 && ms >= 1 && ms <= 5000) this.doubleClickMs = ms;
      } catch { /* Use the Windows default if the setting cannot be read. */ }
    });
    this.saved = new Map();
    this.drives = []; this.driveMenu = false; this.driveAt = 0; this.driveFocus = cx.focus_handle();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
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

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const iconError = entries.find(entry => entry.iconError)?.iconError;
    if (iconError) this.iconError = `Windows 아이콘을 읽지 못해 기본 아이콘을 표시합니다: ${iconError}`;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx, browseRoot) {
    const source = location(), next = key();
    if (next !== this.context?.key || browseRoot !== undefined) {
      if (this.context) this.saved.set(this.context.key, { root: this.root, folders: this.folders, file: this.file });
      const saved = browseRoot === undefined ? this.saved.get(next) : null;
      const cwd = browseRoot ?? saved?.root ?? source.cwd, on = source.on;
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.driveMenu = false; this.drivesLoading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    const { cwd, on } = this.context;
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    this.iconError = null;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
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

  toggle(path, cx) {
    this.fileClickTimer?.cancel();
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  fileClick(path, e, cx) {
    if (this.on || window()?.platform !== "windows") { this.show(path, cx); return; }
    this.fileClickTimer?.cancel();
    if (e.click_count === 2 && this.lastClickedFile === path && this.lastClickedContext === this.context) {
      this.lastClickedFile = null;
      const fullPath = `${this.root}/${path}`;
      cx.spawn(async () => {
        try {
          const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-File", `${appHome()}/mods/files-utf8/open-windows.ps1`, "-Path", fullPath]);
          if (r.code !== 0) throw new Error(r.stderr || "기본 프로그램을 실행할 수 없습니다");
        } catch (error) { notify({ title: "파일 열기 실패", body: String(error), level: "error", timeout: 15000 }); }
      });
    } else {
      this.lastClickedFile = path; this.lastClickedContext = this.context;
      const context = this.context;
      this.fileClickTimer = cx.timer.after(this.doubleClickMs + 50, cx => {
        if (this.current(context)) { this.show(path, cx); cx.notify(); }
      });
    }
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((e, cx) => entry.dir ? this.toggle(path, cx) : this.fileClick(path, e, cx))
        .child(entry.dir ? svg(`mods/files-utf8/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(entry.icon ? image(open && entry.openIcon ? entry.openIcon : entry.icon).size(16).flex_none()
          : svg(`mods/files-utf8/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme(), windows = !this.on && window()?.platform === "windows", parent = parentFolder(this.root, windows);
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().flex_none().font_semibold().child("Files"))
        .when(windows, el => el.child(this.drivePicker(t)))
        .child(Button.new("files-up").size(26).flex_none().rounded(5).disabled(!parent).text_color(parent ? t.muted : t.dim).hover(s => s.bg(t.hover))
          .tooltip("상위 폴더").on_click((_e, cx) => this.navigate(parent, cx)).child("↑"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).tooltip(this.root ?? "").child(this.file ?? this.root?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(Boolean(this.iconError), el => el.child(div().p(8).text_size(11).text_color(t.dim).child(this.iconError)))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
