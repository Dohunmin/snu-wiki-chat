/**
 * 실제 페이지 전수 열거 — 추측 슬러그가 아니라 사이트맵/홈 메뉴에서 진짜 존재하는 페이지를 뽑는다.
 *   목적: "비전이 정말 없나?" + "우리가 놓친 실존 페이지(교수진·연구소·자료실)는?" 를 사이트 실데이터로 확인.
 *   sitemap_index → 하위 sitemap 펼침. 없으면 홈페이지 <a href> 내부 링크 추출.
 *
 *   실행: npx tsx scripts/crawl/enumerate-pages.ts
 */
import https from 'https';

const DOMAINS: Record<string, string> = {
  social: 'social.snu.ac.kr',
  education: 'edu.snu.ac.kr',
  mba: 'gsb.snu.ac.kr',
  gsiat: 'gsiat.snu.ac.kr',
  gsis: 'gsis.snu.ac.kr',
  gsep: 'gsep.snu.ac.kr',
  gsct: 'convergence.snu.ac.kr',
  law: 'law.snu.ac.kr',
};

// 관심 키워드 — 이 페이지가 있으면 강조(놓친 실존 페이지 발견용)
const FLAGS: Record<string, RegExp> = {
  '🎯비전/미션': /비전|미션|목표|인재상|vision|mission|goal|ideal|identity|소개|about|overview|intro/i,
  '👥교수진': /교수|faculty|people|professor|구성원|teacher|member/i,
  '🏛연구소': /연구소|institute|center|센터|연구원|lab/i,
  '📄자료/규정': /자료실|규정|archive|down|발간|publication|소식지|newsletter/i,
};

function get(u: string, r = 0): Promise<string> {
  return new Promise((res, rej) => {
    if (r > 5) return rej(new Error('redir'));
    https.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, rejectUnauthorized: false }, (x) => {
      if (x.statusCode && x.statusCode >= 300 && x.statusCode < 400 && x.headers.location) {
        x.resume(); return get(new URL(x.headers.location, u).toString(), r + 1).then(res, rej);
      }
      if (x.statusCode !== 200) { x.resume(); return rej(new Error('HTTP ' + x.statusCode)); }
      const c: Buffer[] = []; x.on('data', (d) => c.push(d)); x.on('end', () => res(Buffer.concat(c).toString('utf8')));
    }).on('error', rej);
  });
}

function dec(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

async function sitemapPages(domain: string): Promise<string[] | null> {
  for (const sm of ['/sitemap_index.xml', '/sitemap.xml', '/page-sitemap.xml']) {
    try {
      const xml = await get(`https://${domain}${sm}`);
      let locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      // 인덱스면 하위 page-sitemap만 펼침(글 게시판 제외)
      if (locs.some((l) => l.includes('-sitemap.xml'))) {
        const subs = locs.filter((l) => /page-sitemap|snu__|chairperson/.test(l));
        const all: string[] = [];
        for (const s of subs) { try { const x = await get(s); all.push(...[...x.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])); } catch { /* skip */ } }
        locs = all;
      }
      if (locs.length) return locs.map((u) => u.replace(`https://${domain}`, '').replace(/\/$/, '') || '/');
    } catch { /* try next */ }
  }
  return null;
}

async function menuPages(domain: string): Promise<string[]> {
  try {
    const html = await get(`https://${domain}/`);
    const hrefs = [...html.matchAll(/href=["']([^"'#?]+)["']/g)].map((m) => m[1])
      .filter((h) => !/^(https?:)?\/\//.test(h) || h.includes(domain))
      .map((h) => h.replace(/^https?:\/\/[^/]+/, ''))
      .filter((h) => h.startsWith('/') && !/\.(jpg|png|gif|css|js|svg|ico|pdf|woff)/i.test(h));
    return [...new Set(hrefs)];
  } catch (e) { return ['(홈 로드 실패: ' + (e as Error).message + ')']; }
}

async function main() {
  for (const [org, domain] of Object.entries(DOMAINS)) {
    console.log(`\n${'='.repeat(80)}\n### ${org} — ${domain}`);
    let pages = await sitemapPages(domain);
    const via = pages ? 'sitemap' : 'home-menu';
    if (!pages) pages = await menuPages(domain);
    const uniq = [...new Set(pages.map(dec))].filter((p) => !/^\/(en|wp-|attach|sso|main_template|feed|comment)/.test(p));
    console.log(`(${via}, ${uniq.length}개 내부 경로)`);
    // 플래그별 강조
    for (const [label, re] of Object.entries(FLAGS)) {
      const hit = uniq.filter((p) => re.test(p));
      if (hit.length) console.log(`  ${label}: ${hit.join(' , ')}`);
    }
    // 전체(상위 50)
    console.log('  — 전체 —\n   ' + uniq.slice(0, 50).join('\n   '));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
