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
