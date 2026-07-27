/**
 * 라우팅-utilization eval 하네스 — 로드맵 0b (진짜 ship gate).
 *
 *   각 gold 쿼리를 실제 retrieve 파이프라인에 태운다:
 *     routeQuery(q, role)  →  [+getBackgroundContexts (opt)]  →  enforceContextBudget(q, ctxs, complexityBudget(q))  →  buildNumberedContexts
 *   그리고 "라우터가 올바른 위키/청크를 LLM 컨텍스트에 실제로 올렸는가"를 측정한다.
 *   GLOBAL_TOPK_ENABLED·RERANK_ENABLED는 per-call로 읽히므로(정찰 검증) 한 프로세스에서 legacy vs global을 A/B 한다.
 *
 *   test:governance(19/19)는 정적 grep이라 라우팅 '행동'을 검증 못 함 → 이 하네스가 그 공백을 메운다.
 *
 * 채점 (gold: scripts/routing-gold.json):
 *   dispatchHit  : gold 위키 전부가 routeQuery.selectedAgentIds(=contexts[].agentId)에 있나  (라우터가 올렸나)
 *   dispatchRecall: |gold ∩ dispatched| / |gold|
 *   finalWikiHit : gold 위키 전부가 budget 통과 후에도 남아있나  (LLM까지 갔나)
 *   textHit      : (chunk-labeled) gold 청크힌트 문자열이 최종 contextMarkdown에 있나  (정답 청크 본문이 LLM에 닿았나)
 *   truncLoss    : finalWikiHit && !textHit  (위키는 올렸는데 청크가 잘려 나감 — 거대청크 granularity 신호)
 *   webFallbackRisk: scorable인데 !dispatchHit  (정답위키 탈락 → web_search/gap 유출 — starvation 핵심 지표)
 *   abstention 라벨(gold=[])은 집계 제외, dispatched만 진단 출력.
 *
 * 실행:  npx tsx --env-file=.env.local scripts/eval-routing.ts [--path legacy|global|both] [--no-rerank] [--limit N] [--with-background] [--role admin|tier1]
 *   출력:  scripts/eval-routing.out.md (사람용 표) + scripts/eval-routing.results.json (머신 diff/baseline)
 *
 * ⚠ 유료 API: Voyage embed(쿼리·경로당 1~2회) + 기본 context-budget rerank(voyage /rerank). --no-rerank로 rerank 전면 차단(RERANK_ENABLED=false).
 *   라이브 pgvector(chunk_embeddings)도 읽음. 비용은 실행 전 콘솔에 추산 출력.
 */
import fs from 'fs';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { getBackgroundContexts } from '@/lib/agents/background';
import type { Role } from '@/lib/auth/roles';

// ── gold 스키마 ────────────────────────────────────────────────────────────
interface GoldLabel {
  id: string;
  query: string;
  category: string;
  kind: 'chunk-labeled' | 'wiki-labeled' | 'abstention';
  goldWikis: string[];
  goldChunkHint: string | null;
  truncationRisk?: string;
  note?: string;
}
type PathName = 'legacy' | 'global';

// ── 인자 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getArg = (flag: string, def?: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const PATHS: PathName[] = (() => {
  const p = getArg('--path', 'both');
  if (p === 'legacy') return ['legacy'];
  if (p === 'global') return ['global'];
  return ['legacy', 'global'];
})();
const NO_RERANK = argv.includes('--no-rerank');
const WITH_BG = argv.includes('--with-background');
const LIMIT = Number(getArg('--limit', '0')) || 0;
const ROLE = (getArg('--role', 'admin') as Role);
const GOLD_PATH = getArg('--gold', 'scripts/routing-gold.json')!;

// ── per-call 환경 토글 (정찰: 전부 함수 바디에서 per-call read) ────────────────
if (NO_RERANK) process.env.RERANK_ENABLED = 'false'; // 두 rerank 단계 모두 OFF
function setPath(p: PathName) {
  if (p === 'global') process.env.GLOBAL_TOPK_ENABLED = 'true';
  else delete process.env.GLOBAL_TOPK_ENABLED; // legacy = 미설정
}

