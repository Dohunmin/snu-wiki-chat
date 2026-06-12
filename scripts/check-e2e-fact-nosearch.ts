/**
 * e2e (C안 대비 증명): 같은 인물(이석재)이라도 **내부 KB로 답되는 면**은 모델이 웹검색을 *안 한다*.
 *   - 이 스크립트: "이석재 이사회 활동 이력"(내부 board에 있음) → 웹 도구 부착돼 있어도 web 미발동이어야 PASS.
 *   - 짝: check-e2e-fact-web.ts("이석재 학력"=내부에 없음 → web 발동) — 이미 PASS.
 *   둘의 대비 = "도구 있어도 불필요하면 안 쓴다 = 진짜 판단".
 *   비용: Sonnet 1콜(웹 미발동 예상 → 웹페이지 토큰 없음) ~$0.05~0.10.
 */
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { buildSystemPromptParts, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';

const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305', name: 'web_search', max_uses: 1,
  blocked_domains: ['namu.wiki', 'm.namu.wiki', 'thewiki.kr', 'librewiki.net', 'blog.naver.com', 'm.blog.naver.com', 'tistory.com', 'brunch.co.kr', 'velog.io'],
};
const WEB_SEARCH_GUIDANCE_FACT = `\n\n[웹 검색 — 사실 보강(가드)]\n` +
  `- 우선순위: 내부 자료([N])로 핵심이 답되면 검색하지 않는다. 핵심 일부가 내부에 없을 때만 web_search로 보강(최대 1회).\n` +
  `- 외부 사실은 (외부)로 표시, 내부와 동급 권위로 단정 X. 실명 인물은 교차확인 안 되면 단정 X. 답변은 사실 보고 톤.`;

async function main() {
  const role: Role = 'admin';
  const message = '이석재 이사의 이사회 활동 이력(직위·임기·운영소위원회 참여)을 알려줘';   // 내부 board에 있음

  const routing = await routeQuery(message, role);
  const budgeted = await enforceContextBudget(message, routing.contexts, 16000);
  const numbered = buildNumberedContexts(budgeted);
  const parts = buildSystemPromptParts(budgeted, role);
  const systemPrompt = parts.stable + '\n' + parts.tail + WEB_SEARCH_GUIDANCE_FACT;   // 웹 도구 가이드 부착(admin fact)
  const userMessage = buildUserMessage(message, numbered.contextMarkdown, numbered.summary);
  console.log(`[1] routed: ${routing.selectedAgentIds.join(', ') || '(none)'} | 웹 도구 부착됨(admin fact) — 모델이 쓸지 말지 판단\n`);

  const stream = getAnthropicClient().messages.stream({
    model: LLM_MODEL, max_tokens: MAX_TOKENS, system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    tools: [WEB_SEARCH_TOOL] as unknown as never,
  });

  let text = '', webSearches = 0;
  for await (const chunk of stream) {
    if (chunk.type === 'message_delta') {
      const stu = (chunk.usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use;
      if (stu?.web_search_requests) webSearches = stu.web_search_requests;
    } else if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      text += chunk.delta.text;
    }
  }

  console.log('───── 답변 ─────');
  console.log(text.trim().slice(0, 800));
  console.log('\n───── 판정 ─────');
  console.log(`web_search 발동: ${webSearches}  (도구는 부착됨)`);
  const ok = webSearches === 0;
  console.log(`${ok ? '✅ PASS — 내부로 답되니 모델이 웹검색 안 함(불필요하면 안 쓴다 = 진짜 판단)' : '🔴 FAIL — 내부로 답되는데 불필요하게 검색함(web=' + webSearches + ')'}`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(2); });
