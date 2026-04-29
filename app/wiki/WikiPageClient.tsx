'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import WikiNav from '@/components/wiki/WikiNav';
import WikiViewer from '@/components/wiki/WikiViewer';

interface WikiMeta {
  id: string;
  name: string;
  counts: { sources: number; topics: number; entities: number; syntheses: number };
}

export default function WikiPageClient() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [wikis, setWikis] = useState<WikiMeta[]>([]);
  const [selected, setSelected] = useState<{ agentId: string; type: string; itemId: string } | null>(null);

  useEffect(() => {
    fetch('/api/wiki').then(r => r.json()).then(d => setWikis(d.wikis ?? []));
  }, []);

  // URL 파라미터로 초기 선택
  useEffect(() => {
    const agent = searchParams.get('agent');
    const type = searchParams.get('type');
    const id = searchParams.get('id');
    if (agent && type && id) setSelected({ agentId: agent, type, itemId: id });
  }, [searchParams]);

  const handleSelect = useCallback((agentId: string, type: string, itemId: string) => {
    setSelected({ agentId, type, itemId });
    router.replace(`/wiki?agent=${agentId}&type=${type}&id=${encodeURIComponent(itemId)}`, { scroll: false });
  }, [router]);

  return (
    <div className="flex h-screen bg-white">
      {/* 좌측 네비게이션 */}
      <div className="w-64 border-r border-gray-200 flex flex-col bg-gray-50 shrink-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <span className="font-semibold text-gray-800 text-sm">SNU 거버넌스 위키</span>
          <Link href="/" className="text-xs text-blue-600 hover:underline">채팅</Link>
        </div>
        <WikiNav wikis={wikis} selected={selected} onSelect={handleSelect} />
      </div>

      {/* 우측 콘텐츠 */}
      <div className="flex-1 flex overflow-hidden">
        <WikiViewer selected={selected} />
      </div>
    </div>
  );
}
