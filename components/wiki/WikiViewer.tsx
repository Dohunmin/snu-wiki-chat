'use client';

import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type LiveBoard = { board: string; items: { title: string; date?: string; url: string }[]; sourceUrl: string | null; fetchedAt: string; fresh: boolean };

function relTime(iso: string): string {
  const h = (Date.now() - new Date(iso).getTime()) / 3.6e6;
  if (h < 1) return '방금 전 갱신';
  if (h < 24) return `${Math.round(h)}시간 전 갱신`;
  return `${Math.round(h / 24)}일 전 갱신`;
}

interface WikiViewerProps {
  selected: { agentId: string; type: string; itemId: string } | null;
}

export default function WikiViewer({ selected }: WikiViewerProps) {
  const [content, setContent] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [meta, setMeta] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [dbSyntheses, setDbSyntheses] = useState<{ id: string; query: string; answeredAt: string; routedTo: string[]; content: string }[]>([]);
  const [selectedSynth, setSelectedSynth] = useState<string | null>(null);
  const [liveBoards, setLiveBoards] = useState<LiveBoard[]>([]);

  useEffect(() => {
    if (!selected) return;

    if (selected.agentId === 'chat') {
      loadDbSyntheses();
      return;
    }

    // 최신 공지·뉴스(live_cache, Tier4) — board 리스트 뷰
    if (selected.type === 'liveBoards') {
      setLoading(true);
      fetch(`/api/wiki/${selected.agentId}`)
        .then(r => r.json())
        .then(data => { setLiveBoards(data.liveBoards ?? []); setTitle(''); setContent(''); setMeta({}); })
        .finally(() => setLoading(false));
      return;
    }

    setLoading(true);
    fetch(`/api/wiki/${selected.agentId}`)
      .then(r => r.json())
      .then(data => {
        type WikiItem = { id: string; title?: string; name?: string; query?: string; content: string; [key: string]: unknown };
        const ALL_TYPES = ['sources', 'facts', 'stances', 'overviews', 'topics', 'entities', 'syntheses'];

        const findItem = (type: string): WikiItem | undefined =>
          (data[type] as WikiItem[] | undefined)?.find(i => i.id === selected.itemId);

        let item = findItem(selected.type);
        if (!item) {
          // fallback: LLM이 타입 suffix 없이 인용한 경우 모든 타입에서 검색
          for (const t of ALL_TYPES) {
            if (t === selected.type) continue;
            item = findItem(t);
            if (item) break;
          }
        }

        if (!item) { setContent('항목을 찾을 수 없습니다.'); setTitle(''); return; }
        setTitle(item.title ?? item.name ?? item.query ?? item.id);
        setContent(item.content ?? '');
        const { id: _id, content: _c, title: _t, name: _n, query: _q, ...rest } = item;
        setMeta(rest);
      })
      .finally(() => setLoading(false));
  }, [selected]);

  async function loadDbSyntheses() {
    const res = await fetch('/api/wiki/syntheses');
    const data = await res.json();
    setDbSyntheses(data.syntheses ?? []);
    setContent('');
    setTitle('채팅 Synthesis 목록');
    setMeta({});
  }

  if (!selected) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        좌측에서 항목을 선택하세요
      </div>
    );
  }

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">불러오는 중...</div>;
  }

  // DB Synthesis 목록 뷰
  if (selected.agentId === 'chat') {
    const synth = selectedSynth ? dbSyntheses.find(s => s.id === selectedSynth) : null;
    return (
      <div className="flex-1 flex overflow-hidden">
        <div className="w-64 border-r border-gray-200 overflow-y-auto">
          <div className="px-4 py-3 border-b border-gray-100 text-sm font-medium text-gray-700">채팅 Synthesis</div>
          {dbSyntheses.length === 0 && (
            <div className="px-4 py-3 text-xs text-gray-400">저장된 synthesis가 없습니다</div>
          )}
          {dbSyntheses.map(s => (
            <button
              key={s.id}
              onClick={() => setSelectedSynth(s.id)}
              className={`w-full text-left px-4 py-3 border-b border-gray-50 text-xs hover:bg-gray-50 ${selectedSynth === s.id ? 'bg-blue-50 text-blue-700' : 'text-gray-700'}`}
            >
              <div className="font-medium truncate">{s.query}</div>
              <div className="text-gray-400 mt-0.5">{s.answeredAt}</div>
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {synth ? (
            <div className="md-body max-w-3xl">
              <h1 className="text-xl font-semibold mb-4">{synth.query}</h1>
              <div className="flex gap-2 mb-4 flex-wrap">
                {synth.routedTo?.map(r => (
                  <span key={r} className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">{r}</span>
                ))}
                <span className="text-xs text-gray-400">{synth.answeredAt}</span>
              </div>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{synth.content}</ReactMarkdown>
            </div>
          ) : (
            <div className="text-gray-400 text-sm">좌측에서 synthesis를 선택하세요</div>
          )}
        </div>
      </div>
    );
  }

  // 최신 공지·뉴스(live_cache) 뷰 — 항목 클릭 시 원문으로 이동
  if (selected.type === 'liveBoards') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl">
          <h1 className="text-xl font-semibold text-gray-900 mb-1">📰 최신 공지·뉴스</h1>
          <p className="text-xs text-gray-400 mb-4">게시판 캐시(자동 갱신, 일 2회) · 항목 클릭 시 원문으로 이동</p>
          {liveBoards.length === 0 && (
            <div className="text-gray-400 text-sm">갱신된 공지·뉴스가 없습니다. (크롤 미실행 또는 만료)</div>
          )}
          {liveBoards.map(b => (
            <section key={b.board} className="mb-6">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <h2 className="text-sm font-semibold text-gray-700">
                  {b.board === 'notice' ? '📌 공지' : b.board === 'news' ? '🗞️ 뉴스' : b.board}
                </h2>
                <span className="text-xs text-gray-400">{b.items.length}건</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${b.fresh ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                  {b.fresh ? '✓ 신선' : '⚠ 갱신 지연'} · {relTime(b.fetchedAt)}
                </span>
              </div>
              <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">
                {b.items.map((it, i) => (
                  <li key={i}>
                    <a href={it.url} target="_blank" rel="noopener noreferrer" className="block px-4 py-2.5 hover:bg-gray-50">
                      <span className="text-sm text-gray-700 line-clamp-2">{it.title}</span>
                      {it.date && <span className="text-xs text-gray-400 mt-0.5 block">{it.date}</span>}
                    </a>
                  </li>
                ))}
                {b.items.length === 0 && <li className="px-4 py-3 text-sm text-gray-400">항목 없음</li>}
              </ul>
            </section>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl">
        <h1 className="text-xl font-semibold text-gray-900 mb-3">{title}</h1>
        {Object.keys(meta).length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {/* tags/topics가 배열이 아닐 수 있음(단과대 빌드가 빈값을 "" 문자열로 내보냄) → Array.isArray 가드로 .map 크래시 방지 */}
            {(Array.isArray(meta.tags) ? meta.tags as string[] : []).map(t => (
              <span key={t} className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded-full">{t}</span>
            ))}
            {(Array.isArray(meta.topics) ? meta.topics as string[] : []).map(t => (
              <span key={t} className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full">{t}</span>
            ))}
            {meta.date != null && <span className="text-xs text-gray-400">{String(meta.date)}</span>}
            {meta.answeredAt != null && <span className="text-xs text-gray-400">{String(meta.answeredAt)}</span>}
          </div>
        )}
        <div className="md-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
