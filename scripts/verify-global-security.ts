/** P3a-1 보안 검증 — searchVectorGlobal의 allowlist가 lensPersona(leesj) 누출을 막는지. LLM 0. */
import { loadEnvFile } from 'process';
try { loadEnvFile('.env.local'); } catch { /* 무시 */ }
import { searchVectorGlobal } from '@/lib/embed/search';
import { registry } from '@/lib/agents/registry';
import type { Role } from '@/lib/auth/roles';

async function main() {
  const role = 'admin' as Role;
  // getRoutableAgents와 동일 규칙: lensPersona 제외 (admin이라 adminOnly는 포함)
  const allowedWikiIds = registry.getAll().filter(a => !a.config.lensPersona).map(a => a.config.id);
  console.log('allowlist:', allowedWikiIds.join(', '));
  console.log('leesj가 allowlist에 있나?', allowedWikiIds.includes('leesj'), '(false여야 함)');

  // 아까 raw 전역검색서 leesj가 샜던 질문
  const q = '시흥캠퍼스 관련 안건은 병원·체육관·재외동포센터·송전선로·풍동센터 등 물리적 인프라 구축이 핵심인데, 이런 물리적 인프라 구축 계획은 어떤 원칙, 계획 등에 기반하는지 알려줘';
  const res = await searchVectorGlobal(q, role, 24, { allowedWikiIds });
  const counts = res.reduce((m, r) => { m[r.wikiId] = (m[r.wikiId] ?? 0) + 1; return m; }, {} as Record<string, number>);
  console.log('\ntop-24 위키 분포:', counts);
  const leesjN = res.filter(r => r.wikiId === 'leesj').length;
  console.log(`\nleesj 청크: ${leesjN}개  →  ${leesjN === 0 ? '✅ 누출 차단됨 (allowlist 작동)' : '🔴 여전히 누출!'}`);
  process.exit(leesjN === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(2); });
