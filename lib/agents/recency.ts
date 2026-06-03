// Design Ref: recency-boost (v2) — guarantee 방식
// "최근/최신/이번/올해" 등 시간성 쿼리 감지 → date 내림차순 top-N source를 무조건 컨텍스트 진입.
// 점수 가산이 아니라 직접 주입이라 RRF/cap 단계에서 절대 누락 안 됨.

import type { WikiSource } from './types';

export const RECENCY_KEYWORDS: readonly string[] = [
  '최근', '최신', '이번', '요즘', '현재', '근래', '지난',
  '올해', '작년', '이번달', '지난달', '이번주', '지난주',
] as const;

export function detectRecencyIntent(query: string): boolean {
  const lower = query.toLowerCase();
  return RECENCY_KEYWORDS.some(kw => lower.includes(kw));
}

// 폭형(breadth) 의도 — "한 위키의 여러 기록을 폭넓게/시간순으로" 필요한 질문.
//   semantic top-K는 분산된 일부만 따내 폭형을 못 풂(rag 감사 rank2/3). 라우터가 이걸 감지하면
//   키워드-매칭 위키를 dispatch에 강제 추가 → 그 위키의 recency 주입·전체 커버리지가 fire.
//   over-retrieval 걱정 없음: 최종 보편 예산(enforceContextBudget)이 총량 캡.
const BREADTH_KEYWORDS: readonly string[] = [
  '시간순', '순서대로', '차례로', '차례대로', '경과', '연혁', '흐름', '추이', '변천',
  '모든', '전부', '빠짐없이', '목록', '리스트', '전체 기록', '전체 내역', '시계열',
] as const;
const SESSION_NUM_RE = /\d+\s*[,~·및\s]+\s*\d+\s*차|\d+\s*차/;  // "7,8차" / "제10차" / "10차"

export function detectBreadthIntent(query: string): boolean {
  if (detectRecencyIntent(query)) return true;            // 최신성도 폭형의 일종
  const lower = query.toLowerCase();
  if (BREADTH_KEYWORDS.some(kw => lower.includes(kw))) return true;
  return SESSION_NUM_RE.test(query);                       // N차 회의 열거
}

/**
 * 시간성 쿼리에서 컨텍스트에 무조건 진입시킬 source IDs.
 * date 있는 source만 대상, 내림차순 정렬, top N.
 * date 없는 source는 시점 정보 자체가 없어서 "최신"의 정의가 모호 → 제외.
 */
export function getRecencySources(sources: WikiSource[], topN = 5): string[] {
  return sources
    .filter(s => s.date)
    .sort((a, b) => (b.date as string).localeCompare(a.date as string))
    .slice(0, topN)
    .map(s => s.id);
}
