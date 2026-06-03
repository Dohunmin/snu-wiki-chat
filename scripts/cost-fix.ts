/**
 * 고친 설정(global OFF + rerank + 예산) 실제 비용 — true OLD(예산 무한) 대비.
 * 질문 길이별로도 쪼개 "절감이 어디서 오나" 확인. countTokens 무료 + rerank 소액.
 *   npx tsx --env-file=.env.local scripts/cost-fix.ts
 */
import fs from 'fs';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { buildSystemPrompt, buildUserMessage } from '@/lib/llm/prompts';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getAnthropicClient, LLM_MODEL } from '@/lib/llm/client';
import type { Role } from '@/lib/auth/roles';

process.env.RERANK_ENABLED = 'true';   // 고친 설정: rerank on, global off(미설정)
const ROLE: Role = 'admin';
const OUT = 1800, IN$ = 3 / 1e6, OUT$ = 15 / 1e6;
const all = JSON.parse(fs.readFileSync('scripts/gold-questions.json', 'utf-8')).filter((q: any) => !(q.mode || '').startsWith('lens:'));

async function cost(q: string, budget: number) {
  const routing = await routeQuery(q, ROLE);
  const ctxs = await enforceContextBudget(q, routing.contexts, budget);
  const numbered = buildNumberedContexts(ctxs);
  const system = buildSystemPrompt(ctxs, ROLE);
  const user = buildUserMessage(q, numbered.contextMarkdown, numbered.summary);
  const t = await getAnthropicClient().messages.countTokens({ model: LLM_MODEL, system, messages: [{ role: 'user', content: user }] });
  return t.input_tokens * IN$ + OUT * OUT$;
}

async function main() {
  const rows: { len: number; old: number; fix: number }[] = [];
  for (let i = 0; i < all.length; i++) {
    const q = all[i].question;
    const oldC = await cost(q, 999999);   // 예산 무한 = true OLD(per-wiki 통째)
    const fixC = await cost(q, 30000);    // 고친 설정
    rows.push({ len: q.length, old: oldC, fix: fixC });
    process.stdout.write(`\r  ${i + 1}/${all.length}`);
  }
  console.log('');
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)]; };
  const show = (label: string, rs: typeof rows) => {
    const o = rs.map(r => r.old), f = rs.map(r => r.fix);
    console.log(`${label} (n=${rs.length})`);
    console.log(`  OLD : avg $${avg(o).toFixed(3)} | p90 $${pct(o, .9).toFixed(3)} | max $${Math.max(...o).toFixed(3)}`);
    console.log(`  FIX : avg $${avg(f).toFixed(3)} | p90 $${pct(f, .9).toFixed(3)} | max $${Math.max(...f).toFixed(3)}`);
    console.log(`  절감: avg ${Math.round((1 - avg(f) / avg(o)) * 100)}% | max ${Math.round((1 - Math.max(...f) / Math.max(...o)) * 100)}%`);
  };
  show('전체', rows);
  console.log('');
  show('짧은 질문(≤80자)', rows.filter(r => r.len <= 80));
  console.log('');
  show('긴 질문(>120자, 종합형)', rows.filter(r => r.len > 120));
}
main().catch(e => { console.error(e); process.exit(1); });
