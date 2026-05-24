# Plan: Recency Boost — 시간성 쿼리에 신규 source 진입 보장

> **Feature**: recency-boost
> **Date**: 2026-05-25
> **Phase**: Plan

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | "최근 평의원회 이슈" 같은 시간성 쿼리에서 신규 source(19기-7차/8차)가 컨텍스트 진입 실패. 17/18기는 backlinks 누적으로 점수 폭발, 신규는 점수 낮음 |
| **Solution** | 시간성 키워드 감지 시 source scoring 단계에서 date 내림차순 + ID의 N기 M차 패턴 기반 boost 점수 추가 |
| **UX Effect** | "최근/이번/올해" 류 자연어 질문에 가장 최신 자료가 우선 인용됨. 신규 추가된 자료가 즉시 검색 결과에 노출 |
| **Core Value** | 새로 추가한 자료가 검색 결과에서 묻히지 않도록 — RAG 시스템의 운영 신뢰성 확보 |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 현재 검색 점수가 시간을 모름. 오래되고 backlink 많은 자료가 항상 신규 자료를 이김. 사용자가 "최근"이라 물어봐도 1~2년 전 자료가 응답됨 |
| **WHO** | 모든 사용자 — 신규 회의록/계획서가 추가되었을 때 즉시 활용되어야 함. 운영자는 새 자료 추가 후 검색 검증 부담 감소 |
| **RISK** | 시간성 키워드 false positive ("올해의 도서" 류). 시간성과 관련도가 충돌할 때 가중치 조절 필요. 회귀: 시간성 없는 일반 쿼리는 기존 동작 유지 필수 |
| **SUCCESS** | 진단 스크립트의 5개 시간성 쿼리 중 4개 이상에서 19기-7차/8차 컨텍스트 진입. 시간성 키워드 없는 쿼리에 결과 변화 없음 |
| **SCOPE** | `lib/agents/wiki-agent.ts` source scoring 수정 + 신규 파일 `lib/agents/recency.ts` (헬퍼). RRF/router/embeddings 무수정 |

---

## 1. 현재 문제 (진단 결과)

`scripts/diagnose-recency.ts` 실행 결과:

| 쿼리 | 19기-7차/8차 컨텍스트 진입? |
|---|---|
| "평의원회 최근 이슈 알려줘" | ❌ |
| "최근 평의원회에서 논의된 내용" | ❌ |
| "이번 평의원회 안건" | ❌ |
| "평의원회 19기 최신 회의록" | ✅ (19기 명시) |
| "평의원회 진행 상황" | ❌ |

**원인**:
1. 17/18기 회의록은 1년 이상 누적된 topics/entities backlinks로 점수 폭발
2. 19기-7차/8차는 신규 추가 → backlink 매칭 약함 → 점수 낮음
3. "최근" 키워드는 회의록 본문에 안 들어있어 키워드 매칭 0
4. 벡터 유사도도 "최근" 같은 메타-의미 못 잡음

**구조적 진단**: source scoring 단계(`lib/agents/wiki-agent.ts:163-184`)에서 backlink 점수가 시간성 신호를 압도. 컨텍스트 진입 자체가 차단됨.

---

## 2. 해결 방식: 시간성 감지 + recency boost

### 2-1. 시간성 키워드 감지

신규 헬퍼 `lib/agents/recency.ts`:

```ts
const RECENCY_KEYWORDS = [
  '최근', '최신', '이번', '요즘', '현재', '근래', '지난',
  '올해', '작년', '이번달', '지난달', '이번주', '지난주',
];

export function detectRecencyIntent(query: string): boolean {
  const lower = query.toLowerCase();
  return RECENCY_KEYWORDS.some(kw => lower.includes(kw));
}
```

**제외**: `N년` 숫자 패턴 ("70년 역사" 같은 false positive 위험)
**v2 보류**: 역방향 시간성 ("처음에는", "초창기", "예전")

### 2-2. Source 단위 recency 점수 계산

각 source에 대해 두 signal 합산:

```ts
export function recencyScore(source: WikiSource): number {
  // Signal A: date 기반 (date 필드 있는 위키 — senate/board/plan/yhl-speeches)
  const dateScore = source.date ? dateBoost(source.date) : 0;

  // Signal B: sequence pattern (date 없는 위키 — N기 M차 추출)
  const seqScore = source.date ? 0 : sequenceBoost(source.id);

  return Math.max(dateScore, seqScore);
}

function dateBoost(date: string): number {
  // 최신일수록 큰 boost. 1년 이내 +10, 6개월 이내 +15, 3개월 이내 +20
  const days = (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24);
  if (days <= 90) return 20;
  if (days <= 180) return 15;
  if (days <= 365) return 10;
  if (days <= 730) return 5;
  return 0;
}

function sequenceBoost(id: string): number {
  // "19기-8차" 같은 패턴 추출, 가장 큰 수일수록 boost
  // (실제 max는 데이터 빌드 시점에 추출하거나 런타임에 그룹 내 비교)
  const match = id.match(/(\d+)기[-_]?(\d+)차/);
  if (!match) return 0;
  // 단순화: 기수가 큰 source에 boost (max 기수는 런타임 그룹 max 사용)
  return 10;  // 상세 로직은 Design 단계에서 확정
}
```

### 2-3. wiki-agent.ts 통합 지점

