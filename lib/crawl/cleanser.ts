// Design Ref: college-grad-wiki §5.2 (클렌징 — 본문 추출 + GNB/footer 제거)
// Stage 1: content-selector로 main 영역만 선택 → GNB/footer는 컨테이너 밖이라 자동 소거.
// Stage 2(폴백): selector 미스 시 길이 sanity 게이트 + repeated-block 제거 훅.
// 결과: 임베딩 청크에 nav 노이즈가 섞이지 않도록 cleaned markdown만 반환.

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { MainContent, SelectorConfig } from './types';

const MIN_MAIN_CHARS = 120; // 이 미만이면 selector 미스로 보고 폴백
const DEFAULT_STRIP = ['nav', 'header', 'footer', 'script', 'style', 'noscript', '.gnb', '.lnb', '.breadcrumb', '.sns', '.btn_top', '#gnb', '#footer', '#header'];

/**
 * HTML → cleaned MainContent.
 * @param repeatedBlocks (선택) 같은 host 다수 페이지에 공통 등장하는 텍스트 블록 — GNB/footer로 간주해 제거.
 */
export function cleanseMain(
  html: string,
  selectors: SelectorConfig,
  baseUrl: string,
  repeatedBlocks?: Set<string>,
): MainContent {
  const $ = cheerio.load(html);

  // 전역 boilerplate 제거 (selector 밖이어도 방어적으로)
  const stripList = [...DEFAULT_STRIP, ...(selectors.extract.strip_selectors ?? [])];
  for (const sel of stripList) $(sel).remove();

  // Stage 1: main 컨테이너 선택 (배열이면 첫 충분한 것)
  const mainSelectors = Array.isArray(selectors.extract.main_selector)
    ? selectors.extract.main_selector
    : [selectors.extract.main_selector];
  let $main: cheerio.Cheerio<AnyNode> = $('body');
  for (const sel of mainSelectors) {
    const cand = $(sel).first();
    if (cand.length && cand.text().replace(/\s+/g, '').length >= MIN_MAIN_CHARS) {
      $main = cand;
      break;
    }
  }

  // main 내부 잔여 nav/footer 재제거
  $main.find('nav, .gnb, .lnb, .breadcrumb, footer, .footer').remove();

  // 링크 위주 리스트(=메뉴/사이트맵/관련링크) 제거 — 본문 컨테이너가 in-page nav를 품은 경우(humanities·science 사례).
  //   <li> 중 ≥60%가 링크 포함 + 리스트가 충분히 큼 → nav로 간주. 산문 리스트(링크 적음)는 보존.
  stripNavLists($, $main);
  // class/id에 menu·nav·gnb·lnb·sitemap·depth 포함 컨테이너 제거(본문 안에 섞인 경우)
  $main.find('[class*="menu"], [class*="gnb"], [class*="lnb"], [class*="sitemap"], [id*="sitemap"], [class*="depth"]').remove();

  let $picked = $main;
  let markdown = toMarkdown($, $main);

  // Stage 2: 산문(prose) 부족 → 밀도 기반 본문 재선택(문단 점수화, 사이트 무관).
  //   셀렉터가 메뉴 컨테이너를 잡거나 본문이 비표준 DOM(div/텍스트노드)일 때(science 사례) 구제.
  if (proseLen(markdown) < MIN_MAIN_CHARS) {
    const dense = pickDenseContent($);
    if (dense) {
      dense.find('nav, .gnb, .lnb, .breadcrumb, footer, .footer').remove();
      stripNavLists($, dense);
      dense.find('[class*="menu"], [class*="gnb"], [class*="lnb"], [class*="sitemap"], [id*="sitemap"], [class*="depth"]').remove();
      const md2 = toMarkdown($, dense);
      if (proseLen(md2) > proseLen(markdown)) { markdown = md2; $picked = dense; }
    }
  }

  // Stage 3: 그래도 미달 → body 전체(최후)
  if (markdown.replace(/\s+/g, '').length < MIN_MAIN_CHARS) {
    markdown = toMarkdown($, $('body'));
  }

  const title = pickTitle($, $picked, selectors);
  const assetUrls = collectAssets($, $picked, baseUrl);

  // repeated-block 제거 (cross-page GNB/footer 잔재)
  if (repeatedBlocks?.size) {
    markdown = markdown
      .split('\n\n')
      .filter((block) => !repeatedBlocks.has(block.trim()))
      .join('\n\n');
  }

  return { title, markdown: markdown.trim(), assetUrls, charCount: markdown.replace(/\s+/g, '').length };
}

/** markdown의 콘텐츠(=메뉴 리스트 제외) 글자수. heading은 콘텐츠로 인정(본문이 styled heading인 사이트 대응).
 *  메뉴/사이트맵은 대부분 '- ' 리스트라 낮게 나옴 → 본문(산문+heading)과 구별. */
function proseLen(md: string): number {
  return md
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('- '))
    .join('')
    .replace(/\s+/g, '').length;
}

/**
 * 밀도 기반 본문 컨테이너 선택(readability-lite). 사이트 무관 — 셀렉터가 실패할 때 구제.
 * 충분히 긴 문단(≥25자 own-text, 메뉴 라벨 제외)을 점수화해 직계 부모에 누적, 최고점 컨테이너 반환.
 * body 같은 최상위는 문단의 '직계 부모'가 아니므로 자연히 배제됨(메뉴 ul보다 산문 컨테이너가 우세).
 */
