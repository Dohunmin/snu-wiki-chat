'use client';

import { signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function PendingActions() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleLogout() {
    setLoading(true);
    await signOut({ redirect: false });
    router.replace('/login');
    router.refresh();
  }

  return (
    <div className="mt-6 flex items-center justify-center gap-3">
      <button
        type="button"
        onClick={() => router.refresh()}
        className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
      >
        승인 상태 새로고침
      </button>
      <button
        type="button"
        onClick={handleLogout}
        disabled={loading}
        className="rounded-lg px-3 py-2 text-sm text-gray-400 hover:bg-gray-50 hover:text-gray-700 disabled:opacity-50"
      >
        {loading ? '로그아웃 중...' : '로그아웃'}
      </button>
    </div>
  );
}
