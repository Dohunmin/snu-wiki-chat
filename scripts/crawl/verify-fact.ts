/**
 * 후보 현황 페이지 실본문 검증 + snu-cms 단과대 facts 부재 확인.
 *   실행: npx tsx scripts/crawl/verify-fact.ts
 */
import https from 'https';

const VERIFY: [string, string][] = [
  ['cls /facts/', 'https://snuti.snu.ac.kr/facts/'],
  ['pharmacy /facts/', 'https://snupharm.snu.ac.kr/facts/'],
  ['pharmacy /연구현황/', 'https://snupharm.snu.ac.kr/연구현황/'],
  ['human-ecology /대학현황/', 'https://che.snu.ac.kr/대학현황/'],
  ['dent /intro/about/facts/', 'https://dentemp.snu.ac.kr/intro/about/facts/'],
  ['dent /intro/current/', 'https://dentemp.snu.ac.kr/intro/current/'],
  ['gsph /인원현황/', 'https://health.snu.ac.kr/인원현황/'],
  ['gsph /시설현황/', 'https://health.snu.ac.kr/시설현황/'],
];

// snu-cms 단과대 about 인덱스 → facts/현황 메뉴 링크 존재?
const MENU: [string, string][] = [
  ['eng', 'https://eng.snu.ac.kr/about/engineering/history'],
  ['humanities', 'https://humanities.snu.ac.kr/about/goal'],
  ['agriculture', 'https://cals.snu.ac.kr/about/introduction/history'],
  ['nursing', 'https://nursing.snu.ac.kr/about/introduction/history'],
  ['gses', 'https://gses.snu.ac.kr/about/history'],
];

function get(u: string, r = 0): Promise<{ status: number; body: string }> {
  return new Promise((res) => {
    if (r > 5) return res({ status: 0, body: '' });
    const req = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, rejectUnauthorized: false }, (x) => {
      const st = x.statusCode || 0;
      if (st >= 300 && st < 400 && x.headers.location) { x.resume(); return get(new URL(x.headers.location, u).toString(), r + 1).then(res); }
      const c: Buffer[] = []; x.on('data', (d) => c.push(d)); x.on('end', () => res({ status: st, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', () => res({ status: 0, body: '' }));
    req.setTimeout(12000, () => { req.destroy(); res({ status: 0, body: '' }); });
  });
}
const strip = (h: string) => h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();

async function main() {
  console.log('━━━━━━ 후보 현황 페이지 실본문 ━━━━━━');
  for (const [label, url] of VERIFY) {
    const { status, body } = await get(url);
    if (status !== 200) { console.log(`\n### ${label}\n  ✗ HTTP ${status}`); continue; }
    const t = strip(body);
    // 본문 부분 추출: 메뉴/푸터 뒤 실내용. "현황/통계/명/정원" 주변 표본
    const idx = Math.max(t.search(/교수|학생|정원|재학생|전임교원|현황표|명\s/), 0);
    console.log(`\n### ${label}  [${t.length}자]`);
    console.log('  본문표본: ' + t.slice(idx, idx + 500).replace(/\s+/g, ' '));
  }
  console.log('\n\n━━━━━━ snu-cms 단과대 about 메뉴에 facts/현황 링크? ━━━━━━');
  for (const [org, url] of MENU) {
    const { status, body } = await get(url);
    if (status !== 200) { console.log(`\n### ${org}: ✗ HTTP ${status}`); continue; }
    const links = [...body.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g)]
      .map((m) => [m[1], strip(m[2])] as [string, string])
      .filter(([h, txt]) => /현황|통계|숫자|규모|개황|facts|figures|numbers|statistics|한눈/i.test(h + ' ' + txt));
    const uniq = [...new Map(links.map((l) => [l[0], l])).values()].slice(0, 10);
    console.log(`### ${org}: ${uniq.length ? uniq.map(([h, t]) => `${t.slice(0, 14)}→${h}`).join('  |  ') : '(facts/현황 메뉴 링크 없음)'}`);
  }
}
main();
