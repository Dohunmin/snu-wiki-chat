/** live_cache(Tier4 뉴스/공지) 현재 상태·신선도 점검. 실행: npx tsx --env-file=.env.local scripts/diag/news-state.ts */
import { db } from '@/lib/db/client';
import { liveCache } from '@/lib/db/schema';

(async () => {
  const rows = (await db.select().from(liveCache)) as any[];
  if (!rows.length) { console.log('live_cache 비어있음 (Tier4 미갱신 또는 만료삭제)'); process.exit(0); }
  const now = Date.now();
  let fresh = 0, stale = 0, items = 0;
  const byOrg: Record<string, { notice: number; news: number; ageH: number; exp: boolean }> = {};
  for (const r of rows) {
    const n = Array.isArray(r.payload) ? r.payload.length : 0;
    items += n;
    const ageH = (now - new Date(r.fetchedAt).getTime()) / 3.6e6;
    const exp = ageH > (r.ttlHours ?? 26);
    if (exp) stale++; else fresh++;
    const e = byOrg[r.org] ?? { notice: 0, news: 0, ageH: 0, exp: false };
    if (r.board === 'notice') e.notice += n; else if (r.board === 'news') e.news += n;
    e.ageH = Math.max(e.ageH, ageH); e.exp = e.exp || exp; byOrg[r.org] = e;
  }
  const ages = rows.map((r) => (now - new Date(r.fetchedAt).getTime()) / 3.6e6);
  console.log(`live_cache 행 ${rows.length} · 총 항목 ${items}건 · 신선 ${fresh}/만료 ${stale} (TTL 26h)`);
  console.log(`fetchedAt 경과: ${Math.min(...ages).toFixed(1)}h ~ ${Math.max(...ages).toFixed(1)}h 전`);
  console.log('\norg별 (공지/뉴스, 최고경과, 상태):');
  for (const [o, e] of Object.entries(byOrg).sort()) {
    console.log(`  ${o.padEnd(16)} 공지${String(e.notice).padStart(3)} 뉴스${String(e.news).padStart(3)}  ${e.ageH.toFixed(0)}h ${e.exp ? '⚠만료' : '✓신선'}`);
  }
  process.exit(0);
})().catch((e) => { console.error('DB 조회 실패:', (e as Error).message); process.exit(1); });
