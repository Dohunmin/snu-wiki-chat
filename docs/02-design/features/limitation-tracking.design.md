# Design: Limitation Tracking — Option C (Pragmatic) — 증분 처리 + Admin SSE 갱신

> **Feature**: limitation-tracking
> **Date**: 2026-05-27
> **Phase**: Design
> **Plan Reference**: [docs/01-plan/features/limitation-tracking.plan.md](../../01-plan/features/limitation-tracking.plan.md)
> **Architecture**: Option C — Pragmatic Balance (lib 3모듈, 단일 컴포넌트)

---

## 📌 Context Anchor (Plan에서 승계)

| 항목 | 내용 |
|---|---|
| **WHY** | 한계 답변이 흩어져 있어 자료 보충 우선순위 식별 불가 + 평가 모델 haiku/sonnet 불일치 + 매번 전체 재처리 (캐시 X) |
| **WHO** | 관리자 (admin) 전용 — 일반 사용자 노출 X |
| **RISK** | 첫 1회 5분 (batch 자동 반복) / Sonnet 한계 판정 정확도 / 동시 갱신 호출 충돌 / batch 자동 반복 중 네트워크 끊김 |
| **SUCCESS** | sonnet 통일 / 한계 정확도 ≥90% / 클러스터 평균 ≥2 / Admin 탭 작동 / SSE 진행률 / 비-admin 차단 / 증분 ~5초 |
| **SCOPE** | embed-questions thin wrapper + `lib/limitations/` 3모듈 + admin API 2개 + admin page + LimitationsView + AdminDashboard 탭 |

---

## 1. Overview

### 1.1 핵심 원칙

> **"단일 진실(`lib/limitations/refresh.ts`)이 한 호출당 최대 N건만 처리. CLI도 API도 hasMore=true이면 자동 다음 batch. Vercel timeout이 설계상 불가능."**

```
┌──────────────────────────────────────────────────────────────────────┐
│            단일 진실: lib/limitations/refresh.ts                       │
│                                                                      │
│   refresh({ maxNew: N }): Promise<RefreshResult>                     │
│     1. JSON 로드 → processedIds                                       │
│     2. DB 새 질문 fetch (LIMIT N+1 으로 hasMore 판정)                  │
│     3. 최대 N건만 Voyage 임베딩                                        │
│     4. Sonnet 평가 (concurrency 5)                                    │
│     5. DBSCAN 전체 재계산                                              │
│     6. 변경 클러스터만 Sonnet 라벨링                                   │
│     7. JSON 원자적 write                                               │
│   반환: { processed, hasMore, totalCount, durationMs }                │
└──────────────────────────────────────────────────────────────────────┘
            │                                  │
   ┌────────▼────────────┐         ┌──────────▼────────────────┐
   │ CLI (npm run)         │         │ API POST /refresh         │
   │ while (true) {        │         │ refresh({ maxNew: N })    │
   │   res = await refresh │         │ → JSON 응답                │
   │   if (!res.hasMore)   │         │                           │
   │     break             │         │ 클라이언트가:               │
   │ }                     │         │  while (true) {           │
   │ console.log progress  │         │    res = await fetch(...)│
   │                       │         │    if (!res.hasMore) break│
   │                       │         │  }                        │
   └───────────────────────┘         └──────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│ Admin /admin/limitations                                              │
│                                                                      │
│ GET /api/admin/limitations?wiki=...&sort=...                         │
│   → fs.readFile JSON → 필터·그룹·정렬 → JSON 응답                     │
│                                                                      │
│ LimitationsView                                                       │
│   - 위키 필터 / 정렬 토글                                              │
│   - 클러스터 카드 (한계율 X%, N건)                                     │
│   - 발췌 펼침                                                          │
│   - 우측 상단 "지금 갱신" 버튼 + batch 진행 표시                       │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.2 변경 영향 범위

| 영역 | 변경 | 위험 |
|---|---|:---:|
| `scripts/embed-questions.ts` | refresh() 호출하는 thin wrapper로 단순화 | 중 (기존 동작 보존 검증) |
| `lib/limitations/types.ts` | 신규 | 낮 |
| `lib/limitations/dbscan.ts` | 신규 (직접 구현) | 낮 (유닛 검증 가능) |
| `lib/limitations/refresh.ts` | 신규 (핵심 로직 + onProgress) | 중 (핵심) |
| `app/api/admin/limitations/route.ts` | 신규 (read-only) | 낮 |
| `app/api/admin/limitations/refresh/route.ts` | 신규 (SSE + lock) | 중 |
| `app/admin/limitations/page.tsx` | 신규 + admin 가드 | 낮 |
| `components/admin/LimitationsView.tsx` | 신규 (~250) | 중 |
| `components/admin/AdminDashboard.tsx` | "한계 답변" 탭 추가 | 낮 |
| Voyage / Anthropic / DB / 라우팅 / LLM 본문 | 무수정 | 없음 |

---

## 2. Module Specification

### 2.1 `lib/limitations/types.ts`

```ts
// Design Ref: §2.1 — API/UI/스크립트 공유 타입.

