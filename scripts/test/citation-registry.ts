/**
 * CitationRegistry 단위 테스트 (Phase A 무회귀 게이트).
 *   ① 단일 add() == 기존 buildNumberedContexts (byte-identical) — 리팩터 무회귀 구조 검증.
 *   ② 여러 add()에 걸친 [N] 누적·dedup — agent-loop 핵심(같은 source=같은 [N], 새 source=다음 번호).
 *   ③ 제목에 괄호가 있어도 sid 앵커링 유지(H-5).
 *
 * 실행: npx tsx scripts/test/citation-registry.ts  (DB·API 불필요 — 순수 함수)
 */
import { buildNumberedContexts, CitationRegistry } from '../../lib/llm/citations';
import type { AgentContext } from '../../lib/agents/types';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function ctx(agentName: string, body: string, sources: AgentContext['sources']): AgentContext {
  return { agentId: agentName, agentName, relevantData: body, sources, confidence: 0.8 };
}

// ── 합성 컨텍스트 (실제 헤더 포맷 모사) ──────────────────────────────
const senate = ctx(
  '평의원회',
  `## 19기 7차 회의록 (19기-7차) | 회의일: 2024-03-15\n본문 내용 A.\n\n## [stance] 등록금 동결 입장 (등록금동결.stance) | holder: 평의원회\n입장 내용.`,
  [
    { wiki: '평의원회', page: '19기-7차', topic: undefined },
    { wiki: '평의원회', page: '등록금동결.stance', topic: 'stance' },
  ],
);
const board = ctx(
  '이사회',
  `## 2023년 3차 이사회 (의결안건 포함) (2023-3차) | 회의일: 2023-09-01\n이사회 본문.`,
  [{ wiki: '이사회', page: '2023-3차', topic: undefined }],
);

// ── ① 단일 add() == buildNumberedContexts ───────────────────────────
console.log('\n[1] 단일 배치 byte-identical (무회귀)');
{
  const legacy = buildNumberedContexts([senate, board]);
  const reg = new CitationRegistry();
  const md = reg.add([senate, board]);
  check('contextMarkdown 동일', md === legacy.contextMarkdown,
    `legacy.len=${legacy.contextMarkdown.length} reg.len=${md.length}`);
  check('summary 동일', reg.summary === legacy.summary,
    `\n      legacy: ${JSON.stringify(legacy.summary)}\n      reg:    ${JSON.stringify(reg.summary)}`);
  const sameMapping =
    reg.mapping.size === legacy.mapping.size &&
    [...legacy.mapping.entries()].every(([n, r]) => {
      const g = reg.mapping.get(n);
      return g && g.wiki === r.wiki && g.page === r.page && g.title === r.title && g.topic === r.topic;
    });
  check('mapping 동일', sameMapping);
  check('번호 1..3 부여', legacy.mapping.size === 3 && legacy.mapping.has(1) && legacy.mapping.has(3));
}

// ── ② 누적·dedup ────────────────────────────────────────────────────
console.log('\n[2] 다중 배치 누적 + dedup');
{
  const reg = new CitationRegistry();
  reg.add([senate]);                       // [1]=19기-7차, [2]=등록금동결.stance
  const sizeAfterFirst = reg.mapping.size;
  const md2 = reg.add([senate, board]);    // senate 중복 → 같은 [N], board 신규 → [3]
  check('첫 배치 2개 부여', sizeAfterFirst === 2);
  check('중복 source 재부여 안 함(누적 3개)', reg.mapping.size === 3,
    `mapping.size=${reg.mapping.size}`);
  check('두 번째 배치 본문이 기존 [1] 재사용', md2.includes('[1]'),
    'senate가 두 번째 배치에서 새 번호가 아니라 기존 [1]을 받아야 함');
  check('board는 새 번호 [3]', reg.mapping.get(3)?.page === '2023-3차',
    `mapping[3]=${JSON.stringify(reg.mapping.get(3))}`);
  // 번호 연속성: 1,2,3 모두 존재, 4 없음
  check('번호 연속(1,2,3) / 중복 미증가', reg.mapping.has(1) && reg.mapping.has(2) && reg.mapping.has(3) && !reg.mapping.has(4));
}

// ── ③ 제목 괄호 + sid 앵커링(H-5) ───────────────────────────────────
console.log('\n[3] 제목에 괄호 있어도 sid 앵커링');
{
  const reg = new CitationRegistry();
  const md = reg.add([board]);  // 제목: "2023년 3차 이사회 (의결안건 포함)" + sid (2023-3차)
  const ref = reg.mapping.get(1);
  check('sid를 (2023-3차)로 정확 캡쳐', ref?.page === '2023-3차', `page=${ref?.page}`);
  check('본문에 sid(2023-3차) 노출 안 됨', !md.includes('(2023-3차)'),
    'showSourceId=false 기본 → 본문에서 sid 제거되어야 함');
  check('본문에 [1] 주입', md.includes('[1]'));
  check('제목 괄호(의결안건 포함)는 보존', md.includes('(의결안건 포함)'));
}

// ── ④ addOnlyNew — 겹침 제외, 새 source만 ───────────────────────────
console.log('\n[4] addOnlyNew — 이미 본 source 제외');
{
  const reg = new CitationRegistry();
  reg.add([senate]);                          // [1]=19기-7차, [2]=등록금동결.stance
  const md = reg.addOnlyNew([senate, board]); // senate 중복→제외, board만 신규 [3]
  check('새 source(board) [3] 포함', md.includes('[3]') && md.includes('2023년 3차'));
  check('겹친 senate 내용 제외', !md.includes('19기 7차') && !md.includes('등록금'),
    `md=${JSON.stringify(md.slice(0, 80))}`);
  check('mapping 누적 3개', reg.mapping.size === 3, `size=${reg.mapping.size}`);
  const empty = reg.addOnlyNew([senate]);     // 전부 기존 → ''
  check('새 게 없으면 빈 문자열', empty === '', `got=${JSON.stringify(empty.slice(0, 40))}`);
}

console.log(`\n${failures === 0 ? '✅ 전체 통과' : `❌ ${failures}건 실패`}`);
process.exit(failures === 0 ? 0 : 1);
