/**
 * Citation Numbering 검증.
 * - buildNumberedContexts: source 번호 부여 + 헤더에 [N] 주입
 * - resolveText: [N] → [위키] sid
 * - extractCitedNumbers + resolveCitations: LLM 인용한 source만 추출
 *
 * Usage: npx tsx --env-file=.env.local scripts/test-citation-numbering.ts
 */

import { routeQuery } from '@/lib/agents/router';
import {
  buildNumberedContexts,
  resolveText,
  extractCitedNumbers,
  resolveCitations,
  safeFlushPoint,
} from '@/lib/llm/citations';

async function main() {
  // 1) safeFlushPoint 단위 테스트
  console.log('=== safeFlushPoint ===');
  const cases: [string, number][] = [
    ['plain text', 10],                  // 전체 flush
    ['text [1]', 8],                     // 완성된 [1] → 전체
    ['text [1] more', 13],               // 전체
    ['text [', 5],                       // 미완성 [ → [ 위치
    ['text [1', 5],                      // 미완성 [1 → [ 위치
    ['text [12', 5],                     // 미완성 [12 → [ 위치
    ['text [1] then [3', 14],            // 마지막 [ 미완성 — position 14 ([3 시작)
  ];
  for (const [input, expected] of cases) {
    const got = safeFlushPoint(input);
    console.log(`  ${got === expected ? '✅' : '❌'} "${input}" → ${got} (expected ${expected})`);
  }

  // 2) 실제 라우팅 + 번호 매핑
  const query = '평의원회 관련 정보 최근 5개 알려줘';
  console.log(`\n=== Query: "${query}" ===`);
  const routing = await routeQuery(query, 'admin');
  console.log(`선택된 위키: ${routing.selectedAgentIds.join(', ')}`);

  const numbered = buildNumberedContexts(routing.contexts);
  console.log(`\n총 source 수: ${numbered.mapping.size}`);
  console.log(`\n매핑 요약 (앞 10개):`);
  Array.from(numbered.mapping.entries()).slice(0, 10).forEach(([n, ref]) => {
    console.log(`  [${n}] [${ref.wiki}] ${ref.page} ${ref.topic ? `(${ref.topic})` : ''}`);
  });

  // 3) contextMarkdown 안에 [N] 마커 주입 확인
  const markerCount = (numbered.contextMarkdown.match(/##\s+(?:\[(?:source|fact|stance|overview|entity)\]\s+)?\[\d+\]/g) ?? []).length;
  console.log(`\n본문 헤더에 [N] 마커 주입: ${markerCount}개`);

  // 4) resolveText 시뮬레이션 — LLM이 [3] 인용했다고 가정
  const sampleResponse = `평의원회는 등록금 동결을 의결했습니다 [1]. AI대학원 설립계획이 검토되었습니다 [3]. 추가로 [2]에서도 다뤘습니다.`;
  console.log(`\n=== resolveText 시뮬레이션 ===`);
  console.log(`LLM 원본: ${sampleResponse}`);
  const resolved = resolveText(sampleResponse, numbered.mapping);
  console.log(`Resolve 후: ${resolved}`);

  // 5) extractCitedNumbers + resolveCitations
  const cited = extractCitedNumbers(sampleResponse);
  console.log(`\n인용 번호: [${Array.from(cited).join(', ')}]`);
  const citedRefs = resolveCitations(cited, numbered.mapping);
  console.log(`Resolved sources (LLM이 실제 인용):`);
  citedRefs.forEach(r => console.log(`  - [${r.wiki}] ${r.page}`));

  // 6) 비교: 기존 방식 (모든 retrieved) vs 새 방식 (cited only)
  const allRetrieved = routing.contexts.flatMap(c => c.sources);
  console.log(`\n=== 비교 ===`);
  console.log(`기존: routing.contexts.flatMap(c => c.sources) → ${allRetrieved.length}개`);
  console.log(`개선: LLM cited → ${citedRefs.length}개`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
