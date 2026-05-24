# Design: Recency Boost — Option C (Pragmatic Balance)

> **Feature**: recency-boost
> **Date**: 2026-05-25
> **Phase**: Design
> **Plan Reference**: [docs/01-plan/features/recency-boost.plan.md](../../01-plan/features/recency-boost.plan.md)
> **Architecture**: Option C — Pragmatic Balance

---

## 📌 Context Anchor (Plan에서 승계)

| 항목 | 내용 |
|---|---|
| **WHY** | 현재 검색 점수가 시간을 모름. 오래되고 backlink 많은 자료가 항상 신규 자료를 이김. 사용자가 "최근"이라 물어봐도 1~2년 전 자료가 응답됨 |
| **WHO** | 모든 사용자 — 신규 회의록/계획서가 추가되었을 때 즉시 활용되어야 함. 운영자는 새 자료 추가 후 검색 검증 부담 감소 |
| **RISK** | 시간성 키워드 false positive, 시간성×관련도 충돌, 회귀 (시간성 없는 쿼리는 기존 동작 유지) |
| **SUCCESS** | 진단 스크립트 5개 시간성 쿼리 중 4개 이상에서 19기-7차/8차 진입. 비-시간성 쿼리 결과 무변화 |
| **SCOPE** | `lib/agents/wiki-agent.ts` source scoring 수정 + 신규 `lib/agents/recency.ts`. RRF/router/임베딩 무수정 |

---

## 1. Overview

### 1.1 설계 핵심 원칙

> **"시간성 감지는 신규 모듈에 격리. wiki-agent.ts는 단일 지점에서 조건부 점수 가산만 호출."**

```
┌──────────────────────────────────────────────────────────────────┐
│ WikiAgent.getContext(query, role, ...)                          │
│ ┌────────────────────────────────────────────┐                  │
│ │ 기존 source scoring (보존)                   │                  │
│ │  • guaranteed +5                            │                  │
│ │  • topic +3, entity +2, tag +2              │                  │
│ │  • content word +1                          │                  │
│ │  → sourcesWithScore: { source, score }[]    │                  │
│ └─────────────┬──────────────────────────────┘                  │
│               │                                                  │
│               ↓ (recency 조건부 단일 지점 — 신규)                  │
│ ┌──────────────────────────────────────────────┐                │
│ │ const isRecency = detectRecencyIntent(query) │                │
│ │ if (isRecency) {                             │                │
│ │   score += recencyScore(source)              │                │
│ │ }                                            │                │
│ └──────────────────────────────────────────────┘                │
│               │                                                  │
│               ↓                                                  │
│ ┌────────────────────────────────────────────┐                  │
│ │ 기존 후속 로직 (보존)                        │                  │
│ │  • candidateSources 필터                    │                  │
│ │  • chunk scoring                            │                  │
│ │  • 청크 cap, RRF 융합 (ragEnabled), 출력 포맷│                  │
│ └────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────┘
                │
                ↓ 호출
┌──────────────────────────────────────────────────────────────────┐
│ lib/agents/recency.ts                       (신규, 단일 파일)     │
│ ├── RECENCY_KEYWORDS: readonly string[]                          │
│ ├── detectRecencyIntent(query: string): boolean                 │
│ ├── recencyScore(source: WikiSource): number                    │
│ │     ├─ dateBoost(date) — 3개월/6개월/1년/2년 step decay        │
│ │     └─ sequenceBoost(id) — N기 M차 패턴 추출, max 기수 보너스  │
│ └── (internal) parseSequence(id): { gi, cha } | null            │
└──────────────────────────────────────────────────────────────────┘
```

### 1.2 변경 영향 범위

| 영역 | 변경 | 위험 |
|---|---|:---:|
| `lib/agents/recency.ts` | 신규 (~80줄) | 낮음 |
| `lib/agents/wiki-agent.ts` | source scoring 블록에 +5줄 | 낮음 (조건부 가산만) |
| `scripts/diagnose-recency.ts` | 회귀 테스트 쿼리 보강 (이미 존재) | 낮음 |
| `lib/agents/router.ts` | 무수정 | 없음 |
| `lib/embed/*` (vector/RRF) | 무수정 | 없음 |
| `lib/llm/prompts.ts` | 무수정 | 없음 |
| DB 스키마/마이그레이션 | 없음 | 없음 |

---

## 2. Module Specification

### 2.1 `lib/agents/recency.ts` (신규)

