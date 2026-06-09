/** PLAN_SYSTEM 튜닝 후 핀포인트 재검증 — 불일치였던 케이스만 planQuery 재실행(저비용).
 *   npx tsx --env-file=.env.local scripts/verify-plan.ts */
import { planQuery, routerUsage } from '@/lib/agents/agent-router';

const CASES: { q: string; want: string }[] = [
  // recency 과민 → false 기대
  { q: '인문대학의 이슈 알려줘', want: 'fact/simple/rec=false' },
  { q: '평창 캠퍼스 및 시흥 캠퍼스의 이슈는 무엇인가?', want: 'fact/rec=false' },
  { q: '서울대 캠퍼스 관련된 주요 이슈는?', want: 'fact/simple/rec=false' },
  { q: '대학운영계획 관련 내용들 알려줄래?', want: 'rec=false' },
  { q: '인공지능 관련 서울대 이슈 알려줘.', want: 'fact/rec=false' },
  // recency 보존 → true 기대
  { q: '25년 서울대 주요 시행과제 뭐가 있어?', want: 'rec=TRUE(25년)' },
  { q: '대학원생 관련 최근 시행된 제도들 정리해 줘', want: 'rec=TRUE(최근)' },
  // complexity 보존 → complex 기대
  { q: '법인화 이후 서울대 재정 구조가 어떻게 변했나? 등록금 동결 기간 재원 구성 변화를 알려줘', want: 'complex' },
  // intent 외부=insight 보존 (사용자 확인)
  { q: '외부에서 서울대학교를 보는 시선, 최근의 사회적 이슈에서 서울대학교가 부정적으로 언급된 사례', want: 'insight(외부=web)' },
  // college breadth 정밀(특정명/총장전공) → none 기대
  { q: '융합과학기술대학원 관련 쟁점은?', want: 'cb=none(특정 대학원명)' },
  { q: '지금까지 서울대학교 역대 총장의 전공/전문성과 역점 추진 사업에 연관성이 있는가?', want: 'cb=none(전공=총장전공)' },
  { q: '서울대 단과대와 대학원 종류 알려줘', want: 'agg/breadth 관찰' },
];

async function main() {
  for (const c of CASES) {
    const p = await planQuery(c.q);
    console.log(
      `${p.intent.padEnd(7)} ${p.complexity.padEnd(7)} rec=${String(p.recency).padEnd(5)} ` +
      `cb=${p.collegeBreadth.padEnd(5)} ca=${p.collegeAggregate.padEnd(5)} │ 기대:${c.want}`,
    );
    console.log(`   「${c.q.slice(0, 62).replace(/\n/g, ' ')}」`);
  }
  const cost = (routerUsage.inputTokens / 1e6) * 1 + (routerUsage.outputTokens / 1e6) * 5;
  console.log(`\n💰 $${cost.toFixed(4)} (콜 ${routerUsage.calls}, in ${routerUsage.inputTokens}/out ${routerUsage.outputTokens})`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
