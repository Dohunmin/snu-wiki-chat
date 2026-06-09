/** module-4 shadow — planQuery(Haiku 통합) vs 기존 라우터/정규식 필드별 일치율. 실제 질의로그만.
 *   intent 기준 = 기존 routeToAgent(검증된 ROUTER_SYSTEM), 나머지 4필드 기준 = 정규식(complexity/recency/college).
 *   안전: 기본 드라이런(표본·예상비용만, 무료). 실제 Haiku 호출은 --go 명시 시에만.
 *     npx tsx --env-file=.env.local scripts/shadow-intent.ts            # 드라이런
 *     npx tsx --env-file=.env.local scripts/shadow-intent.ts --go       # 실행(과금)
 *     ... --limit 30 --go                                               # 표본 축소
 */
import { sql } from '@vercel/postgres';
import { planQuery, routeToAgent, routerUsage, type CollegeGroupScope } from '@/lib/agents/agent-router';
import { classifyComplexity } from '@/lib/agents/complexity';
import { detectRecencyIntent } from '@/lib/agents/recency';
import { detectGroupBreadth, detectGroupAggregate } from '@/lib/agents/college-route';

const covers = (s: CollegeGroupScope, g: '단과대' | '대학원') => s === g || s === 'both';

async function getQuestions(limit?: number): Promise<string[]> {
  const r = await sql`
    SELECT DISTINCT trim(m.content) AS q
    FROM messages m
    WHERE m.role='user' AND m.mode='normal' AND length(trim(m.content)) > 0`;
  let qs = (r.rows as { q: string }[]).map(x => x.q);
  if (limit && limit > 0) qs = qs.slice(0, limit);
  return qs;
}

const FIELDS = ['intent', 'complexity', 'recency', 'breadth단과대', 'breadth대학원', 'agg단과대', 'agg대학원'] as const;
type Field = typeof FIELDS[number];

async function main() {
  const args = process.argv.slice(2);
  const go = args.includes('--go');
  const li = args.indexOf('--limit');
  const limit = li >= 0 ? Number(args[li + 1]) : undefined;

  const qs = await getQuestions(limit);
  const calls = qs.length * 2; // planQuery + routeToAgent
  console.log(`질문 ${qs.length}건 · Haiku 콜 ${calls}회(planQuery+routeToAgent) · 예상 ~$${(calls * 0.0015).toFixed(3)}`);
  if (!go) { console.log('▶ 드라이런 — 실제 실행은 --go'); process.exit(0); }

  const agree: Record<Field, number> = Object.fromEntries(FIELDS.map(f => [f, 0])) as Record<Field, number>;
  const disag: Record<Field, { q: string; plan: string; base: string }[]> =
    Object.fromEntries(FIELDS.map(f => [f, []])) as Record<Field, { q: string; plan: string; base: string }[]>;

  let i = 0;
  for (const q of qs) {
    const [p, old] = await Promise.all([planQuery(q), routeToAgent(q)]);
    const b = detectGroupBreadth(q);
    const a = detectGroupAggregate(q);
    const cmp: [Field, string, string][] = [
      ['intent', p.intent, old.agent],
      ['complexity', p.complexity, classifyComplexity(q)],
      ['recency', String(p.recency), String(detectRecencyIntent(q))],
      ['breadth단과대', String(covers(p.collegeBreadth, '단과대')), String(b['단과대'])],
      ['breadth대학원', String(covers(p.collegeBreadth, '대학원')), String(b['대학원'])],
      ['agg단과대', String(covers(p.collegeAggregate, '단과대')), String(a['단과대'])],
      ['agg대학원', String(covers(p.collegeAggregate, '대학원')), String(a['대학원'])],
    ];
    for (const [f, pv, bv] of cmp) {
      if (pv === bv) agree[f]++;
      else if (disag[f].length < 10) disag[f].push({ q, plan: pv, base: bv });
    }
    if (++i % 20 === 0) console.log(`  …${i}/${qs.length}`);
  }

  const n = qs.length;
  console.log(`\n══ 필드별 일치율 (n=${n}) ══`);
  for (const f of FIELDS) console.log(`  ${f.padEnd(14)} ${agree[f]}/${n} = ${Math.round((agree[f] / n) * 100)}%`);
  console.log('\n══ 불일치 표본 (plan vs base — 어느 쪽이 옳은지 수동 검수) ══');
  for (const f of FIELDS) {
    if (!disag[f].length) continue;
    console.log(`\n[${f}] ${disag[f].length}건`);
    for (const d of disag[f]) console.log(`  plan=${d.plan} base=${d.base}  «${d.q.slice(0, 64).replace(/\n/g, ' ')}»`);
  }
  // 실측 비용 (Haiku 4.5: input $1/MTok, output $5/MTok)
  const cost = (routerUsage.inputTokens / 1e6) * 1 + (routerUsage.outputTokens / 1e6) * 5;
  console.log(
    `\n💰 실비용: $${cost.toFixed(4)}  (Haiku 콜 ${routerUsage.calls} · ` +
    `in ${routerUsage.inputTokens.toLocaleString()} / out ${routerUsage.outputTokens.toLocaleString()} 토큰)`,
  );
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
