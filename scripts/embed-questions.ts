/**
 * 사용자 질문 77개를 Voyage로 임베딩 → 기존 PCA 공간에 투영
 * 실행: npx tsx scripts/embed-questions.ts
 * 출력: public/knowledge-map-questions.json
 *
 * 선행 조건: generate-knowledge-map.ts 실행 후 public/knowledge-map-proj.json 존재
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch {}

import pg from 'pg';

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
  senate:         '#3B82F6',
  board:          '#10B981',
  plan:           '#F59E0B',
  vision:         '#8B5CF6',
  history:        '#EF4444',
  status:         '#6B7280',
  'yhl-speeches': '#EC4899',
  finance:        '#14B8A6',
  leesj:          '#F97316',
};

const WIKI_LABELS: Record<string, string> = {
  senate:         '평의원회',
  board:          '이사회',
  plan:           '대학운영계획',
  vision:         '중장기발전계획',
  history:        '70년역사',
  status:         '대학현황',
  'yhl-speeches': '유홍림총장연설',
  finance:        '재무정보공시',
  leesj:          '이석재 후보',
};

// ── Voyage 임베딩 (질문용, input_type: 'query') ────────────────────────────
async function embedTexts(texts: string[]): Promise<number[][]> {
  const MAX_BATCH = 64;
  const all: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'voyage-4-large', input: batch, input_type: 'query' }),
    });
    if (!res.ok) throw new Error(`Voyage API error: ${res.status} ${await res.text()}`);
    const data = await res.json() as { data: { embedding: number[]; index: number }[] };
    const sorted = data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
    all.push(...sorted);
    console.log(`  ✅ ${Math.min(i + MAX_BATCH, texts.length)} / ${texts.length}`);
  }
  return all;
}

// ── Random Projection 재현 (seed=42, 동일 행렬) ───────────────────────────
function randomProject(vecs: number[][], dimIn: number, dimOut: number): number[][] {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff * 2 - 1;
  };
  const proj: number[][] = Array.from({ length: dimIn }, () =>
    Array.from({ length: dimOut }, () => rand() / Math.sqrt(dimOut))
  );
  return vecs.map(vec => {
    const out = new Array(dimOut).fill(0);
    for (let j = 0; j < dimIn; j++) {
      if (vec[j] === 0) continue;
      for (let k = 0; k < dimOut; k++) out[k] += vec[j] * proj[j][k];
    }
    return out;
  });
}

// ── PCA 투영 (저장된 파라미터로 새 벡터 투영) ──────────────────────────────
function applyPCA(vecs: number[][], pcaMean: number[], pc1: number[], pc2: number[]): [number, number][] {
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
  return vecs.map(v => {
    const centered = v.map((x, i) => x - pcaMean[i]);
    return [dot(centered, pc1), dot(centered, pc2)];
  });
}

// ── 답변 품질 판정 ──────────────────────────────────────────────────────────
function judgeQuality(answer: string, routedAgents: string[]): 'answered' | 'partial' | 'no_data' {
  if (!answer || answer.trim().length < 50) return 'no_data';
  const noDataPatterns = ['찾을 수 없', '자료가 없', '확인되지 않', '정보가 없', '데이터가 없', '기록이 없', '해당 내용을 찾'];
  if (noDataPatterns.some(p => answer.includes(p))) return 'no_data';
  if (routedAgents.length === 0) return 'partial';
  if (answer.length < 200) return 'partial';
  return 'answered';
}

async function main() {
  // 1. PCA 파라미터 로드
  if (!fs.existsSync('public/knowledge-map-proj.json')) {
    throw new Error('public/knowledge-map-proj.json 없음. generate-knowledge-map.ts 먼저 실행하세요.');
  }
  const proj = JSON.parse(fs.readFileSync('public/knowledge-map-proj.json', 'utf-8')) as {
    pcaMean: number[]; pc1: number[]; pc2: number[];
    wikiStats: Record<string, { cx: number; cy: number; sx: number; sy: number }>;
  };
  console.log('✅ PCA 파라미터 로딩 완료');

  // 2. DB에서 Q&A 쌍 로드
  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });
  const { rows } = await pool.query(`
    SELECT
      u.content  AS question,
      a.content  AS answer,
      a.routed_agents AS routed_agents,
      u.created_at AS created_at
    FROM messages u
    JOIN messages a ON (
      a.conversation_id = u.conversation_id
      AND a.role = 'assistant'
      AND a.id = (
        SELECT id FROM messages
        WHERE conversation_id = u.conversation_id AND role = 'assistant' AND created_at > u.created_at
        ORDER BY created_at LIMIT 1
      )
    )
    WHERE u.role = 'user'
      AND u.content NOT ILIKE '%test%'
      AND LENGTH(u.content) > 5
    ORDER BY u.created_at DESC
    LIMIT 200
  `);
  await pool.end();
  console.log(`✅ ${rows.length}개 Q&A 쌍 로딩`);

  const questions = rows.map((r: any) => r.question as string);

  // 3. Voyage 임베딩
  console.log('🚀 Voyage 임베딩 시작...');
  const embeddings = await embedTexts(questions);
  console.log('✅ 임베딩 완료');

  // 4. Random Projection → PCA 투영
  const DIM_IN = embeddings[0].length;
  const DIM_OUT = 30;
  const reduced = randomProject(embeddings, DIM_IN, DIM_OUT);
  const coords2d = applyPCA(reduced, proj.pcaMean, proj.pc1, proj.pc2);

  // 5. 각 질문의 가장 가까운 위키 찾기 → 섬 좌표 계산
  const wikiIds = Object.keys(proj.wikiStats);
  const SPREAD = 72;

  // 화면 크기 기준은 클라이언트에서 결정하므로 여기선 상대값만 저장
  const result = rows.map((r: any, i: number) => {
    const [px, py] = coords2d[i];

    // 가장 가까운 위키 (PCA 거리 기준)
    let nearestWiki = wikiIds[0];
    let minDist = Infinity;
    for (const wid of wikiIds) {
      const st = proj.wikiStats[wid];
      const d = Math.hypot(px - st.cx, py - st.cy);
      if (d < minDist) { minDist = d; nearestWiki = wid; }
    }
    const st = proj.wikiStats[nearestWiki];

    // 섬 레이아웃 상대 좌표 (W, H는 클라이언트에서 곱함)
    const dxRel = WIKI_LAYOUT[nearestWiki].fx + (px - st.cx) / st.sx * SPREAD / 1000;
    const dyRel = WIKI_LAYOUT[nearestWiki].fy + (py - st.cy) / st.sy * SPREAD / 1000;

    const routedAgents: string[] = r.routed_agents ?? [];
    const quality = judgeQuality(r.answer ?? '', routedAgents);

    return {
      question:     (r.question as string).slice(0, 120),
      quality,
      routedAgents,
      nearestWiki,
      wikiLabel:    WIKI_LABELS[nearestWiki] ?? nearestWiki,
      wikiColor:    WIKI_COLORS[nearestWiki] ?? '#999',
      pcaX: px,
      pcaY: py,
      // 섬 좌표: fx + delta (클라이언트에서 W,H 곱함)
      islandFx: WIKI_LAYOUT[nearestWiki].fx,
      islandFy: WIKI_LAYOUT[nearestWiki].fy,
      // PCA 델타 (섬 내 위치, 픽셀 단위)
      dxDelta: (px - st.cx) / st.sx * SPREAD,
      dyDelta: (py - st.cy) / st.sy * SPREAD,
    };
  });

  fs.writeFileSync('public/knowledge-map-questions.json', JSON.stringify(result, null, 0));
  console.log(`💾 public/knowledge-map-questions.json 저장 완료 (${result.length}개 질문)`);

  // 품질 통계
  const stats = { answered: 0, partial: 0, no_data: 0 };
  result.forEach(r => stats[r.quality]++);
  console.log(`\n📊 품질 분포:`);
  console.log(`   ✅ answered : ${stats.answered}개`);
  console.log(`   ⚠️  partial  : ${stats.partial}개`);
  console.log(`   ❌ no_data  : ${stats.no_data}개`);

  // 위키별 질문 분포
  console.log('\n📍 위키별 질문 분포:');
  const wikiQMap = new Map<string, number>();
  result.forEach(r => wikiQMap.set(r.nearestWiki, (wikiQMap.get(r.nearestWiki) ?? 0) + 1));
  for (const [wid, cnt] of [...wikiQMap.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`   ${WIKI_LABELS[wid] ?? wid}: ${cnt}개`);

  console.log('\n✨ 완료! _make-standalone-map.mjs 실행으로 지형도 업데이트하세요.');
}

main().catch(e => { console.error(e); process.exit(1); });
