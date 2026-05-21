import fs from 'fs';

const points    = JSON.parse(fs.readFileSync('public/knowledge-map-data.json', 'utf-8'));
const questions = fs.existsSync('public/knowledge-map-questions.json')
  ? JSON.parse(fs.readFileSync('public/knowledge-map-questions.json', 'utf-8'))
  : [];

const inlineChunks    = JSON.stringify(points);
const inlineQuestions = JSON.stringify(questions);

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
    background: rgba(255,255,255,0.96); backdrop-filter: blur(10px);
    padding: 10px 20px; border-bottom: 1px solid #e2e8f0;
    display: flex; align-items: center; justify-content: space-between;
  }
  #header h1 { font-size: 14px; font-weight: 700; color: #0f172a; }
  #header p  { font-size: 11px; color: #94a3b8; margin-top: 1px; }
  #controls  { display: flex; align-items: center; gap: 8px; }
  .tb { background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px; padding: 4px 11px; color: #64748b; font-size: 11px; cursor: pointer; transition: all .15s; white-space: nowrap; }
  .tb.on { background: #1e293b; border-color: #1e293b; color: #fff; }
  #search { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 5px 10px; color: #1e293b; font-size: 12px; width: 170px; outline: none; }
  #search:focus { border-color: #64748b; }
  #search::placeholder { color: #94a3b8; }

  #legend { position: fixed; top: 52px; right: 16px; z-index: 10; background: rgba(255,255,255,0.96); border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; min-width: 158px; box-shadow: 0 2px 12px rgba(0,0,0,.07); }
  #legend h3 { font-size: 10px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 7px; }
  .li { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 11px; color: #334155; cursor: pointer; padding: 2px 4px; border-radius: 4px; }
  .li:hover { background: #f1f5f9; }
  .li.dim { opacity: .25; }
  .ld { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .lc { color: #94a3b8; margin-left: auto; font-size: 10px; }

  #key { position: fixed; bottom: 16px; right: 16px; z-index: 10; background: rgba(255,255,255,0.96); border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; width: 200px; box-shadow: 0 2px 12px rgba(0,0,0,.07); font-size: 11px; color: #334155; }
  #key b { display: block; font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }
  .kr { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .q-dot { width: 11px; height: 11px; transform: rotate(45deg); flex-shrink: 0; }

  /* 질문 품질 색상 */
  .q-answered { fill: #22c55e; stroke: #fff; stroke-width: 1.5; }
  .q-partial   { fill: #f59e0b; stroke: #fff; stroke-width: 1.5; }
  .q-no_data   { fill: #ef4444; stroke: #fff; stroke-width: 1.5; }

  #gap-bar { position: fixed; bottom: 16px; left: 16px; z-index: 10; background: rgba(255,255,255,0.96); border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; min-width: 240px; box-shadow: 0 2px 12px rgba(0,0,0,.07); font-size: 11px; }
  #gap-bar b { font-size: 10px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: .06em; display: block; margin-bottom: 8px; }
  .gap-row { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; }
  .gap-wiki { font-size: 11px; color: #334155; flex: 1; }
  .gap-bar-inner { height: 6px; border-radius: 3px; min-width: 4px; }
  .gap-label { font-size: 10px; color: #94a3b8; white-space: nowrap; }

  #tooltip { position: fixed; z-index: 30; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px 14px; max-width: 270px; pointer-events: none; display: none; box-shadow: 0 8px 28px rgba(0,0,0,.12); }
  .tb2  { display: inline-block; font-size: 9px; padding: 2px 7px; border-radius: 4px; margin-bottom: 7px; font-weight: 700; }
  .tt   { font-size: 13px; font-weight: 700; color: #0f172a; margin-bottom: 3px; line-height: 1.3; }
  .tm   { font-size: 10px; color: #94a3b8; margin-bottom: 8px; }
  .tp   { font-size: 11px; color: #475569; line-height: 1.6; border-top: 1px solid #f1f5f9; padding-top: 7px; }
  svg { display: block; }
</style>
</head>
<body>
<div id="header">
  <div>
    <h1>SNU 거버넌스 위키 — 지식 지형도</h1>
    <p id="sub">페이지 네트워크 + 사용자 질문 레이어 · 9개 위키</p>
  </div>
  <div id="controls">
    <button class="tb on"  id="b-edges">연결선</button>
    <button class="tb on"  id="b-cross">위키간</button>
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
  <b>범례</b>
  <div class="kr"><svg width="28" height="10"><line x1="0" y1="5" x2="28" y2="5" stroke="#3b82f6" stroke-width="2"/><\/svg><span>위키 내 유사 페이지</span></div>
  <div class="kr"><svg width="28" height="10"><line x1="0" y1="5" x2="28" y2="5" stroke="#64748b" stroke-width="1.5" stroke-dasharray="4,4"/><\/svg><span>위키 간 내용 유사</span></div>
  <div style="border-top:1px solid #f1f5f9;margin:8px 0;"></div>
  <div class="kr"><svg width="11" height="11"><rect x="1" y="1" width="9" height="9" transform="rotate(45 5.5 5.5)" fill="#22c55e" stroke="#fff" stroke-width="1.5"/><\/svg><span>잘 답변된 질문</span></div>
  <div class="kr"><svg width="11" height="11"><rect x="1" y="1" width="9" height="9" transform="rotate(45 5.5 5.5)" fill="#f59e0b" stroke="#fff" stroke-width="1.5"/><\/svg><span>부분 답변</span></div>
  <div class="kr"><svg width="11" height="11"><rect x="1" y="1" width="9" height="9" transform="rotate(45 5.5 5.5)" fill="#ef4444" stroke="#fff" stroke-width="1.5"/><\/svg><span>자료 없음 응답</span></div>
  <div style="margin-top:8px;border-top:1px solid #f1f5f9;padding-top:8px;color:#94a3b8;font-size:10px;line-height:1.7;">
    원 크기 = 청크 수 (문서 분량)<br>마름모 = 사용자 질문
  </div>
</div>

<div id="gap-bar">
  <b>위키별 질문 밀도 vs 콘텐츠 밀도</b>
  <div id="gap-rows"></div>
  <div style="font-size:10px;color:#94a3b8;margin-top:6px;">
    막대 = 질문수/청크수 비율 · 빨간색 = 콘텐츠 부족 영역
  </div>
</div>

<div id="tooltip">
  <div class="tb2" id="t-badge"></div>
  <div class="tt" id="t-title"></div>
  <div class="tm" id="t-meta"></div>
  <div class="tp" id="t-preview"></div>
</div>
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

const CHUNKS    = ${inlineChunks};
const QUESTIONS = ${inlineQuestions};

(function () {
  const W = window.innerWidth, H = window.innerHeight - 44;

  // ── 섬 좌표 (청크) ──
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
    q.dx = q.islandFx * W + q.dxDelta;
    q.dy = q.islandFy * H + q.dyDelta;
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

  // ── 위키 내 엣지 (k=2) ──
  const edgeSet=new Set(), wEdges=[];
  for (const [,wps] of d3.group(pages,p=>p.wikiId)) {
    for (const p of wps) {
      wps.filter(q=>q!==p)
        .sort((a,b)=>Math.hypot(a.dx-p.dx,a.dy-p.dy)-Math.hypot(b.dx-p.dx,b.dy-p.dy))
        .slice(0,2).forEach(q=>{
          const ek=[p.key,q.key].sort().join('~');
          if (!edgeSet.has(ek)){edgeSet.add(ek);wEdges.push({s:p,t:q});}
        });
    }
  }

  // ── 위키 간 엣지 (상위 20) ──
  const cPairs=[];
  for (let i=0;i<pages.length;i++) for (let j=i+1;j<pages.length;j++)
    if (pages[i].wikiId!==pages[j].wikiId)
      cPairs.push({s:pages[i],t:pages[j],dist:Math.hypot(pages[i].ox-pages[j].ox,pages[i].oy-pages[j].oy)});
  cPairs.sort((a,b)=>a.dist-b.dist);
  const cEdges=cPairs.slice(0,20);

  // ── SVG ──
  const svg  = d3.select('#canvas').attr('width',W).attr('height',H+44);
  const root = svg.append('g').attr('transform','translate(0,44)');
  svg.call(d3.zoom().scaleExtent([0.2,30]).on('zoom',e=>root.attr('transform','translate(0,44) '+e.transform)));
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

  // ── 위키 간 엣지 (점선) ──
  const cLayer=root.append('g').attr('id','ce');
  cEdges.forEach(({s,t})=>cLayer.append('line').attr('x1',s.dx).attr('y1',s.dy).attr('x2',t.dx).attr('y2',t.dy)
    .attr('stroke','#64748b').attr('stroke-opacity',.45).attr('stroke-width',1.4).attr('stroke-dasharray','5,5'));

  // ── 위키 내 엣지 (실선) ──
  const wLayer=root.append('g').attr('id','we');
  wEdges.forEach(({s,t})=>wLayer.append('line').attr('x1',s.dx).attr('y1',s.dy).attr('x2',t.dx).attr('y2',t.dy)
    .attr('stroke',s.color).attr('stroke-opacity',.55).attr('stroke-width',1.6));

  // ── 청크 점 (숨김) ──
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
    .on('mousemove',e=>{
      const x=e.clientX+16, y=e.clientY+16;
      tooltip.style.left=(x+270>W?x-286:x)+'px'; tooltip.style.top=(y+160>window.innerHeight?y-160:y)+'px';
    })
    .on('mouseout',function(e,d){ d3.select(this).attr('r',d.r).attr('stroke-width',d.pageType==='source'?2:.8); tooltip.style.display='none'; });

  // ── 질문 레이어 (마름모) ──
  const qLayer=root.append('g').attr('id','ql');
  const Q_COLOR = { answered:'#22c55e', partial:'#f59e0b', no_data:'#ef4444' };
  const qSize = 8; // 마름모 반크기
  const qNodes=qLayer.selectAll('rect').data(QUESTIONS).join('rect')
    .attr('x', d=>d.dx - qSize/2).attr('y', d=>d.dy - qSize/2)
    .attr('width', qSize).attr('height', qSize)
    .attr('transform', d=>\`rotate(45 \${d.dx} \${d.dy})\`)
    .attr('fill', d=>Q_COLOR[d.quality]||'#94a3b8')
    .attr('stroke','#fff').attr('stroke-width',1.5).attr('fill-opacity',.9)
    .style('cursor','pointer')
    .on('mouseover',function(e,d){
      d3.select(this).raise().attr('width',qSize*2).attr('height',qSize*2)
        .attr('x',d.dx-qSize).attr('y',d.dy-qSize).attr('transform',\`rotate(45 \${d.dx} \${d.dy})\`);
      const qLabel={answered:'✅ 잘 답변됨',partial:'⚠️ 부분 답변',no_data:'❌ 자료 없음'};
      document.getElementById('t-badge').textContent=d.wikiLabel+'  ·  질문';
      document.getElementById('t-badge').style.background=(Q_COLOR[d.quality]||'#94a3b8')+'22';
      document.getElementById('t-badge').style.color=Q_COLOR[d.quality]||'#94a3b8';
      document.getElementById('t-title').textContent=d.question;
      document.getElementById('t-meta').textContent=qLabel[d.quality]+(d.routedAgents?.length?' · 라우팅: '+d.routedAgents.join(', '):'');
      document.getElementById('t-preview').textContent='';
      tooltip.style.display='block';
    })
    .on('mousemove',e=>{
      const x=e.clientX+16, y=e.clientY+16;
      tooltip.style.left=(x+270>W?x-286:x)+'px'; tooltip.style.top=(y+120>window.innerHeight?y-120:y)+'px';
    })
    .on('mouseout',function(e,d){
      d3.select(this).attr('width',qSize).attr('height',qSize).attr('x',d.dx-qSize/2).attr('y',d.dy-qSize/2).attr('transform',\`rotate(45 \${d.dx} \${d.dy})\`);
      tooltip.style.display='none';
    });

  // ── 위키별 갭 분석 바 ──
  const wikiQCounts={};
  QUESTIONS.forEach(q=>{ wikiQCounts[q.nearestWiki]=(wikiQCounts[q.nearestWiki]||0)+1; });
  const wikiChunkCounts={};
  CHUNKS.forEach(c=>{ wikiChunkCounts[c.wikiId]=(wikiChunkCounts[c.wikiId]||0)+1; });

  const totalQ=QUESTIONS.length||1;
  const totalC=CHUNKS.length||1;
  const gapRows=document.getElementById('gap-rows');
  const wikiIds=[...new Set(CHUNKS.map(d=>d.wikiId))];
  // 갭 점수 = (질문비율 / 청크비율) — 1보다 크면 콘텐츠 부족
  const gapData=wikiIds.map(wid=>{
    const qr=(wikiQCounts[wid]||0)/totalQ;
    const cr=(wikiChunkCounts[wid]||1)/totalC;
    return { wid, label:CHUNKS.find(d=>d.wikiId===wid)?.wikiLabel||wid, color:CHUNKS.find(d=>d.wikiId===wid)?.color||'#999', qr, cr, gap:qr/cr };
  }).sort((a,b)=>b.gap-a.gap);

  const maxGap=Math.max(...gapData.map(d=>d.gap));
  gapData.forEach(({wid,label,color,qr,cr,gap})=>{
    const pct=Math.round(gap/maxGap*100);
    const barColor=gap>1.5?'#ef4444':gap>0.8?'#f59e0b':'#22c55e';
    const row=document.createElement('div'); row.className='gap-row';
    row.innerHTML=
      '<span class="gap-wiki">'+label+'</span>'+
      '<div style="width:80px;background:#f1f5f9;border-radius:3px;height:6px;">'+
        '<div class="gap-bar-inner" style="width:'+pct+'%;background:'+barColor+'"></div>'+
      '</div>'+
      '<span class="gap-label">Q'+Math.round(qr*100)+'% C'+Math.round(cr*100)+'%</span>';
    gapRows.appendChild(row);
  });

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
  const tog=(id,layer,state)=>{
    let on=state;
    document.getElementById(id).onclick=function(){ on=!on; this.classList.toggle('on',on); layer.attr('display',on?null:'none'); };
  };
  tog('b-edges',wLayer,true);
  tog('b-cross',cLayer,true);
  tog('b-q',qLayer,true);
  tog('b-chunks',chLayer,false);

  // ── 검색 ──
  document.getElementById('search').addEventListener('input',function(){
    const q=this.value.trim().toLowerCase();
    if(!q){ pgNodes.attr('fill-opacity',.88).attr('r',d=>d.r); qNodes.attr('fill-opacity',.9); return; }
    pgNodes.attr('fill-opacity',d=>((d.title||'').toLowerCase().includes(q)||d.preview.toLowerCase().includes(q))?1:.06)
           .attr('r',d=>((d.title||'').toLowerCase().includes(q)||d.preview.toLowerCase().includes(q))?d.r*1.8:d.r);
    qNodes.attr('fill-opacity',d=>d.question.toLowerCase().includes(q)?1:.06);
  });

  document.getElementById('sub').textContent=
    '페이지 '+pages.length+'개 · 질문 '+QUESTIONS.length+'개 · 9개 위키';
})();
<\/script>
</body>
</html>`;

fs.writeFileSync('public/knowledge-map.html', html);
const size = fs.statSync('public/knowledge-map.html').size;
console.log('✅ knowledge-map.html 생성 완료:', Math.round(size / 1024), 'KB');
console.log('   Layer 1: 페이지 노드 + 연결선');
console.log('   Layer 2: 질문 마름모 (초록/노랑/빨강)');
console.log('   Layer 3: 위키별 갭 분석 바');
