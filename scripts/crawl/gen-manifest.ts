/**
 * 크롤링 현황 매니페스트 생성기 (단과대 + 대학원).
 *
 * 각 그룹 위키의 wiki/{overviews,entities}/{org}/*.md 프론트매터(source_url·category·tier)를
 * 실측해, 조직별 "어떤 페이지를 어디서 크롤했는지" 매니페스트를 생성한다.
 * colleges.yaml(레지스트리)에서 도메인·엔진·활성여부를 보강.
 *
 *   출력:
 *     ../Obsidian/SNU_단과대_LLM_Wiki/크롤링_현황.md
 *     ../Obsidian/SNU_대학원_LLM_Wiki/크롤링_현황.md
 *
 *   실행: npx tsx scripts/crawl/gen-manifest.ts
 *   (Tier3 structured_facts·Tier4 live_cache는 앱 DB라 여기 미포함 — 위키 .md 콘텐츠만 집계.)
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const OBSIDIAN = path.resolve(process.cwd(), '..', 'Obsidian');
const GROUPS = [
  { wiki: '단과대', dir: 'SNU_단과대_LLM_Wiki', label: '단과대' },
  { wiki: '대학원', dir: 'SNU_대학원_LLM_Wiki', label: '대학원' },
] as const;

type Org = {
  id: string; display_name: string; parent_wiki: string; active?: boolean;
  domain?: string; adapter_key?: string; render?: string;
  urls?: Record<string, string | null>; about_pages?: { slug: string; path?: string }[];
  notes?: string;
};
type Page = { id: string; title: string; category: string; entityType?: string; url: string; tier?: number };

function loadOrgs(): Org[] {
  const d = yaml.load(fs.readFileSync(path.join(process.cwd(), 'config', 'colleges.yaml'), 'utf8')) as { orgs: Org[] };
  return d.orgs ?? [];
}

function parseFrontmatter(md: string): { fm: Record<string, unknown>; body: string } {
  if (!md.startsWith('---')) return { fm: {}, body: md };
  const end = md.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, body: md };
  const block = md.slice(3, end);
  const body = md.slice(end + 4);
  let fm: Record<string, unknown> = {};
  try { fm = (yaml.load(block) as Record<string, unknown>) ?? {}; } catch { /* ignore */ }
  return { fm, body };
}

