/** 번호 컨텍스트 디버그 — mapping의 N과 본문 "## [N]" 블록이 일치하는지 확인 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch {}
import { routeQuery } from '@/lib/agents/router';
import { buildNumberedContexts } from '@/lib/llm/citations';
import { extractSourceBlocks } from '@/lib/llm/citation-audit';
import type { Role } from '@/lib/auth/roles';

async function main() {
  const q = '서울대 전체 예산은 얼마이고';
  const gold = JSON.parse(fs.readFileSync('scripts/gold-questions.json', 'utf-8'));
  const found = gold.find((g: { question: string }) => g.question.includes(q)) ?? { question: q, role: 'tier1' };
  const routing = await routeQuery(found.question, (found.role || 'tier1') as Role);
  const numbered = buildNumberedContexts(routing.contexts);
  const mapKeys = [...numbered.mapping.keys()].sort((a, b) => a - b);
  const blocks = extractSourceBlocks(numbered.contextMarkdown);
  const blockKeys = [...blocks.keys()].sort((a, b) => a - b);

  console.log('mapping N 개수:', mapKeys.length, '범위:', mapKeys[0], '~', mapKeys[mapKeys.length - 1]);
  console.log('본문 "## [N]" 블록 개수:', blockKeys.length, '범위:', blockKeys[0], '~', blockKeys[blockKeys.length - 1]);
  const inMapNotBody = mapKeys.filter(n => !blocks.has(n));
  console.log('\nmapping엔 있으나 본문 블록 없는 N:', inMapNotBody.length, '개');
  console.log('  예시:', inMapNotBody.slice(0, 15).map(n => `${n}(${numbered.mapping.get(n)?.wiki} ${numbered.mapping.get(n)?.page})`).join(', '));
  // contextMarkdown에서 실제 "## [" 패턴 몇 개인지
  const headerCount = (numbered.contextMarkdown.match(/^##\s+\[\d+\]/gm) || []).length;
  console.log('\ncontextMarkdown 내 "## [N]" 헤더 라인 수:', headerCount);
  // 숫자 없는 "## [type]" 잔존 여부(주입 실패 흔적)
  const unNumbered = (numbered.contextMarkdown.match(/^##\s+\[(?:source|fact|stance|overview|entity)\]/gm) || []).length;
  console.log('숫자 미주입 "## [type]" 잔존:', unNumbered);
}
main().catch(e => { console.error(e); process.exit(1); });
