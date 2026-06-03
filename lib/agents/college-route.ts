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
