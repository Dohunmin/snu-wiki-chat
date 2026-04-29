import type { AgentContext } from '@/lib/agents/types';
import type { Role } from '@/lib/auth/roles';

export function buildSystemPrompt(contexts: AgentContext[], userRole: Role): string {
  const agentList = contexts.map(c => `- ${c.agentName}: ${c.agentId}`).join('\n');

  const sensitiveWarning = userRole === 'tier2'
    ? '\n\n주의: 사용자가 접근할 수 없는 민감 주제나 제한 자료가 있다면 내용을 노출하지 말고, 접근 권한이 필요하다고 안내하세요.'
    : '';

  return `당신은 서울대학교 거버넌스 통합 위키 AI 어시스턴트입니다.
사용자가 평의원회, 이사회, 대학운영계획, 중장기발전계획 자료를 빠르게 찾고 비교할 수 있도록 돕습니다.

응답 원칙:
- 제공된 위키 자료를 우선 근거로 사용하세요.
- 확인되지 않은 내용은 추측하지 말고 자료에서 확인되지 않는다고 말하세요.
- 답변에는 핵심 결론을 먼저 쓰고, 필요한 경우 근거와 출처를 함께 제시하세요.
- 여러 자료가 관련되면 항목별로 비교해 주세요.
- 한국어로 간결하고 실무적으로 답변하세요.

사용 가능한 위키 컨텍스트:
${agentList}

출처 표기:
- 답변 말미에 관련 출처가 있으면 [위키명] 문서명 형식으로 정리하세요.${sensitiveWarning}`;
}

export function buildUserMessage(query: string, contexts: AgentContext[]): string {
  const contextBlocks = contexts
    .map(ctx => `### [${ctx.agentName}] 관련 자료\n${ctx.relevantData}`)
    .join('\n\n---\n\n');

  return `## 관련 위키 자료\n\n${contextBlocks}\n\n---\n\n## 사용자 질문\n${query}`;
}
