# Karpathy LLM Wiki 패턴 ↔ 본인 시스템 비교 (수정본)

> **작성일**: 2026-05-30 (initial), **재작성**: 2026-05-30 (Obsidian 실제 구조 확인 후 전면 수정)
> **참조**: [karpathy-llm-wiki.md](karpathy-llm-wiki.md)
> **결론 (수정)**: 본인 Obsidian setup은 Karpathy 패턴 **95% 이상 구현체**. 진짜 갭은 *snu-wiki-chat(웹앱) → Obsidian write-back* 단 한 군데.

---

## 0. 이전 분석의 오류 (자기 정정)

이 문서 초안에서 *"본인이 wiki를 직접 작성한다, 복리 점수 35%"* 라고 적었음. **완전 틀림.**

실제 본인 Obsidian setup 확인 후:
- `Obsidian/CLAUDE.md` — Main Agent schema (총 324 line, §1~§T 전체)
- `Obsidian/SNU_*_LLM_Wiki/CLAUDE.md` — 각 Sub Agent schema
- `wiki/log.md` — append-only 작업 로그 (lint·ingest·query 기록)
- `wiki/syntheses/` — query 답변 저장
- `§L 활동 카운터 Lint` — 5회 트리거, 8개 체크 항목 표준화
- 실제 ingest_batch (`2026-04-09 ingest_batch_3 — 19건 대량 ingest`)
- 실제 lint 실행 기록 (`2026-04-09-lint-2.md`)

→ **이미 Karpathy의 핵심 행동 패턴(ingest·query·lint)이 LLM Agent에 의해 자동 실행 중**. 사용자(도훈민)는 source 제공·질문·검토만 함.

---

## 1. 정확한 시스템 아키텍처 (3-layer 매핑)

| Karpathy 레이어 | 본인 실제 구현 | 평가 |
|---|---|:---:|
| **Raw sources** (immutable) | `Obsidian/SNU_*/raw/md/` — PDF→MD 변환된 회의록·연설·재무공시 | ✅ 100% |
| **The wiki** (LLM-maintained markdown) | `Obsidian/SNU_*/wiki/` — sources/topics/entities/syntheses/facts/stances/overviews. **LLM이 작성·유지** (lint 기록으로 검증) | ✅ 100% |
| **The schema** (LLM 운영 가이드) | `Obsidian/CLAUDE.md` (Main) + `Obsidian/SNU_*/CLAUDE.md` (Sub × 9) — §1~§T, §F/§S/§T/§L | ✅ 100% (Karpathy 명세 *초과* — §T topic catalog·§L lint counter 추가) |

추가 레이어 — Karpathy 명세에 *없는* 본인의 확장:

| 추가 요소 | 본인 구현 | 의미 |
|---|---|---|
| **Main Agent ↔ Sub Agent 분리** | Main이 라우팅, Sub × 9가 도메인 답변 | Multi-agent 오케스트레이션 (MIND 연결) |
| **Cross-wiki Topic 매트릭스** | §2.3 §T × Wiki coverage 표 | 후보 비교·교차 질의 가능 토픽 명시 |
| **Stance 4-section 강제** | §S — `핵심 입장 / 근거 발언(Quote 필수) / 맥락 / 관련` | 정치적 해석 금지 등 P-원칙 강제 |
| **Topic Slug 공식 카탈로그** | §T — kebab-case 한글 16개 slug | wiki 간 stance 비교 가능하게 만드는 핵심 메커니즘 |

→ 본인 시스템은 *Karpathy 명세를 거버넌스 도메인용으로 확장*한 것.

---

## 2. Operations 매핑 (수정)

