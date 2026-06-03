// Design Ref: college-grad-wiki §5.3 (메타헤더 주입) / plan §3.2 (§F + §4.2 병합)
// 클렌징된 MainContent → Obsidian .md. §F frontmatter + 크롤 메타(college/org_type/phase/tier/source_url/fetched_at).
// 경계: Tier1/2만 .md(=Obsidian). Tier3/4는 앱 DB(여기서 안 씀).

import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import yaml from 'js-yaml';
import type { Org, ParentWiki } from '../config/orgs';
import type { Category, MainContent, Tier } from './types';

const OBSIDIAN_PATH = process.env.OBSIDIAN_PATH ?? join(process.cwd(), '..', 'Obsidian');
const WIKI_DIR: Record<Org['parent_wiki'], string> = {
  단과대: 'SNU_단과대_LLM_Wiki',
  대학원: 'SNU_대학원_LLM_Wiki',
};
const ORG_TYPE_KO: Record<Org['org_type'], string> = {
  undergraduate: '단과대학',
  graduate_general: '일반대학원',
  graduate_professional: '전문대학원',
  university_college: '학부대학',
};

type PageType = 'overview' | 'fact' | 'source' | 'entity';

/** pageType → wiki 디렉토리명 (entity→entities, 단순 +s 아님). */
const PAGE_DIR: Record<PageType, string> = {
  overview: 'overviews',
  fact: 'facts',
  source: 'sources',
  entity: 'entities',
};

/** category → (pageType, tier). greeting/history/vision/dept/about→overview, stats→fact, archive→source(T2), entity→entity. */
export function categoryToPage(cat: Category): { pageType: PageType; tier: Tier } {
  if (cat === 'stats') return { pageType: 'fact', tier: 1 };
  if (cat === 'archive') return { pageType: 'source', tier: 2 };
  if (cat === 'entity') return { pageType: 'entity', tier: 1 };
  return { pageType: 'overview', tier: 1 };
}

export interface EmitInput {
  org: Org;
  category: Category;
  sourceUrl: string;
  fetchedAt: string; // YYYY-MM-DD
  content: MainContent;
  adapterKey: string;
  pageSlug?: string; // 파일명(없으면 category). about 확장 페이지는 고유 slug 필요.
  rawRef?: string; // raw 원본 상대경로(예: raw/html/eng/greeting.html) — 출처에 표기
  entityKind?: string; // category==='entity'일 때 학과|부속기관 → entity_type
  label?: string; // entity 표시명(한글) — 정적 추출 제목보다 신뢰하여 제목으로 사용
}

/** 크롤 원본 HTML 보존 → raw/html/{org.id}/{slug}.html. 반환: 부모폴더 기준 상대경로. */
export function writeRawHtml(org: Org, slug: string, html: string): string {
  const rel = join('raw', 'html', org.id, `${slug}.html`);
  const full = join(OBSIDIAN_PATH, WIKI_DIR[org.parent_wiki], rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, html, 'utf-8');
  return rel.split(sep).join('/');
}

/**
 * 위키화 전 markdown 원본 → raw/md/{org.id}/{slug}.md (기존 9위키 관례).
 * 클렌징된 본문 텍스트만(프론트매터·출처·변경이력 없음). wiki/overviews는 이걸 위키화한 버전.
 * 반환: 부모폴더 기준 상대경로(.md 참조용).
 */
export function writeRawMarkdown(org: Org, slug: string, title: string, markdown: string): string {
  const rel = join('raw', 'md', org.id, `${slug}.md`);
  const full = join(OBSIDIAN_PATH, WIKI_DIR[org.parent_wiki], rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `# ${title}\n\n${markdown}\n`, 'utf-8');
  return rel.split(sep).join('/');
}

