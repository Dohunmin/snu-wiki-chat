import { sql } from '@vercel/postgres';
import { classifyComplexity } from '@/lib/agents/complexity';

const masterEmail = (process.env.MASTER_ADMIN_EMAIL ?? '').toLowerCase();

async function main() {
  const r = await sql`
    SELECT u.email, m.content FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    JOIN users u ON c.user_id = u.id
    WHERE m.role = 'user' AND u.role <> 'admin'`;
  const rows = r.rows.filter((x: any) => (x.email || '').toLowerCase() !== masterEmail);
  let simple = 0, complex = 0;
  const cx: string[] = [];
  for (const x of rows) {
    if (classifyComplexity(x.content) === 'complex') { complex++; cx.push(x.content.slice(0, 60).replace(/\n/g, ' ')); }
    else simple++;
  }
  console.log(`실제 ${rows.length}질문 → simple ${simple} (${Math.round(simple / rows.length * 100)}%) | complex ${complex} (${Math.round(complex / rows.length * 100)}%)`);
  console.log('\ncomplex로 분류된 것들 (false positive 눈검사):');
  cx.forEach(c => console.log('  🔵 ' + c));
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
