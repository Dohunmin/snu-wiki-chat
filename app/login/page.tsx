'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const res = await signIn('credentials', { email, password, redirect: false });
    if (res?.error) {
      setError('아이디 또는 비밀번호가 올바르지 않습니다.');
      setLoading(false);
    } else {
      router.push('/');
      router.refresh();
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 px-4">
      <div className="bg-white rounded-2xl shadow-sm p-10 w-full max-w-sm">
        {/* 로고 */}
        <div className="flex justify-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/snu-logo.png" alt="SNU" width={72} height={72} style={{ objectFit: 'contain' }} />
        </div>

        <h1 className="text-2xl font-semibold text-center text-gray-900 mb-8">Log in</h1>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="flex items-center gap-3 bg-gray-100 rounded-lg px-4 py-3">
            <svg className="w-4 h-4 text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M2 7l10 7 10-7" />
            </svg>
            <input
              type="text"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Your email"
              required
              className="flex-1 bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400"
            />
          </div>

          <div className="flex items-center gap-3 bg-gray-100 rounded-lg px-4 py-3">
            <svg className="w-4 h-4 text-gray-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0110 0v4" />
            </svg>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Your Password"
              required
              className="flex-1 bg-transparent text-sm text-gray-700 outline-none placeholder:text-gray-400"
            />
            <button type="button" onClick={() => setShowPassword(v => !v)} className="text-gray-400 hover:text-gray-600">
              {showPassword ? (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 4.2A10.4 10.4 0 0112 4c5 0 9 4.5 10 8a11.8 11.8 0 01-3.1 4.8M6.1 6.1A11.8 11.8 0 002 12c1 3.5 5 8 10 8 1.4 0 2.7-.3 3.9-.9" />
                </svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 12s4-8 10-8 10 8 10 8-4 8-10 8S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>

          {error && <p className="text-red-500 text-xs">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 bg-black text-white py-3 rounded-lg text-xs font-bold tracking-widest uppercase hover:bg-gray-800 disabled:opacity-50 transition-colors"
          >
            {loading ? '로그인 중...' : 'SUBMIT'}
          </button>
        </form>

        <p className="text-center text-xs text-gray-400 mt-5">
          계정이 없으신가요?{' '}
          <Link href="/register" className="text-gray-600 hover:underline font-medium">가입 신청</Link>
        </p>
      </div>
    </div>
  );
}
