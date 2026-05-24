// Design Ref: §2.1 — 시간성 쿼리 감지 + source 단위 recency 점수
// Plan SC: SC1 (신규 source 컨텍스트 진입), SC3 (false positive 차단)

import type { WikiSource } from './types';

export const RECENCY_KEYWORDS: readonly string[] = [
  '최근', '최신', '이번', '요즘', '현재', '근래', '지난',
  '올해', '작년', '이번달', '지난달', '이번주', '지난주',
] as const;

export function detectRecencyIntent(query: string): boolean {
  const lower = query.toLowerCase();
  return RECENCY_KEYWORDS.some(kw => lower.includes(kw));
}

const DAY_MS = 1000 * 60 * 60 * 24;

function dateBoost(dateStr: string | undefined): number {
  if (!dateStr) return 0;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return 0;
  const days = (Date.now() - t) / DAY_MS;
  if (days < 0) return 20;
  if (days <= 90) return 20;
  if (days <= 180) return 15;
  if (days <= 365) return 10;
  if (days <= 730) return 5;
  return 0;
}

// Design Ref: §3.4 — sequence boost는 절대 점수 (max 동적 추출 안 함)
const SEQUENCE_PATTERN = /(\d+)기[-_]?(\d+)차/;

interface Sequence { gi: number; cha: number }

function parseSequence(id: string): Sequence | null {
  const m = id.match(SEQUENCE_PATTERN);
  if (!m) return null;
  return { gi: parseInt(m[1], 10), cha: parseInt(m[2], 10) };
}

function sequenceBoost(id: string): number {
  const seq = parseSequence(id);
  if (!seq) return 0;
  let score: number;
  if (seq.gi >= 19) score = 18;
  else if (seq.gi >= 18) score = 12;
  else if (seq.gi >= 15) score = 8;
  else if (seq.gi >= 10) score = 5;
  else score = 0;
  if (seq.cha >= 10) score += 2;
  else if (seq.cha >= 6) score += 1;
  return score;
}

// Design Ref: §3.2 — date 있으면 sequence 무시 (boost 중복 방지)
export function recencyScore(source: WikiSource): number {
  if (source.date) return dateBoost(source.date);
  return sequenceBoost(source.id);
}
