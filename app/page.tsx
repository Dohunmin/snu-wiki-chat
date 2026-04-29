import { auth } from '@/lib/auth/config';
import { redirect } from 'next/navigation';
import { canChat } from '@/lib/auth/roles';
import type { Role } from '@/lib/auth/roles';
import ChatPage from '@/components/chat/ChatPage';

export default async function Home() {
  const session = await auth();
  if (!session) redirect('/login');

  const role = (session.user as { role: Role }).role;
  if (!canChat(role)) redirect('/pending');

  return <ChatPage user={session.user as { id: string; name?: string | null; role: Role }} />;
}
