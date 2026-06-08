'use client';

import { useState } from 'react';

interface WikiMeta {
  id: string;
  name: string;
  group?: string | null;
  counts: { sources: number; topics: number; entities: number; syntheses: number; facts: number; stances: number; overviews: number };
}

interface WikiNavProps {
  wikis: WikiMeta[];
  selected: { agentId: string; type: string; itemId: string } | null;
  onSelect: (agentId: string, type: string, itemId: string) => void;
}

const TABS = [
  { key: 'sources', label: '소스', color: 'bg-blue-100 text-blue-700' },
  { key: 'topics', label: '토픽', color: 'bg-purple-100 text-purple-700' },
  { key: 'entities', label: '엔티티', color: 'bg-green-100 text-green-700' },
  { key: 'syntheses', label: 'Synthesis', color: 'bg-amber-100 text-amber-700' },
  { key: 'facts', label: '팩트', color: 'bg-orange-100 text-orange-700' },
  { key: 'stances', label: '입장', color: 'bg-pink-100 text-pink-700' },
  { key: 'overviews', label: '개요', color: 'bg-teal-100 text-teal-700' },
] as const;

// 거버넌스 위키는 위키별 색, 단과대/대학원은 그룹 색.
const WIKI_COLORS: Record<string, string> = {
  senate: 'border-l-blue-500',
  board: 'border-l-purple-500',
  plan: 'border-l-green-500',
  vision: 'border-l-amber-500',
  history: 'border-l-orange-500',
  status: 'border-l-teal-500',
  'yhl-speeches': 'border-l-rose-500',
  finance: 'border-l-indigo-500',
  leesj: 'border-l-fuchsia-500',
};
const GROUP_COLOR: Record<string, string> = {
  '단과대': 'border-l-cyan-500',
  '대학원': 'border-l-violet-500',
};

function colorFor(wiki: WikiMeta): string {
  return WIKI_COLORS[wiki.id] ?? GROUP_COLOR[wiki.group ?? ''] ?? 'border-l-gray-400';
}

