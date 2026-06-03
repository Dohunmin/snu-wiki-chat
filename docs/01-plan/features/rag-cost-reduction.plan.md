# Plan: RAG 비용 절감 — 품질 유지하며 질문당 $0.40 낮추기

> **Feature**: rag-cost-reduction
> **Date**: 2026-06-03
> **Phase**: Plan (ready for `/pdca design rag-cost-reduction`)
> **✅ 확정 결정 (2026-06-03)**: **전역 top-K 구조전환을 college-grad-wiki Phase 1보다 먼저** 수행 (§0 스케일링 논거). college는 정리된 검색 코어 위에 additive로 올라간다.
> **Related**: [retrieval-confidence-gate](retrieval-confidence-gate.plan.md), [hybrid-rag](hybrid-rag.plan.md), B-2 신뢰도 가중분배(router.ts)
> **근거**: 멀티에이전트 분석(코드해부 + 실제 RAG기법 + 플랫폼레버 + 품질검증) → 옵션 12개 적대적 검증(verify) → 합성. 검증이 **모든 단일 옵션의 절감 주장을 코드에 비춰 정정**함(아래 §3 표).

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | 질문당 $0.40 중 **95%($0.39)가 입력 컨텍스트**(약 13만 토큰). 그 **약 70%가 질문과 무관한 위키**에서 옴(예산 질문인데 평의원회 38k자·이사회 35k자·70년역사 24k자, 정작 재무공시는 15%뿐). |
| **Root Cause** | (A) **구조적 주범** = "위키 선택 → 위키별 통째 덤프" 아키텍처. Voyage+pgvector+RRF가 **이미 구축됐으나** 라우팅 후보 산정 + 위키 *내부* 청크 보강에만 쓰이고, **'전 코퍼스 청크 단위 top-K'로는 안 쓰임**. (B) **cap 우회 누수** = entity 블록 raw 부착·recency 전체본문 주입·CHUNK_CHAR_CAP=3000이 예산을 우회해 추가로 부풀림. |
| **Solution** | 4단계 점진: **(0)** 검증 인프라 배선(무비용) → **(1)** 무위험 위생·계측(캐싱·max_tokens 가드·entity cap) → **(2)** 유사도 cutoff 컷(저위험) → **(3)** 전 코퍼스 전역 top-K + rerank(구조 전환, shadow 선행). |
| **정직한 기대치** | Phase 0~2만: **~$0.26~0.31**(저-중 위험). Phase 3까지: **~$0.18~0.24**(고위험 리팩터). **73~80% 같은 극단 절감은 도달 불가** — entity/recency/protected slot/Tier0 경로를 보존하는 한 현실 천장은 **~55% 절감**. |
| **⚠️ 스케일링 재프레이밍 (2026-06-03)** | [college-grad-wiki](college-grad-wiki.plan.md) 검토 결과 **결론 전환**: 위 절감폭은 *현재 9위키 기준*이고, 진짜 쟁점은 **성장 궤적**이다. 현 코퍼스는 전체 계획(15+단과대·학부대학·일반대학원·11전문대학원)의 **10% 미만**. **위키 통째 덤프 구조는 코퍼스 성장에 비용↑·정밀도↓로 스케일되지 않고, 전역 top-K는 코퍼스 크기에 불변**이다. 따라서 Phase 3(global top-K)는 '선택적 고위험'이 아니라 **성장 전 반드시 깔아야 할 필연**이다(§0). |
| **Core Value** | 닫힌 권위 코퍼스(거버넌스)라 **품질(정확도)이 절대선**. 모든 단계가 golden-qa(무비용 회귀) + 실제 gold 질문 eval(answerable→partial 후퇴 0)을 게이트로 통과해야만 머지 → 과신·사실오류·교차확인 붕괴를 차단하며 비용만 줄임. |

---

## 0. 왜 "지금" 구조전환을 해야 하나 — 스케일링 논거 (2026-06-03 추가, college-grad-wiki 반영)

> 처음 플랜은 Phase 3(전역 top-K)를 "절감 최대지만 고위험이라 선택적"으로 뒀다. **[college-grad-wiki](college-grad-wiki.plan.md)를 읽고 결론을 바꾼다**: 시스템의 성장 궤적을 고려하면 Phase 3는 **선택이 아니라 필연**이다.

