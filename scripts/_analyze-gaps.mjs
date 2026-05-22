import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}
import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });

// Q&A 전체 + 라우팅 정보
const { rows } = await pool.query(`
  SELECT
    u.content AS question,
    a.content AS answer,
    a.routed_agents,
    u.created_at
  FROM messages u
  JOIN messages a ON (
    a.conversation_id = u.conversation_id AND a.role = 'assistant'
    AND a.id = (
      SELECT id FROM messages
      WHERE conversation_id = u.conversation_id AND role = 'assistant' AND created_at > u.created_at
      ORDER BY created_at LIMIT 1
    )
  )
  WHERE u.role = 'user' AND LENGTH(u.content) > 5
  ORDER BY u.created_at DESC LIMIT 200
`);
await pool.end();

// Claude 평가 결과 로드
const qData = JSON.parse(fs.readFileSync('public/knowledge-map-questions.json', 'utf-8'));
const qualityMap = new Map(qData.map(q => [q.question.slice(0, 120), q.quality]));

const WIKI_LABELS = {
  senate:'평의원회', board:'이사회', plan:'대학운영계획', vision:'중장기발전계획',
  history:'70년역사', status:'대학현황', 'yhl-speeches':'유홍림총장연설',
  finance:'재무정보공시', leesj:'이석재 후보',
};

// 분류
const answered = [], partial = [], no_data = [];
rows.forEach(r => {
  const q = r.question.slice(0, 120);
  const quality = qualityMap.get(q) || 'unknown';
  const routed = r.routed_agents || [];
  const entry = { question: r.question, routed, routedLabels: routed.map(w => WIKI_LABELS[w] || w) };
  if (quality === 'answered') answered.push(entry);
  else if (quality === 'partial') partial.push(entry);
  else if (quality === 'no_data') no_data.push(entry);
});

console.log(`\n${'='.repeat(60)}`);
console.log(`총 ${rows.length}개 질문 분석`);
console.log(`✅ answered: ${answered.length}개`);
console.log(`⚠️  partial:  ${partial.length}개`);
console.log(`❌ no_data:  ${no_data.length}개`);

// ── partial 분석 ──────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log('⚠️  PARTIAL 질문 분석');
console.log(`${'─'.repeat(60)}`);

const partialSingle = partial.filter(e => e.routed.length <= 1);
const partialMulti  = partial.filter(e => e.routed.length >= 2);
console.log(`  단일 위키만 라우팅됨: ${partialSingle.length}개`);
console.log(`  다중 위키 라우팅됨:   ${partialMulti.length}개 (→ 컨텐츠 자체 부족)`);

console.log('\n  [단일 위키 partial — 교차 참조 부족]');
partialSingle.forEach(e => {
  const wiki = e.routedLabels[0] || '없음';
  console.log(`  • [${wiki}] ${e.question.slice(0, 65)}`);
});

console.log('\n  [다중 위키 partial — 내용은 있지만 불완전]');
partialMulti.slice(0, 8).forEach(e => {
  console.log(`  • [${e.routedLabels.join('+')}] ${e.question.slice(0, 55)}`);
});

// ── no_data 분석 ──────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log('❌ NO_DATA 질문 분석');
console.log(`${'─'.repeat(60)}`);

const ndNoRoute  = no_data.filter(e => e.routed.length === 0);
const ndWrongRoute = no_data.filter(e => e.routed.length >= 1);
console.log(`  라우팅 자체 없음: ${ndNoRoute.length}개 (→ 범위 완전 이탈)`);
console.log(`  라우팅됐지만 실패: ${ndWrongRoute.length}개 (→ 위키 내 관련 청크 없음)`);

no_data.forEach(e => {
  const wiki = e.routedLabels.join('+') || '없음';
  console.log(`  • [${wiki}] ${e.question.slice(0, 65)}`);
});

// ── 위키별 실패율 ──────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log('📊 위키별 등장 빈도 × 실패율');
console.log(`${'─'.repeat(60)}`);

const wikiStats = {};
[...partial, ...no_data, ...answered].forEach(e => {
  e.routed.forEach(w => {
    if (!wikiStats[w]) wikiStats[w] = { total: 0, fail: 0 };
    wikiStats[w].total++;
    if (partial.includes(e) || no_data.includes(e)) wikiStats[w].fail++;
  });
});

Object.entries(wikiStats)
  .sort((a,b) => b[1].total - a[1].total)
  .forEach(([wid, s]) => {
    const rate = Math.round(s.fail / s.total * 100);
    const bar = '█'.repeat(Math.round(rate/5)) + '░'.repeat(20 - Math.round(rate/5));
    console.log(`  ${(WIKI_LABELS[wid]||wid).padEnd(12)} ${bar} ${rate}% 실패 (${s.fail}/${s.total})`);
  });

// ── 교차 참조 필요 패턴 ─────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log('🔗 교차 참조가 필요했을 것으로 보이는 질문');
console.log(`${'─'.repeat(60)}`);
const crossKeywords = ['비교', '차이', '관계', '연결', '함께', '같이', '전체', '종합', '모든', '어떻게 변', '이후'];
const crossNeeded = [...partial, ...no_data].filter(e =>
  crossKeywords.some(kw => e.question.includes(kw)) || e.routed.length <= 1
);
crossNeeded.slice(0, 10).forEach(e => {
  console.log(`  • ${e.question.slice(0, 70)}`);
  console.log(`    → 라우팅: ${e.routedLabels.join(', ') || '없음'}`);
});
