import path from 'path';
import fs from 'fs';
import type { AgentConfig, AgentContext, AgentPlugin, WikiData } from './types';
import type { Role } from '@/lib/auth/roles';
import { canAccessSensitive } from '@/lib/auth/roles';

const MAX_CHUNKS = 15;
const MAX_CHUNKS_ENTITY = 30; // entity 매칭 시 더 넓은 커버리지 허용

/** ## 헤더 단위로 분할, 최소 100자 미만 청크는 다음과 병합 */
function splitIntoChunks(content: string): string[] {
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
      return { id: this.config.id, name: this.config.name, sources: [], topics: [], entities: [], syntheses: [], index: '' };
    }
    this.data = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as WikiData;
    return this.data;
  }

  async getContext(query: string, userRole: Role): Promise<AgentContext> {
    const data = this.loadData();
    const isSensitiveAllowed = canAccessSensitive(userRole);

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/[\s,]+/).filter(w => w.length >= 2);

    const allowedSources = data.sources.filter(s => isSensitiveAllowed || !s.sensitive);
    const allowedSourceIds = new Set(allowedSources.map(s => s.id));

    // ─── Entity/Topic 역참조: 쿼리 단어가 entity·topic 이름과 일치하면
    //     해당 entity·topic에 연결된 모든 소스를 보장 후보로 수집
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

    // ─── 소스 단위 관련성 점수 ─────────────────────────────────────
    const sourcesWithScore = allowedSources.map(source => {
      let score = 0;

      // entity/topic 역참조로 보장된 소스는 기본 점수 부여
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

    // ─── 청크 단위 점수 계산 ────────────────────────────────────────
    const scoredChunks: {
      title: string; id: string; topic: string; chunk: string; score: number;
    }[] = [];

    for (const source of sourcesToProcess) {
      const isGuaranteed = guaranteedIds.has(source.id);
      const chunks = splitIntoChunks(source.content);
      for (const chunk of chunks) {
        let score = scoreChunk(chunk, queryWords);
        // entity/topic 역참조 소스는 텍스트 매칭 없어도 기본 포함 + 점수 부스트
        if (isGuaranteed) score = score * 2 + 1;
        if (score > 0) {
          scoredChunks.push({
            title: source.title,
            id: source.id,
            topic: source.topics[0] ?? source.tags[0] ?? '',
            chunk,
            score,
          });
        }
      }
    }

    const chunkCap = guaranteedIds.size > 0 ? MAX_CHUNKS_ENTITY : MAX_CHUNKS;

    const chunksToUse = scoredChunks.length > 0
      ? scoredChunks.sort((a, b) => b.score - a.score).slice(0, chunkCap)
      : sourcesToProcess.map(source => ({
          title: source.title,
          id: source.id,
          topic: source.topics[0] ?? source.tags[0] ?? '',
          chunk: splitIntoChunks(source.content)[0],
          score: 0,
        })).slice(0, chunkCap);

    // entity 매칭 시: 매칭된 entity 페이지 내용을 앞에 추가 (이미 정리된 합성 정보)
    const entityBlocks: string[] = [];
    for (const entity of data.entities) {
      const names = [entity.name, entity.id, ...entity.aliases].map(n => n.toLowerCase());
      if (names.some(n => queryWords.some(w => n.includes(w) || w.includes(n))) && entity.content.trim()) {
        entityBlocks.push(`## [${entity.entityType || 'entity'}] ${entity.name}\n${entity.content}`);
      }
    }

    const sourceBlocks = chunksToUse
      .map(c => `## ${c.title} (${c.id})\n${c.chunk}`)
      .join('\n\n---\n\n');

    const relevantData = entityBlocks.length > 0
      ? `${entityBlocks.join('\n\n---\n\n')}\n\n---\n\n${sourceBlocks}`
      : sourceBlocks;

    // 소스 메타데이터 중복 제거
    const seenIds = new Set<string>();
    const sources = chunksToUse
      .filter(c => { if (seenIds.has(c.id)) return false; seenIds.add(c.id); return true; })
      .map(c => ({ wiki: this.config.name, page: c.id, topic: c.topic }));

    return {
      agentId: this.config.id,
      agentName: this.config.name,
      relevantData,
      sources,
      confidence: scoredChunks.length > 0 ? 0.8 : 0.3,
    };
  }
}