### 0.1 비용 스케일링 법칙
- **위키 통째 덤프(현재)**: 라우터가 위키를 고르고 각 위키의 `chunkCap`을 덤프한다. 코퍼스가 커지면 (a)위키·콘텐츠가 늘어 무관 위키 혼입(forced/semantic-hint)이 증가하고, (b)**cap을 우회하는 entity 블록·recency 전체본문 주입이 콘텐츠와 함께 부풀고**, (c)라우팅 정밀도가 떨어진다 → **비용은 오르고 품질은 내린다.** 지금 9위키(전체의 <10%)에서 이미 $0.40인데, 이 구조로는 코퍼스가 무거워질수록 더 나빠진다.
- **전역 top-K(목표)**: 질문 임베딩으로 전 코퍼스에서 가장 가까운 K청크만 뽑는다. **위키가 9개든 90개든 K는 그대로** — 무관 위키 청크는 애초에 top-K 경쟁에서 탈락한다. → **질문당 비용이 코퍼스 크기에 거의 불변.** 닫힌 권위 코퍼스가 커질수록 이 불변성의 가치가 기하급수로 커진다.

### 0.2 college-grad-wiki와의 관계 — 충돌 아닌 상호보완
- college-grad-wiki는 이미 **올바른 철학**을 채택했다(§1.1 "wiki 전체 컨텍스트 주입이 문제 → RAG 청크검색으로 해소", 4-Tier로 휘발성·구조화 데이터를 임베딩에서 분리).
- **T3(구조화 캐시, LLM 스킵, 1레코드)·T4(라이브 페치)는 임베딩 컨텍스트를 아예 우회**하는 훌륭한 직교 전략 — 전역 top-K와 **상호보완**(겹치지 않음). 전역 top-K는 그 플랜이 손대지 않는 **T1/T2 임베딩 경로의 빠진 조각**이다.
- college의 **`college`/`tier` 메타데이터 필터(§6.3)는 전역 top-K의 `WHERE` 술어로 자연 합성**된다: `searchVectorGlobal(query, role, k)` + `AND (college=$c OR NULL)` = **메타데이터 필터드 전역검색** = 표준 production RAG. 즉 두 플랜은 같은 종착지를 가리킨다.

### 0.3 타이밍 — 코퍼스가 커지기 "전"에
1. **지금이 검증 가능**: 9위키 골든셋이 있어 전역 전환의 회귀를 측정할 수 있다. 26개 조직이 올라온 뒤엔 골든셋 구축·검증이 훨씬 비싸다.
2. **미루면 부채 누적**: 구식 아키텍처 위에 위키를 추가할수록 over-retrieval이 악화되고 이관 난이도가 커진다.
3. **college rollout이 검색 코어 위에 올라탄다**: college Phase 1 전에 검색 코어를 전역 top-K로 정리하면, 이후 26개 조직이 **처음부터 올바른(스케일되는) 아키텍처** 위에 쌓인다.

### 0.4 ⚠️ 두 플랜 조정 필요
- college-grad-wiki **SC-10("college 쿼리가 기존 chunk-budget 준수")**과 **per-wiki `searchVector(WHERE wiki_id)` 가정**은 전역 top-K + 메타필터 모델로 **갱신**돼야 한다. 지금 두 플랜을 **공동 설계**하는 게, college를 구식 위에 깔고 나중에 retrofit하는 것보다 훨씬 싸다.
- 단 college의 git-diff=0/additive 원칙과 전역 top-K(검색 코어 변경)는 긴장이 있다 — **전역 top-K를 college rollout보다 먼저 끝내면** college는 변경된 코어 위에 additive로 올라가 충돌이 없다(순서가 관건).

### 0.5 갱신된 결론 (✅ 2026-06-03 확정)
Phase 0~2는 여전히 **올바른 선행 순서**(디리스크 + 계측 + 빠른 위생)지만, **종착지는 Phase 3(전역 top-K + 메타필터)로 확정**한다 — 그것만이 성장하는 코퍼스에서 비용을 일정하게 유지하는 유일한 아키텍처다.

