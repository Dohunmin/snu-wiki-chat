/**
 * 통계연보 PDF 좌표기반 추출기 (SNU_통계 연보_LLM_Wiki)
 *
 * 왜: 이 PDF는 폰트에 ToUnicode 매핑이 없어 pdftotext로는 한글이 0자.
 *     pdf.js(getTextContent)는 한글을 복구하나 기본 추출은 읽기순서가 뒤섞임.
 *     → 아이템 좌표(transform x/y)로 행(y)·열(x)을 재구성해 표 구조를 보존한다.
 *
 * 출력(원본 PDF는 raw/src에 그대로 보존, 본 스크립트 산출물은 raw/extracted/):
 *   - full.txt          : 전 페이지, 행=줄 / 셀=TAB, "===== PAGE =====" 마커
 *   - pages/p{NNN}.txt  : 페이지별 파일(검증·챕터분할용)
 *   - _validation.tsv   : 페이지별 rows/items/hangul/digits (추출 실패 페이지 탐지)
 *
 * 실행: node scripts/extract-stat-yearbook.cjs
 * 의존: pdf-parse (snu-wiki-chat/node_modules)
 */
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');

const WIKI = 'C:/Users/USER/Desktop/Obsidian/SNU_통계 연보_LLM_Wiki';
const PDF = path.join(WIKI, 'raw/src/서울대학교 통계연보 2025년판(pdf) (3).pdf');
const OUTDIR = path.join(WIKI, 'raw/extracted');
const Y_TOL = 3;        // 같은 행으로 묶을 y 허용 오차(pt)
const CELL = '\t';      // 셀 구분자

const pages = {};

function render(pageData) {
  return pageData.getTextContent().then(tc => {
    const items = tc.items
      .map(i => ({ s: i.str, x: Math.round(i.transform[4] * 10) / 10, y: Math.round(i.transform[5] * 10) / 10 }))
      .filter(i => i.s && i.s.trim() !== '');
    // 행: y 내림차순(위→아래), 열: x 오름차순(좌→우)
    items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const rows = [];
    let cur = null;
    for (const it of items) {
      if (!cur || Math.abs(it.y - cur.y) > Y_TOL) { cur = { y: it.y, cells: [] }; rows.push(cur); }
      cur.cells.push(it);
    }
    const text = rows.map(r => r.cells.map(c => c.s).join(CELL)).join('\n');
    const hangul = (text.match(/[가-힣]/g) || []).length;
    const digits = (text.match(/[0-9]/g) || []).length;
    pages[pageData.pageIndex] = { text, rows: rows.length, hangul, digits, items: items.length };
    return ''; // 거대 문자열 누적 방지(파일은 따로 기록)
  });
}

(async () => {
  const buf = fs.readFileSync(PDF);
  await pdf(buf, { pagerender: render, max: 0 }); // max:0 = 전 페이지
  fs.mkdirSync(path.join(OUTDIR, 'pages'), { recursive: true });

  const idxs = Object.keys(pages).map(Number).sort((a, b) => a - b);
  let full = '# 통계연보 2025 — 좌표기반 추출(원문 verbatim, 표=TAB 구분)\n# 원본: raw/src/...2025년판.pdf | 추출기: scripts/extract-stat-yearbook.cjs\n';
  let val = 'pageIndex\tprintedGuess\trows\titems\thangul\tdigits\n';
  for (const i of idxs) {
    const p = pages[i];
    const pp = String(i + 1).padStart(3, '0');
    full += `\n\n===== PAGE index=${i} (printed≈${i + 1}) =====\n` + p.text + '\n';
    fs.writeFileSync(path.join(OUTDIR, 'pages', `p${pp}.txt`), p.text + '\n', 'utf8');
    val += `${i}\t${i + 1}\t${p.rows}\t${p.items}\t${p.hangul}\t${p.digits}\n`;
  }
  fs.writeFileSync(path.join(OUTDIR, 'full.txt'), full, 'utf8');
  fs.writeFileSync(path.join(OUTDIR, '_validation.tsv'), val, 'utf8');

  const totH = idxs.reduce((s, i) => s + pages[i].hangul, 0);
  const totD = idxs.reduce((s, i) => s + pages[i].digits, 0);
  const low = idxs.filter(i => pages[i].hangul < 5);
  console.log('pages:', idxs.length, '| total hangul:', totH, '| total digits:', totD);
  console.log('한글<5 (추출의심) 페이지수:', low.length, '| printed:', low.map(i => i + 1).join(',') || '없음');
  console.log('출력:', OUTDIR);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
