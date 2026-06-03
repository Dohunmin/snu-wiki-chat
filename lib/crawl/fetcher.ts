// Design Ref: college-grad-wiki §5.1 (fetch 하이브리드) / §5.5 (rate-limit) / §6 (TLS 처리)
// 정적: fetch (cheerio가 파싱). 동적(gspa·gsct): playwright 지연 import.
// per-host 직렬 rate-limit. music류 TLS 중간인증서 누락은 relaxTLS로 보정(지연 import undici).

import { getDefaults } from '../config/orgs';
import { isAllowed, getCrawlDelay } from './robots';

export interface FetchOptions {
  userAgent?: string;
  relaxTLS?: boolean; // music 등 TLS 체인 누락 사이트
  checkRobots?: boolean; // 기본 true
}

// playwright(지연 import) 최소 타입 — 미설치여도 컴파일되도록 구조만 선언
interface PwPage {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  content(): Promise<string>;
}
interface PwBrowser {
  newPage(opts: { userAgent: string }): Promise<PwPage>;
  close(): Promise<void>;
}

// host별 마지막 요청 시각 (직렬 rate-limit)
const lastHit = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rateLimit(host: string): Promise<void> {
  const { rate_ms } = getDefaults();
  const robotsDelay = (await getCrawlDelay(host, ua())) ?? 0;
  const minGap = Math.max(rate_ms, robotsDelay * 1000);
  const last = lastHit.get(host) ?? 0;
  const wait = last + minGap - Date.now();
  if (wait > 0) await sleep(wait + Math.floor(Math.random() * 300)); // jitter
  lastHit.set(host, Date.now());
}

function ua(): string {
  return getDefaults().user_agent;
}

/** 정적 페이지 HTML. */
export async function fetchStatic(url: string, opts: FetchOptions = {}): Promise<string> {
  const host = new URL(url).host;
  const userAgent = opts.userAgent ?? ua();
  if (opts.checkRobots !== false && !(await isAllowed(url, userAgent))) {
    throw new Error(`robots.txt disallow: ${url}`);
  }
  await rateLimit(host);

  let dispatcher: unknown;
  if (opts.relaxTLS) {
    try {
      // 변수 specifier로 지연 import (미설치여도 타입 해석 안 함)
      const undiciMod = 'undici';
      const undici = (await import(undiciMod)) as { Agent: new (o: unknown) => unknown };
      dispatcher = new undici.Agent({ connect: { rejectUnauthorized: false } });
    } catch {
      // undici 미가용 → 표준 fetch로 시도(실패 가능). 로그만.
      console.warn(`[fetcher] relaxTLS 요청됐으나 undici 미가용: ${host}`);
    }
  }

  const res = await fetch(url, {
    headers: { 'user-agent': userAgent },
    redirect: 'follow',
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit);

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.text();
}

/** 동적 페이지 HTML (JS 렌더). playwright 지연 import — 미설치 시 명확한 에러. */
export async function fetchDynamic(url: string, opts: FetchOptions = {}): Promise<string> {
  const host = new URL(url).host;
  const userAgent = opts.userAgent ?? ua();
  if (opts.checkRobots !== false && !(await isAllowed(url, userAgent))) {
    throw new Error(`robots.txt disallow: ${url}`);
  }
  await rateLimit(host);

  // 변수 specifier로 지연 import — 미설치 시 명확한 에러 (Phase 1엔 불필요)
  let pw: { chromium: { launch: () => Promise<PwBrowser> } };
  try {
    const pwMod = 'playwright';
    pw = (await import(pwMod)) as typeof pw;
  } catch {
    throw new Error(
      `[fetcher] dynamic fetch엔 playwright 필요(미설치). dynamic 엔진(gspa·gsct)은 ` +
        `npm i -D playwright && npx playwright install chromium 후 사용. (${url})`,
    );
  }
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ userAgent });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    return await page.content();
  } finally {
    await browser.close();
  }
}

export async function fetchHtml(url: string, mode: 'static' | 'dynamic', opts: FetchOptions = {}): Promise<string> {
  return mode === 'dynamic' ? fetchDynamic(url, opts) : fetchStatic(url, opts);
}
