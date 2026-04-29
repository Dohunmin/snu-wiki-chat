import path from 'path';
import fs from 'fs';
import type { AgentConfig, AgentContext, AgentPlugin, WikiData } from './types';
import type { Role } from '@/lib/auth/roles';
import { canAccessSensitive } from '@/lib/auth/roles';

const MAX_CHUNKS = 15;

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
      return { id: this.config.id, name: this.config.name, sources: [], topics: [], entities: [], index: '' };
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

    // ─── 소스 단위 관련성 점수 ─────────────────────────────────────
    const sourcesWithScore = allowedSources.map(source => {
      let score = 0;

      // topic 매칭 (이름이 쿼리에 포함 or 쿼리 단어가 topic명에 포함)
      for (const t of source.topics) {
        const tl = t.toLowerCase();
        if (queryLower.includes(tl) || queryWords.some(w => tl.includes(w))) score += 3;
      }
      // entity 매칭
      for (const e of source.entities) {
        const el = e.toLowerCase();
        if (queryLower.includes(el) || queryWords.some(w => el.includes(w))) score += 2;
      }
      // tags 매칭
      for (const tag of source.tags) {
        const tl = tag.toLowerCase();
        if (queryWords.some(w => tl.includes(w) || w.includes(tl))) score += 2;
      }
      // 본문 단어 매칭
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
      const chunks = splitIntoChunks(source.content);
      for (const chunk of chunks) {
        const score = scoreChunk(chunk, queryWords);
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

    // 관련 청크 없으면 각 소스의 첫 청크를 fallback으로 사용
    const chunksToUse = scoredChunks.length > 0
      ? scoredChunks.sort((a, b) => b.score - a.score).slice(0, MAX_CHUNKS)
      : sourcesToProcess.map(source => ({
          title: source.title,
          id: source.id,
          topic: source.topics[0] ?? source.tags[0] ?? '',
          chunk: splitIntoChunks(source.content)[0],
          score: 0,
        })).slice(0, MAX_CHUNKS);

    const relevantData = chunksToUse
      .map(c => `## ${c.title} (${c.id})\n${c.chunk}`)
      .join('\n\n---\n\n');

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
