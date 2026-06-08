/** 실질문 개수 확인 (DB만, 무료). npx tsx --env-file=.env.local scripts/count-real-questions.ts */
import { sql } from '@vercel/postgres';

const master = (process.env.MASTER_ADMIN_EMAIL ?? '').toLowerCase();

async function main() {
  const r = await sql`
    SELECT m.content AS q, u.email, u.role AS urole
    FROM messages m JOIN conversations c ON m.conversation_id=c.id JOIN users u ON c.user_id=u.id
    WHERE m.role='user' AND m.mode='normal'`;
  const seen = new Set<string>();
  const qs = (r.rows as { q: string; email: string; urole: string }[])
    .filter(x => x.urole !== 'admin' && (x.email || '').toLowerCase() !== master && (x.q || '').length >= 12 && (seen.has(x.q) ? false : (seen.add(x.q), true)))
    .map(x => x.q);
  console.log(`전체 메시지(user/normal): ${r.rows.length}`);
  console.log(`실질문 (비admin·dedup·len>=12): ${qs.length}`);
  console.log(`Haiku 분류 예상 비용: ~$${(qs.length * 0.0007).toFixed(3)}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
