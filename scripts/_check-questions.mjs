import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });

const [all, paired, unpaired, sample] = await Promise.all([
  pool.query("SELECT COUNT(*) as n FROM messages WHERE role='user' AND LENGTH(content)>5"),
  pool.query(`SELECT COUNT(*) as n FROM messages u WHERE u.role='user' AND LENGTH(u.content)>5
    AND EXISTS (SELECT 1 FROM messages a WHERE a.conversation_id=u.conversation_id AND a.role='assistant' AND a.created_at > u.created_at)`),
  pool.query(`SELECT COUNT(*) as n FROM messages u WHERE u.role='user' AND LENGTH(u.content)>5
    AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.conversation_id=u.conversation_id AND a.role='assistant' AND a.created_at > u.created_at)`),
  pool.query(`SELECT u.content FROM messages u WHERE u.role='user' AND LENGTH(u.content)>5
    AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.conversation_id=u.conversation_id AND a.role='assistant' AND a.created_at > u.created_at)
    LIMIT 5`),
]);

console.log('전체 user 메시지 :', all.rows[0].n);
console.log('답변 있는 질문   :', paired.rows[0].n, '← 현재 임베딩됨');
console.log('답변 없는 질문   :', unpaired.rows[0].n, '← 지형도 누락');

if (unpaired.rows[0].n > 0) {
  console.log('\n누락된 질문 샘플:');
  sample.rows.forEach((r, i) => console.log(`  ${i+1}. ${r.content.slice(0,80)}`));
}

await pool.end();
