/**
 * 크롤 커버리지/결손 매트릭스 — 단과대+대학원.
 *
 * 핵심 질문: 각 조직에 개요·학장인사·뉴스가 최소한 다 크롤됐나? + 빠진 부분 + 추가로 더 받은 부분.
 *   Tier1/2(개요·인사·연혁·비전·조직·학과·전략): wiki/{overviews,entities}/{org}/*.md 프론트매터 실측
 *   Tier4(공지·뉴스): live_cache DB 실측(payload 항목 수)
 *   설정 대비: colleges.yaml urls.{greeting,history,vision,notice,news}
 *
 *   실행: npx tsx --env-file=.env.local scripts/crawl/coverage.ts   (DB 조회 위해 env 필요)
 *   출력: ../Obsidian/크롤_커버리지.md
 */
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { db } from '../../lib/db/client';
import { liveCache } from '../../lib/db/schema';

const OBSIDIAN = path.resolve(process.cwd(), '..', 'Obsidian');
const GROUPS = [
  { wiki: '단과대', dir: 'SNU_단과대_LLM_Wiki' },
  { wiki: '대학원', dir: 'SNU_대학원_LLM_Wiki' },
];

type Org = { id: string; display_name: string; parent_wiki: string; active?: boolean; domain?: string; urls?: Record<string, string | null> };

