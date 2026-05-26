# Design: Conversation Ownership — Option C (Pragmatic) — 서버 hard floor + 클라 자동 readOnly + 공용 모달 추출

> **Feature**: conversation-ownership
> **Date**: 2026-05-26
> **Phase**: Design
> **Plan Reference**: [docs/01-plan/features/conversation-ownership.plan.md](../../01-plan/features/conversation-ownership.plan.md)
> **Architecture**: Option C — Pragmatic Balance

---

## 📌 Context Anchor (Plan에서 승계)

| 항목 | 내용 |
|---|---|
| **WHY** | 동일 conversationId에 admin lens 대화와 tier1 normal 질문이 섞여 저장됨. chat API에 ownership 검증 부재 + 클라이언트 readOnly 가드가 URL restore 경로로 우회됨 |
| **WHO** | 모든 인증 사용자. 정상 흐름의 사고가 다수, 의도적 우회는 부차 |
| **RISK** | 서버 403이 정상 흐름에서 사용자에게 노출되면 UX 나쁨 → 클라이언트 가드로 사전 차단 필요. 클라이언트만 두면 보안 floor 없음 |
| **SUCCESS** | 정상 흐름 0건 / 자동 readOnly / 직접 fetch 403 / 30+모달 / 300건 탐색 / race 처리 |
| **SCOPE** | `app/api/chat/route.ts` / `app/api/conversations/public/route.ts` / `components/chat/ChatPage.tsx` + 신규 `components/chat/ConversationsListModal.tsx` |

---

## 1. Overview

### 1.1 핵심 원칙

> **"서버가 hard floor (403). 클라이언트가 ownership을 미리 감지해서 403이 정상 흐름에서 트리거되지 않도록. 모달은 1벌만 유지."**

```
┌──────────────────────────────────────────────────────────────────────┐
│                       정상 흐름 (사고 차단)                            │
│                                                                      │
│  사용자가 "모든 유저 질문" 클릭 / URL ?conv=<남의ID> 새로고침          │
│           ▼                                                          │
│  loadConversation(convId, readOnly?)                                 │
│           ▼                                                          │
│  readOnly === undefined 이면                                         │
│  → isOwn = conversations.some(c => c.id === convId)                  │
│  → effectiveReadOnly = !isOwn  ← 핵심                                │
│           ▼                                                          │
│  isReadOnly=true → 입력창 hidden + "새 대화 시작" 버튼만              │
│           ▼                                                          │
│  사용자가 메시지 보내려 해도 입력창이 없음 → 서버 403 안 도달          │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                  보안 floor (악의·DevTools 우회)                       │
│                                                                      │
│  fetch('/api/chat', { body: { conversationId: '<남의ID>' } })        │
│           ▼                                                          │
│  POST /api/chat                                                      │
│  if (conversationId) {                                               │
│    const [conv] = await db.select({ userId })                        │
│      .from(conversations).where(eq(id, conversationId))              │
│    if (!conv) → 404                                                  │
│    if (conv.userId !== session.user.id) → 403                        │
│  }                                                                   │
│           ▼                                                          │
│  남의 대화 DB INSERT 차단                                              │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 변경 영향 범위

| 영역 | 변경 | 위험 |
|---|---|:---:|
| `app/api/chat/route.ts` | ownership 검증 if-block 추가 (~10줄) | 낮음 (단일 DB select 추가) |
| `app/api/conversations/public/route.ts` | limit 100→300, `?offset=N` Zod parse | 낮음 |
| `components/chat/ChatPage.tsx` | `loadConversation` ownership 자동 판정 + race 처리 + 공용 모달 사용 | 중간 (state 흐름 변경) |
| `components/chat/ConversationsListModal.tsx` | 신규 (~60줄) — 내 대화/공개 대화 공용 | 낮음 |
| DB / LLM / 라우팅 | 무수정 | 없음 |

---

## 2. Module Specification

### 2.1 신규: `components/chat/ConversationsListModal.tsx`

내 대화 모달과 공개 대화 모달이 동일한 JSX를 갖게 되므로 공용 컴포넌트로 추출.

```ts
interface ConversationListItem {
  id: string;
  title: string | null;
  mode?: string;
  createdAt?: string;
}

