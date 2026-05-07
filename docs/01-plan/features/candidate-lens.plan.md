# Plan: Candidate Lens Mode — 인물 시각 기반 분석 모드 (이석재 first)

> **Feature**: candidate-lens
> **Date**: 2026-05-07
> **Phase**: Plan

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | 의사결정자(총장 후보 등)의 시각으로 자료를 분석하고 싶지만, 그 사람의 stance를 일반 위키에 추가하면 모든 질문에 그의 관점이 묻어남. 동시에 stance·발언은 민감 자료라 admin만 봐야 함 |
| **Solution** | 인물 위키를 일반 라우팅 풀에서 분리하고, 사용자가 명시적으로 "후보 lens 모드"를 선택했을 때만 활성화. lens 모드에서는 (1) 인물 stance 데이터를 시각으로 로드, (2) 다른 위키에서 자료를 정상 라우팅, (3) "이 시각으로 자료를 해석하라"는 프롬프트로 LLM 호출 |
| **Function/UX** | 채팅창 좌측 `+` 버튼 → 모드 메뉴(질문 모드 / 후보 lens 모드). 클릭으로 전환. tier1/tier2는 클릭 차단. lens 모드 대화는 사이드바에서 색상 구분. 답변은 자연스럽게 작성하되 인라인 출처에 `[이석재]` 표기로 lens 출처 명확히 |
| **Effect** | 단순 자료 검색 → 특정 인물 시각 기반 분석으로 확장. 어드민이 "이 후보가 시흥캠퍼스에 대해 어떻게 판단할까?" 같은 질문에 자료 기반 추론을 빠르게 얻을 수 있음 |
| **Core Value** | "데이터 위에 시각(lens)을 얹는 RAG 패턴 정립". 첫 인물(이석재) 이후 다른 후보·총장·이사장도 동일 패턴으로 추가 가능한 framework 마련 |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | (1) stance 데이터를 가진 인물 위키가 일반 라우팅에 끼면 답변 품질 오염 (2) 민감 자료라 admin만 접근해야 함 (3) 명령어보다 UI 토글이 사용성·안전성 모두 우월 |
| **WHO** | admin 사용자(특히 의사결정·기획 역할). tier1/tier2에는 모드·위키·관련 UI 모두 비노출 |
| **RISK** | (R1) lens 프롬프트가 너무 강하면 LLM이 stance 자료에 없는 의견을 추측·생성 → P1 hallucination 위반. (R2) lens 모드 대화가 일반 대화와 섞여 사용자가 혼동. (R3) admin only 가드를 클라이언트만 적용하면 우회 가능 → 서버 가드 필수. (R4) 다인물 확장 시 모드 메뉴 무한 증식 |
| **SUCCESS** | (S1) admin이 lens 모드 활성화 후 "시흥캠퍼스 이슈 어떻게 보나?" 질문 → 이석재 stance 인용 + 타 위키 자료 인용한 답변 수신 (S2) tier1/tier2는 leesj 위키·lens 모드·관련 UI 어디에서도 노출되지 않음 (S3) lens 모드 대화는 사이드바에서 시각적으로 구분 (S4) lens 모드에서 stance 자료 부족 시 "이 주제에 대한 명시적 입장 자료 없음" 명시 |
| **SCOPE** | 신규: `data/leesj.json` 빌드, `data/agents.config.json` adminOnly 플래그, lens API 분기, ChatPage 모드 토글 UI, sidebar 색상 구분, DB messages.mode 컬럼. 변경: `lib/agents/router.ts`, `app/api/wiki/route.ts`, `app/api/wiki/[agentId]/route.ts`, `app/api/chat/route.ts`, `lib/llm/prompts.ts`, WikiNav |

---

## 1. Overview

### 1.1 Problem Statement

현재 시스템은 8개 위키를 키워드 매칭 + concept index 기반으로 라우팅한다. 여기에 "이석재" 같은 인물의 입장·발언 자료를 추가하려고 한다.

문제:
1. **라우팅 오염**: 일반 위키처럼 추가하면 "AI 정책 어때?" 같은 일반 질문에 이석재 의견이 끼어들어 답변이 편향됨
2. **권한 누수**: stance 자료는 후보자 발언·내부 발언·민감 정보 포함 → admin만 봐야 함
3. **명령어 UX 한계**: `/stance` 같은 텍스트 명령어는 사용자가 모르거나 오타 가능. 모드 전환 의도가 명확해야 함

