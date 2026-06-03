/**
 * Design Ref: §4.3 — pgvector top-K 검색
 * Plan SC: SC3 (RRF 융합 작동), SC7 (권한 다층 방어 유지)
 *
 * 쿼리 → Voyage 임베딩 → pgvector cosine distance 검색.
 * 권한 다층 방어: wiki_id 필터 + sensitive 필터.
 */

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { embedOne } from './voyage';
import { canAccessSensitive } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import type { VectorSearchResult, ChunkMetadata, PageType } from './types';

const DEFAULT_K = 30;

interface RawRow {
  id: string;
  page_id: string;
  page_type: string;
  chunk_text: string;
  metadata: ChunkMetadata | null;
  distance: number | string;   // pgvector returns numeric
}

/**
 * Design Ref: §5 — WikiAgent에서 단일 지점 호출
 * 쿼리 임베딩 + pgvector top-K 검색 + 권한 필터.
 *
 * @param query 사용자 질문
 * @param wikiId 라우터가 선택한 위키 ID (e.g., 'finance')
 * @param userRole 권한 (sensitive 필터링용)
 * @param k 상위 K개 (기본 30)
 * @returns 유사도순 정렬된 청크 (similarity 내림차순)
 */
export async function searchVector(
  query: string,
  wikiId: string,
  userRole: Role,
  k: number = DEFAULT_K,
): Promise<VectorSearchResult[]> {
  // 1) 쿼리 임베딩 (Voyage inputType=query)
  const queryEmbed = await embedOne(query, 'query');

  // 2) pgvector 쿼리 — cosine distance + 권한 필터
  // pgvector는 vector literal '[0.1,0.2,...]'::vector 포맷 필요
  const embeddingLiteral = `[${queryEmbed.join(',')}]`;
  const sensitiveAllowed = canAccessSensitive(userRole);

  const result = await db.execute(sql`
    SELECT
      id,
      page_id,
      page_type,
      chunk_text,
      metadata,
      embedding <=> ${embeddingLiteral}::vector AS distance
    FROM chunk_embeddings
    WHERE wiki_id = ${wikiId}
      AND (${sensitiveAllowed} OR sensitive = FALSE)
    ORDER BY embedding <=> ${embeddingLiteral}::vector
    LIMIT ${k}
  `);

  // drizzle execute의 결과는 환경에 따라 형태가 다름
  // @vercel/postgres: result.rows
  // 일부: result 자체가 array
  const rows: RawRow[] = Array.isArray(result)
    ? (result as unknown as RawRow[])
    : ((result as unknown as { rows?: RawRow[] }).rows ?? []);

  // 3) 매핑 (distance → similarity 정규화)
  return rows.map(r => ({
    id: r.id,
    pageId: r.page_id,
    pageType: r.page_type as PageType,
    chunkText: r.chunk_text,
    metadata: r.metadata ?? { title: r.page_id, pageType: r.page_type as PageType },
    distance: Number(r.distance),
    similarity: 1 - Number(r.distance) / 2,  // 0~2 → 1~0 정규화
  }));
}

/**
 * Phase 3 (rag-cost-reduction.phase3.design §4.1) — 전 코퍼스 전역 top-K 벡터 검색.
 *
 * searchVector에서 `WHERE wiki_id = $` 만 제거 → 전 위키 청크에서 가장 가까운 top-K.
 * ★ 보안: lensPersona/adminOnly 제외 **양성 allowlist**(`wiki_id IN (...)`)로 leesj 등 누출 차단(R5).
 *   allowedWikiIds = getRoutableAgents(role).map(id). 신규 위키도 명시 포함 전엔 누출 0.
 */
export interface GlobalVectorResult extends VectorSearchResult { wikiId: string; }

export async function searchVectorGlobal(
  query: string,
  userRole: Role,
  k: number,
  opts: { allowedWikiIds: string[] },
): Promise<GlobalVectorResult[]> {
  if (opts.allowedWikiIds.length === 0) return [];

  const queryEmbed = await embedOne(query, 'query');
  const embeddingLiteral = `[${queryEmbed.join(',')}]`;
  const sensitiveAllowed = canAccessSensitive(userRole);
  // 파라미터화된 allowlist (sql.join — 인젝션 안전, 빈배열은 위에서 차단)
  const allowlist = sql.join(opts.allowedWikiIds.map(id => sql`${id}`), sql`, `);

  const result = await db.execute(sql`
    SELECT
      id, wiki_id, page_id, page_type, chunk_text, metadata,
      embedding <=> ${embeddingLiteral}::vector AS distance
    FROM chunk_embeddings
    WHERE wiki_id IN (${allowlist})
      AND (${sensitiveAllowed} OR sensitive = FALSE)
    ORDER BY embedding <=> ${embeddingLiteral}::vector
    LIMIT ${k}
  `);

  type GRow = RawRow & { wiki_id: string };
  const rows: GRow[] = Array.isArray(result)
    ? (result as unknown as GRow[])
    : ((result as unknown as { rows?: GRow[] }).rows ?? []);

  return rows.map(r => ({
    id: r.id,
    wikiId: r.wiki_id,
    pageId: r.page_id,
    pageType: r.page_type as PageType,
    chunkText: r.chunk_text,
    metadata: r.metadata ?? { title: r.page_id, pageType: r.page_type as PageType },
    distance: Number(r.distance),
    similarity: 1 - Number(r.distance) / 2,
  }));
}

