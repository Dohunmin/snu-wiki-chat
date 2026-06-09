/**
 * 인용 깊이 측정 — "답변이 실제로 쓴 source가 rerank 몇 위에 분포하나?"
 *   → 2.2(무관 청크 지우기)가 안전한지의 핵심 데이터. 인용 안 된 하위 순위 = 지워도 무손실.
 * 방법: 과거 실제 Q&A(messages.sources = 인용된 source)를 가져와, 그 질문을 재검색→rerank →
 *       인용된 source가 rerank 몇 위였는지 매핑. 실제 질문만(합성 X).
 * 비용: Voyage 재검색+rerank만 (질문당 ~$0.001, Sonnet 0). 무료티어 내.
 *   npx tsx --env-file=.env.local scripts/measure-citation-depth.ts
 */
import { sql } from '@vercel/postgres';
import { routeQuery } from '@/lib/agents/router';
import { rerankDocuments } from '@/lib/embed/voyage';

const SEP = '\n\n---\n\n';
const ROLE = 'admin' as const;
const SAMPLE = 50;

function pageIdOf(block: string): string | null {
  const m = block.match(/##\s+(?:\[[^\]]+\]\s+)?[^\n(]*?\(([^()\n]+)\)/);
  return m ? m[1].trim() : null;
}

type Cite = { wiki: string; page: string };

async function main() {
  // 1. 실제 Q&A 페어 — 인용 source 있는 assistant + 직전 user
  const rows = (await sql`
    SELECT conversation_id, role, content, sources, created_at
    FROM messages ORDER BY created_at DESC LIMIT 600
  `).rows as { conversation_id: string; role: string; content: string; sources: unknown; created_at: string }[];

  // 대화별 시간순 정렬 후 user→다음 assistant 페어
  const byConv = new Map<string, typeof rows>();
  for (const r of rows) { if (!byConv.has(r.conversation_id)) byConv.set(r.conversation_id, []); byConv.get(r.conversation_id)!.push(r); }
  const pairs: { q: string; cites: Cite[] }[] = [];
  for (const msgs of byConv.values()) {
    msgs.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
    for (let i = 0; i < msgs.length - 1; i++) {
      if (msgs[i].role === 'user' && msgs[i + 1].role === 'assistant') {
        const s = msgs[i + 1].sources;
        const cites = Array.isArray(s) ? (s as Cite[]).filter(c => c && c.wiki && c.page) : [];
        if (cites.length > 0) pairs.push({ q: msgs[i].content, cites });
      }
    }
  }
  const sample = pairs.slice(0, SAMPLE);
  console.log(`실제 Q&A ${pairs.length}개 중 ${sample.length}개 분석 (인용 source 있는 답변)\n`);

  const allRanks: number[] = [];      // 인용된 source들의 rerank 순위 (1-base)
  let notFound = 0, totalCites = 0;
  const perQMaxRank: number[] = [];
  let citeCountSum = 0;

  for (let i = 0; i < sample.length; i++) {
    const { q, cites } = sample[i];
    process.stdout.write(`\r  ${i + 1}/${sample.length}...`);
    let routing;
    try { routing = await routeQuery(q, ROLE); } catch { continue; }

    // 모든 블록 → (wiki, pageId)
    const blocks: { text: string; wiki: string; page: string | null }[] = [];
    for (const c of routing.contexts) {
      for (const t of c.relevantData.split(SEP)) {
        if (t.trim()) blocks.push({ text: t, wiki: c.agentName, page: pageIdOf(t) });
      }
    }
    if (blocks.length === 0) continue;

    // rerank → 순위
    let order: number[];
    try {
      const rr = await rerankDocuments(q, blocks.map(b => b.text.slice(0, 4000)));
      order = rr.map(r => r.index);
    } catch { order = blocks.map((_, j) => j); }

    // source(wiki|page) → 최상위 rerank 순위
    const bestRank = new Map<string, number>();
    order.forEach((blkIdx, rank) => {
      const b = blocks[blkIdx];
      if (!b.page) return;
      const key = `${b.wiki}|${b.page}`;
      if (!bestRank.has(key)) bestRank.set(key, rank + 1); // 1-base
    });

    citeCountSum += cites.length;
    let qMax = 0;
    for (const c of cites) {
      totalCites++;
      const rank = bestRank.get(`${c.wiki}|${c.page}`);
      if (rank === undefined) { notFound++; continue; }
      allRanks.push(rank);
      if (rank > qMax) qMax = rank;
    }
    if (qMax > 0) perQMaxRank.push(qMax);
  }
  process.stdout.write('\n\n');

  // 집계
  const pct = (n: number, d: number) => d === 0 ? '0%' : `${((n / d) * 100).toFixed(0)}%`;
  const within = (k: number) => allRanks.filter(r => r <= k).length;
  allRanks.sort((a, b) => a - b);

  console.log('━━━ 인용된(=실제 쓴) source의 rerank 순위 분포 ━━━');
  console.log(`  분석된 인용 총 ${totalCites}개 (rerank에서 찾음 ${allRanks.length}, 못찾음 ${notFound}=${pct(notFound, totalCites)})`);
  console.log(`  답변당 평균 인용 source: ${(citeCountSum / sample.length).toFixed(1)}개`);
  console.log('');
  for (const k of [3, 5, 8, 10, 15, 20]) {
    console.log(`  rerank top-${String(k).padStart(2)} 안에 든 인용: ${pct(within(k), allRanks.length)}  (${within(k)}/${allRanks.length})`);
  }
  console.log('');
  if (allRanks.length) {
    const med = allRanks[Math.floor(allRanks.length / 2)];
    const p90 = allRanks[Math.floor(allRanks.length * 0.9)];
    console.log(`  인용 순위: 중앙값 ${med}위 / 90퍼센타일 ${p90}위 / 최대 ${allRanks[allRanks.length - 1]}위`);
  }
  // 답변별 '가장 깊은 인용' — top-K로 자르면 몇 %의 답변이 인용 손실?
  console.log('\n━━━ top-K로 자르면 *인용 손실* 생기는 답변 비율 ━━━');
  for (const k of [5, 8, 10, 15]) {
    const lose = perQMaxRank.filter(m => m > k).length;
    console.log(`  top-${k} 컷: ${pct(lose, perQMaxRank.length)} 답변이 쓰던 source를 잃음 (${lose}/${perQMaxRank.length})`);
  }
  console.log('\n해석: top-K 컷에서 손실 답변 비율이 낮을수록 = 그 아래는 거의 안 쓰니 2.2(지우기) 안전.');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
