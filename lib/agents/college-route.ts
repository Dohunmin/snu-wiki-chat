/**
 * 단과대/대학원 위키 라우팅 게이트 (college-grad-wiki wiki_id 격리 *구현*).
 *
 * 문제: 단과대 16개가 거버넌스 9개와 *같은 키워드 풀*에서 경쟁 → "역대 총장"이 단과대 "역대 학장"을
 *   끌어와 오염(품질비교 쌍3에서 확인). CLAUDE.md는 "교차오염 0"이라지만 격리 기계가 없었음.
 *
 * 해법: 단과대는 질문이 *그 단과대를 명시적으로 지칭*할 때만 라우팅 가능.
 *   식별 토큰 = 단과대 이름 + 학과/연구소 한글명(config.keywords) + 약칭(아래) — 단, 일반 토큰 제외.
 *   일반 키워드(소개·연혁·비전·전략)·내용 overlap으론 단과대 활성화 안 됨.
 *   → "기계공학부 정보"/"음대 작곡과"/"경영대 vs 공대" = 해당 단과대 라우팅,
 *      "역대 총장"/"서울대 재정" 등 거버넌스 = 단과대 전부 제외. 단과대 라이브 후에도 영구 유효.
 */
import type { AgentConfig } from './types';

// 약칭(전체명은 keywords에 있음) — 약칭은 전체명의 substring이 아니라서 별도 보강.
const COLLEGE_ABBREV: Record<string, string[]> = {
  eng: ['공대', '공과대'], humanities: ['인문대'], science: ['자연대', '자연과학대'],
  social: ['사회대', '사회과학대'], agriculture: ['농대', '농생대'], education: ['사대', '사범대'],
  business: ['경영대'], 'human-ecology': ['생활대', '생활과학대'], nursing: ['간호대'],
  'fine-arts': ['미대', '미술대'], music: ['음대'], medicine: ['의대'],
  vet: ['수의대'], pharmacy: ['약대'], cls: ['자유전공'], 'liberal-college': ['학부대학'],
};
// 모든 단과대가 공유하는 일반 토큰 — 식별력 없어 게이트에서 제외.
const GENERIC = new Set(['소개', '연혁', '비전', '전략', '미션', '목표', '현황', '개요', '대학', '학부', '대학원']);

export function isCollegeGroup(config: Pick<AgentConfig, 'group'>): boolean {
  return config.group === '단과대' || config.group === '대학원';
}

/** 질문이 이 단과대를 명시적으로 지칭하나 (이름/학과명/약칭). */
export function isCollegeReferenced(query: string, config: AgentConfig): boolean {
  const q = query.toLowerCase();
  const tokens = [
    config.name,
    ...(config.keywords ?? []).filter(k => !k.startsWith('dept-') && !k.startsWith('inst-') && !GENERIC.has(k) && k.length >= 2),
    ...(COLLEGE_ABBREV[config.id] ?? []),
  ];
  return tokens.some(t => t && q.includes(t.toLowerCase()));
}

// ── 그룹 breadth 신호 ─────────────────────────────────────────────────────
// 특정 단과대명이 아니라 '단과대/대학원 그룹 전체'를 가리키는 일반 표현.
//   "각 단과대 현안" · "전공 추천" · "대학원별 차이" 처럼 단과대명을 콕 집지 않지만
//   단과대/대학원 정보가 *필요한* 횡단·집계 질문을 잡는다.
// 이 신호가 있으면 해당 그룹 위키를 라우팅 *후보 풀에 admit*만 한다(강제 선택 아님).
//   실제 라우팅되려면 이후 prefilter 점수 / semantic hint / MAX_WIKIS 게이트를 통과해야 함.
//   → 무관한 단과대가 무더기로 들어오지 않고, "AI 전공 어디" 류는 임베딩이 관련 단과대를 골라냄.
//   집계 수치("학과 몇 개")는 alwaysContext인 대학현황(status) fact가 이미 커버.
const GROUP_BREADTH_SIGNALS: Record<'단과대' | '대학원', string[]> = {
  '단과대': ['단과대', '단과대학', '각 학과', '학과별', '단과대별', '단과대학별', '계열별', '각 대학', '전공'],
  '대학원': ['대학원', '전문대학원', '대학원별'],
};

/** 질문이 단과대/대학원 '그룹 전체'를 가리키는 breadth 신호를 포함하나. */
export function detectGroupBreadth(query: string): Record<'단과대' | '대학원', boolean> {
  const q = query.toLowerCase();
  return {
    '단과대': GROUP_BREADTH_SIGNALS['단과대'].some(s => q.includes(s.toLowerCase())),
    '대학원': GROUP_BREADTH_SIGNALS['대학원'].some(s => q.includes(s.toLowerCase())),
  };
}

// ── 그룹 *집계* 신호 (breadth보다 좁음) ────────────────────────────────────
// "각/모든/전체 단과대" "단과대별" 처럼 *모든* 단과대를 한 번에 묻는 명시적 집계 질문.
//   breadth(admit만)와 달리 이건 그룹 위키를 **force-select**한다 — 특정 단과대명이 없어
//   점수 게이트서 탈락하던 횡단 질문("각 단과대별 학과")의 retrieval 0을 복구.
//   ⚠️ "전공" 같은 느슨한 breadth 신호는 제외 — "공대 전공 추천"에 15개 강제되는 과오염 방지.
const GROUP_AGGREGATE_SIGNALS: Record<'단과대' | '대학원', string[]> = {
  '단과대': ['각 단과대', '모든 단과대', '전체 단과대', '단과대별', '단과대학별', '단과대 전체', '각 대학', '모든 대학', '계열별', '학과별'],
  '대학원': ['각 대학원', '모든 대학원', '전체 대학원', '대학원별', '전문대학원별', '대학원 전체'],
};

/** 질문이 그룹 *전체를 집계*해 묻나(각/모든/별) → 해당 그룹 위키를 force-select 대상으로. */
export function detectGroupAggregate(query: string): Record<'단과대' | '대학원', boolean> {
  const q = query.toLowerCase();
  return {
    '단과대': GROUP_AGGREGATE_SIGNALS['단과대'].some(s => q.includes(s.toLowerCase())),
    '대학원': GROUP_AGGREGATE_SIGNALS['대학원'].some(s => q.includes(s.toLowerCase())),
  };
}
