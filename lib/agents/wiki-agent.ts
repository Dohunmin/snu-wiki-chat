import path from 'path';
import fs from 'fs';
import type { AgentConfig, AgentContext, AgentPlugin, WikiData, GetContextOptions } from './types';
import type { Role } from '@/lib/auth/roles';
import { canAccessSensitive } from '@/lib/auth/roles';
// Design Ref: §5 — RRF 통합 (단일 지점, ragEnabled 위키만)
import { searchVector } from '@/lib/embed/search';
import { rrfFuse, rrfStats } from '@/lib/embed/rrf';
import type { KeywordRankedChunk, ChunkMetadata } from '@/lib/embed/types';
// Design Ref: recency-boost (v2) — 시간성 쿼리에 date 최신 N개 source 직접 주입
import { detectRecencyIntent, getRecencySources } from './recency';

const MAX_CHUNKS = 15;
const MAX_CHUNKS_ENTITY = 30;
const MAX_CHUNKS_RAG = 25;       // 🆕 ragEnabled 위키 — fused 결과 충분 활용

// 내부 wiki 페이지 ID 참조 패턴 제거 (non-Lens 컨텍스트 전용)
// 예: 학문후속세대지원.이석재.stance, 재원구조분석.fact
const INTERNAL_ID_PATTERN = /[\w가-힣·\-]+\.(?:stance|fact|overview)/g;
function stripInternalIds(text: string): string {
  return text.replace(INTERNAL_ID_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Design Ref: §4.2 — chunker가 재사용 (lib/embed/chunker.ts에서 import)
 * ## 헤더 단위로 분할, 최소 100자 미만 청크는 다음과 병합
 */
export function splitIntoChunks(content: string): string[] {
  const parts = content.split(/(?=^## )/m);
  const raw = parts.length > 1 ? parts : content.split(/\n{2,}/);

  const chunks: string[] = [];
  let pending = '';

  for (const part of raw) {
    const merged = pending ? pending + '\n\n' + part : part;
    if (merged.trim().length >= 100) {
      chunks.push(merged.trim());
      pending = '';
    } else {
      pending = merged;
    }
  }
  if (pending.trim().length >= 100) chunks.push(pending.trim());

  return chunks.length > 0 ? chunks : [content];
}

/**
 * Design Ref: §5 — RRF에서 vector-only 결과의 ChunkMetadata를 labeledItem.meta 문자열로 변환.
 * 페이지 타입별로 다른 메타 필드를 통일된 "key: value / ..." 포맷으로.
 */
function metaToString(meta?: ChunkMetadata): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (meta.holder) parts.push(`holder: ${meta.holder}`);
  if (meta.topic) parts.push(`topic: ${meta.topic}`);
  if (meta.category) parts.push(`category: ${meta.category}`);
  if (meta.yearsCovered) parts.push(`years: ${meta.yearsCovered}`);
  if (meta.편) parts.push(`편: ${meta.편}`);
  return parts.join(' / ');
}

/** 청크 내 쿼리 단어 등장 횟수 합산 */
function scoreChunk(chunk: string, queryWords: string[]): number {
  const lower = chunk.toLowerCase();
  let score = 0;
  for (const word of queryWords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    score += (lower.match(new RegExp(escaped, 'g')) ?? []).length;
  }
  return score;
}

export class WikiAgent implements AgentPlugin {
  /** 풀 컨텐츠 없이 메타데이터(tags/topics/entities)만 스캔해 관련성 여부 반환 */
  preScore(query: string, userRole: Role): boolean {
    const data = this.loadData();
    const isSensitiveAllowed = canAccessSensitive(userRole);
    const queryWords = query.toLowerCase().split(/[\s,]+/).filter(w => w.length >= 2);

    for (const source of data.sources) {
      if (!isSensitiveAllowed && source.sensitive) continue;
      for (const field of [...source.tags, ...source.topics, ...source.entities]) {
        const fl = field.toLowerCase();
        if (queryWords.some(w => fl.includes(w) || w.includes(fl))) return true;
      }
    }
    // 신규 타입 메타데이터도 스캔
    for (const s of (data.stances ?? [])) {
      if (queryWords.some(w => s.holder.toLowerCase().includes(w) || s.topic.toLowerCase().includes(w))) return true;
    }
    for (const f of (data.facts ?? [])) {
      if (queryWords.some(w => f.category.toLowerCase().includes(w))) return true;
    }
    return false;
  }


  config: AgentConfig;
  private data: WikiData | null = null;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  private loadData(): WikiData {
    if (this.data) return this.data;
    const dataPath = path.join(process.cwd(), 'data', this.config.dataFile);
    if (!fs.existsSync(dataPath)) {
      return {
        id: this.config.id, name: this.config.name,
        sources: [], topics: [], entities: [], syntheses: [],
        facts: [], stances: [], overviews: [], index: '',
      };
    }
    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as WikiData;
    // 기존 JSON에 신규 필드 없으면 빈 배열로 보정 (후방 호환)
    this.data = {
      ...raw,
      facts: raw.facts ?? [],
      stances: raw.stances ?? [],
      overviews: raw.overviews ?? [],
    };
    return this.data;
  }

  async getContext(
    query: string,
    userRole: Role,
    isGlobal = false,
    options: GetContextOptions = {},
  ): Promise<AgentContext> {
    const data = this.loadData();
    const isSensitiveAllowed = canAccessSensitive(userRole);

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/[\s,]+/).filter(w => w.length >= 2);
    // Plan SC: SC1 (시간성 쿼리에 신규 source 진입)
    const isRecencyQuery = detectRecencyIntent(query);

    const allowedSources = data.sources.filter(s => isSensitiveAllowed || !s.sensitive);
    const allowedSourceIds = new Set(allowedSources.map(s => s.id));

    // ─── Entity/Topic 역참조 ────────────────────────────────────────
    const guaranteedIds = new Set<string>();

    for (const entity of data.entities) {
      const names = [entity.name, entity.id, ...entity.aliases].map(n => n.toLowerCase());
      if (names.some(n => queryWords.some(w => n.includes(w) || w.includes(n)))) {
        entity.sources.filter(sid => allowedSourceIds.has(sid)).forEach(sid => guaranteedIds.add(sid));
      }
    }
    for (const topic of data.topics) {
      const names = [topic.name, topic.id].map(n => n.toLowerCase());
      if (names.some(n => queryWords.some(w => n.includes(w) || w.includes(n)))) {
        topic.sources.filter(sid => allowedSourceIds.has(sid)).forEach(sid => guaranteedIds.add(sid));
      }
    }
    // concept-index에서 온 강제 포함 페이지 ID 추가
    if (options.guaranteedPageIds) {
      for (const pid of options.guaranteedPageIds) {
        if (allowedSourceIds.has(pid)) guaranteedIds.add(pid);
      }
    }

    // ─── 소스 단위 관련성 점수 ─────────────────────────────────────
    const sourcesWithScore = allowedSources.map(source => {
      let score = 0;
      if (guaranteedIds.has(source.id)) score += 5;
      for (const t of source.topics) {
        const tl = t.toLowerCase();
        if (queryLower.includes(tl) || queryWords.some(w => tl.includes(w))) score += 3;
      }
      for (const e of source.entities) {
        const el = e.toLowerCase();
        if (queryLower.includes(el) || queryWords.some(w => el.includes(w))) score += 2;
      }
      for (const tag of source.tags) {
        const tl = tag.toLowerCase();
        if (queryWords.some(w => tl.includes(w) || w.includes(tl))) score += 2;
      }
      const contentLower = source.content.toLowerCase();
      for (const word of queryWords) {
        if (contentLower.includes(word)) score += 1;
      }
      return { source, score };
    });

    const candidateSources = sourcesWithScore.filter(s => s.score > 0);
    const sourcesToProcess = candidateSources.length > 0
      ? candidateSources.map(s => s.source)
      : allowedSources;

    // ─── 청크 단위 점수 계산 (source 페이지) ───────────────────────
    const scoredChunks: {
      type: 'source';
      title: string; id: string; topic: string; date?: string;
      chunk: string; score: number;
    }[] = [];

    for (const source of sourcesToProcess) {
      const isGuaranteed = guaranteedIds.has(source.id);
      const chunks = splitIntoChunks(source.content);
      for (const chunk of chunks) {
        let score = scoreChunk(chunk, queryWords);
        if (isGuaranteed) score = score * 2 + 1;
        if (score > 0) {
          scoredChunks.push({
            type: 'source',
            title: source.title,
            id: source.id,
            topic: source.topics[0] ?? source.tags[0] ?? '',
            date: source.date,
            chunk,
            score,
          });
        }
      }
    }

    // ─── 신규 페이지 타입 점수 계산 (청크 분할 없이 통째로) ────────
    type LabeledItem = {
      type: 'stance' | 'fact' | 'overview';
      id: string; title: string; chunk: string;
      meta: string; score: number;
    };
    const labeledItems: LabeledItem[] = [];

    // stance는 Lens 모드에서만 포함 — 일반 쿼리에서 내부 ID 노출 방지
    if (options.lensMode) {
      for (const s of data.stances) {
        if (!isSensitiveAllowed && s.sensitive) continue;
        let score = scoreChunk(s.content + ' ' + s.holder + ' ' + s.topic, queryWords);
        if (options.guaranteedPageIds?.has(s.id)) score += 5;
        if (queryWords.some(w => s.holder.toLowerCase().includes(w))) score += 3;
        if (queryWords.some(w => s.topic.toLowerCase().includes(w))) score += 3;
        if (score > 0) {
          labeledItems.push({
            type: 'stance', id: s.id, title: s.title,
            chunk: s.content,
            meta: `holder: ${s.holder} / topic: ${s.topic}`,
            score,
          });
        }
      }
    }

    for (const f of data.facts) {
      if (!isSensitiveAllowed && f.sensitive) continue;
      let score = scoreChunk(f.content + ' ' + f.category, queryWords);
      if (options.guaranteedPageIds?.has(f.id)) score += 5;
      if (queryWords.some(w => f.category.toLowerCase().includes(w))) score += 3;
      if (score > 0) {
        labeledItems.push({
          type: 'fact', id: f.id, title: f.title,
          chunk: f.content,
          meta: `category: ${f.category}${f.yearsCovered ? ` / years: ${f.yearsCovered}` : ''}${f.unit ? ` / unit: ${f.unit}` : ''}`,
          score,
        });
      }
    }

    for (const o of data.overviews) {
      if (!isSensitiveAllowed && o.sensitive) continue;
      let score = scoreChunk(o.content + ' ' + o.편, queryWords);
      if (options.guaranteedPageIds?.has(o.id)) score += 5;
      if (queryWords.some(w => o.편.toLowerCase().includes(w))) score += 3;
      if (score > 0) {
        labeledItems.push({
          type: 'overview', id: o.id, title: o.title,
          chunk: o.content,
          meta: `편: ${o.편}${o.시기 ? ` / 시기: ${o.시기[0]}~${o.시기[1]}` : ''}`,
          score,
        });
      }
    }

    // ─── 🆕 RRF 통합 (Design §5) — ragEnabled 위키만, 단일 지점 ──────
    // 기존 키워드 결과(scoredChunks + labeledItems)와 벡터 결과를 RRF 융합.
    // 실패 시 try/catch로 키워드 단독 fallback (회귀 안전).
    if (this.config.ragEnabled) {
      try {
        // (1) 키워드 결과를 RRF 입력 형식으로 통합 + 점수순 정렬
        const keywordCombined: KeywordRankedChunk[] = [
          ...scoredChunks.map(c => ({
            type: c.type, id: c.id, title: c.title, chunk: c.chunk, score: c.score,
            topic: c.topic, date: c.date,
          })),
          ...labeledItems.map(l => ({
            type: l.type, id: l.id, title: l.title, chunk: l.chunk, score: l.score,
            meta: l.meta,
          })),
        ];
        keywordCombined.sort((a, b) => b.score - a.score);

        // (2) 벡터 검색 (Voyage 임베딩 + pgvector top-K)
        const vectorTopRaw = await searchVector(query, this.config.id, userRole, 30);
        // stance는 Lens 모드에서만 인용 가능 — 일반 모드에선 벡터 결과에서도 제외
        const vectorTop = options.lensMode
          ? vectorTopRaw
          : vectorTopRaw.filter(v => v.pageType !== 'stance');

        // (3) RRF 융합 (k=60 업계 표준)
        const debug = process.env.RAG_DEBUG === 'true';
        const fused = rrfFuse(keywordCombined, vectorTop, { k: 60, limit: 30, debug });

        if (debug) {
          const stats = rrfStats(fused);
          console.log(
            `[RAG ${this.config.id}] kw:${keywordCombined.length} vec:${vectorTop.length} ` +
            `→ fused:${fused.length} (both:${stats.both}, kw-only:${stats.keywordOnly}, vec-only:${stats.vectorOnly})`,
          );
        }

        // (4) 융합 결과를 scoredChunks/labeledItems로 재분리 (후속 로직 호환)
        scoredChunks.length = 0;
        labeledItems.length = 0;
        for (const f of fused) {
          if (f.type === 'source') {
            scoredChunks.push({
              type: 'source',
              title: f.title,
              id: f.id,
              topic: typeof f.topic === 'string' ? f.topic : '',
              date: typeof f.date === 'string' ? f.date : undefined,
              chunk: f.chunk,
              score: f.score,
            });
          } else {
            const metaStr = typeof f.meta === 'string'
              ? f.meta
              : metaToString(f.meta as ChunkMetadata | undefined);
            labeledItems.push({
              type: f.type as 'stance' | 'fact' | 'overview',
              id: f.id,
              title: f.title,
              chunk: f.chunk,
              meta: metaStr,
              score: f.score,
            });
          }
        }
      } catch (err) {
        // Fallback: 벡터 검색 실패해도 키워드 결과로 계속 진행
        console.error(`[RAG ${this.config.id}] vector search failed, falling back to keyword-only:`, err);
      }
    }
    // ─── 🆕 RRF 통합 끝 ──────────────────────────────────────────

    // ─── 🆕 source ID 위생화 (citation-validator 보호) ────────────────
    // vector search가 chunk_embeddings에서 topic 페이지를 'source' type으로
    // 잘못 가져오는 경우가 있어 (e.g., 이사회 wiki의 "대학운영계획"이 topic인데
    // chunksToUse에 source처럼 들어옴) bogus citation 발생.
    // 진짜 source/fact/stance/overview ID만 통과시킴.
    const validIds = new Set<string>([
      ...allowedSources.map(s => s.id),
      ...data.facts.map(f => f.id),
      // stance는 Lens 모드에서만 허용 (일반 모드에선 내부 ID 노출 방지 P0)
      ...(options.lensMode ? (data.stances ?? []).map(s => s.id) : []),
      ...(data.overviews ?? []).map(o => o.id),
    ]);
    const filteredScored = scoredChunks.filter(c => validIds.has(c.id));
    const filteredLabeled = labeledItems.filter(l => validIds.has(l.id));
    scoredChunks.length = 0;
    scoredChunks.push(...filteredScored);
    labeledItems.length = 0;
    labeledItems.push(...filteredLabeled);

    // ─── chunk cap 결정 ────────────────────────────────────────────
    const chunkCap = options.chunkCap ?? (
      isGlobal ? allowedSources.length
        : guaranteedIds.size > 0 ? MAX_CHUNKS_ENTITY
        : this.config.ragEnabled ? MAX_CHUNKS_RAG       // 🆕 RAG 위키는 fused 결과 활용
        : MAX_CHUNKS
    );

    // ─── 소스 커버리지 균등화 후 labeled items 합산 ────────────────
    type AnyItem = typeof scoredChunks[0] | (LabeledItem & { topic?: string; date?: string });

    let chunksToUse: AnyItem[];
    if (scoredChunks.length > 0 || labeledItems.length > 0) {
      const sorted = [...scoredChunks].sort((a, b) => b.score - a.score);
      const coveredSources = new Set<string>();
      const firstChunks: typeof scoredChunks = [];
      const restChunks: typeof scoredChunks = [];

      for (const c of sorted) {
        if (!coveredSources.has(c.id)) {
          coveredSources.add(c.id);
          firstChunks.push(c);
        } else {
          restChunks.push(c);
        }
      }

      // source 대표청크 + labeled items + 나머지 source 청크, 점수순 병합
      const combined: AnyItem[] = [
        ...firstChunks,
        ...labeledItems,
        ...restChunks,
      ].sort((a, b) => b.score - a.score);

      chunksToUse = combined.slice(0, chunkCap);
    } else {
      chunksToUse = sourcesToProcess.map(source => ({
        type: 'source' as const,
        title: source.title,
        id: source.id,
        topic: source.topics[0] ?? source.tags[0] ?? '',
        date: source.date,
        chunk: splitIntoChunks(source.content)[0],
        score: 0,
      })).slice(0, chunkCap);
    }

    // ─── recency-boost (v2): 시간성 쿼리 시 date 최신 N개 source를 직접 주입 ───
    // RRF·cap 단계가 자체 점수로 골라낼 때 신규 source가 매번 누락되는 문제 해결.
    // 각 source의 *전체 본문*을 단일 청크로 주입 — 부분 청크만 들어가면 LLM이
    // 회의 메타(개최일·참여자)만 보고 "안건 내용은 자료에 없다"고 답하는 문제 방지.
    if (isRecencyQuery) {
      const recencyIds = new Set(getRecencySources(allowedSources, 5));
      // 이미 chunksToUse에 들어있던 recency source의 부분 청크 제거 (중복·단편화 방지)
      chunksToUse = chunksToUse.filter(c => !recencyIds.has(c.id));
      for (const sid of recencyIds) {
        const source = allowedSources.find(s => s.id === sid);
        if (!source) continue;
        chunksToUse.unshift({
          type: 'source' as const,
          title: source.title,
          id: source.id,
          topic: source.topics[0] ?? source.tags[0] ?? '',
          date: source.date,
          chunk: source.content,  // 전체 본문 — 안건/심의/의결 모두 포함
          score: 999,
        });
      }
    }

    // ─── entity 블록 (기존 유지) ───────────────────────────────────
    const entityBlocks: string[] = [];
    for (const entity of data.entities) {
      const names = [entity.name, entity.id, ...entity.aliases].map(n => n.toLowerCase());
      if (names.some(n => queryWords.some(w => n.includes(w) || w.includes(n))) && entity.content.trim()) {
        entityBlocks.push(`## [entity] ${entity.name}\n${entity.content}`);
      }
    }

    // ─── 출력 포맷 (타입 라벨링) ───────────────────────────────────
    // non-Lens 모드: 내부 페이지 ID 참조를 콘텐츠에서 제거
    const sanitize = options.lensMode ? (s: string) => s : stripInternalIds;

    const sourceBlocks = chunksToUse.map(item => {
      if (item.type === 'source') {
        return `## ${item.title} (${item.id})${item.date ? ` | 회의일: ${item.date}` : ''}\n${sanitize(item.chunk)}`;
      } else {
        const labeled = item as LabeledItem;
        return `## [${labeled.type}] ${labeled.title} (${labeled.id}) | ${labeled.meta}\n${sanitize(labeled.chunk)}`;
      }
    }).join('\n\n---\n\n');

    const relevantData = entityBlocks.length > 0
      ? `${entityBlocks.join('\n\n---\n\n')}\n\n---\n\n${sourceBlocks}`
      : sourceBlocks;

    const seenIds = new Set<string>();
    const sources = chunksToUse
      .filter(c => { if (seenIds.has(c.id)) return false; seenIds.add(c.id); return true; })
      .map(c => ({
        wiki: this.config.name,
        page: c.id,
        topic: c.type === 'source' ? (c as typeof scoredChunks[0]).topic : c.type,
      }));

    return {
      agentId: this.config.id,
      agentName: this.config.name,
      relevantData,
      sources,
      confidence: (scoredChunks.length > 0 || labeledItems.length > 0) ? 0.8 : 0.3,
    };
  }
}