function titleOf(body: string, fallback: string): string {
  const m = body.match(/^\s*#{1,2}\s+(.+?)\s*$/m);
  return m ? m[1].trim() : fallback;
}

function readPages(groupDir: string, type: 'overviews' | 'entities', org: string): Page[] {
  const dir = path.join(OBSIDIAN, groupDir, 'wiki', type, org);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
    const { fm, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
    const id = f.replace(/\.md$/, '');
    return {
      id,
      title: titleOf(body, String(fm.title ?? id)),
      category: String(fm.category ?? ''),
      entityType: fm.entity_type ? String(fm.entity_type) : undefined,
      url: String(fm.source_url ?? (Array.isArray(fm.sources) ? (fm.sources as string[])[0] : '') ?? ''),
      tier: typeof fm.tier === 'number' ? fm.tier : undefined,
    };
  }).sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

function buildManifest(group: typeof GROUPS[number], orgs: Org[]): string {
  const mine = orgs.filter(o => o.parent_wiki === group.wiki);
  const today = new Date().toISOString().slice(0, 10);
  const out: string[] = [];

  out.push(`# SNU ${group.label} 크롤링 현황 (Crawl Manifest)`);
  out.push('');
  out.push(`> 각 ${group.label}별 **크롤 소스 사이트 · 페이지 유형 · 실제 URL**. 자동 생성(\`scripts/crawl/gen-manifest.ts\`).`);
  out.push(`> 기준: \`wiki/{overviews,entities}/{org}/\` 프론트매터 \`source_url\` 실측 + \`colleges.yaml\` 대비. 생성일 ${today}.`);
  out.push('> ⚠️ Tier3(연락처·통계=structured_facts)·Tier4(공지·뉴스=live_cache)는 **앱 DB**라 여기 미포함(.md 콘텐츠만).');
  out.push('');

  // ── 요약 ──
  out.push('## 📊 전체 요약');
  out.push('');
  out.push(`| ${group.label} | 도메인 | 엔진 | render | overview | 학과 | 부속/연구소 | 상태 |`);
  out.push('|---|---|---|---|--:|--:|--:|---|');

  const data = new Map<string, { ov: Page[]; ent: Page[] }>();
  let tOv = 0, tDept = 0, tInst = 0, activeCnt = 0;

  for (const o of mine) {
    const ov = readPages(group.dir, 'overviews', o.id);
    const ent = readPages(group.dir, 'entities', o.id);
    data.set(o.id, { ov, ent });
    const depts = ent.filter(e => (e.entityType ?? e.category).includes('학과') || (e.entityType ?? e.category).includes('전공'));
    const insts = ent.filter(e => !depts.includes(e));
    const status = o.active === false ? '⛔ 비활성' : (ov.length + ent.length === 0 ? '⚠️ 콘텐츠 0' : '✅');
    if (o.active !== false) activeCnt++;
    tOv += ov.length; tDept += depts.length; tInst += insts.length;
    out.push(`| ${o.display_name} | ${o.domain ?? '-'} | ${o.adapter_key ?? '-'} | ${o.render ?? '-'} | ${ov.length} | ${depts.length} | ${insts.length} | ${status} |`);
  }
  out.push('');
  out.push('## 🔢 수치(통계)·게시판은 어디에?');
  out.push('- **Tier3 `structured_facts`(앱 DB)**: 학과수·교원수·대표 연락처. 위키 .md 미출력(중복 방지).');
  out.push('- **Tier4 `live_cache`(앱 DB, TTL 6h)**: 공지·뉴스·소식지. 오프라인 cron `crawl --tier 4`로 갱신.');
  out.push('- 즉 수치·최신글 자체는 크롤되지만 별도 .md가 아니라 DB에 있음.');
  out.push('');

  // ── 조직별 상세 ──
  out.push(`## 🏛 ${group.label}별 상세`);
  out.push('');
  for (const o of mine) {
    const { ov, ent } = data.get(o.id)!;
    out.push(`### ${o.display_name} \`${o.id}\``);
    if (o.active === false) {
      out.push(`> ⛔ **비활성** — ${o.notes ?? 'robots/접근 제한 등'}`);
      out.push('');
      continue;
    }
    out.push(`- **크롤 소스**: \`${o.domain ?? '-'}\` (${o.adapter_key ?? '-'}${o.render && o.render !== 'static' ? `, ${o.render}` : ''})`);
    out.push(`- **수집**: overview ${ov.length} · entity ${ent.length}`);
    const rows = [...ov.map(p => ({ ...p, kind: p.category || '소개' })), ...ent.map(p => ({ ...p, kind: p.entityType ?? p.category ?? '학과' }))];
    if (rows.length === 0) {
      out.push('  - ⚠️ 수집된 .md 없음 (Tier4 게시판만 있거나 미크롤).');
    } else {
      out.push('');
      out.push('| 유형 | 제목 | 실제 크롤 URL |');
      out.push('|---|---|---|');
      for (const r of rows) out.push(`| ${r.kind} | ${r.title} | ${r.url || '-'} |`);
    }
    out.push('');
  }

  out.push('---');
  out.push(`*활성 ${group.label} ${activeCnt}/${mine.length}. 페이지 합계: overview ${tOv} · 학과 ${tDept} · 부속 ${tInst}.*`);
  out.push('');
  return out.join('\n');
}

function main() {
  const orgs = loadOrgs();
  for (const g of GROUPS) {
    const md = buildManifest(g, orgs);
    const dest = path.join(OBSIDIAN, g.dir, '크롤링_현황.md');
    fs.writeFileSync(dest, md, 'utf8');
    const mine = orgs.filter(o => o.parent_wiki === g.wiki);
    console.log(`✅ ${g.label}: ${mine.length}개 조직 → ${dest}`);
  }
}

main();
