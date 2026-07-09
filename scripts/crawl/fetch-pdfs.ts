/**
 * 단과대/대학원 위키가 참조하는 PDF를 전수 스캔 → 다운로드 → 텍스트 추출 시도 → 인벤토리.
 *
 * 목적(현 단계): 위키화는 보류. PDF를 raw에 받아두고 "양이 얼마나 되고 텍스트 추출이 되는지(=이미지면 OCR 필요)"만 파악.
 *
 *   저장: ../Obsidian/SNU_{단과대|대학원}_LLM_Wiki/raw/html/{org}/{원본파일명}.pdf  (원본 보존)
 *   추출: 같은 폴더 옆에 ...{slug}.pdf.txt (텍스트 추출 결과, 있을 때만)
 *   리포트: 콘솔 + raw 기준 인벤토리 표
 *
 *   실행: npx tsx scripts/crawl/fetch-pdfs.ts
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
// pdf-parse 1.x: index.js가 import 시 테스트 PDF를 읽어 에러 → lib 직접 require
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const OBSIDIAN = path.resolve(process.cwd(), '..', 'Obsidian');
const WIKIS = [
  { dir: 'SNU_단과대_LLM_Wiki', group: '단과대' },
  { dir: 'SNU_대학원_LLM_Wiki', group: '대학원' },
];

type PdfRef = { url: string; org: string; group: string; sourceFile: string };

// wiki/ + raw/md/ 의 모든 .md를 스캔해 .pdf URL과 그 org를 수집
function collectPdfRefs(): PdfRef[] {
  const refs = new Map<string, PdfRef>(); // url → ref (dedupe)
  const pdfRe = /https?:\/\/[^\s)"'<>]+\.pdf/gi;
  for (const w of WIKIS) {
    const roots = [path.join(OBSIDIAN, w.dir, 'wiki'), path.join(OBSIDIAN, w.dir, 'raw', 'md')];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      walk(root, (file) => {
        if (!file.endsWith('.md')) return;
        const org = orgFromPath(file);
        if (!org) return;
        const txt = fs.readFileSync(file, 'utf8');
        const matches = txt.match(pdfRe);
        if (!matches) return;
        for (const m of matches) {
          const url = m.replace(/[.,)]+$/, '');
          if (!refs.has(url)) refs.set(url, { url, org, group: w.group, sourceFile: path.relative(OBSIDIAN, file) });
        }
      });
    }
  }
  return [...refs.values()];
}

function walk(dir: string, fn: (f: string) => void) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

// .../{overviews|entities|sources|facts}/{org}/file.md  또는  raw/md/{org}/file.md  에서 org 추출
function orgFromPath(file: string): string | null {
  const parts = file.split(path.sep);
  const i = parts.findIndex((p) => ['overviews', 'entities', 'sources', 'facts', 'strategy', 'md'].includes(p));
  return i >= 0 && parts[i + 1] ? parts[i + 1] : null;
}

function fetchBuf(url: string, redirects = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SNUWikiBot/1.0)' }, rejectUnauthorized: false }, (r) => {
      if (r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        const next = new URL(r.headers.location, url).toString();
        r.resume();
        return fetchBuf(next, redirects + 1).then(resolve, reject);
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const chunks: Buffer[] = [];
      r.on('data', (d) => chunks.push(d));
      r.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('timeout')));
  });
}

function decodeName(url: string): string {
  const raw = url.split('/').pop() || 'file.pdf';
  let name = raw;
  try { name = decodeURIComponent(raw); } catch { /* keep */ }
  return name.replace(/[\\/:*?"<>|]/g, '_'); // Windows 금지문자만 치환(한글 유지)
}

async function main() {
  const refs = collectPdfRefs();
  console.log(`\nPDF 참조 ${refs.length}건 발견\n` + '='.repeat(90));
  const rows: string[] = [];
  rows.push('| org | 그룹 | 파일 | size | pages | 추출텍스트 | 판정 |');
  rows.push('|---|---|---|--:|--:|--:|---|');

  for (const ref of refs) {
    const wdir = ref.group === '단과대' ? 'SNU_단과대_LLM_Wiki' : 'SNU_대학원_LLM_Wiki';
    const destDir = path.join(OBSIDIAN, wdir, 'raw', 'html', ref.org);
    fs.mkdirSync(destDir, { recursive: true });
    const fname = decodeName(ref.url);
    const pdfPath = path.join(destDir, fname);
    let size = 0, pages = 0, textLen = 0, verdict = '', firstChars = '';
    try {
      const buf = await fetchBuf(ref.url);
      size = buf.length;
      fs.writeFileSync(pdfPath, buf); // 원본 보존
      try {
        const d = await pdfParse(buf);
        pages = d.numpages || 0;
        const text = (d.text || '').trim();
        textLen = text.length;
        if (textLen > 0) fs.writeFileSync(pdfPath + '.txt', text, 'utf8');
        verdict = textLen > 200 ? '✅ 텍스트' : (textLen > 0 ? '△ 일부' : '🖼️ 이미지(OCR필요)');
        firstChars = text.slice(0, 120).replace(/\n/g, ' ');
      } catch (e) {
        verdict = '⚠️ 파싱실패: ' + (e as Error).message.slice(0, 40);
      }
      console.log(`✅ ${ref.org.padEnd(14)} ${(size / 1024).toFixed(0).padStart(5)}KB ${String(pages).padStart(3)}p  text=${String(textLen).padStart(6)}  ${verdict}  ${fname}`);
      if (firstChars) console.log(`     "${firstChars}"`);
    } catch (e) {
      verdict = '❌ 다운로드실패: ' + (e as Error).message.slice(0, 40);
      console.log(`❌ ${ref.org.padEnd(14)} ${verdict}  ${ref.url}`);
    }
    rows.push(`| ${ref.org} | ${ref.group} | ${fname.slice(0, 40)} | ${(size / 1024).toFixed(0)}KB | ${pages} | ${textLen}자 | ${verdict} |`);
  }

  console.log('\n' + '='.repeat(90));
  console.log(rows.join('\n'));
  // 인벤토리 .md 저장
  const out = `# PDF 다운로드 인벤토리 (위키화 전 판단용)\n\n생성: fetch-pdfs.ts. 원본 PDF는 각 위키 raw/html/{org}/에 보존, 추출 텍스트는 .pdf.txt.\n\n${rows.join('\n')}\n`;
  fs.writeFileSync(path.join(OBSIDIAN, 'PDF_인벤토리.md'), out, 'utf8');
  console.log('\n→ Obsidian/PDF_인벤토리.md 저장');
}

main().catch((e) => { console.error(e); process.exit(1); });
