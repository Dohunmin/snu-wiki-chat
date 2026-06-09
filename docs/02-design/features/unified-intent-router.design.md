# Design: Unified Intent Router — Haiku QueryPlan 1콜 통합 (아키텍처 C)

> **Feature**: unified-intent-router
> **Date**: 2026-06-09
> **Phase**: Design (ready for `/pdca do unified-intent-router`)
> **Plan**: [unified-intent-router.plan.md](../../01-plan/features/unified-intent-router.plan.md)
> **선택 아키텍처**: **C (실용 균형)** — `agent-router.ts` 확장(새 prod 모듈 X), shadow는 `scripts/`. 플랜을 `routeQuery`에 주입해 완전 통합.

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 의도 분류가 5파일 하드코딩 키워드로 분산 + ~50% 신호 중복 → 질문유형마다 리스트 추가 = 예외 무한증식. Haiku가 *의도*를 구조화 데이터(QueryPlan)로 산출 → 단일 진실원으로 종료. |
| **WHO** | 전 사용자(라우팅 정확도↑) + 유지보수(분류 단일화) + 비용부담자(질의당 비용 불변 — 기존 Haiku 콜 재사용). |
| **RISK** | Haiku 오분류 / 단일콜 책임확대 / 스키마확장 파싱취약 / cutover 미세회귀 / scope creep(tier·web). |
| **SUCCESS** | 단일콜 플랜 출력·추가LLM콜 0 / shadow 일치율 검증 / governance 19/19·골든 비회귀 / 정규식 call-site 제거 / 회귀셋 무회귀 / 비용 불변. |
| **SCOPE** | 수정: `agent-router.ts`·`router.ts`·`route.ts`·`wiki-agent.ts`(recency option). 신규: `scripts/shadow-intent.ts`. 은퇴(cutover후): complexity/recency/college-route 키워드 call-site. 비스코프: tier(T3/T4), web, evaluator, wiki_id 격리. |

---

## 1. 개요 — 무엇을, 어떻게

**한 줄**: 매 질의에 이미 도는 `routeToAgent`(Haiku)를 `planQuery`로 확장 → `QueryPlan` **데이터 객체** 1개 산출 → route.ts/router.ts가 이 데이터를 소비(흩어진 정규식 분류기 대체).

**선택 아키텍처 C**: planQuery·QueryPlan·defaultPlan을 **`agent-router.ts`에 응집**(Haiku 분류라는 같은 관심사). shadow 비교(regexPlan·comparePlans)는 **`scripts/shadow-intent.ts`**(이행 끝나면 삭제, prod 무흔적).

## 2. QueryPlan 스키마

```ts
// lib/agents/agent-router.ts
export interface QueryPlan {
  intent: 'fact' | 'insight';        // 기존 routeToAgent — 답변 스타일
  complexity: 'simple' | 'complex';  // → 예산 16k/40k (classifyComplexity 대체)
  recency: boolean;                  // → 최신 source 주입 (detectRecencyIntent 대체)
  collegeBreadth: boolean;           // → 단과대/대학원 그룹 admit (detectGroupBreadth 대체)
  collegeAggregate: boolean;         // → 단과대 그룹 force-select (detectGroupAggregate 대체)
  reason: string;                    // ≤30자
  via: 'llm' | 'fallback';
}
```

> ⚠️ **`breadth` 용어충돌 해소(코드 정독서 발견)**: `detectGroupBreadth`(단과대 그룹) ≠ `detectBreadthIntent`(시간순·전체기록, recency.ts). 후자는 **이름을 `collegeBreadth`로 분리**해 혼선 차단. **`detectBreadthIntent`는 v1 미흡수** — 소비처(router.ts:229)가 `GLOBAL_TOPK_ENABLED` 블록 안 = **prod OFF(휴면)**이라 흡수 가치 0. 별도(§10).

**안전 디폴트**(Haiku 실패 시 — harm-asymmetric 과잉서빙):
```ts
function defaultPlan(): QueryPlan {
  return { intent:'insight', complexity:'complex', recency:false,
           collegeBreadth:false, collegeAggregate:false, reason:'fallback', via:'fallback' };
}
```
(insight+complex = 더 풍부하게 서빙 → 빈약화보다 안전. college 신호 false = 거버넌스 기본, 오염 0.)

## 3. planQuery (agent-router.ts 확장)

기존 `routeToAgent`의 패턴을 그대로 일반화:
- 프롬프트: 현 fact/insight 룰 + complexity/recency/college 정의·예시 1프롬프트(temp=0, `max_tokens` 80→~160).
- 출력: `{intent, complexity, recency, collegeBreadth, collegeAggregate, reason}` JSON 한 줄.
- **필드별 robust 추출**(기존 `extractAgent` 일반화): 정규식으로 각 필드 개별 추출 → reason 잘림에도 핵심필드 복원. 한 필드 누락 시 그 필드만 안전디폴트(전체 fallback 아님).
- 실패/타임아웃(4s) → `defaultPlan()`.

