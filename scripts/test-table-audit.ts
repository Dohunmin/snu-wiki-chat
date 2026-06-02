/** 표 검산 일반화 테스트 — 저장된 실제 답변들에 validateTables 적용(무료, LLM 0) */
import fs from 'fs';
import { validateTables } from '@/lib/llm/table-audit';

function collect(): { src: string; q: string; text: string }[] {
  const out: { src: string; q: string; text: string }[] = [];
  try { for (const r of JSON.parse(fs.readFileSync('scripts/eval-leverboth-out.json', 'utf-8'))) out.push({ src: 'eval', q: r.q, text: r.answer }); } catch {}
  try { for (const r of JSON.parse(fs.readFileSync('scripts/verify-results.json', 'utf-8'))) if (r.newAnswer) out.push({ src: 'verify', q: (r.question || '').slice(0, 30), text: r.newAnswer }); } catch {}
  return out;
}

function main() {
  const answers = collect();
  let withTable = 0, flagged = 0, totalIssues = 0;
  console.log(`대상 답변 ${answers.length}개\n`);
  for (const a of answers) {
    const hasTable = /\n\s*\|.*\|.*\n\s*\|[\s:|-]+\|/.test(a.text);
    if (hasTable) withTable++;
    const issues = validateTables(a.text);
    if (issues.length) {
      flagged++; totalIssues += issues.length;
      console.log(`■ [${a.src}] ${a.q}`);
      for (const i of issues) console.log(`    ⚠️ ${i.kind}: ${i.detail}`);
    }
  }
  console.log(`\n표 포함 답변: ${withTable}/${answers.length} | 검산 플래그된 답변: ${flagged} | 총 이슈 ${totalIssues}`);
  console.log('→ 플래그 각각이 진짜 오류인지 위에서 확인(적립금=진짜, 나머지 오탐 여부 판단).');
}
main();
