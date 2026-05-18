/**
 * Design Ref: §4.4 — RRF (Reciprocal Rank Fusion)
 * Plan SC: SC3 (RRF 융합 작동)
 *
 * 키워드 순위와 벡터 순위를 순위 기반으로 결합.
 * 가중치 1개(k)만 튜닝, 점수 스케일 정규화 불필요. 업계 표준.
 *
 * 공식:
 *   final_score(chunk) = 1/(k + rank_keyword) + 1/(k + rank_vector)
 *
 * 양쪽 모두에 잡힌 청크가 자연스럽게 부스트되고,
 * 한쪽만 잡힌 청크도 살아남음 (recall↑).
 *
 * 순수 함수, 외부 의존성 0 — 단위 테스트 용이.
 */

import type { KeywordRankedChunk, VectorSearchResult } from './types';

const DEFAULT_K = 60;       // RRF 상수 (작은 차이 흡수, 업계 표준값)
const DEFAULT_LIMIT = 30;

export interface RRFOptions {
  k?: number;
  limit?: number;
  /** 디버그 마커 — fused 결과에 'source' 필드를 추가하여 vec-only 청크 식별 */
  debug?: boolean;
}

export interface FusedChunk extends KeywordRankedChunk {
  /** 'keyword-only' | 'vector-only' | 'both' — 디버그용 */
  rrfSource?: 'keyword-only' | 'vector-only' | 'both';
}

/**
 * 키워드 결과와 벡터 결과를 RRF로 융합.
 *
 * @returns 키워드 청크 객체 형식 (벡터에서만 잡힌 것도 변환) — 후속 로직과 호환
 */
export function rrfFuse(
  keywordRanked: KeywordRankedChunk[],
  vectorRanked: VectorSearchResult[],
  opts: RRFOptions = {},
): FusedChunk[] {
  const { k = DEFAULT_K, limit = DEFAULT_LIMIT, debug = false } = opts;

  // 1) 키워드 결과: 페이지 ID 기준 1-based 순위 매핑
  const keywordRankMap = new Map<string, number>();
  keywordRanked.forEach((c, i) => {
    const key = `${c.type}:${c.id}`;
    if (!keywordRankMap.has(key)) keywordRankMap.set(key, i + 1);
  });

  // 2) 벡터 결과: 같은 키 포맷으로 순위 매핑
  const vectorRankMap = new Map<string, number>();
  vectorRanked.forEach((r, i) => {
    const key = `${r.pageType}:${r.pageId}`;
    if (!vectorRankMap.has(key)) vectorRankMap.set(key, i + 1);
  });

  // 3) Union 키 + RRF 점수 계산
  const allKeys = new Set([...keywordRankMap.keys(), ...vectorRankMap.keys()]);
  const fused: { key: string; score: number; source: 'keyword-only' | 'vector-only' | 'both' }[] = [];

  for (const key of allKeys) {
    const kr = keywordRankMap.get(key);
    const vr = vectorRankMap.get(key);
    const score =
      (kr ? 1 / (k + kr) : 0) +
      (vr ? 1 / (k + vr) : 0);
    const source = kr && vr ? 'both' : kr ? 'keyword-only' : 'vector-only';
    fused.push({ key, score, source });
  }

  // 4) RRF 점수 내림차순 정렬 후 limit
  fused.sort((a, b) => b.score - a.score);
  const top = fused.slice(0, limit);

  // 5) 원본 청크 데이터로 매핑 (first-wins — rankMap과 동일 규칙)
  // 키워드에 있으면 그것을, 없으면 벡터 결과를 청크 형태로 변환
  const keywordIndex = new Map<string, KeywordRankedChunk>();
  keywordRanked.forEach(c => {
    const key = `${c.type}:${c.id}`;
    if (!keywordIndex.has(key)) keywordIndex.set(key, c);
  });

  const vectorIndex = new Map<string, VectorSearchResult>();
  vectorRanked.forEach(v => {
    const key = `${v.pageType}:${v.pageId}`;
    if (!vectorIndex.has(key)) vectorIndex.set(key, v);
  });

  const result: FusedChunk[] = [];
  for (const item of top) {
    const existing = keywordIndex.get(item.key);
    if (existing) {
      // 키워드에서 잡힌 청크 — 기존 필드 보존 + RRF 점수로 교체
      result.push({
        ...existing,
        score: item.score,
        ...(debug && { rrfSource: item.source }),
      });
    } else {
      // 벡터에서만 잡힌 청크 — 키워드 결과 형식으로 변환
      const vr = vectorIndex.get(item.key);
      if (!vr) continue;   // 이론상 발생 안 함

      // PageType → KeywordRankedChunk.type 매핑
      // topic/entity는 KeywordRankedChunk type에 없어서 가장 가까운 매핑 사용
      const type: KeywordRankedChunk['type'] =
        vr.pageType === 'topic' || vr.pageType === 'entity'
          ? 'source'   // topic/entity는 source처럼 컨텍스트에 들어감
          : vr.pageType;

      result.push({
        type,
        id: vr.pageId,
        title: vr.metadata.title,
        chunk: vr.chunkText,
        score: item.score,
        ...(debug && { rrfSource: item.source }),
        // 메타데이터 통과 (출력 포맷에서 사용)
        meta: vr.metadata,
      });
    }
  }

  return result;
}

/**
 * 디버그용 — 융합 결과 요약 통계.
 */
export function rrfStats(fused: FusedChunk[]): {
  total: number;
  both: number;
  keywordOnly: number;
  vectorOnly: number;
} {
  let both = 0, keywordOnly = 0, vectorOnly = 0;
  for (const f of fused) {
    if (f.rrfSource === 'both') both++;
    else if (f.rrfSource === 'keyword-only') keywordOnly++;
    else if (f.rrfSource === 'vector-only') vectorOnly++;
  }
  return { total: fused.length, both, keywordOnly, vectorOnly };
}
