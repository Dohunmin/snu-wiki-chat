/**
 * 질문 복잡도 분류 → 컨텍스트 예산 결정 (fact-기반 답변 모드).
 *
 * 배경: 실제 사용자 질문 측정(76개) — median 28자, 75%가 단순 factoid, 25%가 종합형.
 *   단순(factoid)은 작은 컨텍스트로 충분·저렴, 종합형은 OLD급 컨텍스트라야 풍부한 답.
 *   → 질문별로 예산을 달리해 *평균 비용↓ + 깊은 질문 품질 보존*.
 *
 * 비대칭 안전: under-budget(종합형→작은예산)=얇은 답(비싼 실수), over-budget(factoid→큰예산)=몇 센트(싼 실수).
 *   → 애매하면 complex로 편향. 단 실측상 단순이 75%라 편향해도 collapse 안 함.
 *
 * 향후: 지식base 인사이트/토론 전용 에이전트는 별도 모드(lens 유사)로 분기 — 이 분류기는 fact 모드용.
 */

// 종합·분석·사변 의도 마커 (실제 사용자 질문에서 추출: 한동헌 "정리/방법", 박진호 "원인/진단" 등)
const COMPLEX_MARKERS = new RegExp([
  '가능할까', '가능한가', '가능한지', '방안', '방법은', '한다면', '엮어', '짓고', '어떻게 하면', '어떨까',
  '진단', '원인', '이유', '왜\\s', '배경', '평가', '전략', '방향', '개선', '함의', '시사',
  '전망', '제안', '정리해', '정리하면', '종합', '생각해', '어떻게 생각', '차이', '관계',
  '비교(?!과)',  // "비교해/비교하" 매칭, "비교과(extracurricular)" 제외 (false positive 방지)
  // cross-college 집계("각 단과대별 학과") — 15개 단과대 횡단이라 넓은 컨텍스트 필요 → complex 예산.
  '단과대별', '단과대학별', '각 단과대', '모든 단과대', '전체 단과대', '대학원별',
].join('|'));

export type Complexity = 'simple' | 'complex';

export function classifyComplexity(query: string): Complexity {
  const len = query.length;
  if (len > 120) return 'complex';                                  // 장문 = 다면적/누적 질문
  if (COMPLEX_MARKERS.test(query)) return 'complex';               // 분석·사변·종합 의도
  if ((query.match(/[?？]/g)?.length ?? 0) >= 2) return 'complex';  // 다절(여러 물음)
  return 'simple';
}

/** complexity → char 예산. BUDGET_SIMPLE/BUDGET_COMPLEX env로 튜닝.
 *  (unified-intent-router: QueryPlan.complexity 직접 소비용으로 분리.) */
export function budgetForComplexity(c: Complexity): number {
  const simple = Number(process.env.BUDGET_SIMPLE ?? '16000');
  const complex = Number(process.env.BUDGET_COMPLEX ?? '40000');
  return c === 'complex' ? complex : simple;
}

/** 분류 → char 예산. */
export function complexityBudget(query: string): number {
  return budgetForComplexity(classifyComplexity(query));
}
