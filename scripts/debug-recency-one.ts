/**
 * 한 쿼리에 대해 senate 컨텍스트의 모든 청크를 source별 점수와 함께 출력.
 * 19기-7차/3차가 왜 누락되는지 분석용.
 */

import { routeQuery } from '@/lib/agents/router';

process.env.RAG_DEBUG = 'true';

async function main() {
  const query = '평의원회 관련 정보 최근 5개 알려줘';
  console.log(`Query: "${query}"\n`);

  const routing = await routeQuery(query, 'admin');
  console.log(`\n선택된 위키: ${routing.selectedAgentIds.join(', ')}\n`);

  const senateCtx = routing.contexts.find((c: { agentId: string }) => c.agentId === 'senate');
  if (!senateCtx) {
    console.log('senate context 없음');
    return;
  }

  const raw = (senateCtx as { relevantData: string }).relevantData;

  // 헤더에서 source ID + 회의일 추출
  const pattern = /## ([^|]+?)\(([^)]+)\)(?:\s*\|\s*회의일:\s*(\S+))?/g;
  const sources = new Map<string, { count: number; date?: string }>();
  let m;
  while ((m = pattern.exec(raw)) !== null) {
    const sid = m[2].trim();
    const date = m[3];
    const existing = sources.get(sid);
    if (existing) {
      existing.count++;
      if (date && !existing.date) existing.date = date;
    } else {
      sources.set(sid, { count: 1, date });
    }
  }

  console.log('senate 컨텍스트에 등장한 source (chunk 수 기준):');
  const entries = Array.from(sources.entries()).sort((a, b) => b[1].count - a[1].count);
  for (const [sid, info] of entries) {
    const isGi19 = sid.startsWith('19기');
    console.log(`  ${isGi19 ? '🆕' : '  '} ${sid.padEnd(20)} chunks: ${info.count} ${info.date ? `| ${info.date}` : ''}`);
  }

  console.log(`\n총 chunk 수: ${Array.from(sources.values()).reduce((a, b) => a + b.count, 0)}`);
  console.log(`총 source 수: ${sources.size}`);
  console.log(`전체 컨텍스트 길이: ${raw.length} chars`);

  // 19기 누락 명확히
  const expected19 = ['19기-1차', '19기-2차', '19기-3차', '19기-4차', '19기-5차', '19기-6차서면심의', '19기-7차', '19기-8차서면심의'];
  const missing = expected19.filter(id => !sources.has(id));
  console.log(`\n19기 자료 진입: ${expected19.filter(id => sources.has(id)).join(', ')}`);
  console.log(`19기 자료 누락: ${missing.length > 0 ? missing.join(', ') : '(없음)'}`);
}

main().catch(err => { console.error(err); process.exit(1); });
