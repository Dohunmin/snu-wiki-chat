/** shadow-intent 표본 규모 산정 — 실제 질의로그 개수/유니크/길이분포 (무료, Neon 읽기).
 *   npx tsx --env-file=.env.local scripts/count-questions.ts */
import { sql } from '@vercel/postgres';

const master = (process.env.MASTER_ADMIN_EMAIL ?? '').toLowerCase();

async function main() {
  const r = await sql`
    SELECT m.content AS q, m.mode, u.role AS urole, u.email
    FROM messages m JOIN conversations c ON m.conversation_id=c.id JOIN users u ON c.user_id=u.id
    WHERE m.role='user' AND length(trim(m.content)) > 0`;
  const rows = r.rows as { q: string; mode: string; urole: string; email: string }[];

  const normal = rows.filter(x => x.mode === 'normal');
  const uniq = (arr: typeof rows) => [...new Set(arr.map(x => x.q.trim()))];

  const uAll = uniq(rows);
  const uNormal = uniq(normal);
  const uNormalNonAdmin = uniq(normal.filter(x => x.urole !== 'admin' && (x.email || '').toLowerCase() !== master));

  const dist = (arr: string[]) => {
    const lens = arr.map(s => s.length).sort((a, b) => a - b);
    const q = (p: number) => lens[Math.floor(lens.length * p)] ?? 0;
    return `median ${q(.5)} · p75 ${q(.75)} · p90 ${q(.9)} · max ${lens[lens.length - 1] ?? 0}`;
  };

  console.log(`총 user 메시지: ${rows.length} (mode=normal: ${normal.length})`);
  console.log(`유니크 질문 — 전체: ${uAll.length} / normal: ${uNormal.length} / normal·비admin: ${uNormalNonAdmin.length}`);
  console.log(`normal 유니크 길이: ${dist(uNormal)}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
