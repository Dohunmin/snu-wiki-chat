// Phase2 단과대 crawl-config 적용기 (1회용).
// 사용: npx tsx scripts/crawl/_apply-college-config.ts <discovery.json> [--dry]
// 정찰 워크플로우 JSON({result:[{id,aboutPages,depts,institutes,faculty,strategy,...}]})을 읽어
// colleges.yaml의 각 org 블록을 텍스트 패치: active:false→true + about/entity/strategy/faculty 필드를 notes 앞에 삽입.
// 주석 보존(yaml dump 미사용). 끝에 js-yaml로 파싱 검증.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

interface Dept { slug: string; label: string; path: string; external: boolean; tlsRelax?: boolean }
interface Named { slug: string; label: string; path: string }
interface Cfg {
  id: string; _id?: string; aboutPages: { slug: string; path: string }[]; depts: Dept[];
  institutes: Named[]; faculty: string; strategy: Named[]; deptMode: string; notes: string;
}
const orgId = (c: Cfg) => c._id ?? c.id; // 에이전트가 id에 도메인을 넣음 → 실제 org id는 _id

const jsonPath = process.argv[2];
const dry = process.argv.includes('--dry');
if (!jsonPath) throw new Error('discovery JSON 경로 필요');

const parsed = JSON.parse(readFileSync(jsonPath, 'utf-8'));
const cfgs: Cfg[] = parsed.result ?? parsed;
const yamlPath = process.env.COLLEGES_CONFIG_PATH ?? join(process.cwd(), 'config', 'colleges.yaml');
let text = readFileSync(yamlPath, 'utf-8');

const q = (s: string) => (/[:#?\[\]{}&*!|>'"%@`,]|^\s|\s$/.test(s) ? JSON.stringify(s) : s); // 필요시 따옴표

function block(cfg: Cfg): string {
  const L: string[] = [];
  if (cfg.aboutPages?.length) {
    L.push('    about_pages:');
    for (const a of cfg.aboutPages) L.push(`      - { slug: ${q(a.slug)}, path: ${q(a.path)} }`);
  }
  const ents = [
    ...(cfg.depts ?? []).map((d) => ({ kind: '학과', ...d })),
    ...(cfg.institutes ?? []).map((i) => ({ kind: '부속기관', ...i, external: false as boolean, tlsRelax: undefined })),
  ];
  if (ents.length) {
    L.push('    entity_pages:');
    for (const e of ents) {
      const tls = (e as Dept).tlsRelax ? ', tls_relax: true' : '';
      L.push(`      - { entity: ${e.kind}, slug: ${q(e.slug)}, label: ${q(e.label)}, path: ${q(e.path)}${tls} }`);
    }
  }
  if (cfg.strategy?.length) {
    L.push('    strategy_pages:');
    for (const s of cfg.strategy) L.push(`      - { slug: ${q(s.slug)}, label: ${q(s.label)}, path: ${q(s.path)} }`);
  }
  if (cfg.faculty) L.push(`    faculty: { path: ${q(cfg.faculty)} }`);
  return L.join('\n');
}

let patched = 0;
const report: string[] = [];
for (const cfg of cfgs) {
  // org 블록 경계: `  - id: {id}` 부터 다음 `  - id:` 또는 `# ===` 푸터까지
  const oid = orgId(cfg);
  const startRe = new RegExp(`(^  - id: ${oid}\\s*$)`, 'm');
  const m = startRe.exec(text);
  if (!m) { report.push(`✗ ${oid}: org 블록 못 찾음`); continue; }
  const start = m.index;
  const after = text.slice(start + m[0].length);
  const nextRel = after.search(/^  - id: |^# ={3,}/m);
  const end = nextRel < 0 ? text.length : start + m[0].length + nextRel;
  let blk = text.slice(start, end);

  // active:false → true
  blk = blk.replace(/^(\s*active:\s*)false\s*$/m, '$1true');

  // notes 라인 앞에 삽입 (notes 없으면 블록 끝에)
  const ins = block(cfg);
  if (ins) {
    const notesRe = /^\s*notes:\s.*$/m;
    if (notesRe.test(blk)) blk = blk.replace(notesRe, (nl) => `${ins}\n${nl}`);
    else blk = blk.replace(/\s*$/, `\n${ins}\n`);
  }

  text = text.slice(0, start) + blk + text.slice(end);
  patched++;
  report.push(`✓ ${oid}: about ${cfg.aboutPages?.length ?? 0} / dept ${cfg.depts?.length ?? 0} / inst ${cfg.institutes?.length ?? 0} / strat ${cfg.strategy?.length ?? 0} / faculty ${cfg.faculty ? 'Y' : '-'} (${cfg.deptMode})`);
}

// 검증: 파싱
try {
  const obj = yaml.load(text) as { orgs?: unknown[] };
  if (!obj?.orgs?.length) throw new Error('orgs 비어있음');
} catch (e) {
  console.error('❌ 패치 후 yaml 파싱 실패 — 미저장:', (e as Error).message);
  process.exit(1);
}

console.log(report.join('\n'));
console.log(`\n패치 ${patched}/${cfgs.length} 조직. yaml 파싱 OK.`);
if (dry) { console.log('(--dry: 미저장)'); }
else { writeFileSync(yamlPath, text, 'utf-8'); console.log(`저장: ${yamlPath}`); }
