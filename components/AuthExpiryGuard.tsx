'use client';

import { useEffect } from 'react';

/**
 * 세션 만료(24시간 경과 등) 대응.
 * 페이지를 열어둔 채 세션이 만료된 뒤 무언가를 클릭하면, API 요청이 401을 반환한다.
 * 그 401을 전역에서 가로채 로그인 화면으로 즉시 이동시킨다 (무한 로딩 방지).
 */
export default function AuthExpiryGuard() {
  useEffect(() => {
    const origFetch = window.fetch.bind(window);
    let redirecting = false;

    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const res = await origFetch(...args);
      if (res.status === 401 && !redirecting) {
        const input = args[0];
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
            ? input.href
            : input instanceof Request
            ? input.url
            : '';
        // NextAuth 내부 세션 폴링(/api/auth/*)은 정상적으로 401을 쓸 수 있으니 제외.
        if (!url.includes('/api/auth')) {
          redirecting = true;
          window.location.href = '/login';
        }
      }
      return res;
    };

    return () => {
      window.fetch = origFetch;
    };
  }, []);

  return null;
}
