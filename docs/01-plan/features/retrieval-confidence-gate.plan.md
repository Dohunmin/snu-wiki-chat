# Plan: Retrieval Confidence Gate — CRAG-lite 검색 신뢰도 게이트

> **Feature**: retrieval-confidence-gate
> **Date**: 2026-06-01
> **Phase**: Plan (ready for `/pdca design retrieval-confidence-gate`)
> **Related**: [hybrid-rag](hybrid-rag.plan.md), [limitation-tracking](limitation-tracking.plan.md), B-1 HNSW(`drizzle/0004_hnsw_index.sql`), B-2 신뢰도 가중분배(router.ts)

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | 검색이 빈약해도(코퍼스에 관련 자료 부족) 시스템이 *언제 불확실한지* 모름. P5(한계 인정)는 무조건 규칙이라 LLM 재량에 의존하고, 사용자는 답변이 탄탄한 자료에 근거했는지 빈약한지 알 수 없음. 거버넌스 도구로서 과신·사실오류 위험. |
| **Solution** | B-1(HNSW)로 신뢰 가능해진 **임베딩 거리 + concept/키워드 신호**로 **질의별 검색 신뢰도(high/medium/low)를 추가 LLM 호출·지연 없이** 산출. `low`일 때 (a) 프롬프트의 한계-인정을 *조건부 강화*, (b) UI에 "관련 자료 제한적" 배지, (c) 저신뢰 질의 가시화. CRAG의 retrieval evaluator를 무비용(거리 기반)으로 구현. |
| **UX Effect** | 자료가 빈약한 질문엔 답변이 단정 대신 한계를 명확히 표시 + 신뢰도 배지. 정상(고신뢰) 질문은 체감 변화 0. |
| **Core Value** | "정확해야 하는 데이터"에서 *모르는 걸 모른다고* 알게 됨 — 닫힌·권위 코퍼스의 신뢰성 직접 강화. 온라인 corrective 루프의 가장 저비용 첫 단계. |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 능동적 RAG(Agentic/Self/Corrective) 검토(2026-06-01) 결과, 이 시스템은 *오프라인* corrective(limitations→supplementation→synthesis-writeback)는 갖췄으나 *온라인* 피드백 루프가 없음. 그중 가성비 1위 = 검색 신뢰도 게이팅. **B-1(HNSW)로 거리 신호가 신뢰 가능**해져 추가 LLM 없이 구현 가능해진 지금이 적기. |
| **WHO** | 전체 사용자(신뢰도 배지로 답변 근거 강도 인지) + 관리자(저신뢰 패턴 추적·보충 우선순위). |
| **RISK** | (R1) 임계 미보정 → 과표시(over-hedging, 배지 남발) 또는 소표시. (R2) bestDistance가 *무관하지만 의미상 근접한* 위키에 낮게 나올 수 있음. (R3) 배지 남발 시 사용자 신뢰 저하. |
| **SUCCESS** | (1) 질의별 confidence 산출 — 추가 LLM 0, 지연 0. (2) 라벨셋에서 in-corpus→high/med, out-of-corpus→low 분류 정확. (3) low 답변에 강화 hedging + 배지, high 답변 무회귀. (4) 임계가 보정 하니스로 검증됨. (5) golden-qa 회귀 유지. |
| **SCOPE** | **수정**: `lib/agents/router.ts`(신뢰도 산출+노출), `lib/llm/prompts.ts`(조건부 강화), `app/api/chat/route.ts`(전달+SSE), `components/chat/ChatPage.tsx`(배지). **신규**: `scripts/test-confidence-gate.ts`(보정 하니스). **비스코프**: 교정 재검색(Tier 3), 질의 분해(Tier 2), 온라인 웹검색, DB 컬럼/실시간 limitations 연결, 멀티에이전트. |

---

## 1. 신호 & 분류 (추가 LLM 호출 없음)

`routeQuery`가 이미 보유한 신호 재사용:
- `semanticDist`: 위키별 min cosine distance (B-2에서 `semanticRoutingHints`가 전체 위키 거리 반환). → `bestDist = min over corpus` = 코퍼스에서 질의에 가장 가까운 청크 거리.
- 키워드 `score` (위키별), `conceptResult.forcedWikis`(큐레이션 매칭), `guaranteedPages`(개념 강제 페이지).