interface ConversationsListModalProps {
  title: string;                                  // "내 대화 전체" / "모든 유저 질문 전체"
  conversations: ConversationListItem[];
  currentConvId?: string;
  isReadOnlyCurrent: boolean;                     // 모달의 "지금 보는" 표시 색
  onSelect: (convId: string) => void;
  onDelete?: (convId: string, e: React.MouseEvent) => void;  // 공개 모달엔 없음
  onClose: () => void;
  emptyText: string;
  variant?: 'mine' | 'public';                    // 색상 분기 (blue vs amber)
}
```

**책임**:
- 모달 외곽 (backdrop + close 버튼 + 헤더)
- conversations 리스트 렌더링 + 클릭 핸들러
- variant에 따른 색상 분기 (mine=blue/lens=emerald, public=amber)
- `onDelete` 콜백이 있으면 trash icon 표시, 없으면 숨김

**상태 없음** — 모두 props로 받음. 부모(ChatPage)가 open/close state 관리.

### 2.2 서버: `app/api/chat/route.ts` ownership 검증

```ts
// existing imports
import { conversations as conversationsTable } from '@/lib/db/schema';

// after parsed.data, before ensureUserExists
if (conversationId) {
  const [conv] = await db
    .select({ userId: conversationsTable.userId })
    .from(conversationsTable)
    .where(eq(conversationsTable.id, conversationId))
    .limit(1);

  if (!conv) {
    return Response.json({ error: '대화를 찾을 수 없습니다.' }, { status: 404 });
  }
  if (conv.userId !== userId) {
    return Response.json({ error: '본인 대화에만 메시지를 보낼 수 있습니다.' }, { status: 403 });
  }
}
```

**삽입 위치**: [route.ts:53](app/api/chat/route.ts#L53) (lens 모드 검증 직후, `ensureUserExists` 호출 전).

**선언 충돌 주의**: 라우트 안에 이미 `import { conversations, messages, users }` 가 있음 ([route.ts:25](app/api/chat/route.ts#L25)). `conversations`를 그대로 쓰면 lambda scope 안에 같은 이름의 state가 없으므로 별칭 불필요. 단, 명확성을 위해 import 그대로 사용 가능.

### 2.3 서버: `app/api/conversations/public/route.ts` pagination

```ts
import { z } from 'zod';

