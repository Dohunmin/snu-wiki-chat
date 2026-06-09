# Plan: Unified Intent Router — 흩어진 의도 분류기를 Haiku 쿼리플랜 1콜로 통합

> **Feature**: unified-intent-router (v1: complexity + recency + breadth/aggregate 흡수)
> **Date**: 2026-06-09
> **Phase**: Plan (ready for `/pdca design unified-intent-router`)
> **Related**: [context-spine](context-spine.plan.md)(전달 오염 제거), [smart-routing](smart-routing.plan.md), [[project_multi_agent_state]]

> ⚠️ **제약 (확정 결정 유지)**: ① `fact = 내부 KB 전용`(웹 미도달) 불변 — 본 통합은 *의도 분류*만 건드리고 fact/web 정책은 직교. ② 단과대 `wiki_id` 격리는 *정당한 설계*라 유지 — 흡수 대상은 키워드 **신호**(detectGroupBreadth/Aggregate 등)뿐, 격리 기계가 아님. ③ **새 LLM 콜 추가 없음** — 이미 매 질의에 도는 `routeToAgent`(Haiku)의 *출력 스키마만 확장*. ④ governance 19/19 + 골든QA 비회귀.

---

## Executive Summary

| 관점 | 내용 |
|---|---|
| **Problem** | "이 질문을 어떻게 처리할까"(의도) 판정이 **5개 파일에 하드코딩 한국어 키워드 리스트**로 흩어짐: `complexity.ts`(COMPLEX_MARKERS), `recency.ts`(RECENCY/BREADTH_KEYWORDS), `college-route.ts`(GROUP_BREADTH/AGGREGATE_SIGNALS, ~50% 상호중복). 새 질문이 틀릴 때마다 *어느 리스트에 단어를 추가*하는 구조 → **예외 case가 무한 증식**(2026-06-09 cross-college 픽스도 같은 패치였음). 같은 쿼리를 6~9개 분류기가 독립 분석 → 신호 모순·중복·"어디에 넣지?" 부채. |
| **Solution (v1)** | `agent-router.ts`의 단일 Haiku 콜이 `{agent}` 대신 **구조화된 쿼리플랜** `{intent, complexity, recency, breadth, aggregate, reason}`을 한 번에 출력 → 정규식 분류기 3종(complexity·recency·college breadth/aggregate)을 *의도의 단일 진실원*으로 대체. **이행은 shadow**: 정규식과 병행 실행·로깅 → 실제 질의로그로 일치율 검증 → cutover. **실패 fallback = 안전 디폴트 통일**(insight + complex예산 + 보수신호 → 정규식 call-site 완전 제거). |
| **Function UX Effect** | 라우팅 정확도 = 키워드 매칭 → *의도 이해*(LLM)로 상향(특히 신조어·우회표현·복합의도). 사용자 체감 비용·지연 **불변**(동일 Haiku 콜, 출력 +~70토큰 ≈ +$0.0002/q). 유지보수: 새 질문유형 = 리스트에 단어 추가(끝없음) → **프롬프트 1곳**(또는 무수정 — LLM이 일반화). |
| **Core Value** | 네가 반복 지적한 *"문제마다 case 덧대면 한도 끝도 없다"*는 부채를 **유일하게 종료**하는 구조 전환. 비용 ≈ 0(기존 콜 재사용), governance 안전(shadow). tier(T3/T4 직답 — 실작동·유용)는 **건드리지 않음**. |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 2026-06-09 뼈대 감사: 의도 분류가 5파일 하드코딩 키워드로 분산 + ~50% 신호 중복(breadth vs aggregate). 질문유형마다 리스트 추가 = 반응형 패치 트레드밀. 근본원인 = "정규식+하드코딩 리스트" 기반이라 case-by-case 외 확장 불가. |
| **WHO** | 전 사용자(라우팅 정확도↑) + 운영/유지보수(분류 로직 단일화 → 부채·실수↓). 비용 부담자(질의당 비용 불변 — 기존 콜 재사용). |
| **RISK** | (R1) Haiku 의도 오분류 → 라우팅 악화. (R2) 단일 Haiku 콜이 더 많은 결정의 SPOF(이미 임계경로지만 책임 확대). (R3) 출력 스키마 확장으로 파싱 취약성↑(reason 잘림 등). (R4) cutover 시 정규식 제거가 미세 회귀(특정 질문서 예전 동작 상실). (R5) scope creep — tier·web·fact정책으로 번짐. |
| **SUCCESS** | (1) 단일 콜이 5필드 플랜 출력, 추가 LLM 콜 0. (2) shadow 일치율: 실제 질의로그 N건서 Haiku플랜 vs 정규식 필드별 일치율 측정·임계 충족. (3) governance 19/19 + 골든QA 비회귀. (4) cutover 후 정규식 분류기 call-site 제거(코드↓). (5) 과거 회귀셋(AI대학원 억측·cross-college 집계) 무회귀. (6) 질의당 비용 불변(+output 토큰만). |
| **SCOPE** | **수정**: `lib/agents/agent-router.ts`(쿼리플랜 스키마+프롬프트+robust 추출), `router.ts`/`route.ts`(플랜 소비 — complexity·recency·breadth/aggregate 호출부 교체). **신규**: `scripts/shadow-intent.ts`(무료/저비용 shadow 비교 — 실제 질의로그). **은퇴(cutover 후)**: `complexity.ts`·`recency.ts`·`college-route.ts`의 키워드 리스트 call-site. **비스코프**: tier(T3/T4)·structured.ts, web escalation, fact/web 정책, evaluator 배선, 단과대 wiki_id 격리(`isCollegeReferenced`는 *격리*라 유지 검토). |