function pickDenseContent($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> | null {
  const score = new Map<AnyNode, number>();
  const add = (el: AnyNode | undefined, s: number) => {
    if (el && (el as { type?: string }).type === 'tag') score.set(el, (score.get(el) ?? 0) + s);
  };
  $('p, div, td, blockquote, h2, h3, h4').each((_, el) => {
    const $el = $(el);
    const clone = $el.clone();
    clone.find(NESTED_BLOCK).remove();
    const own = clone.text().replace(/\s+/g, ' ').trim();
    if (own.length < 20) return; // 메뉴/라벨(짧음) 제외
    // 링크 위주 짧은 문단은 패널티(메뉴성)
    const linkPenalty = $el.find('a[href]').length > 0 && own.length < 60 ? own.length : 0;
    const s = own.length - linkPenalty;
    add($el.parent().get(0) as AnyNode | undefined, s);
    add($el.parent().parent().get(0) as AnyNode | undefined, s * 0.4);
  });
  let best: AnyNode | null = null;
  let bestScore = 0;
  for (const [el, s] of score) if (s > bestScore) { bestScore = s; best = el; }
  return best ? $(best) : null;
}

/**
 * 링크 위주 <ul>/<ol> 제거(nav/메뉴/사이트맵). 사이트 무관 휴리스틱.
 * 규칙: 직계 <li> ≥3개 && 링크 포함 <li> 비율 ≥60% → 제거. 중첩 메뉴까지 안쪽부터 처리.
 */
function stripNavLists($: cheerio.CheerioAPI, $main: cheerio.Cheerio<AnyNode>): void {
  let removedAny = true;
  let guard = 0;
  while (removedAny && guard++ < 5) {
    removedAny = false;
    $main.find('ul, ol').each((_, ul) => {
      const $ul = $(ul);
      const lis = $ul.children('li');
      if (lis.length < 3) return;
      let linkLis = 0;
      lis.each((__, li) => {
        if ($(li).find('a[href]').length > 0) linkLis++;
      });
      if (linkLis / lis.length >= 0.6) {
        $ul.remove();
        removedAny = true;
      }
    });
  }
}

function pickTitle($: cheerio.CheerioAPI, $main: cheerio.Cheerio<AnyNode>, selectors: SelectorConfig): string {
  if (selectors.extract.title_selector) {
    const t = $(selectors.extract.title_selector).first().text().trim();
    if (t) return t;
  }
  const h = $main.find('h1, h2, .page_title, .title').first().text().trim();
  if (h) return h;
  return $('title').first().text().trim() || '제목 없음';
}

function collectAssets($: cheerio.CheerioAPI, $main: cheerio.Cheerio<AnyNode>, baseUrl: string): string[] {
  const urls = new Set<string>();
  $main.find('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src) urls.add(abs(baseUrl, src));
  });
  $main.find('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    if (/\.(pdf|hwp|docx?|xlsx?|pptx?|zip)$/i.test(href)) urls.add(abs(baseUrl, href));
  });
  return [...urls];
}

/**
 * 경량 HTML→Markdown. 블록요소의 **고유 텍스트**(중첩 블록 제외)를 추출 — 본문이 <p> 아닌 <div>/텍스트노드에
 * 있어도 포착(humanities·science 인사말 사례). 전역 dedup으로 중첩 중복 방지. 정적 정보페이지용(점진 개선).
 */
const BLOCK_SEL = 'h1, h2, h3, h4, h5, h6, p, li, blockquote, td, div, section, article';
const NESTED_BLOCK = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,td,div,section,article,ul,ol,table';

function toMarkdown($: cheerio.CheerioAPI, $main: cheerio.Cheerio<AnyNode>): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  $main.find(BLOCK_SEL).each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    // 고유 텍스트 = 자신의 텍스트에서 중첩 블록요소 텍스트 제외(부모·자식 중복 방지)
    const clone = $(el).clone();
    clone.find(NESTED_BLOCK).remove();
    const text = clone.text().replace(/\s+/g, ' ').trim();
    if (text.length < 2 || seen.has(text)) return;
    seen.add(text);
    if (tag === 'h1') lines.push(`# ${text}`);
    else if (tag === 'h2') lines.push(`## ${text}`);
    else if (tag === 'h3') lines.push(`### ${text}`);
    else if (tag === 'h4' || tag === 'h5' || tag === 'h6') lines.push(`#### ${text}`);
    else if (tag === 'li') lines.push(`- ${text}`);
    else lines.push(text);
  });
  return mergeMarkers(lines).join('\n\n');
}

/**
 * 번호/짧은 마커 단편 병합: 구조화 목록(아젠다·연혁)에서 "- 1.1"·"1." 같은 마커가 다음 본문과 분리될 때 합침.
 *   "- 1.1" + "관악 50주년 인재상 선포" → "- 1.1 관악 50주년 인재상 선포". 마커에 숫자가 있을 때만(오병합 방지).
 */
function mergeMarkers(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i];
    const next = lines[i + 1];
    const m = cur.match(/^- (.{1,10})$/);
    // 마커 = 숫자 위주 짧은 토큰(1.1, 2, (3) 등). 다음 줄이 일반 본문이면 병합.
    if (m && /^[\d][\d.\s()-]*$/.test(m[1].trim()) && next && !next.startsWith('#') && !next.startsWith('- ')) {
      out.push(`- ${m[1].trim()} ${next}`);
      i++;
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** 상대 URL → 절대 URL. */
export function abs(baseUrl: string, href: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}
