import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { Role } from './roles';
import { parseDeviceId } from './device';

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: {
    strategy: 'jwt',
    maxAge: 60 * 60 * 24, // JWT 최대 24시간 (하루 1회 로그인)
  },
  cookies: {
    sessionToken: {
      options: {
        httpOnly: true,
        sameSite: 'lax' as const,
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 60 * 24, // 24시간 — 브라우저를 닫아도 24시간 동안 로그인 유지
      },
    },
  },
  pages: {
    signIn: '/login',
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) return null;

        // 로그인 시점의 기기 식별자(device-id 쿠키)를 토큰에 고정 → 다른 기기에서의 재사용 차단.
        // (쿠키는 미들웨어가 모든 페이지 응답에서 미리 발급하므로 로그인 시점엔 이미 존재)
        const deviceId = parseDeviceId(new Headers(request?.headers).get('cookie'));

        const masterEmail = process.env.MASTER_ADMIN_EMAIL;
        const masterPassword = process.env.MASTER_ADMIN_PASSWORD;

        if (
          masterEmail &&
          masterPassword &&
          credentials.email === masterEmail &&
          credentials.password === masterPassword
        ) {
          const masterId = 'master-admin';
          const [existingMaster] = await db
            .select()
            .from(users)
            .where(eq(users.id, masterId))
            .limit(1);

          if (!existingMaster) {
            await db.insert(users).values({
              id: masterId,
              email: masterEmail,
              passwordHash: await bcrypt.hash(masterPassword, 12),
              name: '관리자',
              role: 'admin',
              approvedAt: new Date(),
            });
          }

          return {
            id: masterId,
            email: masterEmail,
            name: '관리자',
            role: 'admin' satisfies Role,
            deviceId,
          };
        }

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, credentials.email as string))
          .limit(1);

        if (!user) return null;

        const isValid = await bcrypt.compare(
          credentials.password as string,
          user.passwordHash
        );
        if (!isValid) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role as Role,
          deviceId,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // 최초 로그인 — authorize()가 준 role/deviceId 사용
        token.role = user.role;
        token.did = user.deviceId ?? null;
        token.roleSyncedAt = Date.now();
        return token;
      }
      // 후속 요청 — DB role 재동기화 (TTL throttle).
      // 매 요청 DB 조회는 미들웨어 504 회귀(커밋 aeaadbe)를 유발하므로 5분 간격으로만 조회.
      // → 권한 강등/거부가 약 5분 내 반영. DB 오류 시 기존 토큰 유지(가용성 우선).
      const SYNC_TTL_MS = 5 * 60 * 1000;
      const syncedAt = typeof token.roleSyncedAt === 'number' ? token.roleSyncedAt : 0;
      if (token.sub && Date.now() - syncedAt > SYNC_TTL_MS) {
        try {
          const [dbUser] = await db
            .select({ role: users.role })
            .from(users)
            .where(eq(users.id, token.sub))
            .limit(1);
          // 삭제(거부)된 사용자 → 권한 없는 'pending'으로 강등(canChat/canAccessAdmin 모두 false)
          token.role = dbUser ? (dbUser.role as Role) : 'pending';
          token.roleSyncedAt = Date.now();
        } catch (err) {
          console.error('[auth] role re-sync failed, keeping cached role:', err);
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        session.user.id = token.sub as string;
        session.user.role = token.role as Role;
        session.user.deviceId = (token.did as string | null | undefined) ?? null;
      }
      return session;
    },
  },
});
