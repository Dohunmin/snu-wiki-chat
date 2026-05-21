/**
 * 임베딩 클러스터 맵 생성 스크립트 (PCA 버전 — 외부 라이브러리 불필요)
 * 실행: npx tsx scripts/generate-knowledge-map.ts
 * 출력: public/knowledge-map-data.json + public/knowledge-map.html
 */
import { loadEnvFile } from 'process';
import fs from 'fs';
try { loadEnvFile('.env.local'); } catch {}

import pg from 'pg';

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

const PAGE_TYPE_LABELS: Record<string, string> = {
  source:   '회의록/소스',
  topic:    '토픽',
  entity:   '엔티티',
  fact:     '팩트',
  stance:   '입장',
  overview: '개요',
};

// ── 순수 JS PCA (power iteration, 외부 의존 없음) ──────────────────────────
function pca2d(data: number[][]): [number, number][] {
  const N = data.length;
  const D = data[0].length;

  // 평균 중심화
  const mean = new Array(D).fill(0);
  for (const row of data) for (let j = 0; j < D; j++) mean[j] += row[j];
  for (let j = 0; j < D; j++) mean[j] /= N;
  const X = data.map(row => row.map((v, j) => v - mean[j]));

  // (X^T X) v 행렬-벡터 곱
  function xtxv(v: number[]): number[] {
    const Xv = X.map(row => row.reduce((s, x, j) => s + x * v[j], 0));
    const out = new Array(D).fill(0);
    for (let i = 0; i < N; i++) for (let j = 0; j < D; j++) out[j] += X[i][j] * Xv[i];
    return out;
  }

  function norm(v: number[]): number { return Math.sqrt(v.reduce((s, x) => s + x * x, 0)); }
  function normalize(v: number[]): number[] { const n = norm(v); return v.map(x => x / n); }
  function dot(a: number[], b: number[]): number { return a.reduce((s, x, i) => s + x * b[i], 0); }

  // PC1
  let v1 = normalize(Array.from({ length: D }, (_, i) => Math.sin(i * 1.7 + 0.5)));
  for (let iter = 0; iter < 150; iter++) v1 = normalize(xtxv(v1));

  // PC2 (PC1에 직교)
  let v2 = normalize(Array.from({ length: D }, (_, i) => Math.cos(i * 1.3 + 0.3)));
  const p0 = dot(v2, v1); v2 = normalize(v2.map((x, i) => x - p0 * v1[i]));
  for (let iter = 0; iter < 150; iter++) {
    v2 = xtxv(v2);
    const d = dot(v2, v1); v2 = v2.map((x, i) => x - d * v1[i]);
    v2 = normalize(v2);
  }

  return X.map(row => [dot(row, v1), dot(row, v2)]);
}

