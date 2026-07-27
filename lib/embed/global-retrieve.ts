/**
 * Phase 3 (rag-cost-reduction.phase3.design §4.3) — 전역 top-K 검색 파이프라인.
 *
 * searchVectorGlobal(전 코퍼스 벡터) + 키워드 풀 RRF 융합(wikiId 키) +
 * similarity floor(무관 청크 방어 §8.1) + concept guaranteed protected union → finalK.
 *
 * 순수 오케스트레이션 — getContext 조립은 안 건드림(Option C). 실패 시 throw → router fallback.
 */
import { searchVectorGlobal } from './search';
import { rrfFuse } from './rrf';
import { rerankDocuments } from './voyage';
import type { KeywordRankedChunk, PageType, ChunkMetadata } from './types';
import type { Role } from '@/lib/auth/roles';

export interface GlobalChunk {
  wikiId: string;
  type: PageType;
  id: string;
  title: string;
  chunk: string;
  score: number;          // RRF 점수
  similarity?: number;    // 벡터 cosine
  kwScore?: number;       // 키워드 원점수
  rerankScore?: number;   // Stage-2 cross-encoder 관련도 (0~1, rerank 활성 시)
  topic?: string;
  date?: string;
  meta?: ChunkMetadata | string;
  protected?: boolean;    // guaranteed = floor/finalK 면제
}

export interface GlobalTopKOptions {
  candidateK?: number;    // 후보 풀 크기 (기본 80)
  finalK?: number;        // LLM 통과 상한 (기본 16, A: 24→16 -26% 컨텍스트) — floor로 더 줄 수 있음(adaptive)
  allowedWikiIds: string[];                 // ★ 보안 allowlist
  keywordPool: KeywordRankedChunk[];        // routable 위키 keywordCandidates 합집합
  forceIncludeIds?: Map<string, Set<string>>; // wikiId → concept guaranteed page ids
  simFloor?: number;      // similarity floor (기본 0.40, env SIM_CUT_CHUNK 정렬)
}

const KW_STRONG = 3;