`routeToAgent`는 `planQuery`로 대체(혹은 `planQuery`를 부르고 `.intent`만 쓰는 얇은 래퍼로 잔존 — route.ts effective-mode 로직 무변경).

## 4. 통합 지점 (코드 정독 기준 — 정밀)

| 신호 | 현재 소스 | 소비 위치 | 교체 | 비고 |
|---|---|---|---|---|
| complexity | `classifyComplexity` (complexity.ts) | **route.ts:186** `complexityBudget(message)` | `plan.complexity==='complex'?40k:16k` | route.ts 소유 — 가장 단순 |
| collegeBreadth | `detectGroupBreadth` (college-route.ts) | **router.ts:123** `getRoutableAgents` admit | `plan.collegeBreadth` | routeQuery에 plan 주입 필요 |
| collegeAggregate | `detectGroupAggregate` (college-route.ts) | **router.ts:191-198** force-select | `plan.collegeAggregate` | 동상 |
| recency | `detectRecencyIntent` (recency.ts) | **wiki-agent.getContext**(per-wiki, LIVE) | `options.recency ?? plan.recency` | getContext `options`에 `recency?` 추가 |

**시그니처 변경**:
```ts
// router.ts — plan을 optional로(back-compat: 스크립트/테스트는 plan 없이 호출 가능)
export async function routeQuery(query, userRole, plan?: QueryPlan): Promise<RoutingResult>
//   - plan 있으면: getRoutableAgents(role, query, plan.collegeBreadth),
//                  line191 if(plan.collegeAggregate), getContext options.recency=plan.recency
//   - plan 없으면(shadow/스크립트): 기존 정규식 호출로 fallback (전환기 안전)
```
```ts
// wiki-agent.ts — getContext options 확장
getContext(query, role, isGlobal, options?: { ...; recency?: boolean })
//   recency = options.recency ?? detectRecencyIntent(query)  (전환기 fallback)
```
```ts
// route.ts — 진입부에서 plan 1회 계산 후 모든 소비처에 주입
const plan = await planQuery(message);          // 기존 routeToAgent 자리(추가 콜 0)
const mode = effectiveMode(plan.intent, role);  // 기존 로직
const budgetChars = process.env.CONTEXT_BUDGET_CHARS ? Number(...) : (plan.complexity==='complex'?BUDGET_COMPLEX:BUDGET_SIMPLE);
routing = await routeQuery(message, role, plan);
```

## 5. Shadow 메커니즘 (무비용 검증)

**원리**: planQuery는 라이브로 산출(기존 콜이라 비용 0). **전환기엔 실제 라우팅을 정규식으로** 유지(routeQuery에 plan 미주입 또는 플래그 OFF) + 양쪽 로깅.

```ts
// scripts/shadow-intent.ts (이행용, cutover 후 삭제)
//  - 실제 질의로그(messages role=user / Sheet)에서 질문 N건 로드
//  - 각 질문: planQuery(q) [Haiku]  vs  regexPlan(q) [현 정규식 합성]
//  - 필드별 일치율 집계 + 불일치 표본 출력(어느 쪽이 옳은지 수동 검수)
function regexPlan(q): QueryPlan {  // 현 정규식들을 합성한 baseline
  return { complexity: classifyComplexity(q)==='complex'?...,
           recency: detectRecencyIntent(q),
           collegeBreadth: detectGroupBreadth(q)['단과대']||['대학원'],
           collegeAggregate: detectGroupAggregate(q)['단과대']||['대학원'], ... };
}
```
> ⚠️ **비용**: 과거 로그를 배치로 Haiku 재실행 = N건 × ~$0.0006. 예: 200건 ≈ **$0.12**. **실행 전 비용 보고·승인 필수**(라이브 패시브 로깅은 무료지만 데이터 축적에 시간 소요 → 배치가 빠름). [[feedback_state_cost_before_running]] [[feedback_eval_real_questions_only]]

## 6. Cutover & 정규식 은퇴

shadow 일치율 임계 + governance/golden 통과 시:
1. route.ts/router.ts/wiki-agent가 **plan을 정식 소비**(정규식 fallback 분기 제거).
2. `complexity.ts`·`recency.ts`(detectRecencyIntent)·`college-route.ts`(detectGroupBreadth/Aggregate)의 **call-site 제거**. 함수 자체는 `regexPlan`(shadow)이 참조하므로 cutover 직전까지 유지 → shadow script 삭제와 함께 제거.
3. `isCollegeReferenced`(college-route.ts)는 **격리**(키워드 신호 아님) → **유지**.