**분류 규칙 (초안 — §4 보정 단계서 확정):**
```
hasStrongSignal = conceptResult.forcedWikis.size > 0   // 큐레이션 매칭 = 강한 신뢰
                || topKeywordScore >= 8                 // 명확한 키워드
                || guaranteedPages.size > 0
level =
  hasStrongSignal || bestDist <= T_HIGH(≈0.58)  → 'high'
  bestDist <= T_LOW(≈0.70)                       → 'medium'
  그 외(bestDist > T_LOW, 강한 신호 없음)         → 'low'
```
- 글로벌 키워드(Tier 0, 전체 커버리지) → `high`.
- `semanticDist` 비었을 때(임베딩 실패 fallback) → 키워드 기반(강하면 high, 아니면 medium).

**실측 근거(2026-05 평가)**: 명확 단일주제 best≈0.39~0.55, 동의어/추상 best≈0.60~0.69. → 임계 초안의 출발점. (out-of-corpus 질의 best distance는 보정 하니스에서 측정해 T_LOW 확정.)

---

## 2. 흐름

```
routeQuery(query, role)
  → 기존 라우팅 + RetrievalConfidence{ level, bestDist, signals } 반환

app/api/chat/route.ts
  → buildSystemPrompt(contexts, role, confidence)
       level==='low' → 한계-인정 강화 블록 주입(단정 금지·한계 마커 필수·재질문 유도)
  → SSE 'routing' 이벤트에 confidence 포함

components/chat/ChatPage.tsx
  → confidence.level==='low' → 답변에 "⚠️ 관련 자료가 제한적입니다" 배지
     (medium=미표시 또는 옅게, high=없음)
```

조건부 프롬프트 강화 예 (`low`일 때만 P5 위에 추가):
> ⚠️ 이 질문에 대한 관련 자료가 빈약합니다. 자료로 뒷받침되는 사실만 간결히 제시하고, 추정·일반론으로 채우지 마세요. 답변 말미에 `## ⚠️ 자료 한계 안내` 마커 블록을 **반드시** 포함하고, 더 구체적인 질문으로 다시 물어보도록 안내하세요.

---

## 3. 구현 범위

| 파일 | 변경 | 라인(추정) |
|---|---|---:|
| `lib/agents/router.ts` | `RetrievalConfidence` 타입 + `RoutingResult`에 필드 추가 + 산출 로직 | ~30 |
| `lib/llm/prompts.ts` | `buildSystemPrompt`(+`buildLensSystemPrompt`) 시그니처에 confidence, `low` 조건부 블록 | ~20 |
| `app/api/chat/route.ts` | confidence를 프롬프트에 전달 + `routing` 이벤트에 포함 | ~8 |
| `components/chat/ChatPage.tsx` | `Message`에 confidence, 배지 렌더 | ~20 |
| `scripts/test-confidence-gate.ts` | **신규** — 라벨셋(in-corpus clear/synonym, out-of-corpus, vague) 분류 정확도 + 임계 보정 | ~80 |

### 무수정
- DB 스키마 / 마이그레이션 (신호는 런타임 산출, 저장 안 함)
- `lib/embed/*` (B-2에서 거리 반환 이미 구현됨)
- limitations / lens 코어

---

## 4. Success Criteria

| ID | 기준 | 측정 |
|---|---|---|
| **SC1** | confidence 산출 — 추가 LLM 호출 0, 라우팅 지연 증가 0 | 코드 리뷰 + 라우팅 시간 측정 |
| **SC2** | 라벨셋 분류 정확: in-corpus clear→high, synonym→high/med, out-of-corpus→low, vague→low/med | `test-confidence-gate.ts` |
| **SC3** | low → 강화 hedging 주입 + 배지 표시 / high → 프롬프트·UI 무변화 | 수동 + 단위 |
| **SC4** | golden-qa 회귀 유지 (≥ 기존) | `npm run qa:golden` |
| **SC5** | 임계(T_HIGH/T_LOW)가 보정 하니스로 검증·고정 | 하니스 출력 |

---

## 5. Risks

| 위험 | 완화 |
|---|---|
| **R1** 임계 미보정 → 과/소 표시 | 보정 하니스(SC2·SC5) + **보수적 임계**(명백 저신뢰만 low) + 게이트는 *자문*(비차단) |
| **R2** bestDistance가 무관-근접 위키에 낮음 | concept/키워드 강한 신호와 **결합**해 high 승격, low는 약한 신호일 때만 |
| **R3** 배지 남발로 신뢰 저하 | `low`만 가시 배지, `medium`은 미표시/옅게 |
| **R4** 고신뢰인데 답변이 부실(LLM 문제) | 본 기능 범위 밖 — citation-validator/limitations가 별도 커버 |

---

## 6. Out of Scope (의도적)