/**
 * Semantic Routing — wiki_id 필터 *없이* 모든 임베딩된 위키에서 의미적 매칭.
 * 라우터에서 forcedWikis 후보로 활용.
 *
 * 사용 시점: router.ts 의 Stage 1 (키워드 매칭) 직후, concept-index 조회와 병렬로.
 * 효과: "장학금" 같은 동의어 의존 쿼리에서 finance가 키워드 매칭 약해도
 *      벡터 유사도가 finance 청크들을 의미적으로 매칭 → 자동 라우팅 포함.
 *
 * @param query 사용자 질문
 * @param userRole 권한 (sensitive 필터링)
 * @param topK 검색할 최상위 청크 수 (기본 30)
 * @param maxWikis 반환할 위키 수 상한 (기본 5)
 * @param maxDistance distance 이내만 (0.85 이내면 의미 있는 매칭, 너무 멀면 노이즈)
 * @returns 추천 위키 ID 집합 (forcedWikis와 합쳐서 사용)
 */
export interface SemanticRouting {
  /** forcedWikis 후보 — 임계 통과한 위키 (라우팅 강제 포함) */
  hints: Set<string>;
  /** 라우팅 가능한 모든 위키의 min cosine distance — chunk 예산 가중 분배용 */
  distances: Map<string, number>;
}

export async function semanticRoutingHints(
  query: string,
  userRole: Role,
  opts: {
    maxWikis?: number;
    /** top-1 위키는 무조건 포함하는 상한 (그 이상 멀면 진짜 무관) */
    absoluteMax?: number;
    /** top-2 이후 추가 위키의 거리 임계 (의미적으로 명확한 매칭만) */
    tightMax?: number;
  } = {},
): Promise<SemanticRouting> {
  const { maxWikis = 5, absoluteMax = 1.0, tightMax = 0.85 } = opts;
  const empty: SemanticRouting = { hints: new Set(), distances: new Map() };

  try {
    // 1) 쿼리 임베딩
    const queryEmbed = await embedOne(query, 'query');
    const lit = `[${queryEmbed.join(',')}]`;
    const sensitiveAllowed = canAccessSensitive(userRole);

    // 2) 위키별 min distance 직접 집계 (전역 LIMIT 없이 — 감사 M-5: 큰 위키가 top-K를
    //    점유해 작은 위키가 굶던 문제 제거 + 가중 분배에 전체 위키 거리가 필요).
    const result = await db.execute(sql`
      SELECT wiki_id, MIN(embedding <=> ${lit}::vector) AS min_dist
      FROM chunk_embeddings
      WHERE (${sensitiveAllowed} OR sensitive = FALSE)
      GROUP BY wiki_id
      ORDER BY min_dist
    `);

    const rows: Array<{ wiki_id: string; min_dist: number | string }> = Array.isArray(result)
      ? (result as unknown as Array<{ wiki_id: string; min_dist: number | string }>)
      : ((result as unknown as { rows?: Array<{ wiki_id: string; min_dist: number | string }> }).rows ?? []);

    if (rows.length === 0) {
      if (process.env.RAG_DEBUG === 'true') {
        console.log(`[SemRoute] query="${query.slice(0, 40)}..." → (no chunks in DB)`);
      }
      return empty;
    }

    const distances = new Map(rows.map(r => [r.wiki_id, Number(r.min_dist)]));

    // 3) hints(강제 포함 후보) — 기존 계층 임계 유지(recall 보존):
    //    top-1은 absoluteMax 이내면 포함, top-2 이후는 tightMax 이내인 것만. (top maxWikis 한정)
    const top = rows.slice(0, maxWikis);
    const hints = new Set<string>();
    if (Number(top[0].min_dist) <= absoluteMax) hints.add(top[0].wiki_id);
    for (let i = 1; i < top.length; i++) {
      if (Number(top[i].min_dist) <= tightMax) hints.add(top[i].wiki_id);
    }

    if (process.env.RAG_DEBUG === 'true') {
      const debugAll = rows.map(r => `${r.wiki_id}(${Number(r.min_dist).toFixed(3)})`).join(', ');
      console.log(`[SemRoute] query="${query.slice(0, 40)}..."`);
      console.log(`           all:  ${debugAll}`);
      console.log(`           hints: ${[...hints].join(', ') || '(none)'}`);
    }

    return { hints, distances };
  } catch (err) {
    // Fallback: 의미 라우팅 실패해도 키워드/concept-index 라우팅으로 작동
    console.error('[SemRoute] failed, falling back to keyword routing:', err);
    return empty;
  }
}
