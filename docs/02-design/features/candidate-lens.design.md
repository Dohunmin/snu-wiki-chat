# Design: Candidate Lens Mode — Pragmatic Balance Architecture

> **Feature**: candidate-lens
> **Date**: 2026-05-07
> **Phase**: Design
> **Selected Architecture**: Option C (Pragmatic Balance)

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | (1) stance 데이터를 가진 인물 위키가 일반 라우팅에 끼면 답변 품질 오염 (2) 민감 자료라 admin만 접근해야 함 (3) 명령어보다 UI 토글이 사용성·안전성 모두 우월 |
| **WHO** | admin 사용자(특히 의사결정·기획 역할). tier1/tier2에는 모드·위키·관련 UI 모두 비노출 |
| **RISK** | (R1) lens 프롬프트가 너무 강하면 LLM이 stance 자료에 없는 의견 추측 → P1 hallucination 위반. (R2) lens 모드 대화가 일반과 섞여 사용자 혼동. (R3) admin only 가드를 클라이언트만 적용하면 우회 가능 → 서버 가드 필수. (R4) 다인물 확장 시 모드 메뉴 무한 증식 |
| **SUCCESS** | (S1) admin이 lens 활성화 후 "시흥캠퍼스 어떻게 보나?" → 이석재 stance + 타 위키 자료 인용한 답변 (S2) tier1/tier2는 어디에도 leesj 노출 안 됨 (S3) lens 대화는 사이드바에서 시각 구분 (S4) stance 부족 시 명시 |
| **SCOPE** | 신규: `data/leesj.json`, `data/agents.config.json` 4필드, `lib/agents/lens.ts` (신규 100줄), DB messages.mode 컬럼, ChatPage 모드 토글 UI. 변경: `router.ts`, `wiki API`, `chat API`, `prompts.ts`, WikiNav |

---

## 1. Overview

### 1.1 Selected Architecture: C (Pragmatic Balance)

**핵심 결정**:
- `AgentConfig`에 4개 플래그 추가 (`adminOnly`, `lensPersona`, `personaId`, `displayName`)
- 신규 파일은 `lib/agents/lens.ts` 1개만 (100줄 미만)
- 기존 `routeQuery()`에는 가드 한 줄씩 추가
- chat route에 mode 분기 ~10줄 추가
- 인물 추가 = `agents.config.json` 항목 + `data/{id}.json` 파일만

**Why**: 다인물 확장 가능하면서도 추상화 비용은 최소. 기존 multi-wiki-integration의 config-flag 패턴과 일관성.

### 1.2 핵심 데이터 흐름

```
[일반 모드]
사용자 질문
  → /api/chat { mode: 'normal' }
  → routeQuery(query, role)
       └─ adminOnly·lensPersona 위키 자동 제외
  → buildSystemPrompt(contexts, role)
  → LLM 스트림
  → 저장 (messages.mode = 'normal')

[Lens 모드]
사용자 질문 + 모드 토글 ON
  → /api/chat { mode: 'lens:leesj' }
  → admin 권한 검증 (403 if not admin)
  → routeQuery(query, role) [일반 자료]
  → loadPersonaContext('leesj', query, role) [이석재 stance]
  → buildLensSystemPrompt(contexts, persona, role)
  → buildLensUserMessage(query, contexts, persona)
  → LLM 스트림
  → 저장 (messages.mode = 'lens:leesj')
```

### 1.3 Open Questions 해결

Plan §14의 미결 질문 처리:

| Q | 결정 |
|---|---|
| persona display name 한글 vs 영문 | **한글** — `displayName: "이석재"` 그대로 |
| 같은 conversation에서 모드 전환 가능? | **메시지 단위 허용** — `messages.mode`로 추적, conversation은 첫 메시지의 mode로 사이드바 색상 결정 |
| stance 부족 경고 위치 | **답변 시작 부분** — "이 주제에 대한 ${name}의 명시적 입장 자료가 없습니다. 일반 자료 기반으로 답변합니다." |
| 모드 전환 단축키 | **미적용 (MVP)** — `+` 버튼 클릭만 |