### 1.2 Solution Approach

**A. 데이터 분리 — `adminOnly` 플래그**
이석재 위키를 정식 wiki로 추가하되, `agents.config.json`에 `adminOnly: true` 표시. 모든 wiki API와 라우터에서 admin이 아닐 때 완전히 제거.

**B. 모드 전환 — UI 토글**
채팅 입력창 좌측 `+` 버튼 → 팝오버 메뉴 (`질문 모드` / `후보 lens 모드`). 일반 LLM 챗봇의 모델/도구 선택 UX와 동일.

**C. 라우팅 분기 — lens 모드 시 별도 흐름**
- 일반 모드: 기존 `routeQuery()` 사용 (이석재 위키는 admin이라도 라우팅 풀에서 자동 제외)
- lens 모드: (1) 일반 라우팅으로 자료 위키들 가져오기 (2) 이석재 stance 데이터를 별도 lens context로 추가 (3) 시스템 프롬프트에 lens 지시문 삽입

**D. 출처 표기 — 자연스러운 답변 + 명확한 lens 출처**
답변 본문에 라벨 헤더 자동 삽입은 안 함. 대신 인라인 출처 `[이석재] 시흥캠퍼스-입장` 처럼 표기되어 어떤 부분이 lens 시각인지 자연스럽게 드러남.

**E. 대화 분류 — DB 메타데이터 + UI 색상**
`messages` 테이블에 `mode` 컬럼 추가 (`'normal'` | `'lens:leesj'`). 사이드바 대화 목록에서 lens 모드 대화는 배경색을 `bg-emerald-50` 으로 표시.

### 1.3 Why Now

- 8개 위키 통합(`multi-wiki-integration`) 완료 → 데이터 레이어 안정
- adaptive routing(`smart-routing`) 완료 → 라우팅에 분기 추가하기 좋은 타이밍
- 다음 단계로 "단순 검색 → 시각 기반 분석" 으로 확장하는 자연스러운 진화

---

## 2. Requirements

### 2.1 Functional Requirements

| ID | 요구사항 | 우선순위 |
|---|---|---|
| **FR-1** | 이석재 위키 데이터 빌드 (`data/leesj.json`): stance + source + topic + entity 모두 포함 | P0 |
| **FR-2** | `agents.config.json`에 `adminOnly: true` 플래그 도입, leesj agent에 적용 | P0 |
| **FR-3** | `/api/wiki` 와 `/api/wiki/[agentId]`에서 adminOnly 위키는 admin이 아니면 응답에서 제외 | P0 |
| **FR-4** | `routeQuery()` 에서 adminOnly 위키는 lens 모드가 아니면 항상 제외 (admin이라도) | P0 |
| **FR-5** | `/api/chat`에 `mode` 파라미터 도입 (`'normal'` 기본값, `'lens:{personaId}'`) | P0 |
| **FR-6** | lens 모드 시 시스템 프롬프트에 lens 지시문 삽입, stance 데이터를 별도 context로 결합 | P0 |
| **FR-7** | DB `messages` 테이블에 `mode` 컬럼 추가 (text, default `'normal'`) | P0 |
| **FR-8** | `/api/chat`은 admin이 아닐 때 mode가 `'normal'` 외 값이면 403 반환 | P0 |
| **FR-9** | ChatPage 입력창 좌측에 `+` 버튼 추가, 클릭 시 모드 메뉴 팝오버 표시 | P0 |
| **FR-10** | 모드 메뉴는 admin만 활성화. tier1/tier2는 disabled + "관리자 전용" 안내 | P0 |
| **FR-11** | lens 모드 활성화 시 입력창 위에 현재 모드 배지 표시 (예: `🎯 이석재 시각`) | P0 |
| **FR-12** | 사이드바 대화 목록에서 lens 모드 대화는 배경색 `bg-emerald-50` 적용 | P0 |
| **FR-13** | lens 모드에서 stance 자료 부족할 때 답변에 한계 명시 ("이 주제에 대한 명시적 입장 자료 없음") | P1 |
| **FR-14** | 새 대화 시작 시 마지막 사용 모드 기억 (sessionStorage) | P2 |

### 2.2 Non-Functional Requirements

