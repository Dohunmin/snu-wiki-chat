// Design Ref: college-grad-wiki §1.2 (공통 80% / 엔진별 20%) / §4.3 (board 계약)
// BaseAdapter: 정적 추출·페이지 해석은 공통(8엔진 동일). board 파싱만 엔진별 override.

import type { Org, AdapterKey, SelectorConfig, Category, MainContent, BoardItem, EntityKind } from './types';
import { URL_TO_CATEGORY } from './types';
import { cleanseMain } from './cleanser';

export interface ResolvedPage {
  category: Category;
  url: string;
  slug: string; // 파일명(표준 페이지=category, about 추가분=about_page.slug)
  entityKind?: EntityKind; // category==='entity'일 때 학과|부속기관
  label?: string; // entity 표시명(한글) — 제목·index 라벨로 사용
  tlsRelax?: boolean; // 2b 외부 학과 사이트 self-signed 인증서 대응
}

export interface SiteAdapter {
  key: AdapterKey;
  fetchMode(org: Org, category: Category): 'static' | 'dynamic';
  extractMain(html: string, url: string): MainContent;
  resolvePages(org: Org): ResolvedPage[];
  /** 게시판 목록 HTML → 글 목록 (Tier4). 엔진별. */
  parseBoardList(html: string, boardListUrl: string): BoardItem[];
}

export abstract class BaseAdapter implements SiteAdapter {
  abstract key: AdapterKey;

  constructor(protected selectors: SelectorConfig) {}

  // 공통: dynamic 렌더 조직(gspa·gsct)만 playwright, 나머지 static.
  fetchMode(org: Org): 'static' | 'dynamic' {
    return org.render === 'dynamic' ? 'dynamic' : 'static';
  }

  // 공통: GNB/footer 제거 → cleaned markdown (8엔진 모두 static SSR이라 균일).
  extractMain(html: string, url: string): MainContent {
    return cleanseMain(html, this.selectors, url);
  }

  // 공통: colleges.yaml urls(표준) + about_pages(확장) → Tier1 정적 페이지(board는 Tier4라 제외).
  resolvePages(org: Org): ResolvedPage[] {
    const out: ResolvedPage[] = [];
    for (const [uc, path] of Object.entries(org.urls)) {
      if (!path) continue;
      const cat = URL_TO_CATEGORY[uc as keyof typeof URL_TO_CATEGORY];
      if (!cat || cat === 'board') continue;
      out.push({ category: cat, url: toAbsUrl(org, path), slug: cat });
    }
    // about/소개 섹션 확장 페이지(overview). 표준 키와 slug 중복 시 표준 우선.
    const have = new Set(out.map((p) => p.slug));
    for (const ap of org.about_pages ?? []) {
      if (have.has(ap.slug)) continue;
      have.add(ap.slug);
      out.push({ category: 'about', url: toAbsUrl(org, ap.path), slug: ap.slug });
    }
    // Phase 2a: 학과·부속기관 entity 페이지(정적 Tier1). slug 네임스페이스가 about과 겹치지 않게 운용.
    for (const ep of org.entity_pages ?? []) {
      if (have.has(ep.slug)) continue;
      have.add(ep.slug);
      out.push({ category: 'entity', url: toAbsUrl(org, ep.path), slug: ep.slug, entityKind: ep.entity, label: ep.label, tlsRelax: ep.tls_relax });
    }
    // Phase 2a+: 공약·포지셔닝용 전략 페이지(overview, category=전략).
    for (const sp of org.strategy_pages ?? []) {
      if (have.has(sp.slug)) continue;
      have.add(sp.slug);
      out.push({ category: 'strategy', url: toAbsUrl(org, sp.path), slug: sp.slug, label: sp.label });
    }
    return out;
  }

  // 엔진별: 게시판 파싱 (module-5 Tier4에서 본격 사용).
  abstract parseBoardList(html: string, boardListUrl: string): BoardItem[];
}

/**
 * colleges.yaml urls 값 → 절대 URL.
 * - "https://..." 그대로
 * - "dentemp:/path" → alt_domain 표기 → https://dentemp.snu.ac.kr/path
 * - "snu.ac.kr/path" → 도메인 포함 → https://snu.ac.kr/path
 * - "/path" → org.domain 기준
 */
export function toAbsUrl(org: Org, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  const alt = path.match(/^([a-z0-9-]+):(\/.*)$/i);
  if (alt) return `https://${alt[1]}.snu.ac.kr${alt[2]}`;
  if (/^[a-z0-9-]+\.[a-z][a-z.]+\//i.test(path)) return `https://${path}`;
  const base = org.domain ? `https://${org.domain}` : '';
  return base + (path.startsWith('/') ? path : `/${path}`);
}
