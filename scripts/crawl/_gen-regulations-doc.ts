// 규정집 링크 워크플로우 결과(JSON) → 단과대별 규정 다운로드 링크 문서 생성.
// 사용: npx tsx scripts/crawl/_gen-regulations-doc.ts <workflow.output>

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OBSIDIAN = process.env.OBSIDIAN_PATH ?? join(process.cwd(), '..', 'Obsidian');
const jsonPath = process.argv[2];
if (!jsonPath) throw new Error('workflow output JSON 경로 필요');

interface Doc { title: string; url: string; format: string }
interface Reg { _id: string; _name: string; regulationsFound: boolean; regulationsPageUrl: string; documents: Doc[]; note: string }

const dec = (s: string) => (s ?? '').replace(/&amp;/g, '&').trim();
const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8'));
const regs: Reg[] = (parsed.result ?? parsed).filter(Boolean);

// 실패/누락 조직 폴백(워크플로우 실패분). science는 snu-cms /about/rule (cals와 동형 mode=download&ruleidx).
const KNOWN_FALLBACK: Record<string, { page: string; note: string }> = {
  science: { page: 'https://science.snu.ac.kr/about/rule', note: '워크플로우 에이전트 실패 → 재정찰 필요. 자연대 규정집은 10편 체계(/about/rule), cals와 동형이면 ?mode=download&ruleidx=N 패턴으로 받을 수 있음(개별 ruleidx 확인 필요).' },
};
const ORDER = ['eng', 'humanities', 'science', 'social', 'agriculture', 'education', 'business', 'human-ecology', 'nursing', 'medicine', 'vet', 'pharmacy', 'cls', 'liberal-college', 'music'];
const NAME: Record<string, string> = { eng: '공과대학', humanities: '인문대학', science: '자연과학대학', social: '사회과학대학', agriculture: '농업생명과학대학', education: '사범대학', business: '경영대학', 'human-ecology': '생활과학대학', nursing: '간호대학', medicine: '의과대학', vet: '수의과대학', pharmacy: '약학대학', cls: '첨단융합학부', 'liberal-college': '학부대학', music: '음악대학' };

const byId = new Map(regs.map((r) => [r._id, r]));
const L: string[] = [];
L.push('# SNU 단과대 규정집 다운로드 링크', '');
L.push('> 단과대별 **규정자료실 문서 직링크(PDF/HWP)**. 워크플로우 실측(2026-06-03). 받아서 각 단과대 `raw/` 폴더에 보관하세요.');
L.push('> ⚠ 일부 링크는 **로그인/세션쿠키/nonce**가 필요합니다 — 해당 규정 페이지를 브라우저로 먼저 연 뒤, 같은 세션에서 받으세요. (`&amp;`는 `&`로 디코딩됨.)', '');

// 요약
L.push('## 📊 요약', '');
L.push('| 단과대 | 문서 수 | 규정 페이지 | 비고 |', '|---|--:|---|---|');
for (const id of ORDER) {
  const r = byId.get(id);
  if (!r) { const f = KNOWN_FALLBACK[id]; L.push(`| ${NAME[id]} | 0 | ${f ? dec(f.page) : '-'} | ${f ? '⚠ 재정찰 필요' : '미수집'} |`); continue; }
  const caveat = /로그인|회원전용|nonce|세션|쿠키/.test(r.note) ? '⚠ 로그인/세션 필요분 있음' : '직링크';
  L.push(`| ${r._name} | ${r.documents?.length ?? 0} | ${dec(r.regulationsPageUrl) || '-'} | ${r.regulationsFound ? caveat : '규정 없음'} |`);
}
L.push('');

// 단과대별 상세
L.push('## 🏛 단과대별 상세', '');
for (const id of ORDER) {
  const r = byId.get(id);
  const name = NAME[id] ?? id;
  if (!r) {
    const f = KNOWN_FALLBACK[id];
    L.push(`### ${name} \`${id}\``, f ? `- 규정 페이지: ${dec(f.page)}` : '- 미수집', f ? `> ${f.note}` : '', '');
    continue;
  }
  L.push(`### ${name} \`${id}\``);
  L.push(`- **규정 페이지**: ${dec(r.regulationsPageUrl) || '(없음)'}`);
  if (r.documents?.length) {
    L.push('', '| # | 제목 | 형식 | 다운로드 URL |', '|--:|---|---|---|');
    r.documents.forEach((d, i) => L.push(`| ${i + 1} | ${dec(d.title)} | ${d.format} | ${dec(d.url)} |`));
  } else {
    L.push('- 문서 직링크 없음');
  }
  // note 요약(첫 280자)
  const n = r.note?.replace(/\n+/g, ' ').trim() ?? '';
  if (n) L.push('', `> **비고**: ${n.length > 320 ? n.slice(0, 320) + '…' : n}`);
  L.push('');
}

const pdf = regs.reduce((a, r) => a + (r.documents?.filter((d) => d.format === 'pdf').length ?? 0), 0);
const hwp = regs.reduce((a, r) => a + (r.documents?.filter((d) => /hwp/.test(d.format)).length ?? 0), 0);
L.push('---', `*수집 단과대 ${regs.length}/15 · 문서 ${regs.reduce((a, r) => a + (r.documents?.length ?? 0), 0)}건(PDF ${pdf}·HWP ${hwp}). science는 재정찰 필요.*`);

const out = join(OBSIDIAN, 'SNU_단과대_LLM_Wiki', '규정집_링크.md');
writeFileSync(out, L.join('\n'), 'utf-8');
console.log(`작성: ${out}`);
console.log(`단과대 ${regs.length}/15 · 문서 ${regs.reduce((a, r) => a + (r.documents?.length ?? 0), 0)}건 (PDF ${pdf}·HWP ${hwp})`);
