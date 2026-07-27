'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || '가입 신청 중 문제가 발생했습니다.');
        setLoading(false);
      } else {
        router.push('/login?registered=1');
      }
    } catch {
      setError('서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      setLoading(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '12px 14px',
    border: '1px solid #e5e7eb',
    borderRadius: '6px',
    backgroundColor: '#f9fafb',
    fontSize: '14px',
    color: '#1f2937',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.15s ease, background-color 0.15s ease',
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      background: 'linear-gradient(180deg, #f7f8fa 0%, #eef0f4 100%)',
      padding: '20px',
    }}>
      <div style={{
        backgroundColor: '#ffffff',
        width: '340px',
        padding: '44px 36px',
        borderRadius: '10px',
        border: '1px solid #f0f1f3',
        boxShadow: '0 8px 30px rgba(0,0,0,0.06)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: '8px' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/snu-logo.png" alt="SNU" style={{ width: '64px', height: '64px', objectFit: 'contain', display: 'inline-block' }} />
        </div>

        <h2 style={{
          textAlign: 'center',
          fontWeight: 600,
          fontSize: '22px',
          color: '#111827',
          marginBottom: '28px',
          letterSpacing: '-0.3px',
        }}>Sign Up</h2>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '14px' }}>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="이름"
              required
              style={inputStyle}
              onFocus={e => { e.target.style.borderColor = '#26365f'; e.target.style.backgroundColor = '#fff'; }}
              onBlur={e => { e.target.style.borderColor = '#e5e7eb'; e.target.style.backgroundColor = '#f9fafb'; }}
            />
          </div>

          <div style={{ marginBottom: '14px' }}>
            <input
              type="email"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="이메일"
              required
              style={inputStyle}
              onFocus={e => { e.target.style.borderColor = '#26365f'; e.target.style.backgroundColor = '#fff'; }}
              onBlur={e => { e.target.style.borderColor = '#e5e7eb'; e.target.style.backgroundColor = '#f9fafb'; }}
            />
          </div>

          <div style={{ position: 'relative', marginBottom: '14px' }}>
            <input
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder="비밀번호 (8자 이상)"
              required
              minLength={8}
              style={{ ...inputStyle, paddingRight: '40px' }}
              onFocus={e => { e.target.style.borderColor = '#26365f'; e.target.style.backgroundColor = '#fff'; }}
              onBlur={e => { e.target.style.borderColor = '#e5e7eb'; e.target.style.backgroundColor = '#f9fafb'; }}
            />
            <button
              type="button"
              onClick={() => setShowPassword(v => !v)}
              style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '14px', padding: 0 }}
            >
              {showPassword ? '🙈' : '👁'}
            </button>
          </div>

          {error && <p style={{ color: '#e53e3e', fontSize: '12px', marginBottom: '10px' }}>{error}</p>}

          <div style={{ textAlign: 'center', marginTop: '22px' }}>
            <button
              type="submit"
              disabled={loading}
              style={{
                padding: '12px 48px',
                backgroundColor: loading ? '#a5b4fc' : '#26365f',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 600,
                letterSpacing: '0.3px',
                cursor: loading ? 'not-allowed' : 'pointer',
                boxShadow: '0 2px 8px rgba(37,99,235,0.2)',
                transition: 'background-color 0.15s ease, box-shadow 0.15s ease',
              }}
            >
              {loading ? '신청 중...' : 'SUBMIT'}
            </button>
          </div>
        </form>

        <Link href="/login" style={{ display: 'block', textAlign: 'center', marginTop: '20px', fontSize: '13px', color: '#6b7280', textDecoration: 'none' }}>
          이미 계정이 있으신가요? 로그인
        </Link>
      </div>
    </div>
  );
}