**사용자 확정**: **college-grad-wiki Phase 1 착수 전에 전역 top-K 완료.** → 실행 순서 = `Phase 0(검증 인프라) → Phase 1(무위험 위생·계측, 병행 가능) → Phase 2(유사도 cutoff) → Phase 3(전역 top-K + 메타필터)` 를 college rollout보다 **앞에** 둔다. college-grad-wiki는 전역 top-K가 머지된 검색 코어 위에 `college`/`tier` 메타필터를 `WHERE` 술어로 합성해 올라간다(§0.2). college-grad-wiki **SC-10·per-wiki searchVector 가정은 이 전환에 맞춰 갱신** 필요.

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 사용자가 "질문당 ~$0.5는 너무 비싸다, 품질은 유지하며 토큰을 줄여라"고 요구. diagnose-cost.ts로 실측: 입력 130,059 토큰 = $0.39(전체의 95%), 출력·표교정 retry는 미미. diagnose-context.ts로 분해: 138k자/266청크/위키 8개, 무관 위키가 ~70%. |
| **WHO** | 전체 사용자(동일 품질에 빠르고 싼 답변) + 운영자(API 비용). |
| **RISK** | (R1) 컨텍스트 축소 → 닫힌 권위 코퍼스에서 **사실 누락/교차확인(P4) 붕괴**. (R2) 키워드로만 잡히는 희귀 고유명사(회차ID·인명)가 전역 경쟁에서 탈락. (R3) **"키워드는 살아있되 교차근거·정형데이터만 사라지는" silent regression** — 게이트 사각지대. (R4) 베이스라인 수치(266청크)가 현 budget=22 코드와 어긋날 수 있어 재측정 필요. |
| **SUCCESS** | (1) 질문당 비용 측정치 하락. (2) golden-qa 회귀 0. (3) 실제 gold(구글시트 상위50% 길이) eval에서 answerable→partial/internal-gap **후퇴 0건**. (4) 교차근거 위키 분포 비후퇴(편향 미도입). (5) fact/stance 정형데이터 누락 0 + 인용 [N] 집합 누락 0. |
| **SCOPE** | **수정**: `lib/agents/router.ts`, `lib/agents/wiki-agent.ts`, `lib/embed/{search,rrf,voyage}.ts`, `lib/llm/{prompts,client}.ts`, `app/api/chat/route.ts`. **신규**: `searchVectorGlobal`, `rerankDocuments`, golden-qa 확장, eval-gold 비교모드. **비스코프**: LLMLingua류 컨텍스트 압축(요약 왜곡=사실오류 위험), 채팅 외 batch API 전환(ROI≈0 — drop), adaptive-K 단독 채택(좁음 오분류 위험으로 보류). |

---

## 1. Root Cause — 두 층위 (검증 확정)

### (A) 구조적 주범: 위키 통째 덤프
- `router.ts`가 `MAX_WIKIS=6` + `forcedWikis`(semanticRoutingHints ∪ concept-index, **cap 우회**) + `status`(alwaysContext)로 6~8개 위키 선택.
- 각 위키의 `getContext`가 `TOTAL_CHUNK_BUDGET=22`를 softmax 가중분배한 `chunkCap`만큼 청크를 **덤프**.
- `lib/embed`의 pgvector+RRF는 **이미 있으나** (a)라우팅 후보 산정, (b)선택된 위키 *내부* 청크 보강에만 쓰이고 **'전 코퍼스 청크 top-K'로는 안 쓰임** → `senate.json 482KB`, `board.json 286KB`가 통째로 후보가 됨.
- **검증 정정**: 단일 상수 조정(`MAX_WIKIS↓`, `RELATIVE_THRESHOLD↑`)은 **forcedWikis가 cap을 우회하므로 베이스라인 질문에 거의 무력**. (A)를 안 건드리면 어떤 마이크로 최적화도 **10~20% 천장**에 막힌다.

### (B) cap 우회 누수 — 3경로
1. **entity 블록**(`wiki-agent.ts:437-442`): `entity.content`를 `cap()` 없이 raw로 컨텍스트 최상단 부착. board entity는 다중 매칭 시 수만 자. **현재 유일하게 char cap 면제**.
2. **recency 주입**(`wiki-agent.ts:416-433`): `source.content` 전체를 `score=999`로 unshift(최대 3000자×5개=15k자).
3. **CHUNK_CHAR_CAP=3000**: 긴 회의록 본문을 부풀림.

> ⚠️ **베이스라인 재측정 필요**: 검증이 "266청크/13만토큰이 budget=22와 모순될 수 있다(budget 30→22 인하 전 측정이거나 cap 적용 전 청크를 셌을 가능성)"고 지적. Phase 3 전 `scripts/measure-context-size.ts`로 현 코드 기준선 확정 — 이게 틀리면 "후퇴 0" 판정 자체가 무의미.

