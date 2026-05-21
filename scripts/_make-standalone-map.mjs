import fs from 'fs';

const points = JSON.parse(fs.readFileSync('public/knowledge-map-data.json', 'utf-8'));
const inlineData = JSON.stringify(points);

const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SNU 거버넌스 위키 — 지식 지형도</title>
<script src="https://d3js.org/d3.v7.min.js"><\/script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #080c14; color: #e2e8f0; font-family: -apple-system, 'Malgun Gothic', sans-serif; height: 100vh; overflow: hidden; }
  #header { position: fixed; top: 0; left: 0; right: 0; z-index: 20; background: rgba(8,12,20,0.92); backdrop-filter: blur(10px); padding: 10px 20px; border-bottom: 1px solid #1e293b; display: flex; align-items: center; justify-content: space-between; }
  #header h1 { font-size: 14px; font-weight: 700; color: #f1f5f9; letter-spacing: -0.01em; }
  #header p { font-size: 11px; color: #475569; margin-top: 1px; }
  #search-box { background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 5px 10px; color: #e2e8f0; font-size: 12px; width: 200px; outline: none; }
  #search-box::placeholder { color: #475569; }
  #search-box:focus { border-color: #3b82f6; }
  #legend { position: fixed; top: 52px; right: 16px; z-index: 10; background: rgba(8,12,20,0.88); border: 1px solid #1e293b; border-radius: 8px; padding: 10px 12px; min-width: 155px; }
  #legend h3 { font-size: 10px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 7px; }
  .legend-item { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; font-size: 11.5px; color: #cbd5e1; cursor: pointer; border-radius: 4px; padding: 2px 4px; transition: background 0.15s; }
  .legend-item:hover { background: rgba(255,255,255,0.05); color: #fff; }
  .legend-item.dimmed { opacity: 0.3; }
  .legend-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .legend-cnt { color: #475569; margin-left: auto; font-size: 10px; font-variant-numeric: tabular-nums; }
  #tooltip { position: fixed; z-index: 30; background: rgba(8,12,20,0.97); border: 1px solid #334155; border-radius: 10px; padding: 12px 14px; max-width: 280px; pointer-events: none; display: none; box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
  .t-wiki { font-size: 10px; color: #64748b; margin-bottom: 3px; }
  .t-title { font-size: 13px; font-weight: 700; color: #f1f5f9; margin-bottom: 3px; line-height: 1.3; }
  .t-type { font-size: 10px; color: #475569; margin-bottom: 8px; }
  .t-preview { font-size: 11px; color: #94a3b8; line-height: 1.6; border-top: 1px solid #1e293b; padding-top: 7px; }
  #stats { position: fixed; bottom: 12px; left: 16px; z-index: 10; font-size: 10px; color: #334155; }
  #hint { position: fixed; bottom: 12px; right: 16px; z-index: 10; font-size: 10px; color: #334155; }
  svg { display: block; }
  .cluster-bg { pointer-events: none; }
  .wiki-label { pointer-events: none; user-select: none; }
  circle.dot { cursor: pointer; transition: r 0.08s; }
</style>
</head>
<body>
<div id="header">
  <div>
    <h1>SNU 거버넌스 위키 — 지식 지형도</h1>
    <p>위키별 클러스터 맵 · ${points.length}개 청크 · 9개 위키</p>
  </div>
  <input id="search-box" type="text" placeholder="청크 검색... (제목, 미리보기)">
</div>
<div id="legend">
  <h3>위키</h3>
  <div id="legend-items"></div>
</div>
<div id="tooltip">
  <div class="t-wiki" id="t-wiki"></div>
  <div class="t-title" id="t-title"></div>
  <div class="t-type" id="t-type"></div>
  <div class="t-preview" id="t-preview"></div>
</div>
<div id="stats"></div>
<div id="hint">스크롤: 줌 &nbsp;·&nbsp; 드래그: 이동 &nbsp;·&nbsp; 호버: 상세</div>
<svg id="canvas"></svg>

<script>
const TYPE_RADIUS = { source: 6, overview: 6, topic: 5, entity: 4.5, fact: 3.5, stance: 3.5 };

// 위키별 고정 섬 위치 (정규화 0~1)
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
  const svg = d3.select('#canvas').attr('width', W).attr('height', H + 44);
  const g = svg.append('g').attr('transform', 'translate(0,44)');

  svg.call(d3.zoom().scaleExtent([0.25, 25]).on('zoom', e => {
    g.attr('transform', 'translate(0,44) ' + e.transform);
  }));

  // 위키별 PCA 중심·분산 계산
  const wikiGroups = d3.group(DATA, d => d.wikiId);
  const wikiStats = {};
  for (const [wikiId, pts] of wikiGroups) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    wikiStats[wikiId] = {
      cx: d3.mean(xs), cy: d3.mean(ys),
      sx: d3.deviation(xs) || 1, sy: d3.deviation(ys) || 1,
    };
  }

  // 각 점의 표시 좌표 계산 (위키 섬 중심 + PCA 내부 상대 좌표)
  const SPREAD = 75;
  DATA.forEach(d => {
    const layout = WIKI_LAYOUT[d.wikiId] || { fx: 0.5, fy: 0.5 };
    const st = wikiStats[d.wikiId];
    d.dx = layout.fx * W + (d.x - st.cx) / st.sx * SPREAD;
    d.dy = layout.fy * H + (d.y - st.cy) / st.sy * SPREAD;
  });

  // 클러스터 배경 원
  const clusterLayer = g.append('g').attr('class', 'cluster-bgs');
  for (const [wikiId, pts] of wikiGroups) {
    const layout = WIKI_LAYOUT[wikiId];
    if (!layout) continue;
    const cx = layout.fx * W, cy = layout.fy * H;
    const color = pts[0].color;
    // 배경 원 (반투명)
    clusterLayer.append('circle')
      .attr('cx', cx).attr('cy', cy)
      .attr('r', SPREAD * 1.5 + Math.sqrt(pts.length) * 2.5)
      .attr('fill', color).attr('fill-opacity', 0.06)
      .attr('stroke', color).attr('stroke-opacity', 0.15)
      .attr('stroke-width', 1);
    // 위키 이름 레이블
    clusterLayer.append('text')
      .attr('x', cx).attr('y', cy - SPREAD * 1.5 - Math.sqrt(pts.length) * 2.5 - 6)
      .attr('text-anchor', 'middle')
      .attr('font-size', 11).attr('font-weight', '600')
      .attr('fill', color).attr('fill-opacity', 0.85)
      .attr('letter-spacing', '0.03em')
      .text(pts[0].wikiLabel + ' (' + pts.length + ')');
  }

  // 점 그리기
  const tooltip = document.getElementById('tooltip');
  const dots = g.append('g').selectAll('circle.dot')
    .data(DATA)
    .join('circle')
    .attr('class', 'dot')
    .attr('cx', d => d.dx)
    .attr('cy', d => d.dy)
    .attr('r', d => TYPE_RADIUS[d.pageType] || 4)
    .attr('fill', d => d.color)
    .attr('fill-opacity', 0.75)
    .attr('stroke', 'none')
    .on('mouseover', function(event, d) {
      d3.select(this).attr('r', (TYPE_RADIUS[d.pageType] || 4) * 2.2).attr('fill-opacity', 1).attr('stroke', '#fff').attr('stroke-width', 1.5);
      document.getElementById('t-wiki').textContent = d.wikiLabel;
      document.getElementById('t-title').textContent = d.title || d.pageId;
      document.getElementById('t-type').textContent = d.pageTypeLabel + '  ·  ' + d.pageId;
      document.getElementById('t-preview').textContent = d.preview;
      tooltip.style.display = 'block';
    })
    .on('mousemove', event => {
      const x = event.clientX + 16, y = event.clientY + 16;
      tooltip.style.left = (x + 280 > window.innerWidth ? x - 296 : x) + 'px';
      tooltip.style.top = (y + 160 > window.innerHeight ? y - 160 : y) + 'px';
    })
    .on('mouseout', function(event, d) {
      d3.select(this).attr('r', TYPE_RADIUS[d.pageType] || 4).attr('fill-opacity', 0.75).attr('stroke', 'none');
      tooltip.style.display = 'none';
    });

  // 범례
  const wikis = [...wikiGroups.keys()];
  const legendEl = document.getElementById('legend-items');
  const hidden = new Set();
  wikis.forEach(wikiId => {
    const pts = wikiGroups.get(wikiId);
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML =
      '<span class="legend-dot" style="background:' + pts[0].color + '"></span>' +
      '<span>' + pts[0].wikiLabel + '</span>' +
      '<span class="legend-cnt">' + pts.length + '</span>';
    item.onclick = () => {
      if (hidden.has(wikiId)) {
        hidden.delete(wikiId);
        item.classList.remove('dimmed');
        dots.filter(d => d.wikiId === wikiId).attr('display', null);
        clusterLayer.selectAll('*').filter(function() {
          return d3.select(this).datum && d3.select(this).datum() === wikiId;
        });
        // 클러스터 배경도 표시 복원
        g.selectAll('.cluster-bgs circle').filter((_, i) => wikis[i] === wikiId).attr('display', null);
      } else {
        hidden.add(wikiId);
        item.classList.add('dimmed');
        dots.filter(d => d.wikiId === wikiId).attr('display', 'none');
      }
    };
    legendEl.appendChild(item);
  });

  // 검색
  document.getElementById('search-box').addEventListener('input', function() {
    const q = this.value.trim().toLowerCase();
    if (!q) {
      dots.attr('fill-opacity', 0.75).attr('r', d => TYPE_RADIUS[d.pageType] || 4);
      return;
    }
    dots.attr('fill-opacity', d => {
      const match = (d.title || '').toLowerCase().includes(q) || d.preview.toLowerCase().includes(q) || d.wikiLabel.includes(q);
      return match ? 1 : 0.08;
    }).attr('r', d => {
      const match = (d.title || '').toLowerCase().includes(q) || d.preview.toLowerCase().includes(q) || d.wikiLabel.includes(q);
      return match ? (TYPE_RADIUS[d.pageType] || 4) * 1.6 : (TYPE_RADIUS[d.pageType] || 4);
    });
  });

  document.getElementById('stats').textContent = '총 ' + DATA.length + '개 청크';
})();
<\/script>
</body>
</html>`;

fs.writeFileSync('public/knowledge-map.html', html);
const size = fs.statSync('public/knowledge-map.html').size;
console.log('✅ public/knowledge-map.html 생성 완료:', Math.round(size / 1024), 'KB');