---

## 1. 배경 — 무엇이 부채인가 (2026-06-09 감사)

질문 1건이 들어오면 **독립적으로** 의도를 보는 분류기:

| 파일 | 하드코딩 신호 | 결정 | 부채 |
|---|---|---|---|
| `agent-router.ts` | (LLM 프롬프트) | fact/insight | ✅ **이미 LLM** — 통합의 씨앗 |
| `complexity.ts` | `COMPLEX_MARKERS`(정규식 20+패턴) | 예산 16k/40k | 질문마다 패턴 추가 |
| `recency.ts` | `RECENCY_KEYWORDS`, `BREADTH_KEYWORDS` | 최신 소스 주입 | TIME 신호가 tier T4와도 중복 |
| `college-route.ts` | `GROUP_BREADTH_SIGNALS` | 단과대 admit | aggregate와 ~50% 겹침 |
| `college-route.ts` | `GROUP_AGGREGATE_SIGNALS` | 단과대 force-select | breadth와 ~50% 겹침, "어디 넣지?" 모호 |

**핵심 문제**: 같은 "한국어 키워드 매칭으로 의도 판정"이 5곳 중복 → 신호 추가 시 분기 판단 필요 → 누적·중복·누락. 정규식 기반이라 *근본적으로 case-by-case 대응만 가능*.

> 이미 `agent-router.ts`가 정확히 우리가 원하는 패턴(Haiku 1콜, temp=0, 4s timeout, robust `extractAgent`, harm-asymmetric fallback)으로 작동 중. v1은 **새 구조가 아니라 이 콜의 출력 확장**.

## 2. 목표 & 범위

### In scope (v1)
- `routeToAgent` → `planQuery`로 확장: 단일 Haiku 콜이 **쿼리플랜** 출력.
- 흡수 분류기 **3종**: complexity, recency, college breadth/aggregate.
- Shadow 이행 + 안전디폴트 fallback.

### Out of scope (명시적 — scope creep 차단)
- **tier(T1~4)·structured.ts**: T3/T4는 *실작동·유용*(DB 실측: 49 게시판 피드 daily fresh, 34 structured_facts). 저비용 직답 게이트라 흔들지 않음. → **별도 소규모 정리**(§7.4)로 분리.
- web escalation, fact/web 정책, evaluator 배선, `isCollegeReferenced`(격리 — 키워드 신호 아님).

### 쿼리플랜 스키마 (sketch — 상세는 design)
```ts
interface QueryPlan {
  intent: 'fact' | 'insight';      // 기존
  complexity: 'simple' | 'complex'; // → 예산 16k/40k
  recency: boolean;                 // → 최신 source 주입
  breadth: boolean;                 // → 단과대/대학원 그룹 admit
  aggregate: boolean;               // → 단과대 그룹 force-select
  reason: string;                   // ≤30자
}
// fallback(실패 시 안전 디폴트, harm-asymmetric 과잉서빙):
//   { intent:'insight', complexity:'complex', recency:false, breadth:false, aggregate:false }
```

## 3. 요구사항

**FR**
- FR1: 단일 Haiku 콜이 QueryPlan 전 필드를 1회 출력(추가 콜 0).
- FR2: 응답 파싱은 필드별 robust 추출(reason 잘림에도 핵심 필드 복원 — 기존 `extractAgent` 패턴 일반화).
- FR3: `router.ts`/`route.ts`가 플랜을 소비 — 기존 `classifyComplexity`/`detectRecencyIntent`/`detectGroupBreadth`/`detectGroupAggregate` 호출부를 플랜 필드로 교체.
- FR4: Shadow 모드 — 라이브 라우팅은 *정규식*으로 하되 플랜을 병행 산출·로깅(무비용, 기존 콜 재사용). 비교 후 플래그로 cutover.
- FR5: 실패 시 안전 디폴트로 통일, cutover 후 정규식 call-site 제거.

