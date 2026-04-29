'use client';

import { useState, useRef, useEffect } from 'react';
import { signOut } from 'next-auth/react';
import ReactMarkdown from 'react-markdown';
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
  error?: boolean;
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

const EXAMPLE_QUESTIONS = [
  '이사회에서 시흥캠퍼스 논의가 있었나?',
  '2026년 주요 실행과제는?',
  '서울대 2040 비전의 핵심은?',
  '평의원회와 이사회 쟁점을 비교해줘',
];

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

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [input]);

  async function sendMessage(messageText = input) {
    const trimmed = messageText.trim();
    if (!trimmed || loading) return;

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
    };

    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    const assistantId = crypto.randomUUID();
    setMessages(prev => [
      ...prev,
      { id: assistantId, role: 'assistant', content: '', streaming: true },
    ]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, conversationId: currentConvId }),
      });

      if (!res.ok || !res.body) {
        let detail = '응답을 생성하지 못했습니다.';
        try {
          const data = await res.json();
          if (data?.error) detail = data.error;
        } catch {
          // Keep the generic message.
        }
        throw new Error(detail);
      }

      const reader = res.body.getReader();
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
                { id: data.conversationId, title: trimmed.slice(0, 32) },
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

          if (data.type === 'error') {
            throw new Error(data.message || '오류가 발생했습니다.');
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '오류가 발생했습니다.';
      setMessages(prev => prev.map(m =>
        m.id === assistantId
          ? {
              ...m,
              content: `${message}\n\n환경변수, API 키, 또는 DB 연결 상태를 확인해 주세요.`,
              streaming: false,
              error: true,
            }
          : m
      ));
    } finally {
      setLoading(false);
      inputRef.current?.focus();
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
    setInput('');
    inputRef.current?.focus();
  }

  return (
    <div className="flex h-screen bg-white text-gray-900">
      <aside className="hidden md:flex w-72 shrink-0 flex-col border-r border-gray-200 bg-gray-50">
        <div className="flex h-14 items-center gap-3 px-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold text-white">
            SNU
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">SNU 거버넌스 위키</p>
            <p className="truncate text-xs text-gray-500">{ROLE_LABELS[user.role]}</p>
          </div>
        </div>

        <div className="px-3 py-2">
          <button
            onClick={newConversation}
            className="flex h-10 w-full items-center gap-2 rounded-lg px-3 text-sm font-medium text-gray-800 hover:bg-gray-200"
          >
            <PlusIcon />
            새 대화
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          <p className="px-3 pb-2 text-xs font-medium text-gray-400">최근 대화</p>
          {conversations.length === 0 ? (
            <p className="px-3 text-xs leading-5 text-gray-400">질문을 시작하면 대화가 여기에 표시됩니다.</p>
          ) : (
            <div className="space-y-1">
              {conversations.map(conv => (
                <button
                  key={conv.id}
                  onClick={() => setCurrentConvId(conv.id)}
                  className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm ${
                    currentConvId === conv.id
                      ? 'bg-gray-200 text-gray-950'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {conv.title}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-1 border-t border-gray-200 p-3">
          {canUpload(user.role) && (
            <button className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-gray-600 hover:bg-gray-200">
              <UploadIcon />
              자료 업로드
            </button>
          )}
          {canAccessAdmin(user.role) && (
            <a href="/admin" className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-gray-600 hover:bg-gray-200">
              <SettingsIcon />
              관리자
            </a>
          )}
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-gray-500 hover:bg-gray-200"
          >
            <LogoutIcon />
            로그아웃
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 px-4 md:px-6">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-xs font-bold text-white md:hidden">
              SNU
            </div>
            <h1 className="text-sm font-semibold md:text-base">SNU 거버넌스 위키</h1>
          </div>
          <div className="truncate text-xs text-gray-500 md:text-sm">
            {user.name || '사용자'}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <WelcomePanel onPickQuestion={sendMessage} />
          ) : (
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 py-8 md:px-6">
              {messages.map(msg => (
                <MessageBubble key={msg.id} message={msg} />
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="shrink-0 bg-white px-4 pb-4 pt-2 md:px-6">
          <div className="mx-auto max-w-3xl">
            <div className="flex items-end gap-2 rounded-3xl border border-gray-200 bg-white p-2 shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
              <button
                type="button"
                className="mb-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100"
                title="자료 추가"
                aria-label="자료 추가"
              >
                <PlusIcon />
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="SNU 거버넌스 자료에 대해 질문하세요"
                rows={1}
                className="max-h-40 min-h-10 flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-6 outline-none placeholder:text-gray-400"
              />
              <button
                onClick={() => sendMessage()}
                disabled={loading || !input.trim()}
                className="mb-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-900 text-white transition hover:bg-gray-700 disabled:bg-gray-200 disabled:text-gray-400"
                title="전송"
                aria-label="전송"
              >
                {loading ? <SpinnerIcon /> : <ArrowUpIcon />}
              </button>
            </div>
            <p className="mt-2 text-center text-xs text-gray-400">
              Enter로 전송, Shift+Enter로 줄바꿈
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

function WelcomePanel({ onPickQuestion }: { onPickQuestion: (question: string) => void }) {
  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col items-center justify-center px-4 py-12 text-center">
      <div className="mb-8 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600 text-lg font-bold text-white shadow-sm">
        SNU
      </div>
      <h2 className="text-2xl font-semibold tracking-normal text-gray-950 md:text-3xl">
        무엇을 확인할까요?
      </h2>
      <p className="mt-3 max-w-xl text-sm leading-6 text-gray-500">
        평의원회, 이사회, 대학운영계획, 중장기발전계획 자료를 바탕으로 질문에 답합니다.
      </p>
      <div className="mt-8 grid w-full grid-cols-1 gap-2 md:grid-cols-2">
        {EXAMPLE_QUESTIONS.map(q => (
          <button
            key={q}
            onClick={() => onPickQuestion(q)}
            className="rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left text-sm text-gray-700 shadow-sm hover:border-gray-300 hover:bg-gray-50"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-3xl bg-gray-100 px-5 py-3 text-sm leading-6 text-gray-900">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-4">
      <div className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
        message.error ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-700'
      }`}>
        {message.error ? '!' : 'S'}
      </div>
      <div className="min-w-0 flex-1">
        {message.agentNames && message.agentNames.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {message.agentNames.map(name => (
              <span key={name} className="rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">
                {name}
              </span>
            ))}
          </div>
        )}
        <div className={`prose prose-sm max-w-none leading-7 ${
          message.error ? 'text-red-700' : 'text-gray-800'
        }`}>
          {message.content ? <ReactMarkdown>{message.content}</ReactMarkdown> : null}
          {message.streaming && <span className="ml-1 inline-block h-4 w-1 animate-pulse rounded bg-gray-400 align-middle" />}
        </div>
        {message.sources && message.sources.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {message.sources.slice(0, 8).map((s, i) => (
              <span key={`${s.wiki}-${s.page}-${i}`} className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-500">
                [{s.wiki}] {s.page}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M12 3a9 9 0 00-9 9h3a6 6 0 016-6V3z" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 16V4M7 9l5-5 5 5M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.8 1.8 0 00.4 2l.1.1a2 2 0 01-2.8 2.8l-.1-.1a1.8 1.8 0 00-2-.4 1.8 1.8 0 00-1 1.6v.2a2 2 0 01-4 0V21a1.8 1.8 0 00-1-1.6 1.8 1.8 0 00-2 .4l-.1.1a2 2 0 01-2.8-2.8l.1-.1a1.8 1.8 0 00.4-2 1.8 1.8 0 00-1.6-1H2.8a2 2 0 010-4H3a1.8 1.8 0 001.6-1 1.8 1.8 0 00-.4-2l-.1-.1a2 2 0 012.8-2.8l.1.1a1.8 1.8 0 002 .4 1.8 1.8 0 001-1.6V2.8a2 2 0 014 0V3a1.8 1.8 0 001 1.6 1.8 1.8 0 002-.4l.1-.1a2 2 0 012.8 2.8l-.1.1a1.8 1.8 0 00-.4 2 1.8 1.8 0 001.6 1h.2a2 2 0 010 4H21a1.8 1.8 0 00-1.6 1z" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M10 17l5-5-5-5M15 12H3M21 19V5a2 2 0 00-2-2h-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
