/**
 * 비용 해부 — 61개 실제 시트 질문의 *실제 입력 토큰*을 countTokens(무료)로 측정.
 * OLD(per-wiki 덤프) vs NEW(global top-K)로 비교 → $0.15 목표 설계의 ground truth.
 *
 * 합성 질문 금지(gold-questions.json 실제 질문). 생성 없음 = 과금 없음(countTokens는 무료).
 *   npx tsx --env-file=.env.local scripts/cost-anatomy.ts
 */
import fs from 'fs';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';

interface GoldQ { question: string; mode?: string }
const ROLE: Role = 'admin';
const IN_PRICE = 3 / 1e6;   // Sonnet 4.6 입력 $3/M
const OUT_PRICE = 15 / 1e6; // 출력 $15/M
const ASSUMED_OUT = 1800;   // 평균 출력 토큰 가정(스폿체크 실측 ~1.7k)

const all: GoldQ[] = JSON.parse(fs.readFileSync('scripts/gold-questions.json', 'utf-8'));
const questions = all.filter(q => !(q.mode || '').startsWith('lens:'));

async function measure(q: string, useGlobal: boolean) {
  if (useGlobal) process.env.GLOBAL_TOPK_ENABLED = 'true';
  else delete process.env.GLOBAL_TOPK_ENABLED;
  const routing = await routeQuery(q, ROLE);
  const ctxs = await enforceContextBudget(q, routing.contexts, Number(process.env.CONTEXT_BUDGET_CHARS ?? '14000'));
  const numbered = buildNumberedContexts(ctxs);
  const system = buildSystemPrompt(ctxs, ROLE);
  const userMessage = buildUserMessage(q, numbered.contextMarkdown, numbered.summary);
  const client = getAnthropicClient();
  const full = await client.messages.countTokens({ model: LLM_MODEL, system, messages: [{ role: 'user', content: userMessage }] });
  const ctxOnly = await client.messages.countTokens({ model: LLM_MODEL, messages: [{ role: 'user', content: numbered.contextMarkdown }] });
  return { wikis: routing.selectedAgentIds.length, ctxChars: numbered.contextMarkdown.length, inputTok: full.input_tokens, ctxTok: ctxOnly.input_tokens };
}

function pct(arr: number[], p: number) { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * p)]; }
function stat(label: string, rows: { inputTok: number; ctxTok: number; wikis: number; ctxChars: number }[]) {
  const inp = rows.map(r => r.inputTok), ctx = rows.map(r => r.ctxTok);
  const cost = rows.map(r => r.inputTok * IN_PRICE + ASSUMED_OUT * OUT_PRICE);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`\n=== ${label} ===`);
  console.log(`  입력토큰  avg ${Math.round(avg(inp)).toLocaleString()} | median ${pct(inp, .5).toLocaleString()} | p90 ${pct(inp, .9).toLocaleString()} | max ${Math.max(...inp).toLocaleString()}`);
  console.log(`  컨텍스트토큰 avg ${Math.round(avg(ctx)).toLocaleString()} (전체입력의 ${Math.round(avg(ctx) / avg(inp) * 100)}%)`);
  console.log(`  위키수 avg ${avg(rows.map(r => r.wikis)).toFixed(1)} | 컨텍스트 avg ${Math.round(avg(rows.map(r => r.ctxChars))).toLocaleString()}자`);
  console.log(`  💰 쿼리당(출력 ${ASSUMED_OUT}tok 가정)  avg $${avg(cost).toFixed(3)} | median $${pct(cost, .5).toFixed(3)} | p90 $${pct(cost, .9).toFixed(3)} | max $${Math.max(...cost).toFixed(3)}`);
}

async function main() {
  console.log(`실제 시트 ${questions.length}개, role=${ROLE}, countTokens(무료) 측정 중...`);
  const old_: any[] = [], neu: any[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i].question;
    old_.push(await measure(q, false));
    neu.push(await measure(q, true));
    process.stdout.write(`\r  ${i + 1}/${questions.length}`);
  }
  console.log('');
  stat('OLD (per-wiki 덤프)', old_);
  stat('NEW (global top-K, finalK=16)', neu);
  console.log('\n참고: 위 NEW엔 리랭커·구조화fetch 미적용. 대화이력(직전5교환)도 미포함(단일턴 floor).');
}
main().catch(e => { console.error(e); process.exit(1); });
