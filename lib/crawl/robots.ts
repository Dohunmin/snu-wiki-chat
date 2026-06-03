// Design Ref: college-grad-wiki §5.5 / §7 (호출 예절 — robots.txt 준수)
// host당 robots.txt 1회 fetch·캐시. 모든 fetch가 allowed() 통과해야 진행.

import robotsParser from 'robots-parser';

type Robots = ReturnType<typeof robotsParser>;

const cache = new Map<string, Robots | null>();

async function getRobots(host: string): Promise<Robots | null> {
  if (cache.has(host)) return cache.get(host)!;
  const robotsUrl = `https://${host}/robots.txt`;
  try {
    const res = await fetch(robotsUrl, { redirect: 'follow' });
    const body = res.ok ? await res.text() : '';
    const robots = robotsParser(robotsUrl, body);
    cache.set(host, robots);
    return robots;
  } catch {
    cache.set(host, null); // robots.txt 없음/오류 → 허용으로 간주(보수적으로 rate-limit는 유지)
    return null;
  }
}

export async function isAllowed(url: string, userAgent: string): Promise<boolean> {
  const host = new URL(url).host;
  const robots = await getRobots(host);
  if (!robots) return true;
  return robots.isAllowed(url, userAgent) ?? true;
}

export async function getCrawlDelay(host: string, userAgent: string): Promise<number | undefined> {
  const robots = await getRobots(host);
  return robots?.getCrawlDelay(userAgent);
}