async function main() {
  console.log('🔍 DB에서 임베딩 로딩 중...');

  const pool = new pg.Pool({ connectionString: process.env.POSTGRES_URL });

  const { rows } = await pool.query(`
    SELECT
      id, wiki_id, page_type, page_id, chunk_text, metadata,
      embedding::text AS embedding_text
    FROM chunk_embeddings
    ORDER BY wiki_id, page_type
  `);
  console.log(`✅ ${rows.length}개 청크 로딩 완료`);

  const embeddings: number[][] = rows.map((r: any) => {
    const txt: string = r.embedding_text;
    return txt.slice(1, -1).split(',').map(Number);
  });

  // Step 1: Random Projection 1024 → 30차원
  console.log('⚡ Random Projection 1024 → 30차원...');
  const DIM_IN = embeddings[0].length;
  const DIM_OUT = 30;
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff * 2 - 1;
  };
  const proj: number[][] = Array.from({ length: DIM_IN }, () =>
    Array.from({ length: DIM_OUT }, () => rand() / Math.sqrt(DIM_OUT))
  );
  const reduced: number[][] = embeddings.map(vec => {
    const out = new Array(DIM_OUT).fill(0);
    for (let j = 0; j < DIM_IN; j++) {
      if (vec[j] === 0) continue;
      for (let k = 0; k < DIM_OUT; k++) out[k] += vec[j] * proj[j][k];
    }
    return out;
  });
  console.log('✅ Random Projection 완료');

  // Step 2: PCA 30 → 2차원
  console.log('🧮 PCA 30 → 2차원 (power iteration)...');
  const t0 = Date.now();
  const coords2d = pca2d(reduced);
  console.log(`✅ PCA 완료 (${Date.now() - t0}ms)`);

  // 결과 데이터 구성
  const points = rows.map((r: any, i: number) => {
    const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata ?? {};
    const preview = (r.chunk_text as string).slice(0, 150).replace(/\n/g, ' ');
    return {
      x: coords2d[i][0],
      y: coords2d[i][1],
      wikiId:       r.wiki_id,
      wikiLabel:    WIKI_LABELS[r.wiki_id] ?? r.wiki_id,
      color:        WIKI_COLORS[r.wiki_id] ?? '#999',
      pageType:     r.page_type,
      pageTypeLabel: PAGE_TYPE_LABELS[r.page_type] ?? r.page_type,
      pageId:       r.page_id,
      title:        (meta.title as string) ?? r.page_id,
      preview,
    };
  });

  fs.writeFileSync('public/knowledge-map.html', generateHTML(points));
  console.log('🗺️  public/knowledge-map.html 생성 완료 (self-contained, 서버 불필요)');

  await pool.end();
  console.log('\n✨ 완료! 브라우저에서 public/knowledge-map.html 열어보세요.');
}

