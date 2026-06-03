/**
 * 풀 파이프라인 추적 — "트랙별 연구평가" 질문에서 성과연봉제/트랙 내용이 *최종 컨텍스트*까지 살아남나.
 * route → enforceContextBudget(rerank) 후 실제 LLM 입력 컨텍스트를 검사. LLM 생성 없음(~$0.0002).
 *   npx tsx --env-file=.env.local scripts/trace-track.ts
 */
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';
import { complexityBudget, classifyComplexity } from '@/lib/agents/complexity';

const Q = '트랙별 연구평가 제도가 실제로 제도화 되었는가?';
const MARK = /연봉|트랙|연구평가|성과중시|성과 중시/;

function probe(label: string, ctxs: { agentName: string; relevantData: string }[]) {
  console.log(`\n── ${label} ──`);
  let total = 0;
  for (const c of ctxs) {
    total += c.relevantData.length;
    const hits = (c.relevantData.match(new RegExp(MARK, 'g')) ?? []).length;
    // 블록 제목(## ...) 중 마커 포함한 것
    const markedTitles = c.relevantData.split('\n')
      .filter(l => l.startsWith('## ') && MARK.test(l))
      .map(l => l.slice(3, 60));
    console.log(`  [${c.agentName}] ${c.relevantData.length}자 | 마커 ${hits}회${markedTitles.length ? ` | 제목: ${markedTitles.join(' / ')}` : ''}`);
  }
  console.log(`  계 ${total}자`);
  return total;
}

async function main() {
  console.log(`Q: "${Q}"`);
  console.log(`복잡도: ${classifyComplexity(Q)} / 예산: ${complexityBudget(Q)}자`);

  const routing = await routeQuery(Q, 'tier1');
  console.log(`라우팅: ${routing.selectedAgentIds.join(', ')}`);

  const before = probe('rerank/budget 전 (getContext 원본)', routing.contexts);
  const budget = complexityBudget(Q);
  const budgeted = await enforceContextBudget(Q, routing.contexts, budget);
  const after = probe(`rerank/budget 후 (예산 ${budget}자)`, budgeted);

  console.log(`\n결론: 예산 ${budget}자 vs 원본 ${before}자 → ${before <= budget ? '예산 미달(컷 없음)' : '예산 초과(컷 발생)'}`);
  const beforeHas = routing.contexts.some(c => MARK.test(c.relevantData));
  const afterHas = budgeted.some(c => MARK.test(c.relevantData));
  console.log(`성과연봉제/트랙 내용: getContext원본=${beforeHas ? '있음' : '없음'} → 최종컨텍스트=${afterHas ? '있음 ✓' : '없음 ✗'}`);
  if (beforeHas && !afterHas) console.log('  → rerank가 떨어뜨림 (precision 컷)');
  if (!beforeHas) console.log('  → getContext가 애초에 안 뽑음 (recall 누수)');
  if (afterHas) console.log('  → 컨텍스트엔 있음 → 문제는 *생성*(LLM이 연봉제를 트랙평가로 연결 못함)일 가능성');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
