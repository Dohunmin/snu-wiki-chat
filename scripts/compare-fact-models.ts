/**
 * fact 모델 비교 — Haiku vs Sonnet, 같은 컨텍스트(M1 재정렬 + P8 적용)로 생성.
 *   ① 억측 사라졌나(새 파이프) ② fact에서 Haiku가 Sonnet만큼 하나(비용·품질)
 * 비용: 질문당 Sonnet ~$0.13 + Haiku ~$0.05.
 *   $env:RERANK_ENABLED='true'; npx tsx --env-file=.env.local scripts/compare-fact-models.ts
 */
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL, LLM_MODEL_LIGHT } from '@/lib/llm/client';

const Q = '서울대 ai 대학원이 어떻게 구성되는데? 지금 있는 대학원들이 통합되는 방식이니?';
const ROLE = 'admin' as const;

// $/1M 토큰 [input, output]
const RATES: Record<string, [number, number]> = {
  [LLM_MODEL]: [3, 15],        // Sonnet 4.6
  [LLM_MODEL_LIGHT]: [1, 5],   // Haiku 4.5
};

async function gen(model: string, sys: string, user: string) {
  const resp = await getAnthropicClient().messages.create({
    model, max_tokens: 2000, system: sys, messages: [{ role: 'user', content: user }],
  });
  const text = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
  const [ri, ro] = RATES[model] ?? [3, 15];
  const cost = resp.usage.input_tokens / 1e6 * ri + resp.usage.output_tokens / 1e6 * ro;
  return { text, inT: resp.usage.input_tokens, outT: resp.usage.output_tokens, cost };
}

async function main() {
  const routing = await routeQuery(Q, ROLE);
  const ctxs = await enforceContextBudget(Q, routing.contexts, complexityBudget(Q));
  const numbered = buildNumberedContexts(ctxs);
  const sys = buildSystemPrompt(ctxs, ROLE);
  const user = buildUserMessage(Q, numbered.contextMarkdown, numbered.summary);

  console.log(`Q: ${Q}\n라우팅: ${routing.selectedAgentIds.join(', ')} | 컨텍스트 ${numbered.contextMarkdown.length}자\n`);

  const son = await gen(LLM_MODEL, sys, user);
  const hai = await gen(LLM_MODEL_LIGHT, sys, user);

  console.log('═'.repeat(80) + `\n🟦 SONNET (${LLM_MODEL})\n` + '═'.repeat(80));
  console.log(son.text);
  console.log(`\n💰 in ${son.inT} / out ${son.outT} / $${son.cost.toFixed(4)}\n`);

  console.log('═'.repeat(80) + `\n🟨 HAIKU (${LLM_MODEL_LIGHT})\n` + '═'.repeat(80));
  console.log(hai.text);
  console.log(`\n💰 in ${hai.inT} / out ${hai.outT} / $${hai.cost.toFixed(4)}\n`);

  console.log('━'.repeat(80));
  console.log(`비용: Sonnet $${son.cost.toFixed(4)} vs Haiku $${hai.cost.toFixed(4)} (Haiku = Sonnet의 ${(hai.cost / son.cost * 100).toFixed(0)}%, ${(son.cost / hai.cost).toFixed(1)}배 저렴)`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
