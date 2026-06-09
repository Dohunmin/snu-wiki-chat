/**
 * fact 모델 비교 (배치) — 실제 로그 fact 질문 5개를 Sonnet vs Haiku로, 같은 컨텍스트(M1+P8).
 *   합성 금지 — DB의 실제 user 질문만. 라우터로 fact 확인 후 선정.
 * 비용: 라우터 분류(~$0.01) + 5질문 × (Sonnet+Haiku).
 *   $env:RERANK_ENABLED='true'; npx tsx --env-file=.env.local scripts/compare-fact-batch.ts
 */
import { sql } from '@vercel/postgres';
import { routeToAgent } from '@/lib/agents/agent-router';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL, LLM_MODEL_LIGHT } from '@/lib/llm/client';

const ROLE = 'admin' as const;
const N = 5;
const RATES: Record<string, [number, number]> = { [LLM_MODEL]: [3, 15], [LLM_MODEL_LIGHT]: [1, 5] };

async function gen(model: string, sys: string, user: string) {
  const resp = await getAnthropicClient().messages.create({ model, max_tokens: 2000, system: sys, messages: [{ role: 'user', content: user }] });
  const text = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
  const [ri, ro] = RATES[model] ?? [3, 15];
  return { text, inT: resp.usage.input_tokens, outT: resp.usage.output_tokens, cost: resp.usage.input_tokens / 1e6 * ri + resp.usage.output_tokens / 1e6 * ro };
}

async function main() {
  const rows = (await sql`
    SELECT DISTINCT content, char_length(content) AS len
    FROM messages WHERE role='user' AND char_length(content) BETWEEN 15 AND 160
    ORDER BY len DESC LIMIT 40`).rows as { content: string; len: number }[];
  // 다양성 위해 길이정렬에서 spread sample
  const step = Math.max(1, Math.floor(rows.length / 14));
  const cands = rows.filter((_, i) => i % step === 0).map(r => r.content);

  const picked: string[] = [];
  for (const q of cands) {
    if (picked.length >= N) break;
    const dec = await routeToAgent(q);
    if (dec.agent === 'fact') picked.push(q);
  }
  console.log(`fact 질문 ${picked.length}개 선정 (실제 로그):`);
  picked.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));

  let sonTot = 0, haiTot = 0;
  for (let i = 0; i < picked.length; i++) {
    const Q = picked[i];
    const routing = await routeQuery(Q, ROLE);
    const ctxs = await enforceContextBudget(Q, routing.contexts, complexityBudget(Q));
    const numbered = buildNumberedContexts(ctxs);
    const sys = buildSystemPrompt(ctxs, ROLE);
    const user = buildUserMessage(Q, numbered.contextMarkdown, numbered.summary);
    const son = await gen(LLM_MODEL, sys, user);
    const hai = await gen(LLM_MODEL_LIGHT, sys, user);
    sonTot += son.cost; haiTot += hai.cost;
    console.log('\n' + '█'.repeat(92));
    console.log(`Q${i + 1}: ${Q}`);
    console.log(`라우팅: ${routing.selectedAgentIds.join(',')} | ctx ${numbered.contextMarkdown.length}자 | Sonnet $${son.cost.toFixed(4)} (out ${son.outT}) / Haiku $${hai.cost.toFixed(4)} (out ${hai.outT})`);
    console.log('█'.repeat(92));
    console.log(`\n─── 🟦 SONNET ───\n${son.text}`);
    console.log(`\n─── 🟨 HAIKU ───\n${hai.text}`);
  }
  console.log('\n' + '━'.repeat(92));
  console.log(`총비용: Sonnet $${sonTot.toFixed(4)} / Haiku $${haiTot.toFixed(4)} (Haiku = Sonnet의 ${(haiTot / sonTot * 100).toFixed(0)}%, ${(sonTot / haiTot).toFixed(1)}배 저렴)`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