---

## 2. Architecture Detail

### 2.1 모듈 구조

```
lib/agents/
├── types.ts                    [수정] AgentConfig 4필드 추가
├── router.ts                   [수정] 권한·lens 가드 추가
├── lens.ts                     [신규] loadPersonaContext, lens 헬퍼
└── wiki-agent.ts              [무변경]

lib/llm/
└── prompts.ts                  [수정] buildLensSystemPrompt, buildLensUserMessage

app/api/
├── chat/route.ts              [수정] mode 파라미터 + 분기
├── wiki/route.ts              [수정] adminOnly 필터링
├── wiki/[agentId]/route.ts    [수정] adminOnly 필터링
└── conversations/route.ts     [수정] 응답에 mode 포함

components/chat/
└── ChatPage.tsx               [수정] ModeMenu, ModeBadge, sidebar 색상

lib/db/
└── schema.ts                  [수정] messages.mode 컬럼

data/
├── agents.config.json         [수정] leesj 항목 추가
└── leesj.json                 [신규] 데이터
```

### 2.2 의존성 그래프

```
ChatPage
  └─ /api/chat/route.ts
        ├─ /lib/agents/router.ts (routeQuery)
        │     └─ adminOnly·lensPersona 필터
        ├─ /lib/agents/lens.ts (loadPersonaContext) [신규]
        │     └─ data/leesj.json
        └─ /lib/llm/prompts.ts (buildLensSystemPrompt) [수정]

WikiNav
  └─ /api/wiki/route.ts
        └─ adminOnly 필터

WikiViewer
  └─ /api/wiki/[agentId]/route.ts
        └─ adminOnly 가드 (404)
```

---

## 3. Data Models

### 3.1 AgentConfig 확장 (lib/agents/types.ts)

```typescript
export interface AgentConfig {
  id: string;
  name: string;
  type: string;
  dataFile: string;
  enabled: boolean;
  alwaysContext?: boolean;
  
  // ─── 신규 ─────────────────────────────────
  /** admin만 접근 가능 (모든 wiki API와 라우팅에서 비admin은 제외) */
  adminOnly?: boolean;
  
  /** lens 페르소나 위키 — 일반 라우팅에서 항상 제외, lens 모드 전용 */
  lensPersona?: boolean;
  
  /** lens persona 식별자 (mode='lens:{personaId}'에 사용) */
  personaId?: string;
  
  /** UI 표시명 (모드 메뉴·배지에 표시) */
  displayName?: string;
  // ─────────────────────────────────────────
  
  keywords: string[];
  sensitiveTopics: string[];
  description: string;
}
```

### 3.2 PersonaContext 인터페이스 (lib/agents/lens.ts 신규)

```typescript
export interface PersonaContext {
  id: string;                    // 'leesj'
  name: string;                  // '이석재'
  displayName: string;           // '이석재' (UI용)
  
  /** stance 자료가 매칭된 항목들 */
  stances: Array<{
    id: string;
    title: string;
    holder: string;
    topic: string;
    content: string;
    score: number;
  }>;
  
  /** 매칭된 stance 자료 텍스트 블록 (LLM 프롬프트에 삽입할 형태) */
  stanceBlock: string;
  
  /** stance 자료 부족 여부 (true → 답변에 한계 명시) */
  insufficient: boolean;
}
```

### 3.3 messages 테이블 확장 (lib/db/schema.ts)

```typescript
export const messages = pgTable('messages', {
  id:             text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role:           text('role').notNull(),
  content:        text('content').notNull(),
  routedAgents:   text('routed_agents').array(),
  sources:        jsonb('sources'),
  mode:           text('mode').notNull().default('normal'),  // 'normal' | 'lens:{personaId}'
  createdAt:      timestamp('created_at').defaultNow().notNull(),
});
```

### 3.4 conversations 응답 확장

`/api/conversations` GET 응답:
```typescript
{
  id: string;
  title: string | null;
  mode?: string;        // 첫 메시지의 mode (사이드바 색상용)
}[]
```