| ID | 요구사항 | 기준 |
|---|---|---|
| **NFR-1** | 권한 우회 불가 — 클라이언트 가드만 통과해도 서버에서 차단 | API curl 테스트 통과 |
| **NFR-2** | lens 모드 토큰 증가 ≤ 일반 모드의 1.5배 | stance context 5KB 이내 |
| **NFR-3** | 모드 전환 UX 응답 ≤ 100ms | 클라이언트 state만 변경 |
| **NFR-4** | 다인물 확장 시 코드 수정 1곳 이내 | persona 레지스트리 패턴 |
| **NFR-5** | 기존 (일반 모드) 답변 회귀 없음 | 동일 쿼리 → 동일 위키 라우팅 |

---

## 3. Scope

### 3.1 In Scope

- 이석재 위키 데이터 1건 빌드 + admin only 제어
- 후보 lens 모드 1개 (이석재) 동작
- ChatPage 모드 전환 UI (+ 버튼 + 팝오버)
- lens 프롬프트 + 라우팅 분기
- DB messages.mode 컬럼 추가
- 사이드바 시각 구분
- 권한 가드 (클라/서버)

### 3.2 Out of Scope

- 다인물 lens 모드 (구조만 마련, 실제 추가는 별도 feature)
- lens 비교 모드 (인물 A vs B 동시 시각) — 별도 feature
- 사용자 정의 lens (admin이 직접 인물 추가) — 별도 feature
- lens 답변 품질 자동 평가 — 별도 feature
- 음성·이미지 lens — 범위 밖

---

## 4. Architecture

### 4.1 데이터 모델

**`data/agents.config.json` 신규 항목:**
```json
{
  "id": "leesj",
  "name": "이석재 후보",
  "type": "wiki",
  "dataFile": "leesj.json",
  "enabled": true,
  "adminOnly": true,
  "lensPersona": true,
  "personaId": "leesj",
  "displayName": "이석재 시각",
  "keywords": [...],
  "description": "이석재 후보 stance·발언 (admin 전용 lens)"
}
```

플래그 의미:
- `adminOnly: true` → admin 외에는 위키 자체를 못 봄 (API·WikiNav 양쪽 차단)
- `lensPersona: true` → 일반 라우팅 풀에서 자동 제외, lens 모드에서만 사용

**`AgentConfig` 타입 확장 (lib/agents/types.ts):**
```typescript
export interface AgentConfig {
  // 기존 필드들
  adminOnly?: boolean;
  lensPersona?: boolean;
  personaId?: string;
  displayName?: string;
}
```

### 4.2 권한 모델

| 리소스 | admin | tier1/tier2 |
|---|---|---|
| WikiNav에서 leesj 카드 | ✅ 표시 | ❌ 응답에서 제외 |
| /api/wiki/leesj | ✅ 200 | ❌ 404 (존재 부정) |
| 모드 메뉴 클릭 | ✅ 활성 | ❌ disabled + 안내 |
| /api/chat with mode='lens:leesj' | ✅ 200 | ❌ 403 |
| 일반 모드 채팅 라우팅 | leesj 제외 | leesj 제외 |

### 4.3 Lens Mode 흐름

```
[ChatPage]
  사용자가 + 클릭 → 모드 메뉴
  → "후보 lens 모드 (이석재)" 선택
  → mode state = 'lens:leesj'
  → 입력창 위 배지 표시

  사용자 질문 입력 → POST /api/chat { message, mode: 'lens:leesj', conversationId }

[/api/chat]
  1. session 검증 + admin 확인 (mode가 lens:* 면)
  2. mode 파싱 → personaId = 'leesj'
  3. routeQuery(message, role) → 일반 라우팅 (leesj 제외)
  4. loadPersonaContext('leesj', message) → 이석재 stance 자료 로드
  5. systemPrompt = buildLensSystemPrompt(contexts, persona, role)
  6. userMessage = buildLensUserMessage(query, contexts, persona)
  7. LLM 스트림 + DB 저장 (messages.mode = 'lens:leesj')
```

### 4.4 라우팅 분기

```typescript
// lib/agents/router.ts
export async function routeQuery(query, userRole, options?: { lensPersonaId?: string }) {
  const agents = registry.getAll().filter(a => {
    if (a.config.adminOnly && userRole !== 'admin') return false;
    if (a.config.lensPersona) return false;  // 항상 일반 라우팅에서 제외
    return true;
  });
  // ... 기존 로직
}

// lens 모드용 별도 함수
export async function loadPersonaContext(personaId, query, userRole) {
  // adminOnly + lensPersona 위키만 대상으로 stance 매칭
}
```

---

## 5. UI/UX Plan

### 5.1 모드 전환 버튼

