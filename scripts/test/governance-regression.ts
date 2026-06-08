// Design Ref: college-grad-wiki §8.4 (SC-7/SC-8 회귀) — governance 코드경로 불변 가드.
// 목적: per-college 피봇이 기존 9위키 governance 흐름을 한 줄도 바꾸지 않았음을 결정적으로(무료·무DB·무API) 검증.
//   - 벡터 경로(searchVector/searchVectorGlobal/global-retrieve/chunker/types/schema)에 college/tier 없음
//   - tier/college는 router에서 group('단과대'|'대학원') 게이트로만 set
//   - route.ts T3/T4 직답은 tier===3|4 가드 (governance=undefined→skip)
//   - 9 governance agent 존재 + group 필드 없음
// 실행: npx tsx scripts/test/governance-regression.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name); console.log(`  ✗ ${name}`); }
}

console.log('\n[governance-regression] SC-7/SC-8 — per-college 격리·governance 불변\n');

// ── (A) 벡터 경로: college/tier 부재 (per-wiki searchVector byte-identical) ──
const search = read('lib/embed/search.ts');
check('search.ts: searchVectorGlobal opts에 college/tier 없음',
  !/opts:\s*\{[^}]*\bcollege\?/.test(search) && !/opts:\s*\{[^}]*\btier\?/.test(search));
check('search.ts: collegeFilter/tierFilter SQL 없음',
  !/collegeFilter|tierFilter/.test(search));
check('search.ts: chunk_embeddings에 college/tier 컬럼 참조 없음',
  !/\bcollege\s*=|\btier\s*=\s*\$\{/.test(search));

const gretr = read('lib/embed/global-retrieve.ts');
check('global-retrieve.ts: GlobalTopKOptions에 college/tier 없음',
  !/\bcollege\?:|\btier\?:/.test(gretr));
check('global-retrieve.ts: searchVectorGlobal 호출에 college/tier 미전달',
  !/searchVectorGlobal\([^)]*college/.test(gretr));

const chunker = read('lib/embed/chunker.ts');
check('chunker.ts: metadata에 college/tier stamp 없음', !/\bcollege\b|\btier\b/.test(chunker));

const embedTypes = read('lib/embed/types.ts');
check('embed/types.ts: ChunkMetadata에 college/tier 없음', !/\bcollege\b|\btier\b/.test(embedTypes));

// ── (B) DB 스키마: chunk_embeddings 무변경, 신규는 structured_facts/live_cache 2개만 ──
const schema = read('lib/db/schema.ts');
const chunkBlock = schema.slice(schema.indexOf('chunkEmbeddings'), schema.indexOf('limitationQuestions'));
check('schema.ts: chunk_embeddings 블록에 college/tier 컬럼 없음',
  !/college|tier/.test(chunkBlock));
check('schema.ts: structured_facts 테이블 추가됨', /structuredFacts\s*=\s*pgTable\('structured_facts'/.test(schema));
check('schema.ts: live_cache 테이블 추가됨', /liveCache\s*=\s*pgTable\('live_cache'/.test(schema));

// ── (C) wiki-agent: collegeFilter 없음 ──
const wikiAgent = read('lib/agents/wiki-agent.ts');
check('wiki-agent.ts: collegeFilter/college 전달 없음', !/collegeFilter|\.college\b/.test(wikiAgent));

// ── (D) router: tier/college는 group 게이트로만 set ──
const router = read('lib/agents/router.ts');
// group 게이트(cSel/collegeSel: 선택된 agent 중 group==='단과대'|'대학원') 존재
check('router.ts: group 게이트(단과대|대학원) 존재',
  /group === '단과대'/.test(router) && /group === '대학원'/.test(router));
// tier/college: 콜론 할당 라인(글로벌 경로)은 게이트 변수(cSel) 참조 — 코드 라인만(주석 제외)
const tierCollegeLines = router.split('\n').filter(l => /\btier:|\bcollege:/.test(l) && !/^\s*\*|^\s*\/\//.test(l));
check('router.ts: tier/college 콜론 할당은 모두 게이트 변수 참조',
  tierCollegeLines.length >= 1 && tierCollegeLines.every(l => /cSel|collegeSel/.test(l)));
// 일반 경로: const tier = collegeSel ? classifyTier / const college = collegeSel?.agent.config.id
check('router.ts: 일반 경로 tier/college는 collegeSel 게이트로만 산출',
  /const tier = collegeSel \? classifyTier\(query\) : undefined/.test(router) &&
  /const college = collegeSel\?\.agent\.config\.id/.test(router));

// ── (E) route.ts: T3/T4 직답은 tier===3|4 가드 ──
const route = read('app/api/chat/route.ts');
check('route.ts: 직답 분기가 routing.tier===3||===4 && routing.college 가드',
  /routing\.tier === 3 \|\| routing\.tier === 4\) && routing\.college/.test(route));
check('route.ts: streamDirectAnswer는 direct 적중 시에만 호출(미스→fall through)',
  /if \(direct\) \{[\s\S]*?streamDirectAnswer/.test(route));

// ── (F) agents.config: 9 governance agent 존재 + group 필드 없음 ──
const cfgRaw = read('data/agents.config.json');
const cfg = JSON.parse(cfgRaw) as { agents: { id: string; group?: string }[] };
const GOV9 = ['senate', 'board', 'plan', 'vision', 'history', 'status', 'yhl-speeches', 'finance', 'leesj'];
const ids = new Set(cfg.agents.map(a => a.id));
check('agents.config: 9 governance agent 전부 존재', GOV9.every(id => ids.has(id)));
check('agents.config: governance agent에 group 필드 없음',
  cfg.agents.filter(a => GOV9.includes(a.id)).every(a => a.group === undefined));
check('agents.config: group 필드는 단과대/대학원에만(현재 0개 — 빌드 전)',
  cfg.agents.every(a => a.group === undefined || a.group === '단과대' || a.group === '대학원'));

// ── 결과 ──
console.log(`\n[governance-regression] ${pass} pass / ${fails.length} fail`);
if (fails.length) {
  console.log('실패:');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('✅ governance 코드경로 불변 — per-college 격리 확인 (SC-7/SC-8)\n');
process.exit(0);
