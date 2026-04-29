import type { AgentContext } from './types';
import type { Role } from '@/lib/auth/roles';
import { registry } from './registry';
import { WikiAgent } from './wiki-agent';
import agentsConfig from '@/data/agents.config.json';

export interface RoutingResult {
  selectedAgentIds: string[];
  contexts: AgentContext[];
  isGlobal: boolean;
}

export async function routeQuery(query: string, userRole: Role): Promise<RoutingResult> {
  const queryLower = query.toLowerCase();
  const globalKeywords: string[] = agentsConfig.routing.globalKeywords;
  const agents = registry.getAll();

  // Tier 0: 글로벌 키워드 → 전체 에이전트
  const isGlobal = globalKeywords.some(kw => queryLower.includes(kw));
  if (isGlobal) {
    const contexts = await Promise.all(agents.map(a => a.getContext(query, userRole)));
    return { selectedAgentIds: contexts.map(c => c.agentId), contexts, isGlobal: true };
  }

  // Tier 1: keywords 배열 매칭 (자동보강 포함)
  let selectedAgents = agents.filter(agent =>
    agent.config.keywords.some(kw => queryLower.includes(kw.toLowerCase()))
  );

  // Tier 2: 키워드 미매칭 → 메타데이터 경량 스캔
  if (selectedAgents.length === 0) {
    selectedAgents = agents.filter(agent =>
      agent instanceof WikiAgent && agent.preScore(query, userRole)
    );
  }

  // Fallback-of-last-resort: 모두 score=0 → 전체 호출 (완전 미지 쿼리)
  if (selectedAgents.length === 0) {
    selectedAgents = agents;
  }

  const contexts = await Promise.all(
    selectedAgents.map(agent => agent.getContext(query, userRole))
  );

  // Tier 2 경유 시 confidence 기준 강화
  const confidenceThreshold = selectedAgents.length < agents.length ? 0.4 : 0.3;
  const filteredContexts = contexts.filter(c => c.confidence > confidenceThreshold);

  // 필터 후 전부 제거되면 전체 유지 (정보 손실 방지)
  const finalContexts = filteredContexts.length > 0 ? filteredContexts : contexts;

  return {
    selectedAgentIds: finalContexts.map(c => c.agentId),
    contexts: finalContexts,
    isGlobal: false,
  };
}
