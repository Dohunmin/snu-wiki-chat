'use client';

import { useState, useRef, useEffect } from 'react';
import { signOut } from 'next-auth/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Role } from '@/lib/auth/roles';
import { canUpload, canAccessAdmin, ROLE_LABELS } from '@/lib/auth/roles';
import type { SourceRef } from '@/lib/agents/types';
import Link from 'next/link';

const WIKI_ID_MAP: Record<string, string> = {
  '평의원회': 'senate', '이사회': 'board', '대학운영계획': 'plan', '중장기발전계획': 'vision',
};

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

const AGENT_OPTIONS = [
  { id: 'senate', label: '평의원회' },
  { id: 'board', label: '이사회' },
  { id: 'plan', label: '대학운영계획' },
  { id: 'vision', label: '중장기발전계획' },
] as const;

export default function ChatPage({ user }: { user: User }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | undefined>();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [convLoading, setConvLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function deleteConversation(convId: string, e: React.MouseEvent) {
    e.stopPropagation();
    await fetch(`/api/conversations/${convId}`, { method: 'DELETE' });
    setConversations(prev => prev.filter(c => c.id !== convId));
    if (currentConvId === convId) {
      setCurrentConvId(undefined);
      setMessages([]);
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    fetch('/api/conversations')
      .then(r => r.json())
      .then((rows: { id: string; title: string | null }[]) => {
        if (Array.isArray(rows)) {
          setConversations(rows.map(r => ({ id: r.id, title: r.title || '대화' })));
        }
      })
      .catch(() => {});
  }, []);

  async function loadConversation(convId: string) {
    if (convId === currentConvId) return;
    setConvLoading(true);
    setCurrentConvId(convId);
    try {
      const res = await fetch(`/api/conversations/${convId}`);
      const rows = await res.json();
      if (Array.isArray(rows)) {
        setMessages(rows.map((r: { id: string; role: string; content: string; routedAgents?: string[] | null; sources?: { wiki: string; page: string; topic?: string }[] | null }) => ({
          id: r.id,
          role: r.role as 'user' | 'assistant',
          content: r.content,
          routedAgents: r.routedAgents ?? undefined,
          sources: (r.sources as SourceRef[] | null) ?? undefined,
        })));
      }
    } catch {
      // ignore
    } finally {
      setConvLoading(false);
    }
  }

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
          ? { ...m, content: message, streaming: false, error: true }
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

  function openUpload() {
    if (!canUpload(user.role)) return;
    setUploadOpen(true);
  }

  return (
    <div className="flex h-screen overflow-hidden bg-white text-gray-900">
      {/* Sidebar */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col bg-gray-50 border-r border-gray-200">
        <div className="flex h-14 items-center gap-2.5 px-4 border-b border-gray-200">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-[11px] font-bold text-white shrink-0">
            SNU
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-gray-900">SNU 거버넌스 위키</p>
            <p className="truncate text-xs text-gray-400">{ROLE_LABELS[user.role]}</p>
          </div>
        </div>

        <div className="px-3 pt-3 pb-1 flex flex-col gap-1">
          <button
            onClick={newConversation}
            className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors"
          >
            <PlusIcon />
            새 대화
          </button>
          <Link
            href="/wiki"
            className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors"
          >
            <BookIcon />
            위키 탐색
          </Link>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {conversations.length > 0 && (
            <p className="px-2 pb-1.5 text-[11px] font-medium text-gray-400 uppercase tracking-wide">최근 대화</p>
          )}
          {conversations.length === 0 ? (
            <p className="px-2 pt-1 text-xs text-gray-400 leading-5">질문을 시작하면 대화 목록이 표시됩니다.</p>
          ) : (
            <div className="space-y-0.5">
              {conversations.map(conv => (
                <div
                  key={conv.id}
                  className={`group flex items-center rounded-lg transition-colors ${
                    currentConvId === conv.id ? 'bg-blue-50' : 'hover:bg-gray-100'
                  }`}
                >
                  <button
                    onClick={() => loadConversation(conv.id)}
                    className={`min-w-0 flex-1 truncate px-3 py-2.5 text-left text-sm ${
                      currentConvId === conv.id ? 'text-blue-700 font-medium' : 'text-gray-600'
                    }`}
                  >
                    {conv.title}
                  </button>
                  <button
                    onClick={(e) => deleteConversation(conv.id, e)}
                    className="mr-1.5 hidden shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-400 group-hover:flex"
                    title="삭제"
                  >
                    <TrashIcon />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 p-3 space-y-0.5">
          {canUpload(user.role) && (
            <button
              onClick={openUpload}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-sm text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <UploadIcon />
              자료 업로드
            </button>
          )}
          {canAccessAdmin(user.role) && (
            <a href="/admin" className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-sm text-gray-600 hover:bg-gray-100 transition-colors">
              <SettingsIcon />
              관리자
            </a>
          )}
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-sm text-gray-500 hover:bg-gray-100 transition-colors"
          >
            <LogoutIcon />
            로그아웃
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 px-5 md:px-8">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-600 text-[11px] font-bold text-white md:hidden">
              SNU
            </div>
            <h1 className="text-sm font-semibold text-gray-900">SNU 거버넌스 위키</h1>
          </div>
          <span className="text-xs text-gray-400">{user.name || '사용자'}</span>
        </header>

        {notice && (
          <div className="mx-auto mt-3 w-full max-w-3xl px-5 md:px-8">
            <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-2.5 text-sm text-blue-700">
              {notice}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto flex flex-col">
          {convLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <SpinnerIcon />
            </div>
          ) : messages.length === 0 ? (
            <WelcomePanel onPickQuestion={sendMessage} />
          ) : (
            <div className="mx-auto w-full max-w-3xl flex flex-col gap-6 px-5 py-8 md:px-8">
              {messages.map(msg => (
                <MessageBubble key={msg.id} message={msg} />
              ))}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-gray-100 bg-white py-4">
          <div className="mx-auto w-full max-w-3xl px-5 md:px-8">
            <div className="flex items-end gap-2 rounded-2xl border border-gray-200 bg-white px-3 py-2 shadow-sm focus-within:border-gray-300 focus-within:shadow-md transition-shadow">
              {canUpload(user.role) && (
                <button
                  type="button"
                  onClick={openUpload}
                  className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                  title="자료 업로드"
                  aria-label="자료 업로드"
                >
                  <PlusIcon />
                </button>
              )}
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="SNU 거버넌스 자료에 대해 질문하세요"
                rows={1}
                className="max-h-36 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-base leading-6 outline-none placeholder:text-gray-400"
              />
              <button
                onClick={() => sendMessage()}
                disabled={loading || !input.trim()}
                className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-700 disabled:bg-gray-100 disabled:text-gray-300 disabled:cursor-not-allowed"
                title="전송"
                aria-label="전송"
              >
                {loading ? <SpinnerIcon /> : <ArrowUpIcon />}
              </button>
            </div>
            <p className="mt-2 text-center text-[11px] text-gray-400">
              Enter로 전송 · Shift+Enter로 줄바꿈
            </p>
          </div>
        </div>
      </main>

      {uploadOpen && (
        <UploadModal
          onClose={() => setUploadOpen(false)}
          onUploaded={(message) => {
            setNotice(message);
            setUploadOpen(false);
            window.setTimeout(() => setNotice(''), 4000);
          }}
        />
      )}
    </div>
  );
}

function UploadModal({ onClose, onUploaded }: { onClose: () => void; onUploaded: (message: string) => void }) {
  const [agentId, setAgentId] = useState<(typeof AGENT_OPTIONS)[number]['id']>('senate');
  const [fileName, setFileName] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');
    setFileName(file.name);
    try {
      setContent(await file.text());
    } catch {
      setError('파일을 읽지 못했습니다. 텍스트 파일인지 확인해 주세요.');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, fileName: fileName.trim(), content: content.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '자료 업로드에 실패했습니다.');
      onUploaded(data.message || '자료가 업로드되었습니다.');
    } catch (err) {
      setError(err instanceof Error ? err.message : '자료 업로드에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-lg rounded-xl bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">자료 업로드</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700" aria-label="닫기">
            <CloseIcon />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">분류</label>
            <select
              value={agentId}
              onChange={e => setAgentId(e.target.value as typeof agentId)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
            >
              {AGENT_OPTIONS.map(option => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">파일</label>
            <input
              type="file"
              accept=".md,.txt,.json,.csv,text/*"
              onChange={handleFileChange}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm file:text-gray-700"
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">파일명</label>
            <input
              value={fileName}
              onChange={e => setFileName(e.target.value)}
              placeholder="예: board-note.md"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">내용</label>
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="파일을 선택하거나 내용을 직접 붙여넣으세요."
              rows={8}
              className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm leading-6 outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">
            취소
          </button>
          <button
            type="submit"
            disabled={loading || !fileName.trim() || !content.trim()}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:bg-gray-200 disabled:text-gray-400"
          >
            {loading ? '업로드 중...' : '업로드'}
          </button>
        </div>
      </form>
    </div>
  );
}

function WelcomePanel({ onPickQuestion }: { onPickQuestion: (question: string) => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-5 py-12">
      <div className="w-full max-w-xl text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-600 text-sm font-bold text-white shadow-sm">
          SNU
        </div>
        <h2 className="text-3xl font-semibold text-gray-900">무엇을 확인할까요?</h2>
        <p className="mt-2.5 text-base leading-relaxed text-gray-500">
          평의원회, 이사회, 대학운영계획, 중장기발전계획 자료를 바탕으로 질문에 답합니다.
        </p>
        <div className="mt-7 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {EXAMPLE_QUESTIONS.map(q => (
            <button
              key={q}
              onClick={() => onPickQuestion(q)}
              className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-left text-base text-gray-700 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 transition-colors shadow-sm"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SynthesisSaveButton({ message }: { message: Message }) {
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const routedTo = message.agentNames ?? [];
    const sources = message.sources ?? [];
    const sourcesText = sources.map(s => `- [${s.wiki}] ${s.page}`).join('\n');
    const content = `## 답변\n\n${message.content}${sourcesText ? `\n\n## 출처\n\n${sourcesText}` : ''}`;
    await fetch('/api/wiki/syntheses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '(이전 메시지 참조)',
        answeredAt: new Date().toISOString().slice(0, 10),
        routedTo,
        content,
      }),
    });
    setSaved(true);
    setSaving(false);
  }

  if (saved) return <span className="text-xs text-green-600 mt-2 inline-block">위키에 저장됨</span>;
  return (
    <button
      onClick={save}
      disabled={saving}
      className="mt-2 text-xs text-gray-400 hover:text-blue-600 transition-colors"
    >
      {saving ? '저장 중...' : '위키에 저장'}
    </button>
  );
}

function MessageBubble({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-2xl rounded-tr-sm bg-blue-600 px-4 py-3 text-base leading-relaxed text-white">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.error) {
    return (
      <div className="flex gap-3">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-red-100 text-xs font-bold text-red-500">
          !
        </div>
        <div className="min-w-0 flex-1">
          <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3">
            <p className="text-base font-medium text-red-700 mb-1">응답 오류</p>
            <p className="text-base text-red-600 leading-relaxed whitespace-pre-wrap">{message.content}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">
        S
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        {message.agentNames && message.agentNames.length > 0 && (
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {message.agentNames.map(name => (
              <span key={name} className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
                {name}
              </span>
            ))}
          </div>
        )}
        <div className="md-body text-base">
          {message.content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown> : null}
          {message.streaming && !message.content && (
            <span className="inline-flex gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="h-1.5 w-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
          )}
          {message.streaming && message.content && (
            <span className="ml-0.5 inline-block h-3.5 w-0.5 animate-pulse rounded-full bg-gray-400 align-middle" />
          )}
        </div>
        {message.sources && message.sources.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {message.sources.slice(0, 8).map((s, i) => {
              const agentId = WIKI_ID_MAP[s.wiki];
              const href = agentId
                ? `/wiki?agent=${agentId}&type=source&id=${encodeURIComponent(s.page)}`
                : null;
              return href ? (
                <Link
                  key={`${s.wiki}-${s.page}-${i}`}
                  href={href}
                  className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs text-blue-600 hover:bg-blue-100 transition-colors"
                >
                  [{s.wiki}] {s.page}
                </Link>
              ) : (
                <span key={`${s.wiki}-${s.page}-${i}`} className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs text-gray-500">
                  [{s.wiki}] {s.page}
                </span>
              );
            })}
          </div>
        )}
        {!message.streaming && !message.error && message.content && (
          <SynthesisSaveButton message={message} />
        )}
      </div>
    </div>
  );
}

function TrashIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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

function CloseIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
    </svg>
  );
}
