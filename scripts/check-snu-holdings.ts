/**
 * SNU Holdings 관련 질문이 messages에 있는지,
 * limitation_questions에 들어갔는지, limitation=true로 평가됐는지 확인.
 */
import { db } from '@/lib/db/client';
import { sql } from 'drizzle-orm';

async function main() {
  console.log('─'.repeat(80));
  console.log('1) messages에서 SNU Holdings / 기술지주 관련 질문 검색');
  console.log('─'.repeat(80));
  const msgs = await db.execute(sql`
    SELECT id, role, LEFT(content, 200) AS preview, created_at
    FROM messages
    WHERE (content ILIKE '%SNU Holdings%' OR content ILIKE '%기술지주%' OR content ILIKE '%홀딩스%')
      AND role = 'user'
    ORDER BY created_at DESC
    LIMIT 10
  `);
  console.log(`발견: ${msgs.rows.length}건`);
  for (const r of msgs.rows as Array<{ id: string; preview: string; created_at: Date }>) {
    console.log(`  [${r.created_at.toISOString?.() ?? r.created_at}] id=${r.id}`);
    console.log(`    ${r.preview.replace(/\n/g, ' ')}`);
  }

  if (msgs.rows.length === 0) {
    console.log('\n❌ messages에 SNU Holdings 관련 질문이 없음. (DB에 저장 안 됐을 가능성)');
    return;
  }

  const userIds = (msgs.rows as Array<{ id: string }>).map(r => r.id);

  console.log('\n' + '─'.repeat(80));
  console.log('2) limitation_questions에 해당 id들이 들어가 있는가?');
  console.log('─'.repeat(80));
  const idsJson = JSON.stringify(userIds);
  const tracked = await db.execute(sql`
    SELECT id, wiki, limitation, LEFT(limitation_excerpt, 150) AS excerpt,
           cluster_id, evaluated_at
    FROM limitation_questions
    WHERE id IN (SELECT jsonb_array_elements_text(${idsJson}::jsonb))
  `);
  console.log(`limitation_questions에 등록된 건수: ${tracked.rows.length} / ${userIds.length}`);
  for (const r of tracked.rows as Array<{ id: string; wiki: string; limitation: boolean; excerpt: string; cluster_id: number; evaluated_at: Date }>) {
    console.log(`  id=${r.id}  wiki=${r.wiki}  limitation=${r.limitation}  cluster=${r.cluster_id}`);
    console.log(`    evaluated_at=${r.evaluated_at.toISOString?.() ?? r.evaluated_at}`);
    console.log(`    excerpt: ${r.excerpt || '(없음)'}`);
  }

  const trackedIds = new Set((tracked.rows as Array<{ id: string }>).map(r => r.id));
  const missing = userIds.filter(id => !trackedIds.has(id));
  if (missing.length > 0) {
    console.log(`\n⚠️ limitation_questions에 누락된 user 질문 ${missing.length}건: ${missing.join(', ')}`);
  }

  console.log('\n' + '─'.repeat(80));
  console.log('3) 갱신이 실제로 됐는지: 가장 최근 evaluated_at');
  console.log('─'.repeat(80));
  const last = await db.execute(sql`
    SELECT MAX(evaluated_at) AS max_eval, COUNT(*)::int AS total
    FROM limitation_questions
  `);
  console.log(last.rows[0]);

  console.log('\n' + '─'.repeat(80));
  console.log('4) messages 총 user 질문 수 vs limitation_questions 총 수 (gap = 미처리)');
  console.log('─'.repeat(80));
  const counts = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM messages u
       WHERE u.role = 'user' AND LENGTH(u.content) > 5
         AND EXISTS (SELECT 1 FROM messages a WHERE a.conversation_id = u.conversation_id AND a.role = 'assistant' AND a.created_at > u.created_at)
      ) AS user_with_answer,
      (SELECT COUNT(*)::int FROM limitation_questions) AS tracked
  `);
  console.log(counts.rows[0]);
}

main().catch(err => { console.error(err); process.exit(1); });
