'use client';

import { useState } from 'react';

interface WikiMeta {
  id: string;
  name: string;
  counts: { sources: number; topics: number; entities: number; syntheses: number };
}

interface WikiNavProps {
  wikis: WikiMeta[];
  selected: { agentId: string; type: string; itemId: string } | null;
  onSelect: (agentId: string, type: string, itemId: string) => void;
}

const TABS = [
  { key: 'sources', label: '소스' },
  { key: 'topics', label: '토픽' },
  { key: 'entities', label: '엔티티' },
  { key: 'syntheses', label: 'Synthesis' },
] as const;

export default function WikiNav({ wikis, selected, onSelect }: WikiNavProps) {
  const [expanded, setExpanded] = useState<string | null>(wikis[0]?.id ?? null);
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
        sources: data.sources,
        topics: data.topics,
        entities: data.entities,
        syntheses: [...(data.syntheses ?? [])],
      },
    }));
    setLoading(null);
  }

  function getTab(agentId: string) {
    return activeTab[agentId] ?? 'sources';
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 py-3 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-700">위키 탐색</h2>
      </div>

      {wikis.map(wiki => (
        <div key={wiki.id} className="border-b border-gray-100">
          <button
            onClick={() => expand(wiki.id)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 text-left"
          >
            <span className="text-sm font-medium text-gray-800">{wiki.name}</span>
            <span className="text-xs text-gray-400">{expanded === wiki.id ? '▲' : '▼'}</span>
          </button>

          {expanded === wiki.id && (
            <div className="pb-2">
              {/* 탭 */}
              <div className="flex gap-1 px-3 pb-2">
                {TABS.map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(p => ({ ...p, [wiki.id]: tab.key }))}
                    className={`text-xs px-2 py-1 rounded ${getTab(wiki.id) === tab.key ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-500 hover:bg-gray-100'}`}
                  >
                    {tab.label}
                    <span className="ml-1 text-gray-400">({wiki.counts[tab.key as keyof typeof wiki.counts]})</span>
                  </button>
                ))}
              </div>

              {loading === wiki.id ? (
                <div className="px-4 py-2 text-xs text-gray-400">불러오는 중...</div>
              ) : (
                <ul className="max-h-64 overflow-y-auto">
                  {(items[wiki.id]?.[getTab(wiki.id)] ?? []).map(item => {
                    const label = item.title ?? item.name ?? item.query ?? item.id;
                    const isActive = selected?.agentId === wiki.id && selected?.type === getTab(wiki.id) && selected?.itemId === item.id;
                    return (
                      <li key={item.id}>
                        <button
                          onClick={() => onSelect(wiki.id, getTab(wiki.id), item.id)}
                          className={`w-full text-left px-4 py-1.5 text-xs truncate ${isActive ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-50'}`}
                        >
                          {label}
                        </button>
                      </li>
                    );
                  })}
                  {(items[wiki.id]?.[getTab(wiki.id)] ?? []).length === 0 && (
                    <li className="px-4 py-2 text-xs text-gray-400">항목 없음</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>
      ))}

      {/* DB Syntheses */}
      <div className="border-b border-gray-100">
        <button
          onClick={() => onSelect('chat', 'syntheses', '__list')}
          className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 text-left"
        >
          <span className="text-sm font-medium text-gray-800">채팅 Synthesis</span>
          <span className="text-xs text-gray-400">DB</span>
        </button>
      </div>
    </div>
  );
}
