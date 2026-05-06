'use client';

import { useState } from 'react';

interface WikiMeta {
  id: string;
  name: string;
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

const WIKI_COLORS: Record<string, string> = {
  senate: 'border-l-blue-500',
  board: 'border-l-purple-500',
  plan: 'border-l-green-500',
  vision: 'border-l-amber-500',
  history: 'border-l-orange-500',
  status: 'border-l-teal-500',
  'yhl-speeches': 'border-l-rose-500',
  finance: 'border-l-indigo-500',
};

export default function WikiNav({ wikis, selected, onSelect }: WikiNavProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Record<string, string>>({});
  const [items, setItems] = useState<Record<string, Record<string, { id: string; title?: string; name?: string; query?: string }[]>>>({});
  const [loading, setLoading] = useState<string | null>(null);

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

  function getTab(agentId: string) {
    return activeTab[agentId] ?? 'sources';
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-5 py-4 border-b border-gray-200">
        <p className="text-xs text-gray-400 mt-0.5">위키를 클릭해 소스·토픽·엔티티를 탐색하세요</p>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {wikis.map(wiki => (
          <div key={wiki.id} className={`rounded-xl border border-gray-200 overflow-hidden border-l-4 ${WIKI_COLORS[wiki.id] ?? 'border-l-gray-400'}`}>
            <button
              onClick={() => expand(wiki.id)}
              className="w-full flex items-center justify-between px-4 py-3.5 hover:bg-gray-50 text-left bg-white"
            >
              <div>
                <span className="text-sm font-semibold text-gray-800">{wiki.name}</span>
                <div className="flex gap-2 mt-1">
                  <span className="text-xs text-gray-400">소스 {wiki.counts.sources}</span>
                  <span className="text-xs text-gray-300">·</span>
                  <span className="text-xs text-gray-400">토픽 {wiki.counts.topics}</span>
                  <span className="text-xs text-gray-300">·</span>
                  <span className="text-xs text-gray-400">엔티티 {wiki.counts.entities}</span>
                </div>
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
                        getTab(wiki.id) === tab.key
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
                    {(items[wiki.id]?.[getTab(wiki.id)] ?? []).map(item => {
                      const label = item.title ?? item.name ?? item.query ?? item.id;
                      const isActive = selected?.agentId === wiki.id && selected?.type === getTab(wiki.id) && selected?.itemId === item.id;
                      return (
                        <li key={item.id}>
                          <button
                            onClick={() => onSelect(wiki.id, getTab(wiki.id), item.id)}
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
                    {(items[wiki.id]?.[getTab(wiki.id)] ?? []).length === 0 && (
                      <li className="px-4 py-4 text-sm text-gray-400">항목 없음</li>
                    )}
                  </ul>
                )}
              </div>
            )}
          </div>
        ))}

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
