# Plan: Conversation Ownership — 남의 대화에 쓰기 차단 + 공개 대화 사이드바 UX 개선

> **Feature**: conversation-ownership
> **Date**: 2026-05-26
> **Phase**: Plan

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | 채팅 API가 클라이언트가 보낸 `conversationId`를 검증하지 않아 다른 사용자의 대화에 메시지가 섞여 저장됨 (실측: 동일 conv ID에 admin lens 대화와 tier1 normal 질문 혼재). 동시에 "모든 유저 질문" 사이드바는 100건 cap에 페이지네이션 없이 통째로 dump |
| **Solution** | 서버에 conversationId 소유권 검증 (남의 ID → 403, 보안 floor). 클라이언트는 내 대화 목록과 대조하여 남의 대화 진입 시 자동 readOnly로 전환 (정상 UX에선 403이 트리거되지 않음). 공개 대화 사이드바는 내 대화 모달과 동일 패턴(30 프리뷰 + 전체보기 모달), 서버 limit 300 + offset |
| **UX Effect** | 사용자가 의도치 않게 남의 대화에 메시지 쓰는 일 차단 (자동 readOnly로 입력창이 안 보임). 공개 대화 사이드바가 깔끔해지고 300건까지 탐색 가능 |
| **Core Value** | 대화 소유권 보장 — 데이터 무결성과 책임 추적성 확보. 거버넌스 도구로서 발언 귀속이 어긋나지 않음 |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 2026-05-26 실측, 동일 conversationId(`79b01402-3179-4ebc-8f65-e54fb4a018f4`)에 admin의 `lens:leesj` 질문 2건과 tier1 추호정의 `normal` 질문 4건이 섞여 저장됨. UI 가드(`isReadOnly`)는 클라이언트 state라 URL `?conv=` 새로고침 / dev tools / 직접 fetch로 우회됨 |
| **WHO** | 모든 인증 사용자 (admin / tier1 / tier2). 일반 사용 흐름에서 사고로 발생하는 케이스가 다수, 의도적 우회는 부차적 |
| **RISK** | 서버 403을 사용자가 직접 보면 UX 나쁨 → 정상 흐름에서는 클라이언트가 미리 차단해야 함. 클라이언트 가드만 두면 보안 floor가 빠짐 → 양쪽 다 필요 |
| **SUCCESS** | (1) 정상 흐름에서 남의 대화에 메시지 쓰기 0건, (2) 서버 403은 dev tools 우회 시에만 발동, (3) 공개 대화 300건까지 모달에서 탐색 가능 |
| **SCOPE** | `app/api/chat/route.ts` ownership 검증 / `app/api/conversations/public/route.ts` limit·offset / `components/chat/ChatPage.tsx` 자동 readOnly + 공개 대화 모달. DB 스키마·라우팅·LLM 무수정 |

---

## 1. 현재 문제

### 1.1 서버 ownership 미검증 (보안 floor 부재)

