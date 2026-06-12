/**
 * Agent-loop 스모크 하니스 (Phase A+B 라이브 실측) — HTTP 서버·auth 없이 새 모듈을 실제 API로 관통.
 *
 * 검증:
 *   ① planQuery → routeQuery seed → CitationRegistry 누적([N])  ② 도구 루프(search_wiki+web_search)
 *   ③ 중간 진행텍스트 폐기(search_wiki 세그먼트 텍스트 제외 — route.ts와 동일 로직)
 *   ④ 비용: 루프 vs 레거시 단일콜 토큰·$ 비교 ("이전 대비 늘었나")
 *
 * ⚠️ 유료: 같은 질문을 루프 + 레거시 둘 다 호출(비교용) → 질문당 대략 $0.2~0.6.
 * 실행: npx tsx --env-file=.env.local scripts/test/agent-loop-smoke.ts "이석재 교수 장단점"
 */
import process from 'process';
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local'); } catch {}

import { planQuery } from '@/lib/agents/agent-router';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { budgetForComplexity } from '@/lib/agents/complexity';
import { CitationRegistry, buildNumberedContexts, resolveText, extractCitedNumbers } from '@/lib/llm/citations';
import { buildAgentLoopSystemPrompt, buildAgentLoopUserMessage, buildPolicySystemPrompt, buildUserMessage } from '@/lib/llm/prompts';

// route.ts WEB_SEARCH_GUIDANCE_POLICY 충실 복제(레거시 insight 경로 검증용).
const POLICY_WEB_GUIDANCE = `\n\n[웹 검색 — 인사이트 전용]\n` +
  `- 발동 원칙: 내부 자료([N])로 핵심이 답되면 검색 안 함. 핵심 일부가 내부에 없으면 web_search로 보강(최대 1회). 거절·되묻기 금지, 직접 검색.\n` +
  `- 실명 인물 평가(장단점 포함): 공신력 출처로 교차확인된 범위에서 근거와 함께 서술(귀속·동명이인 주의·미검증은 "확인되지 않음"). 나무위키·블로그 금지.\n` +
  `- 외부 사실은 (외부지식) 표시, 출처 URL은 시스템 자동 첨부.`;
import { SEARCH_WIKI_TOOL, runSearchWiki } from '@/lib/agents/tools';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';
import type { AgentContext } from '@/lib/agents/types';
import type Anthropic from '@anthropic-ai/sdk';

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305', name: 'web_search', max_uses: 1,
  blocked_domains: ['namu.wiki', 'm.namu.wiki', 'thewiki.kr', 'librewiki.net',
    'blog.naver.com', 'm.blog.naver.com', 'tistory.com', 'brunch.co.kr', 'velog.io'],
};

// Sonnet 4.x 추정 단가(USD/백만토큰) + web_search 1회당. 캐시: read 10%, write 125%. 상대비교용.
const IN_PER_M = 3, OUT_PER_M = 15, WEB_EACH = 0.01;
const usd = (inT: number, outT: number, web: number, cacheR = 0, cacheW = 0) =>
  inT / 1e6 * IN_PER_M + cacheR / 1e6 * IN_PER_M * 0.1 + cacheW / 1e6 * IN_PER_M * 1.25 + outT / 1e6 * OUT_PER_M + web * WEB_EACH;
