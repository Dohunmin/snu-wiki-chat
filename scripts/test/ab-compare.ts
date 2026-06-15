/**
 * A/B 비교 — 루프 ON(품질 중심 agentic) vs 단일콜 OFF(비용 중심), 같은 질문.
 *   각 질문에 두 경로를 돌려 비용(캐시 반영) + 답변 전문을 출력. fact 2 + insight 2.
 *
 * ⚠️ 유료: 질문당 (루프 최대 4콜 + 단일 1콜). 4질문 ≈ $1.0~1.5 추정.
 * 실행: npx tsx --env-file=.env.local scripts/test/ab-compare.ts
 */
import process from 'process';
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local'); } catch {}

import { planQuery } from '@/lib/agents/agent-router';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { budgetForComplexity } from '@/lib/agents/complexity';
import { CitationRegistry, buildNumberedContexts, resolveText, extractCitedNumbers } from '@/lib/llm/citations';
import { buildAgentLoopSystemPrompt, buildAgentLoopUserMessage, buildPolicySystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
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
const POLICY_WEB_GUIDANCE = `\n\n[웹 검색 — 인사이트 전용]\n` +
  `- 내부 자료([N])로 핵심이 답되면 검색 안 함. 핵심 일부가 내부에 없으면 web_search로 보강(최대 1회). 거절·되묻기 금지, 직접 검색.\n` +
  `- 실명 인물 평가(장단점 포함): 공신력 출처 교차확인 범위에서 근거와 함께 서술(귀속·동명이인 주의·미검증은 "확인되지 않음"). 나무위키·블로그 금지.\n` +
  `- 외부 사실은 (외부지식) 표시, 출처 URL은 시스템 자동 첨부.`;

const IN_PER_M = 3, OUT_PER_M = 15, WEB_EACH = 0.01;
const usd = (i: number, o: number, w: number, cr = 0, cw = 0) =>
  i / 1e6 * IN_PER_M + cr / 1e6 * IN_PER_M * 0.1 + cw / 1e6 * IN_PER_M * 1.25 + o / 1e6 * OUT_PER_M + w * WEB_EACH;
const webReqs = (u: Anthropic.Usage) => (u as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests ?? 0;

const QUESTIONS: { tag: string; q: string }[] = [
  { tag: 'fact·단순',   q: '2024년 종합재무제표 운영수익은 얼마인가?' },
  { tag: 'fact·복합',   q: '공과대학과 인문대학의 대학원 현황을 비교해줘' },
  { tag: 'insight·단일', q: '법인화 이후 서울대 재정구조 변화가 갖는 의미는?' },
  { tag: 'insight·외부', q: '이석재 교수의 장단점은?' },
];

type Arm = { in: number; out: number; web: number; cacheR: number; cacheW: number; cost: number; searches: number; answer: string };

async function main() {
  const role: Role = 'admin';
  const client = getAnthropicClient();
  const rows: { tag: string; q: string; loop: Arm; legacy: Arm }[] = [];

  for (const { tag, q } of QUESTIONS) {
    console.log(`\n${'#'.repeat(70)}\n[${tag}] ${q}\n${'#'.repeat(70)}`);
    const plan = await planQuery(q, []);
    const budgetChars = budgetForComplexity(plan.complexity);
    const routing = await routeQuery(plan.resolvedQuery || q, role, plan);
    const budgeted = await enforceContextBudget(plan.resolvedQuery || q, routing.contexts, budgetChars);
    console.log(`  plan: intent=${plan.intent} cx=${plan.complexity} | routed=${routing.selectedAgentIds.join('+') || '-'}`);

    const loop = await runLoop(q, role, plan, budgeted, budgetChars, client);
    const legacy = await runLegacy(q, role, budgeted, client);
    rows.push({ tag, q, loop, legacy });

    console.log(`\n  ── 루프 ON  ($${loop.cost.toFixed(4)}, searches=${loop.searches}, web=${loop.web}) ──────────────`);
    console.log(loop.answer.trim());
    console.log(`\n  ── 단일콜 OFF  ($${legacy.cost.toFixed(4)}, web=${legacy.web}) ──────────────`);
    console.log(legacy.answer.trim());
  }

  // 요약 표
  console.log(`\n\n${'='.repeat(70)}\n비용 요약\n${'='.repeat(70)}`);
  let tL = 0, tG = 0;
  for (const r of rows) {
    tL += r.loop.cost; tG += r.legacy.cost;
    const mult = (r.loop.cost / Math.max(r.legacy.cost, 1e-9)).toFixed(1);
    console.log(`  [${r.tag}] 루프 $${r.loop.cost.toFixed(4)} (s=${r.loop.searches},w=${r.loop.web}) | 단일 $${r.legacy.cost.toFixed(4)} (w=${r.legacy.web}) | ${mult}×`);
  }
  console.log(`  ${'-'.repeat(60)}`);
  console.log(`  합계: 루프 $${tL.toFixed(4)} | 단일 $${tG.toFixed(4)} | ${(tL / Math.max(tG, 1e-9)).toFixed(2)}×`);
}

async function runLoop(q: string, role: Role, plan: Awaited<ReturnType<typeof planQuery>>, budgeted: AgentContext[], budgetChars: number, client: ReturnType<typeof getAnthropicClient>): Promise<Arm> {
  const registry = new CitationRegistry();
  const seed = registry.add(budgeted);
  const system = [{ type: 'text', text: buildAgentLoopSystemPrompt(role, { webEnabled: true }), cache_control: { type: 'ephemeral' } }] as unknown as string;
  const convo: Anthropic.MessageParam[] = [{ role: 'user', content: buildAgentLoopUserMessage(q, seed, registry.summary) }];
  let prevRoll: Record<string, unknown> | null = null;
  const markRolling = () => {
    if (prevRoll) { delete prevRoll.cache_control; prevRoll = null; }
    const last = convo[convo.length - 1]; if (!last) return;
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
    const blocks = last.content as unknown as Array<Record<string, unknown>>;
    const lb = blocks[blocks.length - 1];
    if (lb) { lb.cache_control = { type: 'ephemeral' }; prevRoll = lb; }
  };
  let answer = '', i = 0, o = 0, web = 0, cr = 0, cw = 0, searches = 0;
  const MAX_ITERS = 4, MAX_SEARCH = 3;
  for (let iter = 0; iter < MAX_ITERS; iter++) {
    const isLast = iter === MAX_ITERS - 1;
    const allow = !isLast && searches < MAX_SEARCH;
    const tools = (allow ? [SEARCH_WIKI_TOOL, WEB_SEARCH_TOOL] : [WEB_SEARCH_TOOL]) as unknown as never;
    markRolling();
    const resp = await client.messages.create({ model: LLM_MODEL, max_tokens: MAX_TOKENS, system, messages: convo, tools });
    i += resp.usage.input_tokens; o += resp.usage.output_tokens; web += webReqs(resp.usage);
    cr += resp.usage.cache_read_input_tokens ?? 0; cw += resp.usage.cache_creation_input_tokens ?? 0;
    const tu = resp.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'search_wiki');
    const segText = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
    if (tu.length === 0) answer += segText;   // 중간(검색) 세그먼트 텍스트 폐기
    if (resp.stop_reason !== 'tool_use' || tu.length === 0) break;
    searches += tu.length;
    convo.push({ role: 'assistant', content: resp.content as Anthropic.ContentBlockParam[] });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const t of tu) {
      const out = await runSearchWiki({ query: String((t.input as { query?: string })?.query ?? '') }, { role, registry, plan, budgetChars });
      results.push({ type: 'tool_result', tool_use_id: t.id, content: out });
    }
    convo.push({ role: 'user', content: results });
  }
  return { in: i, out: o, web, cacheR: cr, cacheW: cw, cost: usd(i, o, web, cr, cw), searches, answer: resolveText(answer, registry.mapping) };
}

async function runLegacy(q: string, role: Role, budgeted: AgentContext[], client: ReturnType<typeof getAnthropicClient>): Promise<Arm> {
  const numbered = buildNumberedContexts(budgeted);
  const system = buildPolicySystemPrompt(budgeted, role) + POLICY_WEB_GUIDANCE;
  const user = buildUserMessage(q, numbered.contextMarkdown, numbered.summary);
  const resp = await client.messages.create({ model: LLM_MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }], tools: [WEB_SEARCH_TOOL] as unknown as never });
  const i = resp.usage.input_tokens, o = resp.usage.output_tokens, web = webReqs(resp.usage);
  const answer = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
  return { in: i, out: o, web, cacheR: 0, cacheW: 0, cost: usd(i, o, web), searches: 0, answer: resolveText(answer, numbered.mapping) };
}

main().catch(e => { console.error(e); process.exit(1); });
