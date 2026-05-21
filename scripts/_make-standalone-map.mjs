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
  body { background: #f4f6f9; color: #1e293b; font-family: -apple-system, 'Malgun Gothic', sans-serif; height: 100vh; overflow: hidden; }

  #header {
    position: fixed; top: 0; left: 0; right: 0; z-index: 20;
    background: rgba(255,255,255,0.95); backdrop-filter: blur(10px);
    padding: 10px 20px; border-bottom: 1px solid #e2e8f0;
    display: flex; align-items: center; justify-content: space-between;
  }
  #header h1 { font-size: 14px; font-weight: 700; color: #0f172a; }
  #header p  { font-size: 11px; color: #94a3b8; margin-top: 1px; }

  #controls { display: flex; align-items: center; gap: 8px; }
  .toggle-btn {
    background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px;
    padding: 4px 11px; color: #64748b; font-size: 11px; cursor: pointer;
    transition: all 0.15s; white-space: nowrap;
  }
  .toggle-btn.active { background: #1e293b; border-color: #1e293b; color: #fff; }

  #search-box {
    background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px;
    padding: 5px 10px; color: #1e293b; font-size: 12px; width: 180px; outline: none;
  }
  #search-box:focus { border-color: #64748b; }
  #search-box::placeholder { color: #94a3b8; }

  #legend {
    position: fixed; top: 52px; right: 16px; z-index: 10;
    background: rgba(255,255,255,0.95); border: 1px solid #e2e8f0;
    border-radius: 10px; padding: 12px 14px; min-width: 158px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.07);
  }
  #legend h3 { font-size: 10px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 7px; }
  .legend-item { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 11px; color: #334155; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
  .legend-item:hover { background: #f1f5f9; }
  .legend-item.dimmed { opacity: 0.25; }
  .legend-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .legend-cnt { color: #94a3b8; margin-left: auto; font-size: 10px; font-variant-numeric: tabular-nums; }

  #edge-key {
    position: fixed; bottom: 16px; right: 16px; z-index: 10;
    background: rgba(255,255,255,0.95); border: 1px solid #e2e8f0;
    border-radius: 10px; padding: 12px 14px; width: 190px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.07); font-size: 11px; color: #334155;
  }
  #edge-key b { display: block; font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px; }
  .key-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .key-line { flex-shrink: 0; width: 28px; height: 2px; }
  .key-line.within { background: currentColor; }
  .key-line.cross  { background: repeating-linear-gradient(90deg, #64748b 0, #64748b 4px, transparent 4px, transparent 8px); height: 2px; }

  #tooltip {
    position: fixed; z-index: 30;
    background: #fff; border: 1px solid #e2e8f0;
    border-radius: 10px; padding: 12px 14px; max-width: 270px;
    pointer-events: none; display: none;
    box-shadow: 0 8px 28px rgba(0,0,0,0.12);
  }
  .t-badge { display: inline-block; font-size: 9px; padding: 2px 7px; border-radius: 4px; margin-bottom: 7px; font-weight: 700; letter-spacing: 0.03em; }
  .t-title  { font-size: 13px; font-weight: 700; color: #0f172a; margin-bottom: 3px; line-height: 1.3; }
  .t-meta   { font-size: 10px; color: #94a3b8; margin-bottom: 8px; }
  .t-preview { font-size: 11px; color: #475569; line-height: 1.6; border-top: 1px solid #f1f5f9; padding-top: 7px; }

  #stats { position: fixed; bottom: 16px; left: 16px; z-index: 10; font-size: 10px; color: #94a3b8; line-height: 1.8; }
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
    <button class="toggle-btn active" id="btn-edges">연결선</button>
    <button class="toggle-btn active" id="btn-cross">위키간 선</button>
    <button class="toggle-btn" id="btn-chunks">청크 점</button>
    <input id="search-box" type="text" placeholder="페이지 검색...">
  </div>
</div>

<div id="legend">
  <h3>위키</h3>
  <div id="legend-items"></div>
</div>

<div id="edge-key">
  <b>연결선 범례</b>
  <div class="key-row">
    <svg width="28" height="10"><line x1="0" y1="5" x2="28" y2="5" stroke="#3b82f6" stroke-width="2"/><\/svg>
    <span>위키 내 유사 페이지</span>
  </div>
  <div class="key-row">
    <svg width="28" height="10"><line x1="0" y1="5" x2="28" y2="5" stroke="#64748b" stroke-width="1.5" stroke-dasharray="4,4"/><\/svg>
    <span>위키 간 내용 유사</span>
  </div>
  <div style="margin-top:8px;border-top:1px solid #f1f5f9;padding-top:8px;color:#94a3b8;font-size:10px;line-height:1.7">
    원 크기 = 청크 수<br>
    흰 테두리 = 소스 문서<br>
    가까울수록 내용 유사
  </div>
</div>

<div id="tooltip">
  <div class="t-badge" id="t-badge"></div>
  <div class="t-title"  id="t-title"></div>
  <div class="t-meta"   id="t-meta"></div>
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

(function () {
  const W = window.innerWidth, H = window.innerHeight - 44;

  // ── 섬 좌표 ──
  const wikiGroups = d3.group(DATA, d => d.wikiId);
  const wikiStats  = {};
  for (const [wid, pts] of wikiGroups) {
    wikiStats[wid] = {
      cx: d3.mean(pts, p => p.x), cy: d3.mean(pts, p => p.y),
      sx: d3.deviation(pts, p => p.x) || 1, sy: d3.deviation(pts, p => p.y) || 1,
    };
  }
  const SPREAD = 72;
  DATA.forEach(d => {
    const lay = WIKI_LAYOUT[d.wikiId] || { fx: 0.5, fy: 0.5 };
    const st  = wikiStats[d.wikiId];
    d.dx = lay.fx * W + (d.x - st.cx) / st.sx * SPREAD;
    d.dy = lay.fy * H + (d.y - st.cy) / st.sy * SPREAD;
  });

  // ── 페이지 집약 ──
  const pageMap = new Map();
  DATA.forEach(d => {
    const key = d.wikiId + '||' + d.pageId;
    if (!pageMap.has(key)) pageMap.set(key, { key, wikiId: d.wikiId, pageId: d.pageId, title: d.title, wikiLabel: d.wikiLabel, color: d.color, pageType: d.pageType, pageTypeLabel: d.pageTypeLabel, chunks: [] });
    pageMap.get(key).chunks.push(d);
  });
  const pages = [...pageMap.values()].map(p => ({
    ...p, count: p.chunks.length,
    r:  Math.max(6, Math.sqrt(p.chunks.length) * 4.2),
    ox: d3.mean(p.chunks, c => c.x), oy: d3.mean(p.chunks, c => c.y),
    dx: d3.mean(p.chunks, c => c.dx), dy: d3.mean(p.chunks, c => c.dy),
    preview: p.chunks[0].preview,
  }));

  // ── 위키 내 엣지 (k=2 근접 이웃) ──
  const edgeSet = new Set(), withinEdges = [];
  for (const [, wps] of d3.group(pages, p => p.wikiId)) {
    for (const p of wps) {
      wps.filter(q => q !== p)
        .sort((a, b) => Math.hypot(a.dx-p.dx, a.dy-p.dy) - Math.hypot(b.dx-p.dx, b.dy-p.dy))
        .slice(0, 2)
        .forEach(q => {
          const ek = [p.key, q.key].sort().join('~~~');
          if (!edgeSet.has(ek)) { edgeSet.add(ek); withinEdges.push({ s: p, t: q }); }
        });
    }
  }

  // ── 위키 간 엣지 (PCA 거리 상위 20쌍) ──
  const crossPairs = [];
  for (let i = 0; i < pages.length; i++)
    for (let j = i+1; j < pages.length; j++)
      if (pages[i].wikiId !== pages[j].wikiId)
        crossPairs.push({ s: pages[i], t: pages[j], dist: Math.hypot(pages[i].ox-pages[j].ox, pages[i].oy-pages[j].oy) });
  crossPairs.sort((a, b) => a.dist - b.dist);
  const crossEdges = crossPairs.slice(0, 20);

  // ── SVG ──
  const svg  = d3.select('#canvas').attr('width', W).attr('height', H + 44);
  const root = svg.append('g').attr('transform', 'translate(0,44)');
  svg.call(d3.zoom().scaleExtent([0.2, 30]).on('zoom', e => root.attr('transform', 'translate(0,44) ' + e.transform)));

  // ── 클러스터 배경 ──
  for (const [wid, wps] of wikiGroups) {
    const lay = WIKI_LAYOUT[wid]; if (!lay) continue;
    const cx = lay.fx*W, cy = lay.fy*H, color = wps[0].color;
    const r = SPREAD * 1.55 + Math.sqrt(wps.length) * 2.2;
    root.append('circle').attr('cx', cx).attr('cy', cy).attr('r', r)
      .attr('fill', color).attr('fill-opacity', 0.07)
      .attr('stroke', color).attr('stroke-opacity', 0.25).attr('stroke-width', 1.5);
    root.append('text').attr('x', cx).attr('y', cy - r - 7)
      .attr('text-anchor', 'middle')
      .attr('font-size', 12).attr('font-weight', '700')
      .attr('fill', color).attr('fill-opacity', 0.85)
      .text(wps[0].wikiLabel);
  }

  // ── 위키 간 엣지 (점선, 진하게) ──
  const crossLayer = root.append('g').attr('id', 'cross-edges');
  crossEdges.forEach(({ s, t }) =>
    crossLayer.append('line')
      .attr('x1', s.dx).attr('y1', s.dy).attr('x2', t.dx).attr('y2', t.dy)
      .attr('stroke', '#64748b').attr('stroke-opacity', 0.45)
      .attr('stroke-width', 1.4).attr('stroke-dasharray', '5,5')
  );

  // ── 위키 내 엣지 (실선, 위키 색상으로 진하게) ──
  const withinLayer = root.append('g').attr('id', 'within-edges');
  withinEdges.forEach(({ s, t }) =>
    withinLayer.append('line')
      .attr('x1', s.dx).attr('y1', s.dy).attr('x2', t.dx).attr('y2', t.dy)
      .attr('stroke', s.color).attr('stroke-opacity', 0.55)
      .attr('stroke-width', 1.6)
  );

  // ── 청크 점 (기본 숨김) ──
  const chunkLayer = root.append('g').attr('id', 'chunks').attr('display', 'none');
  chunkLayer.selectAll('circle').data(DATA).join('circle')
    .attr('cx', d => d.dx).attr('cy', d => d.dy).attr('r', 2.2)
    .attr('fill', d => d.color).attr('fill-opacity', 0.35);

  // ── 페이지 노드 ──
  const tooltip = document.getElementById('tooltip');
  const pageLayer = root.append('g').attr('id', 'pages');
  const pageNodes = pageLayer.selectAll('circle').data(pages).join('circle')
    .attr('cx', d => d.dx).attr('cy', d => d.dy).attr('r', d => d.r)
    .attr('fill', d => d.color).attr('fill-opacity', 0.88)
    .attr('stroke', '#fff').attr('stroke-width', d => d.pageType === 'source' ? 2 : 0.8)
    .attr('stroke-opacity', 0.9)
    .style('cursor', 'pointer')
    .on('mouseover', function(event, d) {
      d3.select(this).raise().attr('r', d.r * 1.5).attr('stroke-width', 2.5);
      document.getElementById('t-badge').textContent   = d.wikiLabel + '  ·  ' + d.pageTypeLabel;
      document.getElementById('t-badge').style.background = d.color + '22';
      document.getElementById('t-badge').style.color      = d.color;
      document.getElementById('t-title').textContent  = d.title || d.pageId;
      document.getElementById('t-meta').textContent   = '청크 ' + d.count + '개  ·  ' + d.pageId;
      document.getElementById('t-preview').textContent = d.preview;
      tooltip.style.display = 'block';
    })
    .on('mousemove', event => {
      const x = event.clientX + 16, y = event.clientY + 16;
      tooltip.style.left = (x + 270 > window.innerWidth  ? x - 286 : x) + 'px';
      tooltip.style.top  = (y + 160 > window.innerHeight ? y - 160  : y) + 'px';
    })
    .on('mouseout', function(event, d) {
      d3.select(this).attr('r', d.r).attr('stroke-width', d.pageType === 'source' ? 2 : 0.8);
      tooltip.style.display = 'none';
    });

  // ── 범례 ──
  const hidden = new Set();
  const legendEl = document.getElementById('legend-items');
  for (const [wid, wps] of wikiGroups) {
    const wikiPages = pages.filter(p => p.wikiId === wid);
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML =
      '<span class="legend-dot" style="background:' + wps[0].color + '"></span>' +
      '<span>' + wps[0].wikiLabel + '</span>' +
      '<span class="legend-cnt">' + wikiPages.length + 'p</span>';
    item.onclick = () => {
      hidden.has(wid) ? hidden.delete(wid) : hidden.add(wid);
      item.classList.toggle('dimmed', hidden.has(wid));
      pageNodes.attr('display', d => hidden.has(d.wikiId) ? 'none' : null);
      withinLayer.selectAll('line').attr('display', e => hidden.has(e.s.wikiId) ? 'none' : null);
    };
    legendEl.appendChild(item);
  }

  // ── 토글 ──
  let showEdges = true, showCross = true, showChunks = false;
  document.getElementById('btn-edges').onclick = function() {
    showEdges = !showEdges; this.classList.toggle('active', showEdges);
    withinLayer.attr('display', showEdges ? null : 'none');
  };
  document.getElementById('btn-cross').onclick = function() {
    showCross = !showCross; this.classList.toggle('active', showCross);
    crossLayer.attr('display', showCross ? null : 'none');
  };
  document.getElementById('btn-chunks').onclick = function() {
    showChunks = !showChunks; this.classList.toggle('active', showChunks);
    chunkLayer.attr('display', showChunks ? null : 'none');
  };

  // ── 검색 ──
  document.getElementById('search-box').addEventListener('input', function() {
    const q = this.value.trim().toLowerCase();
    if (!q) { pageNodes.attr('fill-opacity', 0.88).attr('r', d => d.r); return; }
    pageNodes
      .attr('fill-opacity', d => ((d.title||'').toLowerCase().includes(q) || d.preview.toLowerCase().includes(q) || d.wikiLabel.includes(q)) ? 1 : 0.07)
      .attr('r', d => ((d.title||'').toLowerCase().includes(q) || d.preview.toLowerCase().includes(q) || d.wikiLabel.includes(q)) ? d.r*1.8 : d.r);
  });

  document.getElementById('stats').textContent =
    '페이지 ' + pages.length + '개  ·  청크 ' + DATA.length + '개  ·  엣지 ' + (withinEdges.length + crossEdges.length) + '개';
  document.getElementById('subtitle').textContent =
    '페이지 단위 네트워크 · ' + pages.length + 'p · 9개 위키';
})();
<\/script>
</body>
</html>`;

fs.writeFileSync('public/knowledge-map.html', html);
const size = fs.statSync('public/knowledge-map.html').size;
console.log('✅ knowledge-map.html 생성 완료:', Math.round(size / 1024), 'KB');
