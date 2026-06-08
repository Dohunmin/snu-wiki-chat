// 단과대 크롤링 현황 문서 생성기.
// wiki/{overviews,entities}/{org}/*.md 프론트매터(source_url·category·entity_type·제목)를 실측 수집 +
// colleges.yaml 설정 대비 미수집(skipped) 도출 → SNU_단과대_LLM_Wiki/크롤링_현황.md 작성.
// 사용: npx tsx scripts/crawl/_gen-manifest.ts

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getOrgsByWiki } from '../../lib/config/orgs';
import type { Org } from '../../lib/config/orgs';

const OBSIDIAN = process.env.OBSIDIAN_PATH ?? join(process.cwd(), '..', 'Obsidian');
const WIKI = join(OBSIDIAN, 'SNU_단과대_LLM_Wiki', 'wiki');
const TODAY = '2026-06-03';

interface PageRow { type: string; title: string; url: string; slug: string }

function fm(text: string, key: string): string {
  return text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '') ?? '';
}
function title(text: string): string {
  return text.match(/^#\s+(.+)$/m)?.[1].trim() ?? '';
}
function readDir(dir: string): { slug: string; text: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .map((f) => ({ slug: f.replace(/\.md$/, ''), text: readFileSync(join(dir, f), 'utf-8') }));
}

// 미수집 사유(알려진 것). slug별.
const SKIP_REASON: Record<string, string> = {
  'dept-cuee': 'JS 프레임(GoPage) — 헤드리스 필요',
  'dept-architecture': '이 환경 접속차단(ECONNREFUSED) — 다른 출구IP/헤드리스',
  vision: '비전 페이지가 이미지 기반(텍스트 거의 없음)',
  dept: 'WordPress 슬러그가 빈 페이지/리다이렉트',
  'dept-pharmacy': 'WP 페이지 본문 0자',
  'dept-manufacturing-pharmacy': 'WP 페이지 본문 0자',
  faculty: '교수 디렉토리 페이지에 총원 수 미표기(추출 불가) — eng만 추출됨',
};

// 단과대 공통 미수집(전 org).
const COMMON_TODO = [
  '📄 **규정집·내규(2c)** — 각 단과대 규정자료실 PDF/HWP. 거버넌스 1급 문서이나 PDF 파싱 신규 필요(미수집).',
  '📰 **소식지·공지·뉴스(Tier4/2c)** — 게시판은 앱 DB live_cache 설계(.md 미생성). 소식지 PDF는 2c 보류.',
  '🎓 **대학원 섹션** — 각 단과대 사이트의 대학원 과정 정보(grad-general 공유분). 별도 Phase에서.',
];

function classify(category: string, entityType: string, type: string): string {
  if (type === 'entity') return entityType || '학과';
  return category || '소개';
}

function orgSection(org: Org): string {
  const ov = readDir(join(WIKI, 'overviews', org.id));
  const en = readDir(join(WIKI, 'entities', org.id));
  const rows: PageRow[] = [];
  for (const { slug, text } of ov) rows.push({ slug, type: classify(fm(text, 'category'), '', 'overview'), title: title(text), url: fm(text, 'source_url') });
  for (const { slug, text } of en) rows.push({ slug, type: classify(fm(text, 'category'), fm(text, 'entity_type'), 'entity'), title: title(text), url: fm(text, 'source_url') });

  // 설정 대비 미수집 도출
  const haveSlugs = new Set(rows.map((r) => r.slug));
  const configured: { slug: string; label: string }[] = [];
  for (const k of ['greeting', 'history', 'vision'] as const) if (org.urls[k]) configured.push({ slug: k, label: k });
  for (const a of org.about_pages ?? []) configured.push({ slug: a.slug, label: a.slug });
  for (const e of org.entity_pages ?? []) configured.push({ slug: e.slug, label: e.label });
  for (const s of org.strategy_pages ?? []) configured.push({ slug: s.slug, label: s.label });
  const skipped = configured.filter((c) => !haveSlugs.has(c.slug));

  const L: string[] = [];
  L.push(`### ${org.display_name} \`${org.id}\``);
  if (!org.active) {
    L.push(`> ⛔ **비활성** — ${org.notes ?? ''}`, '');
    return L.join('\n');
  }
  const facLine = org.faculty ? ` · 교수 디렉토리 → Tier3(DB)` : '';
  L.push(`- **크롤 소스**: \`${org.domain}\` (${org.adapter_key})${en.some((e) => /https?:\/\//.test(fm(e.text, 'source_url')) && !fm(e.text, 'source_url').includes(org.domain ?? '###')) ? ' + 학과 외부 마이크로사이트' : ''}${facLine}`);
  L.push(`- **수집**: overview ${ov.length} · entity ${en.length} (학과 ${en.filter((e) => fm(e.text, 'entity_type') === '학과').length} · 부속기관 ${en.filter((e) => fm(e.text, 'entity_type') === '부속기관').length})`, '');

  L.push('| 유형 | 제목 | 실제 크롤 URL |', '|---|---|---|');
  // 유형 순서: 소개/인사말 → 연혁 → 비전 → 전략 → 학과 → 부속기관
  const order = ['소개', '연혁', '비전', '전략', '학과', '부속기관'];
  rows.sort((a, b) => (order.indexOf(a.type) - order.indexOf(b.type)) || a.slug.localeCompare(b.slug));
  for (const r of rows) L.push(`| ${r.type} | ${r.title} | ${r.url} |`);
  L.push('');

  if (skipped.length) {
    L.push('**미수집(설정됐으나 스킵):**');
    for (const s of skipped) L.push(`- \`${s.slug}\` (${s.label}) — ${SKIP_REASON[s.slug] ?? '본문 미달/404'}`);
    L.push('');
  }
  return L.join('\n');
}

function main(): void {
  const orgs = getOrgsByWiki('단과대');
  const active = orgs.filter((o) => o.active);

  const out: string[] = [];
  out.push('# SNU 단과대 크롤링 현황 (Crawl Manifest)', '');
  out.push(`> 각 단과대별 **크롤 소스 사이트 · 페이지 유형 · 실제 URL · 미수집 항목**. 자동 생성(\`scripts/crawl/_gen-manifest.ts\`).`);
  out.push(`> 기준: \`wiki/{overviews,entities}/{org}/\` 프론트매터 \`source_url\` 실측 + \`colleges.yaml\` 설정 대비. 생성일 ${TODAY}.`, '');

  // 요약 표
  out.push('## 📊 전체 요약', '');
  out.push('| 단과대 | 도메인 | 엔진 | overview | 학과 | 연구소 | 상태 |', '|---|---|---|--:|--:|--:|---|');
  for (const o of orgs) {
    const ov = readDir(join(WIKI, 'overviews', o.id));
    const en = readDir(join(WIKI, 'entities', o.id));
    const dept = en.filter((e) => fm(e.text, 'entity_type') === '학과').length;
    const inst = en.filter((e) => fm(e.text, 'entity_type') === '부속기관').length;
    const st = !o.active ? '⛔ 비활성(robots 등)' : ov.length + en.length === 0 ? '미수집' : '✅';
    out.push(`| ${o.display_name} | ${o.domain ?? '-'} | ${o.adapter_key} | ${ov.length} | ${dept} | ${inst} | ${st} |`);
  }
  out.push('');

  // 수치 위치
  out.push('## 🔢 수치(통계)는 어디에?', '');
  out.push('- **서술형**: 일부 `현황`·`학과` overview/entity 본문에 교원수·학생수·정원이 문장으로 포함(예: 자연대 현황, 수리과학부 "교원37·학부200").');
  out.push('- **구조화**: 학과수·교원수·대표 연락처는 앱 DB **Tier3 `structured_facts`**에 저장(크롤 로그 `fact N건`). 위키 `fact`(§F) 페이지로는 미출력(중복 방지).');
  out.push('- 즉 **수치 자체는 크롤됨** — 다만 별도 `fact` .md가 아니라 본문 + DB에 있음.', '');

  // 공통 미수집
  out.push('## 🧩 공통 미수집 / 해야 할 것 (전 단과대)', '');
  for (const t of COMMON_TODO) out.push(`- ${t}`);
  out.push('- 🌐 **외부 학과 마이크로사이트 보완**: 공대 cuee·architecture(헤드리스 필요).');
  out.push('- 🔢 **faculty 총원**: eng만 추출(329). 나머지는 디렉토리에 총원 미표기 → 미수집.', '');

  // 단과대별 상세
  out.push('## 🏛 단과대별 상세', '');
  for (const o of orgs) out.push(orgSection(o), '');

  out.push('---', `*활성 단과대 ${active.length}/${orgs.length}. 페이지 합계: overview ${orgs.reduce((n, o) => n + readDir(join(WIKI, 'overviews', o.id)).length, 0)} · entity ${orgs.reduce((n, o) => n + readDir(join(WIKI, 'entities', o.id)).length, 0)}.*`);

  const path = join(OBSIDIAN, 'SNU_단과대_LLM_Wiki', '크롤링_현황.md');
  writeFileSync(path, out.join('\n'), 'utf-8');
  console.log(`작성: ${path}`);
  console.log(`활성 ${active.length}/${orgs.length} 단과대.`);
}

main();
