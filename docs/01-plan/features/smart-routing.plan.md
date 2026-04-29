# Plan: Smart Routing — 라우팅 정확도 향상

> **Feature**: smart-routing
> **Date**: 2026-04-29
> **Phase**: Plan

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | 키워드 미매칭 시 4개 에이전트 전부 호출 → 불필요한 토큰 낭비 |
| **Solution** | 빌드타임 키워드 자동 보강 + 런타임 2단계 라우팅으로 fallback 빈도 제거 |
| **UX Effect** | 답변 품질 유지하면서 평균 토큰 30~50% 추가 절감 |
| **Core Value** | 위키 데이터만 활용하되, 관련 없는 에이전트는 처음부터 배제 |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | fallback="전부 호출"은 무관한 에이전트 컨텍스트를 LLM에 던지는 구조적 낭비 |
| **WHO** | 시스템 — 사용자는 체감 변화 없이 더 빠르고 저렴한 응답 수신 |
| **RISK** | 라우팅 과소 선택 시 관련 에이전트가 빠질 수 있음. fallback-of-last-resort 필수 |
| **SUCCESS** | 일반 쿼리에서 1-2개 에이전트만 호출, 전체 fallback 발생 횟수 0에 수렴 |
| **SCOPE** | `scripts/build-wiki-data.ts`, `lib/agents/router.ts`, `data/agents.config.json` |

---

## 1. 현재 문제

```
쿼리 입력
  → keywords 배열 매칭 시도
  → 매칭 없음 (빈번)
  → 4개 에이전트 전부 호출 ← 핵심 낭비
  → 각 에이전트 청크 스코어링
  → confidence > 0.2 필터 (무관한 에이전트도 0.3으로 통과)
```

**구조적 원인 2가지**:
1. `agents.config.json` 키워드가 수동으로 10개 내외 — 실제 wiki 내용의 극히 일부
2. fallback 로직이 "매칭 없으면 전부" — 스마트 선택 없음

---

## 2. 해결 방식: 2단계 접근

### 2-1. 빌드타임 키워드 자동 보강

`build-wiki-data.ts`에서 JSON 생성 후 → `agents.config.json`의 `keywords` 배열을 자동 갱신.

**추출 대상**:
```
senate.json → topics[].id + entities[].id + sources[].tags 전체
             → 중복 제거, 2자 이상, 최대 100개
```

**예시 결과**:
```json
// 기존
"keywords": ["평의원회", "심의", "학칙", "교원"]

// 개선 후 (자동)
"keywords": ["평의원회", "심의", "학칙", "교원", "AI-가이드라인",
             "시흥-캠퍼스", "선도연구진흥센터", "겸임교원-임용",
             "총장추천위", "상임위원회", ...]
```

### 2-2. 런타임 2단계 라우팅

```
[Tier 1] 키워드 매칭 (기존 + 자동보강)
  → 매칭 있음: 해당 에이전트만 호출
  → 매칭 없음: Tier 2로

[Tier 2] 경량 콘텐츠 스캔 (새로 추가)
  → 각 에이전트의 source.tags + source.topics + source.entities
    를 쿼리 단어와 비교 (풀 컨텐츠 없이 메타데이터만)
  → score > 0 인 에이전트만 선택
  → 전체 score=0 이면 fallback-of-last-resort (전부 호출)
```

**경량 스캔이 풀 컨텐츠 스캔보다 빠른 이유**:
- 현재 JSON에 tags/topics/entities는 소스당 수십 글자
- 풀 컨텐츠(청크 분할 + 정규식 매칭)보다 10-20배 빠름
- 여전히 Node.js 내에서 실행 → 토큰 0

### 2-3. confidence 필터 강화

현재 `confidence > 0.2` → Tier 2 이후 호출된 에이전트는 이미 score > 0 보장이므로:
- 글로벌 쿼리: 기존대로
- Tier 1 매칭: `confidence > 0.3`
- Tier 2 스캔: `confidence > 0.4` (더 엄격)

---

## 3. 예상 효과

| 시나리오 | 현재 에이전트 수 | 개선 후 |
|---|---|---|
| "평의원회 AI 정책" | 1 (키워드 매칭) | 1 (동일) |
| "시흥캠퍼스 현황" | 1 (키워드 매칭) | 1 (더 정확) |
| "서울대 재정 현황" | 4 (fallback) | 1-2 (Tier 2 스캔) |
| "이번 이사회 결정" | 1 (키워드 매칭) | 1 (동일) |
| "완전 무관한 질문" | 4 (fallback) | 4 (last-resort, 불가피) |

---

## 4. 구현 범위

**수정 파일 3개**:

| 파일 | 변경 내용 |
|---|---|
| `scripts/build-wiki-data.ts` | JSON 생성 후 `agents.config.json` keywords 자동 갱신 |
| `lib/agents/router.ts` | Tier 1 → Tier 2 2단계 라우팅 로직 추가 |
| `lib/agents/wiki-agent.ts` | `preScore(query)` 메서드 추가 (메타데이터만 스캔) |

**`data/agents.config.json`**은 빌드 시 자동 갱신 (수동 편집 불필요).

---

## 5. 엣지 케이스

| 상황 | 처리 |
|---|---|
| 글로벌 키워드 포함 ("전체", "비교") | 기존대로 4개 전부 (의도된 동작) |
| Tier 2에서 모든 에이전트 score=0 | fallback-of-last-resort: 전부 호출 |
| 민감 토픽 포함 쿼리 | 권한 체크는 getContext 내부에서 유지 |
| 새 Obsidian 소스 추가 후 빌드 안 함 | keywords 미갱신 → 빌드 스크립트 항상 실행 필요 |

---

## 6. 구현 순서

1. `build-wiki-data.ts`에 keywords 자동 추출·갱신 로직 추가
2. 빌드 실행 → `agents.config.json` 키워드 확인
3. `wiki-agent.ts`에 `preScore()` 메서드 추가
4. `router.ts` 2단계 라우팅 구현
5. confidence 필터 분기 조정
