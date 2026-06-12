/**
 * e2e (C안): fact(normal) 모드 + admin에서 내부 KB에 없는 사실을 모델이 *직접* web_search로
 *   보강하는지 + 가드(외부 귀속표시·사실톤) 작동 확인. route.ts의 fact 분기 + WEB_SEARCH_GUIDANCE_FACT 재현.
 *   tier2는 webEnabled=false(웹 미부착)임을 구조로 확인(무료).
 *   비용: Sonnet 1콜 + web ~$0.15. 실행: npx tsx --env-file=.env.local scripts/check-e2e-fact-web.ts
 */
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { buildSystemPromptParts, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';

// route.ts 미러(테스트 전용)
const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305', name: 'web_search', max_uses: 1,
  blocked_domains: ['namu.wiki', 'm.namu.wiki', 'thewiki.kr', 'librewiki.net', 'blog.naver.com', 'm.blog.naver.com', 'tistory.com', 'brunch.co.kr', 'velog.io'],
};
const WEB_SEARCH_GUIDANCE_FACT = `\n\n[웹 검색 — 사실 보강(가드)]\n` +
  `- 우선순위: 내부 자료([N])로 핵심이 답되면 검색하지 않는다. 핵심 일부가 내부에 없을 때만 web_search로 보강(최대 1회). 되묻지 말고 직접 검색.\n` +
  `- 표기: 외부 사실은 (외부)로 표시하고 내부와 동급 권위로 단정 X(URL 자동첨부).\n` +
  `- 실명 인물: 복수 공신력 출처 교차확인 안 되면 단정 말고 "확인되지 않음". 동명이인 주의.\n` +
  `- 답변은 *사실 보고* 톤 유지(해석·평가 추가 X).`;

function webEnabledFor(mode: string, role: Role) {
  return mode === 'policy' || (mode === 'normal' && (role === 'admin' || role === 'tier1'));
}

async function main() {
  const role: Role = 'admin';
  const mode = 'normal';   // fact 분기 강제(새 경로 isolate)
  const message = '이석재 교수의 학력과 전공이 어떻게 되나요?';   // 내부 KB(이사회)엔 없는 사실

  console.log(`[구조] webEnabled: admin=${webEnabledFor('normal','admin')} tier1=${webEnabledFor('normal','tier1')} tier2=${webEnabledFor('normal','tier2')}  (tier2 fact는 웹 미도달이어야 함)`);

  const routing = await routeQuery(message, role);
  const budgeted = await enforceContextBudget(message, routing.contexts, 16000);
  const numbered = buildNumberedContexts(budgeted);
  const parts = buildSystemPromptParts(budgeted, role);
  const systemPrompt = parts.stable + '\n' + parts.tail + (webEnabledFor(mode, role) ? WEB_SEARCH_GUIDANCE_FACT : '');
  const userMessage = buildUserMessage(message, numbered.contextMarkdown, numbered.summary);
  console.log(`[1] routed: ${routing.selectedAgentIds.join(', ') || '(none)'} | web 도구 ${webEnabledFor(mode, role) ? '부착(fact+admin)' : '미부착'}\n`);

  const stream = getAnthropicClient().messages.stream({
    model: LLM_MODEL, max_tokens: MAX_TOKENS, system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    ...(webEnabledFor(mode, role) ? { tools: [WEB_SEARCH_TOOL] as unknown as never } : {}),
  });

  let text = '', webSearches = 0; const urls: string[] = [];
  for await (const chunk of stream) {
    if (chunk.type === 'message_delta') {
      const stu = (chunk.usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use;
      if (stu?.web_search_requests) webSearches = stu.web_search_requests;
    } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      text += chunk.delta.text;
    } else if (chunk.type === 'content_block_start' && (chunk.content_block as { type?: string }).type === 'web_search_tool_result') {
      const wb = (chunk.content_block as { content?: Array<{ url?: string }> }).content;
      if (Array.isArray(wb)) for (const r of wb) if (r?.url) urls.push(r.url);
    }
  }

  console.log('───── 답변 ─────');
  console.log(text.trim().slice(0, 1100));
  console.log('\n───── 판정 ─────');
  console.log(`web_search 발동: ${webSearches} | 외부 URL: ${urls.length} | (외부) 귀속표기: ${/\(외부\)|외부 출처|외부 자료/.test(text) ? '있음' : '없음'}`);
  const ok = webSearches > 0;
  console.log(`${ok ? '✅ PASS — fact 모드에서 모델이 자기판단으로 외부 검색(C안 작동)' : '🔴 FAIL — fact에서 web 미발동(web=' + webSearches + ')'}`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
