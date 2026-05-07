import type { Role } from '@/lib/auth/roles';

export type AgentType = 'wiki' | 'task';
export type PageType = 'source' | 'topic' | 'entity' | 'synthesis' | 'fact' | 'stance' | 'overview';

export interface AgentConfig {
  id: string;
  name: string;
  type: AgentType;
  dataFile: string;
  enabled: boolean;
  keywords: string[];
  sensitiveTopics: string[];
  description: string;
  alwaysContext?: boolean;
  /** admin 외에는 wiki API·라우팅 어디서도 노출 안 됨 */
  adminOnly?: boolean;
  /** lens 페르소나 위키 — 일반 라우팅에서 항상 제외, lens 모드 전용 */
  lensPersona?: boolean;
  /** lens persona 식별자 (mode='lens:{personaId}') */
  personaId?: string;
  /** UI 표시명 (모드 메뉴·배지) */
  displayName?: string;
}

export interface GetContextOptions {
  chunkCap?: number;
  guaranteedPageIds?: Set<string>;
}

export interface SourceRef {
  wiki: string;
  page: string;
  topic?: string;
}

export interface AgentContext {
  agentId: string;
  agentName: string;
  relevantData: string;
  sources: SourceRef[];
  confidence: number;
}

export interface AgentPlugin {
  config: AgentConfig;
  getContext(query: string, userRole: Role, isGlobal?: boolean, options?: GetContextOptions): Promise<AgentContext>;
}

// wiki JSON 데이터 형식
export interface WikiSource {
  id: string;
  title: string;
  date?: string;
  tags: string[];
  topics: string[];
  entities: string[];
  content: string;
  sensitive: boolean;
}

export interface WikiTopic {
  id: string;
  name: string;
  category?: string;
  tags: string[];
  sources: string[];
  content: string;
}

export interface WikiEntity {
  id: string;
  name: string;
  entityType: string;
  aliases: string[];
  tags: string[];
  sources: string[];
  content: string;
}

export interface WikiSynthesis {
  id: string;
  query: string;
  answeredAt: string;
  routedTo: string[];
  tags: string[];
  content: string;
  source: 'obsidian' | 'chat';
}

export interface WikiFact {
  id: string;
  title: string;
  category: string;
  sources: string[];
  unit?: string;
  yearsCovered?: string;
  metricScope?: string;
  verifiedAt?: string;
  tags: string[];
  content: string;
  sensitive: boolean;
}

export interface WikiStance {
  id: string;
  title: string;
  holder: string;
  topic: string;
  sources: string[];
  tags: string[];
  content: string;
  sensitive: boolean;
}

export interface WikiOverview {
  id: string;
  title: string;
  편: string;
  시기?: [number, number];
  관련_stance?: Record<string, string[]>;
  tags: string[];
  content: string;
  sensitive: boolean;
}

export interface WikiData {
  id: string;
  name: string;
  sources: WikiSource[];
  topics: WikiTopic[];
  entities: WikiEntity[];
  syntheses: WikiSynthesis[];
  facts: WikiFact[];
  stances: WikiStance[];
  overviews: WikiOverview[];
  index: string;
}

export interface ConceptEntry {
  wikis: string[];
  aliases: string[];
  linkedPages: {
    wiki: string;
    type: 'entity' | 'topic' | 'stance' | 'source' | 'fact' | 'overview';
    id: string;
  }[];
}

export interface ConceptIndex {
  [conceptName: string]: ConceptEntry;
}
