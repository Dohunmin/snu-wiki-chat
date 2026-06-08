/**
 * blocked_domains 런타임 수용 확인 — web_search 도구 스키마를 API가 받는지 1콜로 검증.
 *   trivial 질의(웹 미발동) → 비용 ~$0.005. API가 도구를 거부하면 400 throw → ❌.
 *   npx tsx --env-file=.env.local scripts/check-blocked-domains.ts
 */
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';

const TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 1,
  blocked_domains: [
    'namu.wiki', 'm.namu.wiki', 'thewiki.kr', 'librewiki.net',
    'blog.naver.com', 'm.blog.naver.com', 'tistory.com', 'brunch.co.kr', 'velog.io',
  ],
};

async function main() {
  try {
    const resp = await getAnthropicClient().messages.create({
      model: LLM_MODEL,
      max_tokens: 30,
      system: '한 단어로만 답하세요. 웹 검색 불필요.',
      messages: [{ role: 'user', content: '"안녕"이라고만 답해줘.' }],
      tools: [TOOL] as unknown as never,
    });
    const u = resp.usage as { input_tokens?: number; output_tokens?: number; server_tool_use?: { web_search_requests?: number } };
    console.log('✅ API가 blocked_domains 스키마 수용 — insight 웹 도구 정상 작동');
    console.log(`   usage: in ${u.input_tokens} / out ${u.output_tokens} / web ${u.server_tool_use?.web_search_requests ?? 0}`);
    const text = resp.content.find((b): b is { type: 'text'; text: string } => b.type === 'text')?.text ?? '';
    console.log(`   응답: ${text.slice(0, 40)}`);
  } catch (e) {
    console.log('❌ 실패 — blocked_domains 무효 가능. insight 채팅 깨질 위험:');
    console.log('  ', (e as Error).message);
    process.exit(1);
  }
}
main().then(() => process.exit(0));
