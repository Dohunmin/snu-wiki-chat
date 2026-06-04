/**
 * 대화 메모리 — summary-buffer (Design: policy-agent §7, FR6/FR7).
 *
 * v1: **buffer + 예산** — 최근 메시지를 char 예산 내로 유지(오래된 것부터 탈락). 토론 연속성 ↑, 비용 바운드.
 *   토론(policy) 모드는 fact의 5턴보다 넓은 창을 쓰되 예산 상한으로 무한 누적 차단.
 * v2(후속): 예산 초과분을 Haiku로 요약해 "지금까지 논점…"으로 압축(현재는 탈락). research §6.2(D8).
 */

export interface ChatTurn { role: 'user' | 'assistant'; content: string; }

/**
 * 최근 메시지를 maxMessages·maxChars 예산 내로 선택 (최근 우선, 오래된 것부터 탈락).
 * 순수 함수 — LLM 호출 없음(무료).
 */
export function selectRecentHistory(
  all: ChatTurn[],
  opts: { maxMessages: number; maxChars: number },
): ChatTurn[] {
  const recent = all.slice(-opts.maxMessages);
  const kept: ChatTurn[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const len = recent[i].content.length;
    if (kept.length > 0 && used + len > opts.maxChars) break;  // 최소 1개는 보장, 그 다음부터 예산 적용
    kept.unshift(recent[i]);
    used += len;
  }
  return kept;
}
