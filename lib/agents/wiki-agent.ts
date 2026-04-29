import path from 'path';
import fs from 'fs';
import type { AgentConfig, AgentContext, AgentPlugin, WikiData, WikiSource } from './types';
import type { Role } from '@/lib/auth/roles';
import { canAccessSensitive } from '@/lib/auth/roles';

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
      return {
        id: this.config.id,
        name: this.config.name,
        sources: [],
        topics: [],
        entities: [],
        index: '',
      };
    }
    this.data = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as WikiData;
    return this.data;
  }

  async getContext(query: string, userRole: Role): Promise<AgentContext> {
    const data = this.loadData();
    const isSensitiveAllowed = canAccessSensitive(userRole);

    // 쿼리와 관련된 source 검색
    const queryLower = query.toLowerCase();
    const relevantSources: WikiSource[] = [];

    for (const source of data.sources) {
      // 2순위는 민감 토픽 소스 제외
      if (!isSensitiveAllowed && source.sensitive) continue;

      const isTopicMatch = source.topics.some(t =>
        queryLower.includes(t.toLowerCase()) || t.toLowerCase().includes(queryLower)
      );
      const isEntityMatch = source.entities.some(e =>
        queryLower.includes(e.toLowerCase())
      );
      const isContentMatch = source.content.toLowerCase().includes(queryLower);

      if (isTopicMatch || isEntityMatch || isContentMatch) {
        relevantSources.push(source);
      }
    }

    // 관련 소스가 없으면 최근 5개 소스를 fallback으로 사용
    const sourcesToUse = relevantSources.length > 0
      ? relevantSources.slice(0, 5)
      : data.sources.filter(s => isSensitiveAllowed || !s.sensitive).slice(-5);

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
      confidence: relevantSources.length > 0 ? 0.8 : 0.3,
    };
  }
}