### 2.1 Ingest
| Karpathy 명세 | 본인 실제 |
|---|---|
| 사용자가 source drop | ✅ raw/md/ 에 PDF→MD 변환 후 추가 |
| LLM이 source 읽고 *대화* | ✅ Claude Code agent가 사용자와 ingest 진행 |
| 요약 페이지 작성 | ✅ sources/{id}.md 자동 작성 |
| Entity/Topic 자동 업데이트 | ✅ 1 source가 10-15 페이지 갱신 (lint 기록 확인됨) |
| Index 갱신 | ✅ wiki/index.md 자동 |
| Log append | ✅ wiki/log.md `## [YYYY-MM-DD] ingest \|` 형식 |
| **batch ingest** | ✅ `ingest_batch_3 — 19건 대량` 같은 실제 기록 존재 |

→ **Karpathy 명세 100% 일치 + batch 확장**.

### 2.2 Query
| Karpathy 명세 | 본인 실제 |
|---|---|
| LLM이 wiki 검색 → 답변 | ✅ Sub Agent가 topic→entity→source drill down |
| 답변 형식 다양화 | 🟡 markdown 위주 (slide·chart는 미사용 — 거버넌스 도메인엔 markdown이 적합) |
| **답변을 wiki에 file** | ✅ wiki/syntheses/{date}-{slug}.md 자동 저장 |
| 교차 wiki 답변 → Main syntheses | ✅ `Obsidian/wiki/syntheses/` 분리 저장 (Sub와 다른 계층) |

→ **Karpathy 명세 +α** (Main vs Sub syntheses 분리는 본인 고유 발전).

### 2.3 Lint
| Karpathy 명세 | 본인 실제 |
|---|---|
| 정기 health check | ✅ §L 활동 카운터 5회 트리거 |
| 모순·stale·orphan 탐지 | ✅ 8개 체크 항목 (고아 / 양방향 깨짐 / 프론트매터 누락 / type-디렉토리 / Quote 누락 / last_updated 누락 / §S 위반 / §T 불일치) |
| 자동 수정 제안 | ✅ lint 결과 `🟡 우선순위 매김` 으로 후속 작업 큐 자동 생성 |

→ **Karpathy 명세 *초과*** — 활동 카운터 기반 *자동 트리거*는 Karpathy도 명시 안 한 디테일.

---

## 3. 진짜 갭 — *단 하나*

본인 *전체 시스템*에서 부족한 부분은 **단 한 곳**:

```
Obsidian Agent (Claude Code)
  ├─ ingest:  raw → wiki LLM 자동 ✅
  ├─ query:   wiki → 답변 LLM 자동 ✅
  ├─ syntheses 저장 → wiki/syntheses/ LLM 자동 ✅
  └─ lint:    LLM 자동 ✅

snu-wiki-chat (웹앱, 다른 사용자용)
  ├─ ingest:  Obsidian 변경 watch + wiki:build ✅ (이미 구현)
  ├─ query:   /api/chat RAG ✅
  ├─ 답변 저장: POST /api/wiki/syntheses → Vercel Postgres syntheses 테이블 ✅
  └─ ❌ 그 답변이 *Obsidian wiki로 환류 안 됨* ← 진짜 갭

  → 결과: 웹앱에서 생성된 좋은 답변이 Obsidian의 *복리 시스템 밖*에 머무름
```

### 갭의 의미

본인 혼자 Obsidian + Claude Code로 작업할 때는 복리 100% 작동 (LLM Agent가 syntheses 자동 작성). 하지만 **다른 사용자(예: 평가단·관리자)가 snu-wiki-chat 챗 UI에서 던진 좋은 질문·답변**은:
- DB(syntheses 테이블)에만 저장됨
- Obsidian의 LLM Agent는 그 답변을 모름
- 다음 ingest 사이클에서 Obsidian wiki에 반영 안 됨
- → 복리에 합류 못 함

---

## 4. 갭 닫는 방법 — Phase D-2 (Synthesis Write-back)

진짜로 필요한 단 하나의 추가 작업.

### 변경 사항

`POST /api/wiki/syntheses` 호출 시:

```typescript
// 현재
async function POST(req) {
  await db.insert(syntheses).values({...});   // DB만
  return { id };
}

// 수정 후
async function POST(req) {
  const id = await db.insert(syntheses).values({...}).returning();
  
  // 🆕 Obsidian wiki에도 markdown 파일 작성
  if (OBSIDIAN_PATH && shouldWriteToObsidian) {
    const filepath = `${OBSIDIAN_PATH}/${routedTo === 1 ? routedWikiFolder : 'wiki'}/syntheses/${date}-${slug}.md`;
    const content = buildSynthesisMarkdown({
      query, answeredAt, routedTo, tags, content,
      // §F/§S 스키마 frontmatter 준수
    });
    fs.writeFileSync(filepath, content);
  }
  
  return { id };
}
```

### 후속 자동 흐름 (이미 구현됨)

```
syntheses/{date}-{slug}.md 생성
  ↓
npm run watch 가 변경 감지
  ↓
wiki:build → data/{wiki}.json 갱신 (syntheses 배열에 신규 entry)
  ↓
embed:build → 그 synthesis도 임베딩 → chunk_embeddings 테이블 추가
  ↓
다음 RAG 쿼리에서 새 synthesis 자동 회수 가능 ← 복리 시작!
```

### 추가 필요 — Obsidian Agent에 알림

Obsidian Agent(Claude Code)가 *외부에서* 추가된 synthesis를 *모를 수 있음*. 두 방법:

**A. log.md에 자동 append** (snu-wiki-chat이 직접)
- Obsidian/wiki/log.md에 `## [{date}] external-synthesis | from snu-wiki-chat` 한 줄 추가
- 다음 lint 사이클에서 Obsidian Agent가 발견 → 적절히 통합

**B. 단순 파일만 작성** (passive)
- Obsidian Agent가 다음 lint에서 *고아 발견* → 자연스럽게 통합 큐에 들어감
- 이미 §L 8개 체크 항목 중 *고아 페이지* 검출이 있어 자동 작동

→ **B가 더 자연스러움**. 본인 §L 시스템이 알아서 처리.

---

## 5. 결론 — 수정된 시스템 평가

| 영역 | 점수 | 비고 |
|------|:----:|------|
| Karpathy 3-layer | 100% | Raw / Wiki / Schema 모두 정착 |
| Ingest 자동화 | 100% | LLM Agent가 자동 수행, batch 가능 |
| Query → wiki 저장 | 95% | Obsidian 내부는 완벽, snu-wiki-chat 외부 답변만 누락 |
| Lint 자동화 | 100% | §L 8개 체크, 활동 카운터 5회 트리거 |
| Cross-wiki | 100% | §T topic 매트릭스 + Main syntheses 분리 |
| **종합** | **~98%** | snu-wiki-chat의 syntheses write-back만 추가하면 100% |

→ 본인 시스템은 사실상 **Karpathy 패턴의 완성형 + 거버넌스 도메인 확장**. snu-wiki-chat은 *consumption layer* 역할에서 *contribution layer*로 한 발만 더 가면 완전체.

---

## 6. Phase D 진짜 우선순위 (재정렬)

| 순위 | 작업 | 본인 가치 | 비용 |
|:--:|------|---------|------|
| 🥇 | **D-2 Synthesis Write-back** | 외부 사용자 답변도 복리에 합류 | 3-5일 |
| (이전 안의 다른 D-항목들은 사실상 *불필요*) | | | |

이전에 내가 제안했던 D-1 Auto-Ingest·D-3 Lint·D-4 log.md 표준화는 **이미 Obsidian agent가 다 함**. snu-wiki-chat은 *retrieval layer* 역할만 잘하면 됨.

---

## 7. 한 줄 결론 (수정)

> **"본인 Obsidian setup은 Karpathy 패턴의 *교과서적 구현*이고, 더 나아가 거버넌스 도메인용으로 §S/§T/§L 확장됨. snu-wiki-chat에서 발생한 syntheses가 Obsidian에 환류되는 단 하나의 다리만 놓으면 100% 완성."**

내가 이전 초안에서 한 35% 평가는 *프로젝트 코드만 보고 추측한 결과*. 본인 Obsidian의 메타 시스템을 *직접 확인 안 한 잘못*. 본인의 정정 지적이 정확.
