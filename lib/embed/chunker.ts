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
const MIN_ARTICLE_MERGE = 100;   // 조문 청크 병합 하한 (splitIntoChunks 100자 규칙과 동일)
const FACT_SPLIT_MIN = 1500;     // 이보다 큰 fact만 ### 섹션 단위로 분할 (작은 단일주제 fact는 통째 유지)
const FACT_MERGE_MIN = 200;      // fact 섹션 병합 하한

/**
 * SHA-256 hash (증분 갱신용 — 같은 chunk_text면 재임베딩 스킵 가능).
 */
function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * policy_document 전용 분할 — `## 장(章)` 뿐 아니라 `### 제N조` **조문 단위**까지 쪼갠다.
 *
 * 기존 splitIntoChunks는 `## `(h2)에서만 분할 → 정관 제2장 기관(8.5k자)에 27개 조문이,
 * 학칙 제2·3장(각 17k자)에 47·53개 조문이 **한 청크로 뭉쳐** 제18조·제27조 같은 깊은 조문이
 * rerank(1500자)/context-budget(4000자) 창 밖으로 잘려 LLM에 미도달 (0b baseline: truncLoss 2/9 확인).
 *
 * 규칙: `## ` 섹션으로 먼저 나눈 뒤, `### ` 조문이 있는 섹션은 조문 단위로 재분할하고
 * 각 조문 청크에 소속 장(章) 헤더(`## 제N장 …`)를 prepend해 맥락·인용을 보존한다.
 * 100자 미만 조문은 다음 조문과 병합. 조문 없는 섹션(개요·전문·부칙·AI가이드라인 등)은 통째 유지.
 */
export function splitPolicyIntoArticles(content: string): string[] {
  const out: string[] = [];
  const sections = content.split(/(?=^## )/m).filter((s) => s.trim());

  for (const sec of sections) {
    if (!/^### /m.test(sec)) {
      // 조문(### 제N조) 없는 섹션 → 통째 (개요·전문·본문조항 인트로·부칙·AI가이드라인 등)
      if (sec.trim().length >= MIN_CONTENT_LENGTH) out.push(sec.trim());
      continue;
    }
    const chapterHeader = (sec.match(/^## .+$/m)?.[0] ?? '').trim(); // 각 조문에 prepend할 장 헤더
    const withHeader = (body: string) => (chapterHeader ? `${chapterHeader}\n${body}` : body);
    const subs = sec.split(/(?=^### )/m);

    // subs[0] = 장 헤더 + 첫 조문 전 서문. 서문에 실체 있으면 별도 청크로 보존
    const intro = subs[0].replace(/^## .+$/m, '').trim();
    if (intro.length >= MIN_CONTENT_LENGTH) out.push(withHeader(intro));

    // 조문들 — 100자 미만은 다음 조문과 병합
    let pending = '';
    for (let i = 1; i < subs.length; i++) {
      const merged = pending ? `${pending}\n${subs[i].trim()}` : subs[i].trim();
      if (merged.length >= MIN_ARTICLE_MERGE) {
        out.push(withHeader(merged));
        pending = '';
      } else {
        pending = merged;
      }
    }
    if (pending.trim().length >= MIN_CONTENT_LENGTH) out.push(withHeader(pending.trim()));
  }

  return out.length > 0 ? out : [content];
}

/**
 * fact 전용 분할 — 큰 다주제 fact를 `### 하위섹션` 단위로 쪼갠다.
 *
 * 등록금장학금대출현황.fact(2,559자: 등록금+장학금+대출)·교원현황.fact(2,439자: 총괄+대학별) 등이
 * 통째 임베딩되면 임베딩이 다주제로 희석돼 특정 수치(6,058,798 등)가 focused 쿼리와 멀어짐
 * (0b 진단: stat fact d=0.587, legacy·global 양쪽 textHit 실패). `### ` 섹션으로 쪼개 focused화.
 *
 * `## 내용` 앞머리(출처·정의)는 head 청크로 보존, 각 `### ` 섹션은 별도 청크(호출부가 제목+카테고리 prefix 부착).
 * FACT_SPLIT_MIN 미만이거나 `### ` 없는 단일주제 fact는 통째 유지(작은 표 분할 시 의미손실 방지).
 */
export function splitFactIntoSubsections(content: string): string[] {
  if (content.length < FACT_SPLIT_MIN || !/^### /m.test(content)) return [content];
  const parts = content.split(/(?=^### )/m);
  const out: string[] = [];
  const head = parts[0].trim();                    // # 제목 + ## 내용(출처·단위·정의)
  if (head.length >= MIN_CONTENT_LENGTH) out.push(head);
  let pending = '';
  for (const s of parts.slice(1)) {
    const merged = pending ? `${pending}\n${s.trim()}` : s.trim();
    if (merged.length >= FACT_MERGE_MIN) { out.push(merged); pending = ''; }
    else pending = merged;
  }
  if (pending.trim().length >= MIN_CONTENT_LENGTH) out.push(pending.trim());
  return out.length > 0 ? out : [content];
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

  // ─── fact: 큰 다주제 fact는 ### 섹션 단위 분할, 작은 건 통째 (제목 + 카테고리 prefix) ──────
  for (const f of (wikiData.facts ?? [])) {
    if (f.content.trim().length < MIN_CONTENT_LENGTH) continue;
    const parts = splitFactIntoSubsections(f.content);
    parts.forEach((sub, idx) => {
      if (sub.trim().length < MIN_CONTENT_LENGTH) return;
      chunks.push(makeChunk({
        wikiId: wikiData.id,
        pageType: 'fact',
        pageId: f.id,
        chunkIdx: idx,
        chunkText: `${f.title}\n카테고리: ${f.category}\n${sub}`,
        sensitive: f.sensitive,
        metadata: {
          title: f.title,
          pageType: 'fact',
          category: f.category,
          yearsCovered: f.yearsCovered,
        },
      }));
    });
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

  // ─── policy_document: ## 장 + ### 제N조 조문 단위 분할 (Step 1 — truncLoss 수정) ──────
  for (const d of (wikiData.documents ?? [])) {
    const parts = splitPolicyIntoArticles(d.content);
    parts.forEach((text, idx) => {
      if (text.trim().length < MIN_CONTENT_LENGTH) return;
      chunks.push(makeChunk({
        wikiId: wikiData.id,
        pageType: 'policy_document',
        pageId: d.id,
        chunkIdx: idx,
        chunkText: `${d.정책명}\n분류: ${d.분류}\n${text}`,
        sensitive: d.sensitive,
        metadata: {
          title: d.title,
          pageType: 'policy_document',
          분류: d.분류,
          제정일: d.제정일,
        },
      }));
    });
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
