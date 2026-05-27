// Design Ref: §2.6 — 1 batch POST. 클라이언트가 hasMore=true이면 자동 재호출.
// In-memory lock으로 동시 갱신 차단 (admin 단일 사용자 가정).

import { auth } from '@/lib/auth/config';
import { canAccessAdmin } from '@/lib/auth/roles';
import { refresh, DEFAULT_BATCH_SIZE } from '@/lib/limitations/refresh';

let refreshing = false;

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: '로그인이 필요합니다.' }, { status: 401 });
  }
  if (!canAccessAdmin(session.user.role)) {
    return Response.json({ error: '관리자 전용입니다.' }, { status: 403 });
  }

  if (refreshing) {
    return Response.json({ error: '이미 갱신 중입니다.' }, { status: 409 });
  }
  refreshing = true;

  try {
    const url = new URL(req.url);
    const batchParam = url.searchParams.get('batch');
    const maxNew = batchParam
      ? Math.max(1, Math.min(100, parseInt(batchParam, 10) || DEFAULT_BATCH_SIZE))
      : DEFAULT_BATCH_SIZE;

    const result = await refresh({ maxNew });
    return Response.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : '갱신 실패';
    console.error('[limitations/refresh] failed:', err);
    return Response.json({ error: msg }, { status: 500 });
  } finally {
    refreshing = false;
  }
}
