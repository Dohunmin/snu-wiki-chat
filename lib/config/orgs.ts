// Design Ref: college-grad-wiki §3.1 (Org entity) / §4 (registry loader)
// colleges.yaml(영속 레지스트리, survey_status 기반)를 파싱해 Org[]로 노출.
// 단일 진실원: "어느 조직이 존재하고, 어디서(domain/urls) 어떻게(adapter_key/board_pattern) 긁는가".
// 앱(detectCollege)·크롤 파이프라인이 공유. 조직 추가 = 이 파일 무수정, yaml만 편집(O(1)).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export type OrgType =
  | 'undergraduate'
  | 'graduate_general'
  | 'graduate_professional'
  | 'university_college';

export type ParentWiki = '단과대' | '대학원';

// 정찰로 확인된 8개 사이트 엔진 계열 (config/colleges.yaml 헤더 참조)
export type AdapterKey =
  | 'snu-cms' // ?md=v / ?bm=v &bbsidx=
  | 'wordpress-kboard' // redirect / mod=document&uid / 숫자·한글 퍼머링크
  | 'wordpress-custom' // WP 비-kboard
  | 'egovframe' // *.do?nttId=
  | 'gnuboard' // board.php?bo_table=&wr_id=
  | 'dotnet-mvc' // /kr/Board/Detail/{type}/{id}  (render=dynamic)
  | 'asp-bidx' // Default.asp?bidx=
  | 'path-based' // /boards/.../{id}/, /content/{slug}
  | 'tbd';

export type SurveyStatus = 'pending' | 'surveyed' | 'adapter_built' | 'ingested';
export type RenderMode = 'static' | 'dynamic' | 'unknown';
export type UrlCategory = 'greeting' | 'history' | 'vision' | 'departments' | 'notice' | 'news';

/** entity 페이지 종류 — wiki/entities/{org.id}/ 의 entity_type 값. */
export type EntityKind = '학과' | '부속기관';

/** Phase 2a 추가 정적 entity (학과·부속기관) 1건. url-list 결정형: 1 URL = 1 entity .md. */
export interface EntityPage {
  entity: EntityKind;
  slug: string; // 파일명(ascii). 예: dept-1, inst-ih
  label: string; // 표시명(한글 학과/기관명). entity 제목 = 이 값(정적 추출 제목보다 신뢰).
  path: string; // org.domain 기준 상대경로 또는 절대 URL(2b 외부 마이크로사이트)
  tls_relax?: boolean; // 2b: 외부 학과 사이트가 self-signed/불완전 체인일 때(예: math.snu.ac.kr) 검증 완화
}

export interface Org {
  id: string; // DB college / structured_facts.org / live_cache.org 키
  display_name: string;
  org_type: OrgType;
  parent_wiki: ParentWiki; // 단과대 → colleges.json, 대학원 → gradschools.json
  phase: 1 | 2 | 3 | 4;
  active: boolean;
  survey_status: SurveyStatus;
  surveyed_at?: string;
  confidence?: 'high' | 'medium' | 'low';
  domain: string | null;
  alt_domain?: string; // dent: 정적=dentemp, 게시판=dentistry
  adapter_key: AdapterKey;
  render?: RenderMode;
  board_pattern?: string | null;
  dept_count?: number;
  needs_recheck?: boolean;
  tool_blocked?: string;
  scope?: string; // grad-general: 'admin_only'
  urls: Partial<Record<UrlCategory, string | null>>;
  /** about/소개 섹션 추가 페이지(overview). slug=파일명, path=상대경로. greeting/history/vision 외 확장분. */
  about_pages?: { slug: string; path: string }[];
  /** Phase 2a: 학과·부속기관 entity 페이지(정적 Tier1, wiki/entities/{org.id}/). */
  entity_pages?: EntityPage[];
  /** Phase 2a+: 공약·포지셔닝용 전략 페이지(발전계획·전략과제·성과·AI정책 등). overview(category=전략)로 적재. */
  strategy_pages?: { slug: string; label: string; path: string }[];
  /** Phase 2a: 교수 디렉토리 페이지 → Tier3 faculty_count (structured_facts). .md는 안 만듦. */
  faculty?: { path: string };
  notes?: string;
}

export interface OrgDefaults {
  status: string;
  ttl_days: number;
  ttl_hours: number;
  news_cutoff_days: number;
  rate_ms: number;
  user_agent: string;
}

interface CollegesYaml {
  version: number;
  defaults: OrgDefaults;
  orgs: Org[];
}

const DEFAULT_PATH = join(process.cwd(), 'config', 'colleges.yaml');

let cache: CollegesYaml | null = null;

function load(): CollegesYaml {
  if (cache) return cache;
  const path = process.env.COLLEGES_CONFIG_PATH ?? DEFAULT_PATH;
  const raw = readFileSync(path, 'utf-8');
  const parsed = yaml.load(raw) as CollegesYaml;
  if (!parsed?.orgs || !Array.isArray(parsed.orgs)) {
    throw new Error(`colleges.yaml: orgs 배열 누락 (${path})`);
  }
  cache = parsed;
  return parsed;
}

/** 전체 조직 (survey 여부 무관). */
export function loadOrgs(): Org[] {
  return load().orgs;
}

export function getDefaults(): OrgDefaults {
  return load().defaults;
}

/** active 조직만. phase 지정 시 phase 이하만 (롤아웃 게이트). */
export function getActiveOrgs(phase?: number): Org[] {
  return load().orgs.filter((o) => o.active && (phase === undefined || o.phase <= phase));
}

export function getOrgById(id: string): Org | undefined {
  return load().orgs.find((o) => o.id === id);
}

export function getOrgsByWiki(parent: ParentWiki): Org[] {
  return load().orgs.filter((o) => o.parent_wiki === parent);
}

/**
 * detectCollege용 별칭 맵: 질의 substring → org.id.
 * id, display_name, 그리고 "대학" 제거형(공과대학→공과/공대 류)을 키로.
 * 라우터(tier-classifier)가 소비. (Design Ref §6.2.4)
 */
export function buildCollegeAliases(): Map<string, string> {
  const map = new Map<string, string>();
  for (const o of load().orgs) {
    map.set(o.display_name, o.id);
    map.set(o.id, o.id);
    // '공과대학' → '공과', '공과대' (괄호·접미사 정규화)
    const base = o.display_name.replace(/\(.*?\)/g, '');
    map.set(base, o.id);
    if (base.endsWith('대학')) map.set(base.slice(0, -2), o.id);
    if (base.endsWith('대학원')) map.set(base.slice(0, -3), o.id);
  }
  return map;
}

/** 테스트/리로드용. */
export function _clearCache(): void {
  cache = null;
}
