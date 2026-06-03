/**
 * 새 한계 판정 로직(HAS_LIMIT_MARKER + extractLimitationSentence)이
 * 기존 145건에 어떻게 적용될지 dry-run.
 *
 * - 마커 있고 추출 OK → limitation=true (정상)
 * - 마커 없음 → limitation=false (정상)
 * - 기존 DB와 다른 판정이 나오는 건만 출력 (변경 영향 확인)
 */
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}

import { db } from '@/lib/db/client';
import { sql } from 'drizzle-orm';

const LIMIT_KEYWORD = /않습니다|없습니다|없어|없으|확인되지|확인할 수 없|제한적|범위(를| 내| 밖| 안)|포함되어 있지|별도 자료|추가 자료|미확인|찾을 수 없|누락|벗어|부족|드리지 못|제공되지|불가능|어렵습니다|어려운|단정|명시되지|나타나지|존재하지|다루지 않|알 수 없|확인 불가/;
const HAS_LIMIT_MARKER = /[📌⚠️📝][^\n]{0,30}한계|(^|\n)\s*[*#>]*\s*한계\s*(가\s*있|[:：를는 ]|안내)/m;

function extractLimitationSentence(answer: string): string {
  const lines = answer.split('\n');
  const marked: string[] = [];
  const plain: string[] = [];
  for (const raw of lines) {
    const clean = raw.replace(/[#>*`|]/g, '').replace(/^\s*[-•]\s*/, '').trim();
    if (clean.length < 12) continue;
    if (!LIMIT_KEYWORD.test(clean)) continue;
    if (/⚠️|📝|한계/.test(raw)) marked.push(clean);
    else plain.push(clean);
  }
  const pick = marked[0] ?? plain[0];
  if (!pick) return '';
  const sentences = pick.split(/(?<=[.!?])\s+/);
  const hit = sentences.find(s => LIMIT_KEYWORD.test(s)) ?? pick;
  return hit.replace(/^[^가-힣a-zA-Z0-9"'(]+/, '').trim().slice(0, 300);
}

async function main() {
  const res = await db.execute(sql`
    SELECT lq.id, lq.limitation AS old_limit, LEFT(lq.limitation_excerpt, 100) AS old_excerpt,
           LEFT(u.content, 80) AS question, a.content AS answer
    FROM limitation_questions lq
    JOIN messages u ON u.id = lq.id
    JOIN messages a ON a.conversation_id = u.conversation_id AND a.role = 'assistant' AND a.created_at > u.created_at
    ORDER BY u.created_at DESC
  `);
  const rows = res.rows as Array<{
    id: string; old_limit: boolean; old_excerpt: string;
    question: string; answer: string;
  }>;

  let changed = 0;
  let promotedN = 0; // false → true (이전엔 누락, 새 로직이 잡음)
  let demotedN = 0;  // true → false
  const changes: Array<{ id: string; from: boolean; to: boolean; q: string; ex: string }> = [];

  for (const r of rows) {
    const hasMarker = HAS_LIMIT_MARKER.test(r.answer ?? '');
    const ex = hasMarker ? extractLimitationSentence(r.answer ?? '') : '';
    const newLimit = ex.length > 0;
    if (newLimit !== r.old_limit) {
      changed++;
      if (newLimit) promotedN++; else demotedN++;
      changes.push({ id: r.id, from: r.old_limit, to: newLimit, q: r.question, ex });
    }
  }

  console.log(`총 ${rows.length}건 검사`);
  console.log(`판정 변경: ${changed}건  (승격 ${promotedN}, 강등 ${demotedN})\n`);

  console.log('═'.repeat(80));
  console.log('강등(true→false) 샘플 8개 — 기존 발췌 + 답변 끝 500자 확인');
  console.log('═'.repeat(80));
  const demoted = changes.filter(c => !c.to).slice(0, 8);
  for (const c of demoted) {
    const r = rows.find(r => r.id === c.id)!;
    console.log(`\nQ: ${c.q}`);
    console.log(`기존 발췌: ${r.old_excerpt?.slice(0, 150)}`);
    console.log(`답변 끝 500자:`);
    console.log('---');
    console.log((r.answer ?? '').slice(-500));
  }
  console.log('\n' + '═'.repeat(80));
  console.log('승격(false→true) 전체 발췌 미리보기 (참고)');
  console.log('═'.repeat(80));
  for (const c of changes.filter(c => c.to)) {
    console.log(`  + ${c.q}`);
    console.log(`    "${c.ex.slice(0, 120)}"`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
