# Analysis: Hybrid RAG — Match Rate 93% (Session 1+2+3)

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