import type { Role } from '@/lib/auth/roles';

export interface LimitationQuestion {
  id: string;                          // DB messages.id (캐시 key)
  question: string;
  answer: string;                      // 답변 (전체)
  createdAt: string;                   // ISO
  routedAgents: string[];              // 라우팅 위키 ID들
  embedding: number[];                 // Voyage 1024차원 (cluster용)

  // Sonnet 평가
  quality: 'answered' | 'partial' | 'no_data';
  wiki: string;                        // 위키 ID (Sonnet 판정, 없으면 routedAgents[0] fallback)
  limitation: boolean;                 // 신규: 한계 명시 답변인가
  limitationExcerpt: string;           // 신규: 한계 부분 최대 300자

  // DBSCAN
  clusterId: number;                   // -1 = outlier
  clusterLabel?: string;               // outlier는 없음

  // 지식 지형도 호환 (기존 필드)
  pcaCoord: [number, number];
  placementWiki: string;
}

export interface LimitationsJsonFile {
  questions: LimitationQuestion[];
  clusterLabels: Record<number, { label: string; memberIds: string[] }>;  // 캐시
  updatedAt: string;
  totalCount: number;
}

export interface LimitationCluster {
  clusterId: number;                   // -1 → outlier 그룹
  wiki: string;                        // 클러스터 우세 위키
  label: string;                       // outlier면 "단일 질문"
  total: number;
  limited: number;
  rate: number;                        // limited / total
  questions: Array<{
    id: string;
    question: string;
    limitation: boolean;
    limitationExcerpt: string;
    createdAt: string;
  }>;
}

export interface RefreshResult {
  processed: number;     // 이번 batch에서 처리한 새 질문 수 (0 = 처리할 게 없음)
  hasMore: boolean;      // DB에 아직 미처리 질문이 더 있는가
  totalCount: number;    // JSON에 저장된 누적 총 질문 수
  durationMs: number;    // 이번 batch 소요 시간
  newClusterCount: number; // 이번 batch에서 새로 라벨링한 클러스터 수
}
```

### 2.2 `lib/limitations/dbscan.ts`

```ts
// Design Ref: §2.4 — 외부 의존 없는 DBSCAN. cosine distance.

/**
 * DBSCAN — Density-Based Spatial Clustering.
 * @returns clusterIds 배열 (-1 = outlier, 0+ = cluster index)
 */
export function dbscan(
  vectors: number[][],
  eps: number = 0.25,
  minPts: number = 2,
): number[] {
  const N = vectors.length;
  const labels = new Array<number>(N).fill(-2);  // -2 = unvisited
  let clusterId = 0;

  // 사전 계산: cosine distance matrix (N×N) — 137건 규모에선 OK
  const dist = (i: number, j: number): number => {
    const a = vectors[i], b = vectors[j];
    let dot = 0, na = 0, nb = 0;
    for (let k = 0; k < a.length; k++) {
      dot += a[k] * b[k];
      na += a[k] * a[k];
      nb += b[k] * b[k];
    }
    return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
  };

  function regionQuery(p: number): number[] {
    const neighbors: number[] = [];
    for (let q = 0; q < N; q++) {
      if (q !== p && dist(p, q) <= eps) neighbors.push(q);
    }
    return neighbors;
  }

  for (let p = 0; p < N; p++) {
    if (labels[p] !== -2) continue;
    const neighbors = regionQuery(p);
    if (neighbors.length < minPts - 1) {
      labels[p] = -1;  // outlier (변경 가능)
      continue;
    }

    labels[p] = clusterId;
    const seeds = [...neighbors];
    while (seeds.length > 0) {
      const q = seeds.shift()!;
      if (labels[q] === -1) labels[q] = clusterId;       // outlier → border
      if (labels[q] !== -2) continue;
      labels[q] = clusterId;
      const qNeighbors = regionQuery(q);
      if (qNeighbors.length >= minPts - 1) seeds.push(...qNeighbors);
    }
    clusterId++;
  }

  return labels;
}
```

### 2.3 `lib/limitations/refresh.ts` — Batch 단위

```ts
// Design Ref: §2.6 (Plan) — 한 호출당 maxNew건만 처리. hasMore=true이면 호출자가 다시 호출.

import fs from 'fs/promises';
import path from 'path';
import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { dbscan } from './dbscan';
import type { LimitationQuestion, LimitationsJsonFile, RefreshResult } from './types';

