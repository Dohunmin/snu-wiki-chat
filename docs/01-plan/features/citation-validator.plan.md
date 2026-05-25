# Plan: Citation Validator — Perplexity 방식 번호 인용 (답변·출처 tight coupling)

> **Feature**: citation-validator
> **Date**: 2026-05-25
> **Phase**: Plan

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | LLM이 긴 source ID (`2026-운영계획-실행과제1`)를 정확히 출력 어렵고 비슷한 ID 혼동 → wrong-attribution. 동시에 sources 필드는 모든 retrieved 자료(~30개)를 저장 — LLM이 실제 인용한 것과 무관 |
| **Solution** | 서버가 컨텍스트의 각 unique source에 번호 [1], [2], ... 부여. LLM은 [N] 짧은 마커로만 인용. 서버가 스트리밍 중 [N] → `[위키] sid` resolve. sources 필드에는 LLM이 실제 인용한 것만 저장 |
| **UX Effect** | 답변·출처 1:1 매칭. "참고 자료" 목록 = LLM이 진짜 본 것만 (30개 → 3~7개). 인용 클릭 시 항상 정확한 source. 스트리밍 그대로 |
| **Core Value** | 답변과 출처가 코드 레벨에서 결합 — wrong-attribution 발생 구조적으로 차단 |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | 2026-05-25 실측 CMU/HCAI wrong-attribution + 답변/출처 분리 문제 동시 발견. 거버넌스 도구로서 신뢰성 직접 훼손 |
| **WHO** | 관리자(도훈민) + 향후 일반 사용자. 의사결정·연구 목적 |
| **RISK** | LLM이 시스템 프롬프트 무시하고 [N] 대신 옛 포맷 출력 가능. resolve 안 됨 → 깨진 [숫자] 표시 |
| **SUCCESS** | LLM이 [N] 형식 95%+ 준수. sources 필드 = 실제 인용된 것만 (retrieved의 일부). 스트리밍 유지 |
| **SCOPE** | `lib/llm/citations.ts` 신규 + `lib/llm/prompts.ts` P2 재작성 + `app/api/chat/route.ts` 스트리밍 buffer/resolve. UI 무수정 (기존 `[wiki] sid` 렌더러 그대로) |

---

## 1. 현재 문제

### 1.1 Wrong-attribution
실측: "AI 대학원" 질문 답변에 "SNU-CMU HCAI 2025.1.9. 설립" 사실을 `[대학운영계획] 2026-운영계획-실행과제1` 로 인용 → 그 source 본문에 CMU 한 단어도 없음. 진짜 출처는 `2026-섹션3-추진성과및기본방향`.

원인: 컨텍스트에 비슷한 source ID 다수 (`2026-운영계획-실행과제1~12`, `2026-섹션1~5` 등) → LLM이 긴 ID 정확히 매칭 못함.