쿼리: 각 conversation의 가장 오래된 메시지의 mode를 LEFT JOIN으로 가져옴.

```sql
SELECT c.id, c.title, m.mode
FROM conversations c
LEFT JOIN LATERAL (
  SELECT mode FROM messages
  WHERE conversation_id = c.id
  ORDER BY created_at ASC
  LIMIT 1
) m ON true
WHERE c.user_id = $1
ORDER BY c.updated_at DESC
```

---

## 4. API Specifications

### 4.1 POST /api/chat

**Request**:
```typescript
{
  message: string;
  conversationId?: string;
  mode?: 'normal' | `lens:${string}`;  // 기본 'normal'
}
```

**Validation (Zod)**:
```typescript
const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().optional(),
  mode: z.string().regex(/^(normal|lens:[a-z0-9-]+)$/).default('normal'),
});
```

**권한 검증**:
- `mode.startsWith('lens:')` && `role !== 'admin'` → **403** `{ error: '관리자 전용 모드입니다.' }`
- `mode.startsWith('lens:')` && persona 존재 안 함 → **400** `{ error: '존재하지 않는 페르소나입니다.' }`

**Response (SSE 스트림)**:
- 기존과 동일 (`type: 'routing' | 'chunk' | 'sources' | 'done' | 'error'`)
- 추가: `routing` 이벤트에 `lensPersona?: { id, displayName, insufficient }` 포함 → 클라이언트가 stance 부족 알림 표시

### 4.2 GET /api/wiki

**변경**:
- `agents.filter(a => a.enabled && (!a.adminOnly || role === 'admin'))`
- 비admin 응답에는 leesj 위키 항목 자체가 없음

### 4.3 GET /api/wiki/[agentId]

**변경**:
- agent.adminOnly && role !== 'admin' → **404** `{ error: 'Not found' }` (존재 부정)

### 4.4 GET /api/conversations

**변경**: 응답에 `mode` 필드 추가 (각 conv의 첫 메시지 mode)

---

## 5. Component Design

### 5.1 ChatPage.tsx 신규 state

```typescript
const [chatMode, setChatMode] = useState<'normal' | `lens:${string}`>('normal');
const [modeMenuOpen, setModeMenuOpen] = useState(false);
const [lensInsufficientNotice, setLensInsufficientNotice] = useState<string | null>(null);
```

### 5.2 ModeMenu 컴포넌트 (인라인 또는 별도 파일)

**구조**:
```tsx
<div className="relative">
  <button
    onClick={() => setModeMenuOpen(!modeMenuOpen)}
    className="rounded-full p-2 hover:bg-gray-100"
  >
    <PlusIcon className="h-5 w-5" />
  </button>
  
  {modeMenuOpen && (
    <div className="absolute bottom-full left-0 mb-2 w-72 rounded-xl bg-white shadow-lg border border-gray-200 py-1.5">
      <ModeMenuItem
        active={chatMode === 'normal'}
        onClick={() => { setChatMode('normal'); setModeMenuOpen(false); }}
        icon="💬"
        label="질문 모드"
        description="기본 자료 검색·답변"
      />
      <div className="my-1 h-px bg-gray-100" />
      <ModeMenuItem
        active={chatMode.startsWith('lens:')}
        disabled={user.role !== 'admin'}
        onClick={() => {
          if (user.role !== 'admin') {
            toast('관리자 전용 기능입니다');
            return;
          }
          setChatMode('lens:leesj');
          setModeMenuOpen(false);
        }}
        icon="🎯"
        label="후보 lens 모드 (이석재 후보)"
        description="이석재 시각으로 자료 분석"
        adminOnly
      />
    </div>
  )}
</div>
```

