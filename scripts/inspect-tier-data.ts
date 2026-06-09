/** Tier3/4 실데이터 점검 — live_cache(T4 게시판)·structured_facts(T3) 적재/신선도 확인.
 *   무료(Neon 읽기만). $env: 불필요 — npx tsx --env-file=.env.local scripts/inspect-tier-data.ts */
import { db } from '@/lib/db/client';
import { liveCache, structuredFacts } from '@/lib/db/schema';

function ageHours(d: Date): number {
  return Math.round((Date.now() - new Date(d).getTime()) / 3_600_000 * 10) / 10;
}

async function main() {
  const lc = await db.select().from(liveCache);
  console.log(`\n══ Tier4 live_cache: ${lc.length} rows ══`);
  for (const r of lc) {
    const items = Array.isArray(r.payload) ? r.payload.length : 0;
    console.log(`  ${r.id.padEnd(22)} items=${String(items).padStart(3)}  ttl=${r.ttlHours}h  age=${ageHours(r.fetchedAt)}h  ${ageHours(r.fetchedAt) < r.ttlHours ? '✅fresh' : '⛔stale'}`);
  }

  const sf = await db.select().from(structuredFacts);
  console.log(`\n══ Tier3 structured_facts: ${sf.length} rows ══`);
  for (const r of sf) {
    console.log(`  ${r.id.padEnd(28)} ttl=${r.ttlDays}d  age=${(ageHours(r.fetchedAt) / 24).toFixed(1)}d`);
  }
  console.log('');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
