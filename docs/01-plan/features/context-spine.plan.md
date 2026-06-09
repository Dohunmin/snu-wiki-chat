# Plan: Context Spine v1 — 재조립 오염 제거 (per-wiki 다양성 경로 내)

> **Feature**: context-spine (v1: 오염 제거 / 관련도순 전달)
> **Date**: 2026-06-09
> **Phase**: Plan (ready for `/pdca design context-spine`)
> **Related**: [retrieval-confidence-gate](retrieval-confidence-gate.plan.md)(= Phase 2 grounding 평가자), [[project_rag_cost_global_topk_first]]

> ⚠️ **제약 (2026-06-03 확정 결정 유지)**: 확정 아키텍처 = **per-wiki 다양성 라우팅 + rerank-aware 보편예산 + 복잡도 라우팅**. global top-K는 *다양성 붕괴*(vision 전략 콘텐츠 체계적 탈락 → 종합형 답 부실)로 **이미 폐기**됨. 본 플랜은 global top-K를 부활시키지 **않는다** — per-wiki 경로 *안에서* 오염만 제거.

---

## Executive Summary

| 관점 | 내용 |
|---|---|
| **Problem** | 검색·rerank는 **정상**(AI대학원 질문 rerank top-3 = 정확한 증거: "신설 단위/통합 허브/검토 단계"). 그런데 LLM이 받는 최종 컨텍스트는 **무관한 2021년 회의록**(수강신청·혁신공유대학 명칭논쟁)이 `[1][2]` 앞을 차지. 원인 = ① `enforceContextBudget`가 kept 블록을 **원래 per-wiki 순서**로 렌더(관련도 무시) ② getContext 키워드 선택이 무관 source까지 과포함. → **억측("통합 아님" 날조)과 비용(40K)의 공통 누수.** |
| **Solution (v1)** | **per-wiki 다양성 경로 유지하며** 오염만 제거: ① `context-budget.ts`가 kept 블록을 **관련도(rerank) 순으로 렌더** → 관련 증거 앞으로, 예산 truncation은 *덜 관련된* 노이즈부터 잘림 ② getContext **무관 source 과포함 억제**(보수적 — 다양성 콘텐츠는 유지) ③ entity/recency **선택 보존**(의도 게이트). |
| **Function UX Effect** | LLM이 관련 증거를 *먼저·깨끗하게* 봄 → **억측↓**(v1 핵심). 종합형 다양성 유지(드롭 아닌 *재정렬*). **비용은 v1이 *여는* 후속** — 신호가 상단에 모이면 예산을 신호 끝까지로 줄여 노이즈만 잘라낼 수 있음(Phase 1.5, §2.4). |
| **Core Value** | "검색은 잘 해놓고 생성 직전 *렌더 순서·과포함*으로 도로 오염"시키는 누수 차단 — global top-K 부활 없이, 가장 안전한 *재정렬* 위주. Phase 2(평가자)가 올라설 깨끗한 토대. |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 2026-06-09 진단(Voyage만 ~$0): AI대학원 질문서 ① rerank top-3은 정확한 증거를 골랐으나 ② 최종 LLM 컨텍스트 `[1][2]`가 2021 무관 회의록. 원인 = `context-budget.ts` 원래순서 렌더 + getContext 과포함. 검색이 아니라 **전달**이 깨짐. |
| **WHO** | 전체 사용자(억측↓·정직↑) + 운영(노이즈 truncation으로 비용↓). |
| **RISK** | (R1) getContext 과포함 억제가 *유효한 다양성 콘텐츠*까지 제거(종합형 부실 — 2026-06-03 재현 위험). (R2) 관련도순 렌더가 시계열·구조 흐름을 흐트림(회의록은 순서 의미 있음). (R3) 후보에 정답 없으면 깨끗해도 빈약(recall). (R4) governance 답변 *내용* 변화. |
| **SUCCESS** | (1) 전달 컨텍스트 무관-source 비율↓(현 ~50%). (2) **종합형 다양성 무회귀**(vision 등 전략 콘텐츠 유지 — 2026-06-03 실패 재발 0). (3) recall 무회귀. (4) char↓. (5) gold-set 생성서 억측↓·governance 무회귀. (6) entity/recency 선택 보존. |
| **SCOPE** | **수정**: `lib/agents/context-budget.ts`(관련도순 렌더), `lib/agents/wiki-agent.ts`(getContext 과포함 억제, 보수적). **신규**: `scripts/measure-pollution.ts`(무료: 오염률·다양성·recall·char). **비스코프**: global top-K 부활, grounding 평가자(§11=Phase 2), 복잡도예산 은퇴, 웹 escalation, 청킹/candidateK 재설계. |

---

## 1. 진단 (2026-06-09, 실측) — 무엇이 깨졌나

