import { auth } from '@/lib/auth/config';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { Role } from '@/lib/auth/roles';
import { canChat, canAccessAdmin } from '@/lib/auth/roles';

export default auth((req: NextRequest & { auth: { user?: { role?: Role } } | null }) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;
  const role = session?.user?.role as Role | undefined;

  // 인증 페이지는 통과
  if (pathname.startsWith('/login') || pathname.startsWith('/register')) {
    if (session) return NextResponse.redirect(new URL('/', req.url));
    return NextResponse.next();
  }

  // 미로그인 → 로그인 페이지
  if (!session) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // 관리자 페이지
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    if (!role || !canAccessAdmin(role)) {
      return NextResponse.json({ error: '관리자 권한이 필요합니다' }, { status: 403 });
    }
  }

  // 채팅 페이지 (pending 차단)
  if (pathname === '/' || pathname.startsWith('/api/chat')) {
    if (!role || !canChat(role)) {
      // pending 상태면 대기 페이지로
      return NextResponse.redirect(new URL('/pending', req.url));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
