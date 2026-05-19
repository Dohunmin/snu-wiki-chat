# Plan: Synthesis Write-back — snu-wiki-chat → Obsidian 복리 합류

> **Feature**: synthesis-writeback
> **Date**: 2026-05-30
> **Phase**: Plan (ready for `/pdca design synthesis-writeback`)
> **Architecture Hint**: Inbox 격리 패턴 (옵션 B, 본인 결정)
> **Related**: [docs/references/karpathy-llm-wiki-comparison.md](../../references/karpathy-llm-wiki-comparison.md)

---

## Executive Summary

| 항목 | 내용 |
|---|---|
| **Problem** | snu-wiki-chat 챗 UI에서 "위키에 저장" 누른 답변이 Vercel Postgres `syntheses` 테이블에만 머무름. 본인 Obsidian의 *복리 학습 시스템*(§F/§S/§T/§L)에 환류 안 됨 → 외부 사용자(평가단·관리자)의 좋은 질문이 Karpathy 패턴의 *compounding* 효과에 합류 못 함 |
| **Solution** | **Inbox 격리 패턴** — DB syntheses → 로컬 sync 스크립트 → `Obsidian/wiki/syntheses/_inbox/` 격리 → 본인 검토 후 본 폴더 승격. §5.1 라우팅 규칙 그대로 적용 (Main vs Sub). Vercel serverless ↔ 로컬 Obsidian 갭은 sync 스크립트로 해결 |
| **UX Effect** | 외부 사용자가 던진 좋은 질문/답변이 본인 검토 게이트를 거쳐 Obsidian wiki에 통합 → 다음 RAG 사이클에서 회수 → *복리 시작*. 본인 워크플로우는 거의 안 바뀜 (watch 명령에 sync만 추가) |
| **Core Value** | Karpathy 패턴 100% 완성. *"explorations compound in the knowledge base just like ingested sources"* 의 마지막 다리. 거버넌스 도구로서 *통제된 축적* 가치 유지 |

---

## Context Anchor

| 항목 | 내용 |
|---|---|
| **WHY** | Karpathy LLM Wiki 패턴의 핵심: *"good answers can be filed back into the wiki as new pages"*. 본인 Obsidian setup은 *내부 작업*은 95% 완성, *snu-wiki-chat 외부 답변 환류*만 빠짐. 다른 사용자(평가단·총장 후보자) 좋은 질문이 1회성으로 휘발됨 |
| **WHO** | 도훈민(Inbox 검토자·승격 결정자) + 향후 챗 UI 사용자들(질문 제공자). Obsidian Agent(Claude Code)가 §L lint·통합 처리 |
| **RISK** | (R1) Vercel serverless → 로컬 Obsidian 직접 write 불가 → 로컬 sync 스크립트로 우회. (R2) 자동 통합 시 외부 답변이 검증 없이 본인 지식 베이스 오염 → Inbox 격리로 회피. (R3) DB와 파일시스템 정합성 (같은 synthesis 중복 sync) → synthesis_id 기반 멱등성. (R4) Inbox 자료가 lint 8개 체크 항목 통과 못 할 수 있음 → 검토 단계에서 §F/§S/§T 적합성 확인 |
| **SUCCESS** | (1) 챗 저장 → 다음 sync 사이클에서 Inbox에 markdown 도착. (2) §5.1 라우팅 규칙 자동 준수 (Main vs Sub). (3) 본인 승격 후 다음 RAG에 회수 가능 (복리 닫힘). (4) 멱등성 — 동일 synthesis 두 번 sync 안 됨. (5) 자동 통합 안 함 (옵션 A 명시 거부) |
| **SCOPE** | **신규**: `scripts/sync-syntheses-to-obsidian.ts`, Inbox 디렉토리 규약. **수정 최소**: `lib/db/schema.ts` (sync 상태 컬럼), `scripts/watch.ts` (주기적 sync 통합), `app/api/wiki/syntheses/route.ts` (synthesis_id 반환 확실히), Obsidian/CLAUDE.md (§5에 Inbox 워크플로우 추가). **비스코프**: 자동 통합·양방향 sync·Conflict resolution |

---

## 1. 현재 한계와 갭

### 1.1 Karpathy 패턴 기준 종합 평가

본인 Obsidian setup은 [karpathy-llm-wiki-comparison.md](../../references/karpathy-llm-wiki-comparison.md) 분석 결과 **Karpathy 패턴 95%+ 구현**. 단 하나의 갭:

```
✅ Obsidian Agent (Claude Code) — Karpathy 패턴 95% 완성
   ├─ ingest: raw → wiki LLM 자동 수행
   ├─ query: wiki → 답변, Sub Agent drill-down
   ├─ syntheses 저장: Main vs Sub 분리 (§5.1)
   ├─ lint: §L 8개 체크, 활동 카운터 5회 트리거
   └─ log.md append-only

❌ snu-wiki-chat (Vercel 웹앱) → Obsidian 환류
   └─ DB syntheses 테이블 저장만, Obsidian wiki 미반영
      → 외부 답변이 *복리 시스템 밖*에 머무름
```

### 1.2 갭의 실질적 영향

snu-wiki-chat 사용자가 다음과 같은 좋은 답변 받았다고 가정:

```
질문: "이석재와 유홍림의 AI 정책 비교"
답변: ⭐ 매우 풍부한 cross-wiki 분석 (4개 위키 인용)
사용자가 "위키에 저장" 클릭
   ↓
현재: DB syntheses 테이블에만 저장
   ↓
이후 본인이 동일 또는 유사 질문 던졌을 때:
   - RAG가 그 synthesis를 회수 못 함 (DB에는 있지만 Obsidian에 없어서)
   - 본인 Obsidian Agent는 그 답변 자체를 모름
   - → 같은 분석을 *처음부터* 다시 해야 함
   - → 복리 X
```

### 1.3 §5.1의 *공식 라우팅 규칙*은 이미 있음

본인 Obsidian/CLAUDE.md §5.1:

| 질의 유형 | 저장 위치 | 이유 |
|---|---|---|
| 교차 질의 (2개+ Wiki 통합) | **Main** `wiki/syntheses/` | 통합 분석은 Main 레벨에서만 존재 |
| 단일 Wiki 깊은 분석 | **해당 Sub** `wiki/syntheses/` | Sub Wiki 내부 지식으로 완결 |
| 단순 조회 | 저장 X | 재활용 가치 없음 |

→ **이 규칙을 sync 스크립트가 그대로 따르면 됨**. 새 규칙 만들 필요 X.

---

## 2. 해결 방식 — Inbox 격리 패턴 (옵션 B)

### 2.1 핵심 원칙

> *"외부 답변은 Inbox로 격리 → 본인 검토 후 정식 승격. 자동 통합 안 함."*

### 2.2 데이터 흐름

```
[사용자가 챗 UI에서 "위키에 저장" 클릭]
                ↓
[Vercel POST /api/wiki/syntheses]
  → DB syntheses 테이블에 INSERT (기존 동작 유지)
  → synced_to_obsidian: false (신규 컬럼)
                ↓
[로컬 노트북: npm run watch 가 주기 sync 실행 — 10분마다]
  scripts/sync-syntheses-to-obsidian.ts
  → DB에서 synced_to_obsidian=false 인 syntheses 조회
  → 각 synthesis에 대해 §5.1 라우팅 규칙 적용:
       routedTo.length === 1 → SNU_{wiki}_LLM_Wiki/wiki/syntheses/_inbox/
       routedTo.length >= 2  → Obsidian/wiki/syntheses/_inbox/
  → §5.2 frontmatter로 markdown 작성
  → DB syntheses.synced_to_obsidian = true 갱신
                ↓
[Inbox에 신규 .md 파일 존재]
                ↓
[본인의 Obsidian Agent (Claude Code) 작업 시]
  → §L lint 또는 본인 명시 요청으로 Inbox 점검
  → 각 inbox synthesis 검토:
       ✅ 좋은 자료: 본 폴더(wiki/syntheses/)로 이동 + status: active
       ❌ 별로: 삭제 (또는 _inbox/discarded/ 로 이동)
                ↓
[본 폴더로 이동된 synthesis]
                ↓
[npm run watch 가 변경 감지]
  → wiki:build → data/{wiki}.json 갱신
  → embed:build → chunk_embeddings에 추가
                ↓
[다음 RAG 쿼리에서 회수 가능] ✅ 복리 닫힘
```

### 2.3 디렉토리 구조 (신규)

```
Obsidian/
├── wiki/
│   ├── syntheses/              # 기존 (Main 교차 질의 저장)
│   │   └── _inbox/             # 🆕 외부 답변 격리
│   │       └── {date}-{slug}.md   # snu-wiki-chat에서 들어온 것
│   └── log.md
└── SNU_*_LLM_Wiki/
    └── wiki/
        ├── syntheses/          # 기존 (Sub 단일 분석 저장)
        │   └── _inbox/         # 🆕 외부 답변 격리
        │       └── {date}-{slug}.md
        └── log.md
```

