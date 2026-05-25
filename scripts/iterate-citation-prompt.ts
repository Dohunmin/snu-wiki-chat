/**
 * Citation prompt 로컬 iteration 도구.
 *
 * 흐름:
 *   1. 쿼리 라우팅
 *   2. buildNumberedContexts (현재 코드)
 *   3. buildSystemPrompt / buildUserMessage (현재 코드)
 *   4. Anthropic 직접 호출 (스트리밍 아님)
 *   5. 응답에서 [N] vs [위키] sid 패턴 카운트 + 샘플 출력
 *
 * 사용:
 *   npx tsx --env-file=.env.local scripts/iterate-citation-prompt.ts "2026년 주요 실행과제는?"
 *
 * 출력 보고 prompt 수정 → 다시 실행 → 통과까지 반복.
 */

import { routeQuery } from '@/lib/agents/router';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import {
  buildNumberedContexts,
  detectOldFormatCitations,
  extractCitedNumbers,
  resolveText,
} from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';

const QUERY = process.argv[2] || '2026년 주요 실행과제는?';

async function main() {
  console.log(`Query: "${QUERY}"\n`);

  const routing = await routeQuery(QUERY, 'admin');
  console.log(`라우팅: ${routing.selectedAgentIds.join(', ')}`);

  const numbered = buildNumberedContexts(routing.contexts);
  console.log(`매핑 source 수: ${numbered.mapping.size}`);
  console.log(`매핑 전체 dump:`);
  Array.from(numbered.mapping.entries()).forEach(([n, ref]) => {
    console.log(`  [${n}] wiki="${ref.wiki}" page="${ref.page}" topic="${ref.topic ?? ''}"`);
  });

  // routing.contexts.sources 원본 확인 (어디서 토픽이 source로 들어오나)
  console.log(`\nrouting.contexts.sources 원본:`);
  routing.contexts.forEach(ctx => {
    console.log(`  ${ctx.agentName}: ${ctx.sources.length}개`);
    ctx.sources.forEach(s => console.log(`    - wiki="${s.wiki}" page="${s.page}" topic="${s.topic ?? ''}"`));
  });

  const systemPrompt = buildSystemPrompt(routing.contexts, 'admin');
  const userMessage = buildUserMessage(QUERY, numbered.contextMarkdown, numbered.summary);

  console.log(`\n시스템 프롬프트 길이: ${systemPrompt.length} chars`);
  console.log(`사용자 메시지 길이: ${userMessage.length} chars`);

  console.log(`\nAnthropic 호출 중...`);
  const client = getAnthropicClient();
  const start = Date.now();
  const resp = await client.messages.create({
    model: LLM_MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`완료 (${elapsed}초)`);

  const raw = resp.content[0]?.type === 'text' ? resp.content[0].text : '';

  // 분석
  const numberedMatches = [...raw.matchAll(/\[(\d+)\]/g)];
  const oldFormat = detectOldFormatCitations(raw);
  const cited = extractCitedNumbers(raw);
  const validNumbers = [...cited].filter(n => numbered.mapping.has(n));
  const invalidNumbers = [...cited].filter(n => !numbered.mapping.has(n));

  console.log('\n' + '═'.repeat(80));
  console.log(' 결과 분석');
  console.log('═'.repeat(80));
  console.log(`[N] 형식 인용 (정답): ${numberedMatches.length}개`);
  console.log(`  - valid (mapping에 있음): ${validNumbers.length}개`);
  console.log(`  - invalid (범위 밖): ${invalidNumbers.length}개${invalidNumbers.length ? ` → [${invalidNumbers.join(', ')}]` : ''}`);
  console.log(`[위키] sid 형식 (위반): ${oldFormat.length}개`);

  if (oldFormat.length > 0) {
    console.log(`  샘플 (앞 10개):`);
    oldFormat.slice(0, 10).forEach(f => console.log(`    - "${f.raw}"`));
  }

  const totalCitations = numberedMatches.length + oldFormat.length;
  const compliance = totalCitations > 0 ? (numberedMatches.length / totalCitations * 100).toFixed(1) : 'N/A';
  console.log(`\nP2 준수율: ${compliance}% (목표: 100%)`);
  console.log(`판정: ${oldFormat.length === 0 ? '✅ PASS' : '❌ FAIL'}`);

  // 헤더 분석 (P6) — 답변의 ## 헤더에 사용자 질문 키워드 또는 시점 명시되어 있나
  console.log('\n' + '─'.repeat(80));
  console.log(' P6 헤더 framing 분석');
  console.log('─'.repeat(80));
  const headers = raw.match(/^##\s+.+$/gm) ?? [];
  console.log(`발견된 ## 헤더 ${headers.length}개:`);
  headers.forEach(h => console.log(`  ${h}`));

  // 답변 앞부분 출력
  console.log('\n' + '─'.repeat(80));
  console.log(' 답변 앞 1500자 (resolve 후)');
  console.log('─'.repeat(80));
  const resolved = resolveText(raw, numbered.mapping);
  console.log(resolved.slice(0, 1500));
  if (resolved.length > 1500) console.log(`... (총 ${resolved.length}자)`);
}

main().catch(err => { console.error(err); process.exit(1); });
