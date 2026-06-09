/**
 * AI대학원 단정(억측) 방지 검증 — P8 추가 후 답변 1회 생성.
 *   before(통합 아님 단정)는 사용자가 이미 확인한 기존 답변. 여기선 after만 생성.
 * 컨텍스트 키워드 카운트도 출력해 "자료엔 결론 없음 vs 답변이 단정했나"를 대조.
 * 비용: Sonnet 1회 (~$0.02~0.05).
 *   npx tsx --env-file=.env.local scripts/test-aidaehakwon.ts
 */
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';

const Q = '서울대 ai 대학원이 어떻게 구성되는데? 지금 있는 대학원들이 통합되는 방식이니?';
const ROLE = 'admin' as const;

async function main() {
  const routing = await routeQuery(Q, ROLE);
  const ctxs = await enforceContextBudget(Q, routing.contexts, complexityBudget(Q));
  const numbered = buildNumberedContexts(ctxs);
  const sys = buildSystemPrompt(ctxs, ROLE);
  const user = buildUserMessage(Q, numbered.contextMarkdown, numbered.summary);

  console.log(`\n══════ Q: ${Q} ══════`);
  console.log(`라우팅: ${routing.selectedAgentIds.join(', ')} | 컨텍스트 ${numbered.contextMarkdown.length}자`);
  console.log('컨텍스트 키워드 등장 횟수 (자료에 결론어가 실제로 있나):');
  for (const kw of ['통합', '신설', '개방형', '설립계획', '준비단', '지속 논의']) {
    const n = (numbered.contextMarkdown.match(new RegExp(kw, 'g')) || []).length;
    console.log(`   '${kw}': ${n}회`);
  }

  const resp = await getAnthropicClient().messages.create({
    model: LLM_MODEL, max_tokens: 2000, system: sys,
    messages: [{ role: 'user', content: user }],
  });
  const text = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
  const cost = resp.usage.input_tokens / 1e6 * 3 + resp.usage.output_tokens / 1e6 * 15;

  console.log(`\n────── 🟢 AFTER (P8 추가) ──────\n${text}`);
  console.log(`\n💰 생성 1회: $${cost.toFixed(4)} (in ${resp.usage.input_tokens} / out ${resp.usage.output_tokens})`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