```ts
import type { WikiSource } from './types';

// ─── 시간성 키워드 사전 ──────────────────────────────────────────
// 상대 시간 표현만 포함. "N년" 같은 절대 시점 숫자 패턴 제외.
// 역방향 시간성 ("처음에는", "초창기") — v2 보류.
export const RECENCY_KEYWORDS: readonly string[] = [
  // 상대 시점
  '최근', '최신', '이번', '요즘', '현재', '근래', '지난',
  // 기간
  '올해', '작년', '이번달', '지난달', '이번주', '지난주',
] as const;

/** 쿼리에 시간성 키워드가 포함되었는지 검사 */
export function detectRecencyIntent(query: string): boolean {
  const lower = query.toLowerCase();
  return RECENCY_KEYWORDS.some(kw => lower.includes(kw));
}

// ─── Date 기반 boost ────────────────────────────────────────────
const DAY_MS = 1000 * 60 * 60 * 24;

function dateBoost(dateStr: string | undefined): number {
  if (!dateStr) return 0;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return 0;
  const days = (Date.now() - t) / DAY_MS;
  if (days < 0) return 20;        // 미래 날짜도 최신 취급
  if (days <= 90) return 20;
  if (days <= 180) return 15;
  if (days <= 365) return 10;
  if (days <= 730) return 5;
  return 0;
}

// ─── Sequence (N기 M차) 기반 boost ────────────────────────────────
// 예: "19기-8차서면심의" → { gi: 19, cha: 8 }
//     "19기-7차"        → { gi: 19, cha: 7 }
//     "2024-1차"        → null (기수 패턴 없음)
const SEQUENCE_PATTERN = /(\d+)기[-_]?(\d+)차/;

interface Sequence { gi: number; cha: number }

function parseSequence(id: string): Sequence | null {
  const m = id.match(SEQUENCE_PATTERN);
  if (!m) return null;
  return { gi: parseInt(m[1], 10), cha: parseInt(m[2], 10) };
}

/**
 * Sequence boost (date 없는 위키용 fallback).
 * 기수가 클수록 가산. 같은 기수 안에서는 차수가 큰 게 더 최신.
 * 절대적 max를 모르므로 점수 범위는 dateBoost와 비슷한 0~20.
 *
 *   기수 1~9: 0점
 *   기수 10~14: +5점
 *   기수 15~17: +8점
 *   기수 18: +12점
 *   기수 19+: +18점
 *   + 차수 보너스: 1~5차 +0, 6~9차 +1, 10차+ +2
 */
function sequenceBoost(id: string): number {
  const seq = parseSequence(id);
  if (!seq) return 0;
  let score: number;
  if (seq.gi >= 19) score = 18;
  else if (seq.gi >= 18) score = 12;
  else if (seq.gi >= 15) score = 8;
  else if (seq.gi >= 10) score = 5;
  else score = 0;
  if (seq.cha >= 10) score += 2;
  else if (seq.cha >= 6) score += 1;
  return score;
}

/**
 * Source 단위 recency 점수.
 * - date 있으면 dateBoost 우선
 * - 없으면 sequenceBoost fallback
 * - 둘 다 0이면 0
 */
export function recencyScore(source: WikiSource): number {
  if (source.date) return dateBoost(source.date);
  return sequenceBoost(source.id);
}
```

### 2.2 `lib/agents/wiki-agent.ts` (수정)

