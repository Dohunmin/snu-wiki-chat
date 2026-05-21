import fs from 'fs';

// ── 데이터 로딩 ───────────────────────────────────────────────────────────
const points    = JSON.parse(fs.readFileSync('public/knowledge-map-data.json',      'utf-8'));
const questions = fs.existsSync('public/knowledge-map-questions.json')
  ? JSON.parse(fs.readFileSync('public/knowledge-map-questions.json', 'utf-8')) : [];

const WIKI_IDS = ['senate','board','plan','vision','history','status','yhl-speeches','finance','leesj'];
const wikiData = {};
WIKI_IDS.forEach(wid => {
  try { wikiData[wid] = JSON.parse(fs.readFileSync(`data/${wid}.json`, 'utf-8')); }
  catch { wikiData[wid] = { sources:[], topics:[], entities:[] }; }
});

// ── 위키 내 구조적 엣지: topic.sources (이 토픽이 어느 문서에서 다뤄졌나) ──
const withinEdges = [];
for (const [wid, wiki] of Object.entries(wikiData)) {
  for (const topic of wiki.topics ?? []) {
    for (const srcId of topic.sources ?? []) {
      withinEdges.push({ wikiId: wid, fromId: topic.id, toId: srcId, label: topic.name });
    }
  }
}
console.log(`위키 내 엣지 (topic→source): ${withinEdges.length}개`);

// ── 위키 간 구조적 엣지: 공통 태그 ──────────────────────────────────────
const tagIndex = {}; // tag → [{wikiId, pageId}]
for (const [wid, wiki] of Object.entries(wikiData)) {
  const addTags = (id, tags) => (tags ?? []).forEach(tag => {
    (tagIndex[tag] = tagIndex[tag] ?? []).push({ wikiId: wid, pageId: id });
  });
  (wiki.sources ?? []).forEach(s => addTags(s.id, s.tags));
  (wiki.topics  ?? []).forEach(t => addTags(t.id, t.tags));
}

const crossEdgeMap = new Map();
for (const [tag, pages] of Object.entries(tagIndex)) {
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      if (pages[i].wikiId === pages[j].wikiId) continue;
      const key = [pages[i].wikiId+'|'+pages[i].pageId, pages[j].wikiId+'|'+pages[j].pageId].sort().join('~~~');
      const e = crossEdgeMap.get(key) ?? { from: pages[i], to: pages[j], tags: [] };
      e.tags.push(tag);
      crossEdgeMap.set(key, e);
    }
  }
}
const crossEdges = [...crossEdgeMap.values()]
  .sort((a, b) => b.tags.length - a.tags.length)
  .slice(0, 40)
  .map(e => ({ fromWiki: e.from.wikiId, fromId: e.from.pageId, toWiki: e.to.wikiId, toId: e.to.pageId, sharedTags: e.tags.slice(0, 5) }));
console.log(`위키 간 엣지 (공통 태그 Top40): ${crossEdges.length}개`);
console.log('  Top3 공통 태그 엣지:');
crossEdges.slice(0,3).forEach(e => console.log(`  ${e.fromWiki}:${e.fromId} ↔ ${e.toWiki}:${e.toId} [${e.sharedTags.join(', ')}]`));

// ── 인라인 데이터 ──────────────────────────────────────────────────────────
const inlineChunks    = JSON.stringify(points);
const inlineQuestions = JSON.stringify(questions);
const inlineWithin    = JSON.stringify(withinEdges);
const inlineCross     = JSON.stringify(crossEdges);

