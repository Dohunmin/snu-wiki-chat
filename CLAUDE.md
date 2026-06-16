# CLAUDE.md — snu-wiki-chat

> 새 세션에서 이 파일을 먼저 읽고, 필요 시 각 항목 옆 파일 경로로 점프해 실제 코드 확인할 것.
> 모든 경로는 프로젝트 루트(`c:\Users\USER\Desktop\snu-wiki-chat`) 기준 상대경로.

---

## 0. 프로젝트 한 줄 요약

서울대 거버넌스·단과대·대학원 자료를 **다수의 위키**로 질의응답하는 Next.js 웹앱. (거버넌스·단과대·대학원은 모두 **동등한 wiki_id**이며, 위키 수는 **고정이 아니라 동적으로 증가**한다 — 현재 목록의 source of truth는 [data/agents.config.json](data/agents.config.json).) 다중 위키 자동 라우팅 + **하이브리드 검색(키워드 + Voyage 임베딩/pgvector 벡터 + RRF 융합)** + 권한 관리 + Lens 페르소나 + 한계답변 추적.

> ⚠️ **문서 정합성(2026-05-29 갱신)**: 한때 "벡터 검색 미도입"으로 적혀 있었으나 실제로는 `lib/embed/`(Voyage + pgvector + RRF)가 **이미 도입**됨. `lib/limitations/`(DBSCAN/ANN 클러스터링), `lib/llm/citations.ts`(번호 인용), `lib/agents/recency.ts`, `lib/google-sheets.ts`도 문서에 누락돼 있었음 → §18에 보강. 전반 점검은 [docs/코드_감사_보고서_2026-05-29.md](docs/코드_감사_보고서_2026-05-29.md) 참조.

---

## 1. 기술 스택 · 진입점

| 분류 | 기술 | 진입점 / 설정 파일 |
|------|------|------------------|
| Framework | Next.js 15 (App Router) | [next.config.ts](next.config.ts), [app/layout.tsx](app/layout.tsx) |
| Styling | Tailwind CSS v4 | [postcss.config.mjs](postcss.config.mjs), [app/globals.css](app/globals.css) |
| LLM | `@anthropic-ai/sdk` — `claude-sonnet-4-6`, `MAX_TOKENS=16000` | [lib/llm/client.ts](lib/llm/client.ts) (17 lines) |
| DB | `@vercel/postgres`(Neon) + **pgvector** + Drizzle ORM | [lib/db/schema.ts](lib/db/schema.ts), [lib/db/client.ts](lib/db/client.ts) (`drizzle-orm/vercel-postgres`), [drizzle.config.ts](drizzle.config.ts) |
| 임베딩/벡터검색 | Voyage `voyage-4-large`(1024d) + pgvector + RRF | [lib/embed/](lib/embed/) — §18 |
| 한계 추적 | DBSCAN/ANN 클러스터링(pgvector) + Sonnet 평가 | [lib/limitations/](lib/limitations/) — §18 |
| 외부 연동 | Google Sheets 질의로그 (RS256 JWT) | [lib/google-sheets.ts](lib/google-sheets.ts) — §18 |
| Auth | NextAuth v5 (Credentials, JWT 세션) | [lib/auth/config.ts](lib/auth/config.ts), [middleware.ts](middleware.ts) |
| Build script | tsx | [scripts/build-wiki-data.ts](scripts/build-wiki-data.ts) (503 lines), [scripts/build-embeddings.ts](scripts/build-embeddings.ts) |
| 패키지 | `package.json` | [package.json](package.json) |

---

## 2. 위키 에이전트 (동적 등록 — 거버넌스·단과대·대학원 모두 동등)

> ⚠️ 위키 수는 **고정이 아니라 동적으로 증가**한다. 거버넌스·단과대·대학원은 `group` 태그만 다를 뿐 라우팅·검색·권한상 **완전히 동등한 wiki_id**다 (별개 시스템 아님). 현재 등록 목록의 source of truth는 [data/agents.config.json](data/agents.config.json). 아래 표는 그중 **거버넌스/기본 group**이며, 단과대·대학원 group은 §2.1 참조.