---

## 2. 실제 production RAG는 어떻게 작동하나 (방향의 근거)

표준 파이프라인은 **retrieval과 generation을 분리**하고, 컨텍스트를 **문서(위키) 단위가 아니라 청크 단위 전역 경쟁**으로 고른다:

1. 질문을 임베딩 → **전체 코퍼스 통합**에서 ANN으로 후보 top-K(보통 50~150 청크).
2. BM25/키워드 결과를 **RRF로 융합** → 희귀 고유명사·정확매칭 recall 보강.
3. **cross-encoder reranker**로 (질문, 청크) 정밀 재채점 → 최종 소수(15~25 청크 또는 relevance 임계 이상)만 LLM에.

핵심: **"어느 문서가 관련 있나"를 골라 통째로 넣는 게 아니라, "어느 청크가 관련 있나"를 전역에서 직접 고른다.** 그러면 무관 문서 청크는 애초에 경쟁에서 탈락 → 컨텍스트가 자연히 작아진다.

**snu-wiki-chat은 이 파이프라인의 부품(Voyage 임베딩·pgvector HNSW·RRF)을 이미 갖췄지만, '위키 먼저 고르고 위키별 덤프'하는 구식 구조라 부품을 절반만 쓰고 있다.** → "전체를 임베딩화/RAG화"라는 사용자 직감이 정확하다. 단, 닫힌 권위 코퍼스에선 전역 top-K가 큐레이션 보장 페이지(concept-index)·최신성(recency)·정형 데이터(fact/stance)를 떨어뜨릴 수 있어, 이들을 **protected slot**으로 경쟁 밖에 강제 포함하고 reranker도 면제하는 가드를 함께 둔다.

---

## 3. 옵션 적대적 검증 결과 — 절감 주장 정정 (핵심)

> 회의적 시니어 엔지니어 에이전트가 각 옵션을 **실제 코드에 비춰** 검증. **거의 모든 비용 주장이 과장**으로 판명.

| 옵션 | 주장 절감 | **검증 정정** | 판정 | 핵심 지적 |
|---|---|---|---|---|
| **global-topk** (전역 top-K) | 73~80% | **40~55%** | revise(고위험) | entity/recency/Tier0가 그대로 남음. budget=22로 일부는 이미 회수. leesj 전역 노출 보안 가드 누락. getContext 절반을 router로 이식하는 셈. |
| **sim-cutoff-drop** (유사도 컷) | 40~55% | **20~35%** | revise | `similarity` 전파 배선 **3곳 누락 시 전량 작동불능**. RRF가 키워드 원점수를 덮어써 '강매칭 면제' 무력. 단일 전역 임계 금지. |
| **router-tighten** (상수 조정) | 30~45% | **10~20%** | revise | `MAX_WIKIS 6→4`는 forced 위키가 우회해 **거의 무력**. confidence 0.3→0.4는 이진값이라 **무효과**. 실효 레버는 tightMax뿐인데 동의어 recall 안전장치라 위험. |
| **chunk-char-cap** (3000→1800) | 10~20% | **3~6%** | revise | 전 코퍼스 854청크 중 (1800,3000] 구간 25개뿐. **재무 fact 표가 뒤쪽이라 절단=치명**. recency 청크도 절단 회귀. |
| **entity-recency-cap** | 3~6% | **2~4%** | revise | cap()은 사실상 no-op(entity 1개만 초과, recency는 출력단에서 이미 cap). 실효는 'entity 수 상한'뿐. '현재' 키워드 제거는 recall 손상. |
| **adaptive-k** (질문폭 가변) | 30~50% | **5~15%** | revise(보류) | 이 코퍼스 실제 질문이 '긴 다문장 교차위키'라 **좁음 오분류 위험 큼**. budget만 낮추면 cap floor에 막혀 거의 무효. |
| **prompt-cache** (캐싱) | 5~12% | **1~3%** | revise | 비용 95%는 system(1.2k토큰)이 아니라 본문(130k). 저트래픽이라 5분 TTL 적중 저조. **본문 over-retrieval을 못 건드림**. |
| **voyage-rerank** | 60~75% | **0~15%**(단독) | revise | 60~75%는 **전적으로 global-topk에 의존**. 위키별 단일 풀엔 효용 낮음. |
| **metadata-prefilter** | 10~25% | **0~3%** | revise | 청크 '순서'만 바꾸고 '개수'는 그대로라 토큰 불변. date hard filter가 fact/stance(date 없음) 전부 탈락. |
| **haiku-oldformat-retry** | 발생시 73% | 평균 3~4% | revise(≈drop) | retry가 **형식변환이 아니라 답변 전체 재생성** → silent regression. M-11 정규식 오탐으로 정상답변도 재작성 위험. |
| **max-tokens-cap** (16k→10k) | ~0 | **~$0**(정직) | revise | 미사용분 미청구라 평균 0. 단 **무음 절단** 위험(stop_reason 미검사). runaway 안전장치일 뿐. |
| **batch-noncritical** | 운영비 50% | **무의미** | **drop** | 채팅 비용 0% 영향. 대상 작업 절대비용이 회당 $0.1~수달러라 절감 무의미. golden-qa는 LLM 0건이라 대상조차 없음. |