| 항목 | 이유 | 후속 |
|---|---|---|
| 교정 재검색(저신뢰 시 재질의·재생성) | 비용·지연 2배, 별도 게이팅 필요 | Tier 3 (별도 plan) |
| 질의 분해(비교/다면) | 검색 *위치*가 아닌 *질의 구조* 문제 | Tier 2 (별도 plan) |
| 온라인 웹검색/외부도구 | 닫힌·권위 코퍼스 — 답변 경로 오염 위험. 오프라인(supplementation)이 정답 | 영구 비스코프(답변 경로) |
| DB 컬럼/실시간 limitations 연결 | limitations가 이미 모든 Q&A를 오프라인 수집 → 중복 | 검토 후 결정 |

---

## 7. Dependencies

- **B-1(HNSW) 완료 전제** — 거리 신호 신뢰성이 본 기능의 토대.
- **B-2(semanticRoutingHints 전체 위키 거리 반환) 완료 전제** — `semanticDist` 활용.
- 외부 라이브러리 / DB 마이그레이션 / 환경변수 **없음**. 기존 SSE 인프라 재사용.

---

## 8. 다음 단계

```
/pdca design retrieval-confidence-gate
   → 3 아키텍처 옵션(산출 위치: router 내 / 별도 lib/rag/confidence.ts / chat route)
   → 임계 보정 절차 + Module Map
```
권장: 산출 로직은 `router.ts` 내 소형 함수 또는 `lib/agents/confidence.ts`로 분리(테스트 용이), 프롬프트/UI는 얇게.

---

## 9. ⚠️ 검증 결과 (2026-06-01) — 무비용 신호 폐기, 설계 수정 필요

§1의 "거리 기반 무비용 게이트" 전제를 실DB로 검증한 결과 **신뢰성 부족**이 확인됨. 특히 **다중 위키 질문 방어 불가**:

**(A) 다중위키 masking** — global `bestDist`가 필요 위키 중 부실한 축을 가림:
| 질의 | global bestDist | 필요 위키 중 최악 | 판정 불일치 |
|---|---|---|---|
| "등록금 동결은 어디서 결정?" (senate+finance) | 0.64 → med | senate **0.78 → low** | ⚠️ med로 안전하다 오판 |
| "법인화 이후 재정 변화" (finance+history) | 0.56 → high | finance 0.66 → med | ⚠️ high로 오판 |

**(B) 절대거리가 OOD를 못 가름** — 한국어 거버넌스 질의 거리가 0.55~0.80에 압축:
- out-of-corpus "서울대 **야구부** 우승 기록" → 0.63 (in-corpus "정부출연금" 0.58보다 *가까움*). `bestDist>0.70→low` 임계가 무의미.

**(C) 어휘 grounding도 noisy** — 조사 결합("동결은"≠"동결") + 일반어("서울대","학교") 잡음으로 in-multi 33% vs out 25~33%, **분리 안 됨**.

→ **결론**: 거리/어휘 같은 무비용 신호는 이 코퍼스에서 신뢰도 게이트를 단독 지탱 못 함. 잘못된 신뢰 배지는 *없느니만 못함*(R3 악화).

→ **수정 방향**:
1. 무비용 신호(거리/어휘)는 **명백 케이스의 coarse pre-filter**로만 사용 (예: 분명히 가깝고 핵심어 강매칭 → high 즉시 확정).
2. 모호 band(대부분 질의) + **다중위키/비교 질의**는 **게이트형 경량 LLM 평가자(Haiku급)** 로 판정: "이 컨텍스트로 질문에 답할 수 있는가? 어느 부분이 자료 부족인가?" → **per-aspect 판정이라 다중위키를 자연 처리**. CRAG의 retrieval evaluator를 *제대로* 구현하되 게이팅으로 비용 통제(질의당 +1 저비용 호출, 명백 케이스는 skip).
3. 또는 **Tier 2(질의 분해)와 결합** — 분해된 sub-aspect별로 grounding/평가 → 부실 aspect만 플래그(가장 견고한 다중위키 방어).

→ **영향**: §1 분류·§4 SC2/SC5(절대임계)는 **폐기**. Design 단계에서 LLM 평가자 게이팅·모델·프롬프트·다중위키 per-aspect 판정 확정 필요. (무비용 전제가 깨졌으므로 "비용≈0" Core Value도 "명백 케이스 무비용 + 모호 케이스 저비용 1회"로 수정.)

---

## 10. ✅ 확정 설계 — 게이트형 LLM 평가자 (프로토타입 검증 통과, 2026-06-01)