### 2.4 §5.2 Frontmatter — 본인 명세 + 마커 2개

```yaml
---
type: synthesis
query: "{사용자 질문 원문}"
answered_at: 2026-05-30
routed_to: [vision, senate, finance, plan]
tags: []
status: pending-review            # 🆕 Inbox 상태 (기존 'active'와 구분)
source: snu-wiki-chat             # 🆕 외부 출처 마커
synthesis_id: nanoid-{db-id}      # 🆕 DB row 연결 (멱등성)
user_id: {user-id-hash}           # 🆕 출처 추적 (옵션)
---

# {질문}

## [중장기발전계획] 요약
{내용 + 인라인 출처}

## [평의원회] 요약
{내용 + 인라인 출처}

## [재무정보공시] 요약
{내용 + 인라인 출처}

## [대학운영계획] 요약
{내용 + 인라인 출처}

## 종합 분석
{LLM의 cross-wiki 종합}
```

본인 §5.2 명세에 *2개 마커만 추가*:
- `status: pending-review` (검토 통과 시 `active` 로 변경)
- `source: snu-wiki-chat` (Obsidian Agent가 외부 출처 식별)
- `synthesis_id: ...` (sync 멱등성)

---

## 3. 보존되어야 할 자산

| 영역 | 현재 동작 | After write-back | 변경 여부 |
|---|---|---|:---:|
| `POST /api/wiki/syntheses` API | DB 저장 + ID 반환 | 동일 (변경 없음) | ✅ 보존 |
| Obsidian Agent 워크플로우 | ingest·query·lint LLM 자동 | 동일 + Inbox 검토 단계 추가 | ✅ 보존 + 확장 |
| §F/§S/§T/§L 스키마 | LLM 강제 준수 | 동일 (Inbox→active 승격 시 §S 4-section 검증) | ✅ 보존 |
| `npm run watch` | Obsidian 변경 → 빌드 | 동일 + DB sync 추가 | ✅ 보존 + 확장 |
| P1~P8 원칙 | 유지 | 유지 | ✅ 보존 |
| §5.1 라우팅 규칙 | Obsidian 내부 적용 | sync 스크립트도 적용 | ✅ 보존 |
| 권한 다층 방어 | sensitive·adminOnly | 동일 (sync는 admin 사용자 답변만 대상? — Design에서 결정) | ✅ 보존 |
| Lens 모드 RAG | leesj 임베딩 + 의미 매칭 | 동일 | ✅ 보존 |

**변경되는 곳**:
- `lib/db/schema.ts` — `syntheses` 테이블에 컬럼 추가 (`synced_to_obsidian`, `synced_at`, `synced_to_path`)
- `app/api/wiki/syntheses/route.ts` — 응답에 synthesis_id 명시적 반환 (이미 nanoid 반환 중이지만 형식 확정)
- `scripts/watch.ts` — 주기적 sync trigger 추가
- `Obsidian/CLAUDE.md` §5 — Inbox 워크플로우 명시 추가

**신규**:
- `scripts/sync-syntheses-to-obsidian.ts` — 핵심 sync 로직
- `drizzle/00xx_synthesis_sync_columns.sql` — DB 마이그레이션

---

## 4. 데이터 모델 변경

### 4.1 syntheses 테이블 확장

```sql
ALTER TABLE syntheses
  ADD COLUMN synced_to_obsidian BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN synced_at TIMESTAMP,
  ADD COLUMN synced_to_path TEXT;

CREATE INDEX syntheses_unsynced_idx
  ON syntheses (created_at)
  WHERE synced_to_obsidian = FALSE;
```

### 4.2 Drizzle schema 갱신

```typescript
export const syntheses = pgTable('syntheses', {
  // ... 기존 컬럼
  syncedToObsidian: boolean('synced_to_obsidian').default(false).notNull(),
  syncedAt: timestamp('synced_at'),
  syncedToPath: text('synced_to_path'),  // e.g., "SNU_Senate_LLM_Wiki/wiki/syntheses/_inbox/2026-05-30-ai-비교.md"
});
```

---

## 5. 구현 단계 (Phase 1-5, ~3-5일)