**결론**: 진짜 큰 절감은 **global-topk(구조 전환)에서만** 나오고, 나머지는 그걸 **안전하게 만드는 선행/보조 작업**이다.

---

## 4. 실행 플랜 — 4단계 점진 롤아웃

### Phase 0 — 검증 인프라 배선 (모든 절감의 전제, 무비용)
> 비용 변경이 품질을 떨어뜨리는지 **자동으로 잡는 게이트를 먼저** 만든다. 없으면 silent regression 검출 불가.

| 변경 | 파일 |
|---|---|
| golden-qa를 finance 단독 15문항 → **9개 위키 확장**. gold-questions.json 64개에서만 mustInclude 키워드 추출(**임의 질문 생성 금지**). regression 1건도 `exit(1)`(무비용 CI 게이트). | `scripts/golden-qa.ts` |
| **비교 모드 추가**(`--baseline`): baseline 스냅샷 vs 변경후 두 번 실행해 answerable→partial/internal-gap **후퇴 건수 자동 집계**, >0이면 exit 1. Haiku 1회/질문, 답변 생성 없음(64문항 ~$0.3). | `scripts/eval-gold.ts` |
| **'교차근거 위키 분포' 측정** 추가 — routedWikis·인용 위키 수를 baseline 대비 diff. 다중위키 질문에서 P4 붕괴 검출(게이트 사각지대). | `scripts/eval-gold.ts` |
| 스트림 루프(206-222)에 `message_delta.stop_reason` 캡처 + `usage`(input/output/cache 토큰) 로깅. `finalMessage()`로 획득. | `app/api/chat/route.ts` |

- **절감**: $0 (안전 게이트 + 계측 인프라). **이 단계 없이 절감 진행 금지.**
- **검증**: 확장 golden-qa가 현 코드에서 전부 PASS(베이스라인 그린) + eval-gold baseline 스냅샷 생성.
- **롤백**: 테스트 스크립트라 되돌릴 것 없음. route.ts 로깅 1줄 제거.

### Phase 1 — 무위험 위생 + 계측 (품질 영향 0)
> 출력을 안 바꾸면서 안전장치를 켜고, 캐싱 적중률을 실측해 Phase 3 의사결정 데이터를 모은다. **정직한 기대: 평균 1~4%.**

| 변경 | 파일 |
|---|---|
| **prompt caching**: 가변 꼬리(`agentList`·tier2 경고)를 system '맨 끝'으로 분리(비-tier2 프리픽스 공유) + `cache_control:ephemeral` 배열. 단발 본문 캐싱은 `isContinuation=true`일 때만(write 1.25배 손해 방지). table-fix는 제외. | `lib/llm/prompts.ts`, `app/api/chat/route.ts` |
| **max_tokens 16000→12000** runaway 가드(평균 비용 ~$0, Phase 0 stop_reason 로깅으로 절단 감지됨). 8000 금지(망라형+P5 한계마커 절단 위험). | `lib/llm/client.ts` |
| **entity 블록 cap + 수 상한**: `cap()` 적용 + 매칭강도(정확>alias>부분) 정렬 후 **top-3**. 임의 2개 컷 금지. 매칭 단어 길이 가드(≥3자)로 과발동 차단. | `lib/agents/wiki-agent.ts:437-442` |

