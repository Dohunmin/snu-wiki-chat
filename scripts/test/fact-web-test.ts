/**
 * fact(normal) + web_search 실측 하니스 — route.ts의 admin/tier1 fact 분기를 충실 복제.
 *   Case B(웹 회피) 수정 검증용: "내부에 없는 사실"을 물었을 때 web_search가 실제로 *발동*하는지,
 *   그리고 답이 거절/외부떠넘김 대신 (외부) 사실로 채워지는지 측정.
 *   route.ts와 동일한 lib/llm/web-search.ts(WEB_SEARCH_GUIDANCE_FACT)·buildSystemPromptParts를 import → 드리프트 0.
 *
 * ⚠️ 유료: web_search 발동 시 검색결과 본문이 입력토큰 → ~$0.1~0.3/질문. 미발동이면 ~$0.05.
 * 실행: npx tsx --env-file=.env.local scripts/test/fact-web-test.ts ["질문"]
 */
import process from 'process';
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local'); } catch {}

import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { buildNumberedContexts, resolveText } from '@/lib/llm/citations';
import { buildSystemPromptParts, buildUserMessage } from '@/lib/llm/prompts';
import { WEB_SEARCH_TOOL_POLICY, WEB_SEARCH_GUIDANCE_FACT } from '@/lib/llm/web-search';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';
import type Anthropic from '@anthropic-ai/sdk';

const IN_PER_M = 3, OUT_PER_M = 15;
const usd = (i: number, o: number) => i / 1e6 * IN_PER_M + o / 1e6 * OUT_PER_M;
const DECLINE_RE = /범위 밖|자료가? (없|부족)|외부.{0,8}확인.{0,4}필요|확인하시기 바랍|snu\.ac\.kr|📌 한계|분석의 한계|자료 한계/;

async function main() {
  const query = process.argv[2] || '학군단 소유주';
  const role: Role = 'admin';   // webEnabled = true (admin/tier1 fact에 web 부착)
  console.log(`\n질문: "${query}"  (mode=normal/fact, role=${role}, webEnabled=true)\n${'='.repeat(70)}`);

  // route.ts fact 분기 복제 ──────────────────────────────────────────
  const routing = await routeQuery(query, role, undefined);
  const budgeted = await enforceContextBudget(query, routing.contexts, complexityBudget(query));
  const numbered = buildNumberedContexts(budgeted);
  const parts = buildSystemPromptParts(budgeted, role);
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: parts.stable },
    { type: 'text', text: parts.tail + WEB_SEARCH_GUIDANCE_FACT },   // ← admin/tier1 fact 웹 가이드(고친 본)
  ];
  const userMessage = buildUserMessage(query, numbered.contextMarkdown, numbered.summary);
  console.log(`routed=${routing.selectedAgentIds.join('+') || '-'} | 컨텍스트 ${budgeted.length}블록`);

  const resp = await getAnthropicClient().messages.create({
    model: LLM_MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: userMessage }],
    tools: [WEB_SEARCH_TOOL_POLICY] as unknown as Anthropic.Tool[],
  });

  const raw = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
  const answer = resolveText(raw, numbered.mapping);
  const webFired = (resp.usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests ?? 0;
  const declined = DECLINE_RE.test(raw);

  console.log(`\n${'─'.repeat(70)}\n${answer}\n${'─'.repeat(70)}`);
  console.log(`\n🌐 web_search 발동: ${webFired}회   |   거절/외부떠넘김 마커: ${declined ? '있음 ❌' : '없음 ✅'}`);
  console.log(`비용 $${usd(resp.usage.input_tokens, resp.usage.output_tokens).toFixed(4)} (in=${resp.usage.input_tokens} out=${resp.usage.output_tokens}) stop=${resp.stop_reason}`);
  console.log(`\n판정: ${webFired > 0 && !declined ? '✅ PASS — 웹 발동 + 직접 답변' : webFired > 0 ? '🟡 부분 — 웹은 폈으나 떠넘김 잔존' : '❌ FAIL — 웹 미발동(회피 지속)'}`);
}

main().catch(e => { console.error(e); process.exit(1); });
