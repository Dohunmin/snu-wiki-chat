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
    <p>PCA 2D 프로젝션 · ${points.length}개 청크 · 9개 위키</p>
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
    item.innerHTML = '<span class="legend-dot" style="background:' + sample.color + '"></span>' + sample.wikiLabel + ' <span style="color:#475569;margin-left:auto">' + cnt + '</span>';
    item.onclick = () => {
      const isActive = item.style.opacity !== '0.3';
      g.selectAll('circle').filter(d => d.wikiId === wikiId).attr('display', isActive ? 'none' : null);
      item.style.opacity = isActive ? '0.3' : '1';
    };
    legendEl.appendChild(item);
  });
  document.getElementById('stats').textContent =
    '총 ' + data.length + '개 청크  ·  스크롤: 줌  ·  드래그: 이동  ·  호버: 상세';
})(_DATA);
<\/script>
</body>
</html>`;

fs.writeFileSync('public/knowledge-map.html', html);
const size = fs.statSync('public/knowledge-map.html').size;
console.log('✅ public/knowledge-map.html 생성 완료:', Math.round(size / 1024), 'KB (self-contained)');
