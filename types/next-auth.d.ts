import type { DefaultSession } from 'next-auth';
import type { Role } from '@/lib/auth/roles';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: Role;
      deviceId?: string | null;
    } & DefaultSession['user'];
  }

  interface User {
    role: Role;
    deviceId?: string | null;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    role: Role;
    did?: string | null;
  }
}
