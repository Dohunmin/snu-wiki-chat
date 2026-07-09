/**
 * 규모 fact(현황/통계) 페이지 탐색 — 24개 기관에서 science의 /about/information/facts 같은
 *   "교수수·학생수·정원·전공수" 통계 페이지가 실존하는지 사이트맵 + 후보 슬러그로 동시 확인.
 *   추측 단독 금지(btw-008) → 사이트맵 fact-키워드 스캔 + 후보 probe 둘 다, 본문 스니펫·통계점수로 판정.
 *
 *   실행: npx tsx scripts/crawl/find-fact-pages.ts
 */
import https from 'https';
import http from 'http';

type Org = { org: string; domain: string; cands: string[] };

// adapter 계열별 후보 슬러그 (yaml 기존 구조 기반)
const SNU_CMS = (base: string[]) => [
  '/about/information/facts', '/about/facts', '/about/information/status', '/about/status',
  '/about/information/figures', '/about/information/overview', ...base,
];
const WP_KO = [
  '/현황/', '/대학현황/', '/학교현황/', '/일반현황/', '/통계/', '/학부현황/', '/재학생현황/',
  '/교원현황/', '/숫자로보는/', '/facts/', '/at-a-glance/', '/한눈에보는/',
];

const ORGS: Org[] = [
  // ── 단과대 12 ──
  { org: 'eng',            domain: 'eng.snu.ac.kr',         cands: SNU_CMS(['/about/engineering/facts', '/about/engineering/status', '/about/engineering/overview']) },
  { org: 'humanities',     domain: 'humanities.snu.ac.kr',  cands: SNU_CMS(['/about/figures', '/about/overview']) },
  { org: 'agriculture',    domain: 'cals.snu.ac.kr',        cands: SNU_CMS(['/about/introduction/facts', '/about/introduction/status', '/about/introduction/overview', '/about/introduction/general']) },
  { org: 'nursing',        domain: 'nursing.snu.ac.kr',     cands: SNU_CMS(['/about/introduction/facts', '/about/introduction/status', '/about/introduction/figures']) },
  { org: 'medicine',       domain: 'medicine.snu.ac.kr',    cands: [] },  // egovframe → 사이트맵/메뉴 의존
  { org: 'cls',            domain: 'snuti.snu.ac.kr',       cands: ['/현황/', '/대학현황/', '/학부현황/', '/통계/', '/facts/', '/about-status/', '/status/', '/overview/'] },
  { org: 'education',      domain: 'edu.snu.ac.kr',         cands: ['/대학소개/현황/', '/대학소개/대학현황/', '/대학소개/일반현황/', '/대학소개/통계/', '/현황/', '/대학현황/'] },
  { org: 'human-ecology',  domain: 'che.snu.ac.kr',         cands: WP_KO },
  { org: 'liberal-college',domain: 'snuc.snu.ac.kr',        cands: WP_KO },
  { org: 'pharmacy',       domain: 'snupharm.snu.ac.kr',    cands: WP_KO },
  { org: 'vet',            domain: 'vet.snu.ac.kr',         cands: ['/status/', '/facts/', '/현황/', '/대학현황/', '/college-status/', '/about-status/', '/overview/'] },
  { org: 'music',          domain: 'music.snu.ac.kr',       cands: ['/content/status', '/content/facts', '/content/overview', '/content/info', '/content/current'] },
  // ── 대학원 12 ──
  { org: 'law',            domain: 'law.snu.ac.kr',         cands: ['/page/status.php', '/page/facts.php', '/page/current.php', '/page/situation.php', '/page/overview.php'] },
  { org: 'gsph',           domain: 'health.snu.ac.kr',      cands: WP_KO },
  { org: 'gspa',           domain: 'gspa.snu.ac.kr',        cands: ['/kr/gspa/intro/status', '/kr/gspa/intro/facts', '/kr/gspa/intro/current', '/kr/gspa/intro/overview'] },
  { org: 'gses',           domain: 'gses.snu.ac.kr',        cands: SNU_CMS(['/about/figures', '/about/overview']) },
  { org: 'gsis',           domain: 'gsis.snu.ac.kr',        cands: ['/status/', '/facts/', '/at-a-glance/', '/현황/', '/gsis-facts/', '/about-gsis/'] },
  { org: 'dent',           domain: 'dentemp.snu.ac.kr',     cands: ['/intro/status/', '/intro/about/status/', '/intro/facts/', '/intro/about/facts/', '/intro/current/'] },
  { org: 'gsct',           domain: 'convergence.snu.ac.kr', cands: WP_KO },
  { org: 'gsiat',          domain: 'gsiat.snu.ac.kr',       cands: ['/information/status.asp', '/information/facts.asp', '/information/current.asp'] },
  { org: 'gsep',           domain: 'gsep.snu.ac.kr',        cands: ['/staticdata/static/introduction/status/', '/staticdata/static/introduction/facts/', '/staticdata/static/introduction/overview/'] },
  { org: 'gsds',           domain: 'gsds.snu.ac.kr',        cands: ['/about/status/', '/about/facts/', '/about/numbers/', '/about/overview/', '/about/at-a-glance/'] },
  { org: 'mba',            domain: 'gsb.snu.ac.kr',         cands: SNU_CMS(['/snu-gsb/facts', '/snu-gsb/status', '/snu-gsb/overview']) },
];