**위치**: 채팅 입력창 좌측 (`textarea` 앞)
**아이콘**: `+` (24px)
**동작**: 클릭 시 위쪽 팝오버 메뉴 표시

**팝오버 메뉴 항목**:
```
┌─────────────────────────────┐
│ ✓ 질문 모드                  │
│   기본 자료 검색·답변          │
├─────────────────────────────┤
│ 🎯 후보 lens 모드 (이석재)    │
│   이석재 시각으로 자료 분석    │
│   [관리자 전용]                │
└─────────────────────────────┘
```

- 비admin: 두 번째 항목 회색 + 클릭 시 토스트 "관리자 전용 기능입니다"
- admin: 두 번째 항목 활성, 선택 시 체크마크 이동

### 5.2 모드 활성 상태 표시

lens 모드 활성 시 입력창 위에 작은 배지:
```
🎯 이석재 시각으로 분석 중  [✕ 해제]
```

`✕`를 누르면 일반 모드로 복귀.

### 5.3 사이드바 색상 구분

`messages.mode = 'lens:leesj'`인 첫 메시지를 가진 conversation은:
- 배경: `bg-emerald-50`
- 좌측 보더: `border-l-2 border-l-emerald-400`
- 작은 배지: `🎯 lens`

(현재 일반 대화는 흰색 배경. 색상 구분으로 한눈에 식별)

---

## 6. Backend Changes

### 6.1 lib/agents/types.ts

```typescript
export interface AgentConfig {
  id: string;
  name: string;
  type: string;
  dataFile: string;
  enabled: boolean;
  alwaysContext?: boolean;
  adminOnly?: boolean;          // 신규
  lensPersona?: boolean;         // 신규
  personaId?: string;            // 신규
  displayName?: string;          // 신규
  keywords: string[];
  sensitiveTopics: string[];
  description: string;
}
```

### 6.2 lib/agents/router.ts

- `routeQuery`에 admin 가드 + lensPersona 제외 로직
- `loadPersonaContext(personaId, query, role)` 함수 신규
- `getEnabledAgents(role)` 헬퍼로 권한 필터링 통합

### 6.3 app/api/wiki/route.ts & [agentId]/route.ts

- `agentsConfig.agents.filter(a => a.enabled && (!a.adminOnly || role === 'admin'))`
- adminOnly 위키에 비admin이 직접 GET 시도하면 404 (존재 부정)

### 6.4 app/api/chat/route.ts

```typescript
const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().optional(),
  mode: z.string().default('normal'),
});

// 권한 검증
if (mode.startsWith('lens:') && role !== 'admin') {
  return Response.json({ error: '관리자 전용 모드입니다.' }, { status: 403 });
}

// 분기
if (mode === 'normal') {
  routing = await routeQuery(message, role);
  systemPrompt = buildSystemPrompt(routing.contexts, role);
} else if (mode.startsWith('lens:')) {
  const personaId = mode.split(':')[1];
  routing = await routeQuery(message, role);
  const persona = await loadPersonaContext(personaId, message, role);
  systemPrompt = buildLensSystemPrompt(routing.contexts, persona, role);
  userMessage = buildLensUserMessage(message, routing.contexts, persona);
}

// DB 저장에 mode 포함
await db.insert(messages).values({ ..., mode });
```

### 6.5 lib/llm/prompts.ts

신규 함수:
```typescript
export function buildLensSystemPrompt(
  contexts: AgentContext[],
  persona: PersonaContext,
  userRole: Role
): string {
  return `당신은 ${persona.name}의 시각으로 서울대 거버넌스 자료를 분석하는 어시스턴트입니다.
  
## 인물 시각
${persona.stanceSummary}

## 자료
[기존 자료 contexts]

## 분석 원칙
1. ${persona.name}이 명시적으로 입장을 표명한 주제는 그 입장을 인용 (출처: [${persona.name}] {stanceId})
2. 명시적 입장이 없는 주제는 그의 가치 우선순위·관점에 비추어 추론하되, "추론" 임을 표시
3. 자료에 없는 내용은 절대 생성하지 말 것 (P1)
4. 일반 자료 인용은 [위키명] 문서ID 형식 그대로 유지
5. 자료 부족 시 "이 주제에 대한 ${persona.name}의 명시적 입장 자료가 없습니다" 명시
...`;
}
```

### 6.6 DB Migration

```sql
ALTER TABLE messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal';
CREATE INDEX idx_messages_mode ON messages(mode) WHERE mode != 'normal';
```

