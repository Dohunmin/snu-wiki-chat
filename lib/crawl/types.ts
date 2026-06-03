// Design Ref: college-grad-wiki §3.1 (SiteAdapter 계약) / §1.2 (공통 80% / 엔진별 20%)
// 크롤 모듈 공용 타입. 정적 정보추출(Tier1/2)은 공통, 게시판 파싱(Tier4)은 엔진별.

import type { Org, AdapterKey, UrlCategory, EntityKind } from '../config/orgs';

export type { Org, AdapterKey, EntityKind };

// 크롤 카테고리 (org.urls 키보다 세분: notice/news → board, entity_pages → entity, strategy_pages → strategy)
export type Category = 'greeting' | 'history' | 'vision' | 'dept' | 'stats' | 'archive' | 'board' | 'about' | 'entity' | 'strategy';
export type Tier = 1 | 2 | 3 | 4;

/** org.urls(UrlCategory) → 크롤 Category 매핑. */
export const URL_TO_CATEGORY: Record<UrlCategory, Category> = {
  greeting: 'greeting',
  history: 'history',
  vision: 'vision',
  departments: 'dept',
  notice: 'board',
  news: 'board',
};

/** Tier1 정적 정보 카테고리(=Obsidian .md 대상). board는 Tier4(앱 DB). */
export const TIER1_CATEGORIES: Category[] = ['greeting', 'history', 'vision', 'dept', 'stats', 'about', 'entity', 'strategy'];
export const TIER2_CATEGORIES: Category[] = ['archive'];

/** 클렌징된 본문 (GNB/footer 제거 후). */
export interface MainContent {
  title: string;
  markdown: string;
  /** 본문 외부에서 수집한 첨부/이미지 URL (다운로드 안 함, URL만). spec §4.4 */
  assetUrls: string[];
  charCount: number;
}

/** 게시판 글 1건 (Tier4). */
export interface BoardItem {
  id: string;
  title: string;
  date?: string;
  url: string;
  summary?: string;
}

/** 한 조직의 크롤 대상 페이지. */
export interface CrawlTarget {
  org: Org;
  category: Category;
  urlCategory: UrlCategory;
  url: string; // 절대 URL
  tier: Tier;
}

/** 사이트별 셀렉터/URL 맵 (config/adapters/{key}.selectors.yaml). */
export interface SelectorConfig {
  key: AdapterKey;
  extract: {
    main_selector: string | string[];
    strip_selectors: string[];
    title_selector?: string;
  };
  board?: {
    list_item_selector?: string;
    id_attr?: string; // 행에서 글 id를 읽을 속성 (e.g. data-idx)
    id_param?: string; // 글 URL의 id 파라미터명 (bbsidx | uid | nttId | wr_id | bidx)
  };
}