**기존 코드 (변경 전)** — [wiki-agent.ts:135-184](../../../lib/agents/wiki-agent.ts#L135-L184):

```ts
const queryLower = query.toLowerCase();
const queryWords = queryLower.split(/[\s,]+/).filter(w => w.length >= 2);

// ... 권한 필터, entity 역참조 ...

const sourcesWithScore = allowedSources.map(source => {
  let score = 0;
  if (guaranteedIds.has(source.id)) score += 5;
  for (const t of source.topics) { /* topic +3 */ }
  for (const e of source.entities) { /* entity +2 */ }
  for (const tag of source.tags) { /* tag +2 */ }
  const contentLower = source.content.toLowerCase();
  for (const word of queryWords) {
    if (contentLower.includes(word)) score += 1;
  }
  return { source, score };
});
```

**변경 후** — 4곳 추가:

```ts
import { detectRecencyIntent, recencyScore } from './recency';  // ← 추가 (1)

// ... 기존 코드 ...

const queryLower = query.toLowerCase();
const queryWords = queryLower.split(/[\s,]+/).filter(w => w.length >= 2);
const isRecencyQuery = detectRecencyIntent(query);              // ← 추가 (2)

// ... 권한 필터, entity 역참조 ...

const sourcesWithScore = allowedSources.map(source => {
  let score = 0;
  if (guaranteedIds.has(source.id)) score += 5;
  // ... 기존 topic/entity/tag/content 점수 ...
  if (isRecencyQuery) score += recencyScore(source);            // ← 추가 (3, source-level: candidateSources 필터 통과 보장)
  return { source, score };
});

// ─── 청크 단위 점수 계산 ───
for (const source of sourcesToProcess) {
  const isGuaranteed = guaranteedIds.has(source.id);
  const sourceRecencyBoost = isRecencyQuery ? recencyScore(source) : 0;  // ← 추가 (4a)
  const chunks = splitIntoChunks(source.content);
  for (const chunk of chunks) {
    let score = scoreChunk(chunk, queryWords);
    if (isGuaranteed) score = score * 2 + 1;
    score += sourceRecencyBoost;                                // ← 추가 (4b, chunk-level: 청크 cap 통과 보장)
    if (score > 0) { scoredChunks.push({...}); }
  }
}
```

### ⚠️ 구현 중 발견된 design 미흡 — 청크 단계 전파 필요

**초기 설계**(source-level 가산만)는 실패. 이유:
- `sourcesWithScore`의 score는 **`candidateSources` 필터(`score > 0`)에만 사용**됨
- 청크 cap 단계는 **청크 단위 점수 (`scoreChunk(chunk, queryWords)`)**로 독립 결정
- 19기-7차 본문에 "최근" 같은 키워드가 없으면 청크 점수 0 → 컨텍스트 미진입
- 진단 결과: source-level만으론 1/5 PASS (FAIL)

**수정**: 청크 점수에도 `sourceRecencyBoost` 전파.
- 같은 source의 모든 청크에 동일 boost (인플레이션 우려 → 실측에서 cap 균등화 로직이 자연스럽게 처리 확인)
- 진단 결과: chunk-level 전파 추가 후 4/5 PASS ✅

총 4곳 추가 (import + 변수 + source-level 가산 + chunk-level 가산 2줄).

---

## 3. Decision Records

### 3.1 왜 점수 가산 (guarantee 아님)?

**대안**: "시간성 쿼리에 한해 top-N 최신 source 무조건 포함" (guarantee).

**채택 안 함**:
- "최근 학생복지 안건" — 관련도 0인 최신 source 강제 포함 → 컨텍스트 오염
- Guarantee는 LLM이 인용 못 해도 비용 발생 (토큰 소비)
- 가산 방식은 관련도와 시간성 자연 융합

### 3.2 왜 date 있으면 sequence 무시?

**대안**: dateBoost + sequenceBoost 둘 다 합산.

**채택 안 함**:
- senate/board 같이 date·sequence 둘 다 있는 경우 boost 중복 → 점수 폭주
- date가 더 정확한 신호 — sequence는 fallback일 뿐
- `Math.max` 대신 `if-else`로 명확히 의도 표현

### 3.3 왜 step decay (선형 decay 아님)?

**대안**: `score = 20 * (1 - days/730)` 같은 연속 함수.

**채택 안 함**:
- "3개월 이내" 같은 경계가 명확 — 사용자 멘탈 모델과 맞음
- 디버깅 용이 (점수 예측 가능)
- 튜닝 시 4개 숫자만 조정하면 됨

### 3.4 왜 sequence boost는 절대 점수 (max 기수 동적 추출 아님)?

**대안**: 위키별로 max 기수를 런타임에 구해서 상대적 비율로 boost.

**채택 안 함**:
- 동적 max는 런타임 오버헤드 (모든 source 한 번 더 스캔)
- 절대 점수면 결정적 (deterministic) — 테스트 쉬움
- 기수 19+는 현재 데이터의 max이므로 18점 (최대치) 부여로 충분

---

## 4. Data Model

### 4.1 입력 (기존)

`WikiSource` ([lib/agents/types.ts:51-60](../../../lib/agents/types.ts#L51-L60)):
```ts
interface WikiSource {
  id: string;          // 예: "19기-7차"
  date?: string;       // 예: "2026-04-16"  (ISO 형식)
  // ... title, content, topics, entities, tags, sensitive ...
}
```

date 필드 커버리지 (Plan에서 확인):
- 100%: senate / board / plan / yhl-speeches
- 0%: vision / history / status / finance / leesj

### 4.2 출력

신규 데이터 모델 없음. `recencyScore(source: WikiSource): number` 만 반환. 기존 score에 합산.

---

## 5. 점수 시뮬레이션

쿼리: `"평의원회 최근 이슈 알려줘"` → `isRecencyQuery = true`

| Source | 기존 점수 | dateBoost | seqBoost | recencyScore | 최종 |
|---|---|---|---|---|---|
| 19기-8차서면심의 (2026-04-20) | 2 | +20 (3개월) | (skip, date 있음) | +20 | 22 |
| 19기-7차 (2026-04-16) | 2 | +20 | skip | +20 | 22 |
| 19기-5차 (2026-03-19) | 2 | +20 | skip | +20 | 22 |
| 18기-14차 (2025-02-13) | 8 | +5 (730일 이내) | skip | +5 | 13 |
| 17기-19차 (2023-05-18) | 12 (backlinks) | 0 | skip | 0 | 12 |
| 17기-2차 (2021-11-17) | 6 | 0 | skip | 0 | 6 |

→ 19기 회의록들이 상위 진입. 17기-19차는 강한 backlink 점수에도 12로 밀림. ✅ SC1 달성.

쿼리: `"평의원회 진행 상황"` → `isRecencyQuery = false` ("진행"은 RECENCY_KEYWORDS에 없음)
→ recencyScore 호출 안 됨. 기존과 100% 동일. ✅ SC2 달성.

쿼리: `"AI대학원 설립"` (vision 위키 영향, date 없음)
→ `isRecencyQuery = false`. fallback 작동 안 함. 회귀 0.

---

## 6. Test Plan

### 6.1 단위 테스트 (신규 `tests/unit/recency.spec.ts` 또는 scripts에 통합)

| Test | Input | Expected |
|---|---|---|
| `detectRecencyIntent` true case | "평의원회 최근 이슈" | `true` |
| `detectRecencyIntent` true case | "이번 평의원회 안건" | `true` |
| `detectRecencyIntent` true case | "올해 등록금 정책" | `true` |
| `detectRecencyIntent` false case | "70년 역사 알려줘" | `false` |
| `detectRecencyIntent` false case | "AI대학원 설립" | `false` |
| `detectRecencyIntent` false case | "이석재 입장" | `false` |
| `dateBoost` 3개월 이내 | "2026-04-20" | `20` |
| `dateBoost` 1년 경과 | "2025-05-25" | `10` |
| `dateBoost` 3년 경과 | "2023-05-25" | `0` |
| `dateBoost` invalid date | "abc" | `0` |
| `dateBoost` 미래 | "2027-01-01" | `20` |
| `sequenceBoost` 19기-8차 | "19기-8차서면심의" | `19` (18+1) |
| `sequenceBoost` 18기-1차 | "18기-1차" | `12` |
| `sequenceBoost` 17기-19차 | "17기-19차" | `10` (8+2) |
| `sequenceBoost` 패턴 없음 | "2024-1차" | `0` |
| `recencyScore` date 있음 | `{ id: '19기-7차', date: '2026-04-16' }` | `20` (date 우선) |
| `recencyScore` date 없음 | `{ id: '19기-7차' }` | `19` (sequence fallback) |
| `recencyScore` 둘 다 없음 | `{ id: 'random-id' }` | `0` |

### 6.2 회귀 테스트 ([scripts/diagnose-recency.ts](../../../scripts/diagnose-recency.ts))

기존 5개 시간성 쿼리 + **신규 비-시간성 5개 추가** — before/after diff:

```ts
const NON_RECENCY_QUERIES = [
  '교육 분야 안건',
  'AI 정책',
  '이사회 의결사항',
  '재정 현황',
  '캠퍼스 인프라',
];
```

각 쿼리에 대해 source ID set 출력. 시간성 쿼리는 19기-7차/8차 포함 여부 확인. 비-시간성 쿼리는 set diff = 0 검증.

### 6.3 통합 (수동) 테스트

채팅 UI에서 직접 입력:
1. "평의원회 최근 이슈 알려줘" → 답변 인용에 19기-7차 또는 8차 등장 확인
2. "이번 평의원회 안건" → 동일
3. "교육 분야 안건" → 기존 답변과 인용 source 셋이 거의 동일 (회귀 무)

---

## 7. Risks & Mitigations

| 위험 | 완화 |
|---|---|
| RECENCY_KEYWORDS false positive ("올해의 도서") | 보수적 키워드 유지. 발견 시 사전에 negative pattern 추가 검토 |
| dateBoost 강도 과다 → 관련도 0 최신 자료가 1위 | max +20 (관련도 5점/단어 × 4단어 = 20과 동등). topic+entity 매칭 강한 자료는 여전히 우위 |
| sequenceBoost가 17기 자료에도 +10 부여 → 노이즈 | dateBoost가 0이라 합산 안 됨 (date 있는 위키는 sequence skip). date 없는 위키만 sequence 작동 |
| 미래 일자 source (실수 frontmatter) | dateBoost는 미래도 20점 → 안전. 데이터 검증 책임은 build-wiki-data 단계 |
| timezone — `new Date(date).getTime()` UTC 기준 vs KST | 일자만 비교 (시:분:초 무관)이므로 timezone 영향 무시 가능 |
| 신규 회의록 추가 후 build 안 했을 때 | recency도 똑같이 적용 안 됨 (data/*.json에 없음). 별도 문제, 기존 watch 자동화로 처리 중 |
| 시간성 + 도메인 충돌 ("최근 학생복지") | 학생복지 매칭 점수 + recency 점수 합산. 균형 작동 (테스트로 검증) |
| LLM이 backlink 강한 자료 인용 우선시 | 컨텍스트에 들어온 자료의 회의일 메타데이터로 자연스럽게 최신 우선시 (별도 프롬프트 지시 불필요) |

---

## 8. Performance

- 추가 비용: detectRecencyIntent 1회 (RECENCY_KEYWORDS 13개 indexOf) + source 수만큼 recencyScore 호출
- senate 53 source × `Date.now()` + 비교 → 1ms 이내
- 메모리: 신규 캐시 없음
- DB 추가 쿼리 없음
- 임베딩 추가 호출 없음
- **결론**: 측정 불가능한 수준의 오버헤드

---

## 9. Rollback

코드 단순. 롤백은 wiki-agent.ts에서 3줄 제거 + recency.ts 삭제로 끝.

긴급 disable이 필요하면 `detectRecencyIntent`가 항상 `false` 반환하도록 한 줄 수정:
```ts
export function detectRecencyIntent(query: string): boolean {
  return false;  // EMERGENCY DISABLE
}
```

별도 환경 변수 플래그 도입 안 함 (YAGNI — Plan 명시).

---

## 10. Out of Scope (Plan 재확인)

- 역방향 시간성 ("초창기", "예전")
- 절대 시점 ("2024년", "N년" 숫자 패턴)
- Date 자동 추출 (누락 source 보강)
- RRF 단계 recency 가중
- Decay 곡선 튜닝 (현재 step function 고정)
- 환경 변수 플래그
- UI 인디케이터

---

## 11. Implementation Guide

### 11.1 구현 순서

1. **`lib/agents/recency.ts` 신규 작성** (~80줄)
   - RECENCY_KEYWORDS, detectRecencyIntent
   - dateBoost (step decay)
   - parseSequence, sequenceBoost
   - recencyScore (date 우선, sequence fallback)

2. **`lib/agents/wiki-agent.ts` 수정** (3줄)
   - import 추가
   - `const isRecencyQuery = detectRecencyIntent(query)` (queryWords 정의 직후)
   - sourcesWithScore.map 내 `if (isRecencyQuery) score += recencyScore(source)`

3. **회귀 테스트 보강 (`scripts/diagnose-recency.ts`)**
   - NON_RECENCY_QUERIES 5개 추가
   - source ID set diff 출력 (시간성 쿼리는 before/after 비교용으로도 유용)

4. **단위 테스트** (선택 — 현재 프로젝트 jest/vitest 설정 없음)
   - 우선 진단 스크립트로 검증
   - 추후 vitest 도입 시 테스트 케이스 이관

5. **수동 검증**
   - 진단 스크립트 실행 → SC1, SC2 확인
   - dev 서버 실측 (3개 쿼리)

### 11.2 주요 파일

- 신규: `lib/agents/recency.ts`
- 수정: `lib/agents/wiki-agent.ts` (3줄)
- 수정: `scripts/diagnose-recency.ts` (비-시간성 쿼리 보강)

### 11.3 Session Guide

단일 세션으로 충분. 모듈 분리 불필요.

| Module | Scope key | 작업 | 예상 시간 |
|---|---|---|---|
| module-1 | `core` | recency.ts 신규 + wiki-agent.ts 3줄 수정 | 20분 |
| module-2 | `test` | diagnose-recency.ts 보강 + 실행 검증 | 10분 |

권장: `--scope` 없이 한 번에 (`/pdca do recency-boost`).

### 11.4 Dependencies

- 외부 라이브러리: 없음
- 환경 변수: 없음
- DB 마이그레이션: 없음
- npm install: 없음