Drizzle schema:
```typescript
export const messages = pgTable('messages', {
  // 기존 필드
  mode: text('mode').notNull().default('normal'),
});
```

---

## 7. Frontend Changes

### 7.1 ChatPage.tsx

신규 state:
```typescript
const [chatMode, setChatMode] = useState<'normal' | `lens:${string}`>('normal');
const [modeMenuOpen, setModeMenuOpen] = useState(false);
```

신규 컴포넌트:
- `<ModeMenu />` — `+` 버튼 + 팝오버
- `<ModeBadge />` — 활성 모드 표시 + 해제 버튼

`sendMessage()`에 `mode` 추가:
```typescript
fetch('/api/chat', {
  body: JSON.stringify({ message, conversationId, mode: chatMode })
})
```

### 7.2 사이드바

`Conversation` 타입에 `mode?: string` 추가, 첫 메시지 mode 가져오는 API 확장.

```tsx
<button className={`...${conv.mode?.startsWith('lens:') ? 'bg-emerald-50 border-l-2 border-l-emerald-400' : ''}`}>
  {conv.mode?.startsWith('lens:') && <span>🎯</span>}
  {conv.title}
</button>
```

### 7.3 권한 가드 (클라)

```tsx
<button
  onClick={role === 'admin' ? selectLensMode : showPermissionToast}
  disabled={role !== 'admin'}
>
  후보 lens 모드 {role !== 'admin' && '(관리자 전용)'}
</button>
```

---

## 8. Database Schema Changes

| 테이블 | 컬럼 | 타입 | 기본값 | 비고 |
|---|---|---|---|---|
| messages | mode | TEXT NOT NULL | 'normal' | 'normal' \| 'lens:leesj' |

마이그레이션 파일: `drizzle/{timestamp}_add_messages_mode.sql`

API 응답에 mode 포함하도록 GET endpoints 확장:
- `/api/conversations` → 각 conv의 첫 메시지 mode 포함
- `/api/conversations/[id]` → messages 응답에 mode 포함

---

## 9. Security Considerations

| 위협 | 방어 |
|---|---|
| 비admin이 brute-force로 leesj 위키 접근 | 모든 wiki API 라우트에서 adminOnly 필터링 (404로 존재 부정) |
| 비admin이 mode='lens:leesj'로 chat API 호출 | `/api/chat`에서 role 검증 후 403 |
| admin 권한 탈취 후 lens 데이터 추출 | 로그 + 감사 (별도 feature) |
| sensitive stance가 일반 모드에 누설 | router에서 lensPersona 위키 항상 제외, prompt에 stance 자료 포함 안 됨 |
| 클라 가드만 우회 시도 | 서버 가드가 truth source. 클라는 UX용 |

---

## 10. Risks & Mitigation

| Risk | 가능성 | 영향 | 완화 |
|---|---|---|---|
| **R1**: lens 프롬프트가 너무 강해 LLM이 stance 없는 의견 생성 | 중 | 높음 | 프롬프트에 "명시적 입장 자료 없으면 명시" + "P1 hallucination 금지" 강조 |
| **R2**: lens 모드 대화가 일반과 섞여 사용자 혼동 | 중 | 중 | 사이드바 색상 + 입력창 배지 + DB mode 컬럼 |
| **R3**: admin 외 사용자가 우회로 접근 | 낮 | 매우 높음 | 서버 가드 다층 (API + router + chat) |
| **R4**: 다인물 확장 시 메뉴 무한 증식 | 낮 | 낮 | 향후 dropdown으로 변경 (현재는 1명) |
| **R5**: stance 자료 부족으로 답변이 일반 모드와 동일 | 중 | 낮 | FR-13 한계 명시 + 사용자 학습 |
| **R6**: DB 마이그레이션이 prod에서 실패 | 낮 | 높음 | default 'normal'로 backward compat 보장 |

---

## 11. Success Criteria

### S1. 기능 동작
- [ ] admin이 + 버튼 → "후보 lens 모드" 선택 → 배지 표시
- [ ] "시흥캠퍼스 어떻게 보나?" 질문 → 이석재 stance 인용 + 다른 위키 자료 인용한 답변
- [ ] 인라인 출처에 `[이석재] {stanceId}` 형식 정상 표기
- [ ] stance 자료 없는 주제 질문 시 "명시적 입장 자료 없음" 답변