**`ModeMenuItem`**:
```tsx
function ModeMenuItem({ active, disabled, onClick, icon, label, description, adminOnly }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 flex items-start gap-2.5 ${
        disabled ? 'opacity-40 cursor-not-allowed' : ''
      }`}
    >
      <span className="text-lg">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
          {active && <CheckIcon className="h-3.5 w-3.5 text-emerald-600" />}
          {label}
          {adminOnly && (
            <span className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded">관리자 전용</span>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-0.5">{description}</p>
      </div>
    </button>
  );
}
```

### 5.3 ModeBadge (입력창 위에 활성 모드 표시)

```tsx
{chatMode.startsWith('lens:') && (
  <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200 px-3 py-1 text-xs">
    <span>🎯</span>
    <span className="text-emerald-700 font-medium">{getPersonaDisplayName(chatMode)} 시각으로 분석</span>
    <button onClick={() => setChatMode('normal')} className="text-emerald-600 hover:text-emerald-900 ml-1">
      ✕
    </button>
  </div>
)}
```

### 5.4 사이드바 conversation 카드 — lens 색상

```tsx
<button
  className={`w-full text-left rounded-lg px-3 py-2.5 transition-colors group flex items-start gap-2 ${
    isActive
      ? 'bg-blue-50 text-blue-700'
      : conv.mode?.startsWith('lens:')
      ? 'bg-emerald-50 hover:bg-emerald-100 border-l-2 border-l-emerald-400'
      : 'hover:bg-gray-50'
  }`}
>
  {conv.mode?.startsWith('lens:') && <span className="text-xs mt-0.5">🎯</span>}
  <span className="flex-1 truncate">{conv.title}</span>
