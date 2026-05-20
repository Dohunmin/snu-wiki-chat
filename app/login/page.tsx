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

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '12px 14px',
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
        <div style={{ textAlign: 'center', marginBottom: '8px' }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/snu-logo.png" alt="SNU" style={{ width: '64px', height: '64px', objectFit: 'contain', display: 'inline-block' }} />
        </div>

        <h2 style={{
          textAlign: 'center',
          fontWeight: 400,
          fontSize: '22px',
          color: '#1a1a1a',
          marginBottom: '28px',
          letterSpacing: '0.5px',
          fontFamily: "'Georgia', 'Times New Roman', serif",
        }}>Log in</h2>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '14px' }}>
            <input
              type="text"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="아이디"
              required
              style={inputStyle}
              onFocus={e => { e.target.style.borderColor = '#1a1a1a'; e.target.style.backgroundColor = '#fff'; }}
              onBlur={e => { e.target.style.borderColor = '#d9d9d9'; e.target.style.backgroundColor = '#fafafa'; }}
            />
          </div>

          <div style={{ position: 'relative', marginBottom: '14px' }}>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="비밀번호"
              required
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
              {loading ? '로그인 중...' : 'SUBMIT'}
            </button>
          </div>
        </form>

        <Link href="/register" style={{ display: 'block', textAlign: 'center', marginTop: '16px', fontSize: '11px', color: '#888', textDecoration: 'none' }}>
          계정이 없으신가요? 가입 신청
        </Link>
      </div>
    </div>
  );
}
