/** 컨텍스트 구성 분해 — 13만 토큰이 어디서 오는지(위키별·타입별 char 수). 무료(임베딩만) */
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch {}
import { routeQuery } from '@/lib/agents/router';
import type { Role } from '@/lib/auth/roles';

async function main() {
  const Q = '서울대학교 2026년 법인회계 세출 예산을 항목별로 나누고, 각 항목이 전체에서 차지하는 비중(%)을 표로 정리해줘.';
  const routing = await routeQuery(Q, 'tier1' as Role);
  let total = 0;
  console.log('위키별 컨텍스트 길이 / 청크(## 헤더) 수:\n');
  const rows = routing.contexts.map(c => {
    const len = [...c.relevantData].length;
    const chunks = (c.relevantData.match(/^##\s/gm) || []).length;
    const entity = (c.relevantData.match(/^##\s*\[entity\]/gm) || []).length;
    total += len;
    return { wiki: c.agentName, len, chunks, entity, sources: c.sources.length };
  }).sort((a, b) => b.len - a.len);
  for (const r of rows) {
    console.log(`  ${r.wiki.padEnd(12)} ${String(r.len).padStart(7)}자  청크 ${String(r.chunks).padStart(2)} (entity ${r.entity})  소스 ${r.sources}`);
  }
  console.log(`\n  총 ${total.toLocaleString()}자, 위키 ${rows.length}개, 청크 ${rows.reduce((s, r) => s + r.chunks, 0)}개`);
  console.log(`  → 가장 큰 위키 ${rows[0].wiki}(${rows[0].len}자)가 전체의 ${Math.round(100 * rows[0].len / total)}%`);
}
main().catch(e => { console.error(e); process.exit(1); });
