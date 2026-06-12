/**
 * e2e: 이석재 후속질문("외부 자료 확인해")이 실제 chat route의 policy 분기를 타고
 *   web_search를 발동시켜 외부 출처를 붙이는지 끝까지 확인.
 *   route.ts의 흐름을 그대로 재현(planQuery→routeQuery→예산→policy 프롬프트→web 도구 스트림).
 *   비용: Sonnet 1콜 + web_search(검색결과 본문이 입력토큰) ~$0.11~0.18.
 *   실행: npx tsx --env-file=.env.local scripts/check-e2e-leesj-web.ts
 */
import { planQuery, type ChatTurn } from '@/lib/agents/agent-router';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { budgetForComplexity } from '@/lib/agents/complexity';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { buildPolicySystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';

// ── route.ts의 module-local 상수 미러 (테스트 전용 복제) ──
const WEB_SEARCH_TOOL_POLICY = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 1,
  blocked_domains: [
    'namu.wiki', 'm.namu.wiki', 'thewiki.kr', 'librewiki.net',
    'blog.naver.com', 'm.blog.naver.com', 'tistory.com', 'brunch.co.kr', 'velog.io',
  ],
};
const WEB_SEARCH_GUIDANCE_POLICY =
  `\n\n[웹 검색 — 인사이트 전용]\n` +
  `- 발동 원칙(하나만): 제공된 내부 자료([N])로 질문의 핵심을 충실히 답할 수 있으면 검색하지 않는다. 핵심의 일부라도 내부 자료에 없어 "자료 밖·별도 확인 필요"라고 쓰게 되는 상황이면, 떠넘기지 말고 그 부분을 web_search로 보강한다(최대 1회).\n` +
  `- 실행: 외부가 필요하다 판단되면 거절하거나 되묻지 말고 네가 직접 검색해 답에 반영한다.\n` +
  `- 출처 기준: 1차·공신력 출처만. 이용자 편집 위키·개인 블로그 금지(시스템 차단). 미검증 실명 주장 인용 금지.`;

async function main() {
  const role: Role = 'admin';   // insight/policy는 admin·tier1 전용
  const history: ChatTurn[] = [
    { role: 'user', content: '이석재 교수 정보 알려줘' },
    { role: 'assistant', content: '이석재는 서울대 이사회 내부이사로 재직(임기 2025.1.25 만료), 운영소위 위원 활동. ⚠️ 학과·전공·교수경력 등 학문적 이력은 내부 자료에 없어 외부 자료 확인이 필요합니다.' },
  ];
  const message = '외부 자료 확인해';

  // 1) 상위 라우터 — 의도 분류 + 맥락 해소
  const plan = await planQuery(message, history);
  const canInsight = role === 'admin' || role === 'tier1';
  const mode = plan.intent === 'insight' && canInsight ? 'policy' : 'normal';
  console.log(`\n[1] plan: intent=${plan.intent} mode=${mode} isFollowup=${plan.isFollowup}`);
  console.log(`    resolvedQuery="${plan.resolvedQuery}"`);

  // 2) 리트리버 — resolvedQuery로 검색
  const effectiveQuery = plan.resolvedQuery || message;
  const routing = await routeQuery(effectiveQuery, role, plan);
  console.log(`[2] routed wikis: ${routing.selectedAgentIds.join(', ') || '(none)'}`);

  // 3) 컨텍스트 예산 + 번호 인용
  const budgetChars = budgetForComplexity(plan.complexity);
  const budgeted = await enforceContextBudget(effectiveQuery, routing.contexts, budgetChars);
  const numbered = buildNumberedContexts(budgeted);

  // 4) policy 프롬프트 + web 도구 부착 스트림 (route.ts mode==='policy' 분기와 동일)
  const systemPrompt = buildPolicySystemPrompt(budgeted, role) + WEB_SEARCH_GUIDANCE_POLICY;
  const userMessage = buildUserMessage(message, numbered.contextMarkdown, numbered.summary);

  console.log(`[3] web_search 도구 ${mode === 'policy' ? '부착됨' : '미부착'} — 스트리밍 시작...\n`);
  const client = getAnthropicClient();
  const stream = client.messages.stream({
    model: LLM_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [...history, { role: 'user', content: userMessage }],
    ...(mode === 'policy' ? { tools: [WEB_SEARCH_TOOL_POLICY] as unknown as never } : {}),
  });

  let text = '';
  let webSearches = 0;
  const webUrls: string[] = [];
  for await (const chunk of stream) {
    if (chunk.type === 'message_delta') {
      const stu = (chunk.usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use;
      if (stu?.web_search_requests) webSearches = stu.web_search_requests;
    } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      text += chunk.delta.text;
    } else if (
      chunk.type === 'content_block_start' &&
      (chunk.content_block as { type?: string }).type === 'web_search_tool_result'
    ) {
      const wb = (chunk.content_block as { content?: Array<{ url?: string; title?: string }> }).content;
      if (Array.isArray(wb)) for (const r of wb) if (r?.url) webUrls.push(r.url);
    }
  }

  console.log('───── 답변 본문 ─────');
  console.log(text.trim().slice(0, 1200));
  console.log('\n───── 판정 ─────');
  console.log(`web_search 발동 횟수 : ${webSearches}`);
  console.log(`외부 출처 URL 수      : ${webUrls.length}`);
  if (webUrls.length) console.log(`상위 출처: ${[...new Set(webUrls)].slice(0, 5).join('\n          ')}`);
  const ok = mode === 'policy' && webSearches > 0;
  console.log(`\n${ok ? '✅ PASS — 후속질문이 policy로 라우팅되어 웹검색 실제 발동' : '🔴 FAIL — web=' + webSearches + ' mode=' + mode}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
