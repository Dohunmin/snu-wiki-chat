import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import bcrypt from 'bcryptjs';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { Role } from './roles';

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: {
    strategy: 'jwt',
    maxAge: 60 * 60 * 8, // JWT 최대 8시간
  },
  cookies: {
    sessionToken: {
      options: {
        httpOnly: true,
        sameSite: 'lax' as const,
        path: '/',
        secure: process.env.NODE_ENV === 'production',
        // maxAge 없음 → 브라우저 종료 시 쿠키 자동 삭제
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
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

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
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        session.user.id = token.sub as string;
        const [currentUser] = await db
          .select({ role: users.role, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, session.user.id))
          .limit(1);

        if (currentUser) {
          session.user.role = currentUser.role as Role;
          session.user.name = currentUser.name;
          session.user.email = currentUser.email;
        } else {
          session.user.role = token.role as Role;
        }
      }
      return session;
    },
  },
});
