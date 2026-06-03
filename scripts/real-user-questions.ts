/**
 * 실제 사용자(admin 제외, tier1/tier2) 질문 수준 검토 — 라우팅/예산 전략 결정용 ground truth.
 *   npx tsx --env-file=.env.local scripts/real-user-questions.ts
 */
import { sql } from '@vercel/postgres';

const SPEC = /가능할까|가능한가|방안|한다면|어떨까|정리해|생각해|왜 |비교|어떻게 생각|할 수 있|엮어|짓고|어떻게 하면/;
const masterEmail = (process.env.MASTER_ADMIN_EMAIL ?? '').toLowerCase();

async function main() {
  const r = await sql`
    SELECT u.name, u.email, u.role AS urole, m.content, char_length(m.content) AS len
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    JOIN users u ON c.user_id = u.id
    WHERE m.role = 'user' AND u.role <> 'admin'
    ORDER BY u.name, m.created_at`;

  const rows = r.rows.filter((x: any) => (x.email || '').toLowerCase() !== masterEmail);
  if (rows.length === 0) { console.log('실제 사용자(비admin) 질문 없음 — 전부 admin이 던진 질문임.'); return; }

  // 사용자별 그룹
  const byUser = new Map<string, any[]>();
  for (const x of rows) { const k = `${x.name} [${x.urole}]`; (byUser.get(k) ?? byUser.set(k, []).get(k))!.push(x); }

  console.log(`실제 사용자 ${byUser.size}명, 질문 ${rows.length}개 (admin·master 제외)\n`);
  const allLens = rows.map((x: any) => Number(x.len));
  const deep = rows.filter((x: any) => Number(x.len) > 120 || SPEC.test(x.content));
  allLens.sort((a, b) => a - b);
  const q = (p: number) => allLens[Math.floor(allLens.length * p)];
  console.log('질문 길이: median ' + q(.5) + '자 | p75 ' + q(.75) + '자 | p90 ' + q(.9) + '자 | max ' + allLens[allLens.length - 1] + '자');
  console.log(`깊은 질문(>120자 또는 사변마커): ${deep.length}/${rows.length} (${Math.round(deep.length / rows.length * 100)}%)\n`);

  for (const [user, qs] of byUser) {
    const d = qs.filter((x: any) => Number(x.len) > 120 || SPEC.test(x.content)).length;
    console.log(`── ${user}: ${qs.length}질문, 평균 ${Math.round(qs.reduce((s: number, x: any) => s + Number(x.len), 0) / qs.length)}자, 깊은 ${d}개 ──`);
    for (const x of qs.slice(0, 8)) console.log(`   (${x.len}자)${(Number(x.len) > 120 || SPEC.test(x.content)) ? '🔵' : '⚪'} ${x.content.slice(0, 75).replace(/\n/g, ' ')}`);
    if (qs.length > 8) console.log(`   … 외 ${qs.length - 8}개`);
    console.log('');
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
