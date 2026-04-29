# Plan: Wiki Browser — 위키 탐색 & Synthesis 저장

> **Feature**: wiki-browser
> **Date**: 2026-04-29
> **Phase**: Plan

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | LLM 답변의 출처를 사용자가 직접 팩트체크할 방법이 없음 |
| **Solution** | `/wiki` 페이지에서 4개 위키 전체 탐색 + 채팅 답변을 Synthesis로 저장 |
| **UX Effect** | 출처 태그 클릭 → 원문 즉시 확인. 중요 Q&A는 위키에 영구 보존 |
| **Core Value** | LLM 답변 신뢰도 향상 + 위키 지식베이스 지속 축적 |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 답변자는 출처를 알지만 질문자는 팩트체크 불가 → 신뢰 문제 |
| **WHO** | 총장 후보자, 관리자 — 중요 의사결정 근거로 위키 내용 직접 확인 필요 |
| **RISK** | Vercel 서버리스 → 로컬 Obsidian에 직접 쓰기 불가. DB synthesis로 대체 |
| **SUCCESS** | 출처 클릭 시 원문 1초 내 표시. 채팅 synthesis DB 저장 및 위키 페이지 표시 |
| **SCOPE** | `app/wiki/`, `app/api/wiki/`, `lib/db/schema.ts`, `build-wiki-data.ts`, `ChatPage.tsx` |

---

## 1. 기능 구성

### 1-1. `/wiki` 페이지 — 위키 브라우저

```
┌─────────────────────────────────────────────────┐
│  SNU 거버넌스 위키                    [채팅으로] │
├──────────────────┬──────────────────────────────┤
│  [좌] 네비게이션  │  [우] 콘텐츠 뷰어             │
│                  │                              │
│  ▼ 평의원회       │  ## 제17기 평의원회 제12차    │
│    Sources (51)  │  본회의 요약                  │
│    Topics  (34)  │                              │
│    Entities(32)  │  > 원문: ...                 │
│    Syntheses (4) │  > 회의일: 2022-11-24         │
│                  │                              │
│  ▶ 이사회         │  ### 안건 개요               │
│  ▶ 대학운영계획   │  ...                         │
│  ▶ 중장기발전계획  │                              │
│                  │  [채팅에 저장] 버튼           │
└──────────────────┴──────────────────────────────┘
```

- 좌측: 아코디언으로 4개 위키 → 탭(Sources / Topics / Entities / Syntheses)
- 우측: 선택 항목 마크다운 렌더링
- URL 쿼리 파라미터로 딥링크: `/wiki?agent=senate&type=source&id=17기-12차`

### 1-2. 채팅 출처 태그 → 위키 딥링크

```
[평의원회] 17기-12차  →  /wiki?agent=senate&type=source&id=17기-12차
```

ChatPage의 출처 태그가 클릭 가능한 링크로 변환됨.

### 1-3. Synthesis 저장

**Obsidian syntheses** (JSON으로 빌드): 읽기 전용, 위키 페이지에 표시

**채팅 → Synthesis 저장**:
1. 어시스턴트 메시지에 "위키에 저장" 버튼
2. 클릭 시 Obsidian 양식으로 자동 포맷:
   ```markdown
   ---
   type: synthesis
   query: "{원문 질문}"
   answered_at: 2026-04-29
   routed_to: [평의원회, 이사회]
   tags: []
   status: active
   ---
   # {질문}
   ## [평의원회] 요약
   {에이전트별 답변 내용}
   ## 종합 분석
   {LLM 최종 답변}
   ```
3. DB `syntheses` 테이블에 저장
4. `/wiki?agent=chat-syntheses` 에서 확인 가능

---

## 2. 데이터 레이어

### 2-1. build-wiki-data.ts — syntheses 추가

```typescript
// wiki/syntheses/*.md → WikiSynthesis[]
interface WikiSynthesis {
  id: string;
  query: string;
  answeredAt: string;
  routedTo: string[];
  tags: string[];
  content: string;
  source: 'obsidian' | 'chat';  // Obsidian 원본 vs 채팅 생성
}
```

### 2-2. DB schema — syntheses 테이블 추가

```typescript
export const syntheses = pgTable('syntheses', {
  id:             text('id').primaryKey(),
  userId:         text('user_id').references(() => users.id),
  conversationId: text('conversation_id').references(() => conversations.id),
  query:          text('query').notNull(),
  answeredAt:     text('answered_at').notNull(),
  routedTo:       text('routed_to').array(),
  tags:           text('tags').array(),
  content:        text('content').notNull(),
  createdAt:      timestamp('created_at').defaultNow().notNull(),
});
```

### 2-3. types.ts — WikiSynthesis 추가

```typescript
export interface WikiSynthesis {
  id: string;
  query: string;
  answeredAt: string;
  routedTo: string[];
  tags: string[];
  content: string;
  source: 'obsidian' | 'chat';
}
```

---

## 3. API Routes

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/wiki` | 4개 위키 메타 목록 |
| GET | `/api/wiki/[agentId]` | 위키 전체 데이터 (sources/topics/entities/syntheses) |
| GET | `/api/wiki/syntheses` | DB syntheses 목록 |
| POST | `/api/wiki/syntheses` | 채팅 synthesis 저장 |

---

## 4. 신규 파일 목록

| 파일 | 역할 |
|---|---|
| `app/wiki/page.tsx` | 위키 브라우저 메인 페이지 |
| `components/wiki/WikiLayout.tsx` | 좌우 분할 레이아웃 |
| `components/wiki/WikiNav.tsx` | 좌측 네비게이션 (아코디언) |
| `components/wiki/WikiViewer.tsx` | 우측 마크다운 뷰어 |
| `components/wiki/SynthesisSaveButton.tsx` | 채팅 내 저장 버튼 |
| `app/api/wiki/route.ts` | GET /api/wiki |
| `app/api/wiki/[agentId]/route.ts` | GET /api/wiki/[agentId] |
| `app/api/wiki/syntheses/route.ts` | GET + POST /api/wiki/syntheses |

### 수정 파일

| 파일 | 변경 내용 |
|---|---|
| `scripts/build-wiki-data.ts` | syntheses 수집 추가 |
| `lib/agents/types.ts` | WikiSynthesis 타입 추가 |
| `lib/db/schema.ts` | syntheses 테이블 추가 |
| `components/chat/ChatPage.tsx` | 출처 태그 → 링크, 저장 버튼 추가 |

---

## 5. 엣지 케이스

| 상황 | 처리 |
|---|---|
| synthesis 없는 위키 | "아직 저장된 synthesis가 없습니다" 빈 상태 표시 |
| 권한 없는 사용자 | `/wiki` 페이지도 auth 필요, 민감 소스는 숨김 |
| 모바일 화면 | 좌측 nav 토글 버튼으로 숨기기/표시 |
| 긴 마크다운 | 우측 뷰어 스크롤, 좌측 nav 고정 |

---

## 6. 구현 순서

1. `build-wiki-data.ts` + `types.ts` — syntheses 포함
2. `lib/db/schema.ts` — syntheses 테이블 추가 + migration
3. API routes 3개
4. `app/wiki/page.tsx` + `WikiLayout` + `WikiNav` + `WikiViewer`
5. `ChatPage.tsx` — 출처 태그 링크 + synthesis 저장 버튼
