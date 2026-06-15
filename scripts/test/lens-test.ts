/**
 * Lens 모드 실측 하니스 — route.ts의 mode='lens:leesj' 분기를 충실 복제(단일 Sonnet 콜, 도구 없음).
 *   P1 리프레임 BEFORE/AFTER 대조용. 같은 retrieval/seed로 프롬프트만 바뀐 효과를 본다.
 *
 * ⚠️ 유료: 단일 콜 ~$0.05~0.1.
 * 실행: npx tsx --env-file=.env.local scripts/test/lens-test.ts ["질문"]
 */
import process from 'process';
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local'); } catch {}

import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { loadPersonaContext, personaToContext } from '@/lib/agents/lens';
import { buildNumberedContexts, resolveText, extractCitedNumbers } from '@/lib/llm/citations';
import { buildLensSystemPrompt, buildLensUserMessage } from '@/lib/llm/prompts';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';
import type Anthropic from '@anthropic-ai/sdk';

const IN_PER_M = 3, OUT_PER_M = 15;
const usd = (i: number, o: number) => i / 1e6 * IN_PER_M + o / 1e6 * OUT_PER_M;

async function main() {
  const query = process.argv[2] ||
    '서울대 대학원 현황 알려주고, 이석재 후보의 입장을 참고해서 대학원 발전 방향성을 크게 3가지로 알려줘';
  const role: Role = 'admin';
  console.log(`\n질문: "${query}"  (mode=lens:leesj, role=${role})\n${'='.repeat(70)}`);

  // route.ts lens 분기 복제 ──────────────────────────────────────────
  const routing = await routeQuery(query, role, undefined);
  const budgeted = await enforceContextBudget(query, routing.contexts, complexityBudget(query));
  const persona = await loadPersonaContext('leesj', query, role);
  if (!persona) { console.error('persona 로드 실패(admin 아님? leesj 없음?)'); process.exit(1); }
  console.log(`routed=${routing.selectedAgentIds.join('+') || '-'} | stance 매칭=${persona.stances.length}개 (insufficient=${persona.insufficient})`);
  console.log(`매칭 stance: ${persona.stances.map(s => `${s.topic}(${s.score.toFixed(2)})`).join(', ')}`);

  const numbered = buildNumberedContexts(budgeted);
  const stanceCtx = personaToContext(persona);
  const lensNumbered = stanceCtx ? buildNumberedContexts([...budgeted, stanceCtx]) : numbered;
  const system = buildLensSystemPrompt(budgeted, persona, role);
  const user = buildLensUserMessage(query, lensNumbered.contextMarkdown, lensNumbered.summary, persona);

  const resp = await getAnthropicClient().messages.create({
    model: LLM_MODEL, max_tokens: MAX_TOKENS, system,
    messages: [{ role: 'user', content: user }],   // lens = 내부 KB만, 도구 없음
  });
  const raw = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('');
  const answer = resolveText(raw, lensNumbered.mapping);
  const cited = [...extractCitedNumbers(raw)].sort((a, b) => a - b);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`비용 $${usd(resp.usage.input_tokens, resp.usage.output_tokens).toFixed(4)} (in=${resp.usage.input_tokens} out=${resp.usage.output_tokens}) | 인용 [N]=${cited.join(',') || '없음'}`);
  console.log(`${'='.repeat(70)}\n${answer.trim()}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
