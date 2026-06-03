// Design Ref: college-grad-wiki §4.2 (crawl 오케스트레이션) / §2.1 (component)
// ingestOrg: 한 조직의 Tier1/2 정적 페이지 → cleanse → Obsidian .md.
//   tiers에 3 포함 시 같은 본문에서 구조화 사실(연락처·인원·학과수) 추출 → structured_facts upsert.
// Tier4(live_cache)는 별도 경로(board-refresh.refreshOrgBoards) — CLI --tier 4.
// 핸드오프: .md 생산 후 기존 wiki:build → embed:build(증분, 비용 발생 — 별도 승인).

import { getOrgById } from '../config/orgs';
import type { Org } from '../config/orgs';
import type { Tier } from './types';
import { getAdapter, isAdapterImplemented } from './adapters';
import { toAbsUrl } from './adapter';
import { fetchHtml } from './fetcher';
import { writeObsidianPage, writeRawHtml, writeRawMarkdown } from './emit';
import { extractFacts, extractFacultyCount, upsertFacts, type FactRecord } from './structured-extract';
import type { EntityKind } from './types';

export interface IngestResult {
  org: string;
  domain: string | null;
  adapter: string;
  written: { category: string; path: string; chars: number }[];
  skipped: { category: string; reason: string }[];
  facts?: number; // Tier3로 upsert된 structured_facts 건수
  note?: string;
}