- **절감**: 평균 1~4%. **핵심 산출은 절감액이 아니라 캐시 적중률 실측 데이터.**
- **검증**: golden-qa 출력 동일성(특히 **lens 모드·tier2 경고** — agentList 이동이 buildLensSystemPrompt 건드림). entity cap 후 인물·기구 gold verdict 후퇴 0.
- **롤백**: 각 독립이라 부분 롤백 가능.

### Phase 2 — 유사도 cutoff 컷 (저위험, 배선 의존성 있음)
> 무관 경계 위키·저유사도 꼬리 청크 drop. **검증 정정: 단독 20~35%**(40~55%는 Phase 3까지 가야). **그냥은 작동 안 함 — `similarity` 전파 배선 3곳이 선행돼야 함.**

| 변경 | 파일 |
|---|---|
| `FusedChunk`에 `similarity?` 추가. **both 케이스(94-101)에서도** `vectorIndex`의 similarity 병합(검증 핵심 지적). + 키워드 **원점수 보존**(`kwScore`) — RRF가 score를 덮어쓰므로 '강매칭 면제'를 원점수로 판정. | `lib/embed/rrf.ts` |
| RRF 재분리 블록(312-339)에 `similarity`·`kwScore` **명시 전파** — 없으면 필터에 도달 못 해 **전량 작동불능**. | `lib/agents/wiki-agent.ts` |
| chunkCap slice 직전(399): similarity 임계 미달 drop. 면제 = `guaranteedIds.has(id)` ‖ `score===999`(recency) ‖ `kwScore≥강매칭`. **단일 전역 임계 금지** — 위키별 상대임계 또는 dist 기준 통일(sweep 전 하드코딩 금지). | `lib/agents/wiki-agent.ts` |
| 선택단계(152-160): `semanticDist>SIM_CUT_WIKI && score<MIN_ABSOLUTE_SCORE`인 위키 제외. alwaysContext·concept forcedWikis 면제. fallback(177)을 `slice(0,MAX_WIKIS)` → 'MIN_ABSOLUTE_SCORE 통과분만'으로. | `lib/agents/router.ts` |

- **절감**: 20~35%($0.40 → $0.26~0.32). recency/entity는 이 필터로 못 줄임(Phase 1에서 entity 처리).
- **검증**: 임계 sweep + golden-qa 회수율 후퇴 0 + eval-gold answerable→partial 후퇴 0 + **교차근거 위키 분포 비후퇴**. 1건이라도 후퇴 시 완화.
- **롤백**: `SIM_CUT_ENABLED` 환경변수 플래그로 즉시 off.

### Phase 3 — 구조 전환: 전역 top-K + reranker (최대 레버, shadow 선행 필수)
> 근본원인 (A) 제거. **가장 침습적** — shadow 모드 품질 검증 후에만 단계 롤아웃.

| 변경 | 파일 |
|---|---|
| **전제**: `measure-context-size.ts`로 현 코드 베이스라인 **재측정**(266청크가 budget=22와 모순될 수 있음). | (측정) |
| `searchVectorGlobal(query, role, k)` 신규 — `searchVector` 복제 후 **WHERE wiki_id 제거**(sensitive 필터 유지). ★**보안 필수**: lensPersona/adminOnly(leesj) 제외 SQL 가드(전역은 비admin 누출 위험). `VectorSearchResult`에 wikiId + id 파싱. | `lib/embed/search.ts` |
| 키 포맷 `type:id` → `wikiId:type:id`(위키 간 동명 페이지 충돌 방지). | `lib/embed/rrf.ts` |
| `rerankDocuments(query, docs, topN)` 신규 — Voyage rerank-2.5(키/재시도 재사용). 실패 시 throw→fallback. | `lib/embed/voyage.ts` |
| 위키별 getContext 루프를 '전역 top-K + 키워드 RRF 융합 → rerank → AgentContext[] 재조립'으로 대체. ★**protected slot**: guaranteedPageIds·recency·fact/stance를 경쟁 밖 강제 union(reranker도 면제). buildNumberedContexts 헤더 정규식·citation 위생화 호환 재현. | `lib/agents/router.ts` |
| Tier0 globalKeyword 경로(114-121)는 전역으로 대체 않거나 별도 처리(의도적 full coverage). | `lib/agents/router.ts` |

