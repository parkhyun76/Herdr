// Status is evidence about the last observed hook, never a promise about a future turn.
export const descriptions = {
  missing_key: '키 입력 필요', credential_error: '키 확인 필요', disabled: '꺼짐', ready: '첫 요청 대기',
  pending: '판단 중', applied: '최근 요청 적용', uncertain: '최근 판단 불확실', ended: '대화 종료',
  timeout: '시간 초과', network_error: '연결 실패', unauthorized: '인증 실패', rate_limited: '호출 한도',
  api_error: 'API 오류', invalid_response: '응답 오류', invalid_input: '입력 오류', storage_error: '기록 오류',
  busy: '이전 판단 진행 중', configuration_error: '설정 오류', unconfirmed: '호출 확인 전',
  unavailable: '상태 읽기 실패', not_installed: '설치 확인 필요', unsupported: '로컬 Claude·Codex 대상', loading: '확인 중',
};
export function statusView(record, terminal, now = Date.now()) {
  if (!record || record.version !== 1 || record.terminal !== terminal || !Number.isFinite(record.updated_ms)
    || record.updated_ms > now + 60000 || !Object.hasOwn(descriptions, record.status)) return { status: 'unconfirmed', label: descriptions.unconfirmed };
  const stale = now - record.updated_ms > 86400000;
  const status = record.status === 'pending' && now - record.updated_ms > 15000 ? 'timeout' : record.status;
  return { ...record, status, label: `${stale ? '이전 기록 · ' : ''}${descriptions[status]}` };
}
export async function readStatus(read, appHome, terminal, now = Date.now()) {
  if (!/^t[a-z0-9]{1,30}$/.test(terminal ?? "")) return { status: 'unsupported', label: descriptions.unsupported };
  let runtime;
  try { runtime = JSON.parse(await read(`${appHome}/data/jev/runtime.json`)); }
  catch { return { status: 'not_installed', label: descriptions.not_installed }; }
  if (runtime.version !== 1 || typeof runtime.directory !== 'string' || !/^[a-z]:[\\/]/i.test(runtime.directory)) return { status: 'unavailable', label: descriptions.unavailable };
  let config;
  try { config = JSON.parse(await read(`${runtime.directory}/config.json`)); }
  catch { return { status: 'unavailable', label: descriptions.unavailable }; }
  if (!config || typeof config.enabled !== 'boolean') return { status: 'unavailable', label: descriptions.unavailable };
  if (config.enabled === false) return { status: 'disabled', label: descriptions.disabled };
  try { return statusView(JSON.parse(await read(`${runtime.directory}/terminals/${terminal}.json`)), terminal, now); }
  catch { return { status: 'unconfirmed', label: descriptions.unconfirmed }; }
}
