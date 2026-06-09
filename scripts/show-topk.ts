/**
 * top-K 실물 확인 — "지금 top-K가 어떤 형식인가"를 눈으로.
 *   [1] 후보 풀(cosine) → rerank 재순위 (야구부류 탈락 / 관련 끌어올림이 실제로 되나)
 *   [2] rerank 상위 청크의 *실제 원문 텍스트* (어떤 덩어리인지)
 *   [3] LLM이 최종으로 받는 *형식* (buildNumberedContexts — [N] + 헤더 라벨)
 * 비용: Voyage 임베딩+rerank만 ≈ $0.0005. 생성(Sonnet) 0.
 *   $env:RERANK_ENABLED='true'; $env:GLOBAL_TOPK_ENABLED='true'; npx tsx --env-file=.env.local scripts/show-topk.ts
 */
import { searchVectorGlobal } from '@/lib/embed/search';
import { rerankDocuments } from '@/lib/embed/voyage';
import { registry } from '@/lib/agents/registry';
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { buildNumberedContexts } from '@/lib/llm/citations';

const Q = '서울대 ai 대학원이 어떻게 구성되는데? 지금 있는 대학원들이 통합되는 방식이니?';
const ROLE = 'admin' as const;

async function main() {
  registry.init();
  const allowedWikiIds = registry.getAll().filter((a: any) => !a.config.lensPersona).map((a: any) => a.config.id);

  console.log('Q:', Q);

  // ── [1] 후보 풀(cosine 40개) → rerank 재순위 ──
  const vec: any[] = await searchVectorGlobal(Q, ROLE, 40, { allowedWikiIds });
  const titleOf = (v: any) => v.metadata?.title || v.pageId || v.page_id || '';
  const wikiOf = (v: any) => v.wikiId || v.wiki_id || v.wiki || '?';
  const typeOf = (v: any) => v.pageType || v.page_type || v.type || '?';
  const textOf = (v: any) => v.chunkText || v.chunk_text || v.chunk || '';

  console.log(`\n[1] 후보 ${vec.length}개 (cosine) → rerank 재순위 — cosine 상위 18`);
  console.log('  cos# | rerank#(Δ) | sim   | rerank | wiki        | type     | title');
  console.log('  ' + '-'.repeat(100));

  let rr: { index: number; relevanceScore: number }[] = [];
  try {
    const docs = vec.map(v => `${titleOf(v)}\n${textOf(v)}`.slice(0, 4000));
    rr = await rerankDocuments(Q, docs);
  } catch (e) {
    console.log('  (rerank 실패:', (e as Error).message, ')');
  }
  const rerankRankByIdx = new Map<number, number>();
  rr.forEach((r, i) => rerankRankByIdx.set(r.index, i));

  vec.slice(0, 18).forEach((v, cosRank) => {
    const rRank = rerankRankByIdx.get(cosRank) ?? 999;
    const rScore = rr.find(x => x.index === cosRank)?.relevanceScore ?? 0;
    const delta = cosRank - rRank;
    const arrow = delta > 0 ? `↑${delta}` : delta < 0 ? `↓${-delta}` : '·';
    console.log(
      `  ${String(cosRank + 1).padStart(4)} | ${String(rRank + 1).padStart(6)} ${arrow.padStart(5)} | ` +
      `${(v.similarity ?? 0).toFixed(3)} | ${rScore.toFixed(3)} | ${String(wikiOf(v)).padEnd(11)} | ${String(typeOf(v)).padEnd(8)} | ${titleOf(v).slice(0, 40)}`,
    );
  });

  // ── [2] rerank 상위 3개의 실제 원문 ──
  console.log('\n[2] rerank 상위 3개 — 실제 청크 원문 (이게 "top-K 한 조각"의 정체):');
  rr.slice(0, 3).forEach((r, i) => {
    const v = vec[r.index];
    console.log(`\n  ───── rerank#${i + 1}  [${wikiOf(v)}/${typeOf(v)}/${titleOf(v)}]  sim=${(v.similarity ?? 0).toFixed(3)} rerank=${r.relevanceScore.toFixed(3)} ─────`);
    console.log('  ' + textOf(v).replace(/\n/g, '\n  ').slice(0, 700));
  });

  // ── [3] LLM이 최종으로 받는 형식 ──
  const routing = await routeQuery(Q, ROLE);
  const ctxs = await enforceContextBudget(Q, routing.contexts, complexityBudget(Q));
  const numbered = buildNumberedContexts(ctxs);
  console.log('\n\n[3] LLM이 실제로 받는 형식 (buildNumberedContexts 앞 1800자):');
  console.log('  인용 매핑 요약:');
  console.log('  ' + numbered.summary.split('\n').slice(0, 8).join('\n  '));
  console.log('\n  본문 형식:');
  console.log('  ' + numbered.contextMarkdown.slice(0, 1800).replace(/\n/g, '\n  '));
  console.log(`\n  ... (총 ${numbered.contextMarkdown.length}자)`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