- **절감**: 40~55%($0.40 → $0.18~0.24, 검증 정정치). **73~80%는 과장** — protected union·Tier0 경로 보존 시 도달 불가.
- **검증**: **shadow 모드 필수** — searchVectorGlobal 추가하되 실답변 미적용, eval-gold 평가자에만 전역 컨텍스트 통과시켜 현/전역 verdict 비교. answerable→partial 후퇴 0 + fact/stance 누락 0 + 인용 [N] 누락 0 + 교차근거 분포 비후퇴 **동시 충족** 시에만 전환. 환경변수 플래그 단계 롤아웃. **leesj 전역 노출 보안 회귀 테스트 포함**.
- **롤백**: `GLOBAL_TOPK_ENABLED=false`로 즉시 위키별 getContext 복귀.

---

## 5. Expected End State

| 범위 | 질문당 비용 | 입력 토큰 | 위험 | 품질 |
|---|---|---|---|---|
| **현재** | $0.40 | ~13만 | — | 기준 |
| **Phase 0~2** | **$0.26~0.31** | ~8.5~10만 | 저-중 | golden-qa 그린 + eval answerable 비후퇴 |
| **Phase 3까지** | **$0.18~0.24** | ~5~7만 | 고(리팩터) | + shadow 검증 통과 |

> **정직한 한계**: 73~80% 같은 극단 절감은 entity/recency/protected slot/Tier0 경로를 보존하는 한 **도달 불가**. 현실 천장은 **~55% 절감($0.18대)**이며 그 이상은 품질 트레이드오프를 동반한다.

---

## 6. Open Decisions (사용자 판단 필요)

1. **~~어디까지 갈지~~ → 언제·어떤 순서로 Phase 3를 할지** (§0 스케일링 논거로 재프레이밍): "Phase 0~2에서 멈춤"은 더 이상 권장 안 함 — 성장 궤적상 전역 top-K는 필연이기 때문. 남은 결정은 **타이밍**: (a) college-grad-wiki Phase 1 **전에** 전역 top-K 완료(권장 — college가 올바른 코어 위에 additive로), (b) 두 플랜 **공동 설계** 후 병행, (c) 급하면 Phase 0~1만 먼저 적용해 즉시 디리스크·계측하고 Phase 2~3는 college와 함께. 어느 쪽이든 Phase 0(검증 인프라)은 무조건 선행.
2. **semantic-hint-only forcedWikis** 면제 정책: 면제하면 절감 작아지고(검증 지적), 좁히면 '장학금↔학생경비' 동의어 recall 안전장치 약화. 비대칭 트레이드오프.
3. **유사도 임계 정책**: 단일 전역 vs 위키별 상대 vs dist 통일 — 검증은 cosine 위키별 편차로 **전역 임계 금지**, 상대/dist 권고. sweep 필수.
4. **reranker 도입 + topN vs relevance 임계** — global-topk 없이는 효용 낮음. 고정 topN은 다면질문 보조측면 탈락 → adaptive cutoff 권장.
5. **Tier0 globalKeyword('전체/종합/정리')** 질문을 전역으로 줄일지 full coverage 유지할지 — 가장 비싼 유형이나 의도적 망라. 실제 질의로그 비중 측정 후 결정.

---

## 7. 다음 단계

**✅ 확정 경로: 전역 top-K 먼저 (college-grad-wiki Phase 1보다 앞).**

```
/pdca design rag-cost-reduction
   → Phase 0 게이트 스크립트 상세 설계(golden-qa 9위키 확장, eval-gold 비교모드, stop_reason/usage 로깅)
   → Phase 3 아키텍처 확정: searchVectorGlobal(WHERE wiki_id 제거 + leesj 보안 가드)
     + rrf wikiId 키 + rerank + protected-slot(guaranteed/recency/fact) + AgentContext 재조립
     + college/tier 메타필터를 WHERE 술어로 합성하는 통합 검색 설계(college-grad-wiki와 조정)
   → Phase 2 similarity 전파 3곳 배선 + 임계 정책(전역 임계 금지, 상대/dist)
```

착수 순서: **Phase 0(무비용 검증 인프라) → Phase 1(무위험 위생·계측) → Phase 2(유사도 cutoff) → Phase 3(전역 top-K)**. Phase 3 전 `measure-context-size.ts`로 베이스라인 재측정 필수(§4 Phase 3 전제). 모든 LLM 검증 실행(eval-gold ~$0.3/회)은 **비용 명시 후 진행**. college-grad-wiki는 Phase 3 머지 후 착수.
