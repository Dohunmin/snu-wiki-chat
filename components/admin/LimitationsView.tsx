'use client';

// Design Ref: §2.8 — cluster 섹션 (복수 질문, 한계율 우선순위) + outlier 섹션 (단일 질문, 위키별 한계만).
// 갱신 버튼: batch 자동 반복으로 누적분 처리. 진행 표시 "batch N — M건 완료".

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { LimitationCluster, RefreshResult } from '@/lib/limitations/types';
import type { OutlierGroup, LimitationsApiResponse } from '@/app/api/admin/limitations/route';

const WIKI_LABELS: Record<string, string> = {
  senate: '평의원회', board: '이사회', plan: '대학운영계획', vision: '중장기발전계획',
  history: '70년역사', status: '대학현황', 'yhl-speeches': '유홍림총장연설',
  finance: '재무정보공시', leesj: '이석재 후보',
};

const WIKI_COLORS: Record<string, string> = {
  senate: 'bg-blue-50 text-blue-700 border-blue-200',
  board: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  plan: 'bg-amber-50 text-amber-700 border-amber-200',
  vision: 'bg-violet-50 text-violet-700 border-violet-200',
  history: 'bg-red-50 text-red-700 border-red-200',
  status: 'bg-gray-50 text-gray-700 border-gray-200',
  'yhl-speeches': 'bg-pink-50 text-pink-700 border-pink-200',
  finance: 'bg-teal-50 text-teal-700 border-teal-200',
  leesj: 'bg-orange-50 text-orange-700 border-orange-200',
};

type SortBy = 'rate' | 'limited' | 'recent';

