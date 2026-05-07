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
  '평의원회': 'senate', '이사회': 'board', '대학운영계획': 'plan', '중장기발전계획': 'vision', '중장기': 'vision',
  '70년역사': 'history', '대학현황': 'status', '유홍림총장연설': 'yhl-speeches', '재무정보공시': 'finance',
};

function getPageType(id: string): string {
  if (id.endsWith('.fact')) return 'facts';
  if (id.endsWith('.stance')) return 'stances';
  if (id.endsWith('.overview')) return 'overviews';
  return 'sources';
}

function linkifyCitations(content: string): string {
  const wikiNames = Object.keys(WIKI_ID_MAP).join('|');
  const pattern = new RegExp(`\\[(${wikiNames})\\]\\s+([\\w가-힣·\\-]+(?:\\.(?:fact|stance|overview))?)`, 'g');
  return content.replace(pattern, (_, wikiName: string, docId: string) => {
    const agentId = WIKI_ID_MAP[wikiName];
    if (!agentId) return `[${wikiName}] ${docId}`;
    const type = getPageType(docId);
    const href = `/wiki?agent=${agentId}&type=${type}&id=${encodeURIComponent(docId)}`;
    return `[${wikiName} ${docId}](${href})`;
  });
}

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
  mode?: string;  // 'normal' | 'lens:{personaId}'
}

