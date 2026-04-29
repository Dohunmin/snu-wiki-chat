'use client';

import { useState, useRef, useEffect } from 'react';
import { signOut } from 'next-auth/react';
import type { Role } from '@/lib/auth/roles';
import { canUpload, canAccessAdmin, ROLE_LABELS } from '@/lib/auth/roles';
import type { SourceRef } from '@/lib/agents/types';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  routedAgents?: string[];
  agentNames?: string[];
  sources?: SourceRef[];
  streaming?: boolean;
}

interface Conversation {
  id: string;
  title: string;
}

interface User {
  id: string;
  name?: string | null;
  role: Role;
}

export default function ChatPage({ user }: { user: User }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | undefined>();
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input.trim(),
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    const assistantId = crypto.randomUUID();
    setMessages(prev => [...prev, {
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
    }]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg.content, conversationId: currentConvId }),
      });

      if (!res.ok) throw new Error('요청 실패');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice(6));

          if (data.type === 'routing') {
            setMessages(prev => prev.map(m =>
              m.id === assistantId
                ? { ...m, routedAgents: data.agents, agentNames: data.agentNames }
                : m
            ));
            if (!currentConvId && data.conversationId) {
              setCurrentConvId(data.conversationId);
              setConversations(prev => [
                { id: data.conversationId, title: userMsg.content.slice(0, 30) + '...' },
                ...prev,
              ]);
            }
          }

          if (data.type === 'chunk') {
            setMessages(prev => prev.map(m =>
              m.id === assistantId
                ? { ...m, content: m.content + data.content }
                : m
            ));
          }

          if (data.type === 'sources') {
            setMessages(prev => prev.map(m =>
              m.id === assistantId
                ? { ...m, sources: data.refs, streaming: false }
                : m
            ));
          }
        }
      }
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId
          ? { ...m, content: '오류가 발생했습니다. 다시 시도해주세요.', streaming: false }
          : m
      ));
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function newConversation() {
    setMessages([]);
    setCurrentConvId(undefined);
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* 사이드바 */}
      <aside className="w-64 bg-white border-r border-gray-100 flex flex-col">
        <div className="p-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
              <span className="text-white text-xs font-bold">SNU</span>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">거버넌스 위키</p>
              <p className="text-xs text-gray-400">{ROLE_LABELS[user.role]}</p>
            </div>
          </div>
        </div>

        <div className="p-3">
          <button
            onClick={newConversation}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            새 대화
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 space-y-1">
          {conversations.map(conv => (
            <button
              key={conv.id}
              onClick={() => setCurrentConvId(conv.id)}
              className={`w-full text-left px-3 py-2 text-xs rounded-lg truncate transition-colors ${
                currentConvId === conv.id
                  ? 'bg-blue-50 text-blue-700'
                  : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              {conv.title}
            </button>
          ))}
        </div>

        <div className="p-3 border-t border-gray-100 space-y-1">
          {canUpload(user.role) && (
            <button className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:bg-gray-50 rounded-lg">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              자료 업로드
            </button>
          )}
          {canAccessAdmin(user.role) && (
            <a href="/admin" className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:bg-gray-50 rounded-lg">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              관리자
            </a>
          )}
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-400 hover:bg-gray-50 rounded-lg"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            로그아웃
          </button>
        </div>
      </aside>

      {/* 메인 채팅 영역 */}
      <main className="flex-1 flex flex-col">
        {/* 헤더 */}
        <header className="bg-white border-b border-gray-100 px-6 py-3 flex items-center justify-between">
          <h1 className="text-sm font-semibold text-gray-700">서울대학교 거버넌스 통합 위키</h1>
          <span className="text-xs text-gray-400">{user.name}</span>
        </header>

        {/* 메시지 영역 */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
          {messages.length === 0 && (
            <div className="text-center mt-20">
              <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <span className="text-blue-600 text-2xl font-bold">SNU</span>
              </div>
              <h2 className="text-lg font-semibold text-gray-700 mb-2">서울대 거버넌스 위키</h2>
              <p className="text-sm text-gray-400 max-w-sm mx-auto">
                평의원회, 이사회, 대학운영계획, 중장기발전계획에 관해 질문해보세요.
              </p>
              <div className="mt-6 flex flex-wrap gap-2 justify-center">
                {['이사회에서 시흥캠퍼스 논의가 있었나?', '2026년 주요 실행과제는?', '총장 선출 절차는?', '서울대 2040 비전은?'].map(q => (
                  <button
                    key={q}
                    onClick={() => { setInput(q); inputRef.current?.focus(); }}
                    className="px-3 py-1.5 text-xs bg-white border border-gray-200 rounded-full text-gray-600 hover:border-blue-300 hover:text-blue-600 transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(msg => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          <div ref={bottomRef} />
        </div>

        {/* 입력 영역 */}
        <div className="bg-white border-t border-gray-100 px-6 py-4">
          <div className="flex gap-3 items-end max-w-4xl mx-auto">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="질문을 입력하세요... (Enter로 전송, Shift+Enter로 줄바꿈)"
              rows={1}
              className="flex-1 px-4 py-3 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              style={{ maxHeight: '120px' }}
            />
            <button
              onClick={sendMessage}
              disabled={loading || !input.trim()}
              className="flex-shrink-0 w-10 h-10 bg-blue-600 text-white rounded-xl flex items-center justify-center hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? (
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-xl bg-blue-600 text-white rounded-2xl rounded-tr-sm px-4 py-3 text-sm">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 max-w-3xl">
      <div className="w-8 h-8 bg-gray-100 rounded-lg flex items-center justify-center flex-shrink-0 mt-1">
        <span className="text-xs font-bold text-gray-500">W</span>
      </div>
      <div className="flex-1">
        {message.agentNames && message.agentNames.length > 0 && (
          <div className="flex gap-1 mb-2 flex-wrap">
            {message.agentNames.map(name => (
              <span key={name} className="px-2 py-0.5 bg-blue-50 text-blue-600 text-xs rounded-full font-medium">
                {name}
              </span>
            ))}
          </div>
        )}
        <div className="bg-white border border-gray-100 rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
          {message.content}
          {message.streaming && <span className="inline-block w-1 h-4 bg-gray-400 animate-pulse ml-0.5" />}
        </div>
        {message.sources && message.sources.length > 0 && (
          <div className="flex gap-1 mt-2 flex-wrap">
            {message.sources.map((s, i) => (
              <span key={i} className="px-2 py-0.5 bg-gray-50 border border-gray-200 text-gray-500 text-xs rounded-full">
                [{s.wiki}] {s.page}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
