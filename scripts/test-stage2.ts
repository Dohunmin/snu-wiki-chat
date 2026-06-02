/** 2단계(소스 전체 재검증) 결정적 검증 — 알려진 케이스로 직접 호출 */
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}
import { loadFullSource, verifyAgainstFullSource } from '@/lib/llm/citation-audit';

const CASES: { label: string; wiki: string; sid: string; claim: string; expect: 'keep' | 'clear' }[] = [
  { label: '겸임교원→18기-19차 (소스 전체에 없음=진짜 오인용)', wiki: '평의원회', sid: '18기-19차', claim: '겸임교원 재임용 제한 단서 조항 삭제, 객원교원 임무 추가', expect: 'keep' },
  { label: '풍동센터→이사회 2025-7차 (소스 전체엔 있음=청크한계 FP)', wiki: '이사회', sid: '2025-7차', claim: '우주항공 통합 풍동센터 구축 보고 접수', expect: 'clear' },
];

async function main() {
  for (const c of CASES) {
    const full = loadFullSource(c.wiki, c.sid);
    console.log('\n' + '═'.repeat(72));
    console.log(c.label);
    if (!full) { console.log('  ❌ 소스 로드 실패'); continue; }
    console.log(`  소스 길이: ${full.length}자, claim에 "풍동" 포함: ${full.includes('풍동')}, "객원교원": ${full.includes('객원교원')}, "재임용": ${full.includes('재임용')}`);
    const v = await verifyAgainstFullSource(c.claim, c.wiki, c.sid, full);
    const action = v.supported ? 'clear(제거)' : 'keep(유지)';
    const ok = (c.expect === 'keep' && !v.supported) || (c.expect === 'clear' && v.supported);
    console.log(`  → supported=${v.supported} → ${action}  | 기대=${c.expect}  ${ok ? '✅' : '❌ 불일치'}${v.failed ? ' (FAIL)' : ''}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