`scripts/show-topk.ts` (AI대학원 질문, Voyage만 ~$0):

**[검색 OK]** rerank 상위 3 = 정확한 증거:
- rerank#1 (senate/topic): "카테고리: 학사 **(신설 단위)**", "**범대학 AI 통합 허브 구축**", "19기-5차 설립계획(안) **검토 안건(아직 최종 심의 아님)**"
- rerank#2/#3: "원안 검토 ← 최종 심의 아님", "기존 단과대학 **연계** 구조 / 개방형 플랫폼 / 준비단 구성 후 지속 논의"
- 야구부류 노이즈 **없음** — rerank 정상.

**[전달 오염]** 같은 질문, 최종 LLM 컨텍스트:
- `[1]` 2021년 17기-2차(수강신청·혁신공유대학 명칭논쟁), `[2]` 17기-12차, `[6]` 2024 시흥캠퍼스 = **무관**.
- 깨끗한 증거는 뒤로 밀리거나 희석.

**원인 (전달 단계)**:
1. **`context-budget.ts`**: flat-pool rerank로 keep할 블록을 *고르긴* 하나, `out`을 **원래 per-wiki 순서**로 렌더 → 무관 2021 블록이 앞. (관련 증거가 컨텍스트 중간에 묻힘 = LLM lost-in-middle.)
2. **`getContext` 과포함**: 키워드 스코어링이 "대학원" 등 일반어로 2021 회의록까지 source로 끌어옴 → 예산(40K)이 커서 안 잘리고 다 들어감.

→ **억측의 기계적 원인**: LLM이 깨끗한 "신설 단위/통합 허브" 페이지를 *먼저·또렷이* 못 보고, 앞에 깔린 2021 노이즈 조각을 패턴매칭해 "통합 아님"을 날조.

> ⚠️ prod는 global OFF(per-wiki)다. 위 두 원인은 **per-wiki 경로에 그대로 존재**(context-budget은 공통, getContext는 per-wiki의 *주* 선택기). 즉 prod에서 그대로 재현. design 단계 `measure-pollution.ts`로 per-wiki 실경로 확정.

---

## 2. 해결 (v1) — per-wiki 안에서, 재정렬 우선

### 2.1 관련도순 렌더 (context-budget.ts) — *핵심·최저위험*

`enforceContextBudget`가 kept 블록을 **rerank 관련도 desc로 렌더**(현재는 원래 per-wiki 순서). 효과:
- 관련 증거가 컨텍스트 **상단**에 옴 (LLM lost-in-middle 완화).
- 예산 truncation 시 잘리는 건 **가장 덜 관련된** 블록(=2021 노이즈), 관련 증거 아님.
- **콘텐츠를 드롭하지 않고 *순서*만 바꿈** → 종합형 다양성 무손실(R1/SUCCESS-2 안전).
- ⚠️ R2: 회의록 시계열 흐름 — *블록 간* 재정렬은 OK이나 *한 source 내부* 순서는 보존(design서 입도 확정).

### 2.2 getContext 과포함 억제 (wiki-agent.ts) — *보수적*

키워드 선택이 일반어("대학원")로 *명백 무관* source를 끌어오는 걸 억제(예: 점수 임계 상향, 또는 rerank-후 floor). **보수적으로** — 다양성 콘텐츠(vision 전략 등)는 유지. R1 방어가 최우선: 종합형에서 콘텐츠 드롭 0 검증 후에만 강도 조정.

### 2.3 entity/recency 선택 보존

현행 entity 블록·recency 주입을 **질문 의도 게이트**로만(인물/최신일 때). 그 외엔 미부착 → 노이즈·비용↓. (`detectRecencyIntent`·entity 이름매칭 재사용.)

### 2.4 비용 축소 — v1이 *여는* 자연스러운 후속 (Phase 1.5)

⭐ v1(관련도순 렌더)이 신호를 컨텍스트 **상단에 모으면** → 예산을 줄여도 잘리는 건 **하단=노이즈, 신호 아님.** *지금* 예산(40K)을 못 줄였던 이유 — "관련 증거가 어디 있을지 몰라 함부로 못 자름" — 이 **사라짐.**
- `measure-pollution.ts`로 "신호가 몇 번째 블록까지 가나"(signal depth)를 측정 → 그 지점까지로 **예산 하향** → **비용↓, 신호·다양성 보존**(종합형도 vision이 상위라 살아남음 → 2026-06-03 붕괴 회피).
- complexity 오분류(AI대학원 "?" 2개→40K)도 여기서 정리.
- ⚠️ **v1 검증(특히 SC2 다양성) 통과가 전제** — v1이 잘 돼야 이 축소가 안전. 그래서 v1 먼저(사용자 확정).

---

## 3. 구현 범위

