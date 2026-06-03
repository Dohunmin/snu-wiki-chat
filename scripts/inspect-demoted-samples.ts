/**
 * 강등될 답변(마커 없음, true→false) 샘플 5개의 끝부분 600자.
 * 실제 한계 표현이 있는지 vs 단순 본문 키워드인지 판단용.
 */
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}

import { db } from '@/lib/db/client';
import { sql } from 'drizzle-orm';

const HAS_LIMIT_MARKER = /[📌⚠️]\s*\*{0,2}\s*한계|(^|\n)\s*\*{0,2}\s*한계\s*[:：]/m;

const SAMPLES = [
  'AI 관련 연구나 프로젝트와 관련하여 서울대가 최근 카이스트',
  '간호대학은 2030년 무렵에 연건캠퍼스에서 관악캠퍼스',
  '서울대의 부동산 자산에 대해 이야기할게',
  '서울대 단과대별로 진행하고 있는 주요 사업',
  '학교채 발행에 있어 가장 큰 걸림돌',
  '컴퓨터공학부의 문제점과 발전방안',
  '재무재표를 봤을 때, 어떤 부분이 지금 서울대에서',
];

async function main() {
  for (const prefix of SAMPLES) {
    const res = await db.execute(sql`
      SELECT lq.limitation_excerpt AS old_excerpt, a.content AS answer, LEFT(u.content, 60) AS q
      FROM limitation_questions lq
      JOIN messages u ON u.id = lq.id
      JOIN messages a ON a.conversation_id = u.conversation_id AND a.role = 'assistant' AND a.created_at > u.created_at
      WHERE u.content LIKE ${prefix + '%'}
      ORDER BY a.created_at ASC
      LIMIT 1
    `);
    const row = res.rows[0] as { old_excerpt: string; answer: string; q: string } | undefined;
    if (!row) continue;
    console.log('═'.repeat(80));
    console.log(`Q: ${row.q}`);
    console.log(`기존 발췌: ${row.old_excerpt?.slice(0, 200)}`);
    console.log(`마커 있나: ${HAS_LIMIT_MARKER.test(row.answer)}`);
    console.log('답변 끝 800자:');
    console.log('---');
    console.log(row.answer.slice(-800));
    console.log('');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
