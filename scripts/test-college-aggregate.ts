/**
 * cross-college 집계 라우팅 검증 — "각 단과대별 학과" 가 단과대 위키를 선택하고
 * 학과명이 컨텍스트에 들어오나. 무료(Voyage 검색만, 생성 0).
 *   $env:RERANK_ENABLED='true'; npx tsx --env-file=.env.local scripts/test-college-aggregate.ts
 */
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget } from '@/lib/agents/complexity';
import { buildNumberedContexts } from '@/lib/llm/citations';

const QS = [
  '각 단과대별 어떤 하위 학과들이 있어?',
  '공대 전공 추천해줘',   // 집계 아님 — 공대만 와야(과오염 체크)
];
const ROLE = 'admin' as const;

async function main() {
  for (const Q of QS) {
    const routing = await routeQuery(Q, ROLE);
    const ctxs = await enforceContextBudget(Q, routing.contexts, complexityBudget(Q));
    const numbered = buildNumberedContexts(ctxs);
    console.log(`\n══ Q: ${Q} ══`);
    console.log(`선택 위키(${routing.selectedAgentIds.length}): ${routing.selectedAgentIds.join(', ')}`);
    console.log(`컨텍스트: ${numbered.contextMarkdown.length}자`);
    const depts: Record<string, string> = {
      '국어국문학과': 'humanities', '기계공학과': 'eng', '경제학부': 'social',
      '수리과학부': 'science', '농경제사회학부': 'agriculture', '간호': 'nursing',
    };
    let hit = 0;
    for (const [dept, wiki] of Object.entries(depts)) {
      const ok = numbered.contextMarkdown.includes(dept);
      if (ok) hit++;
      console.log(`   ${ok ? '✅' : '❌'} ${dept} (${wiki})`);
    }
    console.log(`   → 학과명 ${hit}/${Object.keys(depts).length} 컨텍스트 진입`);
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