기존 source scoring ([wiki-agent.ts:163-184](lib/agents/wiki-agent.ts#L163-L184))에 조건부 합산:

```ts
const isRecencyQuery = detectRecencyIntent(query);

const sourcesWithScore = allowedSources.map(source => {
  let score = 0;
  // ... 기존 점수 계산 (guaranteed, topics, entities, tags, content) ...

  // 시간성 쿼리일 때만 recency boost 추가
  if (isRecencyQuery) {
    score += recencyScore(source);
  }

  return { source, score };
});
```

### 2-4. 적용 전후 점수 시뮬레이션

쿼리: "평의원회 최근 이슈 알려줘"

| Source | 기존 점수 | recency boost (제안) | 최종 |
|---|---|---|---|
| 19기-8차서면심의 (2026-04-20) | 2 | +20 (3개월 이내) | 22 |
| 19기-7차 (2026-04-16) | 2 | +20 | 22 |
| 17기-19차 (2023-05-18) | 12 (backlinks 누적) | 0 (730일 초과) | 12 |
| 18기-14차 (2025-02-13) | 8 | +5 (730일 이내) | 13 |

→ 19기-7차/8차가 상위로 진입.

---

## 3. 구현 범위

### 수정 파일

| 파일 | 변경 종류 | 라인 수 |
|---|---|---|
| `lib/agents/recency.ts` | 신규 | ~60 |
| `lib/agents/wiki-agent.ts` | 수정 (source scoring 부분) | +5 |
| `scripts/diagnose-recency.ts` | 회귀 테스트 보강 (이미 존재) | +10 |

### 무수정

- `lib/agents/router.ts` — 라우팅 로직 무관
- `lib/embed/search.ts`, `lib/embed/rrf.ts` — 벡터/RRF 무관
- `lib/llm/prompts.ts` — P6 시간성 처리 이미 추가됨 (보조 효과만)
- DB 스키마/마이그레이션 — 불필요

---

## 4. Success Criteria

| ID | 기준 | 측정 |
|---|---|---|
| SC1 | "평의원회 최근 이슈", "최근 평의원회에서 논의된 내용", "이번 평의원회 안건", "평의원회 진행 상황" 중 최소 3/4에서 19기-7차 또는 19기-8차 컨텍스트 진입 | `scripts/diagnose-recency.ts` 출력 |
| SC2 | 시간성 키워드 없는 쿼리 5개 ("교육 분야 안건", "AI 정책", "이사회 의결사항", "재정 현황", "캠퍼스 인프라")에서 컨텍스트에 들어오는 source ID 셋이 변화 없음 | 회귀 테스트 |
| SC3 | `detectRecencyIntent`가 RECENCY_KEYWORDS 13개에 모두 true, "70년 역사" / "N년 만에" 같은 false positive 쿼리에 false 반환 | 단위 테스트 |
| SC4 | senate 외 다른 위키(yhl-speeches, board, plan)에서도 date 기반 recency boost 동작 확인 | 진단 스크립트 확장 |
| SC5 | LLM 답변에 인용된 source ID 중 시간성 쿼리에 한해 최신 3개월 자료 비중 50% 이상 (육안 확인) | 채팅 실측 |

---

## 5. Risks

| 위험 | 완화 |
|---|---|
| 시간성 키워드 false positive | RECENCY_KEYWORDS 보수적 유지. `N년` 숫자 제외. 의심 케이스는 진단 스크립트에 추가 |
| Boost 점수 강도가 과해 관련 없는 최신 자료가 항상 1위 | dateBoost 최대 +20 (관련도 5점/단어 × 4단어 매칭과 동등). 도메인 매칭 강한 자료는 여전히 우선 |
| Sequence 패턴 매칭 실패 (date 없는 위키) | sequenceBoost는 부수적. 작동 안 해도 회귀 없음. Design 단계에서 wiki별 패턴 정의 |
| Backfill: 과거 source의 date가 누락된 경우 | 누락된 date는 boost 0 → 안전한 fallback |
| LLM이 boost된 자료를 무시하고 backlink 강한 자료 인용 | 컨텍스트에 들어온 자료의 회의일 메타데이터로 LLM이 자연스럽게 최신 우선시 (별도 프롬프트 지시 불필요) |

---

## 6. Out of Scope

- 역방향 시간성 ("초창기", "예전", "처음에는") — v2
- 절대 시점 ("2024년", "2025-03") — false positive 위험 큼
- Date 자동 추출 (현재 누락된 source의 date 보강) — 별도 backfill 작업
- RRF 단계 recency 가중 — source 진입 후 정렬은 부차적 문제로 판단
- 시간 decay 곡선 튜닝 (현재 step function) — 정량 평가 데이터 쌓이면 검토
- UI: 시간성 자동 감지 표시 — 사용자에게 알리는 인디케이터

---

## 7. Dependencies

- 기존 데이터 구조 (`WikiSource.date`, `WikiSource.id`) 그대로 활용
- 외부 라이브러리 추가 없음
- 환경 변수 추가 없음
- DB 마이그레이션 없음

---

## 8. Validation Plan

1. `scripts/diagnose-recency.ts` 5개 쿼리에 대해 before/after 비교 출력
2. 신규 회귀 테스트 쿼리 5개 (시간성 없음) 추가 — 결과 source ID 셋 diff
3. 채팅 UI에서 "평의원회 최근 이슈" 실제 질문 → 답변에 19기-7차/8차 인용 확인
4. yhl-speeches, board 위키에서 동일한 시간성 쿼리 → 최신 자료 진입 확인
