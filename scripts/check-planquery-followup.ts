/**
 * planQuery 후속질문 맥락 해소 검증 — Phase 1 회귀/기능 확인용.
 *   실제 신고 버그(이석재→"외부 확인") + 회귀 가드(독립질문 과잉재작성·첫턴 불변).
 *   비용: Haiku 5콜 ~$0.013. 실행: npx tsx --env-file=.env.local scripts/check-planquery-followup.ts
 */
import { planQuery, type ChatTurn } from '@/lib/agents/agent-router';

type Case = {
  name: string;
  history: ChatTurn[];
  query: string;
  check: (r: { resolvedQuery: string; isFollowup: boolean; intent: string; complexity: string }) => boolean;
  expect: string;
};

const CASES: Case[] = [
  {
    name: '① 이석재→"외부 자료 확인해" (신고 버그)',
    history: [
      { role: 'user', content: '이석재 교수 정보 알려줘' },
      { role: 'assistant', content: '이석재는 서울대 이사회 내부이사로 재직(임기 2025.1.25 만료), 운영소위 위원 활동. ⚠️ 학과·전공·교수경력 등 학문적 이력은 내부 자료에 없어 외부 자료 확인이 필요합니다.' },
    ],
    query: '외부 자료 확인해',
    expect: 'isFollowup=true, resolved에 이석재+외부, intent=insight',
    check: (r) => r.isFollowup === true && /이석재/.test(r.resolvedQuery) && /외부/.test(r.resolvedQuery) && r.intent === 'insight',
  },
  {
    name: '② 공대→"대학원은?" (생략 주어/그룹 전환)',
    history: [
      { role: 'user', content: '공대 소개해줘' },
      { role: 'assistant', content: '서울대 공과대학은 16개 학부·과로 구성되며...' },
    ],
    query: '대학원은?',
    expect: 'isFollowup=true, resolved="공대 대학원"',
    check: (r) => r.isFollowup === true && /공(대|과)/.test(r.resolvedQuery) && /대학원/.test(r.resolvedQuery),
  },
  {
    name: '③ 예산→"작년이랑 비교해줘" (대상 생략)',
    history: [
      { role: 'user', content: '2026년 예산은 얼마야?' },
      { role: 'assistant', content: '2026년 서울대 예산은 약 ...원으로 편성되었습니다.' },
    ],
    query: '작년이랑 비교해줘',
    expect: 'isFollowup=true, resolved에 비교+2025/작년',
    check: (r) => r.isFollowup === true && /(2025|작년|비교)/.test(r.resolvedQuery),
  },
  {
    name: '④ 음성: 독립질문 (과잉재작성 회귀 가드)',
    history: [
      { role: 'user', content: '2026년 예산은 얼마야?' },
      { role: 'assistant', content: '2026년 서울대 예산은 약 ...원으로 편성되었습니다.' },
    ],
    query: '평의원회 구성은 어떻게 되나요?',
    expect: 'isFollowup=false, resolved≈원문(예산으로 오염 X)',
    check: (r) => r.isFollowup === false && /평의원/.test(r.resolvedQuery) && !/예산/.test(r.resolvedQuery),
  },
  {
    name: '⑤ 음성: 첫 턴(이력 없음)',
    history: [],
    query: '이사회 안건 종류 알려줘',
    expect: 'isFollowup=false, resolved=원문 그대로',
    check: (r) => r.isFollowup === false && r.resolvedQuery.includes('이사회 안건'),
  },
];

async function main() {
  let pass = 0;
  for (const c of CASES) {
    const plan = await planQuery(c.query, c.history);
    const r = {
      resolvedQuery: plan.resolvedQuery,
      isFollowup: plan.isFollowup,
      intent: plan.intent,
      complexity: plan.complexity,
    };
    const ok = c.check(r);
    if (ok) pass++;
    console.log(`\n${ok ? '✅ PASS' : '🔴 FAIL'}  ${c.name}`);
    console.log(`   질문      : "${c.query}"`);
    console.log(`   resolved  : "${r.resolvedQuery}"`);
    console.log(`   isFollowup: ${r.isFollowup} | intent: ${r.intent} | complexity: ${r.complexity} | via: ${plan.via}`);
    console.log(`   기대      : ${c.expect}`);
  }
  console.log(`\n────────────\n결과: ${pass}/${CASES.length} PASS`);
  process.exit(pass === CASES.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
