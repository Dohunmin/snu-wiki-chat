/**
 * 스폿체크 — 실제 시트 finance/숫자형 질문 2개를 OLD(per-wiki) vs NEW(global+A+B)로
 * 실제 생성해 정보 소실을 눈으로 비교. (합성 질문 금지 — gold-questions.json 실제 질문)
 *
 * 실행: GLOBAL 토글은 스크립트가 내부에서 routeQuery 직전에 env로 제어.
 *   npx tsx --env-file=.env.local scripts/spot-check.ts
 */
import { routeQuery } from '@/lib/agents/router';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';

const QUESTIONS = [
  '서울대의 최근 5년간 재정 구조는 어떻게 변화했으며, 국고지원금·발전기금·산학협력수익의 비중은 어떻게 되나요?',
  '법인화 이후 서울대 재정 구조가 어떻게 변했나? 등록금 동결 기간 재원 구성 변화를 알려줘',
];
const ROLE: Role = 'admin'; // 권한 필터 고정 → diff는 순수 retrieval 차이만

async function generate(q: string, useGlobal: boolean) {
  if (useGlobal) process.env.GLOBAL_TOPK_ENABLED = 'true';
  else delete process.env.GLOBAL_TOPK_ENABLED;
  const routing = await routeQuery(q, ROLE);
  const numbered = buildNumberedContexts(routing.contexts);
  const system = buildSystemPrompt(routing.contexts, ROLE);
  const userMessage = buildUserMessage(q, numbered.contextMarkdown, numbered.summary);
  const client = getAnthropicClient();
  const resp = await client.messages.create({
    model: LLM_MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: userMessage }],
  });
  const text = resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
  return { wikis: routing.selectedAgentIds, ctxChars: numbered.contextMarkdown.length, sources: numbered.mapping.size, text, usage: resp.usage };
}

async function main() {
  let totIn = 0, totOut = 0;
  for (const q of QUESTIONS) {
    console.log('\n' + '█'.repeat(92));
    console.log('질문: ' + q);
    console.log('█'.repeat(92));
    for (const useGlobal of [false, true]) {
      const label = useGlobal ? '🟢 NEW (global top-K + A+B, finalK=16)' : '⚪ OLD (per-wiki dump)';
      const r = await generate(q, useGlobal);
      totIn += r.usage.input_tokens; totOut += r.usage.output_tokens;
      console.log('\n' + label);
      console.log(`  위키(${r.wikis.length}): ${r.wikis.join(', ')}`);
      console.log(`  컨텍스트 ${r.ctxChars.toLocaleString()}자 | 출처 ${r.sources}개 | 입력 ${r.usage.input_tokens}tok / 출력 ${r.usage.output_tokens}tok`);
      console.log('  ── 답변 ──');
      console.log(r.text.split('\n').map(l => '  ' + l).join('\n'));
    }
  }
  const cost = totIn / 1e6 * 3 + totOut / 1e6 * 15;
  console.log('\n' + '='.repeat(92));
  console.log(`💰 Sonnet 토큰 합: 입력 ${totIn.toLocaleString()} / 출력 ${totOut.toLocaleString()} → ~$${cost.toFixed(3)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
