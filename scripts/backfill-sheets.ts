/**
 * 기존 DB 전체 Q&A 기록을 Google Sheets에 시간순으로 백필
 * 실행: npx tsx scripts/backfill-sheets.ts
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch { /* 없으면 무시 */ }

// 로컬 JSON 파일에서 직접 읽기 (Vercel env 없을 때 fallback)
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  const jsonPath = 'C:/Users/USER/Desktop/Uxlab/총장에이전트/snu-wiki-qna-db-673d456b6db9.json';
  if (fs.existsSync(jsonPath)) {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fs.readFileSync(jsonPath, 'utf-8');
  }
}
if (!process.env.GOOGLE_SHEET_ID) {
  process.env.GOOGLE_SHEET_ID = '1LxIk7t-mU-BMCHFOqEErRipI649kFp8izMYI4XJ85Cc';
}
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { eq, asc } from 'drizzle-orm';
import { messages, conversations, users } from '../lib/db/schema';
import crypto from 'crypto';

const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
const db = drizzle(pool);

// ── Google Sheets JWT 인증 ─────────────────────────────────────
async function getAccessToken(): Promise<string> {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(creds.private_key, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature}`,
    }),
  });
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

async function appendRows(token: string, values: string[][]): Promise<void> {
  const sheetId = process.env.GOOGLE_SHEET_ID!;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:I:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(await res.text());
}

// ── 메인 ──────────────────────────────────────────────────────
async function main() {
  console.log('📊 Google Sheets 백필 시작...');

  const token = await getAccessToken();
  const sheetId = process.env.GOOGLE_SHEET_ID!;

  // 시트 초기화 (기존 내용 전체 삭제)
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:I:clear`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
  );
  console.log('🧹 시트 초기화 완료');

  // 헤더 삽입
  await appendRows(token, [[
    '날짜시간', '이름', '이메일', '역할', '질문', '답변', '라우팅 위키', '모드', '대화ID'
  ]]);
  console.log('📋 헤더 삽입 완료');

  // 전체 메시지 + 대화 + 유저 조인
  const allMessages = await db
    .select({
      msgId: messages.id,
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

  // user+assistant 쌍으로 묶기
  const rows: string[][] = [];
  for (let i = 0; i < allMessages.length - 1; i++) {
    const cur = allMessages[i];
    const next = allMessages[i + 1];

    if (cur.role === 'user' && next.role === 'assistant' && cur.convId === next.convId) {
      if (!next.content.trim()) { i++; continue; } // 답변 없으면 스킵

      const kst = new Date(cur.createdAt).toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });

      rows.push([
        kst,
        cur.userName,
        cur.userEmail,
        cur.userRole,
        cur.content,
        next.content,
        (next.routedAgents ?? []).join(', '),
        next.mode,
        cur.convId,
      ]);
      i++; // assistant 메시지 건너뜀
    }
  }

  console.log(`📝 총 ${rows.length}개 Q&A 쌍 발견`);

  // 최신순 정렬: rows는 오래된 순 → 뒤집어서 append하면 오래된 것이 아래, 최신이 위
  const reversed = [...rows].reverse();

  // 100행씩 배치 삽입
  const BATCH = 100;
  for (let i = 0; i < reversed.length; i += BATCH) {
    const batch = reversed.slice(i, i + BATCH);
    await appendRows(token, batch);
    console.log(`  ✅ ${Math.min(i + BATCH, reversed.length)} / ${reversed.length} 완료`);
    if (i + BATCH < reversed.length) await new Promise(r => setTimeout(r, 500));
  }

  console.log('🎉 백필 완료!');
}

main().catch(err => { console.error(err); process.exit(1); });