| 파일 | 변경 | 라인(추정) |
|---|---|---:|
| `lib/agents/context-budget.ts` | kept 블록 관련도순 렌더(블록간), source내부 순서 보존 | ~15 |
| `lib/agents/wiki-agent.ts` | getContext 무관 source 과포함 억제(보수적) + entity/recency 의도 게이트 | ~30 |
| `scripts/measure-pollution.ts` | **신규** — 무료: 오염률 + **종합형 다양성**(vision 유지) + recall + char, gold 질문 | ~130 |

### 무수정
- globalTopK / rerank / searchVectorGlobal (검색·순위 정상 — 안 건드림)
- global top-K 경로 (부활 안 함)
- DB 스키마, 임베딩, citations([N])

---

## 4. Success Criteria

| ID | 기준 | 측정 | 비용 |
|---|---|---|---|
| **SC1** | 전달 컨텍스트 **무관-source 비율↓** (현 ~50%) — 관련 증거 상단 | `measure-pollution.ts` | **$0** |
| **SC2** | **종합형 다양성 무회귀** — vision 등 전략 콘텐츠 유지(2026-06-03 붕괴 재발 0) | `measure-pollution.ts`(종합 질문 셋) | **$0** |
| **SC3** | **recall 무회귀** — 정답 청크 생존 | `measure-pollution.ts` | **$0** |
| **SC4** | char **비증가** + **신호 깊이(signal depth) 측정** — 상위 몇 블록까지가 관련(Phase 1.5 안전 예산점 산출용) | `measure-pollution.ts` | **$0** |
| **SC5** | gold-set 생성서 **억측↓ + governance 무회귀** | golden-qa | 유료(별도 보고) |
| **SC6** | entity/recency 선택 보존 + `test:governance` 19/19 | 단위 + test | **$0** |

> 검증 순서(사용자 확정): **무료(SC1·2·3·4·6) 먼저** → 통과 시 유료 SC5를 비용 보고 후.

---

## 5. Risks

| 위험 | 완화 |
|---|---|
| **R1** 과포함 억제가 유효 다양성 콘텐츠 제거(종합형 부실, 2026-06-03 재현) | **2.1 재정렬 우선**(드롭 0). 2.2는 보수적, SC2(다양성 무회귀) 통과 후에만 강화. |
| **R2** 관련도순 렌더가 시계열·구조 흐름 훼손 | *블록 간*만 재정렬, *source 내부* 순서 보존. design서 입도 확정. |
| **R3** 후보에 정답 없으면 빈약(recall) | SC3 측정. 본 v1 비스코프(candidateK)지만 트리거. |
| **R4** governance 답변 내용 변화 | golden-qa(SC5) 게이트 + 단계 활성화. 구조는 frozen(SC6). |

---

## 6. Out of Scope (의도적)

| 항목 | 이유 | 후속 |
|---|---|---|
| **global top-K 부활** | 2026-06-03 다양성붕괴로 폐기 — 본 플랜은 per-wiki 내 수정 | (영구) |
| grounding 4-way 평가자 | 깨끗한 토대 위에 올려야 효과 | **Phase 2** = retrieval-confidence-gate |
| 복잡도예산 은퇴 | 평가자가 예산 결정하게 되면 | Phase 2 |
| 웹 escalation 인터랙티브 | 별 기능(평가자 ③ external) | 별도 |
| 청킹/candidateK 재설계 | recall(SC3) 깨질 때만 | 조건부 |
| P8(억측 금지 프롬프트) | 오염 제거로 불필요해질 수 있음 — SC5서 재평가 | 임시 유지 |

---

## 7. Dependencies

- **rerank 작동 전제**(`RERANK_ENABLED`, lib/embed/voyage rerankDocuments) — context-budget flat-pool이 이미 사용. ✅ **`d04d854`로 배포·전 질문 가동 중**(Voyage 무료 200M 중 ~39M 소진). → **2.1은 *이미 계산된* rerank 순서를 렌더에만 재사용 = 새 rerank 호출 0**(추가비용 없음, 최저위험 근거).
- `scripts/gold-questions.json` — SC2(종합형 다양성)·SC3(정답청크) 라벨 보강 필요.
- 외부 라이브러리/DB 마이그레이션/env 신규 **없음**.

---

## 8. 다음 단계

```
/pdca design context-spine
   → context-budget 관련도순 렌더 입도(블록간 vs source내부) 확정
   → getContext 과포함 억제 방식(임계 vs rerank floor) + 보수 기준
   → measure-pollution.ts 정의(오염률·다양성·recall·char) + gold 라벨 보강
   → 검증: 무료 게이트(특히 SC2 다양성) → 유료 golden-qa → 적용
```
권장: **2.1 관련도순 렌더부터**(최저위험·콘텐츠 드롭 0) 검증 → 효과 보고 2.2 강도 조정. 검색·global top-K는 안 건드림.