const webReqs = (u: Anthropic.Usage) => (u as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests ?? 0;

async function main() {
  const query = process.argv[2] || '이석재 교수 장단점';
  const role: Role = 'admin';
  console.log(`\n질문: "${query}"  (role=${role})\n${'='.repeat(64)}`);

  const plan = await planQuery(query, []);
  const budgetChars = budgetForComplexity(plan.complexity);
  const routing = await routeQuery(plan.resolvedQuery || query, role, plan);
  const budgeted = await enforceContextBudget(plan.resolvedQuery || query, routing.contexts, budgetChars);
  console.log(`[plan] intent=${plan.intent} cx=${plan.complexity} | routed=${routing.selectedAgentIds.join('+') || '-'} contexts=${budgeted.length}`);
  const client = getAnthropicClient();

  const loop = await runLoop(query, role, plan, budgeted, budgetChars, client);
  const legacy = await runLegacy(query, role, budgeted, client);

  // ── 결과 ───────────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(64)}`);
  console.log('[비용 비교]   (in/out 토큰, web, $추정)');
  const legacyCost = usd(legacy.in, legacy.out, legacy.web);
  const loopCost = usd(loop.in, loop.out, loop.web, loop.cacheR, loop.cacheW);
  console.log(`  레거시 단일콜 : in=${legacy.in} out=${legacy.out} web=${legacy.web}  →  $${legacyCost.toFixed(4)}`);
  console.log(`  루프(agentic) : in=${loop.in} cacheR=${loop.cacheR} cacheW=${loop.cacheW} out=${loop.out} web=${loop.web} (iters=${loop.iters})  →  $${loopCost.toFixed(4)}`);
  const ratio = loopCost / Math.max(legacyCost, 1e-9);
  console.log(`  배수          : ${ratio.toFixed(2)}× (루프/레거시)`);
  console.log(`\n[루프 결과] web_search=${loop.web}회, 인용 [N]=${loop.cited.join(',') || '없음'}`);
  const head = loop.answer.slice(0, 200).replace(/\n+/g, ' ');
  console.log(`[루프 답변 첫 200자] ${head}`);
  console.log(`  ⤷ 중간 진행문구 누출 검사: ${/검색하겠습니다|찾아보겠습니다|검색합니다/.test(loop.answer.slice(0, 120)) ? '❌ 누출 의심' : '✅ 깨끗(서두에 진행문구 없음)'}`);
  console.log(`${'='.repeat(64)}\n`);
}

/** route.ts 루프 미러: per-세그먼트, search_wiki 호출 세그먼트의 텍스트는 폐기(최종 답변만 유지). */
async function runLoop(
  query: string, role: Role, plan: Awaited<ReturnType<typeof planQuery>>,
  budgeted: AgentContext[], budgetChars: number, client: ReturnType<typeof getAnthropicClient>,
) {
  const registry = new CitationRegistry();
  const seed = registry.add(budgeted);
  // 캐싱(A): 시스템 고정 캐시 + 매 호출 직전 마지막 블록 롤링 캐시(route.ts와 동일).
  const system = [{ type: 'text', text: buildAgentLoopSystemPrompt(role, { webEnabled: true }), cache_control: { type: 'ephemeral' } }] as unknown as string;
  const convo: Anthropic.MessageParam[] = [{ role: 'user', content: buildAgentLoopUserMessage(query, seed, registry.summary) }];
  let prevRoll: Record<string, unknown> | null = null;
  const markRolling = () => {
    if (prevRoll) { delete prevRoll.cache_control; prevRoll = null; }
    const last = convo[convo.length - 1];
    if (!last) return;
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
    const blocks = last.content as unknown as Array<Record<string, unknown>>;
    const lb = blocks[blocks.length - 1];
    if (lb) { lb.cache_control = { type: 'ephemeral' }; prevRoll = lb; }
  };
  let answer = '', inT = 0, outT = 0, web = 0, iters = 0, searchWikiCount = 0, cacheR = 0, cacheW = 0;
  const MAX_ITERS = 4, MAX_SEARCH_WIKI = 3;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    iters = iter + 1;
    const isLast = iter === MAX_ITERS - 1;
    const allowSearch = !isLast && searchWikiCount < MAX_SEARCH_WIKI;
    const tools = (allowSearch ? [SEARCH_WIKI_TOOL, WEB_SEARCH_TOOL] : [WEB_SEARCH_TOOL]) as unknown as never;
    markRolling();
    const resp = await client.messages.create({ model: LLM_MODEL, max_tokens: MAX_TOKENS, system, messages: convo, tools });
    inT += resp.usage.input_tokens; outT += resp.usage.output_tokens; web += webReqs(resp.usage);
    cacheR += resp.usage.cache_read_input_tokens ?? 0; cacheW += resp.usage.cache_creation_input_tokens ?? 0;

    const toolUses = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'search_wiki');
    const segText = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
    // 중간 진행텍스트 폐기: search_wiki 호출 세그먼트면 텍스트 버림(최종 답변 세그먼트만 채택).
    if (toolUses.length === 0) answer += segText;
    console.log(`[iter ${iter}] stop=${resp.stop_reason} search_wiki=${toolUses.length} web(누적)=${web} text=${segText.length}자${toolUses.length ? '(폐기)' : ''}`);

    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) break;
    searchWikiCount += toolUses.length;
    convo.push({ role: 'assistant', content: resp.content as Anthropic.ContentBlockParam[] });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const q = String((tu.input as { query?: string })?.query ?? '');
      const out = await runSearchWiki({ query: q }, { role, registry, plan, budgetChars });
      console.log(`         ↳ search_wiki("${q.slice(0, 36)}") → ${out.length}자, [N]=${registry.mapping.size}`);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
    }
    convo.push({ role: 'user', content: results });
  }
  return { answer: resolveText(answer, registry.mapping), in: inT, out: outT, web, iters, cacheR, cacheW, cited: [...extractCitedNumbers(answer)].sort((a, b) => a - b) };
}

/** 레거시 baseline: seed 컨텍스트 임베드 + 단일 콜(웹 도구만). "이전" 비용 기준. */
async function runLegacy(query: string, role: Role, budgeted: AgentContext[], client: ReturnType<typeof getAnthropicClient>) {
  const numbered = buildNumberedContexts(budgeted);
  const system = buildPolicySystemPrompt(budgeted, role) + POLICY_WEB_GUIDANCE;   // 실제 insight 경로 충실 재현
  const user = buildUserMessage(query, numbered.contextMarkdown, numbered.summary);
  const resp = await client.messages.create({
    model: LLM_MODEL, max_tokens: MAX_TOKENS, system,
    messages: [{ role: 'user', content: user }],
    tools: [WEB_SEARCH_TOOL] as unknown as never,
  });
  return { in: resp.usage.input_tokens, out: resp.usage.output_tokens, web: webReqs(resp.usage) };
}

main().catch(e => { console.error(e); process.exit(1); });
