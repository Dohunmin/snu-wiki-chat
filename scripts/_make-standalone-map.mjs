import fs from 'fs';

const points = JSON.parse(fs.readFileSync('public/knowledge-map-data.json', 'utf-8'));
const inlineData = JSON.stringify(points);

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>SNU 거버넌스 위키 — 지식 지형도</title>
<script src="https://d3js.org/d3.v7.min.js"><\/script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080c14; color: #e2e8f0; font-family: -apple-system, 'Malgun Gothic', sans-serif; height: 100vh; overflow: hidden; }
  #header { position: fixed; top: 0; left: 0; right: 0; z-index: 20; background: rgba(8,12,20,0.92); backdrop-filter: blur(10px); padding: 10px 20px; border-bottom: 1px solid #1e293b; display: flex; align-items: center; justify-content: space-between; }
  #header h1 { font-size: 14px; font-weight: 700; color: #f1f5f9; }
  #header p { font-size: 11px; color: #475569; margin-top: 1px; }
  #controls { display: flex; align-items: center; gap: 10px; }
  #search-box { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 5px 10px; color: #e2e8f0; font-size: 12px; width: 180px; outline: none; }
  #search-box:focus { border-color: #3b82f6; }
  #search-box::placeholder { color: #475569; }
  .toggle-btn { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 4px 10px; color: #94a3b8; font-size: 11px; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
  .toggle-btn.active { background: #3b82f6; border-color: #3b82f6; color: #fff; }
  #legend { position: fixed; top: 52px; right: 16px; z-index: 10; background: rgba(8,12,20,0.9); border: 1px solid #1e293b; border-radius: 8px; padding: 10px 12px; min-width: 150px; }
  #legend h3 { font-size: 10px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 7px; }
  .legend-item { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; font-size: 11px; color: #cbd5e1; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
  .legend-item:hover { background: rgba(255,255,255,0.05); }
  .legend-item.dimmed { opacity: 0.25; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .legend-cnt { color: #475569; margin-left: auto; font-size: 10px; }
  #info { position: fixed; bottom: 60px; right: 16px; z-index: 10; background: rgba(8,12,20,0.9); border: 1px solid #1e293b; border-radius: 8px; padding: 10px 12px; width: 200px; font-size: 10px; color: #475569; line-height: 1.7; }
  #info b { color: #94a3b8; display: block; margin-bottom: 4px; font-size: 11px; }
  #tooltip { position: fixed; z-index: 30; background: rgba(8,12,20,0.97); border: 1px solid #334155; border-radius: 10px; padding: 12px 14px; max-width: 280px; pointer-events: none; display: none; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  .t-badge { display: inline-block; font-size: 9px; padding: 1px 6px; border-radius: 3px; margin-bottom: 6px; font-weight: 600; }
  .t-title { font-size: 13px; font-weight: 700; color: #f1f5f9; margin-bottom: 3px; line-height: 1.3; }
  .t-meta { font-size: 10px; color: #475569; margin-bottom: 8px; }
  .t-preview { font-size: 11px; color: #94a3b8; line-height: 1.6; border-top: 1px solid #1e293b; padding-top: 7px; }
  #stats { position: fixed; bottom: 12px; left: 16px; z-index: 10; font-size: 10px; color: #334155; line-height: 1.8; }
  svg { display: block; }
</style>
</head>
<body>
<div id="header">
  <div>
    <h1>SNU 거버넌스 위키 — 지식 지형도</h1>
    <p id="subtitle">페이지 단위 네트워크 · 9개 위키</p>
  </div>
  <div id="controls">
    <button class="toggle-btn active" id="btn-pages">페이지 노드</button>
    <button class="toggle-btn active" id="btn-edges">연결선</button>
    <button class="toggle-btn" id="btn-chunks">청크 점</button>
    <input id="search-box" type="text" placeholder="검색...">
  </div>
</div>
<div id="legend">
  <h3>위키</h3>
  <div id="legend-items"></div>
  <div style="margin-top:8px;border-top:1px solid #1e293b;padding-top:8px;">
    <h3 style="margin-bottom:5px;">노드 크기</h3>
    <div style="font-size:10px;color:#475569;line-height:1.8">
      크기 ∝ 청크 수<br>
      실선 = 위키 내 근접 연결<br>
      점선 = 위키 간 의미 유사
    </div>
  </div>
</div>
<div id="info">
  <b>읽는 법</b>
  가까운 노드 = 비슷한 내용<br>
  실선 = 같은 위키 내 연관<br>
  점선 = 다른 위키 간 내용 유사<br>
  굵은 원 = 많은 청크(큰 문서)<br>
  호버하면 미리보기 표시
</div>
<div id="tooltip">
  <div class="t-badge" id="t-badge"></div>
  <div class="t-title" id="t-title"></div>
  <div class="t-meta" id="t-meta"></div>
  <div class="t-preview" id="t-preview"></div>
</div>
<div id="stats"></div>
<svg id="canvas"></svg>

<script>
const WIKI_LAYOUT = {
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

const DATA = ${inlineData};

(function() {
  const W = window.innerWidth, H = window.innerHeight - 44;

  // ── 섬 레이아웃 좌표 계산 (청크 단위) ──
  const wikiGroups = d3.group(DATA, d => d.wikiId);
  const wikiStats = {};
  for (const [wid, pts] of wikiGroups) {
    wikiStats[wid] = {
      cx: d3.mean(pts, p => p.x), cy: d3.mean(pts, p => p.y),
      sx: d3.deviation(pts, p => p.x) || 1, sy: d3.deviation(pts, p => p.y) || 1,
    };
  }
  const SPREAD = 72;
  DATA.forEach(d => {
    const lay = WIKI_LAYOUT[d.wikiId] || { fx: 0.5, fy: 0.5 };
    const st = wikiStats[d.wikiId];
    d.dx = lay.fx * W + (d.x - st.cx) / st.sx * SPREAD;
    d.dy = lay.fy * H + (d.y - st.cy) / st.sy * SPREAD;
  });

  // ── 페이지 단위 집약 ──
  const pageMap = new Map();
  DATA.forEach(d => {
    const key = d.wikiId + '||' + d.pageId;
    if (!pageMap.has(key)) pageMap.set(key, {
      key, wikiId: d.wikiId, pageId: d.pageId,
      title: d.title, wikiLabel: d.wikiLabel, color: d.color,
      pageType: d.pageType, pageTypeLabel: d.pageTypeLabel, chunks: []
    });
    pageMap.get(key).chunks.push(d);
  });
  const pages = [...pageMap.values()].map(p => {
    const count = p.chunks.length;
    return {
      ...p, count,
      r: Math.max(6, Math.sqrt(count) * 4),
      ox: d3.mean(p.chunks, c => c.x),   // original PCA
      oy: d3.mean(p.chunks, c => c.y),
      dx: d3.mean(p.chunks, c => c.dx),  // island
      dy: d3.mean(p.chunks, c => c.dy),
      preview: p.chunks[0].preview,
    };
  });

  // ── 위키 내 엣지: k=2 근접 이웃 ──
  const withinEdgeSet = new Set();
  const withinEdges = [];
  for (const [wid, wps] of d3.group(pages, p => p.wikiId)) {
    for (const p of wps) {
      const sorted = wps.filter(q => q !== p)
        .sort((a, b) => Math.hypot(a.dx - p.dx, a.dy - p.dy) - Math.hypot(b.dx - p.dx, b.dy - p.dy));
      for (const q of sorted.slice(0, 2)) {
        const ek = [p.key, q.key].sort().join('~~~');
        if (!withinEdgeSet.has(ek)) {
          withinEdgeSet.add(ek);
          withinEdges.push({ s: p, t: q, color: p.color });
        }
      }
    }
  }

  // ── 위키 간 엣지: 원래 PCA 거리 기준 상위 20쌍 ──
  const crossPairs = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      if (pages[i].wikiId !== pages[j].wikiId) {
        crossPairs.push({
          s: pages[i], t: pages[j],
          dist: Math.hypot(pages[i].ox - pages[j].ox, pages[i].oy - pages[j].oy)
        });
      }
    }
  }
  crossPairs.sort((a, b) => a.dist - b.dist);
  const crossEdges = crossPairs.slice(0, 20);

  // ── SVG 세팅 ──
  const svg = d3.select('#canvas').attr('width', W).attr('height', H + 44);
  const root = svg.append('g').attr('transform', 'translate(0,44)');
  svg.call(d3.zoom().scaleExtent([0.2, 30]).on('zoom', e => {
    root.attr('transform', 'translate(0,44) ' + e.transform);
  }));

  // ── 클러스터 배경 ──
  const bgLayer = root.append('g');
  for (const [wid, wps] of wikiGroups) {
    const lay = WIKI_LAYOUT[wid]; if (!lay) continue;
    const cx = lay.fx * W, cy = lay.fy * H;
    const color = wps[0].color;
    const cnt = wps.length;
    bgLayer.append('circle').attr('cx', cx).attr('cy', cy)
      .attr('r', SPREAD * 1.5 + Math.sqrt(cnt) * 2.2)
      .attr('fill', color).attr('fill-opacity', 0.05)
      .attr('stroke', color).attr('stroke-opacity', 0.12).attr('stroke-width', 1);
    bgLayer.append('text').attr('x', cx).attr('y', cy - SPREAD * 1.5 - Math.sqrt(cnt) * 2.2 - 7)
      .attr('text-anchor', 'middle')
      .attr('font-size', 11).attr('font-weight', '700')
      .attr('fill', color).attr('fill-opacity', 0.7)
      .text(wps[0].wikiLabel);
  }

  // ── 위키 간 엣지 (점선) ──
  const crossLayer = root.append('g').attr('id', 'cross-edges');
  crossEdges.forEach(({ s, t }) => {
    crossLayer.append('line')
      .attr('x1', s.dx).attr('y1', s.dy).attr('x2', t.dx).attr('y2', t.dy)
      .attr('stroke', '#94a3b8').attr('stroke-opacity', 0.18)
      .attr('stroke-width', 1).attr('stroke-dasharray', '4,5');
  });

  // ── 위키 내 엣지 (실선) ──
  const withinLayer = root.append('g').attr('id', 'within-edges');
  withinEdges.forEach(({ s, t, color }) => {
    withinLayer.append('line')
      .attr('x1', s.dx).attr('y1', s.dy).attr('x2', t.dx).attr('y2', t.dy)
      .attr('stroke', color).attr('stroke-opacity', 0.22)
      .attr('stroke-width', 0.8);
  });

  // ── 청크 점 (배경, 기본 숨김) ──
  const chunkLayer = root.append('g').attr('id', 'chunks').attr('display', 'none');
  chunkLayer.selectAll('circle').data(DATA).join('circle')
    .attr('cx', d => d.dx).attr('cy', d => d.dy).attr('r', 2)
    .attr('fill', d => d.color).attr('fill-opacity', 0.3);

  // ── 페이지 노드 ──
  const tooltip = document.getElementById('tooltip');
  const pageLayer = root.append('g').attr('id', 'pages');
  const pageNodes = pageLayer.selectAll('circle').data(pages).join('circle')
    .attr('cx', d => d.dx).attr('cy', d => d.dy).attr('r', d => d.r)
    .attr('fill', d => d.color).attr('fill-opacity', 0.82)
    .attr('stroke', d => d.pageType === 'source' ? '#fff' : d.color)
    .attr('stroke-width', d => d.pageType === 'source' ? 1.2 : 0)
    .attr('stroke-opacity', 0.4)
    .style('cursor', 'pointer')
    .on('mouseover', function(event, d) {
      d3.select(this).attr('r', d.r * 1.5).attr('fill-opacity', 1).attr('stroke', '#fff').attr('stroke-width', 2).attr('stroke-opacity', 1);
      document.getElementById('t-badge').textContent = d.wikiLabel + ' · ' + d.pageTypeLabel;
      document.getElementById('t-badge').style.background = d.color + '33';
      document.getElementById('t-badge').style.color = d.color;
      document.getElementById('t-title').textContent = d.title || d.pageId;
      document.getElementById('t-meta').textContent = '청크 ' + d.count + '개  ·  ' + d.pageId;
      document.getElementById('t-preview').textContent = d.preview;
      tooltip.style.display = 'block';
    })
    .on('mousemove', event => {
      const x = event.clientX + 16, y = event.clientY + 16;
      tooltip.style.left = (x + 280 > window.innerWidth ? x - 296 : x) + 'px';
      tooltip.style.top = (y + 160 > window.innerHeight ? y - 160 : y) + 'px';
    })
    .on('mouseout', function(event, d) {
      d3.select(this).attr('r', d.r).attr('fill-opacity', 0.82)
        .attr('stroke', d.pageType === 'source' ? '#fff' : d.color)
        .attr('stroke-width', d.pageType === 'source' ? 1.2 : 0)
        .attr('stroke-opacity', 0.4);
      tooltip.style.display = 'none';
    });

  // ── 범례 ──
  const hidden = new Set();
  const legendEl = document.getElementById('legend-items');
  for (const [wid, wps] of wikiGroups) {
    const item = document.createElement('div');
    item.className = 'legend-item';
    const wikiPages = pages.filter(p => p.wikiId === wid);
    item.innerHTML =
      '<span class="legend-dot" style="background:' + wps[0].color + '"></span>' +
      '<span>' + wps[0].wikiLabel + '</span>' +
      '<span class="legend-cnt">' + wikiPages.length + 'p</span>';
    item.onclick = () => {
      if (hidden.has(wid)) { hidden.delete(wid); item.classList.remove('dimmed'); }
      else { hidden.add(wid); item.classList.add('dimmed'); }
      pageNodes.attr('display', d => hidden.has(d.wikiId) ? 'none' : null);
      d3.selectAll('#within-edges line').attr('display', e => hidden.has(e.s.wikiId) ? 'none' : null);
    };
    legendEl.appendChild(item);
  }

  // ── 토글 ──
  let showEdges = true, showChunks = false;
  document.getElementById('btn-edges').onclick = function() {
    showEdges = !showEdges;
    this.classList.toggle('active', showEdges);
    d3.select('#within-edges').attr('display', showEdges ? null : 'none');
    d3.select('#cross-edges').attr('display', showEdges ? null : 'none');
  };
  document.getElementById('btn-chunks').onclick = function() {
    showChunks = !showChunks;
    this.classList.toggle('active', showChunks);
    d3.select('#chunks').attr('display', showChunks ? null : 'none');
  };

  // ── 검색 ──
  document.getElementById('search-box').addEventListener('input', function() {
    const q = this.value.trim().toLowerCase();
    if (!q) { pageNodes.attr('fill-opacity', 0.82).attr('r', d => d.r); return; }
    pageNodes
      .attr('fill-opacity', d => {
        const hit = (d.title || '').toLowerCase().includes(q) || d.preview.toLowerCase().includes(q) || d.wikiLabel.includes(q);
        return hit ? 1 : 0.06;
      })
      .attr('r', d => {
        const hit = (d.title || '').toLowerCase().includes(q) || d.preview.toLowerCase().includes(q) || d.wikiLabel.includes(q);
        return hit ? d.r * 1.8 : d.r;
      });
  });

  // ── 통계 ──
  document.getElementById('stats').textContent =
    '페이지 ' + pages.length + '개  ·  청크 ' + DATA.length + '개  ·  엣지 ' + (withinEdges.length + crossEdges.length) + '개';
  document.getElementById('subtitle').textContent =
    '페이지 단위 네트워크 · ' + pages.length + '개 페이지 · 9개 위키';
})();
<\/script>
</body>
</html>`;

fs.writeFileSync('public/knowledge-map.html', html);
const size = fs.statSync('public/knowledge-map.html').size;
console.log('✅ knowledge-map.html 생성 완료:', Math.round(size / 1024), 'KB');
console.log('   페이지 집약 + 위키 내/간 엣지 추가됨');
