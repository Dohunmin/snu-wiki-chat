'use client';

import { useEffect, useState } from 'react';
import { ROLE_LABELS } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';

interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
  approvedAt: string | null;
}

export default function AdminDashboard() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  async function fetchUsers() {
    const res = await fetch('/api/admin/users');
    if (res.ok) setUsers(await res.json());
    setLoading(false);
  }

  useEffect(() => { fetchUsers(); }, []);

  async function handleApprove(userId: string, role: 'tier1' | 'tier2') {
    setActionLoading(userId + role);
    await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, action: 'approve', role }),
    });
    await fetchUsers();
    setActionLoading(null);
  }

  async function handleReject(userId: string) {
    if (!confirm('이 사용자를 거부하고 삭제하시겠습니까?')) return;
    setActionLoading(userId + 'reject');
    await fetch('/api/admin/users', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, action: 'reject' }),
    });
    await fetchUsers();
    setActionLoading(null);
  }

  const pendingUsers = users.filter(u => u.role === 'pending');
  const activeUsers = users.filter(u => u.role !== 'pending');

  const counts = { admin: 0, tier1: 0, tier2: 0, pending: 0 };
  users.forEach(u => counts[u.role]++);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 헤더 */}
      <header className="bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">관리자 대시보드</h1>
        <a href="/" className="text-sm text-blue-600 hover:underline">채팅으로 돌아가기</a>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
        {/* 사용자 현황 */}
        <div className="grid grid-cols-4 gap-4">
          {(['admin', 'tier1', 'tier2', 'pending'] as Role[]).map(role => (
            <div key={role} className="bg-white rounded-xl border border-gray-100 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900">{counts[role]}</p>
              <p className="text-xs text-gray-500 mt-1">{ROLE_LABELS[role]}</p>
            </div>
          ))}
        </div>

        {/* 승인 대기 */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">
            승인 대기 ({pendingUsers.length}명)
          </h2>
          {pendingUsers.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-100 p-6 text-center text-sm text-gray-400">
              승인 대기 중인 사용자가 없습니다
            </div>
          ) : (
            <div className="space-y-2">
              {pendingUsers.map(u => (
                <div key={u.id} className="bg-white rounded-xl border border-gray-100 p-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{u.name}</p>
                    <p className="text-xs text-gray-400">{u.email}</p>
                    <p className="text-xs text-gray-300 mt-0.5">
                      신청: {new Date(u.createdAt).toLocaleDateString('ko-KR')}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleApprove(u.id, 'tier1')}
                      disabled={actionLoading === u.id + 'tier1'}
                      className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded-lg hover:bg-blue-700 disabled:opacity-50"
                    >
                      1순위 승인
                    </button>
                    <button
                      onClick={() => handleApprove(u.id, 'tier2')}
                      disabled={actionLoading === u.id + 'tier2'}
                      className="px-3 py-1.5 bg-gray-600 text-white text-xs rounded-lg hover:bg-gray-700 disabled:opacity-50"
                    >
                      2순위 승인
                    </button>
                    <button
                      onClick={() => handleReject(u.id)}
                      disabled={actionLoading === u.id + 'reject'}
                      className="px-3 py-1.5 bg-white border border-red-200 text-red-500 text-xs rounded-lg hover:bg-red-50 disabled:opacity-50"
                    >
                      거부
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 활성 사용자 */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-3">
            활성 사용자 ({activeUsers.length}명)
          </h2>
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">이름</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">이메일</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">역할</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-gray-500">승인일</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {activeUsers.map(u => (
                  <tr key={u.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{u.name}</td>
                    <td className="px-4 py-3 text-gray-500">{u.email}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        u.role === 'admin' ? 'bg-purple-50 text-purple-600' :
                        u.role === 'tier1' ? 'bg-blue-50 text-blue-600' :
                        'bg-gray-50 text-gray-600'
                      }`}>
                        {ROLE_LABELS[u.role]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {u.approvedAt ? new Date(u.approvedAt).toLocaleDateString('ko-KR') : '-'}
                    </td>
                    <td className="px-4 py-3">
                      {u.role !== 'admin' && (
                        <select
                          defaultValue={u.role}
                          onChange={async e => {
                            await handleApprove(u.id, e.target.value as 'tier1' | 'tier2');
                          }}
                          className="text-xs border border-gray-200 rounded px-2 py-1 text-gray-600"
                        >
                          <option value="tier1">1순위</option>
                          <option value="tier2">2순위</option>
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
