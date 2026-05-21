/**
 * 사용자 질문을 Voyage 임베딩 + Claude 품질 평가 + routedAgents 기반 배치
 * 실행: npx tsx scripts/embed-questions.ts
 * 출력: public/knowledge-map-questions.json
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch {}

import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';

const WIKI_LAYOUT: Record<string, { fx: number; fy: number }> = {
  senate:         { fx: 0.20, fy: 0.32 },
  board:          { fx: 0.78, fy: 0.32 },
  plan:           { fx: 0.48, fy: 0.14 },
  vision:         { fx: 0.30, fy: 0.54 },
  history:        { fx: 0.16, fy: 0.68 },
  status:         { fx: 0.50, fy: 0.52 },
  'yhl-speeches': { fx: 0.68, fy: 0.54 },
  finance:        { fx: 0.84, fy: 0.68 },
  leesj:          { fx: 0.50, fy: 0.80 },
};
const WIKI_COLORS: Record<string, string> = {
  senate:'#3B82F6', board:'#10B981', plan:'#F59E0B', vision:'#8B5CF6',
  history:'#EF4444', status:'#6B7280', 'yhl-speeches':'#EC4899',
  finance:'#14B8A6', leesj:'#F97316',
};
const WIKI_LABELS: Record<string, string> = {
  senate:'평의원회', board:'이사회', plan:'대학운영계획', vision:'중장기발전계획',
  history:'70년역사', status:'대학현황', 'yhl-speeches':'유홍림총장연설',
  finance:'재무정보공시', leesj:'이석재 후보',
};

// ── Voyage 임베딩 ──────────────────────────────────────────────────────────
async function embedTexts(texts: string[]): Promise<number[][]> {
  const MAX_BATCH = 64;
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'voyage-4-large', input: batch, input_type: 'query' }),
    });
    if (!res.ok) throw new Error(`Voyage error: ${res.status} ${await res.text()}`);
    const data = await res.json() as { data: { embedding: number[]; index: number }[] };
    all.push(...data.data.sort((a, b) => a.index - b.index).map(d => d.embedding));
    console.log(`  임베딩 ${Math.min(i + MAX_BATCH, texts.length)} / ${texts.length}`);
  }
  return all;
}

// ── Random Projection 재현 ─────────────────────────────────────────────────
function randomProject(vecs: number[][], dimIn: number, dimOut: number): number[][] {
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff * 2 - 1; };
  const proj = Array.from({ length: dimIn }, () => Array.from({ length: dimOut }, () => rand() / Math.sqrt(dimOut)));
  return vecs.map(vec => {
    const out = new Array(dimOut).fill(0);
    for (let j = 0; j < dimIn; j++) { if (vec[j] === 0) continue; for (let k = 0; k < dimOut; k++) out[k] += vec[j] * proj[j][k]; }
    return out;
  });
}

// ── PCA 투영 ──────────────────────────────────────────────────────────────
function applyPCA(vecs: number[][], pcaMean: number[], pc1: number[], pc2: number[]): [number, number][] {
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  return vecs.map(v => { const c = v.map((x, i) => x - pcaMean[i]); return [dot(c, pc1), dot(c, pc2)]; });
}

// ── Claude Haiku LLM-as-judge ──────────────────────────────────────────────
let anthropic: Anthropic;

async function judgeOne(question: string, answer: string): Promise<'answered' | 'partial' | 'no_data'> {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 5,
    messages: [{
      role: 'user',
      content: `서울대 거버넌스 위키 챗봇의 Q&A를 평가하세요.

질문: ${question}

답변(앞부분): ${answer.slice(0, 600)}

평가 기준:
- answered: 질문의 핵심에 위키 자료 기반으로 구체적으로 답변함
- partial: 관련 내용은 있으나 불완전하거나 일부만 답변함
- no_data: 자료 없음/범위 밖/답변 불가 등으로 실질적 답변 없음

한 단어만 출력 (answered / partial / no_data):`,
    }],
  });
  const text = (msg.content[0] as { text: string }).text.trim().toLowerCase();
  if (text.startsWith('answered')) return 'answered';
  if (text.startsWith('partial'))  return 'partial';
  return 'no_data';
}

async function judgeAll(pairs: { question: string; answer: string }[]): Promise<('answered' | 'partial' | 'no_data')[]> {
  const results: ('answered' | 'partial' | 'no_data')[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < pairs.length; i += CONCURRENCY) {
    const batch = pairs.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(p => judgeOne(p.question, p.answer)));
    results.push(...batchResults);
    process.stdout.write(`\r  Claude 평가 ${Math.min(i + CONCURRENCY, pairs.length)} / ${pairs.length}`);
  }
  console.log();
  return results;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY가 .env.local에 없습니다. 추가해주세요.');
  anthropic = new Anthropic({ apiKey });

  if (!fs.existsSync('public/knowledge-map-proj.json'))
    throw new Error('public/knowledge-map-proj.json 없음. generate-knowledge-map.ts 먼저 실행하세요.');

  const proj = JSON.parse(fs.readFileSync('public/knowledge-map-proj.json', 'utf-8')) as {
    pcaMean: number[]; pc1: number[]; pc2: number[];
    wikiStats: Record<string, { cx: number; cy: number; sx: number; sy: number }>;
  };
  console.log('✅ PCA 파라미터 로딩');

  // ── DB 쿼리 ──
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
  const { rows } = await pool.query(`
    SELECT u.content AS question, a.content AS answer,
           a.routed_agents AS routed_agents, u.created_at
    FROM messages u
    JOIN messages a ON (
      a.conversation_id = u.conversation_id AND a.role = 'assistant'
      AND a.id = (
        SELECT id FROM messages
        WHERE conversation_id = u.conversation_id AND role = 'assistant' AND created_at > u.created_at
        ORDER BY created_at LIMIT 1
      )
    )
    WHERE u.role = 'user' AND LENGTH(u.content) > 5
    ORDER BY u.created_at DESC LIMIT 200
  `);
  await pool.end();
  console.log(`✅ ${rows.length}개 Q&A 로딩`);

  // ── Voyage 임베딩 ──
  console.log('🚀 Voyage 임베딩...');
  const questions = rows.map((r: any) => r.question as string);
  const embeddings = await embedTexts(questions);

  // ── PCA 투영 ──
  const reduced  = randomProject(embeddings, embeddings[0].length, 30);
  const coords2d = applyPCA(reduced, proj.pcaMean, proj.pc1, proj.pc2);

  // ── Claude 품질 평가 ──
  console.log('🤖 Claude Haiku 품질 평가...');
  const qualities = await judgeAll(rows.map((r: any) => ({ question: r.question, answer: r.answer ?? '' })));

  // ── 결과 구성 ──
  const MAX_DELTA = 110;
  const SPREAD    = 72;
  const seenQ     = new Map<string, number>();
  const wikiIds   = Object.keys(proj.wikiStats);

  const result = rows.map((r: any, i: number) => {
    const [px, py] = coords2d[i];
    const routedAgents: string[] = r.routed_agents ?? [];

    // 배치 위키: PCA 공간에서 가장 가까운 위키 (의미적 유사도 기반)
    let placementWiki = wikiIds[0];
    let minDist = Infinity;
    for (const w of wikiIds) {
      const d = Math.hypot(px - proj.wikiStats[w].cx, py - proj.wikiStats[w].cy);
      if (d < minDist) { minDist = d; placementWiki = w; }
    }

    const st = proj.wikiStats[placementWiki];
    const clamp = (v: number) => Math.max(-MAX_DELTA, Math.min(MAX_DELTA, v));
    const dxDelta = clamp((px - st.cx) / st.sx * SPREAD);
    const dyDelta = clamp((py - st.cy) / st.sy * SPREAD);

    // 중복 질문 jitter
    const cnt = seenQ.get(r.question) ?? 0;
    seenQ.set(r.question, cnt + 1);

    return {
      question:    (r.question as string).slice(0, 120),
      quality:     qualities[i],
      routedAgents,
      nearestWiki: placementWiki,
      wikiLabel:   WIKI_LABELS[placementWiki] ?? placementWiki,
      wikiColor:   WIKI_COLORS[placementWiki] ?? '#999',
      islandFx:    WIKI_LAYOUT[placementWiki].fx,
      islandFy:    WIKI_LAYOUT[placementWiki].fy,
      dxDelta,
      dyDelta,
      jitterAngle: cnt * 2.0,
      jitterR:     cnt * 14,
    };
  });

  fs.writeFileSync('public/knowledge-map-questions.json', JSON.stringify(result, null, 0));
  console.log(`💾 저장 완료 (${result.length}개)`);

  const stats = { answered: 0, partial: 0, no_data: 0 };
  result.forEach(r => stats[r.quality]++);
  console.log(`\n📊 품질 분포 (Claude 평가):`);
  console.log(`   ✅ answered : ${stats.answered}개`);
  console.log(`   ⚠️  partial  : ${stats.partial}개`);
  console.log(`   ❌ no_data  : ${stats.no_data}개`);

  console.log('\n📍 위키별 질문 분포 (routedAgents 기반):');
  const wikiQMap = new Map<string, number>();
  result.forEach(r => wikiQMap.set(r.nearestWiki, (wikiQMap.get(r.nearestWiki) ?? 0) + 1));
  for (const [w, n] of [...wikiQMap.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`   ${WIKI_LABELS[w] ?? w}: ${n}개`);
}

main().catch(e => { console.error(e); process.exit(1); });
