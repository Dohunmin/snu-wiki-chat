# Design: Citation Validator — Option C (Pragmatic) — Perplexity 번호 인용

> **Feature**: citation-validator
> **Date**: 2026-05-25
> **Phase**: Design
> **Plan Reference**: [docs/01-plan/features/citation-validator.plan.md](../../01-plan/features/citation-validator.plan.md)
> **Architecture**: Option C — Pragmatic (단일 모듈, 번호 인용 + 서버 resolve)

---

## 📌 Context Anchor (Plan에서 승계)

| 항목 | 내용 |
|---|---|
| **WHY** | LLM이 긴 source ID 혼동 → wrong-attribution. 동시에 sources 필드는 전체 retrieved 저장 → 답변·출처 분리 |
| **WHO** | 관리자 + 향후 일반 사용자. 거버넌스 정보 신뢰성 |
| **RISK** | LLM이 시스템 프롬프트 무시하고 옛 포맷 출력 가능 |
| **SUCCESS** | 95%+ [N] 형식 준수, sources = 인용된 것만, 스트리밍 유지 |
| **SCOPE** | `lib/llm/citations.ts` + `prompts.ts` + `route.ts`. UI 무수정 |

---

## 1. Overview

### 1.1 핵심 원칙

> **"LLM은 [N]만 출력. 서버가 컨텍스트 빌드 시 번호 부여 + 스트리밍 중 resolve. UI는 기존 [wiki] sid 텍스트만 받음."**

```
┌────────────────────────────────────────────────────────────────┐
│ POST /api/chat                                                 │
│                                                                │
│ ┌──────────────────────────────────┐                           │
│ │ 1. 라우팅 (기존)                  │                           │
│ └─────────────┬────────────────────┘                           │
│               │                                                │
│ ┌─────────────▼────────────────────────────┐                   │
│ │ 2. buildNumberedContexts(contexts)        │                   │
│ │    → mapping: Map<N, {wiki, sid, ...}>    │                   │
│ │    → contextMarkdown: 헤더에 [N] 주입      │                   │
│ │    → summary: "[1] [위키] sid" 줄         │                   │
│ └─────────────┬────────────────────────────┘                   │
│               │                                                │
│ ┌─────────────▼──────────────────────────┐                     │
│ │ 3. buildUserMessage(query, ctxMd, summary)                   │
│ │    → 매핑 요약 + 본문 + 질문            │                     │
│ └─────────────┬──────────────────────────┘                     │
│               │                                                │
│ ┌─────────────▼──────────────────────────┐                     │
│ │ 4. Anthropic streaming                  │                     │
│ │    각 chunk → buffer 누적               │                     │
│ │    safeFlushPoint 까지 resolveText 후   │                     │
│ │    SSE chunk 송신                       │                     │
│ │    → 부분 [N] (chunk 경계) 안전 처리     │                     │
│ └─────────────┬──────────────────────────┘                     │
│               │                                                │
│ ┌─────────────▼──────────────────────────┐                     │
│ │ 5. 종료 후                              │                     │
│ │    - fullContentRaw 전체 resolve         │                     │
│ │    - extractCitedNumbers → Set<N>        │                     │
│ │    - resolveCitations → CitationRef[]    │                     │
│ │    - DB content = resolved text          │                     │
│ │    - DB sources = cited refs (전체 X)    │                     │
│ └────────────────────────────────────────┘                     │
└────────────────────────────────────────────────────────────────┘
```

### 1.2 변경 영향 범위

| 영역 | 변경 | 위험 |
|---|---|:---:|
| `lib/llm/citations.ts` | 신규 (~130줄) | 낮음 |
| `lib/llm/prompts.ts` | P2 재작성 + buildUserMessage 시그니처 변경 | 중간 (시그니처 호출처 영향) |
| `app/api/chat/route.ts` | numbered 호출 + 스트리밍 buffer/resolve + cited sources만 저장 | 중간 |
| UI 렌더러 | 무수정 (기존 [wiki] sid 처리 그대로) | 없음 |
| DB 스키마 | 무수정 | 없음 |

---

## 2. Module Specification

### 2.1 `lib/llm/citations.ts` 핵심 API

