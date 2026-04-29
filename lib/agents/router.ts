import type { AgentContext } from './types';
import type { Role } from '@/lib/auth/roles';
import { registry } from './registry';
import agentsConfig from '@/data/agents.config.json';

export interface RoutingResult {
  selectedAgentIds: string[];
  contexts: AgentContext[];
  isGlobal: boolean;
}

export async function routeQuery(query: string, userRole: Role): Promise<RoutingResult> {
  const queryLower = query.toLowerCase();
  const globalKeywords: string[] = agentsConfig.routing.globalKeywords;

  // 1. 글로벌 키워드 → 전체 에이전트
  const isGlobal = globalKeywords.some(kw => queryLower.includes(kw));
  const agents = registry.getAll();

  let selectedAgents = isGlobal
    ? agents
    : agents.filter(agent =>
        agent.config.keywords.some(kw => queryLower.includes(kw))
      );

  // 2. 매칭 없으면 모든 에이전트로 fallback
  if (selectedAgents.length === 0) {
    selectedAgents = agents;
  }

  // 3. 각 에이전트에서 컨텍스트 수집 (병렬)
  const contexts = await Promise.all(
    selectedAgents.map(agent => agent.getContext(query, userRole))
  );

  // confidence 낮은 에이전트 제거 (전체 질의 아닌 경우)
  const filteredContexts = isGlobal
    ? contexts
    : contexts.filter(c => c.confidence > 0.2);

  return {
    selectedAgentIds: filteredContexts.map(c => c.agentId),
    contexts: filteredContexts,
    isGlobal,
  };
}
