/**
 * 갭 사례 직접 검증 스크립트.
 *
 * 같은 쿼리("대학원생 장학금이 최근 10년 사이에 증가했어?")를
 * RAG OFF 와 RAG ON 두 가지 모드로 finance WikiAgent에 던지고
 * 결과 청크에 *핵심 데이터*가 포함되는지 자동 검증.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/test-rag-gap.ts
 */

import process from 'process';

try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile('.env.local');
  }
} catch { /* ignore */ }

import { WikiAgent } from '@/lib/agents/wiki-agent';
import type { AgentConfig } from '@/lib/agents/types';
import agentsConfig from '@/data/agents.config.json';

const GAP_QUERY = '대학원생 장학금이 최근 10년 사이에 증가했어?';

// 갭 사례 답변에 기대되는 핵심 키워드 (재무 관련 청크가 회수됐는지 검증)
const EXPECTED_KEYWORDS = [
  '학생경비',          // finance/비용구조.fact 의 핵심 항목
  '학문후속세대',      // plan/2026-섹션3 (RAG로 회수되어야 함, 단 finance 위키에는 없음)
  '1,203',             // 학생경비 2017년 시작값
  '1,605',             // 학생경비 2024년 값
];

async function runOnce(ragEnabled: boolean): Promise<{ contextLength: number; chunkCount: number; foundKeywords: string[]; relevantData: string }> {
  // finance 설정 가져오기
  const baseConfig = (agentsConfig.agents as AgentConfig[]).find(a => a.id === 'finance');
  if (!baseConfig) throw new Error('finance agent not found');

  // ragEnabled 오버라이드
  const config: AgentConfig = { ...baseConfig, ragEnabled };
  const agent = new WikiAgent(config);

  const ctx = await agent.getContext(GAP_QUERY, 'admin', false);
  const data = ctx.relevantData;

  const foundKeywords = EXPECTED_KEYWORDS.filter(kw => data.includes(kw));

  return {
    contextLength: data.length,
    chunkCount: ctx.sources.length,
    foundKeywords,
    relevantData: data,
  };
}

async function main() {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`🧪 갭 사례 검증: "${GAP_QUERY}"`);
  console.log(`   대상 위키: finance`);
  console.log('='.repeat(70));

  // RAG OFF (키워드만)
  console.log('\n📋 [RAG OFF] 키워드 매칭만');
  const off = await runOnce(false);
  console.log(`  컨텍스트 길이: ${off.contextLength} chars`);
  console.log(`  청크 수: ${off.chunkCount}`);
  console.log(`  발견된 핵심 키워드: ${off.foundKeywords.length}/${EXPECTED_KEYWORDS.length}`);
  console.log(`    ${off.foundKeywords.map(k => `✓ ${k}`).join('  ')}`);
  const offMissing = EXPECTED_KEYWORDS.filter(k => !off.foundKeywords.includes(k));
  if (offMissing.length > 0) {
    console.log(`    누락: ${offMissing.map(k => `✗ ${k}`).join('  ')}`);
  }

  // RAG ON (키워드 + 벡터 + RRF)
  console.log('\n📋 [RAG ON] 하이브리드 (키워드 + 벡터 + RRF)');
  process.env.RAG_DEBUG = 'true';
  const on = await runOnce(true);
  console.log(`  컨텍스트 길이: ${on.contextLength} chars`);
  console.log(`  청크 수: ${on.chunkCount}`);
  console.log(`  발견된 핵심 키워드: ${on.foundKeywords.length}/${EXPECTED_KEYWORDS.length}`);
  console.log(`    ${on.foundKeywords.map(k => `✓ ${k}`).join('  ')}`);
  const onMissing = EXPECTED_KEYWORDS.filter(k => !on.foundKeywords.includes(k));
  if (onMissing.length > 0) {
    console.log(`    누락: ${onMissing.map(k => `✗ ${k}`).join('  ')}`);
  }

  // 비교
  console.log(`\n${'─'.repeat(70)}`);
  console.log('📊 결과');
  console.log('─'.repeat(70));
  console.log(`  컨텍스트 길이: ${off.contextLength} → ${on.contextLength} (Δ ${on.contextLength - off.contextLength >= 0 ? '+' : ''}${on.contextLength - off.contextLength})`);
  console.log(`  청크 수: ${off.chunkCount} → ${on.chunkCount}`);
  console.log(`  핵심 키워드 회수: ${off.foundKeywords.length} → ${on.foundKeywords.length} ${on.foundKeywords.length > off.foundKeywords.length ? '✅ 개선' : on.foundKeywords.length === off.foundKeywords.length ? '🟡 동등' : '🔴 회귀'}`);

  if (on.foundKeywords.length > off.foundKeywords.length) {
    console.log(`\n🎉 RAG 도입으로 새로 회수된 키워드:`);
    for (const k of on.foundKeywords) {
      if (!off.foundKeywords.includes(k)) console.log(`  + ${k}`);
    }
  }

  // 디버그 — 학생경비 관련 청크 미리보기
  console.log(`\n${'─'.repeat(70)}`);
  console.log('🔍 RAG ON 컨텍스트 미리보기 (학생경비 등장 부분 검색)');
  console.log('─'.repeat(70));
  const idx = on.relevantData.indexOf('학생경비');
  if (idx >= 0) {
    const start = Math.max(0, idx - 100);
    const end = Math.min(on.relevantData.length, idx + 400);
    console.log(on.relevantData.slice(start, end));
  } else {
    console.log('(학생경비 키워드 미발견)');
  }

  console.log(`\n${'='.repeat(70)}\n`);

  // Exit code 기반 신호
  if (on.foundKeywords.length > off.foundKeywords.length) {
    console.log('✅ PASS — RAG 도입으로 키워드 회수 개선');
    process.exit(0);
  } else if (on.foundKeywords.length === off.foundKeywords.length && on.foundKeywords.length >= 2) {
    console.log('🟡 SAME — 키워드 동등 회수 (RAG 효과 없음 또는 키워드도 잘 잡힘)');
    process.exit(0);
  } else {
    console.log('🔴 FAIL — 키워드 회수가 줄어듦 (회귀 의심)');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\n❌ Test failed:');
  console.error(err);
  process.exit(2);
});