### S2. 권한
- [ ] tier1/tier2가 + 버튼 클릭 → "후보 lens 모드" 회색 + 클릭 시 안내
- [ ] tier1/tier2가 직접 `/api/chat` mode='lens:leesj'로 호출 → 403
- [ ] tier1/tier2가 직접 `/api/wiki/leesj` GET → 404
- [ ] tier1/tier2 WikiNav 응답에 leesj 카드 미포함

### S3. 회귀 없음
- [ ] 일반 모드에서 admin이 질문해도 leesj 위키는 라우팅에 안 잡힘
- [ ] 기존 8개 위키 라우팅·답변 동일

### S4. UI
- [ ] lens 대화는 사이드바에서 emerald 배경
- [ ] 모드 배지 + 해제 버튼 동작
- [ ] 입력 시 + 버튼은 새 메시지 보낼 때마다 모드 유지

### S5. 확장성
- [ ] 새 인물(예: '권오현') 추가 시 `agents.config.json`에 항목 1개 + 데이터 파일 1개 만 추가하면 동작
- [ ] router·prompt·UI 코드 변경 없음

---

## 12. Implementation Phases

> Module 단위로 분리. 각 module은 독립 세션에서 구현 가능.

### Module 1 — Data + Admin Gate
**범위**: 데이터 ingest + 권한 가드 (라우팅 분기 없음)

- `lib/agents/types.ts`: AgentConfig 확장
- `data/agents.config.json`: leesj 항목 추가 (`adminOnly: true`, `lensPersona: true`)
- `data/leesj.json` 생성 (실제 자료는 별도)
- `app/api/wiki/route.ts`: adminOnly 필터링
- `app/api/wiki/[agentId]/route.ts`: adminOnly 필터링
- `lib/agents/router.ts`: lensPersona 항상 제외, adminOnly 비admin 제외

검증: admin은 WikiNav에서 leesj 보임 / 비admin은 안 보임 / 일반 채팅 라우팅에서 leesj 미포함

### Module 2 — Lens Backend
**범위**: lens 모드 API + 프롬프트

- `lib/agents/router.ts`: `loadPersonaContext()` 추가
- `lib/llm/prompts.ts`: `buildLensSystemPrompt()`, `buildLensUserMessage()`
- `app/api/chat/route.ts`: mode 파싱 + 분기 + 권한 검증
- `lib/db/schema.ts`: messages.mode 컬럼
- Drizzle 마이그레이션 생성·적용

검증: curl로 admin 토큰 + mode='lens:leesj' POST → 정상 / tier2 토큰 + 동일 → 403

### Module 3 — Lens Frontend
**범위**: 모드 전환 UI + 사이드바 표시

- `ChatPage.tsx`: chatMode state, ModeMenu 컴포넌트, ModeBadge
- `+ 버튼` UI 추가
- `sendMessage()`에 mode 포함
- `/api/conversations` 응답에 mode 추가
- 사이드바 conversation 카드 색상 분기

검증: admin 로그인 → + 버튼 → 모드 선택 → 배지 → 답변 / tier1 로그인 → + 버튼 → 비활성 / lens 대화 사이드바 색상 확인

### Module 4 (Optional) — UX Polish
- sessionStorage로 마지막 mode 기억
- lens 모드에서 추천 질문 변경
- lens 답변 메시지 버블에 작은 마커

---

## 13. Future Extension

| 확장 | 방법 |
|---|---|
| 다인물 lens (총장, 이사장) | `agents.config.json`에 `lensPersona: true` 항목 추가, 모드 메뉴 자동 확장 |
| Lens 비교 모드 (A vs B) | mode = `'lens-compare:A,B'` 패턴, 프롬프트에 양쪽 stance 병렬 제공 |
| 사용자 정의 lens | admin UI에서 인물·키워드 입력 → 자동 stance 페이지 생성 |
| Lens quality score | 답변에 "stance 인용 비율 / 자료 인용 비율" 표시 |

---

## 14. Open Questions

(Plan 단계에서 미결, Design 단계에서 결정)

- [ ] persona display name을 한글 vs 영문? → "이석재" 그대로 vs "Lee Seokjae"
- [ ] lens 모드에서 동일 conversation 안에서 일반 모드로 전환 가능? → MVP에선 conversation 단위 잠금?
- [ ] stance 부족 경고 문구를 답변 시작 vs 끝에 둘지?
- [ ] 모드 전환 단축키 (Cmd+K 등) 필요?