function generateHTML(points: object[]): string {
  const inlineData = JSON.stringify(points);
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>SNU 거버넌스 위키 — 지식 지형도</title>
<script src="https://d3js.org/d3.v7.min.js"><\/script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f1117; color: #e2e8f0; font-family: -apple-system, sans-serif; height: 100vh; overflow: hidden; }
  #header { position: fixed; top: 0; left: 0; right: 0; z-index: 10; background: rgba(15,17,23,0.9); backdrop-filter: blur(8px); padding: 12px 20px; border-bottom: 1px solid #1e293b; display: flex; align-items: center; gap: 16px; }
  #header h1 { font-size: 15px; font-weight: 600; color: #f1f5f9; }
  #header p { font-size: 12px; color: #64748b; }
  #legend { position: fixed; top: 60px; right: 16px; z-index: 10; background: rgba(15,17,23,0.85); border: 1px solid #1e293b; border-radius: 8px; padding: 12px; min-width: 160px; }
  #legend h3 { font-size: 11px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
  .legend-item { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; font-size: 12px; color: #cbd5e1; cursor: pointer; }
  .legend-item:hover { color: #fff; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  #tooltip { position: fixed; z-index: 20; background: rgba(15,17,23,0.95); border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; max-width: 300px; pointer-events: none; display: none; }
  #tooltip .t-wiki { font-size: 11px; color: #94a3b8; margin-bottom: 2px; }
  #tooltip .t-title { font-size: 13px; font-weight: 600; color: #f1f5f9; margin-bottom: 4px; }
  #tooltip .t-type { font-size: 11px; color: #64748b; margin-bottom: 6px; }
  #tooltip .t-preview { font-size: 11px; color: #94a3b8; line-height: 1.5; }
  #stats { position: fixed; bottom: 16px; left: 16px; z-index: 10; font-size: 11px; color: #475569; }
  #canvas { width: 100vw; height: 100vh; }
  circle { cursor: pointer; }
  circle:hover { stroke: #fff; stroke-width: 1.5px; }
</style>
</head>
<body>
<div id="header">
  <div>
    <h1>SNU 거버넌스 위키 — 지식 지형도</h1>
    <p>PCA 2D 프로젝션 · 1,054개 청크 · 9개 위키</p>
  </div>
</div>
<div id="legend">
  <h3>위키</h3>
  <div id="legend-items"></div>
  <div style="margin-top:10px; border-top:1px solid #1e293b; padding-top:8px;">
    <h3 style="margin-bottom:6px;">페이지 타입</h3>
    <div style="font-size:11px; color:#64748b; line-height:1.8;">
      ● 크기 큼 = 소스/개요<br>
      ● 크기 중 = 토픽/엔티티<br>
      ● 크기 소 = 팩트/입장
    </div>
  </div>
</div>
<div id="tooltip">
  <div class="t-wiki" id="t-wiki"></div>
  <div class="t-title" id="t-title"></div>
  <div class="t-type" id="t-type"></div>
  <div class="t-preview" id="t-preview"></div>
</div>
<div id="stats"></div>
<svg id="canvas"></svg>

<script>
const TYPE_RADIUS = { source: 6, overview: 6, topic: 4.5, entity: 4, fact: 3, stance: 3 };
const _DATA = ${inlineData};
(function(data) {
    const svg = d3.select('#canvas');
    const W = window.innerWidth, H = window.innerHeight;
    svg.attr('width', W).attr('height', H);

    const g = svg.append('g');
    svg.call(d3.zoom().scaleExtent([0.3, 20]).on('zoom', e => g.attr('transform', e.transform)));

    const pad = 80;
    const xExt = d3.extent(data, d => d.x);
    const yExt = d3.extent(data, d => d.y);
    const xScale = d3.scaleLinear().domain(xExt).range([pad, W - pad]);
    const yScale = d3.scaleLinear().domain(yExt).range([pad + 40, H - pad]);

    const tooltip = document.getElementById('tooltip');
    g.selectAll('circle')
      .data(data)
      .join('circle')
      .attr('cx', d => xScale(d.x))
      .attr('cy', d => yScale(d.y))
      .attr('r', d => TYPE_RADIUS[d.pageType] || 3.5)
      .attr('fill', d => d.color)
      .attr('fill-opacity', 0.7)
      .attr('stroke', 'none')
      .on('mouseover', function(event, d) {
        d3.select(this).attr('r', (TYPE_RADIUS[d.pageType] || 3.5) * 2).attr('fill-opacity', 1);
        document.getElementById('t-wiki').textContent = d.wikiLabel;
        document.getElementById('t-title').textContent = d.title || d.pageId;
        document.getElementById('t-type').textContent = d.pageTypeLabel + ' · ' + d.pageId;
        document.getElementById('t-preview').textContent = d.preview;
        tooltip.style.display = 'block';
      })
      .on('mousemove', event => {
        const x = event.clientX + 16, y = event.clientY + 16;
        tooltip.style.left = (x + 300 > window.innerWidth ? x - 316 : x) + 'px';
        tooltip.style.top = (y + 150 > window.innerHeight ? y - 150 : y) + 'px';
      })
      .on('mouseout', function(event, d) {
        d3.select(this).attr('r', TYPE_RADIUS[d.pageType] || 3.5).attr('fill-opacity', 0.7);
        tooltip.style.display = 'none';
      });

    const wikis = [...new Set(data.map(d => d.wikiId))];
    const legendEl = document.getElementById('legend-items');
    wikis.forEach(wikiId => {
      const sample = data.find(d => d.wikiId === wikiId);
      const cnt = data.filter(d => d.wikiId === wikiId).length;
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML = \`<span class="legend-dot" style="background:\${sample.color}"></span>\${sample.wikiLabel} <span style="color:#475569;margin-left:auto">\${cnt}</span>\`;
      item.onclick = () => {
        const isActive = item.style.opacity !== '0.3';
        g.selectAll('circle').filter(d => d.wikiId === wikiId).attr('display', isActive ? 'none' : null);
        item.style.opacity = isActive ? '0.3' : '1';
      };
      legendEl.appendChild(item);
    });

    document.getElementById('stats').textContent =
      \`총 \${data.length}개 청크  ·  스크롤: 줌  ·  드래그: 이동  ·  호버: 상세\`;
})(_DATA);
<\/script>
</body>
</html>`;
}

main().catch(e => { console.error(e); process.exit(1); });
