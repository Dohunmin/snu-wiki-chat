/**
 * 리랭커 진단 — 코사인 순위 vs rerank 순위를 실제 질문으로 나란히 비교.
 * "cosine이 묻은 관련 청크를 rerank가 끌어올리고, 높은-cosine-무관을 내리나"를 증명.
 * 합성 질문 금지(gold 실제 질문). 비용: 질문당 임베딩1+rerank1 ≈ $0.0003.
 *   npx tsx --env-file=.env.local scripts/rerank-diag.ts
 */
import fs from 'fs';
import { searchVectorGlobal } from '@/lib/embed/search';
import { rerankDocuments } from '@/lib/embed/voyage';
import { registry } from '@/lib/agents/registry';

const ROLE = 'admin' as const;
const all = JSON.parse(fs.readFileSync('scripts/gold-questions.json', 'utf-8')).filter((q: any) => !(q.mode || '').startsWith('lens:'));
// 재무·정형 질문 3개(벡터가 약한 영역) — 실제 시트에서
const PICKS = all.filter((q: any) => /재정|예산|등록금|출연금|발전기금|산학|비중|구조/.test(q.question)).slice(0, 3);

async function main() {
  registry.init();
  const allowedWikiIds = registry.getAll().filter((a: any) => !a.config.lensPersona).map((a: any) => a.config.id);

  for (const q of PICKS) {
    const query = q.question;
    console.log('\n' + '█'.repeat(96));
    console.log('Q: ' + query.slice(0, 90));
    console.log('█'.repeat(96));
    const vec = await searchVectorGlobal(query, ROLE, 30, { allowedWikiIds });
    if (vec.length === 0) { console.log('  (벡터 후보 없음)'); continue; }
    const titleOf = (v: any) => v.metadata?.title || v.pageId || '';
    const docs = vec.map(v => `${titleOf(v)}\n${v.chunkText}`.slice(0, 4000));
    const rr = await rerankDocuments(query, docs); // [{index, relevanceScore}] desc

    const rerankRankByIdx = new Map<number, number>();
    rr.forEach((r, i) => rerankRankByIdx.set(r.index, i));

    // cosine 상위 12개를 보여주되, 각자의 rerank 순위·점수 표시
    console.log('  cosine순위 | rerank순위(Δ) | sim    | rerank | title');
    console.log('  ' + '-'.repeat(90));
    let promoted = 0, demoted = 0;
    vec.slice(0, 12).forEach((v, cosRank) => {
      const rRank = rerankRankByIdx.get(cosRank) ?? 999;
      const rScore = rr.find(x => x.index === cosRank)?.relevanceScore ?? 0;
      const delta = cosRank - rRank; // +면 rerank가 끌어올림
      if (delta >= 3) promoted++; if (delta <= -3) demoted++;
      const arrow = delta > 0 ? `↑${delta}` : delta < 0 ? `↓${-delta}` : '·';
      console.log(`  ${String(cosRank + 1).padStart(9)} | ${String(rRank + 1).padStart(6)} ${arrow.padStart(5)} | ${(v.similarity ?? 0).toFixed(3)} | ${rScore.toFixed(3)} | ${titleOf(v).slice(0, 50)}`);
    });
    // rerank 상위 5가 cosine에서 어디 있었나(묻혔던 관련 청크 발굴)
    console.log('  ── rerank TOP5의 원래 cosine 순위 ──');
    rr.slice(0, 5).forEach((r, i) => {
      console.log(`  rerank#${i + 1} (점수 ${r.relevanceScore.toFixed(3)}) ← cosine #${r.index + 1} | ${titleOf(vec[r.index]).slice(0, 50)}`);
    });
    console.log(`  ▶ cosine상위12 중 rerank가 3계단+ 끌어올림 ${promoted} / 내림 ${demoted}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