```ts
export interface CitationRef {
  wiki: string;
  page: string;
  topic?: string;
}

export function buildNumberedContexts(contexts: AgentContext[]): {
  contextMarkdown: string;   // LLM 본문 (헤더에 [N] 마커 주입)
  mapping: Map<number, CitationRef>;
  summary: string;           // "[1] [위키] sid" 줄들
};

export function resolveText(text: string, mapping: Map<number, CitationRef>): string;
//   "...설립 [3]" → "...설립 [대학운영계획] 2026-섹션3..."

export function extractCitedNumbers(text: string): Set<number>;
//   "...[3]...[5]...[3]..." → {3, 5}

export function resolveCitations(
  numbers: Set<number>,
  mapping: Map<number, CitationRef>,
): CitationRef[];

export function safeFlushPoint(buffer: string): number;
//   스트리밍 중 부분 [N] 안전 처리
//   "text [1] then [3" → 14 ([3 시작 위치, hold from here)
```

### 2.2 번호 부여 로직

unique key = `${wiki}|${page}`. 순서: contexts 순회 → 각 context의 sources 순회 → 첫 등장 시 nextNum 부여.

### 2.3 헤더 [N] 주입

기존 헤더 패턴: `## {title} ({sourceId}) | 회의일: ...` 또는 `## [{type}] {title} ({sourceId}) | ...`

정규식으로 매칭, [N] 주입 → `## [N] {title} ({sourceId}) ...` 또는 `## [type] [N] {title} ...`

여러 chunk가 같은 source면 모든 chunk 헤더에 같은 [N].

### 2.4 스트리밍 + resolve 알고리즘

```ts
let buffer = '';
let fullContentRaw = '';
for await (chunk of stream) {
  buffer += chunk.text;
  fullContentRaw += chunk.text;
  const point = safeFlushPoint(buffer);
  if (point > 0) {
    const flushed = buffer.slice(0, point);
    send({ type: 'chunk', content: resolveText(flushed, mapping) });
    buffer = buffer.slice(point);
  }
}
if (buffer) send({ type: 'chunk', content: resolveText(buffer, mapping) });
```

`safeFlushPoint`:
- 마지막 `[` 없음 → 전체 flush
- 마지막 `[` 가 완성된 `[N]` → 전체 flush
- 마지막 `[` 미완성 (`[`, `[1`, `[12`) → 그 위치까지만 flush, 나머지 hold

### 2.5 sources 저장 (LLM 인용된 것만)

```ts
const fullContent = resolveText(fullContentRaw, mapping);
const cited = extractCitedNumbers(fullContentRaw);
const citedSources = resolveCitations(cited, mapping);

await db.insert(messages).values({
  content: fullContent,    // resolve된 텍스트
  sources: citedSources,   // LLM이 실제 인용한 것만
});
```

기존: `routing.contexts.flatMap(c => c.sources)` (~30개) → 새: `citedSources` (~3-7개).

---

## 3. Decision Records

### 3.1 왜 번호 인용 (Quote/Embedding 검증 폐기)

- Quote 강제: LLM 출력 부담 +20~30%, 포맷 추함
- Embedding sim: 추가 200ms latency, 임계값 튜닝 필요, 의미 반전 못 잡음
- 번호 인용: LLM 부담 ↓ (긴 ID → 짧은 [N]), wrong-attribution 구조적 차단, 검증 latency 0

### 3.2 왜 서버 resolve (클라이언트 mapping 송신 안 함)

- 서버에서 resolve해서 보내면: UI 렌더러는 기존 `[wiki] sid` 처리 그대로 사용 — backward compat 자동
- 클라이언트가 mapping 받아 처리하면: UI 코드 변경 + 매번 mapping 송신 + DB 저장 형식 결정 복잡
- 서버 resolve가 단순하고 명확

### 3.3 왜 sources = cited only (전체 retrieved 폐기)

- 사용자 화면 "참고 자료"는 답변에 실제 등장한 자료 목록이어야 의미 있음
- 전체 retrieved (30개)는 노이즈 — LLM이 안 본 자료까지 포함
- cited sources (3~7개)는 답변과 1:1 결합 — 사용자가 인용 클릭하면 진짜 그 source

### 3.4 왜 retry / 검증 메커니즘 없음

- 번호 인용으로 wrong-attribution 자체가 차단되어 검증 불필요
- LLM이 옛 포맷 사용해도 → resolveText가 [wiki] sid 패턴은 그대로 둠 → UI 렌더러가 처리 → graceful degradation
- LLM이 범위 밖 [N] 출력 → resolveText가 미매칭 [N]은 그대로 → UI에서 깨진 표시 → LLM 실수 visible
- Retry 인프라 없이도 구조적으로 안전

