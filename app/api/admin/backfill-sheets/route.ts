import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
import { canAccessAdmin } from '@/lib/auth/roles';
import { db } from '@/lib/db/client';
import { messages, conversations, users } from '@/lib/db/schema';
import { eq, asc } from 'drizzle-orm';
import { logQuestionToSheet } from '@/lib/google-sheets';
import crypto from 'crypto';

async function clearAndSetHeader(): Promise<void> {
  const sheetId = process.env.GOOGLE_SHEET_ID!;
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const jwt = `${signingInput}.${sign.sign(creds.private_key, 'base64url')}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const { access_token } = await tokenRes.json() as { access_token: string };

  // 시트 초기화
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:I:clear`, {
    method: 'POST', headers: { Authorization: `Bearer ${access_token}` },
  });

  // 헤더 삽입
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:I:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['날짜시간', '이름', '이메일', '역할', '질문', '답변', '라우팅 위키', '모드', '대화ID']] }),
    }
  );
}

export async function POST(_req: NextRequest) {
  const session = await auth();
  if (!session?.user || !canAccessAdmin(session.user.role)) {
    return Response.json({ error: '관리자 전용' }, { status: 403 });
  }

  const allMessages = await db
    .select({
      convId: messages.conversationId,
      role: messages.role,
      content: messages.content,
      routedAgents: messages.routedAgents,
      mode: messages.mode,
      createdAt: messages.createdAt,
      userName: users.name,
      userEmail: users.email,
      userRole: users.role,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .innerJoin(users, eq(conversations.userId, users.id))
    .orderBy(asc(messages.createdAt));

  await clearAndSetHeader();

  let count = 0;
  for (let i = 0; i < allMessages.length - 1; i++) {
    const cur = allMessages[i];
    const next = allMessages[i + 1];

    if (cur.role === 'user' && next.role === 'assistant' && cur.convId === next.convId) {
      if (!next.content.trim()) { i++; continue; }

      await logQuestionToSheet({
        name: cur.userName,
        email: cur.userEmail,
        role: cur.userRole,
        question: cur.content,
        answer: next.content,
        wikis: (next.routedAgents ?? []).join(', '),
        mode: next.mode,
        conversationId: cur.convId,
        timestamp: cur.createdAt,
      });

      count++;
      i++;
      if (count % 10 === 0) await new Promise(r => setTimeout(r, 200));
    }
  }

  return Response.json({ ok: true, logged: count });
}