### 1.2 답변·출처 분리
[route.ts:166](app/api/chat/route.ts#L166): `const allSources = routing.contexts.flatMap(c => c.sources)` → 라우팅이 가져온 모든 source(~30개)를 sources로 저장. LLM이 실제 인용한 것과 무관.

사용자 화면 "참고 자료": 30개 source 표시. 그 중 답변에 등장한 건 5~10개. 나머지 20개는 LLM이 안 본 자료.

---

## 2. 해결 — Perplexity 방식 번호 인용

### 2.1 핵심 아이디어
긴 source ID 대신 단순 번호 [1], [2]... 로 인용. LLM 부담 최소화 + 서버 resolve로 답변·출처 자동 결합.

### 2.2 흐름

```
서버: buildNumberedContexts(routing.contexts)
  → unique source N개에 번호 부여
  → 컨텍스트 본문 헤더에 [N] 마커 주입
  → mapping: { 1: {wiki, sid}, 2: {...}, ... }

LLM 컨텍스트:
  ## 인용 번호 매핑
  [1] [평의원회] 19기-7차
  [2] [평의원회] 19기-8차서면심의
  [3] [대학운영계획] 2026-섹션3-추진성과및기본방향
  ...

  ## 위키 자료 본문
  ## [3] 섹션 III ... (2026-섹션3-추진성과및기본방향)
  (본문...)

LLM 출력: "...설립되었습니다 [3]..."

서버: 스트리밍 중 buffer + resolve
  → 안전한 위치까지 [N] → "[대학운영계획] 2026-섹션3..." 치환
  → 클라이언트로 송신

응답 종료:
  → resolved fullContent 저장
  → cited 번호만 추출 → sources 필드 = LLM 실제 인용한 것만
```

### 2.3 효과
- **Wrong-attribution 차단**: LLM은 [3] 같은 짧은 번호만 출력. 긴 ID 혼동 불가
- **답변·출처 결합**: sources = `[wiki] sid` 텍스트에서 추출한 것 = LLM이 실제 인용
- **UI 무변경**: 서버에서 이미 [wiki] sid 형식으로 resolve. 기존 ChatPage.tsx 렌더러 그대로
- **스트리밍 유지**: safeFlushPoint로 부분 [N] 안전 처리 (chunk 경계에서 안 깨짐)

---

## 3. 구현 범위

| 파일 | 변경 | 라인 |
|---|---|---|
| `lib/llm/citations.ts` | 신규 | ~130 |
| `lib/llm/prompts.ts` | P2 재작성 + buildUserMessage 시그니처 변경 (contexts → numbered.markdown + summary) | ~30 변경 |
| `app/api/chat/route.ts` | buildNumberedContexts 호출 + 스트리밍 buffer/resolve + cited sources만 저장 | ~30 변경 |
| 신규 `scripts/test-citation-numbering.ts` | end-to-end 검증 | ~70 |

### 무수정
- `components/chat/*` — 서버가 [wiki] sid로 resolve해서 보내므로 기존 렌더러 작동
- DB 스키마
- `lib/embed/*` / router 등

---

## 4. Success Criteria

| ID | 기준 | 측정 |
|---|---|---|
| **SC1** | LLM 출력의 인용 95%+가 [N] 형식 준수 (옛 형식 미사용) | 실측 20건 분석 |
| **SC2** | sources 필드 = LLM 실제 인용 (전체 retrieved보다 작음) | DB 저장된 sources.length < routing.contexts.flatMap(c=>c.sources).length |
| **SC3** | 스트리밍 동작 유지 — 사용자 체감 latency 변화 없음 | 토큰 첫 도착 시간 측정 |
| **SC4** | CMU 케이스 재현 시 정확한 source로 인용 | 채팅 UI 실측 |
| **SC5** | resolve된 텍스트가 기존 UI 렌더러로 정상 클릭 가능 | 수동 검증 |

---

## 5. Risks

| 위험 | 완화 |
|---|---|
| LLM이 [N] 무시하고 옛 포맷 (`[위키] sid`) 사용 | 시스템 프롬프트 강한 규칙 + 절대 금지 명시. 옛 포맷도 ChatPage 렌더러로 표시는 됨 (graceful) |
| LLM이 범위 밖 [N] 출력 (mapping에 없는 숫자) | resolveText가 미매칭 [N]은 그대로 둠. UI에서 깨진 표시 (사용자 보고 LLM 실수 인지 가능) |
| 스트리밍 chunk 경계에 [N] 걸림 (e.g., "[" + "3]") | safeFlushPoint로 마지막 [ 위치까지만 flush. 다음 chunk 도착 시 통합 resolve |
| 같은 source 중복 인용 | extractCitedNumbers가 Set으로 중복 제거 |
| Lens 모드 stance 인용 | 동일 번호 매핑에 stance도 포함. 별도 처리 불필요 |

---

## 6. Out of Scope

- Embedding-based semantic validation — 번호 인용으로 wrong-attribution 100% 차단되므로 불필요
- LLM-as-judge 검증 — 동일
- Citation auto-rewrite — 동일
- Retry 메커니즘 — LLM이 [N] 잘 따르면 불필요
- UI에 [1], [2] 같은 번호 표시 — 사용자에겐 [wiki] sid 형식이 더 의미 있음
- Wiki browser / synthesis 자동 답변 검증 — 별도 feature

---

## 7. Dependencies

- 외부 라이브러리 없음
- 환경 변수 없음
- DB 마이그레이션 없음
- 기존 SSE 인프라 재사용