---

## 4. 시뮬레이션

### 4.1 정상 흐름

```
컨텍스트:
[1] [평의원회] 19기-4차
[2] [평의원회] 19기-7차
[3] [대학운영계획] 2026-섹션3-추진성과및기본방향
...

LLM 출력 stream:
"평의원회는 등록금 동결 의결 [1]. AI대학원은 [2]에서 검토. SNU-CMU HCAI 설립은 [3] 기록..."

스트리밍 chunk 단위로 resolve → 사용자 화면:
"평의원회는 등록금 동결 의결 [평의원회] 19기-4차. AI대학원은 [평의원회] 19기-7차에서 검토. SNU-CMU HCAI 설립은 [대학운영계획] 2026-섹션3-추진성과및기본방향 기록..."

종료 후:
  cited = {1, 2, 3}
  sources = 3개 (전체 retrieved 30개 아님)
```

### 4.2 CMU 케이스 재현

LLM이 컨텍스트에서 [3] = `[대학운영계획] 2026-섹션3-추진성과및기본방향` 임을 본문에 명시된 헤더 (`## [3] 섹션 III ...`) 로 정확히 파악. CMU 사실은 [3] 본문에 있으므로 [3] 인용 → 정확.

긴 ID 혼동 가능성 없음. wrong-attribution 차단.

---

## 5. Test Plan

### 5.1 단위 테스트 (`scripts/test-citation-numbering.ts`)

| Test | 검증 |
|---|---|
| safeFlushPoint — plain text | 전체 flush |
| safeFlushPoint — 완성된 [N] | 전체 flush |
| safeFlushPoint — 미완성 `[`, `[1`, `[12` | [ 위치 hold |
| buildNumberedContexts — 번호 부여 | 1부터 순차 |
| buildNumberedContexts — 헤더 마킹 | source 헤더에 [N] 주입 |
| resolveText | [N] → [wiki] sid 치환 |
| extractCitedNumbers | Set 중복 제거 |
| resolveCitations — 매칭 안 됨 | skip |

### 5.2 실측 (chat UI)

- CMU/HCAI 질문 → 정확한 source로 인용 확인
- 일반 쿼리 5건 → sources 필드 = 인용된 것만 (전체 retrieved 아님)
- 스트리밍 체감 latency 변화 없음 확인

---

## 6. Risks & Mitigations

| 위험 | 완화 |
|---|---|
| LLM이 [N] 무시하고 옛 포맷 사용 | 시스템 프롬프트 강한 규칙. 옛 포맷도 UI 렌더러 처리 가능 (graceful) |
| 범위 밖 [N] 출력 | resolveText skip → 사용자에게 [숫자] 그대로 노출 → LLM 실수 visible |
| 스트리밍 chunk 경계 | safeFlushPoint로 안전 처리 |
| 시스템 프롬프트 토큰 증가 (매핑 요약) | source 30개 기준 ~1KB. 무시 가능 |
| 본문에 사용자가 직접 적은 `[숫자]` 가 있는 경우 (드물게) | 매핑에 없는 번호는 그대로 둠. 영향 없음 |

---

## 7. Out of Scope

- Embedding/LLM-judge 검증
- Retry 메커니즘
- 자동 citation rewrite
- UI에 [1], [2] 번호 그대로 표시 (사용자엔 [wiki] sid 가 의미 있음)
- Wiki browser / synthesis 검증

---

## 8. Implementation Guide

### 8.1 구현 순서

1. **`lib/llm/citations.ts`** 신규 — 5개 함수 + interfaces
2. **`scripts/test-citation-numbering.ts`** — 단위 + 실측 검증
3. **`lib/llm/prompts.ts`** — P2 재작성 + buildUserMessage 시그니처
4. **`app/api/chat/route.ts`** — buildNumberedContexts 호출 + 스트리밍 buffer/resolve + DB 저장 수정

### 8.2 Session Guide

전체 한 세션 ~1.5시간. 모듈 분리 불필요.

| Step | 작업 | 시간 |
|---|---|---|
| 1 | citations.ts | 40분 |
| 2 | 테스트 + 실행 검증 | 20분 |
| 3 | prompts.ts (P2 + 시그니처) | 15분 |
| 4 | route.ts 통합 | 15분 |
| 5 | 빌드 + 실측 | 10분 |

### 8.3 Dependencies

없음 (외부 라이브러리·환경 변수·DB 마이그레이션 모두 불필요).