> **점진 옵션**: 필드별 cutover 가능(complexity 먼저 → college → recency). 위험 분산.

## 7. 안전장치

- Haiku 실패 → `defaultPlan()`(전 필드 안전값). 한 필드 파싱실패 → 그 필드만 디폴트.
- 전환기 `routeQuery(plan?)` optional → 스크립트/테스트 무변경.
- governance: plan의 college/recency 신호는 거버넌스 답변에 사실상 무영향(단과대·시간성). complexity(예산)만 적용 → shadow로 일치 검증 후 cutover.

## 8. 테스트 계획

- **L1(무료)**: `scripts/shadow-intent.ts` 필드별 일치율(실질의로그). 불일치 표본 수동 검수.
- **L2(무료)**: `npm run test:governance` 19/19, tsc 0. (router.ts/route.ts 소스 패턴 검사 — breadth/aggregate 제거가 governance-regression 패턴 깨는지 확인 필요 → do 단계 점검.)
- **L3(소액)**: 골든QA 비회귀 + 회귀셋("AI대학원 구성?" 억측0, "각 단과대별 학과?" 집계 라우팅 유지) — Sonnet 생성 포함이라 비용 보고 후.

## 9. 리스크 & 완화

| R | 완화 |
|---|---|
| Haiku 의도 오분류 | shadow 사전검출(§5) + 안전디폴트 + temp=0 |
| 단일콜 책임확대 | 이미 임계경로. 필드별 robust 추출 + 4s timeout |
| 스키마확장 파싱취약 | 필드 개별 추출, 한 필드 실패가 전체 fallback 강제 안 함 |
| cutover 미세회귀 | shadow 불일치 검수 + 회귀셋 + 필드별 점진 cutover |
| governance-regression 패턴 의존 | do 단계서 router.ts 소스 패턴 검사 항목 사전 점검·갱신 |
| scope creep | tier·web·temporalBreadth 명시 제외(§10) |

## 10. Out of scope (명시)

- **tier(T1~4)·structured.ts**: 실작동·유용(DB 49피드/34팩트) → 불간섭. 별도 정리(plan §7.4).
- **`detectBreadthIntent`(temporalBreadth)**: 소비처 globalTopK = prod OFF(휴면) → 흡수 가치 0, 보류.
- web escalation, evaluator 배선, `isCollegeReferenced`(격리), fact/web 정책.

## 11. Implementation Guide

### 11.1 구현 순서
1. `agent-router.ts`: `QueryPlan`·`planQuery`·`defaultPlan` + 프롬프트 확장 + 필드별 추출.
2. `route.ts`: plan 1회 계산 → complexity 예산 교체 + routeQuery에 주입 + effective-mode는 plan.intent.
3. `router.ts`: `routeQuery(q,role,plan?)` — plan 소비(collegeBreadth/Aggregate) + 정규식 fallback 유지.
4. `wiki-agent.ts`: getContext `options.recency` 수용.
5. `scripts/shadow-intent.ts`: regexPlan + 필드별 일치율(실질의로그).
6. (후속 세션) cutover: 정규식 call-site 제거 + shadow script 삭제.

### 11.2 핵심 파일
- 수정: `lib/agents/agent-router.ts`, `lib/agents/router.ts`, `app/api/chat/route.ts`, `lib/agents/wiki-agent.ts`
- 신규: `scripts/shadow-intent.ts`
- 불변(은퇴 대상, cutover까지 유지): `complexity.ts`, `recency.ts`, `college-route.ts`(detectGroup*)

### 11.3 Session Guide (Module Map — `/pdca do --scope`)
| module | 범위 | 산출 | 비용 |
|---|---|---|---|
| **module-1** | agent-router.ts: QueryPlan+planQuery+defaultPlan+프롬프트 | 데이터 객체 산출(라이브 미배선) | $0(코드) |
| **module-2** | route.ts: plan 계산+complexity 예산+routeQuery 주입 | 예산 통합 | $0 |
| **module-3** | router.ts+wiki-agent: plan 소비(college/recency), optional fallback | 완전 통합(shadow모드) | $0 |
| **module-4** | scripts/shadow-intent.ts + 실질의로그 일치율 | 검증 리포트 | 배치 Haiku ~$0.1(승인후) |
| **module-5** | (후속) cutover: 정규식 제거 + shadow 삭제 | 덕지덕지 종료 | $0 |

**권장 세션 분할**: module-1+2+3(통합 배선, 무료) → governance/tsc 검증 → module-4(shadow 검증, 승인후) → module-5(cutover, 별 세션).
