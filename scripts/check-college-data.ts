/** 단과대/대학원 data/*.json 항목수 집계 — 크롤 완전성 점검 (무료). npx tsx scripts/check-college-data.ts */
import fs from 'fs';
import path from 'path';

const COLLEGE = ['eng','humanities','science','social','agriculture','education','business','human-ecology','nursing','fine-arts','music','medicine','vet','pharmacy','cls','liberal-college'];
const GRAD = ['grad-general','gsph','gspa','gses','gsis','dent','mba','law','gsct','gsiat','gsep','gsds'];

function counts(id: string) {
  const p = path.join(process.cwd(), 'data', `${id}.json`);
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const c = (k: string) => (Array.isArray(d[k]) ? d[k].length : 0);
  return { ov: c('overviews'), ent: c('entities'), src: c('sources'), fact: c('facts'), top: c('topics'), st: c('stances') };
}

function row(id: string) {
  const c = counts(id);
  if (!c) { console.log(`${id.padEnd(16)} ❌ 파일 없음`); return; }
  const core = c.ov + c.ent;
  const flag = core === 0 ? '  ⚠️ 핵심(개요+엔티티) 0 — 크롤 실패/빈shell' : core <= 1 ? '  ⚠️ 빈약' : '';
  console.log(`${id.padEnd(16)} 개요 ${String(c.ov).padStart(2)}  엔티티 ${String(c.ent).padStart(2)}  소스 ${c.src}  팩트 ${c.fact}  토픽 ${c.top}${flag}`);
}

console.log('━━━ 단과대 ━━━');
for (const id of COLLEGE) row(id);
console.log('\n━━━ 대학원 ━━━');
for (const id of GRAD) row(id);