</button>
```

---

## 6. State Management

### 6.1 ChatPage state 변화

| 사용자 행동 | state 변화 |
|---|---|
| `+` 버튼 클릭 | `modeMenuOpen = true` |
| 메뉴 외부 클릭 | `modeMenuOpen = false` |
| "후보 lens 모드" 클릭 (admin) | `chatMode = 'lens:leesj'`, `modeMenuOpen = false` |
| "후보 lens 모드" 클릭 (비admin) | toast 표시, state 변화 없음 |
| 배지 ✕ 클릭 | `chatMode = 'normal'` |
| 메시지 전송 | API 호출에 `mode = chatMode` 포함, `chatMode` 유지 |
| 새 conversation 시작 | `chatMode` 유지 (sessionStorage 미적용 — MVP) |
| 사이드바에서 lens 대화 클릭 | `chatMode` 변화 없음 (대화 내용은 mode 유지하지만 state는 별개) |

### 6.2 lens insufficient 알림

서버에서 `routing` 이벤트에 `lensPersona.insufficient: true`가 오면:
- 답변 시작 전에 회색 알림 박스 표시: "이 주제에 대한 이석재의 명시적 입장 자료가 없습니다. 일반 자료 기반으로 답변합니다."
- 새 메시지 전송 시 초기화

### 6.3 mode persistence

- 같은 conversation 안에서 mode를 바꾸면 다음 메시지부터 새 mode 적용
- 사이드바 색상은 첫 메시지 기준 (변하지 않음)
- 새 conversation 시작 시 `chatMode = 'normal'` 리셋 (이전 모드 기억 안 함, MVP)

---

## 7. Error Handling

| 시나리오 | 처리 |
|---|---|
| tier2가 lens 모드 직접 호출 (curl) | 403 + `error: '관리자 전용 모드입니다.'` |
| 존재하지 않는 personaId (`lens:foo`) | 400 + `error: '존재하지 않는 페르소나입니다.'` |
| `data/leesj.json` 파일 없음 | 500 + 로그 + `error: 'persona 자료를 불러올 수 없습니다.'` |
| stance 자료 0개 매칭 | 정상 200 + `lensPersona.insufficient: true` |
| 클라가 부적합 mode 문자열 ("lens:") | Zod regex 실패 → 400 |
| 모드 메뉴 렌더링 중 user.role 변경 | useEffect로 chatMode 강제 'normal' 리셋 |

---

## 8. Test Plan

### 8.1 Unit / API 레벨

| Test | Method | Expected |
|---|---|---|
| T1. 비admin GET /api/wiki | tier2 토큰 | 응답에 leesj 없음 |
| T2. 비admin GET /api/wiki/leesj | tier2 토큰 | 404 |
| T3. admin GET /api/wiki/leesj | admin 토큰 | 200 + 데이터 |
| T4. 비admin POST /api/chat mode='lens:leesj' | tier2 토큰 | 403 |
| T5. admin POST /api/chat mode='lens:leesj' | admin 토큰 | 200 SSE 스트림 |
| T6. admin POST 일반 모드 | admin 토큰 | leesj가 라우팅에 안 잡힘 |
| T7. mode='lens:foo' (없는 persona) | admin 토큰 | 400 |
| T8. mode='lens:' 이상한 형식 | admin 토큰 | 400 (Zod) |

### 8.2 UI / E2E 레벨

| Scenario | Steps | Expected |
|---|---|---|
| E1. tier2 로그인 → + 클릭 | 메뉴 열림 | "후보 lens 모드" 회색 + "관리자 전용" 배지 |
| E2. tier2 → "후보 lens 모드" 클릭 시도 | 클릭 | toast "관리자 전용 기능입니다" |
| E3. admin 로그인 → + 클릭 → lens 선택 | 클릭 | 배지 "🎯 이석재 후보 시각으로 분석" 표시 |
| E4. admin → lens 모드에서 질문 | "시흥캠퍼스 어떻게 보나?" | 답변에 `[이석재] {stanceId}` 인라인 출처 |
| E5. lens 자료 부족 질문 | "오늘 점심 메뉴 추천" | 답변 상단에 "이석재의 명시적 입장 자료 없음" 알림 |
| E6. admin이 lens 대화 후 사이드바 확인 | 새 대화 생성 | 해당 카드 emerald 배경 + 🎯 아이콘 |
| E7. lens 모드 → 일반 모드 토글 | 배지 ✕ 클릭 | 배지 사라짐, 다음 메시지는 'normal' mode 저장 |

### 8.3 회귀 테스트

| Test | Expected |
|---|---|
| R1. 일반 모드에서 "시흥캠퍼스" 질문 | leesj 없이 senate/board/vision/plan만 라우팅 |
| R2. WikiNav 비admin 응답 | 8개 위키만 표시 (leesj 없음) |
| R3. tier1 사용자도 모드 메뉴 | "후보 lens 모드" 비활성 (tier1도 admin 아님) |

---

## 9. Security

### 9.1 위협 모델

| 위협 | 방어 계층 |
|---|---|
| 비admin이 fetch로 lens API 호출 | `app/api/chat/route.ts` 서버 검증 (303줄 추가) |
| 비admin이 wiki API로 leesj 데이터 직접 조회 | `app/api/wiki/[agentId]/route.ts` 404 반환 |
| 일반 모드에서 leesj 자료 누설 | `lib/agents/router.ts` 필터에서 lensPersona 항상 제외 |
| 클라 가드 우회 (devtools에서 chatMode 강제 변경) | 서버 가드가 truth source. 클라는 UX 보조용 |
| stance 자료 일부가 sensitive | 기존 `sensitive: true` 패턴 그대로 적용 |

### 9.2 다층 방어 (Defense in Depth)

```
요청 도착
  ↓
[Layer 1] middleware: 로그인 검증
  ↓
[Layer 2] /api/chat: role 검증 + mode 검증
  ↓
[Layer 3] router: lensPersona 자동 제외
  ↓
[Layer 4] router: adminOnly 비admin 제외
  ↓
[Layer 5] wiki API: adminOnly 404
```

Layer 1~5 중 어느 하나라도 통과 못 하면 차단.

---

## 10. Migration Plan

### 10.1 DB 마이그레이션

**파일**: `drizzle/{timestamp}_add_messages_mode.sql`

```sql
ALTER TABLE messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'normal';

-- lens 모드만 인덱스 (일반 모드는 압도적 다수)
CREATE INDEX IF NOT EXISTS idx_messages_mode 
  ON messages(mode) 
  WHERE mode != 'normal';