const JSON_PATH = path.join(process.cwd(), 'public/knowledge-map-questions.json');
const SONNET_MODEL = 'claude-sonnet-4-6';
const VOYAGE_MODEL = 'voyage-4-large';
const CONCURRENCY = 5;
const DBSCAN_EPS = 0.25;
const DBSCAN_MIN_PTS = 2;
// Design Ref: §5 — Do phase 실측 후 결정. 60s × 0.5 안전 margin / 건당 시간으로 산출.
// 초기 20건 = Sonnet ~3s/5건 batch × 4 = ~12s 예상.
export const DEFAULT_BATCH_SIZE = 20;

export async function refresh({ maxNew = DEFAULT_BATCH_SIZE }: { maxNew?: number } = {}): Promise<RefreshResult> {
  const t0 = Date.now();

  // 1. JSON 로드
  const existing = await loadJson();
  const processedIds = new Set(existing.questions.map(q => q.id));

  // 2. DB에서 미처리 질문 fetch — LIMIT (maxNew + 1)로 hasMore 판정
  //    NOT IN 보다는 EXISTS / LEFT JOIN이 나을 수 있지만 137~수천 건 규모면 NOT IN으로 충분
  const idsArr = Array.from(processedIds);
  const allRows = await fetchNewQuestionsFromDB(idsArr, maxNew + 1);
  const hasMore = allRows.length > maxNew;
  const batch = allRows.slice(0, maxNew);

  if (batch.length === 0) {
    return {
      processed: 0,
      hasMore: false,
      totalCount: existing.questions.length,
      durationMs: Date.now() - t0,
      newClusterCount: 0,
    };
  }

  // 3. Voyage 임베딩 (batch만)
  const newEmbeddings = await voyageEmbed(batch.map(r => r.question));

  // 4. Sonnet 평가 (concurrency 5)
  const judgements = await judgeBatch(batch);

  // 5. 신규 질문 객체
  const newQuestions: LimitationQuestion[] = batch.map((r, i) => ({
    id: r.id,
    question: r.question,
    answer: r.answer,
    createdAt: r.createdAt,
    routedAgents: r.routedAgents ?? [],
    embedding: newEmbeddings[i],
    quality: judgements[i].quality,
    wiki: judgements[i].wiki || r.routedAgents?.[0] || '',
    limitation: judgements[i].limitation,
    limitationExcerpt: judgements[i].excerpt,
    clusterId: -1,
    pcaCoord: [0, 0],
    placementWiki: r.routedAgents?.[0] || '',
  }));

  const merged = [...existing.questions, ...newQuestions];

  // 6. DBSCAN 전체 재계산 (137건 규모에선 ~수십 ms)
  const clusterIds = dbscan(merged.map(q => q.embedding), DBSCAN_EPS, DBSCAN_MIN_PTS);
  merged.forEach((q, i) => { q.clusterId = clusterIds[i]; });

  // 7. 클러스터 라벨링 (멤버 변경된 것만)
  const { labels: newLabels, newCount: newClusterCount } =
    await assignClusterLabels(merged, existing.clusterLabels);

  // 8. JSON 원자적 write — 매 batch 끝에 저장하므로 중간 끊겨도 진행분 보존
  const newJson: LimitationsJsonFile = {
    questions: merged,
    clusterLabels: newLabels,
    updatedAt: new Date().toISOString(),
    totalCount: merged.length,
  };
  await atomicWrite(JSON_PATH, JSON.stringify(newJson));

  return {
    processed: batch.length,
    hasMore,
    totalCount: merged.length,
    durationMs: Date.now() - t0,
    newClusterCount,
  };
}

/**
 * 모든 미처리 질문을 batch 자동 반복으로 전부 처리. CLI 스크립트가 호출.
 * 단순 wrapper — 각 batch마다 progress 콜백.
 */
export async function refreshAll(opts: {
  batchSize?: number;
  onBatch?: (batchNum: number, result: RefreshResult) => void;
} = {}): Promise<{ totalProcessed: number; totalBatches: number; durationMs: number }> {
  const t0 = Date.now();
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  let batchNum = 0;
  let totalProcessed = 0;
  while (true) {
    batchNum++;
    const result = await refresh({ maxNew: batchSize });
    totalProcessed += result.processed;
    opts.onBatch?.(batchNum, result);
    if (!result.hasMore) break;
    if (result.processed === 0) break;  // safety
  }
  return { totalProcessed, totalBatches: batchNum, durationMs: Date.now() - t0 };
}

async function loadJson(): Promise<LimitationsJsonFile> {
  try {
    const raw = await fs.readFile(JSON_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // 기존 knowledge-map-questions.json은 questions 배열만 있을 수 있음 — graceful upgrade
    return {
      questions: parsed.questions ?? parsed ?? [],
      clusterLabels: parsed.clusterLabels ?? {},
      updatedAt: parsed.updatedAt ?? '',
      totalCount: (parsed.questions ?? parsed ?? []).length,
    };
  } catch {
    return { questions: [], clusterLabels: {}, updatedAt: '', totalCount: 0 };
  }
}

async function atomicWrite(filePath: string, content: string) {
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, filePath);   // POSIX 원자적 (Windows에서도 일반 안전)
}