**정의 위치**: [data/agents.config.json](data/agents.config.json) (전체 설정 + 키워드)
**타입 정의**: [lib/agents/types.ts:6-24](lib/agents/types.ts#L6-L24) (`AgentConfig` 인터페이스)
**등록**: [lib/agents/registry.ts:10-21](lib/agents/registry.ts#L10-L21) (`AgentRegistry.init()`)

| ID | 이름 | 데이터 파일 | 특수 플래그 |
|----|------|------------|---|
| senate | 평의원회 | [data/senate.json](data/senate.json) | — |
| board | 이사회 | [data/board.json](data/board.json) | — |
| plan | 대학운영계획 | [data/plan.json](data/plan.json) | — |
| vision | 중장기발전계획 | [data/vision.json](data/vision.json) | — |
| history | 70년역사 | [data/history.json](data/history.json) | — |
| status | 대학현황 | [data/status.json](data/status.json) | `alwaysContext: true` (항상 포함) |
| yhl-speeches | 유홍림총장연설 | [data/yhl-speeches.json](data/yhl-speeches.json) | — |
| finance | 재무정보공시 | [data/finance.json](data/finance.json) | — |
| leesj | 이석재 후보 | [data/leesj.json](data/leesj.json) | `adminOnly + lensPersona`, `personaId: "leesj"` |

**Cross-wiki 개념 인덱스**: [data/concept-index.json](data/concept-index.json) (3,951개)
- 빌드 위치: [scripts/build-wiki-data.ts](scripts/build-wiki-data.ts) (lensPersona 위키는 제외 — `395d21f` 커밋)
- 로딩 위치: [lib/agents/router.ts:60-70](lib/agents/router.ts#L60-L70) (`getConceptIndex`, 캐시됨)

### 2.1 단과대/대학원 위키 (college-grad-wiki, per-college 동적 생성)

거버넌스 위키와 **완전히 동등하게**, 각 단과대·대학원도 독립 wiki_id로 동적 등록된다 (`group` 태그만 다름 — 라우팅·검색·권한 메커니즘은 §2 거버넌스와 동일). (통합 위키 아님 — wiki_id 격리로 "공대 X"는 eng 위키로만 라우팅, 교차오염 0.)

- **레지스트리**: [config/colleges.yaml](config/colleges.yaml) — 28개 조직(survey_status 기반). `active: true`만 위키화.
- **소스**: Obsidian `SNU_단과대_LLM_Wiki` / `SNU_대학원_LLM_Wiki`의 `wiki/{overviews,facts,sources,entities}/{org.id}/` 하위폴더.
- **생성**: [scripts/build-wiki-data.ts](scripts/build-wiki-data.ts) `buildCollegeWiki` + `ensureCollegeAgent` — active 조직마다 `data/{org.id}.json` + agent 항목(`group: '단과대'|'대학원'`) 자동 생성. **조직 추가 = yaml `active` 플래그만 → O(1)**.
- **라우팅**: 기존 wiki_id 메커니즘 그대로. `group` 위키가 선택되면 [lib/agents/answer-class.ts](lib/agents/answer-class.ts) `classifyAnswerClass`로 **AnswerClass(1~4)** 산출 → `RoutingResult.answerClass`/`.college`. AnswerClass 3(연락처·통계)/4(최신공지)는 chat 핸들러가 분기(structured_facts/live_cache). ⚠️ **AnswerClass(답변 방식 분류)는 권한 등급 tier1/tier2와 무관** — 과거 둘 다 'tier'라 혼동돼 2026-06-10 `AnswerClass`로 분리.
- **크롤**: [lib/crawl/](lib/crawl/) (8개 사이트 엔진 어댑터) → 크롤 Tier1/2 `.md` 생성(raw HTML는 `raw/html/`에 원본 보존) → 위 빌드 파이프라인. (lib/crawl의 `Tier`는 크롤 콘텐츠 깊이로, 위 AnswerClass와 같은 1~4 의미축이나 별도 모듈.) cleanser는 콘텐츠셀렉터+밀도기반선택(readability-lite)+반복블록 메뉴제거로 nav/메뉴 걸러냄.
- **AnswerClass 3/4** (`lib/agents/structured.ts`, 앱 DB): 3=`structured_facts`(연락처·통계, TTL 90일), 4=`live_cache`(최신공지, TTL 6h). chat route가 `routing.answerClass===3|4 && routing.college`일 때 직답(`streamDirectAnswer`, LLM 0토큰). 미스/만료→AnswerClass 1 degrade.
- Phase 1 active: `eng`·`humanities`·`social`·`science`. Phase 2~4는 yaml `active` 전환으로 확장.

### 2.2 웹검색 — insight(policy) 전용 (2026-06 설계 변경)

> ⚠️ **변경**: 과거엔 normal(fact) 모드도 `web_search`를 썼으나, **fact 답변이 웹發 사실을 권위 있게 단정하는 리스크**(특히 교수·총장후보가 쓰는 거버넌스 도구) 때문에 **fact 파이프에서 웹 완전 제거**. 웹은 **insight(policy) 파이프 전용**으로 이전. → fact는 내부 KB로만 답하고, 없으면 "내부 자료 범위 밖"으로 정직하게 답함(웹發 리스크 0). 상위 라우터(§3.0)가 fact/insight를 가르므로, 외부 reach가 필요할 수 있는 애매한 질문은 "애매하면 insight" 비대칭으로 insight에 배정 → 웹 도달 보장.

- **위치**: [app/api/chat/route.ts](app/api/chat/route.ts) — `mode === 'policy'`일 때만 메인 스트림에 `WEB_SEARCH_TOOL_POLICY` + `WEB_SEARCH_GUIDANCE_POLICY` 부착. fact(normal)·lens는 도구 미부착.
- **발동 원칙(하나)**: 주제 분류(외부/비교/최신)가 아니라 **"내부 자료([N])로 핵심이 답되느냐"** 만으로 판단. 답되면 검색 안 함, 핵심 일부가 내부에 없으면 떠넘기지 말고 보강(max_uses:1).
- **출처 가드**: `blocked_domains`로 나무위키·더위키·개인 블로그 **하드 차단** + 프롬프트로 1차·공신력 출처만, 실명 미검증 주장 인용 금지, 미확인은 생략/표시.
- **권한·격리**: insight 자체가 admin·tier1 전용(§7) → 웹 노출이 그 경로로만 좁혀짐. tier2·pending은 fact만 → 웹 절대 미도달. lens 미적용.
- **비용**: fact·lens **$0**(웹 없음). insight 발동 시 **~$0.18~0.36**(웹 페이지 본문이 입력토큰). `[chat-usage] web=N` 로깅.

---

## 3. 라우팅 엔진

**파일**: [lib/agents/router.ts](lib/agents/router.ts) (171 lines)
**진입 함수**: `routeQuery(query, userRole)` — [router.ts:106](lib/agents/router.ts#L106)

### 3.1 상수 (router.ts:15-19)

```ts
MIN_ABSOLUTE_SCORE = 3       // 절대 점수 하한
RELATIVE_THRESHOLD = 0.4     // 1위 점수 대비 비율
MAX_WIKIS = 6                // 한 번에 호출할 최대 위키 수
ALWAYS_CONTEXT_CAP = 5       // alwaysContext 위키의 chunk cap
TOTAL_CHUNK_BUDGET = 30      // 전체 chunk 예산
```

### 3.2 단계별 흐름

| 단계 | 함수 / 위치 | 동작 |
|------|------------|------|
| **Pre** | [router.ts:98-104](lib/agents/router.ts#L98-L104) `getRoutableAgents` | `lensPersona` 제외, `adminOnly`는 비admin에게 제외 |
| **Tier 0** | [router.ts:112-119](lib/agents/router.ts#L112-L119) | `agentsConfig.routing.globalKeywords`(예: "전체","종합") 매칭 시 모든 위키 full coverage |
| **Stage 1** | [router.ts:21-34](lib/agents/router.ts#L21-L34) `prefilterScore` | 각 에이전트별 키워드 매칭 점수 + `WikiAgent.preScore()` 보너스 5점 |
| **Concept lookup** | [router.ts:72-95](lib/agents/router.ts#L72-L95) `lookupConceptIndex` | `concept-index.json`에서 `forcedWikis` + `guaranteedPages` 추출 |
| **Gap detect** | [router.ts:36-50](lib/agents/router.ts#L36-L50) `detectScoreGap` | 점수 급락 지점 자동 탐지로 cutoff 결정 |
| **선택** | [router.ts:134-144](lib/agents/router.ts#L134-L144) | `alwaysContext` OR `forcedWikis` OR (`score >= MIN_ABSOLUTE_SCORE` AND `score >= relativeThreshold` AND `i <= gapCutoff`), 최대 `MAX_WIKIS`개 |
| **Stage 2 cap 분배** | [router.ts:147-154](lib/agents/router.ts#L147-L154) | `(30 - alwaysContext수×5) / 일반위키수`, 최소 5 |
| **컨텍스트 수집** | [router.ts:156-161](lib/agents/router.ts#L156-L161) | 각 `WikiAgent.getContext()` 병렬 호출 |
| **신뢰도 필터** | [router.ts:163-164](lib/agents/router.ts#L163-L164) | `confidence > 0.3`인 것만, 전부 0.3 이하면 전체 반환 (fallback) |

---

## 4. WikiAgent — 청크 추출 & 스코어링

**파일**: [lib/agents/wiki-agent.ts](lib/agents/wiki-agent.ts) (327 lines)
**진입 함수**: `getContext(query, role, isGlobal, options)` — [wiki-agent.ts:96](lib/agents/wiki-agent.ts#L96)

### 4.1 상수 / 헬퍼

| 항목 | 위치 |
|------|------|
| `MAX_CHUNKS = 15` / `MAX_CHUNKS_ENTITY = 30` | [wiki-agent.ts:7-8](lib/agents/wiki-agent.ts#L7-L8) |
| `splitIntoChunks` — `## 헤더` 단위 분할, <100자는 다음과 병합 | [wiki-agent.ts:11-30](lib/agents/wiki-agent.ts#L11-L30) |
| `scoreChunk` — 쿼리 단어 등장 횟수 합산 | [wiki-agent.ts:33-41](lib/agents/wiki-agent.ts#L33-L41) |
| `preScore` — 메타데이터(tags/topics/entities/stance/fact)만 스캔 | [wiki-agent.ts:45-65](lib/agents/wiki-agent.ts#L45-L65) |
| `loadData` — JSON 캐시 로딩, 후방호환 빈배열 보정 | [wiki-agent.ts:75-94](lib/agents/wiki-agent.ts#L75-L94) |

### 4.2 getContext 내부 흐름

| 단계 | 위치 | 동작 |
|------|------|------|
| 1. 권한 필터 | [wiki-agent.ts:103-109](lib/agents/wiki-agent.ts#L103-L109) | `sensitive` 자료 제외 (tier2는 차단) |
| 2. Entity/Topic 역참조 | [wiki-agent.ts:111-131](lib/agents/wiki-agent.ts#L111-L131) | entity/topic 이름 매칭 시 연관 source IDs를 `guaranteedIds`에 추가 + concept-index의 `guaranteedPageIds` 합산 |
| 3. 소스 단위 점수 | [wiki-agent.ts:133-159](lib/agents/wiki-agent.ts#L133-L159) | guaranteed +5, topic +3, entity +2, tag +2, content 단어 +1 |
| 4. source 청크 점수 | [wiki-agent.ts:161-186](lib/agents/wiki-agent.ts#L161-L186) | `scoreChunk()`; guaranteed는 `score*2+1` 보너스 |
| 5. 신규 타입 점수 (`stance`/`fact`/`overview`) | [wiki-agent.ts:188-240](lib/agents/wiki-agent.ts#L188-L240) | 청크 분할 없이 전체 통째로 스코어링, guaranteed +5, holder/topic/category 매칭 +3 |
| 6. chunk cap 결정 | [wiki-agent.ts:242-246](lib/agents/wiki-agent.ts#L242-L246) | `options.chunkCap` > isGlobal면 전체 > guaranteed 있으면 30 > 기본 15 |
| 7. 소스 커버리지 균등화 | [wiki-agent.ts:248-285](lib/agents/wiki-agent.ts#L248-L285) | 각 source 대표청크 먼저, 그 다음 labeled items, 그 다음 나머지 청크 |
| 8. Entity 블록 추가 | [wiki-agent.ts:287-294](lib/agents/wiki-agent.ts#L287-L294) | entity 페이지 통째로 컨텍스트 상단 부착 |
| 9. 출력 포맷 (라벨링) | [wiki-agent.ts:296-309](lib/agents/wiki-agent.ts#L296-L309) | `## [stance] ...`, `## [fact] ...`, `## 회의록 (id) | 회의일:` 등 |
| 10. confidence | [wiki-agent.ts:324](lib/agents/wiki-agent.ts#L324) | 매칭 있으면 0.8, 없으면 0.3 |

---

## 5. Lens 모드 — 인물 시각 분석 (admin + tier1, `canUseLens`)

> 권한: 2026-06-15 admin 전용 → **admin+tier1**로 확대 (tier2·pending 차단). 가드 = `canUseLens` (roles.ts) — route.ts lens 분기 / `loadPersonaContext` #1 / 프론트 게이트 3중.

**파일**: [lib/agents/lens.ts](lib/agents/lens.ts)

| 항목 | 위치 |
|------|------|
| `PersonaContext` 인터페이스 (`canonical` 필드 포함) | [lens.ts](lib/agents/lens.ts) |
| 상수: `STANCE_LIMIT = 8`, `MIN_SCORE = 1` | [lens.ts:38-39](lib/agents/lens.ts#L38-L39) |
| `getPersonaConfig` — `lensPersona && personaId` 매칭 | [lens.ts](lib/agents/lens.ts) |
| `loadPersonaContext` — 다층 가드(#1 `canUseLens`), canonical(L0) 상시 로드 + stance 스코어링 | [lens.ts](lib/agents/lens.ts) |
| stance 스코어링: 빈도 + topic 매칭 +5 + title 매칭 +3 | [lens.ts](lib/agents/lens.ts) |
| `personaToContext` / `canonicalToContext` — stance(L1)·canonical(L0)을 [N] 인용 컨텍스트로 | [lens.ts](lib/agents/lens.ts) |
| `insufficient: true` — 매칭 stance 0개 **AND** canonical 0개일 때만 → 한계 명시 | [lens.ts](lib/agents/lens.ts) |

**Canonical 레이어 모델 (L0 프레임, *필터 아님*)**: `data/{persona}.json`의 `layer: canonical` source(예: leesj 공약 "미래대학 3대 축")를 질의와 무관하게 **항상 컨텍스트 최상단에 pin**(`canonicalToContext`) → 답변의 1차 조직 프레임. route.ts lens 순서 = `[canonical(L0), 중립위키, stance(L1)]`. ⚠️ **프레임이지 필터가 아님** — 3대 축에 안 맞는 주제(국제화·캠퍼스·인권 등)도 회수된 stance를 그대로 충실히 활용하고, 공약은 닿는 곳만 연결([prompts.ts](lib/llm/prompts.ts) `buildLensSystemPrompt`의 "공약 프레임" 섹션). frontmatter `layer`는 빌드가 [WikiSource.layer](lib/agents/types.ts)로 보존. Obsidian source-of-truth = `SNU_후보 철학_LLM_Wiki/CLAUDE.md` §1.5/§7.1.

**호출 흐름**: `POST /api/chat` body의 `mode: 'lens:leesj'` → [api/chat/route.ts:66-78](app/api/chat/route.ts#L66-L78)

---

## 6. LLM 시스템 프롬프트

**파일**: [lib/llm/prompts.ts](lib/llm/prompts.ts) (127 lines)

| 함수 | 위치 | 역할 |
|------|------|------|
| `buildSystemPrompt(contexts, userRole)` | [prompts.ts:5-74](lib/llm/prompts.ts#L5-L74) | P1~P5 원칙 (할루시네이션 금지, 인라인 출처, 테마별 구조화, 교차 확인, 한계 인정) + 페이지 타입 활용 가이드 + 답변 길이 원칙. tier2면 sensitiveWarning 추가 |
| `buildUserMessage(query, contexts)` | [prompts.ts:76-82](lib/llm/prompts.ts#L76-L82) | `### [위키명] 관련 자료` 헤더로 컨텍스트 묶음 + 질문 |
| `buildLensSystemPrompt(contexts, persona, userRole)` | [prompts.ts:88-114](lib/llm/prompts.ts#L88-L114) | 일반 프롬프트 + Lens 적용 5원칙 + stance 자료 블록 + insufficient 경고 |
| `buildLensUserMessage` | [prompts.ts:120-127](lib/llm/prompts.ts#L120-L127) | 현재는 `buildUserMessage`와 동일 (향후 확장 지점) |

---

## 7. 채팅 API — 메인 엔드포인트

**파일**: [app/api/chat/route.ts](app/api/chat/route.ts) (~320 lines)
> ⚠️ 아래 표의 라인 번호는 작성 당시 기준 — 이후 번호 인용(§18.2)·H-4 수정 등으로 이동됨. 흐름만 참고하고 실제 라인은 코드 확인.
> 추가 흐름: chunk마다 `safeFlushPoint`+`resolveText`로 `[N]` 인용 안전 변환, 완료 후 old-format 검출 시 1회 retry(`replace` 이벤트), 스트림 실패 시 부분답변 저장(H-4).

| 단계 | 위치 |
|------|------|
| Zod 스키마 (`message` 최대 2000자, `mode: 'normal'|'lens:xxx'`) | [route.ts:19-23](app/api/chat/route.ts#L19-L23) |
| 인증 + `canChat()` 권한 검증 | [route.ts:26-34](app/api/chat/route.ts#L26-L34) |
| lens 모드 admin 검증 (다층 방어 #2) | [route.ts:46-48](app/api/chat/route.ts#L46-L48) |
| `routeQuery` 호출 → `routing.contexts` | [route.ts:64](app/api/chat/route.ts#L64) |
| 모드 분기: lens면 `loadPersonaContext` + `buildLens*` | [route.ts:66-82](app/api/chat/route.ts#L66-L82) |
| 대화 신규 생성 (없으면) + user 메시지 저장 | [route.ts:84-101](app/api/chat/route.ts#L84-L101) |
| **SSE 스트리밍 시작** | [route.ts:107-194](app/api/chat/route.ts#L107-L194) |
| `routing` 이벤트 (선택된 에이전트 즉시 전달) | [route.ts:115-121](app/api/chat/route.ts#L115-L121) |
| 직전 5회 교환(user+assistant×5 = 10개) 대화 이력 포함 | [route.ts:162-181](app/api/chat/route.ts#L162-L181) |
| Anthropic 스트림 → `chunk` 이벤트 | [route.ts:147-162](app/api/chat/route.ts#L147-L162) |
| `sources` 이벤트 (출처 목록) | [route.ts:164-165](app/api/chat/route.ts#L164-L165) |
| assistant 메시지 DB 저장 | [route.ts:167-175](app/api/chat/route.ts#L167-L175) |
| `done` 이벤트 (conversationId 반환) | [route.ts:177](app/api/chat/route.ts#L177) |

---

## 8. API 엔드포인트 전체 목록

| 경로 | 파일 | 메서드 | 권한 |
|------|------|--------|------|
| `/api/auth/[...nextauth]` | [app/api/auth/](app/api/auth/) | - | - |
| `/api/register` | [app/api/register/](app/api/register/) | POST | 비인증 |
| `/api/chat` | [app/api/chat/route.ts](app/api/chat/route.ts) | POST | `canChat` |
| `/api/conversations` | [app/api/conversations/route.ts](app/api/conversations/route.ts) | GET | 인증 (본인 것만) |
| `/api/conversations/[id]` | [app/api/conversations/[id]/](app/api/conversations/%5Bid%5D/) | GET/DELETE | 인증. ⚠️ **GET은 소유권 미검사**(공개뷰어 의도) — 감사 H-3 |
| `/api/conversations/public` | [app/api/conversations/public/route.ts](app/api/conversations/public/route.ts) | GET | 인증. **타 유저 대화 title 노출** — 감사 H-3 연관 |
| `/api/wiki` | [app/api/wiki/route.ts](app/api/wiki/route.ts) | GET | 인증 |
| `/api/wiki/[agentId]` | [app/api/wiki/[agentId]/](app/api/wiki/%5BagentId%5D/) | GET | 인증 |
| `/api/wiki/syntheses` | [app/api/wiki/syntheses/](app/api/wiki/syntheses/) | GET/POST | 인증 |
| `/api/admin/users` | [app/api/admin/users/](app/api/admin/users/) | GET/PATCH | admin |
| `/api/admin/uploads` · `/api/admin/uploads/[id]` | [app/api/admin/uploads/](app/api/admin/uploads/) | GET/PATCH | admin |
| `/api/admin/limitations` | [app/api/admin/limitations/route.ts](app/api/admin/limitations/route.ts) | GET | admin (한계 클러스터 조회) |
| `/api/admin/limitations/refresh` | [app/api/admin/limitations/refresh/route.ts](app/api/admin/limitations/refresh/route.ts) | POST | admin (batch 증분 갱신) |
| `/api/admin/backfill-sheets` | [app/api/admin/backfill-sheets/route.ts](app/api/admin/backfill-sheets/route.ts) | POST | admin |
| `/api/uploads` | [app/api/uploads/](app/api/uploads/) | POST | `canUpload` |

**라우팅 보호**: [middleware.ts](middleware.ts) (42 lines) — `/admin/*` admin 전용, `/`·`/api/chat` `canChat`, 비인증은 `/login` 리다이렉트, `pending`은 `/pending` 페이지.

---

## 9. 페이지 (App Router)

| 경로 | 파일 |
|------|------|
| `/` (채팅 메인) | [app/page.tsx](app/page.tsx) → [components/chat/ChatPage.tsx](components/chat/ChatPage.tsx) |
| `/login` | [app/login/](app/login/) |
| `/register` | [app/register/](app/register/) |
| `/pending` | [app/pending/](app/pending/) |
| `/wiki` (위키 브라우저) | [app/wiki/](app/wiki/) → [components/wiki/WikiNav.tsx](components/wiki/WikiNav.tsx), [components/wiki/WikiViewer.tsx](components/wiki/WikiViewer.tsx) |
| `/admin` (관리자) | [app/admin/](app/admin/) → [components/admin/AdminDashboard.tsx](components/admin/AdminDashboard.tsx) |

---

## 10. 권한 체계

**파일**: [lib/auth/roles.ts](lib/auth/roles.ts)

| Role | label | canChat | canUpload | canAccessAdmin | canAccessSensitive |
|------|-------|:-------:|:---------:|:--------------:|:------------------:|
| `admin` | 관리자 | ✓ | ✓ | ✓ | ✓ |
| `tier1` | 1차 접근 | ✓ | ✓ | ✗ | ✓ |
| `tier2` | 2차 접근 | ✓ | ✗ | ✗ | ✗ |
| `pending` | 승인 대기 | ✗ | ✗ | ✗ | ✗ |

함수 정의: [roles.ts:17-31](lib/auth/roles.ts#L17-L31). `canAccessSensitive`는 [wiki-agent.ts:103](lib/agents/wiki-agent.ts#L103), [lens.ts:59](lib/agents/lens.ts#L59) 에서 호출.

---

## 11. 데이터 모델

### 11.1 위키 JSON 페이지 타입 — 7가지

**타입 정의**: [lib/agents/types.ts](lib/agents/types.ts)

| 타입 | 인터페이스 | 위치 | 설명 |
|------|----------|------|------|
| source | `WikiSource` | [types.ts:51-60](lib/agents/types.ts#L51-L60) | 회의록·계획서 1건 |
| topic | `WikiTopic` | [types.ts:62-69](lib/agents/types.ts#L62-L69) | 주제별 색인 |
| entity | `WikiEntity` | [types.ts:71-79](lib/agents/types.ts#L71-L79) | 인물·기구 |
| synthesis | `WikiSynthesis` | [types.ts:81-89](lib/agents/types.ts#L81-L89) | 저장된 Q&A |
| fact | `WikiFact` | [types.ts:91-103](lib/agents/types.ts#L91-L103) | 정형 통계·재무 |
| stance | `WikiStance` | [types.ts:105-114](lib/agents/types.ts#L105-L114) | 인물 입장·발언 (lens 핵심) |
| overview | `WikiOverview` | [types.ts:116-125](lib/agents/types.ts#L116-L125) | 편(章) 단위 개요 |

전체 `WikiData` 구조: [types.ts:127-138](lib/agents/types.ts#L127-L138)
`ConceptIndex` 구조: [types.ts:140-152](lib/agents/types.ts#L140-L152)

### 11.2 DB 테이블 (Drizzle)

**파일**: [lib/db/schema.ts](lib/db/schema.ts)

| 테이블 | 위치 | 주요 필드 |
|-------|------|----------|
| `users` | [schema.ts:3-13](lib/db/schema.ts#L3-L13) | id, email, passwordHash, role, approvedBy, approvedAt |
| `conversations` | [schema.ts:15-21](lib/db/schema.ts#L15-L21) | id, userId, title |
| `messages` | [schema.ts:23-32](lib/db/schema.ts#L23-L32) | role, content, **routedAgents** (text[]), **sources** (jsonb), **mode** (normal\|lens:xxx) |
| `uploads` | [schema.ts:34-44](lib/db/schema.ts#L34-L44) | agentId, fileName, content, status (pending\|approved\|rejected), reviewedBy |
| `syntheses` | [schema.ts:46-56](lib/db/schema.ts#L46-L56) | query, answeredAt, routedTo, content (채팅 저장 답변) |
| `sensitiveTopics` | [schema.ts:58-64](lib/db/schema.ts#L58-L64) | agentId, topic, createdBy |

---

## 12. 빌드 파이프라인 (Obsidian → JSON)

**파일**: [scripts/build-wiki-data.ts](scripts/build-wiki-data.ts) (573 lines)
**실행**: `npm run wiki:build`

처리 내용:
- Obsidian 마크다운 + frontmatter 파싱 (`OBSIDIAN_PATH` 환경변수 기준, 기본 `../Obsidian`)
- 각 위키별 sources/topics/entities/facts/stances/overviews 추출
- Topic/Entity → Source 역매핑
- 키워드 자동 보강 → `data/agents.config.json` 갱신
- Concept Index 생성 → `data/concept-index.json` (lensPersona 위키 제외)

---

## 13. npm 명령어

| 명령어 | 동작 |
|-------|------|
| `npm run dev` | Next.js 개발 서버 |
| `npm run build` | 프로덕션 빌드 |
| `npm run start` | 프로덕션 서버 |
| `npm run wiki:build` | Obsidian → `data/*.json` 전처리 (에이전트 데이터 갱신 시) |
| `npm run embed:build` | `data/*.json` → Voyage 임베딩 → `chunk_embeddings` 적재 (증분, contentHash 기반) |
| `npm run qa:golden` | 골든 QA 회귀 테스트 ([scripts/golden-qa.ts](scripts/golden-qa.ts)) |
| `npm run watch` | 파일 변경 감시 → 자동 재빌드 ([scripts/watch.ts](scripts/watch.ts)) |
| `npm run knowledge:map` / `knowledge:questions` | 지식 지형도(PCA proj) / 질문 임베딩 생성 |
| `npm run db:generate` | Drizzle 마이그레이션 SQL 생성 |
| `npm run db:migrate` | DB에 마이그레이션 적용 |

---

## 14. 환경 변수

```
ANTHROPIC_API_KEY            # Claude API (lib/llm/client.ts:6)
VOYAGE_API_KEY               # Voyage 임베딩 API (lib/embed/voyage.ts, lib/limitations/refresh.ts)
MASTER_ADMIN_EMAIL           # 마스터 어드민 이메일
MASTER_ADMIN_PASSWORD        # 마스터 어드민 비밀번호 (Credentials provider)
OBSIDIAN_PATH                # Obsidian 폴더 경로 (기본: ../Obsidian)
AUTH_SECRET                  # NextAuth 시크릿
POSTGRES_URL                 # @vercel/postgres (Neon, pgvector 확장 필요)
GOOGLE_SERVICE_ACCOUNT_JSON  # Google Sheets 질의로그용 서비스계정 JSON (선택)
GOOGLE_SHEET_ID              # 로그 기록 대상 시트 ID (선택)
RAG_DEBUG                    # 'true'면 RRF/시맨틱라우팅 디버그 로그 (선택)
```

---

## 15. 알려진 한계 / 향후 과제

- 데이터 갱신이 수동 (`npm run wiki:build` → `npm run embed:build` 순서로 실행 필요)
- Synthesis 저장이 Postgres에만 — Obsidian 역방향 동기화 없음
- 모바일 UI 미최적화
- LLM 응답 캐싱 없음 (매번 새 호출)
- **2026-05-29 감사에서 보안/정합성 이슈 다수 발견** — [docs/코드_감사_보고서_2026-05-29.md](docs/코드_감사_보고서_2026-05-29.md) (HIGH 6 / MEDIUM 33 등). 미해결 항목 추적 필요.

---

## 16. 관련 설계 문서

- [docs/SNU_거버넌스_위키_시스템_보고서.md](docs/SNU_거버넌스_위키_시스템_보고서.md) — ⚠️ **2026-04-30 작성, 일부 stale** (거버넌스 위키 일부만 언급)
- [docs/라우팅_스코어링_상세.md](docs/라우팅_스코어링_상세.md) — 라우팅/스코어링 로직 보충
- [docs/스코어링_및_답변_생성_보고서.md](docs/스코어링_및_답변_생성_보고서.md)
- [docs/01-plan/features/](docs/01-plan/features/) — smart-retrieval, multi-wiki-integration 등 plan
- [docs/02-design/features/](docs/02-design/features/) — multi-wiki-integration 등 design
- [docs/코드_감사_보고서_2026-05-29.md](docs/코드_감사_보고서_2026-05-29.md) — **전체 코드 감사** (버그 63 / 개선 25 / 죽은코드 4, file:line + 수정안)

---

## 17. 최근 주요 변경 이력 (git log)

```
9ce1311 Sync history & status wikis from Obsidian: backfill topics
a839b30 candidate-lens M3: frontend lens UI
395d21f Exclude lensPersona wikis from concept-index build
3089a7a candidate-lens M1+M2: backend lens mode for admin-only persona
fc20e82 Fix wiki nav summary, citation regex, and back navigation
aeaadbe Fix middleware 504: remove DB query from session callback
911f4ad Fix citation links and wiki nav for fact/stance/overview types
7126ba9 Fix scroll lock and restore conversation on back navigation
1e06df9 Fix auto-scroll: stop following when user scrolls up during streaming
278b62d Fix global routing: always use all wikis when global keyword present
```

**핵심 흐름**: Candidate Lens 기능(M1~M3) 완성 → 위키 nav/citation 정선 → Obsidian 동기화 자동화 강화 → **RAG(Voyage+pgvector+RRF) 도입** → **한계답변 추적(pgvector ANN 클러스터링)** 추가.

---

## 18. 추가 서브시스템 (문서 보강 — 2026-05-29)

> §1~§17이 작성된 이후 추가됐으나 본문에 누락돼 있던 모듈들. 실제 코드는 각 경로에서 확인.

### 18.1 RAG — 하이브리드 검색 ([lib/embed/](lib/embed/))

키워드 스코어링(WikiAgent) 결과와 벡터 검색 결과를 **RRF(Reciprocal Rank Fusion)** 로 융합. 모든 위키 `ragEnabled: true`.

| 파일 | 역할 |
|------|------|
| [lib/embed/voyage.ts](lib/embed/voyage.ts) | Voyage REST 클라이언트. `voyage-4-large`, `output_dimension=1024`, 128배치, 지수백오프 재시도, 차원검증 |
| [lib/embed/search.ts](lib/embed/search.ts) | `searchVector(query, wikiId, role, k)` — Voyage 쿼리임베딩 → pgvector cosine(`<=>`) top-K. `semanticRoutingHints()` — 위키 자동 라우팅 후보 |
| [lib/embed/rrf.ts](lib/embed/rrf.ts) | `rrfFuse(keyword, vector, {k:60, limit})` — 순위 기반 융합, 순수 함수 |
| [lib/embed/chunker.ts](lib/embed/chunker.ts) | 임베딩용 청크 분할 (WikiAgent `splitIntoChunks`와 동일 규칙) |

- **통합 지점**: [wiki-agent.ts](lib/agents/wiki-agent.ts) `getContext` 내 `if (this.config.ragEnabled)` 블록 — 키워드 결과를 RRF 입력으로 변환 후 융합, 실패 시 키워드 단독 fallback(try/catch).
- **DB**: `chunk_embeddings` 테이블 (`vector(1024)`, `sensitive`, `contentHash`). 적재는 `npm run embed:build`.
- **권한**: `searchVector`가 `wiki_id` + `canAccessSensitive` 기반 `sensitive` 필터를 SQL WHERE에 적용 (다층 방어).

### 18.2 번호 인용 ([lib/llm/citations.ts](lib/llm/citations.ts))

LLM이 긴 source ID 대신 `[N]` 번호만 쓰게 하고 서버에서 `[위키명] sid`로 resolve (wrong-attribution 차단, Perplexity 방식).

| 함수 | 역할 |
|------|------|
| `buildNumberedContexts` | unique source에 `[N]` 부여 + 헤더에 주입(sid 숨김) + 매핑/요약 생성 |
| `resolveText` / `extractCitedNumbers` / `resolveCitations` | `[N]` → 출처 텍스트/링크 변환, 인용된 번호 추출 |
| `safeFlushPoint` | SSE 스트리밍 중 미완성 `[N]`이 잘리지 않는 안전 flush 지점 |
| `detectOldFormatCitations` / `buildOldFormatRetryPrompt` | LLM이 옛 형식(`[위키] sid`) 출력 시 1회 재요청 |

**호출**: [app/api/chat/route.ts](app/api/chat/route.ts) 스트리밍 루프에서 chunk마다 `safeFlushPoint`+`resolveText`, 완료 후 old-format 검출 시 retry.

### 18.3 recency-boost ([lib/agents/recency.ts](lib/agents/recency.ts))

`detectRecencyIntent` — "최근/최신/이번/올해…" 시간성 키워드 감지 시 `getRecencySources`로 date 최신 N개 source를 **컨텍스트에 직접 주입**(점수 가산 아님). WikiAgent `getContext` 말미에서 호출. ⚠️ 감사 M-15/M-16: cap 초과·과발동 이슈.

### 18.4 한계답변 추적 ([lib/limitations/](lib/limitations/))

챗봇이 "자료 없음/한계"를 명시한 답변을 추적·클러스터링해 보충 우선순위를 시각화 (admin 전용).

| 파일 | 역할 |
|------|------|
| [lib/limitations/refresh.ts](lib/limitations/refresh.ts) | 증분 처리 핵심: 미처리 질문 → Voyage 임베딩 + Sonnet 품질평가 + 코드기반 한계마커 추출 → INSERT + ANN 클러스터 할당 + 라벨 재생성 |
| [lib/limitations/cluster-ann.ts](lib/limitations/cluster-ann.ts) | `assignClusterANN` — pgvector 이웃검색 기반 증분 클러스터 할당. `rebuildAllClusters` — 전체 DBSCAN 보정 |
| [lib/limitations/dbscan.ts](lib/limitations/dbscan.ts) | 순수 DBSCAN (cosine distance) |

- **DB**: `limitation_questions`(질문/답변/임베딩/quality/limitation/clusterId/PCA좌표), `limitation_clusters`(라벨 캐시).
- **API**: GET `/api/admin/limitations`(클러스터 조회), POST `/api/admin/limitations/refresh`(batch 증분). UI: [components/admin/LimitationsView.tsx](components/admin/LimitationsView.tsx).
- ⚠️ 감사 M-8~M-10: 트랜잭션 부재·클러스터ID 경쟁·NEW배지 정합성 이슈.

### 18.5 Google Sheets 질의 로그 ([lib/google-sheets.ts](lib/google-sheets.ts))

`logQuestionToSheet` — 매 채팅 완료 시 질문/답변/위키/모드를 시트에 기록 (RS256 서비스계정 JWT). `GOOGLE_SERVICE_ACCOUNT_JSON`/`GOOGLE_SHEET_ID` 없으면 no-op. [app/api/chat/route.ts](app/api/chat/route.ts) 말미에서 호출. ⚠️ 감사 M-26: 토큰 캐시 포이즈닝.
