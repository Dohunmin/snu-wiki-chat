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
