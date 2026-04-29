import { auth } from '@/lib/auth/config';
import { redirect } from 'next/navigation';
import { canAccessAdmin } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import AdminDashboard from '@/components/admin/AdminDashboard';

export default async function AdminPage() {
  const session = await auth();
  if (!session) redirect('/login');
  const role = (session.user as { role: Role }).role;
  if (!canAccessAdmin(role)) redirect('/');

  return <AdminDashboard />;
}
