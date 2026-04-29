import { auth } from './config';
import type { Role } from './roles';
import { canChat, canUpload, canAccessAdmin } from './roles';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function requireAuth(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
  }
  return session;
}

export async function requireChat(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
  }
  const role = (session.user as { role: Role }).role;
  if (!canChat(role)) {
    return NextResponse.json(
      { error: '관리자 승인을 기다리고 있습니다' },
      { status: 403 }
    );
  }
  return session;
}

export async function requireUpload(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
  }
  const role = (session.user as { role: Role }).role;
  if (!canUpload(role)) {
    return NextResponse.json({ error: '권한이 없습니다' }, { status: 403 });
  }
  return session;
}

export async function requireAdmin(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: '로그인이 필요합니다' }, { status: 401 });
  }
  const role = (session.user as { role: Role }).role;
  if (!canAccessAdmin(role)) {
    return NextResponse.json({ error: '관리자 권한이 필요합니다' }, { status: 403 });
  }
  return session;
}
