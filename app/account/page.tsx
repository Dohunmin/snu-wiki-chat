'use client';

import { useState } from 'react';

export default function AccountPage() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('새 비밀번호는 8자 이상이어야 합니다.');
      return;
    }
    if (newPassword !== confirm) {
      setError('새 비밀번호가 일치하지 않습니다.');
      return;
    }
    setLoading(true);
    const res = await fetch('/api/account/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    setLoading(false);
    if (res.ok) {
      setDone(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } else {
      setError(data.error ?? '변경에 실패했습니다.');
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl border border-gray-100 p-8 shadow-sm">
          <h1 className="text-lg font-semibold text-gray-900 mb-1">비밀번호 변경</h1>
          <p className="text-xs text-gray-400 mb-6">현재 비밀번호를 확인한 뒤 새 비밀번호로 변경합니다.</p>

          {done ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-green-50 border border-green-100 px-4 py-3 text-sm text-green-700">
                비밀번호가 변경되었습니다.
              </div>
              <a href="/" className="block text-center text-sm text-blue-600 hover:underline">
                채팅으로 돌아가기
              </a>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                type="password"
                placeholder="현재 비밀번호"
                value={currentPassword}
                onChange={e => setCurrentPassword(e.target.value)}
                required
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-400 focus:outline-none"
              />
              <input
                type="password"
                placeholder="새 비밀번호 (8자 이상)"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                required
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-400 focus:outline-none"
              />
              <input
                type="password"
                placeholder="새 비밀번호 확인"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                required
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-blue-400 focus:outline-none"
              />
              {error && <p className="text-xs text-red-500">{error}</p>}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-blue-600 text-white text-sm py-2.5 hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? '변경 중...' : '비밀번호 변경'}
              </button>
              <a href="/" className="block text-center text-xs text-gray-400 hover:text-gray-600 pt-1">
                취소
              </a>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
