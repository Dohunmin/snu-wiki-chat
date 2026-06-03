import { sql } from '@vercel/postgres';

async function main() {
  const installed = await sql`SELECT extname, extversion FROM pg_extension WHERE extname = 'vector'`;
  console.log('pgvector 설치됨:', installed.rows.length > 0 ? JSON.stringify(installed.rows[0]) : '아니오');

  const available = await sql`SELECT name, default_version FROM pg_available_extensions WHERE name = 'vector'`;
  console.log('설치 가능:', available.rows.length > 0 ? JSON.stringify(available.rows[0]) : '아니오 (환경 미지원)');
}

main().catch(console.error);