§9의 무비용 신호 폐기에 따라 **(가) LLM 평가자** 방향 채택. 프로토타입으로 *어려운 케이스를 옳게 판단하는지* 먼저 검증함.

### 10.1 프로토타입 결과 (실DB 컨텍스트 + 구조화 평가자)
| 케이스 | 기대 | Haiku | Sonnet |
|---|---|---|---|
| 정부출연금 (in-corpus 단일) | sufficient | sufficient ✅ | sufficient ✅ |
| **야구부 우승 (OOD)** | insufficient | insufficient ✅ | insufficient ✅ |
| **등록금 동결 (다중위키)** | partial | partial ✅(주체/절차/배경 축 분해) | partial ✅ |
| 장학금 늘었나 (동의어+시계열) | sufficient? | partial 🟡 | partial 🟡 |

- **거리·어휘가 못 가른 OOD/다중위키를 정확히 처리** — 본 설계의 핵심 가설 입증.
- **Haiku = Sonnet (4/4 동일)** → 비용 모델은 **Haiku**로 충분(질의당 저비용). Sonnet은 escalation 후보.
- 평가자가 **안전한 방향으로 보수적**(장학금→partial). 거버넌스엔 과신보다 안전. ↔ 단 보정 필요(§10.4).

### 10.2 평가자 = 구조화·grounded·per-aspect (다중위키 방어의 본질)
입력: 질문 + 검색된 컨텍스트(원문). 출력(JSON):
```json
{"aspects":[{"aspect":"...","covered":"yes|partial|no"}],"overall":"sufficient|partial|insufficient","missing":["..."]}
```
- **질문을 정보 요소(aspect)로 분해 → 컨텍스트만 근거로 요소별 판정** → 다중위키의 부실 축이 `missing`에 드러남. (단일 점수보다 신뢰도↑ — CRAG/Self-RAG 합의)
- **자료 밖 지식 금지 + 동의어 인정** 명시(grounding & 장학금≈학생경비 false-missing 차단).

### 10.3 게이팅 & 동작
- **skip(평가자 미호출)**: 강한 신호로 명백 충분할 때만 (concept-index exact 매칭 + 근접 + 핵심어 강매칭). **신뢰성 우선 — 애매하면 호출**(Haiku 저비용).
- **run**: 비교·다중엔티티 질의, 모호 band, 신호 불일치.
- **verdict→action**:
  - `sufficient` → 정상 생성.
  - `partial` → 생성기에 **부실 aspect 전달** → 커버된 부분 답하고 **부족 aspect만 `## ⚠️ 자료 한계` 마커로 명시**(per-aspect 한계 = 다중위키 정직성).
  - `insufficient` → "자료 없음" + 재질문 유도.
- **비대칭 안전**: 불확실 시 partial/insufficient 쪽으로 (과신 < 과신중).

### 10.4 "확실히 판단 잘 함" 보증 = 검증 하니스 (필수 deliverable)
- **라벨 gold-set** (~40~60): in-corpus 단일/동의어, **다중위키(양축 covered / 한축 부실)**, OOD, vague. 각 항목에 정답 overall + per-aspect 라벨(전문가/도훈민).
- 측정: 평가자 ↔ gold **일치율**(특히 *insufficient/partial 탐지* precision/recall), per-aspect 정확도. **목표 ≥ 90%** (insufficient 탐지는 recall 우선 — 놓치면 과신).
- **보정 대상**: §10.1의 "장학금 partial"이 옳은지(검색 누락) 과보수인지 gold 라벨로 확정 → 프롬프트/동의어 가이드 튜닝.
- 모델 선택(Haiku vs Sonnet)도 gold 일치율로 확정. 저일치 케이스만 Sonnet escalation 검토.

### 10.5 비용·지연
- 게이트로 명백 케이스 skip. run 시 **Haiku 1회**(질의당 ~수백 토큰 in/out, $ 미미·~1s).
- **지연**: 평가자는 생성 *전* 실행 → 게이트된 질의의 TTFT +~1s. 거버넌스(정확성>속도)엔 수용. (옵션: 생성과 병렬 후 보정 = Self-RAG식, Design에서 검토.)

### 10.6 수정된 구현 범위 (§3 대체)
| 파일 | 변경 |
|---|---|
| `lib/agents/evaluator.ts` (신규) | 구조화 평가자 호출 + 파싱 + 게이팅 판단 (~120) |
| `lib/agents/router.ts` | 강한-신호 게이트 산출(skip 여부 힌트) (~15) |
| `app/api/chat/route.ts` | run이면 평가자 호출 → verdict를 프롬프트/SSE에 반영 (~25) |
| `lib/llm/prompts.ts` | verdict별(특히 partial의 per-aspect missing) 조건부 블록 (~25) |
| `components/chat/ChatPage.tsx` | verdict 배지(부족 aspect 표시) (~25) |
| `scripts/eval-gold.ts` (신규) | gold-set 일치율 측정·모델선택·보정 하니스 (~120) |

