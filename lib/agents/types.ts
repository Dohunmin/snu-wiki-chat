import type { Role } from '@/lib/auth/roles';

export type AgentType = 'wiki' | 'task';

export interface AgentConfig {
  id: string;
  name: string;
  type: AgentType;
  dataFile: string;
  enabled: boolean;
  keywords: string[];
  sensitiveTopics: string[];
  description: string;
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
  getContext(query: string, userRole: Role): Promise<AgentContext>;
}

// wiki JSON 데이터 형식
export interface WikiSource {
  id: string;
  title: string;
  date?: string;
  topics: string[];
  entities: string[];
  content: string;
  sensitive: boolean;
}

export interface WikiData {
  id: string;
  name: string;
  sources: WikiSource[];
  topics: string[];
  entities: string[];
  index: string;
}
