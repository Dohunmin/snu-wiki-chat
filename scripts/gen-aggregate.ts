/** 집계 라우팅 end-to-end — "각 단과대별 학과" 실답변 1회(Sonnet ~$0.13). 픽스 확인용.
 *   $env:RERANK_ENABLED='true'; npx tsx --env-file=.env.local scripts/gen-aggregate.ts */
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';

const Q = '각 단과대별 어떤 하위 학과들이 있어?';
async function main() {
  const r = await routeQuery(Q, 'admin');
  const c = await enforceContextBudget(Q, r.contexts, complexityBudget(Q));
  const n = buildNumberedContexts(c);
  const resp = await getAnthropicClient().messages.create({
    model: LLM_MODEL, max_tokens: 3000, system: buildSystemPrompt(c, 'admin'),
    messages: [{ role: 'user', content: buildUserMessage(Q, n.contextMarkdown, n.summary) }],
  });
  const t = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
  console.log(`위키 ${r.selectedAgentIds.length}개 | ctx ${n.contextMarkdown.length}자\n${'─'.repeat(70)}\n${t}`);
  console.log(`\n💰 $${(resp.usage.input_tokens / 1e6 * 3 + resp.usage.output_tokens / 1e6 * 15).toFixed(4)} (in ${resp.usage.input_tokens}/out ${resp.usage.output_tokens})`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
