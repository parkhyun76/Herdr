import { View, div } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { props, closeOverlay, shared, theme } from "herdr";

const tasks = { explain: "설명", status: "상태 조회", plan: "계획", implement: "구현", verify: "검증", operate: "운영", other: "기타" };
const checks = { answer: "사실 확인", software: "관련 테스트", hardware: "장치·CAD 근거", operational: "실제 결과 확인", unknown: "미확정" };
export default class JevStatus extends View {
  init(_props, cx) { this.handle = cx.focus_handle(); this.handle.focus(); }
  render() {
    const t = theme(), state = shared("jev.current") ?? { label: "호출 확인 전" };
    const lines = [`상태: ${state.label}`, `현재 터미널: ${state.terminal ?? "선택 없음"}`];
    if (Number.isFinite(state.updated_ms)) lines.push(`최근 수신: ${new Date(state.updated_ms).toLocaleString()}`);
    if (tasks[state.task?.choice]) lines.push(`요청: ${tasks[state.task.choice]} · 선택 확률 ${Math.round(state.task.probability * 100)}%`);
    if (checks[state.verification?.choice]) lines.push(`확인 근거: ${checks[state.verification.choice]}`);
    if (/^jev[-\w.]{1,60}$/.test(state.model ?? "")) lines.push(`모델: ${state.model} · ${state.duration_ms} ms · 입력 ${state.usage?.input_tokens ?? "?"} 토큰`);
    return v_flex().id("jev-status").size_full().p(20).gap(12).bg(t.popover).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(div().text_size(17).font_semibold().child("Jev 자동 판단"))
      .child(div().child(lines.join("\n")))
      .child(div().flex_1().min_h(0).text_color(t.muted).child("Herdr의 Claude·Codex 요청에 자동으로 참고 정보를 제공합니다.\n'호출 확인 전'은 이 대화의 실행 기록이 아직 없다는 뜻입니다.\n연결 실패 시에도 기본 작업은 계속됩니다.\n현재 요청과 제한된 최근 문맥이 TypeSafe로 전송됩니다."))
      .child(h_flex().justify_end().child(Button.new("jev-close").h(32).px(12).on_click(() => closeOverlay(props().overlay)).child("닫기")));
  }
}
