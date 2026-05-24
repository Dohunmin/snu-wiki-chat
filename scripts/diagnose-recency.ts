/**
 * Recency 진단 — 두 가지 영역 검증:
 *   1) RECENCY_QUERIES — 시간성 쿼리에 19기-7차/8차가 senate 컨텍스트에 진입하는지 (SC1)
 *   2) REGRESSION_QUERIES — 비-시간성 쿼리는 결과 변화 없어야 함 (SC2, 회귀 확인용)
 *
 * Usage: npx tsx --env-file=.env.local scripts/diagnose-recency.ts
 */

import { routeQuery } from '@/lib/agents/router';

const RECENCY_QUERIES = [
  '평의원회 최근 이슈 알려줘',
  '최근 평의원회에서 논의된 내용',
  '이번 평의원회 안건',
  '평의원회 19기 최신 회의록',
  '평의원회 진행 상황',
];

// SC2 회귀 확인용 — 시간성 키워드 없음. 이전 동작과 동일해야 함
const REGRESSION_QUERIES = [
  '교육 분야 안건',
  'AI 정책',
  '이사회 의결사항',
  '재정 현황',
  '캠퍼스 인프라',
];

const RECENT_IDS = ['19기-8차서면심의', '19기-7차', '19기-6차서면심의'];

interface QueryResult {
  query: string;
  selectedWikis: string[];
  senateHeaders: string[];
  recentHits: string[];
}

async function diagnose(query: string): Promise<QueryResult> {
  const routing = await routeQuery(query, 'admin');
  const senateCtx = routing.contexts.find((c: { agentId: string }) => c.agentId === 'senate');
  const headers: string[] = senateCtx
    ? (senateCtx as { relevantData: string }).relevantData.match(/^##\s+.+$/gm) ?? []
    : [];
  const recentHits = RECENT_IDS.filter(id => headers.some(h => h.includes(id)));
  return {
    query,
    selectedWikis: routing.selectedAgentIds,
    senateHeaders: headers,
    recentHits,
  };
}

function printRecencySection(results: QueryResult[]) {
  console.log('\n' + '═'.repeat(80));
  console.log(' SC1 — 시간성 쿼리 (19기-7차/8차 진입 확인)');
  console.log('═'.repeat(80));

  let passedCount = 0;
  for (const r of results) {
    const passed = r.recentHits.length > 0;
    if (passed) passedCount++;
    console.log(`\n[${passed ? '✅' : '❌'}] "${r.query}"`);
    console.log(`    위키: ${r.selectedWikis.join(', ')}`);
    console.log(`    senate 헤더 ${r.senateHeaders.length}개. 최신 source 진입: ${r.recentHits.length > 0 ? r.recentHits.join(', ') : '(없음)'}`);
  }

  console.log('\n' + '─'.repeat(80));
  console.log(`SC1 결과: ${passedCount}/${results.length} 쿼리에서 최신 source 진입 (목표: 4/5 이상)`);
  console.log(`판정: ${passedCount >= 4 ? '✅ PASS' : '❌ FAIL'}`);
}

function printRegressionSection(results: QueryResult[]) {
  console.log('\n' + '═'.repeat(80));
  console.log(' SC2 — 비-시간성 쿼리 (회귀 확인 — 라우팅·헤더 셋)');
  console.log('═'.repeat(80));

  for (const r of results) {
    console.log(`\n"${r.query}"`);
    console.log(`    위키: ${r.selectedWikis.join(', ')}`);
    console.log(`    senate 헤더 ${r.senateHeaders.length}개`);
    if (r.senateHeaders.length > 0) {
      const sample = r.senateHeaders.slice(0, 5).map(h => h.slice(0, 70));
      console.log(`    샘플: ${sample.join(' | ')}`);
    }
  }
  console.log('\n' + '─'.repeat(80));
  console.log('SC2 판정: git history와 비교해 라우팅·헤더 셋이 동일하면 통과 (수동 확인)');
}

async function main() {
  console.log('Recency Boost 진단 시작...\n');

  const recencyResults: QueryResult[] = [];
  for (const q of RECENCY_QUERIES) recencyResults.push(await diagnose(q));

  const regressionResults: QueryResult[] = [];
  for (const q of REGRESSION_QUERIES) regressionResults.push(await diagnose(q));

  printRecencySection(recencyResults);
  printRegressionSection(regressionResults);

  console.log('\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
