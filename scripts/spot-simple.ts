/** 단순 factoid 질문이 complexity 라우팅에서 simple→16k→싸고 좋은 답 나오나 확인. */
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget, classifyComplexity } from '@/lib/agents/complexity';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';

const QS = [
  '이사회가 주로 다루는 안건은 어떤 것들이 있습니까?',     // 권태경 (실제)
  '서울대 전체 예산은 얼마이고 어떻게 구성되나요?',         // 권태경 (실제)
];

async function main() {
  let totIn = 0, totOut = 0;
  for (const q of QS) {
    const routing = await routeQuery(q, 'tier1');
    const budget = complexityBudget(q);
    const ctxs = await enforceContextBudget(q, routing.contexts, budget);
    const numbered = buildNumberedContexts(ctxs);
    const sys = buildSystemPrompt(ctxs, 'tier1');
    const user = buildUserMessage(q, numbered.contextMarkdown, numbered.summary);
    const resp = await getAnthropicClient().messages.create({ model: LLM_MODEL, max_tokens: 4000, system: sys, messages: [{ role: 'user', content: user }] });
    const text = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
    totIn += resp.usage.input_tokens; totOut += resp.usage.output_tokens;
    const cost = resp.usage.input_tokens / 1e6 * 3 + resp.usage.output_tokens / 1e6 * 15;
    console.log('\n' + '█'.repeat(80));
    console.log(`Q: ${q}`);
    console.log(`[${classifyComplexity(q)} / 예산 ${budget} / 컨텍스트 ${numbered.contextMarkdown.length}자 / 입력 ${resp.usage.input_tokens}tok / 💰$${cost.toFixed(3)}]`);
    console.log('─'.repeat(80));
    console.log(text.slice(0, 1400));
  }
  console.log(`\n총 ${QS.length}개 💰 ~$${(totIn / 1e6 * 3 + totOut / 1e6 * 15).toFixed(3)}`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