export interface IngestOptions {
  dryRun?: boolean; // fetch+cleanse만, .md 미작성
  today?: string; // YYYY-MM-DD (테스트 고정용)
  tiers?: Tier[]; // 기본 [1,2] (Obsidian만). 3 포함 시 structured_facts도 채움.
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function ingestOrg(orgId: string, opts: IngestOptions = {}): Promise<IngestResult> {
  const org = getOrgById(orgId);
  if (!org) throw new Error(`[pipeline] 미등록 조직: ${orgId} (colleges.yaml 확인)`);

  const result: IngestResult = {
    org: org.id,
    domain: org.domain,
    adapter: org.adapter_key,
    written: [],
    skipped: [],
  };

  if (!org.domain) {
    result.note = '도메인 없음 — 정찰 필요(survey_status)';
    return result;
  }
  if (!isAdapterImplemented(org.adapter_key)) {
    result.note = `어댑터 "${org.adapter_key}" 미구현 — Phase별 점진 구축 대상`;
    return result;
  }

  const adapter = getAdapter(org.adapter_key);
  const pages = adapter.resolvePages(org);
  const today = opts.today ?? isoToday();
  const relaxTLS = org.tool_blocked === 'tls';
  const tiers = opts.tiers ?? [1, 2];
  const wantT3 = tiers.includes(3);
  const factMap = new Map<string, FactRecord>(); // id별 첫 확신값 우선

  // ── Phase A: 전 페이지 fetch + cleanse 수집 (반복 블록 판정 위해 한 번에) ──
  interface Fetched { category: string; slug: string; url: string; markdown: string; assetUrls: string[]; rawRef?: string; entityKind?: EntityKind; label?: string }
  const fetched: Fetched[] = [];
  for (const page of pages) {
    try {
      const mode = adapter.fetchMode(org, page.category);
      const html = await fetchHtml(page.url, mode, { relaxTLS: relaxTLS || (page.tlsRelax ?? false) });
      const rawRef = opts.dryRun ? undefined : writeRawHtml(org, page.slug, html);
      const content = adapter.extractMain(html, page.url);
      fetched.push({ category: page.category, slug: page.slug, url: page.url, markdown: content.markdown, assetUrls: content.assetUrls, rawRef, entityKind: page.entityKind, label: page.label });
    } catch (e) {
      result.skipped.push({ category: page.slug, reason: (e as Error).message });
    }
  }

  // ── 반복 블록 = boilerplate(메뉴/사이트맵/푸터). ≥2 페이지 등장 블록을 제거 ──
  //   링크 없는 JS 메뉴(humanities·science)도 페이지 간 동일 반복이므로 잡힘 — 사이트 무관.
  //   1페이지짜리 조직은 반복 판정 불가 → content-selector에만 의존.
  const repeated = computeRepeatedBlocks(fetched.map((f) => f.markdown));

  // ── Phase B: boilerplate 제거 후 fact 추출 + 쓰기 ──
  for (const f of fetched) {
    const cleanMd = stripBlocks(f.markdown, repeated);
    const charCount = cleanMd.replace(/\s+/g, '').length;
    if (charCount < 50) {
      result.skipped.push({ category: f.slug, reason: `본문 미달(${charCount}자, 반복제거후) — selector/렌더 점검` });
      continue;
    }
    if (wantT3) {
      for (const fr of extractFacts({ title: '', markdown: cleanMd, assetUrls: f.assetUrls, charCount }, org, f.url)) {
        if (!factMap.has(fr.id)) factMap.set(fr.id, fr);
      }
    }
    if (opts.dryRun) {
      result.written.push({ category: f.slug, path: '(dry-run)', chars: charCount });
      continue;
    }
    // entity는 label(한글 학과/기관명)을 제목으로 신뢰(정적 추출 제목 불안정).
    const title = f.entityKind && f.label
      ? f.label
      : cleanMd.split('\n').find((l: string) => l.startsWith('# '))?.slice(2).trim() || f.slug;
    // 위키화 전 원본 markdown → raw/md/{org}/{slug}.md (관례). wiki 페이지는 이걸 참조.
    const mdRef = writeRawMarkdown(org, f.slug, title, cleanMd);
    const path = writeObsidianPage({
      org,
      category: f.category as Parameters<typeof writeObsidianPage>[0]['category'],
      pageSlug: f.slug,
      sourceUrl: f.url,
      fetchedAt: today,
      content: { title, markdown: cleanMd, assetUrls: f.assetUrls, charCount },
      adapterKey: org.adapter_key,
      rawRef: mdRef,
      entityKind: f.entityKind,
      label: f.label,
    });
    result.written.push({ category: f.slug, path, chars: charCount });
  }

  // ── Phase 2a: 교수 디렉토리 → Tier3 faculty_count (.md 미생성, fact만) ──
  if (wantT3 && org.faculty?.path) {
    const facUrl = toAbsUrl(org, org.faculty.path);
    try {
      const html = await fetchHtml(facUrl, adapter.fetchMode(org, 'about'), { relaxTLS });
      const content = adapter.extractMain(html, facUrl);
      const fc = extractFacultyCount(content.markdown, org, facUrl);
      if (fc && !factMap.has(fc.id)) factMap.set(fc.id, fc);
      else if (!fc) result.skipped.push({ category: 'faculty', reason: '교원 수 패턴 미검출(스킵, 할루시네이션 금지)' });
    } catch (e) {
      result.skipped.push({ category: 'faculty', reason: (e as Error).message });
    }
  }

  // Tier3 upsert (dry-run이 아니고 추출된 사실이 있을 때만)
  if (wantT3 && !opts.dryRun && factMap.size > 0) {
    result.facts = await upsertFacts([...factMap.values()]);
  } else if (wantT3 && opts.dryRun) {
    result.facts = factMap.size;
  }
  return result;
}

/**
 * 여러 페이지 markdown에서 반복 블록(boilerplate=메뉴/사이트맵/푸터) 판정.
 * ≥2개 페이지에 동일 등장 + 리스트('- ')/헤딩('#') 블록만 대상(산문 단락은 절대 제외 안 함 → 안전).
 */
function computeRepeatedBlocks(markdowns: string[]): Set<string> {
  if (markdowns.length < 2) return new Set();
  const pageCount = new Map<string, number>();
  for (const md of markdowns) {
    const seen = new Set<string>();
    for (const raw of md.split('\n\n')) {
      const b = raw.trim();
      if (!b) continue;
      if (seen.has(b)) continue; // 같은 페이지 중복은 1회만
      seen.add(b);
      pageCount.set(b, (pageCount.get(b) ?? 0) + 1);
    }
  }
  const repeated = new Set<string>();
  for (const [b, n] of pageCount) {
    if (n >= 2 && (b.startsWith('- ') || b.startsWith('#'))) repeated.add(b);
  }
  return repeated;
}

/** markdown에서 repeated 블록 제거. */
function stripBlocks(markdown: string, repeated: Set<string>): string {
  if (repeated.size === 0) return markdown;
  return markdown
    .split('\n\n')
    .filter((b) => !repeated.has(b.trim()))
    .join('\n\n')
    .trim();
}

/** active 조직 여러 건 순차 ingest (host 간 병렬은 호출측에서). */
export async function ingestOrgs(orgs: Org[], opts: IngestOptions = {}): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const org of orgs) {
    results.push(await ingestOrg(org.id, opts));
  }
  return results;
}