### Phase 1 — DB schema + 마이그레이션 (0.5일)
- [ ] `drizzle/00xx_synthesis_sync.sql` 작성
- [ ] `lib/db/schema.ts` syntheses 컬럼 추가
- [ ] Neon에 마이그레이션 적용
- 검증: 컬럼 추가 확인, 기존 syntheses 데이터 영향 없음

### Phase 2 — sync 스크립트 신설 (1.5일) ★ 핵심
- [ ] `scripts/sync-syntheses-to-obsidian.ts` 작성
  - DB에서 `synced_to_obsidian=false` 조회
  - 각 row에 대해:
    - routedTo 길이 판정 → §5.1 경로 결정
    - slug 생성 (query → kebab-case)
    - markdown frontmatter 생성 (§5.2 + 마커 3개)
    - Inbox 디렉토리 생성 (없으면)
    - 파일 작성
    - DB 갱신 (synced_to_obsidian=true, synced_to_path)
  - 에러 핸들링: 파일 작성 실패 시 DB 갱신 안 함 (재시도 가능)
- [ ] `npm run sync:obsidian` 스크립트 추가
- 검증: 테스트용 synthesis 1개 → sync 실행 → Inbox에 파일 + DB 컬럼 갱신

### Phase 3 — watch 통합 (0.5일)
- [ ] `scripts/watch.ts` 에 주기적 sync 추가
  - setInterval(syncToObsidian, 10 * 60 * 1000) — 10분마다
  - 또는 SIGUSR1 신호로 수동 트리거
- 검증: watch 실행 중 챗 UI에서 저장 → 10분 후 Inbox에 자동 도착

### Phase 4 — Obsidian/CLAUDE.md 갱신 (0.5일)
- [ ] §5에 Inbox 워크플로우 추가:
  ```markdown
  ### 5.5 외부 답변 통합 (snu-wiki-chat write-back)
  
  외부 사용자가 snu-wiki-chat 웹앱에서 저장한 synthesis는 _inbox/ 격리.
  
  - 위치: Main `wiki/syntheses/_inbox/` 또는 Sub `SNU_*/wiki/syntheses/_inbox/`
  - 검토 트리거: §L lint 또는 본인 명시 요청
  - 통과 기준:
    * §F/§S/§T 스키마 적합
    * 출처 정확 (인라인 인용 검증)
    * 본인 위키 지식과 모순 없음 (있으면 모순 플래그 페이지 생성)
  - 승격: status: pending-review → active, _inbox/ → 본 폴더 이동
  - 거부: _inbox/discarded/ 로 이동 (감사 추적용 보존)
  ```
- 검증: Obsidian Agent가 갱신된 CLAUDE.md 읽고 워크플로우 인식

### Phase 5 — 회귀 검증 + 문서 (0.5일)
- [ ] 본인이 직접 챗 UI에서 저장 → 10분 후 Inbox 확인 → 본 폴더로 승격 → npm run watch가 wiki:build + embed:build → 다음 동일 쿼리에 회수 검증
- [ ] Golden Q&A 회귀 (기존 통과 18/20 유지)
- [ ] Vercel 배포 후 프로덕션 검증

---

## 6. 위험 및 완화

| Risk | 영향 | 완화 |
|---|:---:|---|
| **R1** Vercel serverless → 로컬 Obsidian 직접 write 불가 | 고 | 로컬 sync 스크립트로 우회 (1-way pull) — 본인 노트북에서 watch 실행 시 자동 |
| **R2** 외부 답변이 자동 통합되어 본인 지식 베이스 오염 | 고 | Inbox 격리 (옵션 B 채택), 본인 수동 검토 필수 |
| **R3** 같은 synthesis 두 번 sync (멱등성) | 중 | synthesis_id 기반 중복 체크, `synced_to_obsidian` 플래그 |
| **R4** 본인 노트북 꺼져 있으면 sync 지연 | 중 | 본인 수동 `npm run sync:obsidian` 가능, watch 실행 시 자동 |
| **R5** Inbox 검토 부담 누적 (방치 시 Inbox 쌓임) | 중 | §L lint에 Inbox 미검토 항목 카운트 추가 (8 → 9개 체크) |
| **R6** Slug 충돌 (같은 질문 여러 번) | 저 | date prefix + synthesis_id 일부 포함 (`2026-05-30-ai-비교-{id-4글자}.md`) |
| **R7** Inbox 자료가 §F/§S/§T 위반 (외부 LLM이 만든 거라 형식 차이) | 중 | sync 스크립트가 frontmatter 표준화 시도, 위반 시 검토 단계에서 본인이 §S/§F 강제로 재작성 |
| **R8** 권한 — 일반 사용자(tier2)의 synthesis도 sync해야 하나? | 저 | Design에서 결정. 기본 admin/tier1만 sync, tier2 답변은 *별도 폴더* `_inbox/tier2/` 또는 sync 제외 |

