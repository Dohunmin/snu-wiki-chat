/**
 * 한 쿼리에 대해 senate 컨텍스트 raw를 직접 검사.
 * 5개 recency source가 모두 들어왔는지 + 각 source content 길이.
 */

import { routeQuery } from '@/lib/agents/router';

async function main() {
  const query = '평의원회 관련 정보 최근 5개 알려줘';
  console.log(`Query: "${query}"\n`);

  const routing = await routeQuery(query, 'admin');
  console.log(`선택된 위키: ${routing.selectedAgentIds.join(', ')}\n`);

  const senateCtx = routing.contexts.find((c: { agentId: string }) => c.agentId === 'senate');
  if (!senateCtx) { console.log('senate context 없음'); return; }
  const raw = (senateCtx as { relevantData: string }).relevantData;

  // 기대되는 date top-5 source IDs (가장 최신)
  const EXPECTED = [
    '19기-8차서면심의',
    '19기-7차',
    '19기-6차서면심의',
    '19기-5차',
    '19기-4차',
  ];

  console.log('Top-5 recency source 진입 확인:');
  for (const id of EXPECTED) {
    // header pattern: "## ... (id) | 회의일:" — id 뒤에 ) | 회의일: 가 있으면 진입
    const headerExists = raw.includes(`(${id}) | 회의일:`);

    // content size 추정: 같은 source의 본문이 얼마나 들어왔나
    // 다음 "## " 또는 "---" 까지의 거리로 측정
    let contentSize = 0;
    if (headerExists) {
      const headerIdx = raw.indexOf(`(${id}) | 회의일:`);
      const afterHeader = raw.slice(headerIdx);
      // 다음 source block 시작 ("\n---\n") 까지 거리
      const endIdx = afterHeader.indexOf('\n\n---\n\n');
      contentSize = endIdx > 0 ? endIdx : afterHeader.length;
    }

    console.log(`  ${headerExists ? '✅' : '❌'} ${id.padEnd(20)} ${headerExists ? `${contentSize} chars` : '(누락)'}`);
  }

  console.log(`\n전체 senate 컨텍스트: ${raw.length} chars`);
  console.log(`\n=== senate 컨텍스트 첫 800자 ===`);
  console.log(raw.slice(0, 800));
}

main().catch(err => { console.error(err); process.exit(1); });