// ── 결과 타입 ──────────────────────────────────────────────────────────────
interface RunResult {
  dispatched: string[];
  finalWikis: string[];
  dispatchHit: boolean | null;       // null = abstention
  dispatchRecall: number | null;
  finalWikiHit: boolean | null;
  textHit: boolean | null;           // null = chunk-labeled 아님
  truncLoss: boolean;
  dispatchedCount: number;
  error?: string;
}

async function runOne(g: GoldLabel, p: PathName): Promise<RunResult> {
  setPath(p);
  try {
    const routing = await routeQuery(g.query, ROLE);
    const dispatched = [...new Set(routing.contexts.map((c) => c.agentId))].sort();

    let ctxs = routing.contexts;
    if (WITH_BG) {
      const bg = await getBackgroundContexts(g.query, ROLE);
      if (bg.length) ctxs = [...ctxs, ...bg];
    }
    const budgeted = await enforceContextBudget(g.query, ctxs, complexityBudget(g.query));
    const finalWikis = [...new Set(budgeted.map((c) => c.agentId))].sort();
    const finalMd = buildNumberedContexts(budgeted).contextMarkdown;

    const gold = g.goldWikis;
    const scorable = gold.length > 0;
    const dispatchHit = scorable ? gold.every((w) => dispatched.includes(w)) : null;
    const dispatchRecall = scorable ? gold.filter((w) => dispatched.includes(w)).length / gold.length : null;
    const finalWikiHit = scorable ? gold.every((w) => finalWikis.includes(w)) : null;
    const textHit = g.goldChunkHint ? finalMd.includes(g.goldChunkHint) : null;
    const truncLoss = !!(finalWikiHit && textHit === false);

    return { dispatched, finalWikis, dispatchHit, dispatchRecall, finalWikiHit, textHit, truncLoss, dispatchedCount: dispatched.length };
  } catch (e: unknown) {
    return {
      dispatched: [], finalWikis: [], dispatchHit: null, dispatchRecall: null, finalWikiHit: null,
      textHit: null, truncLoss: false, dispatchedCount: 0, error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── 집계 ──────────────────────────────────────────────────────────────────
interface Agg {
  n: number; dispatchHit: number; finalWikiHit: number; recallSum: number;
  chunkN: number; textHit: number; truncLoss: number; dispatchedCountSum: number; webFallbackRisk: number; errors: number;
}
const emptyAgg = (): Agg => ({ n: 0, dispatchHit: 0, finalWikiHit: 0, recallSum: 0, chunkN: 0, textHit: 0, truncLoss: 0, dispatchedCountSum: 0, webFallbackRisk: 0, errors: 0 });
function fold(a: Agg, r: RunResult, g: GoldLabel) {
  if (r.error) a.errors++;
  if (g.goldWikis.length === 0) return; // abstention 제외
  a.n++;
  if (r.dispatchHit) a.dispatchHit++; else a.webFallbackRisk++;
  if (r.finalWikiHit) a.finalWikiHit++;
  a.recallSum += r.dispatchRecall ?? 0;
  a.dispatchedCountSum += r.dispatchedCount;
  if (g.kind === 'chunk-labeled' && g.goldChunkHint) {
    a.chunkN++;
    if (r.textHit) a.textHit++;
    if (r.truncLoss) a.truncLoss++;
  }
}
const pct = (num: number, den: number) => (den === 0 ? '—' : `${((100 * num) / den).toFixed(0)}%`);
const avg = (sum: number, den: number) => (den === 0 ? '—' : (sum / den).toFixed(2));

// ── 메인 ──────────────────────────────────────────────────────────────────
async function main() {
  const goldPath = GOLD_PATH;
  const gold: GoldLabel[] = JSON.parse(fs.readFileSync(goldPath, 'utf-8')).labels;
  const labels = LIMIT ? gold.slice(0, LIMIT) : gold;
  const scorableN = labels.filter((g) => g.goldWikis.length > 0).length;
  const chunkN = labels.filter((g) => g.kind === 'chunk-labeled' && g.goldChunkHint).length;

  console.log('═'.repeat(80));
  console.log(`라우팅 eval — ${labels.length} 쿼리 (scorable ${scorableN}, chunk-labeled ${chunkN}), role=${ROLE}`);
  console.log(`경로: ${PATHS.join(' + ')} | rerank: ${NO_RERANK ? 'OFF(무료 rerank)' : 'ON(context-budget, 유료)'} | background: ${WITH_BG ? 'ON' : 'OFF'}`);
  const embedCalls = labels.length * PATHS.length * (WITH_BG ? 2 : 1);
  const rerankCalls = NO_RERANK ? 0 : labels.length * PATHS.length;
  console.log(`추산 유료호출: Voyage embed ~${embedCalls}회(쿼리 임베딩, ≈무료티어 내) + rerank ~${rerankCalls}회(각 ≤60문서). 라이브 pgvector 읽기.`);
  console.log('═'.repeat(80));

  const perQuery: Record<string, Partial<Record<PathName, RunResult>>> = {};
  const aggAll: Record<PathName, Agg> = { legacy: emptyAgg(), global: emptyAgg() };
  const aggCat: Record<PathName, Record<string, Agg>> = { legacy: {}, global: {} };

  for (const g of labels) {
    perQuery[g.id] = {};
    for (const p of PATHS) {
      const r = await runOne(g, p);
      perQuery[g.id][p] = r;
      fold(aggAll[p], r, g);
      (aggCat[p][g.category] ??= emptyAgg());
      fold(aggCat[p][g.category], r, g);
      const flag = r.error ? '⚠ERR' : g.goldWikis.length === 0 ? '·probe' : r.dispatchHit ? (r.textHit === false ? '~trunc' : '✓') : '✗MISS';
      console.log(`[${p.padEnd(6)}] ${g.id.padEnd(30)} disp=${(r.dispatchHit ?? 'n/a').toString().padEnd(5)} final=${(r.finalWikiHit ?? 'n/a').toString().padEnd(5)} text=${String(r.textHit).padEnd(5)} #${r.dispatchedCount} ${flag}`);
    }
  }

  // ── 리포트 ────────────────────────────────────────────────────────────────
  const out: string[] = [];
  out.push(`# 라우팅-utilization eval 결과\n`);
  out.push(`> ${labels.length} 쿼리 (scorable ${scorableN} · chunk-labeled ${chunkN}) · role=${ROLE} · rerank ${NO_RERANK ? 'OFF' : 'ON'} · background ${WITH_BG ? 'ON' : 'OFF'}\n`);
  out.push(`> 경로: ${PATHS.join(' vs ')}. dispatchHit=라우터가 gold위키 전부 올림 · finalWikiHit=budget 후 생존 · textHit=gold청크힌트가 LLM 컨텍스트에 존재 · webFallbackRisk=gold위키 탈락(=web유출).\n`);

  // 종합 요약
  out.push(`\n## 종합 (scorable ${scorableN})\n`);
  out.push(`| 지표 | ${PATHS.map((p) => p).join(' | ')} |`);
  out.push(`|---|${PATHS.map(() => '---:').join('|')}|`);
  const rowsSpec: [string, (a: Agg) => string][] = [
    ['dispatchHit (정답위키 전부 올림)', (a) => pct(a.dispatchHit, a.n)],
    ['dispatchRecall (평균)', (a) => avg(a.recallSum, a.n)],
    ['finalWikiHit (budget 생존)', (a) => pct(a.finalWikiHit, a.n)],
    ['textHit (청크 본문 도달, chunk-labeled)', (a) => pct(a.textHit, a.chunkN)],
    ['truncLoss (위키↑ 청크↓ 잘림손실)', (a) => `${a.truncLoss}/${a.chunkN}`],
    ['webFallbackRisk (정답위키 탈락)', (a) => `${a.webFallbackRisk}/${a.n}`],
    ['평균 dispatch 위키수', (a) => avg(a.dispatchedCountSum, a.n)],
    ['에러', (a) => `${a.errors}`],
  ];
  for (const [label, f] of rowsSpec) out.push(`| ${label} | ${PATHS.map((p) => f(aggAll[p])).join(' | ')} |`);

  // 카테고리별
  out.push(`\n## 카테고리별 dispatchHit / textHit\n`);
  const cats = [...new Set(labels.filter((g) => g.goldWikis.length > 0).map((g) => g.category))];
  out.push(`| 카테고리 | n | ${PATHS.map((p) => `${p} dispatchHit`).join(' | ')} | ${PATHS.map((p) => `${p} textHit`).join(' | ')} |`);
  out.push(`|---|---:|${PATHS.map(() => '---:').join('|')}|${PATHS.map(() => '---:').join('|')}|`);
  for (const c of cats) {
    const n = aggCat[PATHS[0]][c]?.n ?? 0;
    const dh = PATHS.map((p) => pct(aggCat[p][c]?.dispatchHit ?? 0, aggCat[p][c]?.n ?? 0));
    const th = PATHS.map((p) => pct(aggCat[p][c]?.textHit ?? 0, aggCat[p][c]?.chunkN ?? 0));
    out.push(`| ${c} | ${n} | ${dh.join(' | ')} | ${th.join(' | ')} |`);
  }

  // 쿼리별 상세
  out.push(`\n## 쿼리별 상세\n`);
  out.push(`| id | cat | gold위키 | ${PATHS.map((p) => `${p}: disp/final/text/#`).join(' | ')} | 힌트 |`);
  out.push(`|---|---|---|${PATHS.map(() => '---').join('|')}|---|`);
  const mark = (b: boolean | null) => (b === null ? '·' : b ? '✓' : '✗');
  for (const g of labels) {
    const cells = PATHS.map((p) => {
      const r = perQuery[g.id][p]!;
      if (r.error) return `⚠ERR`;
      return `${mark(r.dispatchHit)}/${mark(r.finalWikiHit)}/${mark(r.textHit)}/${r.dispatchedCount}`;
    });
    out.push(`| ${g.id} | ${g.category} | ${g.goldWikis.join(',') || '(abstain)'} | ${cells.join(' | ')} | ${g.goldChunkHint ?? ''} |`);
  }

  // 미스 상세 (진단)
  out.push(`\n## 미스·probe 상세\n`);
  for (const g of labels) {
    for (const p of PATHS) {
      const r = perQuery[g.id][p]!;
      const isMiss = g.goldWikis.length > 0 && (r.dispatchHit === false || r.truncLoss);
      const isProbe = g.goldWikis.length === 0;
      if (isMiss || isProbe || r.error) {
        const tag = r.error ? 'ERR' : isProbe ? 'PROBE' : r.dispatchHit === false ? 'MISS' : 'TRUNC';
        out.push(`- **[${p}] ${g.id}** (${tag}): gold=[${g.goldWikis.join(',') || '없음'}] → dispatched=[${r.dispatched.join(',')}]${r.error ? ` err=${r.error}` : ''}`);
      }
    }
  }

  const tag = GOLD_PATH.includes('routing-gold.json') ? '' : '-' + (GOLD_PATH.split('/').pop() || '').replace(/\.json$/, '').replace(/^routing-gold-?/, '');
  const outPath = `scripts/eval-routing${tag}.out.md`;
  fs.writeFileSync(outPath, out.join('\n'), 'utf-8');

  const resultsPath = `scripts/eval-routing${tag}.results.json`;
  fs.writeFileSync(resultsPath, JSON.stringify({
    meta: { at: null, paths: PATHS, role: ROLE, noRerank: NO_RERANK, withBackground: WITH_BG, scorableN, chunkN },
    aggregate: aggAll, byCategory: aggCat, perQuery,
  }, null, 2), 'utf-8');

  // 콘솔 종합
  console.log('═'.repeat(80));
  for (const p of PATHS) {
    const a = aggAll[p];
    console.log(`[${p}] dispatchHit ${pct(a.dispatchHit, a.n)} · recall ${avg(a.recallSum, a.n)} · finalWiki ${pct(a.finalWikiHit, a.n)} · textHit ${pct(a.textHit, a.chunkN)} · webFallbackRisk ${a.webFallbackRisk}/${a.n} · trunc ${a.truncLoss}/${a.chunkN} · err ${a.errors}`);
  }
  console.log(`→ ${outPath}`);
  console.log(`→ ${resultsPath}`);
  console.log('═'.repeat(80));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
