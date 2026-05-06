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

  // Tier 1: keywords 배열 매칭 (자동보강 포함) — 먼저 시도
  const tier1Matches = agents.filter(agent =>
    agent.config.keywords.some(kw => queryLower.includes(kw.toLowerCase()))
  );

  // Tier 0: 글로벌 키워드 → Tier 1 미매칭일 때만 전체 호출
  // (특정 에이전트가 이미 매칭됐다면 글로벌 키워드 무시: "이사회 전체 요약" → board만)
  const hasGlobalKeyword = globalKeywords.some(kw => queryLower.includes(kw));
  if (hasGlobalKeyword && tier1Matches.length === 0) {
    const contexts = await Promise.all(agents.map(a => a.getContext(query, userRole, true)));
    return { selectedAgentIds: contexts.map(c => c.agentId), contexts, isGlobal: true };
  }

  let selectedAgents = tier1Matches;

  // Tier 2: Tier 1 미매칭 → 메타데이터 경량 스캔
  if (selectedAgents.length === 0) {
    selectedAgents = agents.filter(agent =>
      agent instanceof WikiAgent && agent.preScore(query, userRole)
    );
  }

  // Fallback-of-last-resort: 모두 score=0 → 전체 호출 (완전 미지 쿼리)
  if (selectedAgents.length === 0) {
    selectedAgents = agents;
  }

  // "전체", "모든" 등 글로벌 키워드가 있으면 선택된 에이전트 내에서도 전 소스 커버
  const contexts = await Promise.all(
    selectedAgents.map(agent => agent.getContext(query, userRole, hasGlobalKeyword))
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
