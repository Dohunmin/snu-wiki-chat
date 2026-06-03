/**
 * SNU Holdings 질문의 답변 원문 + judge 재실행 + extractLimitationSentence 단독 검증.
 * 왜 한계 false로 평가됐는지 원인 특정.
 */
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}

import { db } from '@/lib/db/client';
import { sql } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';

const Q_ID = 'c7a636a5-b332-432b-8de2-ff98fadc7edc';

// refresh.ts에서 발췌 — 정규식 + extractLimitationSentence 동일 복제
const LIMIT_KEYWORD = /않습니다|없습니다|없어|없으|확인되지|확인할 수 없|제한적|범위(를| 내| 밖| 안)|포함되어 있지|별도 자료|추가 자료|미확인|찾을 수 없|누락|벗어|부족|드리지 못|제공되지|불가능|어렵습니다|어려운|단정|명시되지|나타나지|존재하지|다루지 않|알 수 없|확인 불가/;

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
  // 답변 가져오기
  const res = await db.execute(sql`
    SELECT a.id, a.content AS answer, LEFT(u.content, 100) AS question
    FROM messages u
    JOIN messages a ON a.conversation_id = u.conversation_id AND a.role = 'assistant' AND a.created_at > u.created_at
    WHERE u.id = ${Q_ID}
    ORDER BY a.created_at ASC
    LIMIT 1
  `);
  const row = res.rows[0] as { id: string; answer: string; question: string } | undefined;
  if (!row) {
    console.log('❌ 답변 없음');
    return;
  }

  console.log('═'.repeat(80));
  console.log('답변 전체:');
  console.log('═'.repeat(80));
  console.log(row.answer);

  console.log('\n' + '═'.repeat(80));
  console.log('A) extractLimitationSentence 결과');
  console.log('═'.repeat(80));
  const excerpt = extractLimitationSentence(row.answer);
  console.log(`길이: ${excerpt.length}`);
  console.log(`결과: "${excerpt}"`);

  console.log('\n' + '═'.repeat(80));
  console.log('B) "📌|한계" 마커가 있는 줄 + 키워드 매칭 검증');
  console.log('═'.repeat(80));
  const lines = row.answer.split('\n');
  lines.forEach((raw, i) => {
    if (/📌|한계/.test(raw)) {
      const clean = raw.replace(/[#>*`|]/g, '').replace(/^\s*[-•]\s*/, '').trim();
      const kwHit = LIMIT_KEYWORD.test(clean);
      console.log(`  L${i + 1}  clean.length=${clean.length}  kwHit=${kwHit}`);
      console.log(`    raw: ${raw.slice(0, 200)}`);
      console.log(`    clean: ${clean.slice(0, 200)}`);
    }
  });

  console.log('\n' + '═'.repeat(80));
  console.log('C) Sonnet judge 재실행');
  console.log('═'.repeat(80));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('⚠️ ANTHROPIC_API_KEY 없음 - skip');
    return;
  }
  const anthropic = new Anthropic({ apiKey });
  const WIKI_LIST = 'senate(평의원회), board(이사회), plan(대학운영계획), vision(중장기발전계획), history(70년역사), status(대학현황), yhl-speeches(유홍림총장연설), finance(재무정보공시), leesj(이석재 후보)';

  const sanitize = (s: string) => s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

  // 수정된 squeeze 로직 (refresh.ts의 squeezeAnswerForJudge와 동일)
  const squeeze = (a: string, head = 1200, tail = 1000) => {
    if (a.length <= head + tail + 20) return a;
    return `${a.slice(0, head)}\n\n[...중략...]\n\n${a.slice(-tail)}`;
  };
  const squeezed = squeeze(sanitize(row.answer));
  console.log(`전달 길이: ${squeezed.length}자 (원본 ${row.answer.length}자)`);
  console.log(`전달 끝 200자: ...${squeezed.slice(-200)}\n`);

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `서울대 거버넌스 위키 챗봇 Q&A를 평가하세요.

질문: ${sanitize(row.question)}
답변: ${squeezed}

[품질]
- answered: 위키 자료로 핵심에 구체적으로 답변
- partial: 일부만 답변하거나 불완전
- no_data: 자료없음/범위밖/실질 답변 없음

[위키 분류] 이 질문의 주제와 가장 가까운 위키 ID 하나:
${WIKI_LIST}
관련 위키가 없으면 none

[한계 여부] — 엄격하게 판정하세요.
- yes: 답변이 질문의 **핵심**에 대해 "위키 자료에 없다 / 범위 밖이다 / 확인 불가"라고 명시적으로 밝힌 경우.
       또는 답변 전체가 자료 부족으로 핵심을 답하지 못한 경우.
- no:  자료로 핵심을 답변한 경우. 답변에 표·목록·구체적 수치·인용이 있으면 거의 no.
       답변 끝에 "일부 세부사항은 별도 자료 참고" 정도의 **부수적 보조 안내**가 있어도,
       핵심 질문에 답했으면 no.
  ※ quality가 answered면 대부분 no. 잘 답변했는데 한계로 분류하지 마세요.

JSON으로만 출력:
{"q":"answered|partial|no_data","w":"위키ID","l":"yes|no"}`,
    }],
  });
  const raw = (msg.content[0] as { text: string }).text.trim();
  console.log('Sonnet 출력:', raw);

  console.log('\n' + '═'.repeat(80));
  console.log('D) 최종 판정 — 1200자 자르기 영향 확인');
  console.log('═'.repeat(80));
  console.log(`답변 전체 길이: ${row.answer.length}자`);
  console.log(`Sonnet에 전달된 slice(0, 1200) 끝부분 100자:`);
  console.log(`  ...${sanitize(row.answer).slice(1100, 1200)}`);
  const limPos = row.answer.indexOf('📌');
  console.log(`"📌" 위치: ${limPos}자 (1200 이상이면 Sonnet이 못 봄 → false로 판정될 수 있음)`);
}

main().catch(err => { console.error(err); process.exit(1); });
