/* Debug only — top 30 vector matches for gap query */
import process from 'process';
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local'); } catch {}

import { embedOne } from '@/lib/embed/voyage';
import { sql } from '@vercel/postgres';

const query = '대학원생 장학금이 최근 10년 사이에 증가했어?';

async function main() {
  const queryEmbed = await embedOne(query, 'query');
  const lit = '[' + queryEmbed.join(',') + ']';
  const r = await sql.query(`
    SELECT id, page_type, page_id, LEFT(chunk_text, 100) as preview,
           (embedding <=> '${lit}'::vector) as distance
    FROM chunk_embeddings
    WHERE wiki_id = 'finance'
    ORDER BY embedding <=> '${lit}'::vector
    LIMIT 30
  `);
  console.log('Top 30 vector matches for finance:');
  r.rows.forEach((row, i) => {
    console.log(`${(i+1).toString().padStart(2)}. dist=${Number(row.distance).toFixed(3)} | ${row.page_type}:${row.page_id}`);
    console.log(`     ${row.preview.replace(/\n/g, ' ').slice(0, 100)}`);
  });
}
main().catch(e => { console.error(e); process.exit(1); });