export async function globalTopK(
  query: string,
  userRole: Role,
  opts: GlobalTopKOptions,
): Promise<GlobalChunk[]> {
  const {
    candidateK = 80, finalK = Number(process.env.GLOBAL_FINAL_K ?? '16'),
    allowedWikiIds, keywordPool, forceIncludeIds,
    simFloor = Number(process.env.SIM_CUT_CHUNK ?? '0.40'),
  } = opts;

  // 1. 전 코퍼스 벡터 후보 (allowlist 보안 내장)
  const vec = await searchVectorGlobal(query, userRole, candidateK, { allowedWikiIds });

  // 2. 키워드 풀 + 벡터 RRF 융합 (wikiId 키 — P3a-1b)
  const fused = rrfFuse(keywordPool, vec, { k: 60, limit: candidateK });

  // 2.5 Stage-2 리랭커 (rag 감사 rank1): cross-encoder가 (query,chunk)를 함께 읽어 관련도 재채점.
  //   cosine 노이즈(0.55~0.80 띠에서 무관>관련 역전)를 교정 → finalK·하드예산이 안전해짐.
  //   RERANK_ENABLED=true에서만. 실패 시 RRF 순서 유지(graceful). 비용 ~$0.0001/쿼리.
  let rerankScore: Map<number, number> | null = null;
  if (process.env.RERANK_ENABLED === 'true' && fused.length > 0) {
    try {
      const docs = fused.map(f => `${f.title}\n${f.chunk}`.slice(0, 4000));
      const rr = await rerankDocuments(query, docs);
      rerankScore = new Map(rr.map(r => [r.index, r.relevanceScore]));
    } catch (err) {
      console.error('[globalTopK] rerank 실패 — RRF 순서 유지:', err);
    }
  }

  const isGuaranteed = (wikiId: string, id: string) => forceIncludeIds?.get(wikiId)?.has(id) ?? false;

  const all: GlobalChunk[] = fused.map((f, idx) => {
    const wikiId = (f.wikiId as string | undefined) ?? '';
    const rs = rerankScore?.get(idx);
    return {
      wikiId,
      type: f.type as PageType,
      id: f.id,
      title: f.title,
      chunk: f.chunk,
      // rerank 활성 시 score=관련도 → 다운스트림(getContext 정렬·finalK)이 rerank 순서를 따름. 아니면 RRF.
      score: rs ?? f.score,
      similarity: f.similarity,
      kwScore: f.kwScore,
      rerankScore: rs,
      topic: typeof f.topic === 'string' ? f.topic : undefined,
      date: typeof f.date === 'string' ? f.date : undefined,
      meta: (f.meta as ChunkMetadata | string | undefined),
      protected: isGuaranteed(wikiId, f.id),
    };
  });

  // rerank 활성 시 관련도 desc 정렬 (protected는 아래 split에서 무조건 포함 보장).
  if (rerankScore) all.sort((a, b) => (b.rerankScore ?? -1) - (a.rerankScore ?? -1));

  // 2.7 절대임계 per-wiki anti-starvation floor (Step 3):
  //   각 위키의 최고 similarity 청크가 절대임계 이내면 그 top-1을 protected로 승격 → RRF/finalK/budget 컷 면제.
  //   → 큰 위키의 후보 도배·키워드-RRF 강등에도 관련 위키가 dispatch 보장(0b 진단: policy가 벡터 #1~2인데도
  //   finalK 컷서 탈락하던 문제). 가장 가까운 ≤MAX 위키만 승격(과-dispatch 방지). 아무 위키도 임계 밖이면
  //   0개 승격 → 내부 관련자료 없음의 올바른 신호(web fallback 유지). GLOBAL_FLOOR_DIST=0으로 비활성.
  const floorDist = Number(process.env.GLOBAL_FLOOR_DIST ?? '0.48');
  const floorMax = Number(process.env.GLOBAL_FLOOR_MAX_WIKIS ?? '4');
  if (floorDist > 0 && floorMax > 0) {
    const floorSim = 1 - floorDist;
    const bestPerWiki = new Map<string, GlobalChunk>();
    for (const c of all) {
      if (c.similarity === undefined) continue;
      const cur = bestPerWiki.get(c.wikiId);
      if (!cur || c.similarity > (cur.similarity ?? -1)) bestPerWiki.set(c.wikiId, c);
    }
    const leaders = [...bestPerWiki.values()]
      .filter((c) => (c.similarity ?? -1) >= floorSim)
      .sort((a, b) => (b.similarity ?? -1) - (a.similarity ?? -1))
      .slice(0, floorMax);
    for (const c of leaders) c.protected = true;
  }

  // 3. similarity floor — 무관 청크(벡터만 가깝고 무관) 방어 (§8.1).
  //    면제: protected(큐레이션) / 키워드 강매칭(kwScore≥강) / similarity 없음(키워드-only=벡터신호 부재≠무관).
  const survives = (c: GlobalChunk) =>
    c.protected || (c.kwScore ?? 0) >= KW_STRONG || c.similarity === undefined || c.similarity >= simFloor;
  const kept = all.filter(survives);

  // 4. 하드 컨텍스트 예산(rag 감사 rank1 동반) — rerank 순서로 char 예산까지만 누적.
  //    protected는 무조건 포함(adaptive). 비용 꼬리($0.52)를 잘라 전 쿼리 ≤$0.15 보장(cost-sim 검증).
  //    rerank가 켜져 있으면 normal은 관련도 desc라, 예산에서 잘리는 건 *가장 덜 관련된* 청크.
  const RENDER_CAP = 3000;  // wiki-agent CHUNK_CHAR_CAP과 일치 — 렌더 후 실길이로 예산 계산
  const budgetChars = Number(process.env.GLOBAL_CTX_BUDGET_CHARS ?? '9000');
  const costOf = (c: GlobalChunk) => Math.min(c.chunk.length, RENDER_CAP);

  const prot = kept.filter(c => c.protected);
  const normalPool = kept.filter(c => !c.protected);  // all 정렬 유지(rerank desc 또는 RRF)
  let used = prot.reduce((s, c) => s + costOf(c), 0);
  const normal: GlobalChunk[] = [];
  for (const c of normalPool) {
    if (prot.length + normal.length >= finalK) break;          // 개수 상한(belt)
    if (normal.length > 0 && used + costOf(c) > budgetChars) break;  // char 예산(suspenders) — 최소 1개 보장
    normal.push(c);
    used += costOf(c);
  }
  return [...prot, ...normal];
}

/** wikiId별로 분배 (router dispatch용). */
export function partitionByWiki(chunks: GlobalChunk[]): Map<string, GlobalChunk[]> {
  const m = new Map<string, GlobalChunk[]>();
  for (const c of chunks) {
    if (!m.has(c.wikiId)) m.set(c.wikiId, []);
    m.get(c.wikiId)!.push(c);
  }
  return m;
}