-- conversation의 첫 메시지 mode를 빠르게 조회하기 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_messages_conv_created 
  ON messages(conversation_id, created_at);
```

**Backward Compatibility**:
- `default 'normal'` → 기존 메시지는 자동으로 'normal'
- API 응답 변경 없음 (mode 필드는 추가만)
- 기존 클라이언트는 mode 필드 무시 가능

### 10.2 데이터 빌드

`scripts/build-wiki-data.ts`에 leesj 추가:
- WIKI_MAP에 `{ id: 'leesj', folder: 'SNU_이석재후보_LLM_Wiki' }` 추가
- 기존 stance/source/topic/entity 파서 재사용
- 빌드 명령: `npm run wiki:build`
- 출력: `data/leesj.json`

### 10.3 배포 순서

1. **DB 마이그레이션 적용** (Vercel Postgres `drizzle-kit push:pg`)
2. **데이터 파일 업로드** (commit + git push)
3. **코드 배포** (Vercel auto-deploy)
4. **검증**: admin 계정으로 lens 모드 동작 확인 + tier2로 비노출 확인

---

## 11. Implementation Guide

### 11.1 구현 순서 (의존성 기준)

```
[Foundation]
1. lib/agents/types.ts (AgentConfig 확장)
2. lib/db/schema.ts + drizzle migration
3. data/leesj.json + agents.config.json

[Backend]
4. lib/agents/router.ts (가드 추가)
5. lib/agents/lens.ts (신규)
6. lib/llm/prompts.ts (lens 프롬프트 함수)
7. app/api/wiki/route.ts (admin 필터)
8. app/api/wiki/[agentId]/route.ts (admin 가드)
9. app/api/chat/route.ts (mode 분기)
10. app/api/conversations/route.ts (mode 응답)

[Frontend]
11. ChatPage.tsx — chatMode state
12. ChatPage.tsx — ModeMenu/ModeBadge UI
13. ChatPage.tsx — sidebar 색상 분기
14. ChatPage.tsx — sendMessage에 mode 포함
```

### 11.2 핵심 코드 스니펫

**lib/agents/router.ts — 가드 추가**:
```typescript
function getEnabledAgents(role: Role) {
  return registry.getAll().filter(a => {
    if (a.config.adminOnly && role !== 'admin') return false;
    if (a.config.lensPersona) return false;  // 일반 라우팅에서 항상 제외
    return true;
  });
}

export async function routeQuery(query: string, userRole: Role): Promise<RoutingResult> {
  // ...기존 로직...
  const agents = getEnabledAgents(userRole);  // ← 여기만 변경
  // ...나머지 동일...
}
```

**lib/agents/lens.ts — 신규**:
```typescript
import path from 'path';
import fs from 'fs';
import type { WikiData, AgentConfig } from './types';
import type { Role } from '@/lib/auth/roles';
import { canAccessSensitive } from '@/lib/auth/roles';
import agentsConfig from '@/data/agents.config.json';

export interface PersonaContext {
  id: string;
  name: string;
  displayName: string;
  stances: Array<{ id: string; title: string; holder: string; topic: string; content: string; score: number }>;
  stanceBlock: string;
  insufficient: boolean;
}

const STANCE_LIMIT = 8;
const MIN_SCORE = 1;

export function getPersonaConfig(personaId: string): AgentConfig | null {
  return (agentsConfig.agents as AgentConfig[]).find(
    a => a.lensPersona && a.personaId === personaId && a.enabled
  ) ?? null;
}

