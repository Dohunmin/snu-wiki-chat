/** 표 자동교정 검증 — 저장된 '틀린 답변'을 교정 호출에 넣어 산수가 고쳐지는지 확인(교정 호출만, 싸게) */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch {}
import { validateTables, buildTableFixPrompt } from '@/lib/llm/table-audit';
import { getAnthropicClient, LLM_MODEL, MAX_TOKENS } from '@/lib/llm/client';

function badAnswers(): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  try { const e = JSON.parse(fs.readFileSync('scripts/eval-leverboth-out.json', 'utf-8')); out.push({ label: '예산비중(적립금 비중초과)', text: e[0].answer }); } catch {}
  try { const v = JSON.parse(fs.readFileSync('scripts/verify-results.json', 'utf-8')); const f = v.find((x: { question: string }) => x.question.includes('부동산 자산')); if (f) out.push({ label: '부동산(표 행 누락)', text: f.newAnswer }); } catch {}
  return out;
}

async function main() {
  for (const a of badAnswers()) {
    const before = validateTables(a.text);
    console.log('\n' + '═'.repeat(70));
    console.log(`${a.label} — 교정 전 이슈 ${before.length}`);
    before.forEach(i => console.log('  ⚠️ ' + i.detail));
    if (before.length === 0) continue;
    const resp = await getAnthropicClient().messages.create({
      model: LLM_MODEL, max_tokens: MAX_TOKENS, system: '당신은 서울대 거버넌스 위키 어시스턴트입니다. 수치 표 산수를 정확히 다룹니다.',
      messages: [{ role: 'user', content: '아래 답변의 표를 검토해줘.' }, { role: 'assistant', content: a.text }, { role: 'user', content: buildTableFixPrompt(before) }],
    });
    const fixed = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
    const after = validateTables(fixed);
    console.log(`교정 후 이슈 ${after.length} ${after.length < before.length ? '✅ 개선' : '❌ 미개선'}`);
    after.forEach(i => console.log('  남음 ⚠️ ' + i.detail));
    // 교정된 표 일부 보여주기
    const tline = fixed.split('\n').filter(l => /^\|/.test(l) && /적립금|합계|100%|동\b|필지/.test(l)).slice(0, 6);
    if (tline.length) { console.log('  교정 표 일부:'); tline.forEach(l => console.log('    ' + l.trim().slice(0, 80))); }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
