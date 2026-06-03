/** 단과대 라우팅 게이트 검증 — 명시 지칭 시만 단과대 포함, 거버넌스는 제외. */
import { routeQuery } from '@/lib/agents/router';
import { registry } from '@/lib/agents/registry';

const COLLEGE = new Set<string>();

const QS = [
  '역대 총장 정보 알려줘',                          // 거버넌스 → 단과대 0 기대
  '서울대 재정 구조는 어떻게 변했나?',              // 거버넌스 → 단과대 0
  '기계공학부 정보와 연혁은 어때?',                 // → eng
  '음대 작곡과는 어때?',                            // → music
  '경영대와 공대의 차이는 뭐야?',                   // → business + eng
  '간호대학 교육과정 알려줘',                       // → nursing
];

async function main() {
  registry.init();
  for (const a of registry.getAll()) if (a.config.group === '단과대' || a.config.group === '대학원') COLLEGE.add(a.config.id);
  for (const q of QS) {
    const r = await routeQuery(q, 'admin');
    const colleges = r.selectedAgentIds.filter(id => COLLEGE.has(id));
    console.log(`\nQ: ${q}`);
    console.log(`   선택: ${r.selectedAgentIds.join(', ')}`);
    console.log(`   → 단과대: ${colleges.length ? colleges.join(', ') : '(없음)'}`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