export async function loadPersonaContext(
  personaId: string,
  query: string,
  userRole: Role,
): Promise<PersonaContext | null> {
  if (userRole !== 'admin') return null;
  
  const config = getPersonaConfig(personaId);
  if (!config) return null;
  
  const filePath = path.join(process.cwd(), 'data', config.dataFile);
  if (!fs.existsSync(filePath)) return null;
  
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WikiData;
  const isSensitiveAllowed = canAccessSensitive(userRole);
  
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/[\s,]+/).filter(w => w.length >= 2);
  
  const allowedStances = (data.stances ?? []).filter(s => isSensitiveAllowed || !s.sensitive);
  
  const scored = allowedStances.map(s => {
    let score = 0;
    const text = `${s.title} ${s.topic} ${s.content}`.toLowerCase();
    for (const w of queryWords) {
      score += (text.match(new RegExp(w, 'g')) ?? []).length;
    }
    if (queryWords.some(w => s.topic.toLowerCase().includes(w))) score += 5;
    return { ...s, score };
  }).filter(s => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, STANCE_LIMIT);
  
  const stanceBlock = scored.map(s =>
    `## [${data.name}-stance] ${s.title} (${s.id}) | topic: ${s.topic}\n${s.content}`
  ).join('\n\n---\n\n');
  
  return {
    id: personaId,
    name: data.name,
    displayName: config.displayName ?? data.name,
    stances: scored.map(s => ({
      id: s.id, title: s.title, holder: s.holder,
      topic: s.topic, content: s.content, score: s.score,
    })),
    stanceBlock,
    insufficient: scored.length === 0,
  };
}
```

**lib/llm/prompts.ts — lens 프롬프트**:
```typescript
export function buildLensSystemPrompt(
  contexts: AgentContext[],
  persona: PersonaContext,
  userRole: Role,
): string {
  const baseSystem = buildSystemPrompt(contexts, userRole);
  
  const insufficientNotice = persona.insufficient
    ? `\n\n## ⚠️ 자료 한계\n이 주제에 대한 ${persona.name}의 명시적 입장 자료가 자료에 없습니다. 답변 시작 부분에 이 사실을 사용자에게 알리고, 일반 자료만으로 답변하세요. ${persona.name}의 의견을 추측·생성하지 마세요.`
    : '';
  
  return `${baseSystem}

## 🎯 Lens 모드 — ${persona.name}의 시각으로 분석

위 자료들을 ${persona.name}의 시각으로 해석·답변하세요.

### Lens 적용 원칙
1. ${persona.name}이 명시적으로 입장을 표명한 주제는 그 입장을 인용 (출처: \`[${persona.name}] {stanceId}\` 형식)
2. 명시적 입장이 없는 주제는 그의 가치 우선순위·관점에 비추어 추론하되, 답변 본문에 "추론" 임을 명시
3. **자료에 없는 내용은 절대 생성하지 말 것** (P1 hallucination 금지 — 일반 모드와 동일)
4. 일반 자료 인용은 \`[위키명] 문서ID\` 형식 그대로 유지
5. 답변 톤은 자연스럽게. 헤더 자동 삽입 안 함. 단, 인용 출처에서 lens인지 일반 자료인지 명확히 구분되어야 함

### ${persona.name} 자료
${persona.stanceBlock || '(매칭된 stance 자료 없음)'}${insufficientNotice}`;
}

export function buildLensUserMessage(
  query: string,
  contexts: AgentContext[],
  persona: PersonaContext,
): string {
  return buildUserMessage(query, contexts);
  // 기존 형식 그대로 사용. lens 자료는 system prompt에 포함됨
}
```

**app/api/chat/route.ts — mode 분기 (핵심)**:
```typescript
const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationId: z.string().optional(),
  mode: z.string().regex(/^(normal|lens:[a-z0-9-]+)$/).default('normal'),
});

// ...session·role 검증 후...

const { message, conversationId, mode } = parsed.data;

// lens 모드 권한 검증
if (mode.startsWith('lens:') && role !== 'admin') {
  return Response.json({ error: '관리자 전용 모드입니다.' }, { status: 403 });
}

// 라우팅 + 프롬프트 분기
let routing, systemPrompt, userMessage, lensPersona;

routing = await routeQuery(message, role);

if (mode.startsWith('lens:')) {
  const personaId = mode.slice(5);
  lensPersona = await loadPersonaContext(personaId, message, role);
  if (!lensPersona) {
    return Response.json({ error: '존재하지 않는 페르소나입니다.' }, { status: 400 });
  }
  systemPrompt = buildLensSystemPrompt(routing.contexts, lensPersona, role);
  userMessage = buildLensUserMessage(message, routing.contexts, lensPersona);
} else {
  systemPrompt = buildSystemPrompt(routing.contexts, role);
  userMessage = buildUserMessage(message, routing.contexts);
}