/** Obsidian .md 1건 작성. 반환: 작성 경로. */
export function writeObsidianPage(input: EmitInput): string {
  const { org, category, sourceUrl, fetchedAt, content, adapterKey } = input;
  const { pageType, tier } = categoryToPage(category);
  const dir = join(OBSIDIAN_PATH, WIKI_DIR[org.parent_wiki], 'wiki', PAGE_DIR[pageType], org.id);
  mkdirSync(dir, { recursive: true });

  const slug = input.pageSlug ?? `${category}`; // 표준=category, about 확장=고유 slug
  const path = join(dir, `${slug}.md`);

  // entity는 §F·소개 분류 대신 entity_type(학과|부속기관) 사용. 제목은 label 우선(정적 추출 제목 불안정).
  // label은 entity·strategy 등 config에 표시명이 있는 페이지에 공통 적용.
  const isEntity = pageType === 'entity';
  const koCat = isEntity ? input.entityKind ?? '학과' : koCategory(category);
  const displayTitle = input.label ?? content.title;

  const fm: Record<string, unknown> = {
    type: pageType,
    category: koCat,
    sources: [sourceUrl],
    first_seen: fetchedAt,
    last_updated: fetchedAt,
    status: 'active',
    tags: isEntity ? [org.display_name, koCat, displayTitle] : [org.display_name, koCat],
    // ── 크롤 메타 (spec §4.2, lint-ignored) ──
    college: org.id,
    org_type: ORG_TYPE_KO[org.org_type],
    phase: org.phase,
    tier,
    source_url: sourceUrl,
    fetched_at: fetchedAt,
    adapter_key: adapterKey,
  };
  if (isEntity) fm.entity_type = input.entityKind ?? '학과';
  if (pageType === 'fact') fm.verified_at = fetchedAt;

  const body = [
    `# ${displayTitle}`,
    '',
    pageType === 'fact' ? '## 내용' : '',
    content.markdown,
    '',
    '## 출처',
    `- 외부: ${sourceUrl}`,
    input.rawRef ? `- 원문(raw): ${input.rawRef}` : '',
    content.assetUrls.length ? `- 첨부(URL만): ${content.assetUrls.join(' · ')}` : '',
    '',
    '## 변경이력',
    `- ${fetchedAt}: 최초 ingest (Phase ${org.phase}, Tier ${tier})`,
    '',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const front = `---\n${yaml.dump(fm, { lineWidth: -1 })}---\n\n`;
  writeFileSync(path, front + body, 'utf-8');
  return path;
}

function koCategory(cat: Category): string {
  const map: Record<Category, string> = {
    about: '소개',
    greeting: '소개',
    history: '연혁',
    vision: '비전',
    dept: '학과소개',
    stats: '통계',
    archive: '기타',
    board: '기타',
    entity: '학과', // 실제값은 entityKind로 덮어씀(writeObsidianPage). 타입 완전성용 기본값.
    strategy: '전략', // 공약·포지셔닝용 전략 페이지(overview, category=전략).
  };
  return map[cat];
}

// 페이지 slug → 표시 라벨 (index 카탈로그용).
const SLUG_LABEL: Record<string, string> = {
  greeting: '인사말', history: '연혁', vision: '비전', dept: '학과 소개',
  'dean-profile': '학장 소개', 'dean-intro': '학장 소개', 'core-agenda': '핵심 아젠다',
  organization: '조직', 'history-records': '역사 기록', facts: '현황', intro: '소개',
  status: '보직자 현황', speech: '학장 연설',
  // 전략 페이지(strategy_pages)
  'research-activities': '🎯 연구활동·성과', 'ai-policy': '🎯 AI 정책·가이드라인',
  'teaching-award': '🎯 우수강의', 'core-strategy': '🎯 핵심전략', 'dev-plan': '🎯 발전계획',
};

/** entities/{org.id}/ 스캔 → {slug, label(첫 # 제목), kind(entity_type)} 목록 (index 카탈로그용). */
function collectEntityLabels(entDir: string): { slug: string; label: string; kind: string }[] {
  if (!existsSync(entDir)) return [];
  const out: { slug: string; label: string; kind: string }[] = [];
  for (const f of readdirSync(entDir).filter((f) => f.endsWith('.md')).sort()) {
    const slug = f.replace(/\.md$/, '');
    const text = readFileSync(join(entDir, f), 'utf-8');
    const label = text.match(/^#\s+(.+)$/m)?.[1].trim() ?? slug;
    const kind = text.match(/^entity_type:\s*(.+)$/m)?.[1].trim() ?? '학과';
    out.push({ slug, label, kind });
  }
  return out;
}

/**
 * 한 parent_wiki(단과대|대학원)의 index.md 재생성 — overviews/{org.id}/ 스캔 → 조직별 페이지 링크 카탈로그.
 * 크롤 후 호출하면 "wiki화"(탐색 가능) 자동 유지. 콘텐츠 없는 조직은 'ingest 대기'로 표기.
 */
export function regenerateCollegeIndex(parentWiki: ParentWiki, orgs: Org[]): string {
  const wikiRoot = join(OBSIDIAN_PATH, WIKI_DIR[parentWiki], 'wiki');
  const title = parentWiki === '단과대' ? 'SNU 단과대 Wiki' : 'SNU 대학원 Wiki';
  const lines: string[] = [
    '---', 'type: overview', 'tags: [index]', 'sources: []',
    'status: active', '---', '',
    `# Index — ${title}`, '',
    `> ${parentWiki}별 정적 정보 reference wiki. 각 ${parentWiki} = 독립 wiki_id. 이 카탈로그는 크롤 시 자동 갱신.`,
    `> Tier1/2(정적)만 여기 · Tier3(연락처·통계)·Tier4(최신공지)는 앱 DB.`, '',
    `## 🏛 조직별 페이지`, '',
  ];

  for (const org of orgs) {
    const ovDir = join(wikiRoot, 'overviews', org.id);
    const pages = existsSync(ovDir)
      ? readdirSync(ovDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
      : [];
    const entities = collectEntityLabels(join(wikiRoot, 'entities', org.id)); // Phase 2a
    if (pages.length === 0 && entities.length === 0) {
      lines.push(`### ${org.display_name} \`${org.id}\` — _ingest 대기_`, '');
      continue;
    }
    const counts = [pages.length ? `${pages.length}페이지` : '', entities.length ? `entity ${entities.length}` : '']
      .filter(Boolean)
      .join(' · ');
    lines.push(`### ${org.display_name} \`${org.id}\` — ${counts}`);
    if (pages.length) {
      const links = pages
        .sort()
        .map((slug) => `[[overviews/${org.id}/${slug}|${SLUG_LABEL[slug] ?? slug}]]`);
      lines.push('- 소개: ' + links.join(' · '));
    }
    if (entities.length) {
      const byKind = (kind: string) => entities.filter((e) => e.kind === kind);
      for (const [kind, head] of [['학과', '학과'], ['부속기관', '부속기관']] as const) {
        const es = byKind(kind);
        if (!es.length) continue;
        const links = es.map((e) => `[[entities/${org.id}/${e.slug}|${e.label}]]`);
        lines.push(`- ${head}: ` + links.join(' · '));
      }
    }
    lines.push('');
  }

  lines.push(
    '## 🔗 앱 DB (별도 저장)',
    '- **Tier3** `structured_facts`: 연락처·학과수·교원수 · **Tier4** `live_cache`: 최신 공지·뉴스', '',
    '## 📄 페이지 타입', '- `overview`(서술) · `fact`·`source`·`entity`(확장 시)', '',
  );

  const path = join(wikiRoot, 'index.md');
  writeFileSync(path, lines.join('\n'), 'utf-8');
  return path;
}
