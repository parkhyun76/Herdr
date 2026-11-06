import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, keys, shared, focused, readTextFile, appHome, setShared } from "herdr";
import { readStatus, descriptions } from "./jev.js";

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.refreshJev(cx);
    cx.timer.every(1000, cx => { this.refreshJev(cx); cx.notify(); });
  }

  refreshJev(cx) {
    const terminal = focused()?.terminal;
    if (this.jevTerminal !== terminal) {
      this.jevTerminal = terminal;
      this.jevAt = 0;
      setShared("jev.current", { terminal, status: "loading", label: descriptions.loading });
    }
    if (window()?.platform !== "windows" || !/^t[a-z0-9]{1,30}$/.test(terminal ?? "")) {
      setShared("jev.current", { terminal, status: "unsupported", label: descriptions.unsupported });
      return;
    }
    if (this.jevPending || Date.now() - (this.jevAt ?? 0) < 2000) return;
    this.jevPending = true;
    cx.spawn(async cx => {
      try {
        const state = await readStatus(readTextFile, appHome(), terminal);
        if (focused()?.terminal === terminal) setShared("jev.current", { ...state, terminal });
      } catch {
        if (focused()?.terminal === terminal) setShared("jev.current", { terminal, status: "unavailable", label: descriptions.unavailable });
      } finally { this.jevPending = false; this.jevAt = Date.now(); cx.notify(); }
    });
  }

  progress(t) {
    const p = shared("session.manual-progress");
    if (!p || !Number.isFinite(p.updated_ms) || !Number.isInteger(p.step) || !["save", "restore"].includes(p.action) || Date.now() - p.updated_ms > (p.step === 3 ? 5000 : 60000)) return null;
    const step = Math.max(0, Math.min(3, p.step));
    const action = p.action === "save" ? "저장" : "복원 검사";
    const phase = p.failed ? "실패" : ["준비", "대화 확인", p.action === "save" ? "연결 저장" : "재개 요청", "완료"][step];
    return h_flex().id("session-progress").gap(6).items_center().flex_none()
      .child(div().child(`대화 ${action} · ${phase}`))
      .child(div().w(72).h(5).rounded(3).bg(t.input).child(div().w(72 * step / 3).h(5).rounded(3).bg(p.failed ? t.blocked : t.accent)))
      .when(!p.failed, el => el.child(div().child(`${step}/3`)));
  }

  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const list = agents();
    const needs = list.filter(a => a.status === "blocked").length;
    const progress = this.progress(t);
    const jev = shared("jev.current");
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .when(window()?.platform === "windows", el => el.child(div().id("jev-status-button").flex_none()
        .text_color(jev?.status === "applied" ? t.done : t.muted)
        .tooltip("현재 대화의 최근 Jev 호출 결과 보기")
        .on_click(() => run("mod.open", { name: "jev-status" }))
        .child(`Jev · ${jev?.label ?? "호출 확인 전"}`)))
      .when(Boolean(progress), el => el.child(progress))
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}
