/** 비용 근본원인 진단 — 질문 1개의 실제 input/output 토큰을 API usage로 측정 */
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}
import { routeQuery } from '@/lib/agents/router';
import { buildNumberedContexts, resolveText } from '@/lib/llm/citations';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import { validateTables, buildTableFixPrompt } from '@/lib/llm/table-audit';
import type { Role } from '@/lib/auth/roles';

const textOf = (c: { type: string }[]) => c.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map(b => b.text).join('');
const IN = 3 / 1e6, OUT = 15 / 1e6;   // sonnet-4-6 단가
const cost = (u: { input_tokens: number; output_tokens: number }) => u.input_tokens * IN + u.output_tokens * OUT;

async function main() {
  const Q = '서울대학교 2026년 법인회계 세출 예산을 항목별로 나누고, 각 항목이 전체에서 차지하는 비중(%)을 표로 정리해줘.';
  const role = 'tier1' as Role;
  const routing = await routeQuery(Q, role);
  const numbered = buildNumberedContexts(routing.contexts);
  const system = buildSystemPrompt(routing.contexts, role);
  const user = buildUserMessage(Q, numbered.contextMarkdown, numbered.summary);

  console.log('라우팅 위키:', routing.selectedAgentIds.join(', '));
  console.log('컨텍스트 길이:', [...numbered.contextMarkdown].length, '자 / 시스템 프롬프트:', [...system].length, '자 / user 메시지:', [...user].length, '자');

  // 1차 생성
  const r1 = await getAnthropicClient().messages.create({ model: LLM_MODEL, max_tokens: MAX_TOKENS, system, messages: [{ role: 'user', content: user }] });
  const a1 = textOf(r1.content);
  console.log('\n── 1차 생성 ──');
  console.log(`  입력 ${r1.usage.input_tokens.toLocaleString()} tok / 출력 ${r1.usage.output_tokens.toLocaleString()} tok → $${cost(r1.usage).toFixed(4)}`);
  console.log(`  (입력 $${(r1.usage.input_tokens * IN).toFixed(4)} + 출력 $${(r1.usage.output_tokens * OUT).toFixed(4)})`);

  // 표 검산 → 교정 retry (경량)
  const issues = validateTables(resolveText(a1, numbered.mapping));
  let c2 = 0;
  console.log(`\n표 검산: ${issues.length}개 이슈${issues.length ? ' → 교정 retry' : ' (retry 없음)'}`);
  if (issues.length) {
    const r2 = await getAnthropicClient().messages.create({
      model: LLM_MODEL, max_tokens: MAX_TOKENS,
      system: '당신은 서울대학교 거버넌스 위키 어시스턴트입니다. 인용은 [N] 번호만 유지. 표 산수만 교정.',
      messages: [{ role: 'user', content: '직전 답변 검토.' }, { role: 'assistant', content: a1 }, { role: 'user', content: buildTableFixPrompt(issues) }],
    });
    c2 = cost(r2.usage);
    console.log('── 표 교정 retry (경량) ──');
    console.log(`  입력 ${r2.usage.input_tokens.toLocaleString()} tok / 출력 ${r2.usage.output_tokens.toLocaleString()} tok → $${c2.toFixed(4)}`);
  }
  console.log(`\n💰 이 질문 총비용: $${(cost(r1.usage) + c2).toFixed(4)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
