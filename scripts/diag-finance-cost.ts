/**
 * 특정 질문 비용 해부 (생성 없음, ~$0.0003). 컨텍스트 비대 vs 재시도 원인 분리.
 *   npx tsx --env-file=.env.local scripts/diag-finance-cost.ts
 */
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget, classifyComplexity } from '@/lib/agents/complexity';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';

const Q = '서울대학교 법인회계의 수입(세입)을 정부출연금·등록금·산학협력수익 등 출처별로 나누고, 각각 전체 수입에서 차지하는 비중(%)을 표로 보여줘';
const ROLE = 'tier1' as const;
const KRW_PER_TOK = 1 / 2;           // 한글 대략 2자/토큰 (러프)

async function main() {
  console.log(`Q(${Q.length}자): ${Q}\n`);
  console.log(`복잡도: ${classifyComplexity(Q)} / 예산: ${complexityBudget(Q)}자`);

  const routing = await routeQuery(Q, ROLE);
  console.log(`라우팅 위키 ${routing.selectedAgentIds.length}개: ${routing.selectedAgentIds.join(', ')}`);

  const rawTotal = routing.contexts.reduce((s, c) => s + c.relevantData.length, 0);
  const budgeted = await enforceContextBudget(Q, routing.contexts, complexityBudget(Q));
  const numbered = buildNumberedContexts(budgeted);
  const sys = buildSystemPrompt(budgeted, ROLE);
  const user = buildUserMessage(Q, numbered.contextMarkdown, numbered.summary);

  const inputChars = sys.length + user.length;
  const inTok = Math.round(inputChars * KRW_PER_TOK);
  console.log(`\n컨텍스트: raw ${rawTotal}자 → 예산후 ${numbered.contextMarkdown.length}자`);
  console.log(`시스템프롬프트 ${sys.length}자 + user(컨텍스트포함) ${user.length}자 = 입력 ${inputChars}자 ≈ ${inTok} 토큰`);

  // 메인 1회 비용 추정 (출력 가정치별)
  const inCost = inTok / 1e6 * 3;
  console.log(`\n── 메인 1회 비용 추정 (입력 $${inCost.toFixed(4)}, 캐시 미적용 가정) ──`);
  for (const outTok of [1500, 3000, 6000]) {
    const c = inCost + outTok / 1e6 * 15;
    console.log(`  출력 ${outTok}토큰 → $${c.toFixed(4)}`);
  }
  console.log(`\n※ 표·비중 질문 → 표산수 교정 retry(경량) 가능. 옛-인용 retry는 *전체 컨텍스트 재전송* → 발동 시 +입력 $${inCost.toFixed(4)} 추가.`);
  console.log(`※ 캐시 적중 시 입력비 대폭↓. 실제 [chat-usage] in/out/cacheR 로그가 진짜 답.`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