**[app/api/chat/route.ts:52](app/api/chat/route.ts#L52)** — 클라이언트가 보낸 `conversationId`를 그대로 INSERT에 사용:

```ts
const { message, conversationId, mode } = parsed.data;
const userId = session.user.id;
// ... conversationId 소유자 검증 없음
await db.insert(messages).values({
  conversationId: convId,   // 남의 ID여도 통과
  ...
});
```

**실측 증거**: DB·Google Sheets 로그에 동일 `conversationId`가 admin/tier1 사용자에게 동시 출현. lens 모드 빈틈이 아니라 chat API 자체의 검증 부재가 원인.

### 1.2 클라이언트 UI 가드의 우회 경로

**[ChatPage.tsx:157-164](components/chat/ChatPage.tsx#L157-L164)** — URL restore:

```ts
const restore = () => {
  const convId = new URLSearchParams(window.location.search).get('conv');
  if (convId) loadConversation(convId);   // ← 2번째 인자 안 넘김 → readOnly 디폴트 false
};
```

**[ChatPage.tsx:187](components/chat/ChatPage.tsx#L187)** — `loadConversation(convId, readOnly = false)` 디폴트 false.

사고 시나리오:
1. 사용자가 "모든 유저 질문"에서 남의 대화 클릭 → `loadConversation(id, true)` → 정상 readOnly.
2. URL이 `?conv=<남의ID>`로 바뀜 ([line 169-173](components/chat/ChatPage.tsx#L169-L173)).
3. 새로고침 / 뒤로가기 / URL 공유 → restore 발동 → `readOnly` 인자 없이 호출 → `false` → 입력창 열림.
4. 입력 → API → 남의 대화에 INSERT.

추가 우회: dev tools `setIsReadOnly(false)`, 또는 `fetch('/api/chat', { body: { conversationId: '<남의ID>' } })` 직접 호출.

### 1.3 공개 대화 사이드바 — 통째로 dump

**[ChatPage.tsx:494-521](components/chat/ChatPage.tsx#L494-L521)** — `publicConvs` 100건을 페이지네이션 없이 모두 렌더링. 좁은 사이드바에 100줄 스크롤.

**[app/api/conversations/public/route.ts:24](app/api/conversations/public/route.ts#L24)** — `.limit(100)` 하드코딩. 100건 초과는 아예 접근 불가.

내 대화 사이드바는 [line 463-470](components/chat/ChatPage.tsx#L463-L470)의 `CONV_PREVIEW=12` + [line 748-803](components/chat/ChatPage.tsx#L748-L803)의 전체보기 모달이 있지만, 공개 대화는 같은 패턴 없음.

---

## 2. 해결

### 2.1 보안 floor — 서버 ownership 검증 (hard 403)

`POST /api/chat`에서 `conversationId`가 주어진 경우 DB에서 owner 조회 후 본인이 아니면 403:

```ts
if (conversationId) {
  const [conv] = await db.select({ userId: conversations.userId })
    .from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!conv) {
    return Response.json({ error: '대화를 찾을 수 없습니다.' }, { status: 404 });
  }
  if (conv.userId !== userId) {
    return Response.json({ error: '본인 대화에만 메시지를 보낼 수 있습니다.' }, { status: 403 });
  }
}
```

정상 흐름에선 클라이언트 가드가 먼저 막아주므로 이 403은 dev tools 우회 시에만 발동 (관찰 가능한 UX 영향 없음).

### 2.2 클라이언트 자동 readOnly — 의도치 않은 우회 차단

`loadConversation`이 진입 시 **내 대화 목록(`conversations` state)에 conv가 있는지 확인** → 없으면 자동 readOnly:

```ts
async function loadConversation(convId: string, readOnly?: boolean) {
  // readOnly 명시되지 않으면 ownership으로 자동 결정
  const isOwn = conversations.some(c => c.id === convId);
  const effectiveReadOnly = readOnly ?? !isOwn;
  ...
}
```

기존 호출부 변경:
- `loadConversation(conv.id)` (내 대화 클릭) → readOnly 자동 false (목록에 있음)
- `loadConversation(conv.id, true)` (공개 대화 클릭) → 명시적 readOnly 유지
- `restore()` 경로 → readOnly 자동 결정 → 남의 대화면 자동 readOnly

**Edge case**: `conversations` state가 아직 로드 안 됐을 때(`useEffect`로 fetch 중) restore가 먼저 발동하면 `isOwn`이 false로 잘못 판정될 수 있음. 처리:
- 첫 mount 시 conversations fetch가 완료될 때까지 restore 보류
- 또는 conversations 로드 완료 후 `effectiveReadOnly` 재평가

### 2.3 공개 대화 사이드바 — 30 프리뷰 + 전체보기 모달

내 대화 모달 패턴 그대로 복제 ([ChatPage.tsx:748-803](components/chat/ChatPage.tsx#L748-L803)):

```tsx
const PUBLIC_PREVIEW = 30;
const [showPublicConvsModal, setShowPublicConvsModal] = useState(false);

// 사이드바
{publicConvs.slice(0, PUBLIC_PREVIEW).map(...)}
{publicConvs.length > PUBLIC_PREVIEW && (
  <button onClick={() => setShowPublicConvsModal(true)}>
    전체 보기 ({publicConvs.length}개) ▼
  </button>
)}

// 모달 — 내 대화 모달과 동일 구조, 데이터만 publicConvs
```

### 2.4 서버 limit 상향 + offset 페이지네이션

`/api/conversations/public`:
- `.limit(300)` (100 → 300)
- `?offset=N` 쿼리 파라미터 지원 (기본 0)
- 모달에서 300건 초과 시 "더 불러오기" 버튼으로 다음 페이지 로드 (필요해질 때 추가)

---

## 3. 구현 범위

| 파일 | 변경 | 라인 |
|---|---|---|
| `app/api/chat/route.ts` | conversationId ownership 검증 추가 (404/403) | ~10 |
| `app/api/conversations/public/route.ts` | limit 100→300, offset 파라미터 지원 | ~10 |
| `components/chat/ChatPage.tsx` | `loadConversation` ownership 자동 판정, `PUBLIC_PREVIEW=30`, 공개 대화 모달 (내 대화 모달 복제), conversations 로드 race 처리 | ~80 |

### 무수정
- DB 스키마
- `lib/agents/*`, `lib/llm/*`, `lib/embed/*`
- 다른 API 라우트 (`/api/conversations/[id]` 등 — 읽기는 의도적으로 열림 유지)

---

## 4. Success Criteria

| ID | 기준 | 측정 |
|---|---|---|
| **SC1** | 정상 흐름에서 남의 대화에 메시지 쓰기 발생 0건 | DB의 `messages` 조인 — 각 conversation의 모든 messages가 동일 user 소유인지 검증 쿼리 |
| **SC2** | URL `?conv=<남의ID>` 새로고침 시 입력창 자동 숨김 + "새 대화 시작" 버튼만 노출 | 수동 검증 (admin 계정으로 conv URL 만들고 tier1 계정으로 새로고침) |
| **SC3** | `POST /api/chat`에 남의 `conversationId` 직접 fetch → 403 응답 | curl 또는 브라우저 콘솔에서 fetch 호출 후 응답 코드 확인 |
| **SC4** | "모든 유저 질문" 사이드바가 30건 + 전체보기 버튼 표시 | UI 수동 확인 |
| **SC5** | 공개 대화 모달에서 300건까지 스크롤 가능, 31번째 이후 보임 | UI 수동 확인 (DB에 300건 이상 있을 때) |
| **SC6** | conversations 로드 race 케이스 — `?conv=<내것>` 첫 mount 새로고침 시 readOnly로 잘못 진입하지 않음 | 수동 검증 |

---

## 5. Risks

| 위험 | 완화 |
|---|---|
| `conversations` state가 비어있을 때 restore 발동 → 내 대화가 readOnly로 잘못 판정 | conversations fetch 완료 플래그(`convsLoaded`) 도입. restore는 fetch 완료 후 발동하거나, 로드 후 자동 재평가 |
| 새 대화 생성 직후 URL 동기화 — 막 만든 내 대화가 conversations state에 반영되기 전 새로고침 | `sendMessage` 안에서 `routing` 이벤트의 `conversationId` 받자마자 `setConversations`에 prepend ([ChatPage.tsx:294-297](components/chat/ChatPage.tsx#L294-L297)) 이미 구현됨. 추가 처리 불필요 |
| 서버 403이 정상 흐름에서 발동 — 사용자가 에러 화면 봄 | 클라이언트 가드가 먼저 차단하므로 정상 흐름에서 발생 불가. 발동 시엔 dev tools 우회 의도이므로 에러 메시지 표시가 적절 |
| 공개 대화 모달 limit 300도 부족해질 수 있음 | offset 파라미터로 향후 "더 불러오기" 추가 가능 (이번 PR은 1페이지만) |
| 기존 잘못 섞인 메시지는 그대로 남음 | Out of Scope. 별도 정리 작업으로 분리 (routedAgents·mode·userId 조인으로 식별 후 어떻게 처리할지 별도 결정) |

---

## 6. Out of Scope

- 기존 DB에 잘못 섞여 들어간 메시지 분리/정리 (별도 데이터 정리 작업)
- conversation 읽기 권한 변경 — 현재 "공개 대화 뷰어" 의도는 유지 ([conversations/[id]/route.ts:19](app/api/conversations/[id]/route.ts#L19) 주석 그대로)
- conversation 삭제·이름변경·복제 등 다른 작업
- 공개 대화 모달에 검색·필터 기능 (필요해지면 별도)
- "더 불러오기" UI 구현 — offset 파라미터는 지원하지만 이번엔 1페이지(300건)까지만 노출
- Rate limiting — 별도 feature

---

## 7. Dependencies

- 외부 라이브러리 없음
- 환경 변수 없음
- DB 마이그레이션 없음
- Drizzle 쿼리만 추가
- 기존 `auth()` / `conversations` 테이블 재사용
