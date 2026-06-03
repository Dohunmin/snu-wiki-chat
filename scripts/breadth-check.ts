/**
 * 폭형 dispatch 검증 — step3 후 "7,8차"·"시간순 정리"가 senate/board를 dispatch하고
 * recency/회의록을 컨텍스트에 넣나. 생성 없음 = 과금 없음(routeQuery만, Voyage 임베딩/rerank 소액).
 *   GLOBAL_TOPK_ENABLED=true RERANK_ENABLED=true npx tsx --env-file=.env.local scripts/breadth-check.ts
 */
import { routeQuery } from '@/lib/agents/router';
import { enforceContextBudget } from '@/lib/agents/context-budget';

const QUERIES = [
  '가장 최근 이슈면 평의원회 7,8차 자료들이 나와야하는거 아니니? 그런 자료 내용은 왜 하나도 없니',
  'AI 대학원 설립 추진 경과와 의결 사항을 시간순으로 정리해줘',
];

async function main() {
  for (const q of QUERIES) {
    console.log('\n' + '█'.repeat(90));
    console.log('Q:', q.slice(0, 80));
    const r = await routeQuery(q, 'admin');
    const ctxs = await enforceContextBudget(q, r.contexts, Number(process.env.CONTEXT_BUDGET_CHARS ?? '14000'));
    console.log('dispatch 위키:', ctxs.map(c => c.agentId).join(', '));
    // 회의일(날짜) 마커 + 회차 추출 — recency/회의록 진입 여부
    for (const c of ctxs) {
      const dates = [...c.relevantData.matchAll(/회의일:\s*([\d-]+)/g)].map(m => m[1]);
      const sessions = [...c.relevantData.matchAll(/제?\s*\d+\s*기?\s*[^\n]{0,6}?제?\s*(\d+)\s*차/g)].map(m => m[0].trim().slice(0, 20));
      if (dates.length || sessions.length || /senate|board|평의원|이사회/.test(c.agentId + c.agentName)) {
        console.log(`  [${c.agentName}] conf=${c.confidence.toFixed(2)} | ${c.relevantData.length}자 | 회의일 ${dates.length}개${dates.length ? ' (최신:' + dates.slice(0, 3).join(',') + ')' : ''} | 회차마커 ${sessions.length}개`);
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
