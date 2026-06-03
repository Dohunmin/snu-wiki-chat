import { sql } from '@vercel/postgres';

async function main() {
  const r = await sql`SELECT wiki_id, COUNT(*)::int AS n FROM chunk_embeddings GROUP BY wiki_id ORDER BY n DESC`;
  console.log('총 위키 수:', r.rows.length);
  for (const row of r.rows) console.log('  ' + String(row.wiki_id).padEnd(18) + row.n);
  const v = r.rows.find((x: any) => x.wiki_id === 'vision');
  console.log('\nvision(중장기발전계획) 청크:', v ? (v as any).n : '❌ 0 — 미적재!');
  // 타입별
  const t = await sql`SELECT page_type, COUNT(*)::int AS n FROM chunk_embeddings GROUP BY page_type ORDER BY n DESC`;
  console.log('\n페이지 타입별:');
  for (const row of t.rows) console.log('  ' + String(row.page_type).padEnd(12) + row.n);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
