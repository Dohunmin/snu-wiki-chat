/**
 * "현황 페이지가 정말 메뉴에 없나" 증명 — 부재 판정 org들의 '소개(About)' 메뉴 전체를 덤프.
 *   science(facts 보유)를 양성대조로 함께 출력 → 다른 곳에 facts/현황 항목이 없음을 눈으로 확인.
 *   실행: npx tsx scripts/crawl/dump-about-menu.ts
 */
import https from 'https';

// [org, 어떤 페이지를 열어 메뉴를 추출할지, 메뉴로 인정할 href 접두어]
const TARGETS: [string, string, RegExp][] = [
  ['science(대조:facts보유)', 'https://science.snu.ac.kr/about/greeting', /\/about\//],
  ['eng',         'https://eng.snu.ac.kr/about/engineering/history',  /\/about\//],
  ['humanities',  'https://humanities.snu.ac.kr/about/goal',          /\/about\//],
  ['agriculture', 'https://cals.snu.ac.kr/about/introduction/history',/\/about\//],
  ['nursing',     'https://nursing.snu.ac.kr/about/introduction/history', /\/about\//],
  ['gses',        'https://gses.snu.ac.kr/about/history',             /\/about\//],
  ['medicine(egov)', 'https://medicine.snu.ac.kr/fnt/bbm/bbs/selectBoardArticleView.do?nttId=80', /selectBoardArticleView|fnGoMenu|nttId/],
];

function get(u: string, r = 0): Promise<string> {
  return new Promise((res) => {
    if (r > 5) return res('');
    const q = https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, rejectUnauthorized: false }, (x) => {
      const s = x.statusCode || 0;
      if (s >= 300 && s < 400 && x.headers.location) { x.resume(); return get(new URL(x.headers.location, u).toString(), r + 1).then(res); }
      const c: Buffer[] = []; x.on('data', (d) => c.push(d)); x.on('end', () => res(Buffer.concat(c).toString('utf8')));
    });
    q.on('error', () => res('')); q.setTimeout(12000, () => { q.destroy(); res(''); });
  });
}
const strip = (h: string) => h.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();
const re = /현황|통계|숫자|규모|개황|facts|figures|numbers|statistics|한눈|glance|일반현황|대학현황/i;

async function main() {
  for (const [org, url, menure] of TARGETS) {
    const html = await get(url);
    if (!html) { console.log(`\n### ${org}: ✗ 로드 실패`); continue; }
    // 메뉴 후보: href가 menure 패턴 + 텍스트 있는 a
    const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g)]
      .map((m) => [m[1], strip(m[2])] as [string, string])
      .filter(([h, t]) => menure.test(h) && t.length > 0 && t.length < 30);
    const uniq = [...new Map(links.map((l) => [l[1] + l[0], l])).values()];
    console.log(`\n### ${org}  (소개 메뉴 ${uniq.length}항목)`);
    console.log('  ' + uniq.map(([h, t]) => `${t}${re.test(h + ' ' + t) ? ' ⭐현황?' : ''}`).join('  ·  '));
  }
}
main();
