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
  const [search, setSearch] = useState('');                             // 질문 텍스트 검색
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
          await loadData();
          if (totalProcessed === 0) {
            alert('새 질문이 없습니다.');
          } else {
            alert(`갱신 완료: ${totalProcessed}건 처리.\n새로 추가된 한계 답변은 상단에 🆕 NEW로 표시됩니다.`);
          }
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

  // 질문 검색 — 매칭 질문이 있는 카드만, 매칭 질문만 노출 (client-side)
  const kw = search.trim().toLowerCase();
  const matchQ = (q: { question: string; limitationExcerpt: string }) =>
    !kw || q.question.toLowerCase().includes(kw) || q.limitationExcerpt.toLowerCase().includes(kw);

  const clusters = (data?.clusters ?? [])
    .map(c => kw ? { ...c, label: c.label, questions: c.questions.filter(matchQ) } : c)
    .filter(c => !kw || c.questions.length > 0 || c.label.toLowerCase().includes(kw));
  const outliers = (data?.outliers ?? [])
    .map(o => kw ? { ...o, questions: o.questions.filter(matchQ) } : o)
    .filter(o => !kw || o.questions.length > 0);
  const searching = kw.length > 0;

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
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="🔍 질문·발췌 검색"
              className="text-xs border border-gray-200 rounded-lg px-3 py-1.5 w-52 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-xs text-gray-400 hover:text-gray-700">✕</button>
            )}
            <label className="text-xs text-gray-500 ml-2">위키</label>
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

        {searching && clusters.length === 0 && outliers.length === 0 && (
          <div className="text-center text-sm text-gray-400 py-8">
            &ldquo;{search}&rdquo; 검색 결과 없음
          </div>
        )}

        {/* 클러스터 섹션 */}
        {clusters.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              📊 클러스터된 주제 ({clusters.length}개) <span className="text-xs text-gray-400 font-normal">— 복수 질문, 우선순위 신호</span>
            </h2>
            <div className="space-y-2">
              {clusters.map(c => (
                <ClusterCard
                  key={c.clusterId}
                  cluster={c}
                  expanded={searching || expanded.has(`c:${c.clusterId}`)}
                  onToggle={() => toggleExpand(`c:${c.clusterId}`)}
                />
              ))}
            </div>
          </section>
        )}

        {/* outlier 섹션 */}
        {outliers.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-3">
              📌 단일 질문 — 한계 답변 ({outliers.reduce((s, o) => s + o.questions.length, 0)}건)
              <span className="text-xs text-gray-400 font-normal"> — 위키별로 그룹</span>
            </h2>
            <div className="space-y-2">
              {outliers.map(o => (
                <OutlierCard
                  key={o.wiki}
                  group={o}
                  expanded={searching || expanded.has(`out:${o.wiki}`)}
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
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-800 font-medium truncate">{cluster.label}</span>
            {(cluster.newCount ?? 0) > 0 && (
              <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-bold rounded bg-blue-500 text-white">🆕 NEW {cluster.newCount}</span>
            )}
          </div>
          {/* 펼치기 전 대표 한계 발췌 1줄 미리보기 */}
          {!expanded && cluster.questions[0]?.limitationExcerpt && (
            <p className="text-[11px] text-gray-500 truncate mt-0.5">
              ⚠️ {cluster.questions[0].limitationExcerpt}
            </p>
          )}
        </div>
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
            <QuestionRow key={q.id} q={q} />
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
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-800">단일 질문 — 한계 답변 {group.questions.length}건</span>
            {(group.newCount ?? 0) > 0 && (
              <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-bold rounded bg-blue-500 text-white">🆕 NEW {group.newCount}</span>
            )}
          </div>
          {/* 펼치기 전 대표 한계 발췌 1줄 미리보기 */}
          {!expanded && group.questions[0]?.limitationExcerpt && (
            <p className="text-[11px] text-gray-500 truncate mt-0.5">
              ⚠️ {group.questions[0].limitationExcerpt}
            </p>
          )}
        </div>
        <span className="text-xs text-gray-400 shrink-0">전체 {group.total}건 중</span>
        <span className="text-gray-300 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-3 space-y-3">
          {group.questions.map(q => (
            <QuestionRow key={q.id} q={q} />
          ))}
        </div>
      )}
    </div>
  );
}

// 공통 질문 행 — NEW 배지 + 발췌 + 시각
function QuestionRow({ q }: {
  q: { id: string; question: string; limitationExcerpt: string; createdAt: string; isNew?: boolean }
}) {
  return (
    <div className="text-xs">
      <div className="flex items-start gap-2">
        <span className="shrink-0 mt-0.5 w-2 h-2 rounded-full bg-red-400" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            {q.isNew && (
              <span className="shrink-0 px-1 py-0.5 text-[10px] font-bold rounded bg-blue-500 text-white">🆕 NEW</span>
            )}
            <p className="text-gray-800 font-medium">{q.question}</p>
          </div>
          {q.limitationExcerpt && (
            <p className="mt-1 px-2 py-1 bg-amber-50 border border-amber-100 rounded text-amber-800 whitespace-pre-line">
              ⚠️ {q.limitationExcerpt}
            </p>
          )}
          <p className="mt-1 text-gray-300">{new Date(q.createdAt).toLocaleString('ko-KR')}</p>
        </div>
      </div>
    </div>
  );
}
