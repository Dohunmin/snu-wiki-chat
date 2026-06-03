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