export default function WikiNav({ wikis, selected, onSelect }: WikiNavProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Record<string, string>>({});
  const [items, setItems] = useState<Record<string, Record<string, { id: string; title?: string; name?: string; query?: string }[]>>>({});
  const [loading, setLoading] = useState<string | null>(null);
  // 단과대·대학원 섹션은 기본 접힘(거버넌스만 펼침) — 초기 화면 간결 유지.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ '단과대': false, '대학원': false });

  async function expand(agentId: string) {
    if (expanded === agentId) { setExpanded(null); return; }
    setExpanded(agentId);
    if (items[agentId]) return;
    setLoading(agentId);
    const res = await fetch(`/api/wiki/${agentId}`);
    const data = await res.json();
    setItems(prev => ({
      ...prev,
      [agentId]: {
        sources: data.sources ?? [],
        topics: data.topics ?? [],
        entities: data.entities ?? [],
        syntheses: data.syntheses ?? [],
        facts: data.facts ?? [],
        stances: data.stances ?? [],
        overviews: data.overviews ?? [],
      },
    }));
    setLoading(null);
  }

  // 기본 탭 = 첫 번째 비어있지 않은 탭(단과대/대학원은 소스 0 → 개요·엔티티로 시작)
  function firstTab(wiki: WikiMeta): string {
    const t = TABS.find(tab => (wiki.counts[tab.key as keyof typeof wiki.counts] ?? 0) > 0);
    return t?.key ?? 'sources';
  }
  function getTab(wiki: WikiMeta) {
    return activeTab[wiki.id] ?? firstTab(wiki);
  }

  const renderCard = (wiki: WikiMeta) => (
    <div key={wiki.id} className={`rounded-xl border border-gray-200 overflow-hidden border-l-4 ${colorFor(wiki)}`}>
      <button
        onClick={() => expand(wiki.id)}
        className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-gray-50 text-left bg-white"
      >
        <div>
          <span className="text-sm font-semibold text-gray-800">{wiki.name}</span>
          <p className="text-xs text-gray-400 mt-1">
            {[
              wiki.counts.sources > 0 ? `소스 ${wiki.counts.sources}` : null,
              wiki.counts.topics > 0 ? `토픽 ${wiki.counts.topics}` : null,
              wiki.counts.entities > 0 ? `엔티티 ${wiki.counts.entities}` : null,
              (wiki.counts.facts ?? 0) > 0 ? `팩트 ${wiki.counts.facts}` : null,
              (wiki.counts.stances ?? 0) > 0 ? `입장 ${wiki.counts.stances}` : null,
              (wiki.counts.overviews ?? 0) > 0 ? `개요 ${wiki.counts.overviews}` : null,
            ].filter(Boolean).join(' · ') || '준비 중'}
          </p>
        </div>
        <span className="text-gray-400 text-lg">{expanded === wiki.id ? '▲' : '▼'}</span>
      </button>

      {expanded === wiki.id && (
        <div className="border-t border-gray-100 bg-gray-50">
          {/* 탭 */}
          <div className="flex flex-wrap gap-1.5 px-4 py-3">
            {TABS.filter(tab => (wiki.counts[tab.key as keyof typeof wiki.counts] ?? 0) > 0).map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(p => ({ ...p, [wiki.id]: tab.key }))}
                className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${
                  getTab(wiki) === tab.key
                    ? tab.color
                    : 'text-gray-500 bg-white border border-gray-200 hover:bg-gray-100'
                }`}
              >
                {tab.label}
                <span className="ml-1 opacity-70">({wiki.counts[tab.key as keyof typeof wiki.counts]})</span>
              </button>
            ))}
          </div>

          {loading === wiki.id ? (
            <div className="px-4 py-4 text-sm text-gray-400">불러오는 중...</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto border-t border-gray-100">
              {(items[wiki.id]?.[getTab(wiki)] ?? []).map(item => {
                const label = item.title ?? item.name ?? item.query ?? item.id;
                const isActive = selected?.agentId === wiki.id && selected?.type === getTab(wiki) && selected?.itemId === item.id;
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => onSelect(wiki.id, getTab(wiki), item.id)}
                      className={`w-full text-left px-4 py-2.5 text-sm border-b border-gray-100 last:border-0 transition-colors ${
                        isActive
                          ? 'bg-blue-50 text-blue-700 font-medium'
                          : 'text-gray-700 hover:bg-white'
                      }`}
                    >
                      <span className="line-clamp-2">{label}</span>
                    </button>
                  </li>
                );
              })}
              {(items[wiki.id]?.[getTab(wiki)] ?? []).length === 0 && (
                <li className="px-4 py-4 text-sm text-gray-400">항목 없음</li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );

  const governance = wikis.filter(w => !w.group);
  const colleges = wikis.filter(w => w.group === '단과대');
  const grads = wikis.filter(w => w.group === '대학원');

  // 단과대·대학원 = 거버넌스 카드와 *동급* 독립 위키집 폴더카드.
  //   클릭 → 하위 단과대/대학원 카드 목록 펼침 → 각 카드 클릭 → 탭(소스·엔티티·팩트·토픽…).
  //   = 거버넌스보다 깊이 1단계 더(폴더 → 목록 → 탭).
  const renderGroupCard = (title: string, list: WikiMeta[], border: string, icon: string) => {
    if (list.length === 0) return null;
    const open = openGroups[title];
    return (
      <div className={`rounded-xl border border-gray-200 overflow-hidden border-l-4 ${border}`}>
        <button
          onClick={() => setOpenGroups(p => ({ ...p, [title]: !p[title] }))}
          className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-gray-50 text-left bg-white"
        >
          <div>
            <span className="text-sm font-semibold text-gray-800">{icon} {title}</span>
            <p className="text-xs text-gray-400 mt-1">{list.length}개 위키 · 클릭해 펼치기</p>
          </div>
          <span className="text-gray-400 text-lg">{open ? '▲' : '▼'}</span>
        </button>
        {open && (
          <div className="border-t border-gray-100 bg-gray-50 p-2 space-y-2">
            {list.map(renderCard)}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-5 py-4 border-b border-gray-200">
        <p className="text-xs text-gray-400 mt-0.5">위키를 클릭해 소스·팩트·입장 등을 탐색하세요</p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* 거버넌스 — 항상 펼침 */}
        {governance.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-bold text-gray-500 tracking-wide px-2">거버넌스</p>
            {governance.map(renderCard)}
          </div>
        )}

        {/* 단과대 · 대학원 — 독립 위키집 폴더카드(클릭 → 하위 목록 → 각 위키 → 탭) */}
        {renderGroupCard('단과대', colleges, 'border-l-cyan-500', '🏛️')}
        {renderGroupCard('대학원', grads, 'border-l-violet-500', '🎓')}

        {/* 채팅 Synthesis */}
        <div className="rounded-xl border border-gray-200 overflow-hidden border-l-4 border-l-rose-400">
          <button
            onClick={() => onSelect('chat', 'syntheses', '__list')}
            className={`w-full flex items-center justify-between px-4 py-3.5 text-left transition-colors ${
              selected?.agentId === 'chat' ? 'bg-rose-50' : 'bg-white hover:bg-gray-50'
            }`}
          >
            <div>
              <span className="text-sm font-semibold text-gray-800">채팅 Synthesis</span>
              <p className="text-xs text-gray-400 mt-0.5">저장된 Q&A 모음</p>
            </div>
            <span className="text-xs px-2 py-1 bg-rose-100 text-rose-600 rounded-full">DB</span>
          </button>
        </div>
      </div>
    </div>
  );
}
