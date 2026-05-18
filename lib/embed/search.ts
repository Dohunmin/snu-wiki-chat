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
export async function semanticRoutingHints(
  query: string,
  userRole: Role,
  opts: {
    topK?: number;
    maxWikis?: number;
    maxDistance?: number;
  } = {},
): Promise<Set<string>> {
  const { topK = 30, maxWikis = 5, maxDistance = 0.85 } = opts;

  try {
    // 1) 쿼리 임베딩
    const queryEmbed = await embedOne(query, 'query');
    const lit = `[${queryEmbed.join(',')}]`;
    const sensitiveAllowed = canAccessSensitive(userRole);

    // 2) 위키 단위로 최소 거리 집계 + 임계값 이내만
    //    각 위키의 *가장 가까운 청크* 거리로 위키 관련성 판정.
    //    GROUP BY wiki_id + MIN(distance) 로 위키별 best score.
    const result = await db.execute(sql`
      WITH ranked AS (
        SELECT
          wiki_id,
          embedding <=> ${lit}::vector AS distance
        FROM chunk_embeddings
        WHERE (${sensitiveAllowed} OR sensitive = FALSE)
        ORDER BY embedding <=> ${lit}::vector
        LIMIT ${topK}
      )
      SELECT wiki_id, MIN(distance) AS min_dist
      FROM ranked
      GROUP BY wiki_id
      HAVING MIN(distance) <= ${maxDistance}
      ORDER BY min_dist
      LIMIT ${maxWikis}
    `);

    const rows: Array<{ wiki_id: string; min_dist: number | string }> = Array.isArray(result)
      ? (result as unknown as Array<{ wiki_id: string; min_dist: number | string }>)
      : ((result as unknown as { rows?: Array<{ wiki_id: string; min_dist: number | string }> }).rows ?? []);

    if (process.env.RAG_DEBUG === 'true') {
      console.log(`[SemRoute] query="${query.slice(0, 40)}..." →`,
        rows.map(r => `${r.wiki_id}(${Number(r.min_dist).toFixed(3)})`).join(', '));
    }

    return new Set(rows.map(r => r.wiki_id));
  } catch (err) {
    // Fallback: 의미 라우팅 실패해도 키워드/concept-index 라우팅으로 작동
    console.error('[SemRoute] failed, falling back to keyword routing:', err);
    return new Set();
  }
}
