/**
 * 단과대/대학원 라우팅 admission 게이트 — before/after 시뮬레이션.
 *
 * routeQuery 전체(임베딩 API 호출)를 돌리지 않고, getRoutableAgents의 *college 입장 판정*만
 * 결정론적으로 재현한다. 외부 API 0 → 비용 0.
 *
 * BEFORE = 기존 게이트(명시 지칭만): isCollegeReferenced
 * AFTER  = 신규 게이트(+ 그룹 breadth): isCollegeReferenced || detectGroupBreadth[group]
 *
 * 실행: npx tsx scripts/diag/test-college-admission.ts
 */
import agentsConfig from '../../data/agents.config.json';
import { isCollegeGroup, isCollegeReferenced, detectGroupBreadth } from '../../lib/agents/college-route';
import type { AgentConfig } from '../../lib/agents/types';

const agents = (agentsConfig.agents as unknown as AgentConfig[]).filter(a => a.enabled);
const colleges = agents.filter(a => isCollegeGroup(a));

function admittedBefore(query: string): AgentConfig[] {
  return colleges.filter(a => isCollegeReferenced(query, a));
}
function admittedAfter(query: string): AgentConfig[] {
  const breadth = detectGroupBreadth(query);
  return colleges.filter(a => {
    const grp = a.group as '단과대' | '대학원';
    return isCollegeReferenced(query, a) || breadth[grp];
  });
}

type Case = { q: string; expect: 'gain' | 'same-specific' | 'precision-zero' };
const CASES: Case[] = [
  // ── 빈틈 케이스: AFTER가 단과대/대학원을 끌어와야 함 ──
  { q: '각 단과대 현안이 뭐야?', expect: 'gain' },
  { q: 'AI 전공 어디서 배울 수 있어?', expect: 'gain' },
  { q: '대학원별 차이를 알려줘', expect: 'gain' },
  { q: '전문대학원 종류가 뭐가 있어?', expect: 'gain' },
  { q: '단과대학별 정원 알려줘', expect: 'gain' },
  { q: '학과별 강점 비교해줘', expect: 'gain' },
  // ── 특정 단과대 지칭: BEFORE == AFTER (정밀 라우팅 유지) ──
  { q: '공과대학 학과 알려줘', expect: 'same-specific' },
  { q: '경영대 vs 의대 비교', expect: 'same-specific' },
  // ── 정밀도 보존: 거버넌스 질문은 BEFORE==AFTER==0 (오염 0) ──
  { q: '역대 총장이 누구야?', expect: 'precision-zero' },
  { q: '서울대 재정 현황 알려줘', expect: 'precision-zero' },
  { q: '교원 인사 규정 심의 내역', expect: 'precision-zero' },
  { q: '이사회 정관 개정 안건', expect: 'precision-zero' },
];

const name = (a: AgentConfig) => a.name;
let pass = 0, fail = 0;

console.log(`\n총 위키: ${agents.length} (단과대/대학원 ${colleges.length}, 거버넌스 ${agents.length - colleges.length})`);
console.log('='.repeat(78));

for (const { q, expect } of CASES) {
  const before = admittedBefore(q);
  const after = admittedAfter(q);
  const gained = after.length - before.length;

  let ok: boolean;
  if (expect === 'gain') ok = gained > 0;
  else if (expect === 'same-specific') ok = before.length > 0 && after.length === before.length;
  else ok = before.length === 0 && after.length === 0; // precision-zero

  if (ok) pass++; else fail++;
  const tag = ok ? '✅' : '❌';
  console.log(`${tag} [${expect}] "${q}"`);
  console.log(`     BEFORE ${before.length}개${before.length ? ': ' + before.map(name).join(', ') : ''}`);
  console.log(`     AFTER  ${after.length}개${after.length ? ': ' + after.slice(0, 8).map(name).join(', ') + (after.length > 8 ? ' …' : '') : ''}`);
}

console.log('='.repeat(78));
console.log(`결과: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