// fetchQuestionsFromDB, voyageEmbed, judgeBatchWithProgress, assignClusterLabels —
// 기존 embed-questions.ts에서 추출/이전 (생략 — 상세는 Do phase에서 구현)
```

**핵심 알고리즘 결정**:

- **클러스터 라벨 캐싱**: 기존 `clusterLabels`는 `{ [clusterId]: { label, memberIds[] } }` 형태. 새 클러스터링 결과의 `memberIds` set이 동일하면 기존 label 유지, 다르면 Sonnet 호출.
- **PCA 투영**: 기존 `knowledge-map-questions.json`의 PCA 로직(지식 지형도)은 별도 유지. 이번 PR에선 새 필드만 추가. 첫 갱신 시 기존 PCA 좌표 보존.
- **`existing.questions`의 embedding이 없는 경우**: 기존 JSON엔 embedding이 저장 안 됐음 ([embed-questions.ts:218](scripts/embed-questions.ts#L218)에서 result에 embedding 안 넣음). **첫 갱신 시 전체 재처리 불가피** — 137건 임베딩 한 번 더 (~5분, Plan §5 명시). 그 이후엔 증분.

### 2.4 `scripts/embed-questions.ts` (thin wrapper — batch 자동 반복)

```ts
// 기존 350줄 → ~30줄. refreshAll()이 모든 batch 자동 반복.
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}

import { refreshAll } from '@/lib/limitations/refresh';

