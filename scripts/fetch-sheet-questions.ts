/**
 * 실제 Google Sheet 질의로그(E열=question)에서 사용자 질문을 읽어
 * 길이 상위 50%(긴 절반)만 추려 평가자 gold-set 입력으로 출력.
 *
 *   - 합성 질문 생성 금지: 반드시 실제 시트 질문만 사용 (사용자 지시)
 *   - 길이 기준 상위 50% 이상만
 *
 * 실행: npx tsx scripts/fetch-sheet-questions.ts [--all] [--json out.json]
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
import crypto from 'crypto';
try { loadEnvFile('.env.local'); } catch { /* 없으면 무시 */ }

// 로컬 JSON 파일에서 직접 읽기 (Vercel env 없을 때 fallback) — backfill-sheets.ts와 동일
if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  const jsonPath = 'C:/Users/USER/Desktop/Uxlab/총장에이전트/snu-wiki-qna-db-673d456b6db9.json';
  if (fs.existsSync(jsonPath)) {
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = fs.readFileSync(jsonPath, 'utf-8');
  }
}
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1LxIk7t-mU-BMCHFOqEErRipI649kFp8izMYI4XJ85Cc';

async function getAccessToken(): Promise<string> {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const jwt = `${signingInput}.${sign.sign(creds.private_key, 'base64url')}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const data = await res.json() as { access_token?: string; error_description?: string };
  if (!data.access_token) throw new Error(`token failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

export interface SheetQuestion {
  question: string;
  answer: string;
  role: string;
  wikis: string;
  mode: string;
  timestamp: string;
  length: number;
}

/** 시트 전체에서 질문 행 읽기 (헤더 제외, E열=question) */
export async function fetchSheetQuestions(): Promise<SheetQuestion[]> {
  const token = await getAccessToken();
  // A:I 전체 — A=timestamp, D=role, E=question, G=wikis, H=mode
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A:I`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`values.get failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { values?: string[][] };
  const rows = data.values ?? [];
  const out: SheetQuestion[] = [];
  for (let i = 1; i < rows.length; i++) {   // row 0 = 헤더
    const r = rows[i];
    const question = (r[4] ?? '').trim();   // E열
    if (!question) continue;
    out.push({
      timestamp: r[0] ?? '',
      role: r[3] ?? '',
      question,
      answer: (r[5] ?? '').trim(),          // F열 = 봇 답변
      wikis: r[6] ?? '',
      mode: r[7] ?? '',
      length: [...question].length,         // 코드포인트 길이(한글/이모지 안전)
    });
  }
  return out;
}

/** 중복 질문 제거(동일 텍스트) */
function dedup(qs: SheetQuestion[]): SheetQuestion[] {
  const seen = new Set<string>();
  const out: SheetQuestion[] = [];
  for (const q of qs) {
    const key = q.question.replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/** 길이 상위 50%(긴 절반) — 중앙값 이상 */
export function topHalfByLength(qs: SheetQuestion[]): { all: SheetQuestion[]; topHalf: SheetQuestion[]; median: number } {
  const uniq = dedup(qs);
  const sorted = [...uniq].sort((a, b) => b.length - a.length);
  const lens = sorted.map(q => q.length).sort((a, b) => a - b);
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const topHalf = sorted.filter(q => q.length >= median);
  return { all: uniq, topHalf, median };
}

async function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes('--all');
  const jsonIdx = args.indexOf('--json');
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null;

  const raw = await fetchSheetQuestions();
  const { all, topHalf, median } = topHalfByLength(raw);

  console.log('═'.repeat(80));
  console.log(`시트 질문 로그: 총 ${raw.length}행 → 중복제거 ${all.length}개`);
  console.log(`길이 중앙값: ${median}자 → 상위 50%(긴 절반): ${topHalf.length}개`);
  console.log('═'.repeat(80));

  const list = showAll ? topHalf : topHalf.slice(0, 30);
  list.forEach((q, i) => {
    console.log(`\n[${i + 1}] (${q.length}자, role=${q.role}, wikis=${q.wikis}, mode=${q.mode})`);
    console.log(`    ${q.question}`);
  });
  if (!showAll && topHalf.length > 30) {
    console.log(`\n... 외 ${topHalf.length - 30}개 (--all 로 전체 출력)`);
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(topHalf, null, 2), 'utf-8');
    console.log(`\n💾 상위 50% ${topHalf.length}개 → ${jsonOut}`);
  }
}

// 직접 실행할 때만 main() — 다른 스크립트가 fetchSheetQuestions를 import할 때 부작용 방지
const invokedDirectly = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('fetch-sheet-questions.ts');
if (invokedDirectly) {
  main().catch(err => { console.error(err); process.exit(1); });
}