→ Design(`/pdca design`)에서: 게이팅 신호 정의, 평가자 프롬프트 최종화, gold-set 구축, 병렬-vs-순차 실행, Haiku/Sonnet 확정.

---

## 11. 확정 — (다) verdict 4-way + 전략 디스패처 + 확장 로드맵 (2026-06-01)

### 11.1 실제 로그(긴 질문 14개) 검토에서 드러난 것
- **구현**: 4/14 PARSE_FAIL — Haiku의 ` ```json ` 코드펜스 + `max_tokens` 절단. → 토큰 상향 + 펜스 제거 + 견고 파싱(구현 시 처리). 신뢰성 점검 항목.
- **핵심**: 실제 트래픽 상당수가 **의견·제안·분석형**("수목장 아이디어 어때", "종합대학 체계 최선인가", "카이스트에 밀리는 원인 진단") — 사실 코퍼스가 *직접* 답을 안 가짐. 평가자는 (엄격히) insufficient/partial로 정확히 판정하나, **"sufficient" 기준을 엄격히 두면 실사용 대부분이 차단 → 과도한 hedging 위험**.
- 판단력 자체는 우수(예: "예산 늘릴 방법 3개?" → 기부금/연구비 yes, 정부출연금 no, '가용예산' 정의 모호 까지 per-aspect 정확).

### 11.2 채택 — verdict를 4-way로 (사용자 결정: 다)
평가자는 단일 충분성 점수가 아니라 **답변 전략을 라우팅하는 분류**를 출력:

| verdict | 의미 | 게이트 동작 (현 단계) | 향후 모드 |
|---|---|---|---|
| **① answerable** | 코퍼스가 직접 답함 | 엄격 답변(현 P1) | — |
| **② opinion-grounded** | 관련 사실은 있으나 *의견·제안·추론*은 기록 밖 | 관련 사실 제시 + "이 판단/제안은 기록에 없음" 명시(자료기반 추론 허용, 한계 명시) | **분석·조언 모드(확장 B)** |
| **③ external-needed** | 내부엔 없고 *외부/비교/최신* 정보 필요 | "내부 자료 없음" 명시 | **웹 API fallback(확장 A)** |
| **④ internal-gap (OOD)** | 진짜 내부 공백 | "자료 없음" + 재질문 유도 | supplementation(기존 오프라인) |

→ **이 분류기가 곧 전략 디스패처**. 현 단계는 ②③④를 "한계 명시"로 비슷하게 처리하되 **verdict는 4종으로 분류·기록**(향후 모드가 리팩터 없이 가지에 붙도록).

### 11.3 확장 로드맵 (사용자 비전 — 가능성 확인됨)
- **확장 B — 데이터 기반 의견·조언 모드** (②에 부착): P1을 *선택적*으로 풀어 인용된 사실 근거 추론·조언 허용. 사실/추론 시각 구분 + [N] 인용 필수 + "AI 분석·비공식" 프레이밍. **선례: lens 모드**(추론 마커 강제, `lib/agents/lens.ts`). ⚠️ 엄격 검색기→분석가로의 제품 정체성 전환 + 거버넌스 민감성 신중.
- **확장 A — 웹 API fallback** (③에 부착): `web_search`(이미 supplementation에서 사용). ⚠️ **사실 질문엔 금지**(비권위 정보가 큐레이션 데이터 권위 훼손). 외부·비교·최신 질문에 한정 + **출처 분리·"외부(비공식)" 라벨** + 내부 사실 미덮어쓰기. 별도 큰 feature(CRAG+web).
- **공통 전제**: 두 확장 모두 **분류기가 ①②③④를 정확히 가르는 것**에 의존 → **gold-set 검증(§10.4)이 더 중요**. 잘못 분류 시 사실질문에 웹/의견 누출 또는 의견질문 차단.

### 11.4 권장 순서
1. confidence-gate를 **4-way 분류기**로 구축(②③④는 일단 한계 명시로 동일 처리) + gold-set으로 분류 정확도 확보.
2. → 확장 B(분석모드, ② 가지).
3. → 확장 A(웹 fallback, ③ 가지).

토대를 4-way로 잡으면 확장이 분류 가지에 모드만 추가하는 작업이 됨(아키텍처 안정).
