import { auth } from '@/lib/auth/config';
import { redirect } from 'next/navigation';
import { canChat } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import WikiPageClient from './WikiPageClient';

export default async function WikiPage() {
  const session = await auth();
  if (!session) redirect('/login');
  const role = (session.user as { role: Role }).role;
  if (!canChat(role)) redirect('/pending');
  return <WikiPageClient />;
}
