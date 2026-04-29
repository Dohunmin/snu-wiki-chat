import { auth } from '@/lib/auth/config';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { Role } from '@/lib/auth/roles';
import { canChat, canAccessAdmin } from '@/lib/auth/roles';

export default auth((req: NextRequest & { auth: { user?: { role?: Role } } | null }) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;
  const role = session?.user?.role as Role | undefined;

  if (pathname.startsWith('/api/auth') || pathname.startsWith('/api/register')) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/login') || pathname.startsWith('/register')) {
    if (session) return NextResponse.redirect(new URL('/', req.url));
    return NextResponse.next();
  }

  if (!session) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    if (!role || !canAccessAdmin(role)) {
      return NextResponse.json({ error: 'Admin permission required' }, { status: 403 });
    }
  }

  if (pathname === '/' || pathname.startsWith('/api/chat')) {
    if (!role || !canChat(role)) {
      return NextResponse.redirect(new URL('/pending', req.url));
    }
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