function loadOrgs(): Org[] {
  const d = yaml.load(fs.readFileSync(path.join(process.cwd(), 'config', 'colleges.yaml'), 'utf8')) as { orgs: Org[] };
  return d.orgs ?? [];
}
function fm(md: string): Record<string, unknown> {
  if (!md.startsWith('---')) return {};
  const end = md.indexOf('\n---', 3); if (end === -1) return {};
  try { return (yaml.load(md.slice(3, end)) as Record<string, unknown>) ?? {}; } catch { return {}; }
}
function h1(md: string): string { const m = md.match(/^\s*#\s+(.+)$/m); return m ? m[1].trim() : ''; }

type Buckets = { 개요: number; 학장인사: number; 연혁: number; 비전: number; 조직: number; 학과: number; 부속: number; 전략: number; facts: number };

function scanOrg(dir: string, org: string): Buckets {
  const b: Buckets = { 개요: 0, 학장인사: 0, 연혁: 0, 비전: 0, 조직: 0, 학과: 0, 부속: 0, 전략: 0, facts: 0 };
  // overviews
  const ovDir = path.join(OBSIDIAN, dir, 'wiki', 'overviews', org);
  if (fs.existsSync(ovDir)) {
    for (const f of fs.readdirSync(ovDir).filter(x => x.endsWith('.md'))) {
      const md = fs.readFileSync(path.join(ovDir, f), 'utf8');
      const id = f.replace(/\.md$/, '').toLowerCase();
      const cat = String(fm(md).category ?? '');
      const title = h1(md);
      if (/greet|인사말|deans?-?m|message/.test(id) || title.includes('인사말')) b.학장인사++;
      else if (cat === '연혁' || /history|연혁/.test(id)) b.연혁++;
      else if (cat === '비전' || /vision|goal|mission|비전/.test(id)) b.비전++;
      else if (/organization|org-?chart|조직|보직|staff|directions|직원/.test(id)) b.조직++;
      else if (cat === '전략') b.전략++;
      else b.개요++;   // 소개·학과소개·기타 일반 개요
    }
  }
  // facts
  if (fs.existsSync(path.join(OBSIDIAN, dir, 'wiki', 'facts', org))) b.facts = fs.readdirSync(path.join(OBSIDIAN, dir, 'wiki', 'facts', org)).filter(x => x.endsWith('.md')).length;
  // entities
  const entDir = path.join(OBSIDIAN, dir, 'wiki', 'entities', org);
  if (fs.existsSync(entDir)) {
    for (const f of fs.readdirSync(entDir).filter(x => x.endsWith('.md'))) {
      const md = fs.readFileSync(path.join(entDir, f), 'utf8');
      const t = String(fm(md).entity_type ?? fm(md).category ?? '');
      if (t.includes('학과') || t.includes('전공')) b.학과++; else b.부속++;
    }
  }
  return b;
}

async function loadNews(): Promise<Map<string, { notice: number; news: number; other: number }>> {
  const m = new Map<string, { notice: number; news: number; other: number }>();
  try {
    const rows = await db.select().from(liveCache);
    for (const r of rows) {
      const e = m.get(r.org) ?? { notice: 0, news: 0, other: 0 };
      const n = Array.isArray(r.payload) ? r.payload.length : 0;
      if (r.board === 'notice') e.notice += n; else if (r.board === 'news') e.news += n; else e.other += n;
      m.set(r.org, e);
    }
  } catch (err) {
    console.error('live_cache 조회 실패:', (err as Error).message);
  }
  return m;
}

function yn(n: number): string { return n > 0 ? `✅${n > 1 ? n : ''}` : '❌'; }

async function main() {
  const orgs = loadOrgs();
  const news = await loadNews();
  const dbOk = news.size > 0;
  const out: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  out.push('# SNU 단과대/대학원 크롤 커버리지 · 결손 (Coverage Matrix)');
  out.push('');
  out.push(`> 핵심 3종(개요·학장인사·뉴스)이 최소한 다 크롤됐는지 + 추가 수집분 + 빠진 부분. 생성 ${today} (\`scripts/crawl/coverage.ts\`).`);
  out.push('> Tier1/2(개요·인사·연혁·비전·조직·학과)=wiki .md 실측, Tier4(공지·뉴스)=live_cache DB 실측.');
  if (!dbOk) out.push('> ⚠️ **live_cache(뉴스) DB 조회 실패 — 뉴스 칸은 미확인**. `--env-file=.env.local`로 재실행 필요.');
  out.push('');

  for (const g of GROUPS) {
    const mine = orgs.filter(o => o.parent_wiki === g.wiki && o.active !== false);
    out.push(`## ${g.wiki} (${mine.length})`);
    out.push('');
    out.push('| 조직 | 개요 | 학장인사 | 연혁 | 비전 | 조직도 | 학과 | 공지(T4) | 뉴스(T4) | 빠진 핵심 |');
    out.push('|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|');
    for (const o of mine) {
      const b = scanOrg(g.dir, o.id);
      const nv = news.get(o.id) ?? { notice: 0, news: 0, other: 0 };
      const miss: string[] = [];
      if (b.개요 === 0) miss.push('개요');
      if (b.학장인사 === 0) miss.push('학장인사');
      if (dbOk && nv.news === 0 && nv.notice === 0) miss.push('뉴스/공지');
      if (b.연혁 === 0) miss.push('연혁');
      if (b.비전 === 0) miss.push('비전');
      out.push(`| ${o.display_name} | ${yn(b.개요)} | ${yn(b.학장인사)} | ${yn(b.연혁)} | ${yn(b.비전)} | ${yn(b.조직)} | ${b.학과 || '—'} | ${dbOk ? (nv.notice || '❌') : '?'} | ${dbOk ? (nv.news || '❌') : '?'} | ${miss.length ? '🔴 ' + miss.join('·') : '—'} |`);
    }
    out.push('');
  }

  // 요약
  out.push('## 📌 핵심 3종(개요·학장인사·뉴스) 충족 요약');
  out.push('');
  let triadFull = 0, triadPartial: string[] = [];
  for (const g of GROUPS) {
    for (const o of orgs.filter(x => x.parent_wiki === g.wiki && x.active !== false)) {
      const b = scanOrg(g.dir, o.id);
      const nv = news.get(o.id) ?? { notice: 0, news: 0, other: 0 };
      const hasIntro = b.개요 > 0, hasGreet = b.학장인사 > 0, hasNews = (nv.news + nv.notice) > 0;
      if (hasIntro && hasGreet && (!dbOk || hasNews)) triadFull++;
      else triadPartial.push(`${o.display_name}(${[!hasIntro && '개요', !hasGreet && '인사', dbOk && !hasNews && '뉴스'].filter(Boolean).join('·')})`);
    }
  }
  out.push(`- ✅ 3종 모두 충족: **${triadFull}개 조직**`);
  out.push(`- 🔴 일부 결손: ${triadPartial.length ? triadPartial.join(', ') : '없음'}`);
  out.push('');
  // 남은 ❌의 성격 — 2026-06-08 curl 정찰로 "사이트에 페이지 없음/타 페이지 포함/이미지 기반"임 확인된 것들(크롤 실패 아님).
  out.push('## 🔎 남은 ❌의 성격 (정찰로 확인 — 크롤 실패 아님)');
  out.push('간판 채우기 후 남은 ❌는 모두 **소스 사이트에 페이지 자체가 없거나·다른 페이지에 포함·이미지 기반**임이 curl 정찰로 확인됨. (없는 걸 지어내면 할루시네이션이라 채우지 않음)');
  out.push('- **일반대학원 인사/연혁/비전**: 연합대학원(75학과+32협동과정이 단과대와 공유)이라 *자체* 원장/연혁/비전 페이지가 없음. 대학 차원은 대학현황 위키가 담당. → 개요(연합구조)만 채우는 게 정답(완료).');
  out.push('- **MBA 개요·연혁**: `/snu-gsb/overview`(학교현황=연혁+졸업생 통계)에 인라인(현재 비전 페이지로 적재). 원장 인사말: 사이트에 없음(전 slug 404).');
  out.push('- **사회대·사범대 비전**: 전용 비전 페이지 없음 — 사회대는 `/소개/`에 비전·목표·인재상 통합, 사범대는 이미지 기반(비전 문구는 학장인사말에 포함, OCR 필요).');
  out.push('- **gsiat 비전**: 이미지 기반(OCR 필요). **개요**: 인사말 랜딩이 겸함(전용 없음).');
  out.push('- **국제대학원 연혁**: 전용 페이지 없음(1997 설립 연혁은 why-gsis/비전에 포함). ⚠️ 한글 `/연혁/` 슬러그는 사범대 오염이라 사용 금지.');
  out.push('- **뉴스(T4) ❌**(사회·사범·법전원·융합과기원·일반대학원): 사이트에 별도 \'뉴스\' 게시판이 없고 \'공지\'만 존재(구조적).');
  out.push('');
  out.push('## 🧩 우리가 *추가로* 더 크롤한 것 (간판 3종 외)');
  out.push('- 연혁·역대학장·조직도/보직자(거의 전 조직) · 학과/전공 entity · 부속 연구소 · 일부 전략·facts(정량)');
  out.push('- ⚠️ 빠진 영역(전 조직 공통): 교수진 명단·커리큘럼·정량 KPI·재정·발전계획 → [콘텐츠_감사.md](SNU_단과대_LLM_Wiki/콘텐츠_감사.md) 참조');
  out.push('');

  fs.writeFileSync(path.join(OBSIDIAN, '크롤_커버리지.md'), out.join('\n'), 'utf8');
  console.log(`→ Obsidian/크롤_커버리지.md 저장 (DB 조회 ${dbOk ? 'OK' : '실패'})`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
