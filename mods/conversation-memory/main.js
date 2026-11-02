import { View, div } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { run, props, closeOverlay, theme, commands } from "herdr";

export default class ConversationMemory extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  perform(command) {
    if (this.started) return;
    this.started = true;
    closeOverlay(props().overlay);
    run(command);
  }

  render() {
    const t = theme();
    const available = commands().some(c => c.name === "session.save");
    return v_flex().id("conversation-memory").size_full().p(20).gap(14).bg(t.popover)
      .text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(div().text_size(17).font_semibold().child("대화 저장 · 복원"))
      .child(div().text_color(t.muted).child("현재 대화를 저장할까요, 저장된 대화를 복원할까요?"))
      .child(div().flex_1().min_h(0).text_color(t.muted).child(available
        ? "지금 저장: 모든 로컬 워크스페이스의 대화 ID와 탭 연결을 즉시 저장합니다.\n\n복원: 현재 탭에서 사라진 AI 대화만 이어 엽니다. 실행 중인 대화는 중복 실행하지 않으며 직접 닫은 탭은 다시 열지 않습니다.\n\n자동 저장·복원도 계속 작동합니다. 처리 결과는 화면 알림으로 표시됩니다."
        : "이 실행 파일에는 대화 저장·복원 기능이 없습니다. 개인 개선판을 설치해야 사용할 수 있습니다."))
      .child(h_flex().gap(8).justify_end()
        .child(Button.new("conversation-cancel").h(34).px(12).on_click(() => closeOverlay(props().overlay)).child("취소"))
        .child(Button.new("conversation-save").h(34).px(12).disabled(!available || Boolean(this.started)).on_click(() => this.perform("session.save")).child("지금 저장"))
        .child(Button.new("conversation-restore").h(34).px(12).bg(t.solid).text_color(t.solid_foreground).disabled(!available || Boolean(this.started)).on_click(() => this.perform("session.restore")).child("저장된 대화 복원")));
  }
}