const querySchema = z.object({
  offset: z.coerce.number().int().nonnegative().optional().default(0),
  limit: z.coerce.number().int().min(1).max(300).optional().default(300),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    offset: url.searchParams.get('offset'),
    limit: url.searchParams.get('limit'),
  });
  if (!parsed.success) {
    return Response.json({ error: '잘못된 페이지네이션 파라미터입니다.' }, { status: 400 });
  }
  const { offset, limit } = parsed.data;
  const userId = session.user.id;

  const rows = await db
    .select({ id: conversations.id, title: conversations.title, createdAt: conversations.createdAt })
    .from(conversations)
    .where(ne(conversations.userId, userId))
    .orderBy(desc(conversations.createdAt))
    .limit(limit)
    .offset(offset);

  return Response.json(rows);
}
```

**기본 동작**: 클라이언트가 파라미터 없이 호출하면 `offset=0, limit=300` — 기존 동작 호환 (100 → 300으로 cap만 상향).

### 2.4 클라이언트: `ChatPage.tsx` 자동 readOnly

**`loadConversation` 시그니처 변경**:

```ts
async function loadConversation(convId: string, readOnly?: boolean) {
  // readOnly 미지정 시 ownership으로 자동 결정
  // conversations(=내 대화 목록)에 있으면 내 것 → readOnly=false
  // 없으면 남의 것 → readOnly=true
  const isOwn = conversations.some(c => c.id === convId);
  const effectiveReadOnly = readOnly ?? !isOwn;

  if (convId === currentConvId && isReadOnly === effectiveReadOnly) return;

  setSidebarOpen(false);
  setConvLoading(true);
  setCurrentConvId(convId);
  setIsReadOnly(effectiveReadOnly);
  setLensInsufficient(null);

  // 내 대화일 때만 lens 모드 이어받음 — 기존 로직 유지, isOwn 사용
  if (!effectiveReadOnly && isOwn) {
    const conv = conversations.find(c => c.id === convId);
    if (conv?.mode?.startsWith('lens:') && isAdmin) {
      setChatMode(conv.mode);
    } else {
      setChatMode('normal');
    }
  } else {
    setChatMode('normal');
  }

  // ... rest unchanged (fetch messages)
}
```

**기존 호출처 호환**:
- `loadConversation(conv.id)` — `readOnly`가 undefined이므로 ownership 자동 판정 (이전: 자동으로 false였음)
- `loadConversation(conv.id, true)` — 명시 readOnly=true 유지 (공개 대화 클릭)
- `restore()` — 그대로 `loadConversation(convId)` 호출, 이제 자동 판정으로 안전

### 2.5 클라이언트: conversations 로드 race 처리

**문제**: 첫 mount 시 `useEffect` 두 개가 거의 동시에 실행됨:
1. [ChatPage.tsx:141-154](components/chat/ChatPage.tsx#L141-L154) — `fetch('/api/conversations')` → `setConversations(...)`
2. [ChatPage.tsx:157-166](components/chat/ChatPage.tsx#L157-L166) — `restore()` → `loadConversation(convId)`

`restore()`가 fetch 완료 전에 실행되면 `conversations`는 `[]` → `isOwn=false` → 내 대화도 readOnly로 잘못 진입.

**해결**: `convsLoaded` 플래그 도입.

```ts
const [convsLoaded, setConvsLoaded] = useState(false);

useEffect(() => {
  fetch('/api/conversations')
    .then(r => r.json())
    .then((rows: ...) => {
      if (Array.isArray(rows)) {
        setConversations(rows.map(...));
      }
      setConvsLoaded(true);
    })
    .catch(() => setConvsLoaded(true));
}, []);

// URL restore: conversations 로드 완료 후 발동
useEffect(() => {
  if (!convsLoaded) return;
  const restore = () => {
    const convId = new URLSearchParams(window.location.search).get('conv');
    if (convId) loadConversation(convId);
  };
  restore();
  window.addEventListener('popstate', restore);
  return () => window.removeEventListener('popstate', restore);
}, [convsLoaded]);
```

**Edge case**: 사용자가 막 새 대화 만든 직후 새로고침 — `routing` 이벤트에서 이미 [line 294-297](components/chat/ChatPage.tsx#L294-L297) `setConversations(prev => [{id, title, mode}, ...prev])` 로 prepend 됨. 새로고침 후 `/api/conversations` 다시 fetch하면 DB에 저장된 새 대화가 같이 옴 → 정상 동작.

### 2.6 클라이언트: 공개 대화 사이드바 30 프리뷰 + 모달

```ts
const CONV_PREVIEW = 12;       // 내 대화 (기존)
const PUBLIC_PREVIEW = 30;     // 공개 대화 (신규)

const [showMyConvsModal, setShowMyConvsModal] = useState(false);
const [showPublicConvsModal, setShowPublicConvsModal] = useState(false);
```

**사이드바 (공개 대화 섹션)**:
```tsx
{publicConvs.slice(0, PUBLIC_PREVIEW).map(conv => ...)}
{publicConvs.length > PUBLIC_PREVIEW && (
  <button onClick={() => setShowPublicConvsModal(true)}>
    전체 보기 ({publicConvs.length}개) ▼
  </button>
)}
```

**모달 사용**:
```tsx
{showMyConvsModal && (
  <ConversationsListModal
    title="내 대화 전체"
    conversations={conversations}
    currentConvId={currentConvId}
    isReadOnlyCurrent={!isReadOnly}
    onSelect={(id) => { loadConversation(id); setShowMyConvsModal(false); }}
    onDelete={deleteConversation}
    onClose={() => setShowMyConvsModal(false)}
    emptyText="아직 대화가 없습니다."
    variant="mine"
  />
)}