export function LimitationsView() {
  const [data, setData] = useState<LimitationsApiResponse | null>(null);
  const [error, setError] = useState<string>('');
  const [wikiFilter, setWikiFilter] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('rate');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());     // cluster id or "out:wiki"
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [batchInfo, setBatchInfo] = useState<{ batchNum: number; totalProcessed: number } | null>(null);

  async function loadData() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/limitations?wiki=${wikiFilter}&sort=${sortBy}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? '데이터 로드 실패');
        setData(null);
      } else {
        setData(json);
        if (json.error) setError(json.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '네트워크 오류');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [wikiFilter, sortBy]);

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
        const result: RefreshResult = await res.json();
        totalProcessed += result.processed;
        setBatchInfo({ batchNum, totalProcessed });

        if (!result.hasMore) {
          if (totalProcessed === 0) {
            alert('새 질문이 없습니다. (DBSCAN/라벨링은 재계산됨)');
          } else {
            alert(`갱신 완료: ${totalProcessed}건 처리 (${batchNum} batch)`);
          }
          await loadData();
          break;
        }
      }
    } finally {
      setRefreshing(false);
      setBatchInfo(null);
    }
  }

  function toggleExpand(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // 위키 필터 옵션 (현재 데이터에 등장한 위키만)
  const wikiOptions = data
    ? Array.from(new Set([
        ...data.clusters.map(c => c.wiki),
        ...data.outliers.map(o => o.wiki),
      ].filter(Boolean))).sort()
    : [];

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <Link href="/admin" className="text-sm text-gray-400 hover:text-gray-700">← 관리자</Link>
          <h1 className="text-lg font-semibold text-gray-900">한계 답변 추적</h1>
        </div>
        <div className="flex items-center gap-3">
          {data && (
            <p className="text-xs text-gray-400">
              {data.updatedAt ? `갱신 ${new Date(data.updatedAt).toLocaleString('ko-KR')}` : ''}
            </p>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="px-3 py-1.5 bg-gray-900 text-white text-xs rounded-lg hover:bg-gray-700 disabled:bg-gray-300"
          >
            {refreshing && batchInfo
              ? `갱신 중... batch ${batchInfo.batchNum} (${batchInfo.totalProcessed}건)`
              : '지금 갱신'}
          </button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        {/* 요약 + 필터 */}
        <div className="bg-white rounded-xl border border-gray-100 p-4 flex flex-wrap items-center gap-4">
          {data && (
            <div className="flex gap-6 text-sm">
              <span>
                <span className="text-gray-400">총 질문</span>{' '}
                <span className="font-semibold text-gray-900">{data.totalCount}</span>
              </span>
              <span>
                <span className="text-gray-400">한계 답변</span>{' '}
                <span className="font-semibold text-red-600">{data.limitedCount}</span>
                <span className="text-xs text-gray-400 ml-1">
                  ({data.totalCount > 0 ? Math.round(data.limitedCount / data.totalCount * 100) : 0}%)
                </span>
              </span>
              <span>
                <span className="text-gray-400">클러스터</span>{' '}
                <span className="font-semibold text-gray-900">{data.clusters.length}</span>
              </span>
              <span>
                <span className="text-gray-400">단일 질문 (한계)</span>{' '}
                <span className="font-semibold text-gray-900">
                  {data.outliers.reduce((s, o) => s + o.limited, 0)}
                </span>
              </span>
            </div>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">위키</label>
            <select
              value={wikiFilter}
              onChange={e => setWikiFilter(e.target.value)}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5"
            >
              <option value="">전체</option>
              {wikiOptions.map(w => (
                <option key={w} value={w}>{WIKI_LABELS[w] ?? w}</option>
              ))}
            </select>
            <label className="text-xs text-gray-500 ml-2">정렬</label>
            <select
              value={sortBy}
              onChange={e => setSortBy(e.target.value as SortBy)}
              className="text-xs border border-gray-200 rounded-lg px-2 py-1.5"
            >
              <option value="rate">한계율</option>
              <option value="limited">한계 건수</option>
              <option value="recent">최신순</option>
            </select>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            {error}
          </div>
        )}

        {loading && !data && (
          <div className="text-center text-sm text-gray-400 py-12">로딩 중...</div>
        )}

        {data && data.clusters.length === 0 && data.outliers.length === 0 && !error && (
          <div className="text-center text-sm text-gray-400 py-12">
            한계 답변 데이터가 없습니다. 우측 상단 &ldquo;지금 갱신&rdquo; 버튼을 눌러 분석을 시작하세요.
          </div>
        )}

        {/* 클러스터 섹션 */}
        {data && data.clusters.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              📊 클러스터된 주제 ({data.clusters.length}개) <span className="text-xs text-gray-400 font-normal">— 복수 질문, 우선순위 신호</span>
            </h2>
            <div className="space-y-2">
              {data.clusters.map(c => (
                <ClusterCard
                  key={c.clusterId}
                  cluster={c}
                  expanded={expanded.has(`c:${c.clusterId}`)}
                  onToggle={() => toggleExpand(`c:${c.clusterId}`)}
                />
              ))}
            </div>
          </section>
        )}

        {/* outlier 섹션 */}
        {data && data.outliers.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              📌 단일 질문 — 한계 답변 ({data.outliers.reduce((s, o) => s + o.limited, 0)}건)
              <span className="text-xs text-gray-400 font-normal"> — 위키별로 그룹</span>
            </h2>
            <div className="space-y-2">
              {data.outliers.map(o => (
                <OutlierCard
                  key={o.wiki}
                  group={o}
                  expanded={expanded.has(`out:${o.wiki}`)}
                  onToggle={() => toggleExpand(`out:${o.wiki}`)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function ClusterCard({ cluster, expanded, onToggle }: { cluster: LimitationCluster; expanded: boolean; onToggle: () => void }) {
  const ratePct = Math.round(cluster.rate * 100);
  const rateColor = ratePct >= 75 ? 'text-red-600' : ratePct >= 40 ? 'text-amber-600' : 'text-gray-500';
  const wikiBadge = WIKI_COLORS[cluster.wiki] ?? 'bg-gray-50 text-gray-700 border-gray-200';

  return (
    <div className="bg-white rounded-xl border border-gray-100">
      <button onClick={onToggle} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50 rounded-xl">
        <span className={`shrink-0 px-2 py-0.5 text-xs rounded-md border ${wikiBadge}`}>
          {WIKI_LABELS[cluster.wiki] ?? cluster.wiki}
        </span>
        <span className="flex-1 text-sm text-gray-800 font-medium truncate">{cluster.label}</span>
        <span className="text-xs text-gray-500 shrink-0">
          {cluster.total}건 (한계 <span className={rateColor}>{cluster.limited}</span>, <span className={`font-semibold ${rateColor}`}>{ratePct}%</span>)
        </span>
        <span className="text-gray-300 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-3 space-y-3">
          {cluster.questions.length === 0 ? (
            <p className="text-xs text-gray-400">한계 답변이 없는 클러스터입니다. (이 주제는 자료가 충분)</p>
          ) : cluster.questions.map(q => (
            <div key={q.id} className="text-xs">
              <div className="flex items-start gap-2">
                <span className="shrink-0 mt-0.5 w-2 h-2 rounded-full bg-red-400" />
                <div className="flex-1 min-w-0">
                  <p className="text-gray-800 font-medium">{q.question}</p>
                  {q.limitationExcerpt && (
                    <p className="mt-1 px-2 py-1 bg-amber-50 border border-amber-100 rounded text-amber-800 whitespace-pre-line">
                      ⚠️ {q.limitationExcerpt}
                    </p>
                  )}
                  <p className="mt-1 text-gray-300">{new Date(q.createdAt).toLocaleString('ko-KR')}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OutlierCard({ group, expanded, onToggle }: { group: OutlierGroup; expanded: boolean; onToggle: () => void }) {
  const wikiBadge = WIKI_COLORS[group.wiki] ?? 'bg-gray-50 text-gray-700 border-gray-200';
  return (
    <div className="bg-white rounded-xl border border-gray-100">
      <button onClick={onToggle} className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-gray-50 rounded-xl">
        <span className={`shrink-0 px-2 py-0.5 text-xs rounded-md border ${wikiBadge}`}>
          {WIKI_LABELS[group.wiki] ?? group.wiki}
        </span>
        <span className="flex-1 text-sm text-gray-800">단일 질문 — 한계 답변 {group.limited}건</span>
        <span className="text-xs text-gray-400 shrink-0">전체 {group.total}건 중</span>
        <span className="text-gray-300 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-3 space-y-3">
          {group.questions.map(q => (
            <div key={q.id} className="text-xs">
              <div className="flex items-start gap-2">
                <span className="shrink-0 mt-0.5 w-2 h-2 rounded-full bg-red-400" />
                <div className="flex-1 min-w-0">
                  <p className="text-gray-800 font-medium">{q.question}</p>
                  {q.limitationExcerpt && (
                    <p className="mt-1 px-2 py-1 bg-amber-50 border border-amber-100 rounded text-amber-800 whitespace-pre-line">
                      ⚠️ {q.limitationExcerpt}
                    </p>
                  )}
                  <p className="mt-1 text-gray-300">{new Date(q.createdAt).toLocaleString('ko-KR')}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
