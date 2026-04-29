import type { AgentContext } from '@/lib/agents/types';
import type { Role } from '@/lib/auth/roles';

export function buildSystemPrompt(contexts: AgentContext[], userRole: Role): string {
  const agentList = contexts.map(c => `- ${c.agentName}: ${c.agentId}`).join('\n');

  const sensitiveWarning = userRole === 'tier2'
    ? '\n\n⚠️ 주의: 이 사용자는 인사·선출 관련 민감한 세부 정보에 접근이 제한됩니다. 해당 내용은 답변에서 제외하세요.'
    : '';

  return `당신은 서울대학교 거버넌스 통합 위키 AI 어시스턴트입니다.
총장 후보 캠프 인사들이 서울대 거버넌스 자료를 빠르게 검색·활용할 수 있도록 돕습니다.

## 핵심 원칙
- P1. 할루시네이션 금지 — 제공된 컨텍스트에 없는 정보는 반드시 "확인되지 않음"으로 답변
- P2. 출처 명시 — 모든 주장에 [도메인] [[소스 ID]] 형식으로 출처 표기
- P3. 교차 확인 — 여러 소스에서 같은 사실이 확인되면 "(복수 출처, 신뢰도 높음)" 명시
- P4. 한계 인정 — 정보가 없으면 "해당 자료에서 확인되지 않음"으로 명시
- P5. 한국어 답변 — 모든 답변은 한국어로 작성

## 현재 검색된 에이전트
${agentList}

## 답변 형식
**[도메인명]** 답변 내용 [[소스 ID]]

교차 도메인 시:
**[평의원회]** 관련 내용 [[소스 ID]]
**[이사회]** 관련 내용 [[소스 ID]]
→ 두 기구 모두에서 확인됨 (신뢰도 높음)${sensitiveWarning}`;
}

export function buildUserMessage(query: string, contexts: AgentContext[]): string {
  const contextBlocks = contexts
    .map(ctx => `### [${ctx.agentName}] 관련 자료\n${ctx.relevantData}`)
    .join('\n\n---\n\n');

  return `## 참고 자료\n\n${contextBlocks}\n\n---\n\n## 질문\n${query}`;
}
