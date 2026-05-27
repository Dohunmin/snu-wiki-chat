// Design Ref: §2.7 — admin 전용 페이지. 비-admin은 미들웨어로 차단되지만 server-side에서 한 번 더.

import { auth } from '@/lib/auth/config';
import { redirect } from 'next/navigation';
import { canAccessAdmin } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import { LimitationsView } from '@/components/admin/LimitationsView';

export default async function LimitationsPage() {
  const session = await auth();
  if (!session) redirect('/login');
  const role = (session.user as { role: Role }).role;
  if (!canAccessAdmin(role)) redirect('/');

  return <LimitationsView />;
}
