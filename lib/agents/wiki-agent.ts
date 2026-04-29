import path from 'path';
import fs from 'fs';
import type { AgentConfig, AgentContext, AgentPlugin, WikiData, WikiSource } from './types';
import type { Role } from '@/lib/auth/roles';
import { canAccessSensitive } from '@/lib/auth/roles';

const MAX_SOURCES = 2;

export class WikiAgent implements AgentPlugin {
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
    // 단어 단위 매칭 (2자 이상 단어만)
    const queryWords = queryLower.split(/[\s,]+/).filter(w => w.length >= 2);

    const scored: { source: WikiSource; score: number }[] = [];

    for (const source of data.sources) {
      if (!isSensitiveAllowed && source.sensitive) continue;

      const contentLower = source.content.toLowerCase();
      let score = 0;

      // topic/entity 매칭 (높은 점수)
      for (const t of source.topics) {
        if (queryLower.includes(t.toLowerCase())) score += 3;
      }
      for (const e of source.entities) {
        if (queryLower.includes(e.toLowerCase())) score += 2;
      }
      // 단어별 본문 매칭
      for (const word of queryWords) {
        if (contentLower.includes(word)) score += 1;
      }

      if (score > 0) scored.push({ source, score });
    }

    // 점수 내림차순 정렬
    scored.sort((a, b) => b.score - a.score);

    const allowedSources = data.sources.filter(s => isSensitiveAllowed || !s.sensitive);
    const sourcesToUse: WikiSource[] = scored.length > 0
      ? scored.slice(0, MAX_SOURCES).map(s => s.source)
      : allowedSources.slice(-MAX_SOURCES);

    const relevantData = sourcesToUse
      .map(s => `## ${s.title} (${s.id})\n${s.content}`)
      .join('\n\n---\n\n');

    const sources = sourcesToUse.map(s => ({
      wiki: this.config.name,
      page: s.id,
      topic: s.topics[0],
    }));

    return {
      agentId: this.config.id,
      agentName: this.config.name,
      relevantData,
      sources,
      confidence: scored.length > 0 ? 0.8 : 0.3,
    };
  }
}