// ── HTML 생성 ─────────────────────────────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>SNU 거버넌스 위키 — 지식 지형도</title>
<script src="https://d3js.org/d3.v7.min.js"><\/script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #f4f6f9; color: #1e293b; font-family: -apple-system, 'Malgun Gothic', sans-serif; height: 100vh; overflow: hidden; }

  #header { position: fixed; top: 0; left: 0; right: 0; z-index: 20;
    background: rgba(255,255,255,0.96); backdrop-filter: blur(10px);
    padding: 10px 20px; border-bottom: 1px solid #e2e8f0;
    display: flex; align-items: center; justify-content: space-between; }
  #header h1 { font-size: 14px; font-weight: 700; color: #0f172a; }
  #header p  { font-size: 11px; color: #94a3b8; margin-top: 1px; }
  #controls  { display: flex; align-items: center; gap: 8px; }
  .tb { background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; padding: 4px 11px; color: #64748b; font-size: 11px; cursor: pointer; transition: all .15s; white-space: nowrap; }
  .tb.on { background: #1e293b; border-color: #1e293b; color: #fff; }
  #search { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 5px 10px; color: #1e293b; font-size: 12px; width: 170px; outline: none; }
  #search:focus { border-color: #64748b; }
  #search::placeholder { color: #94a3b8; }

  #legend { position: fixed; top: 52px; right: 16px; z-index: 10;
    background: rgba(255,255,255,0.96); border: 1px solid #e2e8f0;
    border-radius: 10px; padding: 12px 14px; min-width: 158px;
    box-shadow: 0 2px 12px rgba(0,0,0,.07); }
  #legend h3 { font-size: 10px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 7px; }
  .li { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 11px; color: #334155; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
  .li:hover { background: #f1f5f9; }
  .li.dim { opacity: .25; }
  .ld { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .lc { color: #94a3b8; margin-left: auto; font-size: 10px; }

  #key { position: fixed; bottom: 16px; right: 16px; z-index: 10;
    background: rgba(255,255,255,0.96); border: 1px solid #e2e8f0;
    border-radius: 10px; padding: 12px 14px; width: 210px;
    box-shadow: 0 2px 12px rgba(0,0,0,.07); font-size: 11px; color: #334155; }
  #key b { display: block; font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }
  .kr { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }

  #tooltip { position: fixed; z-index: 30; background: #fff; border: 1px solid #e2e8f0;
    border-radius: 10px; padding: 12px 14px; max-width: 280px; pointer-events: none; display: none;
    box-shadow: 0 8px 28px rgba(0,0,0,.12); }
  .tb2 { display: inline-block; font-size: 9px; padding: 2px 7px; border-radius: 4px; margin-bottom: 7px; font-weight: 700; }
  .tt  { font-size: 13px; font-weight: 700; color: #0f172a; margin-bottom: 3px; line-height: 1.3; }
  .tm  { font-size: 10px; color: #94a3b8; margin-bottom: 8px; }
  .tp  { font-size: 11px; color: #475569; line-height: 1.6; border-top: 1px solid #f1f5f9; padding-top: 7px; }

  #stats { position: fixed; bottom: 16px; left: 16px; z-index: 10; font-size: 10px; color: #94a3b8; }
  svg { display: block; }
</style>
</head>
<body>
<div id="header">
  <div>
    <h1>SNU 거버넌스 위키 — 지식 지형도</h1>
    <p id="sub">페이지 네트워크 + 사용자 질문 · 9개 위키</p>
  </div>
  <div id="controls">
    <button class="tb on"  id="b-edges">위키 내 연결</button>
    <button class="tb on"  id="b-cross">위키 간 연결</button>
    <button class="tb on"  id="b-q">질문 레이어</button>
    <button class="tb"     id="b-chunks">청크 점</button>
    <input id="search" type="text" placeholder="검색...">
  </div>
</div>

<div id="legend">
  <h3>위키</h3>
  <div id="legend-items"></div>
</div>

<div id="key">
  <b>연결선 의미</b>
  <div class="kr">
    <svg width="28" height="10"><line x1="0" y1="5" x2="28" y2="5" stroke="#3b82f6" stroke-width="2"/><\/svg>
    <span>토픽 → 회의록 (같은 위키)</span>
  </div>
  <div class="kr">
    <svg width="28" height="10"><line x1="0" y1="5" x2="28" y2="5" stroke="#64748b" stroke-width="1.5" stroke-dasharray="4,4"/><\/svg>
    <span>공통 태그 (위키 간)</span>
  </div>
  <div style="border-top:1px solid #f1f5f9;margin:8px 0;padding-top:8px;">
    <b>사용자 질문 ◆</b>
    <div class="kr" style="margin-top:6px;">
      <svg width="14" height="14"><polygon points="7,1 13,7 7,13 1,7" fill="#000" stroke="#fff" stroke-width="1.5"/><\/svg>
      <span style="font-size:10px;color:#475569;">검정 마름모 · 호버하면 품질 표시</span>
    </div>
  </div>
  <div style="font-size:10px;color:#94a3b8;line-height:1.7;margin-top:4px;">
    원 크기 = 청크 수<br>흰 테두리 원 = 소스 문서
  </div>
</div>

<div id="tooltip">
  <div class="tb2" id="t-badge"></div>
  <div class="tt"  id="t-title"></div>
  <div class="tm"  id="t-meta"></div>
  <div class="tp"  id="t-preview"></div>
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

const CHUNKS        = ${inlineChunks};
const QUESTIONS     = ${inlineQuestions};
const WITHIN_STRUCT = ${inlineWithin};   // topic→source (wiki JSON 구조)
const CROSS_STRUCT  = ${inlineCross};    // 공통 태그 기반 위키 간 연결

(function () {
  const W = window.innerWidth, H = window.innerHeight - 44;

  // ── 섬 좌표 ──
  const wikiGroups = d3.group(CHUNKS, d => d.wikiId);
  const wikiStats  = {};
  for (const [wid, pts] of wikiGroups) {
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const mx = d3.mean(xs), my = d3.mean(ys);
    wikiStats[wid] = { cx: mx, cy: my, sx: d3.deviation(xs)||1, sy: d3.deviation(ys)||1 };
  }
  const SPREAD = 72;
  CHUNKS.forEach(d => {
    const lay = WIKI_LAYOUT[d.wikiId]||{fx:.5,fy:.5}, st = wikiStats[d.wikiId];
    d.dx = lay.fx*W + (d.x - st.cx)/st.sx * SPREAD;
    d.dy = lay.fy*H + (d.y - st.cy)/st.sy * SPREAD;
  });

  // ── 질문 섬 좌표 ──
  QUESTIONS.forEach(q => {
    q.dx = q.islandFx*W + q.dxDelta + Math.cos(q.jitterAngle||0)*(q.jitterR||0);
    q.dy = q.islandFy*H + q.dyDelta + Math.sin(q.jitterAngle||0)*(q.jitterR||0);
  });

  // ── 페이지 집약 ──
  const pageMap = new Map();
  CHUNKS.forEach(d => {
    const key = d.wikiId+'||'+d.pageId;
    if (!pageMap.has(key)) pageMap.set(key, { key, wikiId:d.wikiId, pageId:d.pageId, title:d.title, wikiLabel:d.wikiLabel, color:d.color, pageType:d.pageType, pageTypeLabel:d.pageTypeLabel, chunks:[] });
    pageMap.get(key).chunks.push(d);
  });
  const pages = [...pageMap.values()].map(p => ({
    ...p, count:p.chunks.length, r:Math.max(6,Math.sqrt(p.chunks.length)*4.2),
    ox:d3.mean(p.chunks,c=>c.x), oy:d3.mean(p.chunks,c=>c.y),
    dx:d3.mean(p.chunks,c=>c.dx), dy:d3.mean(p.chunks,c=>c.dy),
    preview:p.chunks[0].preview,
  }));

  // ── 구조적 엣지 매핑 ──
  const pageIndex = new Map(pages.map(p => [p.wikiId+'||'+p.pageId, p]));

  // 위키 내: topic → source
  const wEdgeSet = new Set(), wEdges = [];
  WITHIN_STRUCT.forEach(e => {
    const s = pageIndex.get(e.wikiId+'||'+e.fromId);
    const t = pageIndex.get(e.wikiId+'||'+e.toId);
    if (!s || !t) return;
    const k = [s.key, t.key].sort().join('~');
    if (edgeSet(wEdgeSet, k)) wEdges.push({ s, t, label: e.label });
  });

  // 위키 간: 공통 태그
  const cEdges = [];
  CROSS_STRUCT.forEach(e => {
    const s = pageIndex.get(e.fromWiki+'||'+e.fromId);
    const t = pageIndex.get(e.toWiki+'||'+e.toId);
    if (s && t) cEdges.push({ s, t, tags: e.sharedTags });
  });

  function edgeSet(set, key) {
    if (set.has(key)) return false;
    set.add(key); return true;
  }

  // ── SVG ──
  const svg  = d3.select('#canvas').attr('width',W).attr('height',H+44);
  const root = svg.append('g').attr('transform','translate(0,44)');
  svg.call(d3.zoom().scaleExtent([0.2,30]).on('zoom', e => root.attr('transform','translate(0,44) '+e.transform)));
  const tooltip = document.getElementById('tooltip');

  // ── 클러스터 배경 ──
  for (const [wid,wps] of wikiGroups) {
    const lay=WIKI_LAYOUT[wid]; if(!lay) continue;
    const cx=lay.fx*W, cy=lay.fy*H, color=wps[0].color;
    const r=SPREAD*1.55+Math.sqrt(wps.length)*2.2;
    root.append('circle').attr('cx',cx).attr('cy',cy).attr('r',r)
      .attr('fill',color).attr('fill-opacity',.07).attr('stroke',color).attr('stroke-opacity',.25).attr('stroke-width',1.5);
    root.append('text').attr('x',cx).attr('y',cy-r-7)
      .attr('text-anchor','middle').attr('font-size',12).attr('font-weight','700')
      .attr('fill',color).attr('fill-opacity',.85).text(wps[0].wikiLabel);
  }

  // ── 위키 간 엣지 (점선, 공통 태그) ──
  const cLayer=root.append('g').attr('id','ce');
  cEdges.forEach(({s,t,tags})=>{
    cLayer.append('line')
      .attr('x1',s.dx).attr('y1',s.dy).attr('x2',t.dx).attr('y2',t.dy)
      .attr('stroke','#64748b').attr('stroke-opacity',.5)
      .attr('stroke-width',1.4).attr('stroke-dasharray','5,5')
      .append('title').text(tags.join(', ')); // hover로 공통 태그 확인 가능
  });

  // ── 위키 내 엣지 (실선, topic→source) ──
  const wLayer=root.append('g').attr('id','we');
  wEdges.forEach(({s,t,label})=>{
    wLayer.append('line')
      .attr('x1',s.dx).attr('y1',s.dy).attr('x2',t.dx).attr('y2',t.dy)
      .attr('stroke',s.color).attr('stroke-opacity',.55).attr('stroke-width',1.6)
      .append('title').text(label||'');
  });

  // ── 청크 점 ──
  const chLayer=root.append('g').attr('id','ch').attr('display','none');
  chLayer.selectAll('circle').data(CHUNKS).join('circle')
    .attr('cx',d=>d.dx).attr('cy',d=>d.dy).attr('r',2.2)
    .attr('fill',d=>d.color).attr('fill-opacity',.3);

  // ── 페이지 노드 ──
  const pgLayer=root.append('g').attr('id','pg');
  const pgNodes=pgLayer.selectAll('circle').data(pages).join('circle')
    .attr('cx',d=>d.dx).attr('cy',d=>d.dy).attr('r',d=>d.r)
    .attr('fill',d=>d.color).attr('fill-opacity',.88)
    .attr('stroke','#fff').attr('stroke-width',d=>d.pageType==='source'?2:.8).attr('stroke-opacity',.9)
    .style('cursor','pointer')
    .on('mouseover',function(e,d){
      d3.select(this).raise().attr('r',d.r*1.5).attr('stroke-width',2.5);
      document.getElementById('t-badge').textContent=d.wikiLabel+'  ·  '+d.pageTypeLabel;
      document.getElementById('t-badge').style.background=d.color+'22'; document.getElementById('t-badge').style.color=d.color;
      document.getElementById('t-title').textContent=d.title||d.pageId;
      document.getElementById('t-meta').textContent='청크 '+d.count+'개  ·  '+d.pageId;
      document.getElementById('t-preview').textContent=d.preview;
      tooltip.style.display='block';
    })
    .on('mousemove',e=>{ const x=e.clientX+16,y=e.clientY+16; tooltip.style.left=(x+280>W?x-296:x)+'px'; tooltip.style.top=(y+160>window.innerHeight?y-160:y)+'px'; })
    .on('mouseout',function(e,d){ d3.select(this).attr('r',d.r).attr('stroke-width',d.pageType==='source'?2:.8); tooltip.style.display='none'; });

  // ── 질문 레이어 (검정 마름모) ──
  const Q_LABEL = { answered:'잘 답변됨', partial:'부분 답변', no_data:'관련 자료 없음' };
  const QSIZE = 13;
  const diamond = (cx,cy,r) => \`\${cx},\${cy-r} \${cx+r},\${cy} \${cx},\${cy+r} \${cx-r},\${cy}\`;

  const qLayer=root.append('g').attr('id','ql');
  const qNodes=qLayer.selectAll('polygon').data(QUESTIONS).join('polygon')
    .attr('points',d=>diamond(d.dx,d.dy,QSIZE))
    .attr('fill','#000000').attr('stroke','#fff').attr('stroke-width',2).attr('fill-opacity',.88)
    .style('cursor','pointer')
    .on('mouseover',function(e,d){
      d3.select(this).raise().attr('points',diamond(d.dx,d.dy,QSIZE*1.8)).attr('fill-opacity',1);
      document.getElementById('t-badge').textContent=d.wikiLabel+'  ·  사용자 질문';
      document.getElementById('t-badge').style.background='#f1f5f9'; document.getElementById('t-badge').style.color='#374151';
      document.getElementById('t-title').textContent=d.question;
      document.getElementById('t-meta').textContent=Q_LABEL[d.quality]||'';
      document.getElementById('t-preview').textContent='';
      tooltip.style.display='block';
    })
    .on('mousemove',e=>{ const x=e.clientX+16,y=e.clientY+16; tooltip.style.left=(x+280>W?x-296:x)+'px'; tooltip.style.top=(y+120>window.innerHeight?y-120:y)+'px'; })
    .on('mouseout',function(e,d){ d3.select(this).attr('points',diamond(d.dx,d.dy,QSIZE)).attr('fill-opacity',.88); tooltip.style.display='none'; });

  // ── 범례 ──
  const hidden=new Set();
  const lgEl=document.getElementById('legend-items');
  for (const [wid,wps] of wikiGroups) {
    const wp=pages.filter(p=>p.wikiId===wid);
    const item=document.createElement('div'); item.className='li';
    item.innerHTML='<span class="ld" style="background:'+wps[0].color+'"></span><span>'+wps[0].wikiLabel+'</span><span class="lc">'+wp.length+'p</span>';
    item.onclick=()=>{
      hidden.has(wid)?hidden.delete(wid):hidden.add(wid);
      item.classList.toggle('dim',hidden.has(wid));
      pgNodes.attr('display',d=>hidden.has(d.wikiId)?'none':null);
      wLayer.selectAll('line').attr('display',e=>hidden.has(e.s.wikiId)?'none':null);
      qNodes.attr('display',d=>hidden.has(d.nearestWiki)?'none':null);
    };
    lgEl.appendChild(item);
  }

  // ── 토글 ──
  const tog=(id,layer,state)=>{ let on=state; document.getElementById(id).onclick=function(){ on=!on; this.classList.toggle('on',on); layer.attr('display',on?null:'none'); }; };
  tog('b-edges',wLayer,true);
  tog('b-cross',cLayer,true);
  tog('b-q',qLayer,true);
  tog('b-chunks',chLayer,false);

  // ── 검색 ──
  document.getElementById('search').addEventListener('input',function(){
    const q=this.value.trim().toLowerCase();
    if(!q){ pgNodes.attr('fill-opacity',.88).attr('r',d=>d.r); qNodes.attr('fill-opacity',.88); return; }
    pgNodes.attr('fill-opacity',d=>((d.title||'').toLowerCase().includes(q)||d.preview.toLowerCase().includes(q))?1:.06)
           .attr('r',d=>((d.title||'').toLowerCase().includes(q)||d.preview.toLowerCase().includes(q))?d.r*1.8:d.r);
    qNodes.attr('fill-opacity',d=>d.question.toLowerCase().includes(q)?1:.06);
  });

  const wikiCount = [...new Set(CHUNKS.map(d=>d.wikiId))].length;
  document.getElementById('stats').textContent =
    '페이지 '+pages.length+'개  ·  질문 '+QUESTIONS.length+'개  ·  위키 내 연결 '+wEdges.length+'개  ·  위키 간 연결 '+cEdges.length+'개';
  document.getElementById('sub').textContent =
    'topic→source 구조 기반 · '+pages.length+'p · '+wikiCount+'개 위키';
})();
<\/script>
</body>
</html>`;

fs.writeFileSync('public/knowledge-map.html', html);
const size = fs.statSync('public/knowledge-map.html').size;
console.log(`✅ knowledge-map.html 생성 완료: ${Math.round(size/1024)} KB`);
