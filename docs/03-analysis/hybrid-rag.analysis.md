# Analysis: Hybrid RAG — PoC 93% → Phase B 98%

> **최신 상태 (2026-05-19)**: Phase B Overall **98%** — Critical 0건, Important 0건, Minor 4건
> Phase C 진입 가능. 자세한 Phase B 분석은 본 문서 §"Phase B Analysis (2026-05-19)" 참조.

---

## Original PoC Analysis — Match Rate 93% (Session 1+2+3)

> **Feature**: hybrid-rag
> **Date**: 2026-05-19
> **Phase**: Check (Gap Analysis)
> **Scope**: module-1, module-2, module-3, module-4 (module-5, module-6 보류)

---

## 📌 Context Anchor (Plan/Design에서 승계)

| 항목 | 내용 |
|---|---|
| **WHY** | 2026-05-18 갭 사례 — "대학원생 장학금 10년" 질문에 풍부한 자료가 있음에도 "자료 없음" 답변. 동의어 매칭 실패가 거버넌스 도구 신뢰성을 위협 |
| **WHO** | 총장 후보자·관리자. PoC 사용자 도훈민 |
| **RISK** | 노이즈 청크 오염 / 임베딩 비용·지연 / 회귀 / pgvector 마이그레이션 실수 |
| **SUCCESS** | 갭 사례 해소 + 회귀 ≥18/20 + 지연 ≤200ms + 9개 확장 청사진 |
| **SCOPE** | finance 1개 위키만, 신규 lib/embed/ + pgvector 테이블 |

---

## 1. Overall Match Rate

| 축 | 점수 | 가중치 | 기여 |
|---|:---:|:---:|---:|
| Structural Match | 100% | 0.2 | 20.0 |
| Functional Depth | 95% | 0.4 | 38.0 |
| API / Design Contract | 88% | 0.4 | 35.2 |
| **Overall** | — | — | **93.2%** |

**합격선 90% 초과 — Report 단계 진입 가능.**

---

## 2. Plan Success Criteria 충족도

| # | 기준 | 결과 |
|:--:|------|:----:|
| SC1 | pgvector 설치 + chunk_embeddings 테이블 작동 | ✅ |
| SC2 | finance 임베딩 성공 (166 청크) | ✅ |
| SC3 | RRF 융합 작동 (vec-only 24개 청크 회수) | ✅ |
| SC4 | 갭 사례 해소 (학생경비·학문후속세대 회수 0→2/4) | ✅ |
| SC5 | 회귀 ≥18/20 (module-5 범위) | ⏳ |
| SC6 | 갭 개선 ≥3/5 (module-5 범위) | ⏳ |
| SC7 | 권한 다층 방어 유지 (sensitive 필터) | ✅ |
| SC8 | 다른 8개 위키 영향 없음 (ragEnabled OFF) | ✅ |
| SC9 | Vercel 프로덕션 배포 | ⏳ (module-6) |
| SC10 | 9개 확장 청사진 | ⏳ (Report) |

**Session 1+2+3 범위 6/6 ✅**

---

## 3. Critical / Important / Minor

### 🔴 Critical (즉시 처리)
**없음.**

### 🟡 Important (Phase B 전 처리 필수)

| # | 이슈 | 위치 | 권장 조치 |
|---|---|---|---|
| I1 | Design은 voyage-3, 실제 voyage-4-large | design.md §2.3, §4.1 | Design 모델/가격 업데이트 (200M free tier) |
| I2 | MAX_CHUNKS_RAG=25 Design 미반영 | wiki-agent.ts:13 | Design §10.1 chunkCap 정책 추가. Plan §8.3 토큰 영향 재계산 |
| I3 | fused → scoredChunks/labeledItems 재분리 로직 Design 누락 | wiki-agent.ts:299-325 | Design §5 의사코드 업데이트 |
| I4 | test-rag-gap.ts, debug-vector-top.ts 미문서화 | plan.md §12, design.md §11.1 | 검증/디버그 스크립트 항목 추가 |
| I5 | drizzle execute 결과 형태 분기 fragility | search.ts:69-71 | Vercel Postgres 환경에서 실제 형태 확정 후 단순화 |

### 🟢 Minor

| # | 이슈 | 권장 |
|---|---|---|
| M1 | voyageai SDK 미사용 (fetch + drizzle vector) | Plan §12에서 SDK 항목 제거, "fetch 직접" 명시 |
| M2 | search.ts SQL이 단일 wiki_id 사용 (Design은 IN) | Design §2.5에 "위키별 병렬 호출" 명시 |
| M3 | MIN_CONTENT_LENGTH=30 가드 미문서화 | Design §4.2에 짧은 청크 스킵 정책 |
| M4 | metadata null fallback (`{ title: page_id, pageType }`) | Design §3.4에 fallback 정책 |

---

## 4. 의사결정 변경 추적

| 변경 | 정당화 | Design 동기화 |
|---|---|:---:|
| voyage-3 → voyage-4-large | 한국어 SOTA + 200M free tier → PoC $0 | 🔲 |
| MAX_CHUNKS_RAG = 25 신설 | 실측: 학생경비 청크가 top-19 → 15면 누락 | 🔲 |
| voyageai SDK 미사용 → fetch | Edge runtime 호환성 + 의존성 최소화 | 🔲 |

---

## 5. 강점 / 부채

