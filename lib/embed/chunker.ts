/**
 * Design Ref: §4.2 — 페이지 타입별 임베딩 단위 변환
 * Plan SC: SC2 (finance 임베딩 성공)
 *
 * data/{wikiId}.json (WikiData)를 읽어 임베딩 가능 단위(EmbeddingChunk[])로 변환.
 *
 * 페이지 타입별 분할 정책:
 * - source: `##` 헤더 단위로 분할 (splitIntoChunks 재사용, 100자 미만 병합)
 * - fact / stance / overview / topic / entity: 통째 1청크 (분할 X, 메타데이터로 보강)
 *
 * → fact/stance 등이 통째 임베딩되는 이유:
 *   표·짧은 문단이라 분할하면 의미 손실. 통째 임베딩이 의미 매칭에 유리.
 */

import crypto from 'crypto';
import { splitIntoChunks } from '@/lib/agents/wiki-agent';
import type { WikiData } from '@/lib/agents/types';
import type { EmbeddingChunk, ChunkMetadata, PageType } from './types';

const MIN_CONTENT_LENGTH = 30;   // 30자 미만 청크는 임베딩 가치 낮음 (예: 빈 entity)

/**
 * SHA-256 hash (증분 갱신용 — 같은 chunk_text면 재임베딩 스킵 가능).
 */
function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * 위키 데이터 1개를 임베딩 청크 배열로 변환.
 * embedding 필드는 빈 배열로 시작 (voyage 호출 후 채움).
 */
export function chunkifyWiki(wikiData: WikiData): EmbeddingChunk[] {
  const chunks: EmbeddingChunk[] = [];

  // ─── source: 기존 ## 헤더 분할 재사용 ─────────────────────────
  for (const source of wikiData.sources) {
    const parts = splitIntoChunks(source.content);
    parts.forEach((text, idx) => {
      if (text.trim().length < MIN_CONTENT_LENGTH) return;
      chunks.push(makeChunk({
        wikiId: wikiData.id,
        pageType: 'source',
        pageId: source.id,
        chunkIdx: idx,
        chunkText: text,
        sensitive: source.sensitive,
        metadata: {
          title: source.title,
          pageType: 'source',
          date: source.date,
        },
      }));
    });
  }

  // ─── fact: 통째 (제목 + 카테고리 + 본문) ─────────────────────
  for (const f of (wikiData.facts ?? [])) {
    if (f.content.trim().length < MIN_CONTENT_LENGTH) continue;
    chunks.push(makeChunk({
      wikiId: wikiData.id,
      pageType: 'fact',
      pageId: f.id,
      chunkIdx: 0,
      chunkText: `${f.title}\n카테고리: ${f.category}\n${f.content}`,
      sensitive: f.sensitive,
      metadata: {
        title: f.title,
        pageType: 'fact',
        category: f.category,
        yearsCovered: f.yearsCovered,
      },
    }));
  }

  // ─── stance: 통째 (제목 + 발언자 + 주제 + 본문) ──────────────
  for (const s of (wikiData.stances ?? [])) {
    if (s.content.trim().length < MIN_CONTENT_LENGTH) continue;
    chunks.push(makeChunk({
      wikiId: wikiData.id,
      pageType: 'stance',
      pageId: s.id,
      chunkIdx: 0,
      chunkText: `${s.title}\n발언자: ${s.holder}\n주제: ${s.topic}\n${s.content}`,
      sensitive: s.sensitive,
      metadata: {
        title: s.title,
        pageType: 'stance',
        holder: s.holder,
        topic: s.topic,
      },
    }));
  }

  // ─── overview: 통째 (제목 + 편 + 본문) ───────────────────────
  for (const o of (wikiData.overviews ?? [])) {
    if (o.content.trim().length < MIN_CONTENT_LENGTH) continue;
    chunks.push(makeChunk({
      wikiId: wikiData.id,
      pageType: 'overview',
      pageId: o.id,
      chunkIdx: 0,
      chunkText: `${o.title}\n편: ${o.편}\n${o.content}`,
      sensitive: o.sensitive,
      metadata: {
        title: o.title,
        pageType: 'overview',
        편: o.편,
      },
    }));
  }

  // ─── topic: 통째 (이름 + 본문) ────────────────────────────────
  for (const t of wikiData.topics) {
    if (t.content.trim().length < MIN_CONTENT_LENGTH) continue;
    chunks.push(makeChunk({
      wikiId: wikiData.id,
      pageType: 'topic',
      pageId: t.id,
      chunkIdx: 0,
      chunkText: `${t.name}\n${t.content}`,
      sensitive: false,
      metadata: {
        title: t.name,
        pageType: 'topic',
        topic: t.name,
      },
    }));
  }

  // ─── entity: 통째 (이름 + 별칭 + 본문) ────────────────────────
  for (const e of wikiData.entities) {
    if (e.content.trim().length < MIN_CONTENT_LENGTH) continue;
    const aliasLine = e.aliases.length > 0 ? `별칭: ${e.aliases.join(', ')}\n` : '';
    chunks.push(makeChunk({
      wikiId: wikiData.id,
      pageType: 'entity',
      pageId: e.id,
      chunkIdx: 0,
      chunkText: `${e.name}\n${aliasLine}${e.content}`,
      sensitive: false,
      metadata: {
        title: e.name,
        pageType: 'entity',
      },
    }));
  }

  return chunks;
}

interface MakeChunkInput {
  wikiId: string;
  pageType: PageType;
  pageId: string;
  chunkIdx: number;
  chunkText: string;
  sensitive: boolean;
  metadata: ChunkMetadata;
}

function makeChunk(input: MakeChunkInput): EmbeddingChunk {
  return {
    id: `${input.wikiId}:${input.pageType}:${input.pageId}:${input.chunkIdx}`,
    wikiId: input.wikiId,
    pageType: input.pageType,
    pageId: input.pageId,
    chunkIdx: input.chunkIdx,
    chunkText: input.chunkText,
    embedding: [],                       // voyage 호출 후 채움
    sensitive: input.sensitive,
    metadata: input.metadata,
    contentHash: sha256(input.chunkText),
  };
}

/**
 * 청크 통계 (빌드 스크립트용 디버그).
 */
export function chunkStats(chunks: EmbeddingChunk[]): {
  total: number;
  byType: Record<PageType, number>;
  sensitive: number;
  avgLength: number;
} {
  const byType = {} as Record<PageType, number>;
  let totalLength = 0;
  let sensitive = 0;
  for (const c of chunks) {
    byType[c.pageType] = (byType[c.pageType] ?? 0) + 1;
    totalLength += c.chunkText.length;
    if (c.sensitive) sensitive++;
  }
  return {
    total: chunks.length,
    byType,
    sensitive,
    avgLength: chunks.length > 0 ? Math.round(totalLength / chunks.length) : 0,
  };
}