const LENS_PERSONAS: { id: string; displayName: string }[] = [
  { id: 'leesj', displayName: '이석재 후보' },
];

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
  { id: 'history', label: '70년역사' },
  { id: 'status', label: '대학현황' },
  { id: 'yhl-speeches', label: '유홍림총장연설' },
  { id: 'finance', label: '재무정보공시' },
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  const [chatMode, setChatMode] = useState<string>('normal');
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [lensInsufficient, setLensInsufficient] = useState<string | null>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const isAdmin = canAccessAdmin(user.role);

  async function deleteConversation(convId: string, e: React.MouseEvent) {
    e.stopPropagation();
    await fetch(`/api/conversations/${convId}`, { method: 'DELETE' });
    setConversations(prev => prev.filter(c => c.id !== convId));
    if (currentConvId === convId) {
      setCurrentConvId(undefined);
      setMessages([]);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }

  useEffect(() => {
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  function handleScrollContainer() {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom > 100) userScrolledUp.current = true;
  }

  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [input]);

  useEffect(() => {
    fetch('/api/conversations')
      .then(r => r.json())
      .then((rows: { id: string; title: string | null; mode?: string | null }[]) => {
        if (Array.isArray(rows)) {
          setConversations(rows.map(r => ({
            id: r.id,
            title: r.title || '대화',
            mode: r.mode ?? 'normal',
          })));
        }
      })
      .catch(() => {});
  }, []);

  // URL에서 대화 복원 + 뒤로가기(popstate) 대응
  useEffect(() => {
    const restore = () => {
      const convId = new URLSearchParams(window.location.search).get('conv');
      if (convId) loadConversation(convId);
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // currentConvId → URL 동기화 (클리어는 명시적 삭제 시에만)
  useEffect(() => {
    if (currentConvId) {
      window.history.replaceState({}, '', `?conv=${currentConvId}`);
    }
  }, [currentConvId]);

  // 모드 메뉴 외부 클릭 시 닫기
  useEffect(() => {
    if (!modeMenuOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setModeMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [modeMenuOpen]);

  async function loadConversation(convId: string) {
    if (convId === currentConvId) return;
    setSidebarOpen(false);
    setConvLoading(true);
    setCurrentConvId(convId);
    setLensInsufficient(null);

    // 해당 대화의 mode가 있으면 입력 모드를 그대로 이어받음 (admin만)
    const conv = conversations.find(c => c.id === convId);
    if (conv?.mode?.startsWith('lens:') && isAdmin) {
      setChatMode(conv.mode);
    } else {
      setChatMode('normal');
    }
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

    userScrolledUp.current = false;
    setLensInsufficient(null);
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
        body: JSON.stringify({ message: trimmed, conversationId: currentConvId, mode: chatMode }),
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

            if (data.lensPersona?.insufficient) {
              setLensInsufficient(data.lensPersona.displayName);
            }

            if (!currentConvId && data.conversationId) {
              setCurrentConvId(data.conversationId);
              setConversations(prev => [
                { id: data.conversationId, title: trimmed.slice(0, 32), mode: chatMode },
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
    setSidebarOpen(false);
    inputRef.current?.focus();
  }

  function openUpload() {
    if (!canUpload(user.role)) return;
    setUploadOpen(true);
  }

  return (
    <div className="flex h-screen overflow-hidden bg-white text-gray-900">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed inset-y-0 left-0 z-30 w-64 flex flex-col bg-gray-50 border-r border-gray-200
        transform transition-transform duration-200 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        md:relative md:translate-x-0 md:flex
      `}>
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
              {conversations.map(conv => {
                const isLens = conv.mode?.startsWith('lens:');
                const isCurrent = currentConvId === conv.id;
                return (
                <div
                  key={conv.id}
                  className={`group flex items-center rounded-lg transition-colors border-l-2 ${
                    isCurrent
                      ? 'bg-blue-50 border-l-blue-400'
                      : isLens
                      ? 'bg-emerald-50 hover:bg-emerald-100 border-l-emerald-400'
                      : 'border-l-transparent hover:bg-gray-100'
                  }`}
                >
                  <button
                    onClick={() => loadConversation(conv.id)}
                    className={`min-w-0 flex-1 truncate px-3 py-2.5 text-left text-sm flex items-center gap-1.5 ${
                      isCurrent ? 'text-blue-700 font-medium' : 'text-gray-600'
                    }`}
                  >
                    {isLens && <span className="text-xs shrink-0">🎯</span>}
                    <span className="truncate">{conv.title}</span>
                  </button>
                  <button
                    onClick={(e) => deleteConversation(conv.id, e)}
                    className="mr-1.5 hidden shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-400 group-hover:flex"
                    title="삭제"
                  >
                    <TrashIcon />
                  </button>
                </div>
                );
              })}
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
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-gray-100 px-4 md:px-8">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 md:hidden"
              aria-label="메뉴 열기"
            >
              <HamburgerIcon />
            </button>
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

        <div ref={scrollContainerRef} onScroll={handleScrollContainer} className="flex-1 overflow-y-auto flex flex-col">
          {convLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <SpinnerIcon />
            </div>
          ) : messages.length === 0 ? (
            <WelcomePanel onPickQuestion={sendMessage} />
          ) : (
            <div className="w-full py-8 flex justify-center px-6">
              <div className="w-full max-w-2xl flex flex-col gap-6">
                {messages.map((msg, i) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    userQuery={msg.role === 'assistant' ? (messages[i - 1]?.content ?? '') : ''}
                  />
                ))}
                <div ref={bottomRef} />
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-gray-200 bg-white py-5 flex justify-center px-6">
          <div className="w-full max-w-2xl">
            {/* Lens 자료 부족 알림 */}
            {lensInsufficient && (
              <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                ⚠️ <strong>{lensInsufficient}</strong>의 명시적 입장 자료가 이 주제에 대해 없습니다. 일반 자료 기반으로 답변되었습니다.
              </div>
            )}

            {/* 활성 모드 배지 */}
            {chatMode.startsWith('lens:') && (
              <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs">
                <span>🎯</span>
                <span className="font-medium text-emerald-700">
                  {LENS_PERSONAS.find(p => p.id === chatMode.slice(5))?.displayName ?? chatMode.slice(5)} 시각으로 분석
                </span>
                <button
                  onClick={() => setChatMode('normal')}
                  className="ml-1 text-emerald-600 hover:text-emerald-900"
                  aria-label="lens 모드 해제"
                >
                  ✕
                </button>
              </div>
            )}

            <div className="flex items-end gap-3 rounded-2xl border border-gray-300 bg-white px-4 py-3 shadow-md focus-within:border-blue-400 focus-within:shadow-lg transition-all">
              {/* 통합 + 메뉴 (자료 업로드 + 모드 전환) */}
              <div ref={modeMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setModeMenuOpen(o => !o)}
                  className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                  title="옵션"
                  aria-label="옵션 메뉴 열기"
                >
                  <PlusIcon />
                </button>

                {modeMenuOpen && (
                  <div className="absolute bottom-full left-0 mb-2 w-72 rounded-xl border border-gray-200 bg-white shadow-lg py-1.5 z-20">
                    <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">응답 모드</div>
                    <button
                      onClick={() => { setChatMode('normal'); setModeMenuOpen(false); }}
                      className="w-full text-left px-3 py-2.5 hover:bg-gray-50 flex items-start gap-2.5"
                    >
                      <span className="text-base">💬</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
                          {chatMode === 'normal' && <span className="text-emerald-600">✓</span>}
                          질문 모드
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">기본 자료 검색·답변</p>
                      </div>
                    </button>

                    {LENS_PERSONAS.map(persona => {
                      const personaMode = `lens:${persona.id}`;
                      const isActive = chatMode === personaMode;
                      return (
                        <button
                          key={persona.id}
                          onClick={() => {
                            if (!isAdmin) {
                              setNotice('관리자 전용 기능입니다.');
                              setTimeout(() => setNotice(''), 3000);
                              setModeMenuOpen(false);
                              return;
                            }
                            setChatMode(personaMode);
                            setModeMenuOpen(false);
                          }}
                          disabled={!isAdmin}
                          className={`w-full text-left px-3 py-2.5 flex items-start gap-2.5 ${
                            isAdmin ? 'hover:bg-gray-50' : 'opacity-50 cursor-not-allowed'
                          }`}
                        >
                          <span className="text-base">🎯</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-900 flex items-center gap-1.5">
                              {isActive && <span className="text-emerald-600">✓</span>}
                              후보 lens 모드 ({persona.displayName})
                              {!isAdmin && (
                                <span className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded">관리자 전용</span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 mt-0.5">{persona.displayName} 시각으로 자료 분석</p>
                          </div>
                        </button>
                      );
                    })}

                    {canUpload(user.role) && (
                      <>
                        <div className="my-1 h-px bg-gray-100" />
                        <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">자료</div>
                        <button
                          onClick={() => { openUpload(); setModeMenuOpen(false); }}
                          className="w-full text-left px-3 py-2.5 hover:bg-gray-50 flex items-start gap-2.5"
                        >
                          <span className="text-base">📎</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-900">자료 업로드</div>
                            <p className="text-xs text-gray-500 mt-0.5">새로운 자료 파일 추가</p>
                          </div>
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="SNU 거버넌스 자료에 대해 질문하세요"
                rows={1}
                className="max-h-36 min-h-[44px] flex-1 resize-none bg-transparent py-2 text-base leading-6 outline-none placeholder:text-gray-400"
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
        <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {EXAMPLE_QUESTIONS.map(q => (
            <button
              key={q}
              onClick={() => onPickQuestion(q)}
              className="rounded-2xl border border-gray-200 bg-white px-8 py-6 text-left text-base text-gray-700 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 transition-colors shadow-sm leading-relaxed"
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SynthesisSaveButton({ message, userQuery }: { message: Message; userQuery: string }) {
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const routedTo = message.agentNames ?? message.routedAgents ?? [];
    const sources = message.sources ?? [];
    const sourcesText = sources.map(s => `- [${s.wiki}] ${s.page}`).join('\n');
    const content = [
      userQuery ? `## 질문\n\n${userQuery}` : '',
      `## 답변\n\n${message.content}`,
      sourcesText ? `## 출처\n\n${sourcesText}` : '',
    ].filter(Boolean).join('\n\n');

    await fetch('/api/wiki/syntheses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: userQuery || '질문 없음',
        answeredAt: new Date().toISOString().slice(0, 10),
        routedTo,
        content,
      }),
    });
    setSaved(true);
    setSaving(false);
  }

  if (saved) return (
    <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-green-50 border border-green-200 px-3.5 py-1.5 text-sm text-green-600">
      위키에 저장됨
    </span>
  );
  return (
    <button
      onClick={save}
      disabled={saving}
      className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-sm text-gray-500 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-600 transition-colors"
    >
      {saving ? '저장 중...' : '위키에 저장'}
    </button>
  );
}

function MessageBubble({ message, userQuery = '' }: { message: Message; userQuery?: string }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-tr-sm bg-blue-600 px-6 py-4 text-base leading-relaxed text-white">
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
          {message.content ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => {
                  if (href?.startsWith('/wiki?')) {
                    return (
                      <Link
                        href={href}
                        className="inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600 hover:bg-blue-100 transition-colors no-underline mx-0.5"
                      >
                        {children}
                      </Link>
                    );
                  }
                  return <a href={href}>{children}</a>;
                },
              }}
            >
              {linkifyCitations(message.content)}
            </ReactMarkdown>
          ) : null}
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
        {!message.streaming && !message.error && message.content && (
          <SynthesisSaveButton message={message} userQuery={userQuery} />
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

function HamburgerIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
    </svg>
  );
}
