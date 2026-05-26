'use client';

// Design Ref: §2.1 — 내/공개 대화 모달 JSX 중복(~50줄) 제거를 위한 공용 컴포넌트.
// variant로 색상만 분기 (mine=blue/lens=emerald, public=amber).

import type React from 'react';

export interface ConversationListItem {
  id: string;
  title: string | null;
  mode?: string;
  createdAt?: string;
}

interface ConversationsListModalProps {
  title: string;
  conversations: ConversationListItem[];
  currentConvId?: string;
  isReadOnlyCurrent: boolean;
  onSelect: (convId: string) => void;
  onDelete?: (convId: string, e: React.MouseEvent) => void;
  onClose: () => void;
  emptyText: string;
  variant?: 'mine' | 'public';
}

export function ConversationsListModal({
  title,
  conversations,
  currentConvId,
  isReadOnlyCurrent,
  onSelect,
  onDelete,
  onClose,
  emptyText,
  variant = 'mine',
}: ConversationsListModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 flex flex-col max-h-[70vh] mt-8"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">{title} ({conversations.length}개)</h2>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 text-base"
          >
            ✕
          </button>
        </div>
        <div className="overflow-y-auto flex-1 px-3 py-2 space-y-0.5">
          {conversations.length === 0 ? (
            <p className="px-3 py-4 text-xs text-gray-400">{emptyText}</p>
          ) : conversations.map(conv => {
            const isLens = variant === 'mine' && conv.mode?.startsWith('lens:');
            const isCurrent = currentConvId === conv.id && isReadOnlyCurrent;

            const rowBg = isCurrent
              ? variant === 'mine'
                ? 'bg-blue-50 border-l-blue-400'
                : 'bg-amber-50 border-l-amber-400'
              : isLens
              ? 'bg-emerald-50 hover:bg-emerald-100 border-l-emerald-400'
              : 'border-l-transparent hover:bg-gray-100';

            const titleClass = isCurrent
              ? variant === 'mine'
                ? 'text-blue-700 font-medium'
                : 'text-amber-700 font-medium'
              : 'text-gray-600';

            return (
              <div
                key={conv.id}
                className={`group flex items-center rounded-lg border-l-2 transition-colors ${rowBg}`}
              >
                <button
                  onClick={() => onSelect(conv.id)}
                  className={`min-w-0 flex-1 truncate px-3 py-2.5 text-left text-sm flex items-center gap-1.5 ${titleClass}`}
                >
                  {isLens && <span className="text-xs shrink-0">🎯</span>}
                  <span className="truncate">{conv.title ?? '(제목 없음)'}</span>
                </button>
                {onDelete && (
                  <button
                    onClick={(e) => onDelete(conv.id, e)}
                    className="mr-1.5 hidden shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-400 group-hover:flex"
                    title="삭제"
                  >
                    <TrashIconSmall />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TrashIconSmall() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
