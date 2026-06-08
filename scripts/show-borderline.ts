/** 경계 질문 풀텍스트 출력 (DB만, 무료). npx tsx --env-file=.env.local scripts/show-borderline.ts */
import { sql } from '@vercel/postgres';

const KEYS = [
  ['#15', '신임교원'],
  ['#17', '나눔기반'],
  ['#28', '정해지지 않은 권한'],
  ['#30', '인문대학 관점과'],
  ['#38', '일관되게 유지해온'],
];

async function main() {
  const r = await sql`SELECT DISTINCT content AS q FROM messages WHERE role='user' AND mode='normal'`;
  for (const [id, key] of KEYS) {
    const hit = r.rows.find((x: any) => (x.q || '').includes(key));
    console.log(`\n━━ ${id} ━━\n${hit ? hit.q : '(못 찾음)'}\n`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
