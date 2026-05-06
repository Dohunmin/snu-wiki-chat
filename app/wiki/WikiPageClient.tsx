'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import WikiNav from '@/components/wiki/WikiNav';
import WikiViewer from '@/components/wiki/WikiViewer';

interface WikiMeta {
  id: string;
  name: string;
  counts: { sources: number; topics: number; entities: number; syntheses: number; facts: number; stances: number; overviews: number };
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
      <div className="w-80 border-r border-gray-200 flex flex-col bg-gray-50 shrink-0">
        <div className="px-5 py-4 border-b border-gray-200 bg-white">
          <div className="flex items-center justify-between mb-3">
            <span className="font-bold text-gray-900 text-base">SNU 거버넌스 위키</span>
          </div>
          <Link
            href="/"
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            채팅으로 돌아가기
          </Link>
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