{showPublicConvsModal && (
  <ConversationsListModal
    title="모든 유저 질문 전체"
    conversations={publicConvs}
    currentConvId={currentConvId}
    isReadOnlyCurrent={isReadOnly}
    onSelect={(id) => { loadConversation(id, true); setShowPublicConvsModal(false); }}
    onClose={() => setShowPublicConvsModal(false)}  // onDelete 없음
    emptyText="아직 다른 유저의 대화가 없습니다."
    variant="public"
  />
)}
```

---

## 3. API Contract

### 3.1 `POST /api/chat`

| 변경 | 내용 |
|---|---|
| Request | 동일 (`message`, `conversationId?`, `mode`) |
| New responses | `404` (conv 없음), `403` (남의 conv) |
| 기존 200 SSE 응답 | 동일 |

### 3.2 `GET /api/conversations/public`

| 변경 | 내용 |
|---|---|
| New query params | `offset?: number (≥0, default 0)`, `limit?: number (1~300, default 300)` |
| 400 | 잘못된 파라미터 |
| 응답 형태 | 동일 (`{id, title, createdAt}[]`) |

---

## 4. Data Model

DB 변경 없음. Drizzle 스키마 그대로.

---

## 5. State Management

```
┌─────────────── ChatPage state ─────────────────┐
│  conversations: Conversation[]                  │ // 내 대화 (auth 사용자 기준)
│  publicConvs: { id, title, createdAt }[]        │ // 공개 대화
│  convsLoaded: boolean                            │ // 신규: race 가드
│  currentConvId: string | undefined               │
│  isReadOnly: boolean                             │ // 자동 결정 (대부분 케이스)
│  showMyConvsModal: boolean                       │
│  showPublicConvsModal: boolean                   │ // 신규
└─────────────────────────────────────────────────┘
```

기존 state 재활용 위주. `convsLoaded` 1개 추가, `showPublicConvsModal` 1개 추가.

---

## 6. Test Plan

### 6.1 수동 검증 시나리오

| ID | 시나리오 | 기대 |
|---|---|---|
| T1 | admin 계정에서 대화 생성 후 URL 복사. tier1 계정으로 URL 새로고침 | 입력창 hidden, "새 대화 시작" 버튼만 표시 |
| T2 | T1 상태에서 dev tools 콘솔에서 `fetch('/api/chat', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ message: 'test', conversationId: '<adminID>', mode: 'normal' }) })` | 403 응답 |
| T3 | 내 대화 클릭 → 정상 로드, 입력창 표시, 이어 대화 가능 | OK |
| T4 | 공개 대화 사이드바 — 30건 이하면 모두 표시, 초과면 "전체 보기 (N개)" 버튼 | OK |
| T5 | 공개 대화 "전체 보기" 클릭 → 모달 열림, 스크롤로 300건까지 탐색 | OK |
| T6 | URL `?conv=<내 ID>` 새로고침 (race 케이스) | 입력창 표시, readOnly 아님 |
| T7 | `/api/conversations/public?offset=100&limit=50` 직접 호출 | 100~149 인덱스 응답 |
| T8 | `/api/chat`에 `conversationId=<존재 안하는 ID>` | 404 |

### 6.2 자동 검증 (선택)

- Playwright spec 1개: T1, T2, T6 (race) 자동화 가능. 이번엔 수동 검증으로 충분.
- DB 무결성 쿼리 (SC1 검증): 각 conversation의 모든 messages가 동일 user인지 — feature 완료 후 실측.

---

## 7. Implementation Order

1. **신규 컴포넌트 추출**: `ConversationsListModal.tsx` 작성 + ChatPage 기존 `showMyConvsModal` 부분 교체 → 동작 확인 (기존 기능 보존 검증).
2. **서버 ownership 검증**: `chat/route.ts` if-block 추가 + 직접 fetch로 403/404 확인.
3. **서버 pagination**: `public/route.ts` limit 300 + offset 지원.
4. **클라 자동 readOnly**: `loadConversation` 시그니처 변경 + 호출처 확인.
5. **race 처리**: `convsLoaded` 플래그 + restore useEffect 의존성.
6. **공개 대화 모달 추가**: `showPublicConvsModal` state + 사이드바 30 프리뷰.
7. **수동 검증**: T1~T8.

각 단계마다 dev 서버에서 확인 후 다음 진행.

---

## 8. Risks & Mitigations

| 위험 | 완화 |
|---|---|
| `loadConversation(convId)` 자동 판정 — 기존 호출처가 의도와 다르게 readOnly 진입 | `restore()`는 자동 판정 의도 그대로. `loadConversation(id, true/false)` 명시 호출 그대로 우선. 미지정 호출은 [ChatPage.tsx:444](components/chat/ChatPage.tsx#L444), [782](components/chat/ChatPage.tsx#L782) 뿐 — 둘 다 "내 대화" 클릭 — 내 목록에 있으므로 자동 false |
| `conversations` race — convsLoaded=false 동안 restore 보류 → URL 새로고침 시 잠깐 빈 화면 | `convsLoaded` flag로 단순 처리. fetch 200~500ms 내 완료 — 사용자가 느끼지 못함 |
| 공개 대화 사이드바가 fetch 안 했는데 모달 열기 시도 (publicLoaded=false) | 이미 [line 478-487](components/chat/ChatPage.tsx#L478-L487)에서 펼치기 클릭 시 fetch 발동. 모달은 `showPublic` 펼쳐진 상태에서만 활성화되므로 항상 publicLoaded=true |
| 모달 추출로 인한 props 누락 / 시그니처 실수 | 컴포넌트 추출을 가장 먼저 (Step 1) 진행하여 기존 동작 보존 검증 후 다음 단계 진행 |
| 서버 ownership 검증이 새 대화 생성 흐름을 막음 | `if (conversationId)` 조건 — 신규 대화는 `conversationId` 없이 들어와서 영향 없음 |

---

## 9. Out of Scope (Plan에서 명시)

- 기존 DB에 잘못 섞여 들어간 메시지 분리 (별도 작업)
- conversation 읽기 권한 변경 (공개 뷰어 의도 유지)
- 공개 대화 모달의 "더 불러오기" UI — offset 파라미터는 지원하지만 1페이지만 노출
- 검색/필터, rate limiting

---

## 10. Dependencies

- 새 라이브러리: 없음 (Zod 이미 사용 중)
- DB migration: 없음
- 환경 변수: 없음

---

## 11. Implementation Guide

### 11.1 Module Map

| 모듈 | 파일 | 역할 |
|---|---|---|
| `module-modal` | `components/chat/ConversationsListModal.tsx` (신규) | 내/공개 대화 공용 리스트 모달 |
| `module-chat-api` | `app/api/chat/route.ts` | ownership 검증 (서버 floor) |
| `module-public-api` | `app/api/conversations/public/route.ts` | limit 300 + offset |
| `module-client-readonly` | `components/chat/ChatPage.tsx` (loadConversation 부분) | 자동 readOnly + race 처리 |
| `module-client-modal` | `components/chat/ChatPage.tsx` (모달/사이드바 부분) | 30 프리뷰 + showPublicConvsModal |

### 11.2 Recommended Session Plan

작은 변경(~140줄)이라 단일 세션으로 충분. 단계별 세션 분할 옵션:

| 세션 | 모듈 | 예상 시간 |
|---|---|---|
| 단일 | 모두 | ~1.5h |
| 분할 1 (서버 우선) | module-chat-api, module-public-api | ~30min |
| 분할 2 (UI) | module-modal, module-client-readonly, module-client-modal | ~1h |

### 11.3 Session Guide

**기본**: `/pdca do conversation-ownership` (전체 진행)

**서버만**: `/pdca do conversation-ownership --scope module-chat-api,module-public-api`

**UI만**: `/pdca do conversation-ownership --scope module-modal,module-client-readonly,module-client-modal`

각 세션 시작 시 Do phase에서 Decision Record Chain + Success Criteria 체크리스트 표시.
