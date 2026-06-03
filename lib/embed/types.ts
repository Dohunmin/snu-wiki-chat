/**
 * Design Ref: §3.4 — lib/embed/types.ts
 *
 * 임베딩 관련 공용 타입.
 * - ChunkMetadata: DB의 jsonb metadata 컬럼에 저장되는 페이지 타입별 메타
 * - EmbeddingChunk: 임베딩 빌드 단계에서 사용 (chunker → voyage → DB INSERT)
 * - VectorSearchResult: pgvector 쿼리 결과 (검색 단계)
 * - KeywordRankedChunk: WikiAgent의 기존 키워드 결과와 호환되는 인터페이스 (RRF 입력)
 */

export type PageType = 'source' | 'fact' | 'stance' | 'overview' | 'topic' | 'entity';

export interface ChunkMetadata {
  title: string;
  pageType: PageType;
  // 페이지 타입별 보강 메타데이터
  topic?: string;        // stance, topic
  holder?: string;       // stance
  category?: string;     // fact
  yearsCovered?: string; // fact
  편?: string;          // overview
  date?: string;         // source
}

/**
 * 임베딩 빌드 단계에서 사용.
 * embedding은 chunker가 만들 때 빈 배열, voyage 호출 후 채워짐.
 */
export interface EmbeddingChunk {
  id: string;                  // {wikiId}:{pageType}:{pageId}:{chunkIdx}
  wikiId: string;
  pageType: PageType;
  pageId: string;
  chunkIdx: number;
  chunkText: string;
  embedding: number[];         // 1024차원
  sensitive: boolean;
  metadata: ChunkMetadata;
  contentHash: string;
}

/**
 * pgvector top-K 검색 결과.
 * distance: cosine distance (0=완전 같음, 2=정반대)
 * similarity: 1 - distance/2 (0~1 정규화)
 */
export interface VectorSearchResult {
  id: string;
  pageId: string;
  pageType: PageType;
  chunkText: string;
  distance: number;
  similarity: number;
  metadata: ChunkMetadata;
  /** Phase 3 전역 검색 시 set(searchVectorGlobal). per-wiki searchVector는 undefined. */
  wikiId?: string;
}

/**
 * WikiAgent의 기존 청크 결과와 호환되는 인터페이스 (RRF 입력용).
 * 실제 wiki-agent.ts의 scoredChunks/labeledItems는 더 많은 필드를 가지지만
 * RRF 융합에 필요한 최소 필드만 정의.
 */
export interface KeywordRankedChunk {
  type: 'source' | 'fact' | 'stance' | 'overview';
  id: string;                  // page id
  title: string;
  chunk: string;
  score: number;
  /** Phase 3 전역 키워드 풀에서 set. 레거시(단일 위키)는 undefined. */
  wikiId?: string;
  // 기타 필드 (topic, date, meta 등) — 통과만 시킴
  [key: string]: unknown;
}