---

## 7. Success Criteria

| # | 기준 | 측정 |
|---|---|---|
| **SC1** | DB 신규 syntheses → Inbox 도착 (10분 이내) | 챗 저장 → 10분 후 Inbox 파일 존재 확인 |
| **SC2** | §5.1 라우팅 규칙 준수 | routedTo.length===1 → Sub Inbox, ≥2 → Main Inbox |
| **SC3** | §5.2 frontmatter + 마커 3개 모두 포함 | status: pending-review, source: snu-wiki-chat, synthesis_id 존재 |
| **SC4** | 멱등성 — 중복 sync 안 됨 | 같은 synthesis로 sync 두 번 실행 → 한 번만 작성 |
| **SC5** | 회귀 없음 | Golden Q&A 18/20 이상 유지 |
| **SC6** | 검토 승격 후 복리 시작 | Inbox → 본 폴더 이동 → next wiki:build → embed:build → RAG 회수 확인 |
| **SC7** | 자동 통합 안 함 (옵션 B 강제) | status: pending-review 인 synthesis는 Obsidian Agent가 active 자료로 사용 X |
| **SC8** | 권한 다층 방어 유지 | sensitive 표시된 답변은 sync 제외 또는 별도 격리 |
| **SC9** | Vercel 프로덕션 무영향 | API 응답 시간·에러율 변화 없음 (sync는 로컬에서만 작동) |

---

## 8. 의도적 비스코프 (Out of Scope)

| 항목 | 이유 | 후속 단계 |
|---|---|---|
| **자동 통합 (옵션 A)** | 본인 결정 — 통제된 축적 가치 우선 | 영구 비스코프 |
| **양방향 sync** (Obsidian 변경 → DB) | 현재 watch + wiki:build가 이미 충분 | 검토 후 결정 |
| **Conflict resolution** | 같은 query 여러 번 → date prefix로 자연 분리 | 충돌 빈도 봐서 추후 |
| **실시간 push** (Vercel → 본인 노트북) | 본인 노트북 항상 켜져 있지 않음 + 보안 복잡 | 검토 후 결정 |
| **공유 Obsidian** (팀 작업) | 현재 도훈민 1인 사용 가정 | Phase E 후보 |
| **자동 §F/§S/§T 보정** | 외부 답변 형식 다를 수 있으나 본인이 검토 시 수정 | Obsidian Agent가 검토 시 자동 수정 가능 |

---

## 9. 다음 단계

```
지금 → /pdca design synthesis-writeback
   3가지 아키텍처 옵션 (A 최소변경 / B 클린아키텍처 / C 실용균형) 제시
   본인 결정 → 구현 시작
```

### 권장 아키텍처 옵션 (Design에서 상세화 예정)
- **Option A — Minimal**: schema.ts 컬럼 추가 + sync 스크립트 1개. watch.ts에 setInterval 추가
- **Option B — Modular**: lib/sync/ 신규 디렉토리 (db-reader, markdown-writer, frontmatter-builder 분리)
- **Option C — Pragmatic**: scripts/sync-syntheses-to-obsidian.ts 단일 파일 + lib에서 frontmatter 유틸만 분리

기본 Recommendation: **C (Pragmatic)** — 단일 스크립트지만 frontmatter 유틸은 재사용 가능

---

## 10. 참고

- 비교 분석: [docs/references/karpathy-llm-wiki-comparison.md](../../references/karpathy-llm-wiki-comparison.md)
- Karpathy 원문: [docs/references/karpathy-llm-wiki.md](../../references/karpathy-llm-wiki.md)
- 본인 Obsidian schema: `c:/Users/USER/Desktop/Obsidian/CLAUDE.md` §5.1, §5.2, §L
- 기존 hybrid-rag PoC: [docs/01-plan/features/hybrid-rag.plan.md](hybrid-rag.plan.md)
- 기존 분석: [docs/03-analysis/hybrid-rag.analysis.md](../../03-analysis/hybrid-rag.analysis.md)

---

## 11. 실행 시 한 줄 트리거

```
/pdca design synthesis-writeback
```

→ 이 Plan이 자동 로딩되어 3가지 아키텍처 옵션 + Module Map + Session Guide가 Design 문서로 생성됨.
