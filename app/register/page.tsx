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
    padding: '12px 12px 12px 40px',
    border: '1px solid #d9d9d9',
    borderRadius: '6px',
    backgroundColor: '#fafafa',
    fontSize: '13px',
    color: '#333',
    outline: 'none',
    boxSizing: 'border-box',
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: '#c4c4c4',
      fontFamily: "'Helvetica Neue', Arial, sans-serif",
      padding: '20px',
    }}>
      <div style={{
        backgroundColor: '#ffffff',
        width: '340px',
        padding: '40px 35px',
        borderRadius: '4px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.05)',
      }}>
        {/* 로고 */}
        <div style={{ textAlign: 'center', marginBottom: '8px' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/snu-logo.png"
            alt="SNU"
            style={{ width: '64px', height: '64px', objectFit: 'contain', display: 'inline-block' }}
          />
        </div>

        <h2 style={{
          textAlign: 'center',
          fontWeight: 400,
          fontSize: '22px',
          color: '#1a1a1a',
          marginBottom: '28px',
          letterSpacing: '0.5px',
          fontFamily: "'Georgia', 'Times New Roman', serif",
        }}>Sign Up</h2>

        <form onSubmit={handleSubmit}>
          {/* 이름 */}
          <div style={{ position: 'relative', marginBottom: '14px' }}>
            <span style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: '#9a9a9a', fontSize: '14px' }}>👤</span>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="이름"
              required
              style={inputStyle}
              onFocus={e => { e.target.style.borderColor = '#1a1a1a'; e.target.style.backgroundColor = '#fff'; }}
              onBlur={e => { e.target.style.borderColor = '#d9d9d9'; e.target.style.backgroundColor = '#fafafa'; }}
            />
          </div>

          {/* 이메일 */}
          <div style={{ position: 'relative', marginBottom: '14px' }}>
            <span style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: '#9a9a9a', fontSize: '14px' }}>✉</span>
            <input
              type="email"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              placeholder="이메일"
              required
              style={inputStyle}
              onFocus={e => { e.target.style.borderColor = '#1a1a1a'; e.target.style.backgroundColor = '#fff'; }}
              onBlur={e => { e.target.style.borderColor = '#d9d9d9'; e.target.style.backgroundColor = '#fafafa'; }}
            />
          </div>

          {/* 비밀번호 */}
          <div style={{ position: 'relative', marginBottom: '14px' }}>
            <span style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: '#9a9a9a', fontSize: '13px' }}>🔒</span>
            <input
              type={showPassword ? 'text' : 'password'}
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder="비밀번호 (8자 이상)"
              required
              minLength={8}
              style={{ ...inputStyle, paddingRight: '40px' }}
              onFocus={e => { e.target.style.borderColor = '#1a1a1a'; e.target.style.backgroundColor = '#fff'; }}
              onBlur={e => { e.target.style.borderColor = '#d9d9d9'; e.target.style.backgroundColor = '#fafafa'; }}
            />
            <button
              type="button"
              onClick={() => setShowPassword(v => !v)}
              style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9a9a9a', fontSize: '14px', padding: 0 }}
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
                padding: '10px 48px',
                backgroundColor: loading ? '#555' : '#1a1a1a',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                fontSize: '11px',
                fontWeight: 600,
                letterSpacing: '1.5px',
                cursor: loading ? 'not-allowed' : 'pointer',
                fontFamily: "'Helvetica Neue', Arial, sans-serif",
              }}
            >
              {loading ? '신청 중...' : 'SUBMIT'}
            </button>
          </div>
        </form>

        <Link
          href="/login"
          style={{
            display: 'block',
            textAlign: 'center',
            marginTop: '16px',
            fontSize: '11px',
            color: '#888',
            textDecoration: 'none',
            fontFamily: "'Helvetica Neue', Arial, sans-serif",
          }}
        >
          이미 계정이 있으신가요? 로그인
        </Link>
      </div>
    </div>
  );
}
