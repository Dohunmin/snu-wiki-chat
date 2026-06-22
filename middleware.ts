import { auth } from '@/lib/auth/config';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import type { Role } from '@/lib/auth/roles';
import { canChat, canAccessAdmin } from '@/lib/auth/roles';
import { DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE } from '@/lib/auth/device';

// NextAuth v5 기본 세션 쿠키 이름 (dev / production secure 양쪽)
const SESSION_COOKIES = ['authjs.session-token', '__Secure-authjs.session-token'];

function clearSession<T extends NextResponse>(res: T): T {
  for (const name of SESSION_COOKIES) res.cookies.delete(name);
  return res;
}

export default auth((req: NextRequest & { auth: { user?: { role?: Role; deviceId?: string | null } } | null }) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;
  const role = session?.user?.role as Role | undefined;

  // 기기 바인딩: 로그인 시 고정한 device-id와 현재 요청 쿠키의 device-id를 대조.
  // 다르면(=다른 기기에서 세션 쿠키 재사용) 세션 무효 처리. IP 변동에는 영향 없음.
  const boundDevice = session?.user?.deviceId;
  const currentDevice = req.cookies.get(DEVICE_COOKIE)?.value;
  const deviceMismatch = !!session && !!boundDevice && currentDevice !== boundDevice;
  const authed = !!session && !deviceMismatch;

  // 모든 응답에 device-id 쿠키가 없으면 새로 발급 (로그인보다 먼저 존재하도록).
  const ensureDevice = <T extends NextResponse>(res: T): T => {
    if (!currentDevice) {
      res.cookies.set(DEVICE_COOKIE, crypto.randomUUID(), {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: DEVICE_COOKIE_MAX_AGE,
      });
    }
    return res;
  };

  if (pathname.startsWith('/api/auth') || pathname.startsWith('/api/register')) {
    return ensureDevice(NextResponse.next());
  }

  if (pathname.startsWith('/login') || pathname.startsWith('/register')) {
    if (authed) return NextResponse.redirect(new URL('/', req.url));
    // 다른 기기의 잔존 세션이 남아 있으면 쿠키를 비워 깨끗하게 재로그인하도록.
    return ensureDevice(deviceMismatch ? clearSession(NextResponse.next()) : NextResponse.next());
  }

  if (!authed) {
    // API 요청은 리다이렉트하면 fetch가 로그인 HTML을 받아 무한 로딩에 빠짐.
    // → 401을 반환해 클라이언트가 로그인 화면으로 이동하도록 함.
    if (pathname.startsWith('/api/')) {
      return ensureDevice(clearSession(NextResponse.json({ error: 'Session expired' }, { status: 401 })));
    }
    return ensureDevice(clearSession(NextResponse.redirect(new URL('/login', req.url))));
  }

  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    if (!role || !canAccessAdmin(role)) {
      return NextResponse.json({ error: 'Admin permission required' }, { status: 403 });
    }
  }

  if (pathname.startsWith('/knowledge-map')) {
    if (!role || !canAccessAdmin(role)) {
      return NextResponse.redirect(new URL('/', req.url));
    }
  }

  if (pathname === '/' || pathname.startsWith('/api/chat')) {
    if (!role || !canChat(role)) {
      return NextResponse.redirect(new URL('/pending', req.url));
    }
  }

  return ensureDevice(NextResponse.next());
});

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.svg|.*\\.webp|.*\\.ico|snu-logo\\.png).*)'],
};