// DB 저장에 mode 포함
await db.insert(messages).values({
  // ...기존 필드들,
  mode,
});

// 클라에 lens 정보 전달
send({
  type: 'routing',
  agents: routing.selectedAgentIds,
  agentNames: routing.contexts.map(c => c.agentName),
  conversationId: convId,
  lensPersona: lensPersona
    ? { id: lensPersona.id, displayName: lensPersona.displayName, insufficient: lensPersona.insufficient }
    : undefined,
});
```

### 11.3 Session Guide

**Module Map**:
| Module | 파일 | 검증 가능 시점 |
|---|---|---|
| **M1**: Foundation | types.ts, schema.ts, agents.config.json, leesj.json (placeholder) | DB 마이그레이션 + 빌드만으로 |
| **M2**: Backend Lens | router.ts, lens.ts, prompts.ts, chat/route.ts | curl로 API 검증 |
| **M3**: Wiki API + admin gate | wiki/route.ts, wiki/[agentId]/route.ts, conversations/route.ts | curl로 API 검증 |
| **M4**: Frontend | ChatPage.tsx (state, ModeMenu, ModeBadge, sidebar 색상) | 브라우저 E2E |

**Recommended Session Plan**:
```
Session 1: M1 + M2  (≈4시간)
  - DB 스키마, 타입, 데이터 배치
  - 백엔드 lens 동작 (curl 검증)
  
Session 2: M3 + M4  (≈3시간)
  - admin 가드 완성
  - 프론트엔드 UI

Session 3 (옵션): UX Polish
  - 토스트 라이브러리, 메뉴 외부 클릭 닫힘 등
```

**Scope 사용 예시**:
```bash
/pdca do candidate-lens --scope M1,M2     # 백엔드 한 번에
/pdca do candidate-lens --scope M3,M4     # 프론트엔드 한 번에
/pdca do candidate-lens                    # 전체 (한 세션 내 완성)
```

---

## 12. Files Summary

| 파일 | 변경 종류 | 라인 수 (예상) |
|---|---|---|
| `lib/agents/types.ts` | 수정 (필드 추가) | +5 |
| `lib/agents/router.ts` | 수정 (가드 추가) | +10 |
| `lib/agents/lens.ts` | 신규 | ~100 |
| `lib/llm/prompts.ts` | 수정 (함수 추가) | +60 |
| `lib/db/schema.ts` | 수정 (컬럼 추가) | +1 |
| `drizzle/{ts}_add_messages_mode.sql` | 신규 | ~10 |
| `app/api/chat/route.ts` | 수정 (mode 분기) | +25 |
| `app/api/wiki/route.ts` | 수정 (필터) | +3 |
| `app/api/wiki/[agentId]/route.ts` | 수정 (404) | +5 |
| `app/api/conversations/route.ts` | 수정 (mode 응답) | +10 |
| `components/chat/ChatPage.tsx` | 수정 (UI) | +120 |
| `data/agents.config.json` | 수정 (leesj 추가) | +20 |
| `data/leesj.json` | 신규 (빌드 생성) | (자동) |
| `scripts/build-wiki-data.ts` | 수정 (leesj 폴더 추가) | +5 |
| **합계** | | **~370 라인** |

---

## 13. Open Items (Design 단계 미결 — Do 단계에서 결정)

- [ ] 데이터 폴더 이름: `SNU_이석재후보_LLM_Wiki` vs `SNU_leesj_LLM_Wiki` (기존 패턴 따라 한글 추천)
- [ ] 모드 메뉴 외부 클릭 시 닫힘 처리: useRef + outside-click 훅 (별도 라이브러리 없이)
- [ ] toast 알림 표시 방식: 기존 코드에 toast 라이브러리 있는지 확인 필요. 없으면 알림 영역에 inline 표시