function get(u: string, r = 0): Promise<{ status: number; body: string }> {
  return new Promise((res) => {
    if (r > 5) return res({ status: 0, body: '' });
    const lib = u.startsWith('http://') ? http : https;
    const req = lib.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, rejectUnauthorized: false }, (x) => {
      const st = x.statusCode || 0;
      if (st >= 300 && st < 400 && x.headers.location) { x.resume(); return get(new URL(x.headers.location, u).toString(), r + 1).then(res); }
      const c: Buffer[] = []; x.on('data', (d) => c.push(d)); x.on('end', () => res({ status: st, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', () => res({ status: 0, body: '' }));
    req.setTimeout(12000, () => { req.destroy(); res({ status: 0, body: '' }); });
  });
}

const strip = (h: string) => h.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

// 통계 페이지 가능성 점수: 교수/학생/정원/명/현황 키워드 + 숫자그룹 빈도
function statScore(text: string): number {
  const kw = (text.match(/교수|학생|정원|재학생|전임|명\b|현황|통계|전공|학부생|대학원생/g) || []).length;
  const nums = (text.match(/\d{1,4}\s*명|\d{2,4}/g) || []).length;
  return kw * 2 + Math.min(nums, 40);
}

async function sitemapFactHits(domain: string): Promise<string[]> {
  const re = /현황|통계|숫자|규모|한눈|개황|일반현황|대학현황|facts|figures|numbers|statistics|at.a.glance|status/i;
  for (const sm of ['/sitemap_index.xml', '/sitemap.xml', '/page-sitemap.xml']) {
    const { status, body } = await get(`https://${domain}${sm}`);
    if (status !== 200 || !body.includes('<loc>')) continue;
    let locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    if (locs.some((l) => l.includes('-sitemap.xml'))) {
      const subs = locs.filter((l) => /page-sitemap|snu__|chairperson/.test(l));
      const all: string[] = [];
      for (const s of subs) { const r = await get(s); all.push(...[...r.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])); }
      locs = all;
    }
    const hits = locs.map((u) => { try { return decodeURIComponent(u.replace(`https://${domain}`, '')); } catch { return u; } }).filter((p) => re.test(p));
    if (hits.length) return [...new Set(hits)];
    return [];  // 사이트맵은 있는데 fact 힌트 없음
  }
  return ['(사이트맵 없음)'];
}

async function main() {
  for (const { org, domain, cands } of ORGS) {
    console.log(`\n${'='.repeat(78)}\n### ${org} — ${domain}`);
    const sm = await sitemapFactHits(domain);
    console.log(`  사이트맵 fact-힌트: ${sm.length ? sm.join('  ') : '(없음)'}`);
    const found: string[] = [];
    for (const c of cands) {
      const { status, body } = await get(`https://${domain}${c}`);
      if (status !== 200) continue;
      const text = strip(body);
      const score = statScore(text);
      if (text.length < 200) continue;
      const snip = text.slice(0, 90).replace(/\n/g, ' ');
      const mark = score >= 25 ? '🟢' : score >= 12 ? '🟡' : '⚪';
      found.push(`  ${mark} ${c}  [len ${text.length}, stat ${score}]  ${snip}…`);
    }
    console.log(found.length ? found.join('\n') : '  (후보 200응답 없음)');
    await new Promise((r) => setTimeout(r, 300));
  }
}
main();