**NFR**
- NFR1(비용): 질의당 LLM 콜 수 불변. 출력 토큰 +~70(≈+$0.0002/q). 새 비용원 0.
- NFR2(지연): 동일 임계경로 콜 → 체감 지연 불변.
- NFR3(안전): governance 19/19 + 골든QA 비회귀가 cutover 게이트.
- NFR4(관측): shadow 일치율·불일치 샘플 로깅.

## 4. 설계 방향 (design에서 확정)

1. **확장**: `agent-router.ts`에 `planQuery(query): Promise<QueryPlan & {via}>`. 프롬프트는 기존 fact/insight 룰 + 4필드 정의를 1프롬프트로(예시 포함, temp=0, max_tokens 상향 ~160).
2. **소비**: `route.ts`가 `planQuery` 1회 호출 → `routing`/`budget`/`recency`/`college` 분기에 필드 주입. `router.ts`는 플랜을 인자로 받도록 시그니처 확장(혹은 route.ts가 결과를 router에 전달).
3. **Shadow**(§7.1): 플랜 산출은 라이브로 ON, *소비는 정규식 유지* + 양쪽 로깅. `scripts/shadow-intent.ts`가 실제 질의로그(messages role=user / Sheet)서 필드별 일치율 집계.
4. **Cutover**: 일치율 임계 + governance/golden 통과 시 소비를 플랜으로 전환, 정규식 call-site 제거(안전디폴트만 잔존).

## 5. Success Criteria (측정 가능)

- SC1: `planQuery`가 5필드 플랜 출력, 질의당 추가 LLM 콜 = 0 (코드/로그 확인).
- SC2: shadow 일치율 — 실제 질의로그 N(≥150)건서 complexity/recency/breadth/aggregate 각 필드 Haiku vs 정규식 **일치율 리포트**(불일치는 어느 쪽이 옳은지 표본 검수). 임계는 design서 확정(예: 의미적 동등 포함 ≥85%, 불일치 표본의 다수가 Haiku 우세).
- SC3: governance-regression 19/19, 골든QA 비회귀.
- SC4: cutover 후 `complexity.ts`/`recency.ts`/`college-route.ts` 키워드 분류기 call-site 제거 — 순 코드 라인 감소.
- SC5: 회귀셋 무회귀 — "서울대 AI대학원 구성?"(억측 0), "각 단과대별 학과?"(집계 라우팅 유지).
- SC6: 질의당 비용 = 기존 + output 토큰 증분만(diagnose-cost로 확인).

## 6. 리스크 & 완화

| R | 리스크 | 완화 |
|---|---|---|
| R1 | Haiku 의도 오분류 → 라우팅 악화 | **Shadow 사전검출**(SC2) + 안전디폴트(과잉서빙=무해) + temp=0 |
| R2 | 단일 콜 SPOF 책임 확대 | 이미 임계경로 콜. fallback이 전 필드 안전값 보장. timeout 4s 유지 |
| R3 | 스키마 확장 → 파싱 취약 | 필드별 독립 robust 추출(FR2). 한 필드 실패가 전체 fallback 강제 안 함 |
| R4 | cutover 미세 회귀 | shadow 불일치 표본 검수 + 회귀셋(SC5) + 단계적(필드별 cutover 가능) |
| R5 | scope creep(tier/web/fact) | §2 Out of scope 명시. tier는 §7.4 별건 |
| R6 | Haiku 수치 불안정(과거 finance) | 해당은 *생성* 이슈. 분류(범주 출력)는 견고. 본 콜은 분류만 |

## 7. 단계 계획

- **7.1 Shadow 배선** — `planQuery` 라이브 산출 + 정규식 병행 + 양쪽 로깅(라우팅은 정규식). 무비용(기존 콜 재사용).
- **7.2 Shadow 측정** — `scripts/shadow-intent.ts`로 실제 질의로그 필드별 일치율. *(주의: 과거 로그를 배치로 Haiku 재실행하면 N건 × Haiku ≈ 소액 과금 → 비용 보고·승인 후. 라이브 패시브 로깅은 무료.)*
- **7.3 Cutover** — 임계 충족 + governance/golden 통과 → 소비를 플랜으로, 정규식 call-site 제거.
- **7.4 (별건) tier 정리** — 본 플랜 밖. ① content tier ↔ role tier 용어 분리(예: `AnswerLane`) ② 죽은 T1/T2 구분 제거(→ structured/board/normal 3-way) ③ stale 피드(gsct/gspa) 점검. *별도 plan 또는 소규모 PR.*

## 8. 미해결/확정 필요 (design 입력)
- shadow 일치율 임계 수치 + 불일치 판정 기준(의미적 동등 처리).
- 필드별 점진 cutover vs 일괄 cutover.
- `planQuery` 프롬프트 길이 ↔ 정확도 트레이드오프(예시 몇 개).
- router.ts 시그니처: 플랜을 인자로 받을지 vs route.ts가 분해해 전달할지.
