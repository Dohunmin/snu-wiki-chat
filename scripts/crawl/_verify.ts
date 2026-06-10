// 임시 — governance 불변 + AnswerClass 3/4 직답 검증. 실행 후 삭제.
import { routeQuery } from '../../lib/agents/router';
import { getStructuredFact, getLiveBoard } from '../../lib/agents/structured';

async function main() {
  console.log('=== governance 쿼리 (answerClass/college undefined 이어야) ===');
  for (const q of ['이사회 정관 개정 논의', '재무 결산 현황']) {
    try {
      const r = await routeQuery(q, 'admin');
      console.log(`  "${q}" → [${r.selectedAgentIds.join(',')}] answerClass=${r.answerClass ?? 'undefined'} college=${r.college ?? 'undefined'}`);
    } catch (e) {
      console.log(`  "${q}" ✗ ${(e as Error).message}`);
    }
  }

  console.log('\n=== Tier3 직답 ===');
  const f = await getStructuredFact('science', '교수 몇 명');
  console.log('  science 교수수:', f ? f.answer.replace(/\n/g, ' ').slice(0, 70) : '(없음)');
  const f2 = await getStructuredFact('eng', '학장 연락처');
  console.log('  eng 연락처:', f2 ? f2.answer.replace(/\n/g, ' ').slice(0, 70) : '(없음)');
  const f3 = await getStructuredFact('humanities', '학과 몇 개');
  console.log('  humanities 학과수:', f3 ? f3.answer.replace(/\n/g, ' ').slice(0, 70) : '(없음)');

  console.log('\n=== Tier4 직답 ===');
  const b = await getLiveBoard('eng', '최근 공지');
  console.log('  eng 공지:', b ? b.answer.split('\n').filter((l) => l.startsWith('- ')).slice(0, 2).join(' | ').slice(0, 90) : '(없음)');
}
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
