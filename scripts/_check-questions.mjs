import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });

// 특정 키워드로 질문 찾기
const keywords = ['크롤링', '외부', '단과대', '인문대', '사회과학', '자체 진단', '보직', '부정적'];

for (const kw of keywords) {
  const { rows } = await pool.query(
    `SELECT content, created_at FROM messages WHERE role='user' AND content ILIKE $1 ORDER BY created_at DESC LIMIT 3`,
    [`%${kw}%`]
  );
  if (rows.length > 0) {
    console.log(`\n🔍 "${kw}" 포함 질문:`);
    rows.forEach(r => console.log(`  - ${r.content.slice(0, 100)}`));
  } else {
    console.log(`\n❌ "${kw}" 포함 질문 없음`);
  }
}

// 전체 user 메시지 목록 확인
const { rows: all } = await pool.query(
  `SELECT content, created_at FROM messages WHERE role='user' AND LENGTH(content)>5 ORDER BY created_at DESC LIMIT 100`
);
console.log(`\n\n📋 최근 user 메시지 ${all.length}개:`);
all.forEach((r, i) => console.log(`${i+1}. ${r.content.slice(0, 80)}`));

await pool.end();
