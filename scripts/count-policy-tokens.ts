/**
 * 입력 토큰 정확 분해 (생성 X, countTokens=무료). web 콘텐츠가 실제로 얼마나 더하나.
 *   npx tsx --env-file=.env.local scripts/count-policy-tokens.ts
 */
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { buildPolicySystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';

const Q = '서울대학교 자산 중 사대부속 학교들의 부동산을 고층건물로 짓고 일부 저층은 초중고 용도로, 고층부는 대학 교육·연구시설로 사용하는 것은 가능할까?';
const ROLE = 'admin' as const;
const GUIDE = `\n\n[웹 검색 도구 — 공약설계]\n- 내부 위키 사실은 [N]로 인용한다.`;

async function main() {
  const routing = await routeQuery(Q, ROLE);
  const ctxs = await enforceContextBudget(Q, routing.contexts, complexityBudget(Q));
  const numbered = buildNumberedContexts(ctxs);
  const sys = buildPolicySystemPrompt(ctxs, ROLE) + GUIDE;
  const user = buildUserMessage(Q, numbered.contextMarkdown, numbered.summary);

  const ct = await getAnthropicClient().messages.countTokens({
    model: LLM_MODEL, system: sys, messages: [{ role: 'user', content: user }],
  });
  const internal = ct.input_tokens;

  console.log(`내부 입력(시스템+컨텍스트+질문, web 결과 없음) = ${internal} 토큰`);
  console.log(`  (시스템 ${sys.length}자 + user ${user.length}자)\n`);
  for (const [label, totalIn] of [['web=2 실측', 100479], ['web=1 실측', 98359]] as const) {
    const webPart = totalIn - internal;
    console.log(`${label}: 총입력 ${totalIn} → 내부 ${internal} + web/도구 ${webPart} 토큰 (web 비용 ~$${(webPart / 1e6 * 3).toFixed(3)})`);
  }
  console.log(`\n해석: web/도구 부분이 작으면 → 비용 지배는 *내부 컨텍스트*(복잡질문 40k예산). web 횟수 줄여도 거의 그대로.`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