async function main() {
  console.log('🚀 한계 답변 분석 갱신 시작...');
  const result = await refreshAll({
    onBatch: (batchNum, r) => {
      console.log(
        `  batch ${batchNum}: 처리 ${r.processed}건 (총 ${r.totalCount}건, ${(r.durationMs/1000).toFixed(1)}s)` +
        (r.hasMore ? ' → 다음 batch...' : '')
      );
    },
  });
  console.log(`\n✅ 완료: 총 ${result.totalProcessed}건 처리 (${result.totalBatches} batch, ${(result.durationMs/1000).toFixed(1)}s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
```

### 2.5 `app/api/admin/limitations/route.ts` (read-only)

```ts
import { auth } from '@/lib/auth/config';
import { canAccessAdmin } from '@/lib/auth/roles';
import fs from 'fs/promises';
import path from 'path';
import type { LimitationsJsonFile, LimitationCluster, LimitationQuestion } from '@/lib/limitations/types';

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user || !canAccessAdmin(session.user.role)) {
    return Response.json({ error: '관리자 전용' }, { status: 403 });
  }

  const url = new URL(req.url);
  const wikiFilter = url.searchParams.get('wiki') ?? '';
  const sortBy = (url.searchParams.get('sort') ?? 'limited') as 'limited' | 'rate' | 'recent';

  const raw = await fs.readFile(
    path.join(process.cwd(), 'public/knowledge-map-questions.json'), 'utf-8'
  );
  const json: LimitationsJsonFile = JSON.parse(raw);

  // 클러스터별 그룹핑
  const groups = groupByCluster(json.questions, json.clusterLabels);
  const filtered = wikiFilter ? groups.filter(g => g.wiki === wikiFilter) : groups;
  const sorted = sortClusters(filtered, sortBy);

  return Response.json({ clusters: sorted, totalCount: json.totalCount, updatedAt: json.updatedAt });
}

function groupByCluster(qs: LimitationQuestion[], labels: Record<number, { label: string; memberIds: string[] }>): LimitationCluster[] {
  const byCluster = new Map<number, LimitationQuestion[]>();
  for (const q of qs) {
    const arr = byCluster.get(q.clusterId) ?? [];
    arr.push(q);
    byCluster.set(q.clusterId, arr);
  }
  return Array.from(byCluster.entries()).map(([cid, items]) => ({
    clusterId: cid,
    wiki: dominantWiki(items),
    label: cid === -1 ? '단일 질문' : (labels[cid]?.label ?? `클러스터 ${cid}`),
    total: items.length,
    limited: items.filter(q => q.limitation).length,
    rate: items.filter(q => q.limitation).length / items.length,
    questions: items.map(q => ({
      id: q.id, question: q.question,
      limitation: q.limitation, limitationExcerpt: q.limitationExcerpt,
      createdAt: q.createdAt,
    })),
  }));
}

function dominantWiki(items: LimitationQuestion[]): string {
  const counts: Record<string, number> = {};
  for (const q of items) counts[q.wiki] = (counts[q.wiki] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

function sortClusters(clusters: LimitationCluster[], sortBy: string): LimitationCluster[] {
  if (sortBy === 'limited') return clusters.sort((a, b) => b.limited - a.limited);
  if (sortBy === 'rate') return clusters.sort((a, b) => b.rate - a.rate);
  // recent — 클러스터 내 가장 최근 question의 createdAt 기준
  return clusters.sort((a, b) => {
    const ma = Math.max(...a.questions.map(q => +new Date(q.createdAt)));
    const mb = Math.max(...b.questions.map(q => +new Date(q.createdAt)));
    return mb - ma;
  });
}
```

### 2.6 `app/api/admin/limitations/refresh/route.ts` (Batch POST + lock)

```ts
import { auth } from '@/lib/auth/config';
import { canAccessAdmin } from '@/lib/auth/roles';
import { refresh, DEFAULT_BATCH_SIZE } from '@/lib/limitations/refresh';

// In-memory lock — Vercel function 인스턴스 내. 다중 region 가능성 있지만 admin 단일 사용자 가정.
let refreshing = false;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || !canAccessAdmin(session.user.role)) {
    return Response.json({ error: '관리자 전용' }, { status: 403 });
  }

  if (refreshing) {
    return Response.json({ error: '이미 갱신 중입니다.' }, { status: 409 });
  }
  refreshing = true;

  try {
    // Query: ?batch=N (optional override). 기본은 DEFAULT_BATCH_SIZE.
    const url = new URL(req.url);
    const batchParam = url.searchParams.get('batch');
    const maxNew = batchParam ? Math.max(1, Math.min(100, parseInt(batchParam, 10))) : DEFAULT_BATCH_SIZE;

    const result = await refresh({ maxNew });
    return Response.json(result);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : '갱신 실패' },
      { status: 500 }
    );
  } finally {
    refreshing = false;
  }
}
```

SSE 안 씀 — 1 batch가 짧으니 단순 POST 응답으로 충분. 클라이언트가 `hasMore=true`이면 자동 재호출 (§2.8).

### 2.7 `app/admin/limitations/page.tsx`

```tsx
import { auth } from '@/lib/auth/config';
import { canAccessAdmin } from '@/lib/auth/roles';
import { redirect } from 'next/navigation';
import { LimitationsView } from '@/components/admin/LimitationsView';

export default async function LimitationsPage() {
  const session = await auth();
  if (!session?.user || !canAccessAdmin(session.user.role)) redirect('/');
  return <LimitationsView />;
}
```

### 2.8 `components/admin/LimitationsView.tsx`

핵심 props/state + batch 자동 반복:

```tsx
'use client';

import { useState, useEffect } from 'react';
import type { LimitationCluster, RefreshResult } from '@/lib/limitations/types';

const WIKI_LABELS = { senate: '평의원회', board: '이사회', ... };

export function LimitationsView() {
  const [clusters, setClusters] = useState<LimitationCluster[]>([]);
  const [wikiFilter, setWikiFilter] = useState('');
  const [sortBy, setSortBy] = useState<'limited' | 'rate' | 'recent'>('limited');
  const [expandedClusterIds, setExpandedClusterIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [batchInfo, setBatchInfo] = useState<{ batchNum: number; totalProcessed: number; lastBatch?: RefreshResult } | null>(null);
  const [updatedAt, setUpdatedAt] = useState('');
  const [totalCount, setTotalCount] = useState(0);

  async function loadData() {
    setLoading(true);
    const res = await fetch(`/api/admin/limitations?wiki=${wikiFilter}&sort=${sortBy}`);
    const data = await res.json();
    setClusters(data.clusters);
    setUpdatedAt(data.updatedAt);
    setTotalCount(data.totalCount);
    setLoading(false);
  }
  useEffect(() => { loadData(); }, [wikiFilter, sortBy]);

  // Batch 자동 반복 갱신
  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    let batchNum = 0;
    let totalProcessed = 0;

    try {
      while (true) {
        batchNum++;
        setBatchInfo({ batchNum, totalProcessed });

        const res = await fetch('/api/admin/limitations/refresh', { method: 'POST' });
        if (res.status === 409) {
          alert('이미 갱신 중입니다.');
          break;
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          alert(`갱신 실패: ${err.error ?? res.status}`);
          break;
        }

        const data: RefreshResult = await res.json();
        totalProcessed += data.processed;
        setBatchInfo({ batchNum, totalProcessed, lastBatch: data });

        if (!data.hasMore) {
          if (totalProcessed === 0) alert('새 질문이 없습니다.');
          else alert(`갱신 완료: 총 ${totalProcessed}건 처리 (${batchNum} batch)`);
          break;
        }
      }
      loadData();
    } finally {
      setRefreshing(false);
      setBatchInfo(null);
    }
  }

  return (
    <div className="...">
      {/* 헤더: 총 N건 · 마지막 갱신 시각 · 지금 갱신 버튼 */}
      {/* 필터: 위키 드롭다운 + 정렬 토글 */}
      {/* batchInfo 있으면: "batch {N} 처리 중 — {totalProcessed}건 완료" */}
      {/* 클러스터 카드들 — outlier(clusterId=-1)는 별도 섹션 */}
    </div>
  );
}
```

내부 sub-함수: `ClusterCard`, `RefreshBar`, `FilterBar` 같은 함수 컴포넌트를 같은 파일 안에.

### 2.9 `components/admin/AdminDashboard.tsx` (탭 추가)

```tsx
// 기존 탭/메뉴 구조 확인 후, "한계 답변" 링크 1줄 추가
<Link href="/admin/limitations" className="...">한계 답변</Link>
```

(AdminDashboard 현재 구조는 Do phase에서 확인)

---

## 3. API Contract

### 3.1 `GET /api/admin/limitations`

| 필드 | 타입 | 설명 |
|---|---|---|
| Query `wiki` | `string?` | 위키 ID 필터 (빈 값=전체) |
| Query `sort` | `'limited'\|'rate'\|'recent'` | 정렬 키 (default `limited`) |
| 401 | `{error}` | 비인증 |
| 403 | `{error}` | non-admin |
| 200 | `{clusters: LimitationCluster[], totalCount: number, updatedAt: string}` | 성공 |

### 3.2 `POST /api/admin/limitations/refresh` (Batch)

| 항목 | 값 |
|---|---|
| Query `batch` | 1~100 (optional, default DEFAULT_BATCH_SIZE=20) |
| 401 | `{error}` |
| 403 | non-admin |
| 409 | `{error: "이미 갱신 중..."}` (lock) |
| 500 | `{error}` (Sonnet/Voyage/DB 실패) |
| 200 | `RefreshResult` — `{processed, hasMore, totalCount, durationMs, newClusterCount}` |

호출자는 `hasMore=true`이면 다시 호출해서 누적분 전부 처리. 한 batch가 짧으니(~10~20초) Vercel timeout 안전.

---

## 4. Data Model

`public/knowledge-map-questions.json` 형식 변경:

```json
// 기존
[{ "question": "...", "wiki": "...", ... }]

// 신규
{
  "questions": [
    {
      "id": "uuid",
      "question": "...",
      "answer": "...",
      "createdAt": "ISO",
      "routedAgents": ["plan"],
      "embedding": [0.1, 0.2, ...],

      "quality": "answered",
      "wiki": "plan",
      "limitation": true,                         // 신규
      "limitationExcerpt": "📝 한계\n트랙별 ...",  // 신규

      "clusterId": 3,                              // 신규
      "pcaCoord": [12.3, -4.5],
      "placementWiki": "plan"
    }
  ],
  "clusterLabels": {                               // 신규 — 캐시
    "0": { "label": "트랙별 연구평가 제도", "memberIds": ["uuid1", "uuid2"] },
    "1": { "label": "고가 장비 관리자 채용", "memberIds": ["uuid3"] }
  },
  "updatedAt": "2026-05-27T...",
  "totalCount": 137
}
```

**호환성**: 기존 `knowledge-map.html`은 배열 형태를 기대. 첫 갱신 시 형태 바뀌므로 HTML 측에서 `Array.isArray(data) ? data : data.questions`로 graceful fallback 필요. (Do phase에서 1줄 수정 추가)

---

## 5. State Management

### 5.1 클라이언트 (LimitationsView)

| state | 타입 | 용도 |
|---|---|---|
| clusters | `LimitationCluster[]` | API 응답 |
| wikiFilter | `string` | 위키 필터 |
| sortBy | `'limited'\|'rate'\|'recent'` | 정렬 키 |
| expandedClusterIds | `Set<number>` | 펼친 클러스터 ID |
| loading | `boolean` | 데이터 fetch 중 |
| refreshing | `boolean` | 배치 갱신 중 (자동 반복 진행 중) |
| batchInfo | `{batchNum, totalProcessed, lastBatch?} \| null` | batch 진행 표시용 |
| updatedAt, totalCount | `string`, `number` | 헤더 표시 |

### 5.2 서버 (refresh route)

- **In-memory lock**: 모듈 변수 `refreshing: boolean`
- Vercel 인스턴스가 여러 개인 경우 lock 미작동 — admin 단일 사용자 가정으로 수용. (필요 시 DB 또는 Redis-style lock으로 확장 가능, 이번엔 Out of Scope)

---

## 6. Test Plan

### 6.1 수동 검증 시나리오

| ID | 시나리오 | 기대 |
|---|---|---|
| T1 | `npm run knowledge:questions` (첫 갱신, 137건 전수) | batch 자동 반복, ~5분 내 완료, batch log 출력 |
| T2 | 두 번째 `npm run knowledge:questions` (변경 없음) | ~1초 내 종료 (batch 1회, processed=0, hasMore=false) |
| T3 | admin으로 `/admin/limitations` 진입 | 클러스터 카드 N개 표시, 한계율 % 표시 |
| T4 | tier1으로 `/admin/limitations` 진입 시도 | redirect `/` |
| T5 | "지금 갱신" 버튼 클릭 (새 질문 없음) | 1 batch → "새 질문 없음" alert |
| T6 | DB에 새 질문 50건 만든 후 "지금 갱신" 클릭 | batch 자동 3회 반복(20+20+10), 진행 표시 "batch 1/?, 2/?, 3/?", 완료 alert |
| T7 | 1 batch 응답 시간 | ≤ 30초 (Vercel timeout 60s 안전 margin) |
| T8 | T6 진행 중 다른 탭에서 갱신 클릭 | 409 응답, alert |
| T9 | 위키 필터 = `plan` 선택 | plan 위키 클러스터만 표시 |
| T10 | 정렬 = `한계율` 선택 | 한계율 100% 클러스터 상단 |
| T11 | 클러스터 카드 클릭 → 펼침 | 질문 리스트, 한계 발췌 표시 |
| T12 | non-admin이 `POST /api/admin/limitations/refresh` 직접 호출 | 403 |
| T13 | batch 처리 중 네트워크 끊김(개발자 도구로 abort) → 다시 누름 | 중단된 시점 이후 batch부터 이어서 (JSON에 진행분 저장됐으니) |

### 6.2 유닛 (DBSCAN)

`lib/limitations/dbscan.ts`만 별도 테스트:
- 동일 점들 → 1 cluster
- 멀리 떨어진 점들 → 모두 outlier
- 2개 cluster + 1 outlier 케이스

(테스트 프레임워크 없어도 간단 console.assert로 검증, 별도 PR로 정식화 가능)

---

## 7. Implementation Order

1. **module-types**: `lib/limitations/types.ts` — 타입 정의 (가장 먼저, 다른 모듈이 의존)
2. **module-dbscan**: `lib/limitations/dbscan.ts` — 독립 알고리즘, 빠르게 검증 가능
3. **module-refresh**: `lib/limitations/refresh.ts` — 핵심 로직. 기존 embed-questions.ts에서 fetchQuestions/voyageEmbed/judgeBatch 추출 + 증분 로직 추가
4. **module-wrapper**: `scripts/embed-questions.ts` — thin wrapper로 단순화 + 동작 검증 (`npm run knowledge:questions` 1회 5분)
5. **module-readapi**: `app/api/admin/limitations/route.ts` — 그룹/필터/정렬
6. **module-sseapi**: `app/api/admin/limitations/refresh/route.ts` — SSE + lock
7. **module-page**: `app/admin/limitations/page.tsx` + admin 가드
8. **module-view**: `components/admin/LimitationsView.tsx` — 필터·정렬·카드·갱신·SSE 진행률
9. **module-nav**: `components/admin/AdminDashboard.tsx` — 탭 추가
10. **module-mapcompat**: `public/knowledge-map.html` — JSON 새 형식 호환 (`questions` 배열 추출)
11. **수동 검증**: T1~T10

### 핵심 분기점

- **Step 4 완료 후** dev 서버에서 첫 갱신 결과 확인:
  - DBSCAN 클러스터 수·평균 크기 — 만족 못하면 eps/minPts 튜닝 후 다시
  - 한계 라벨 정확도 spot check 10건
  - **1 batch 실측 시간** — `DEFAULT_BATCH_SIZE` 조정. 1 batch가 30s 안쪽 들어오면 OK, 안 들어오면 N 줄임
- **Step 7~9** 진행 중에는 `npm run dev`로 admin 페이지 동작 확인 단계별로.

---

## 8. Risks & Mitigations

| 위험 | 완화 |
|---|---|
| 기존 JSON에 embedding 필드 없음 → 첫 갱신 시 137건 전체 재임베딩 | Plan §5 명시. 첫 1회는 로컬에서 5분 수동 실행 후 커밋 |
| DBSCAN eps=0.25 결과가 의미없는 경우 (클러스터 0개 또는 137개 모두 outlier) | Step 4 결과 보고 0.20~0.30 범위에서 튜닝. 결과 만족 못하면 minPts=3 등 시도 |
| Sonnet 한계 판정 false positive/negative | spot check 10건 ≥9/10 통과 못하면 프롬프트 보강 (예시 추가). 정확도 80%대도 보충 의사결정엔 충분하니 perfectionism 회피 |
| Vercel function timeout (Pro 60s) | **Batch 처리로 설계상 제거됨**. 1 batch = ~10~20초 예상. Batch size N은 Do phase 실측 후 조정 가능 (refresh.ts DEFAULT_BATCH_SIZE 상수 1줄) |
| Batch 자동 반복 중 네트워크 끊김 | 각 batch마다 JSON write 완료 → 진행분 보존. 사용자 다시 누름 시 이어서 |
| Batch size N 결정 실패 (timeout 발생) | Do phase Step 4에서 batch 1건 시간 측정. 60s × 0.5 = 30s margin 안에 들도록 N 조정. 너무 작으면 호출 수 증가하지만 안전 |
| 동시 갱신 — Vercel 다중 region에서 lock 무력 | admin 단일 사용자 가정. 실측에서 충돌 발견되면 DB lock (limit_refresh_lock 테이블) 도입 (별도 PR) |
| 기존 knowledge-map.html이 새 JSON 형식 깨짐 | Step 10에서 `Array.isArray(data) ? data : data.questions` 1줄 fallback |
| LimitationsView 250줄 컴포넌트 — 가독성 | 내부 sub-함수로 ClusterCard, RefreshBar 등 분리. 별도 파일 X (재사용 X) |
| outlier 너무 많아 그룹핑 의미 약화 | UI에서 outlier 별도 섹션 분리. 일반 클러스터 = 보충 신호, outlier = 참고용 |

---

## 9. Out of Scope (Plan에서 명시)

- Obsidian 자료 자동 생성
- "보충 완료" 상태 추적 (체크박스/DB)
- Vercel Cron 매일 자동 갱신
- Slack/이메일 알림
- 지식 지형도 위 한계 마커 표시
- 사용자에게 한계 통계 노출
- DB 신규 테이블 (lock도 in-memory)
- 다중 region 동시성 처리 (admin 단일 사용자 가정)

---

## 10. Dependencies

- 외부 라이브러리 없음 (DBSCAN 직접 구현)
- 환경 변수 기존 그대로
- DB 마이그레이션 없음
- knowledge-map.html JSON 형식 변경 — Step 10에서 호환 처리
- 첫 1회 수동 `npm run knowledge:questions` 필요 (5분)
- 기존 admin middleware / `canAccessAdmin` 재사용
- SSE는 기존 `app/api/chat/route.ts` 패턴 재사용

---

## 11. Implementation Guide

### 11.1 Module Map

| 모듈 | 파일 | 역할 |
|---|---|---|
| `module-types` | `lib/limitations/types.ts` | LimitationQuestion / LimitationCluster / RefreshProgress 타입 |
| `module-dbscan` | `lib/limitations/dbscan.ts` | DBSCAN cosine distance 알고리즘 (독립) |
| `module-refresh` | `lib/limitations/refresh.ts` | 증분 fetch + Sonnet 평가 + 클러스터링 + 라벨 캐싱 + atomicWrite. onProgress 콜백 |
| `module-wrapper` | `scripts/embed-questions.ts` | refresh() 호출 thin wrapper (CLI 진행 출력만) |
| `module-readapi` | `app/api/admin/limitations/route.ts` | GET — JSON 읽고 그룹/필터/정렬 |
| `module-sseapi` | `app/api/admin/limitations/refresh/route.ts` | POST SSE — refresh() onProgress → SSE 변환 + lock |
| `module-page` | `app/admin/limitations/page.tsx` | Server component + admin 가드 |
| `module-view` | `components/admin/LimitationsView.tsx` | 필터·정렬·카드·갱신 버튼·SSE 진행률 |
| `module-nav` | `components/admin/AdminDashboard.tsx` | "한계 답변" 탭 링크 |
| `module-mapcompat` | `public/knowledge-map.html` | JSON 형식 graceful fallback 1줄 |

### 11.2 Recommended Session Plan

총 ~770줄, 신규 7파일. 단일 세션도 가능(~4~5h)이나 분할 권장:

| 세션 | 모듈 | 예상 |
|---|---|---|
| **세션 1 (백엔드 core)** | module-types, module-dbscan, module-refresh, module-wrapper | ~2.5h |
| **세션 2 (API + UI)** | module-readapi, module-sseapi, module-page, module-view, module-nav, module-mapcompat | ~2h |

세션 1 완료 후 `npm run knowledge:questions` 1회 실행 → DBSCAN·라벨 결과 검증 → 세션 2 진행. 분기점에서 클러스터 결과 만족 못하면 §2.4 파라미터 조정.

### 11.3 Session Guide

**전체**: `/pdca do limitation-tracking`

**백엔드만**: `/pdca do limitation-tracking --scope module-types,module-dbscan,module-refresh,module-wrapper`

**API+UI만**: `/pdca do limitation-tracking --scope module-readapi,module-sseapi,module-page,module-view,module-nav,module-mapcompat`

각 세션 시작 시 Do phase에서 Decision Record Chain + Success Criteria 체크리스트 표시.
