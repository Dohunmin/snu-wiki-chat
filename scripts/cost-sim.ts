/**
 * 비용 시뮬 — NEW(global) 61질문의 실측 토큰에 "하드 컨텍스트 예산"을 씌워
 * 각 예산에서 쿼리당 비용 분포(avg/p90/p99/max) + ≤$0.15 비율을 계산. 과금 0(countTokens 무료 + 순수산술).
 *
 * 목적: $0.15 목표를 어떤 예산·모델티어 조합이 *신뢰성 있게*(p99까지) 달성하는지 증명.
 *   npx tsx --env-file=.env.local scripts/cost-sim.ts
 */
import fs from 'fs';
import { routeQuery } from '@/lib/agents/router';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';

const ROLE: Role = 'admin';
const OUT_TOK = 1800;
const PRICE = { sonnet: { in: 3 / 1e6, out: 15 / 1e6 }, haiku: { in: 1 / 1e6, out: 5 / 1e6 } };
const all = JSON.parse(fs.readFileSync('scripts/gold-questions.json', 'utf-8')).filter((q: any) => !(q.mode || '').startsWith('lens:'));

async function main() {
  process.env.GLOBAL_TOPK_ENABLED = 'true';
  const client = getAnthropicClient();
  const rows: { overhead: number; ctxTok: number }[] = [];
  console.log(`NEW(global) ${all.length}질문 실측 중...`);
  for (let i = 0; i < all.length; i++) {
    const routing = await routeQuery(all[i].question, ROLE);
    const numbered = buildNumberedContexts(routing.contexts);
    const system = buildSystemPrompt(routing.contexts, ROLE);
    const userMessage = buildUserMessage(all[i].question, numbered.contextMarkdown, numbered.summary);
    const full = (await client.messages.countTokens({ model: LLM_MODEL, system, messages: [{ role: 'user', content: userMessage }] })).input_tokens;
    const ctx = (await client.messages.countTokens({ model: LLM_MODEL, messages: [{ role: 'user', content: numbered.contextMarkdown }] })).input_tokens;
    rows.push({ overhead: full - ctx, ctxTok: ctx });
    process.stdout.write(`\r  ${i + 1}/${all.length}`);
  }
  console.log('');

  const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

  function sim(budgetTok: number, tier: 'sonnet' | 'haiku' | 'mixed') {
    const costs = rows.map(r => {
      const ctx = Math.min(r.ctxTok, budgetTok);
      const inTok = r.overhead + ctx;
      // mixed: 컨텍스트가 작아 단순(factoid)로 추정되는 질문(<=budget의 절반)은 Haiku, 나머지 Sonnet
      const p = tier === 'mixed' ? (ctx <= budgetTok * 0.6 ? PRICE.haiku : PRICE.sonnet) : PRICE[tier];
      return inTok * p.in + OUT_TOK * p.out;
    });
    const under = costs.filter(c => c <= 0.15).length;
    return { avg: avg(costs), p90: pct(costs, .9), p99: pct(costs, .99), max: Math.max(...costs), underPct: Math.round(under / costs.length * 100) };
  }

  console.log(`\n실측 baseline: 컨텍스트토큰 avg ${Math.round(avg(rows.map(r => r.ctxTok))).toLocaleString()} | overhead(시스템+인용맵+질문) avg ${Math.round(avg(rows.map(r => r.overhead))).toLocaleString()}`);
  console.log(`(대화이력 미포함 — 단일턴 floor. 멀티턴은 이력 캡/캐시로 별도 관리)\n`);
  console.log('하드 예산 × 모델티어별 쿼리당 비용 (출력 1800tok 가정):');
  console.log('예산(ctx토큰) | 티어    | avg     | p90     | p99     | max     | ≤$0.15 비율');
  console.log('-------------|---------|---------|---------|---------|---------|----------');
  for (const b of [6000, 8000, 10000, 12000, 16000]) {
    for (const tier of ['sonnet', 'mixed'] as const) {
      const s = sim(b, tier);
      console.log(`${String(b).padStart(12)} | ${tier.padEnd(7)} | $${s.avg.toFixed(3)} | $${s.p90.toFixed(3)} | $${s.p99.toFixed(3)} | $${s.max.toFixed(3)} | ${s.underPct}%`);
    }
  }
  console.log('\nmixed = 컨텍스트가 작은(예산 60% 이하) 단순질문은 Haiku, 나머지 Sonnet.');
}
main().catch(e => { console.error(e); process.exit(1); });