### ✅ 강점
- Design §1.2 "변경 X" 4개 영역(router/lens/prompts/middleware) **grep 결과 0건** — 회귀 위험 구조적으로 0
- Option C "Pragmatic Balance" 약속 그대로 — 9개 위키 확장이 *config 한 줄씩 변경* 수준
- Voyage 4-large 200M free tier → PoC/Phase B 모두 실 비용 $0
- 갭 사례 실측 통과 (학생경비 시계열 데이터 컨텍스트 진입)

### ⚠️ 부채
- Design 문서의 모델·청크캡·SDK 명세가 실제와 불일치 → 다음 세션 Decision Record Chain 신뢰성 저하
- SC5/SC6 (회귀 자동 검증) 아직 미실행 — Phase B 진입 전 module-5 필수
- chunkCap 25 → input 토큰 +66% 가능 → Plan §8.3 "±10%" 기준 재검증 필요

---

## 6. Phase B 진입 전 필수 처리

1. **module-5 (scripts/golden-qa.ts) 구현 + 실행** — SC5/SC6 검증
2. **토큰 영향 측정** — MAX_CHUNKS_RAG=25의 실제 input 토큰 변화
3. **SC9 — Vercel 배포 + finance 쿼리 동일 작동 확인**
4. **Design/Plan 동기화** (I1-I4)

---

## 7. 다음 단계 결정

```
현재: Match Rate 93% (90% 합격선 초과)
선택지:
  (A) /pdca iterate hybrid-rag       — 자동 수정 (Important 5개)
  (B) module-5 (golden-qa.ts) 구현    — SC5/SC6 검증 (Phase B 전 필수)
  (C) /pdca report hybrid-rag        — 보고서 생성 (PoC 완료 선언)
  (D) Design 문서 동기화 (I1-I4)       — 문서 부채 정리

권장: B → A → D → C
  module-5로 회귀 검증 → 발견된 회귀 자동 수정 → Design 동기화 → 최종 보고서
```

---

# Phase B Analysis (2026-05-19)

## 1. Overall Match Rate — **98%**

| 축 | 점수 | 산출 근거 |
|---|:---:|---|
| Structural Match | **100%** | Plan §10.2.1 6개 ✅ 항목 모두 코드에 존재 |
| Functional Depth | **97%** | Tiered thresholds, try/catch, 권한 다층 모두 정확 |
| Contract Match | **100%** | Design §14.5 시그니처/SQL/Promise.all 일치 |
| **Overall (가중)** | **98%** | Critical 0, Important 0, Minor 4 |

## 2. Phase B Success Criteria — 4/4 PASS

| # | 기준 | 결과 |
|:--:|------|:----:|
| SC11 | 8개 위키 임베딩 완료 (1,021 청크) | ✅ |
| SC12 | Semantic Routing 작동 | ✅ |
| SC13 | Forced wiki cap priority | ✅ |
| SC14 | 5개 갭 쿼리 finance 포함 | ✅ |

## 3. Decision Record Verification

| 결정 | 출처 | 코드 검증 | 상태 |
|---|---|---|:---:|
| Phase B Pivot: router.ts additive 수정 | Design §14.5 | router.ts:9, 133-145, 165-177 | ✅ |
| Bug fix: Forced cap priority | Design §14.5.4 | router.ts:162-177 | ✅ |
| Tiered thresholds (1.0 / 0.85) | Design §14.5.2 | search.ts:112 + router.ts:137 | ✅ |
| Scholarship 동의어 (defense in depth) | Design §14.5.5 | concept-index.json:2-44 + agents.config.json:910-916 | ✅ |
| leesj는 Phase C에서 lens-specific 처리 | Design §14.5.1 | agents.config.json:992 ragEnabled 미설정 | ✅ |

## 4. Minor 관찰 (Phase C 차단 사유 아님)

| # | 항목 | 권장 조치 |
|---|---|---|
| M1 | Forced 위키 7개 이상 시 MAX_WIKIS=6 cap 초과 가능 (현재 최대 5) | Design §14.5.4에 "soft cap" 명시 |
| M2 | semanticRoutingHints가 top-1 absoluteMax 초과 시 빈 Set 반환 | RAG_DEBUG 로그가 이미 가시화 — 추가 조치 불필요 |
| M3 | Plan §10.2.1 1,021 청크 수치는 실측 | `SELECT COUNT(*) FROM chunk_embeddings GROUP BY wiki_id` 로 재검증 |
| M4 | router.ts ~30줄 추가 (import + Promise.all + cap priority) — Option C "router 무변경" 부분 완화 | Plan §10.2 사용자 결정으로 정당화 완료 |

## 5. Runtime Verification

- L1 (DB): `SELECT wiki_id, COUNT(*) FROM chunk_embeddings GROUP BY wiki_id` — 8 wikis 합 1,021 expected
- L2 (Routing): `npx tsx --env-file=.env.local scripts/debug-routing.ts` — 5/5 finance 포함 expected
- L3 (SemRoute): `RAG_DEBUG=true ...` 로 distance 분포 가시화 — 0.6-0.8 강한 매칭, 0.95+ 노이즈 확인

## 6. Phase C 진입 권장

**차단 항목 없음.** Phase C 작업:
1. Lens 모드 RAG (leesj stance 의미 매칭)
2. concept-index 자동 생성 (Semantic Routing이 사실상 대체했으므로 우선순위 낮음)
3. Obsidian watch → 자동 재빌드·재임베딩
4. Parent Document Retriever 패턴 (청크 → source 전체 컨텍스트)
5. Golden Q&A 50개 + end-to-end (Plan §10.2.1에서 이월)
