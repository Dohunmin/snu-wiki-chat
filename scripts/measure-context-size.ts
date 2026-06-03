/**
 * 컨텍스트 크기 실측 — routeQuery가 실제로 만드는 컨텍스트가 얼마나 큰지.
 * "청크 top-k로 슬림화 됐나 vs 188k 부풀음" 검증용 (일회성).
 *
 * Usage: npx tsx --env-file=.env.local scripts/measure-context-size.ts
 */
import process from 'process';
try { if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env.local'); } catch {}

import { routeQuery } from '@/lib/agents/router';
import { detectRecencyIntent } from '@/lib/agents/recency';

const QUERIES: { tag: string; q: string }[] = [
  { tag: 'BROAD',    q: '서울대가 재정과 학생 지원 측면에서 어떤 방향으로 가고 있어?' },
  { tag: 'SYNTH',    q: '서울대학교 거버넌스 구조와 의사결정 체계 전반을 종합적으로 설명해줘' },
  { tag: 'RECENCY',  q: '최근 평의원회에서 논의된 주요 안건이 뭐야?' },
  { tag: 'FACT',     q: '2024년 정부출연금 규모가 얼마야?' },
  { tag: 'ENTITY',   q: '유홍림 총장의 주요 발언과 강조점은?' },
  { tag: 'OOD',      q: '서울대 셔틀버스 노선 알려줘' },
];

// 한국어+마크다운 혼합 대략치: 1 token ≈ 2 chars
const estTok = (chars: number) => Math.round(chars / 2);
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));

async function main() {
  for (const { tag, q } of QUERIES) {
    const t0 = Date.now();
    const r = await routeQuery(q, 'admin');
    const ms = Date.now() - t0;

    const perWiki = r.contexts
      .map(c => ({ name: c.agentName, chars: c.relevantData.length }))
      .sort((a, b) => b.chars - a.chars);
    const total = perWiki.reduce((s, w) => s + w.chars, 0);

    console.log('\n' + '='.repeat(72));
    console.log(`[${tag}] "${q}"`);
    console.log(`  global=${r.isGlobal}  recency=${detectRecencyIntent(q)}  wikis=${perWiki.length}  ${ms}ms`);
    console.log(`  TOTAL: ${total.toLocaleString()}자  ≈ ${estTok(total).toLocaleString()} 토큰`);
    for (const w of perWiki) {
      console.log(`    ${pad(w.name, 16)} ${pad(w.chars.toLocaleString() + '자', 10)} ≈ ${estTok(w.chars).toLocaleString()} tok`);
    }
  }
  console.log('\n' + '='.repeat(72));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
