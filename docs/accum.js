/* 여러 시야를 누적해 하나의 데이터셋으로 모으는 모듈.
   저장은 claude.ai 안에서는 아티팩트 DB, 밖(예: GitHub Pages)에서는 브라우저 저장으로
   자동 전환된다. 같은 파일 하나가 양쪽에서 돌아가도록 하는 게 목적. */
(function(){
"use strict";
var A = window.APP;
if (!A) return;

var LS_KEY = "sem-particle-fields-v1";
var FIELDS = [];
var Store = {
  mode: "local",   // "db" | "local"
  db: null,
  async init(){
    var db = await A.useCap("db");
    if (db){ this.db = db; this.mode = "db"; }
    return this.mode;
  },
  async list(){
    if (this.mode === "db"){
      var snap = await this.db.collection("fields").get();
      return snap.docs.map(function(d){
        var v = d.data() || {};
        v.id = d.id;
        return v;
      });
    }
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
    catch(e){ return []; }
  },
  async put(rec){
    if (this.mode === "db"){
      var body = {};
      for (var k in rec) if (k !== "id") body[k] = rec[k];
      await this.db.collection("fields").doc(rec.id).set(body);
      return;
    }
    var all = await this.list();
    var i = all.findIndex(function(f){ return f.id === rec.id; });
    if (i >= 0) all[i] = rec; else all.push(rec);
    this._writeLocal(all);
  },
  async remove(id){
    if (this.mode === "db"){ await this.db.collection("fields").doc(id).delete(); return; }
    var all = (await this.list()).filter(function(f){ return f.id !== id; });
    this._writeLocal(all);
  },
  async clearAll(){
    if (this.mode === "db"){
      var all = await this.list();
      for (var i=0;i<all.length;i++) await this.db.collection("fields").doc(all[i].id).delete();
      return;
    }
    this._writeLocal([]);
  },
  _writeLocal(all){
    try { localStorage.setItem(LS_KEY, JSON.stringify(all)); }
    catch(e){ msg("브라우저 저장 공간이 찼습니다. 누적 CSV로 내보낸 뒤 오래된 시야를 지워 주세요.", "bad"); }
  }
};

/* ---------- 레코드 만들기 ---------- */
var SRC_CODE = {"맵":"map", "지점":"point"};
function buildRecord(name){
  var S = A.S;
  if (!S.result || !S.result.props.length) return null;
  var rows = A.unifiedRows();
  var elSet = {};
  rows.forEach(function(r){ if (r.comp) for (var k in r.comp.raw) elSet[k]=1; });
  var els = Object.keys(elSet);
  var out = rows.map(function(r){
    var base = [
      r.p.id, A.CLS.indexOf(r.p.cls),
      round(r.p.eqd,3), round(r.p.feret,3), r.p.area, round(r.p.perim,3),
      round(r.p.circ,4), round(r.p.sol,4), round(r.p.ar,4),
      r.comp ? (SRC_CODE[r.src]||"") : "",
      r.v1 ? (r.v1.indexOf("Fe")===0?"Fe":r.v1.indexOf("Al")===0?"Al":r.v1.indexOf("Ti")===0?"Ti":"none") : "",
      r.v2 ? A.CLS2.indexOf(r.v2) : -1
    ];
    els.forEach(function(e){
      base.push(r.comp && r.comp.raw[e] != null ? round(Number(r.comp.raw[e]),3) : "");
    });
    return base;
  });
  var thumb = "";
  try {
    var c = document.getElementById("s-canvas");
    var t = document.createElement("canvas");
    var w = 160, h = Math.max(1, Math.round(c.height * w / c.width));
    t.width = w; t.height = h;
    t.getContext("2d").drawImage(c, 0, 0, w, h);
    thumb = t.toDataURL("image/jpeg", 0.55);
  } catch(e){}
  return {
    id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    name: name,
    imageName: S.imgName,
    isExample: !!S.isExample,
    savedAt: new Date().toISOString(),
    umPerPx: S.umPerPx,
    settings: {sigma:S.sigma, minArea:S.minArea, splitFrac:S.splitFrac,
               ar:S.ar, sol:S.sol, circ:S.circ, arsph:S.arsph},
    thumb: thumb,
    els: els,
    rows: out
  };
}
function round(v, d){ var m=Math.pow(10,d); return Math.round(Number(v)*m)/m; }

/* 레코드 한 줄 → 다루기 쉬운 객체 */
function readRow(rec, row){
  var o = {
    field: rec.name, fieldId: rec.id, umPerPx: rec.umPerPx,
    id: row[0], cls: A.CLS[row[1]] || "불규칙",
    eqd: row[2], feret: row[3], area: row[4], perim: row[5],
    circ: row[6], sol: row[7], ar: row[8],
    src: row[9], v1: row[10], v2: row[11] >= 0 ? A.CLS2[row[11]] : null,
    comp: {}
  };
  (rec.els||[]).forEach(function(e,i){
    var v = row[12+i];
    if (v !== "" && v != null) o.comp[e] = Number(v);
  });
  return o;
}
function allRows(){
  var out = [];
  FIELDS.forEach(function(rec){ (rec.rows||[]).forEach(function(r){ out.push(readRow(rec, r)); }); });
  return out;
}

/* ---------- 저장/삭제 ---------- */
function msg(html, kind){
  var host = document.getElementById("d-store-msg");
  if (!host) return;
  host.innerHTML = html
    ? '<div class="callout" style="border-left-color:'+(kind==="bad"?"var(--critical)":"var(--accent)")+'">'+html+'</div>'
    : "";
}
function saveState(t){
  var el = document.getElementById("s-save-state");
  if (el) el.innerHTML = t;
}
async function saveCurrent(){
  var S = A.S;
  if (!S.result || !S.result.props.length){ saveState("저장할 분석 결과가 없습니다."); return; }
  var base = (S.imgName || "시야").replace(/\.[^.]+$/,"");
  var name = base;
  var n = 2;
  while (FIELDS.some(function(f){ return f.name === name; })) name = base + " (" + (n++) + ")";
  var rec = buildRecord(name);
  if (!rec) return;
  saveState('<span class="mono">저장 중…</span>');
  try {
    await Store.put(rec);
    FIELDS = await Store.list();
    saveState('<span class="flag ok">저장됨</span> ' + A.esc(name) + ' · 입자 ' + rec.rows.length + '개' +
      (S.isExample ? ' <span class="flag warn">합성 예제</span>' : '') +
      (S.umPerPx == null ? ' <span class="flag warn">스케일 미보정</span>' : ''));
    render();
  } catch(e){
    saveState('<span class="flag bad">저장 실패</span> ' + A.esc(String(e && e.message || e)));
  }
}

/* ---------- 통계 ---------- */
function unitInfo(){
  var cal = FIELDS.filter(function(f){ return f.umPerPx != null; }).length;
  if (!FIELDS.length) return {unit:"px", k:function(){return 1;}, mixed:false, allCal:false};
  var allCal = cal === FIELDS.length;
  return {
    unit: allCal ? "µm" : "px",
    allCal: allCal,
    mixed: cal > 0 && !allCal,
    k: function(r){ return allCal && r.umPerPx ? r.umPerPx : 1; }
  };
}
function otsu1d(vals){
  if (vals.length < 8) return null;
  var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
  if (!(hi > lo)) return null;
  var B = 64, hist = new Array(B).fill(0), i;
  vals.forEach(function(v){
    var b = Math.min(B-1, Math.floor((v-lo)/(hi-lo)*B));
    hist[b]++;
  });
  var total = vals.length, sumAll = 0;
  for (i=0;i<B;i++) sumAll += i*hist[i];
  var wB=0, sumB=0, best=-1, bestVar=-1;
  for (i=0;i<B;i++){
    wB += hist[i];
    if (!wB) continue;
    var wF = total - wB;
    if (!wF) break;
    sumB += i*hist[i];
    var mB = sumB/wB, mF = (sumAll-sumB)/wF;
    var between = wB*wF*(mB-mF)*(mB-mF);
    if (between > bestVar){ bestVar = between; best = i; }
  }
  if (best < 0) return null;
  return lo + (best+1)/B*(hi-lo);
}

/* ---------- 렌더 ---------- */
function render(){
  if (!document.getElementById("d-kpis")) return;
  var rows = allRows();
  var u = unitInfo();
  var withComp = rows.filter(function(r){ return r.v2; });
  var diams = rows.map(function(r){ return r.eqd * u.k(r); });
  var mean = diams.length ? diams.reduce(function(a,b){return a+b},0)/diams.length : 0;

  document.getElementById("d-store-note").textContent =
    (Store.mode === "db" ? "아티팩트 DB에 저장 — 같은 조직 팀원과 공유됨" : "이 브라우저에 저장 — 기기 간에는 CSV로 옮기세요");

  document.getElementById("d-kpis").innerHTML =
    A.kpiHTML("시야", A.fmt(FIELDS.length), "장", FIELDS.length ? "누적 데이터셋" : "아직 저장 없음") +
    A.kpiHTML("총 입자", A.fmt(rows.length), "개", withComp.length ? "조성 있는 입자 " + withComp.length + "개" : "조성 없음") +
    A.kpiHTML("평균 지름", rows.length ? mean.toFixed(u.unit==="px"?1:2) : "—", u.unit,
              u.mixed ? "일부 시야 미보정 → px 기준" : (u.allCal ? "전 시야 보정됨" : "스케일 미보정")) +
    A.kpiHTML("시야당 평균", FIELDS.length ? (rows.length/FIELDS.length).toFixed(1) : "—", "개", "입자 수");

  renderFieldList();
  renderHist(rows, u);
  renderByField();
  renderCross(withComp);
  renderSuggest(rows);
}

function renderFieldList(){
  var host = document.getElementById("d-fields");
  if (!FIELDS.length){
    host.innerHTML = '<p style="font-size:12.5px;color:var(--ink-3)">아직 저장된 시야가 없습니다. 형상 탭에서 사진을 분석한 뒤 <b>이 시야를 누적에 저장</b>을 누르세요. 조성까지 붙인 상태로 저장하면 조성도 함께 쌓입니다.</p>';
    return;
  }
  var sorted = FIELDS.slice().sort(function(a,b){ return (a.savedAt||"") < (b.savedAt||"") ? 1 : -1; });
  host.innerHTML = '<div style="display:flex;flex-direction:column;gap:8px">' + sorted.map(function(f){
    var n = (f.rows||[]).length;
    var comp = (f.rows||[]).filter(function(r){ return r[9]; }).length;
    var d = f.savedAt ? new Date(f.savedAt) : null;
    return '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;border:1px solid var(--line);border-radius:5px;padding:9px 11px;background:var(--surface-2)">' +
      (f.thumb ? '<img src="'+f.thumb+'" alt="" style="width:64px;height:auto;border-radius:3px;border:1px solid var(--line-2);flex:none">' : '') +
      '<div style="flex:1;min-width:150px">' +
        '<div style="font-size:13px;font-weight:500">' + A.esc(f.name) +
          (f.isExample ? ' <span class="flag warn">합성 예제</span>' : '') +
          (f.umPerPx == null ? ' <span class="flag warn">미보정</span>' : '') + '</div>' +
        '<div class="mono" style="font-size:11px;color:var(--ink-3)">' +
          '입자 ' + n + '개' + (comp ? ' · 조성 ' + comp + '개' : '') +
          (f.umPerPx != null ? ' · ' + (f.umPerPx*1000).toFixed(1) + ' nm/px' : '') +
          (d ? ' · ' + d.toLocaleString("ko-KR") : '') + '</div>' +
      '</div>' +
      '<button class="btn d-del" data-id="'+f.id+'" type="button" style="padding:4px 9px">삭제</button>' +
    '</div>';
  }).join("") + '</div>';
  host.querySelectorAll(".d-del").forEach(function(b){
    b.addEventListener("click", async function(){
      await Store.remove(b.dataset.id);
      FIELDS = await Store.list();
      render();
    });
  });
}

function renderHist(rows, u){
  var host = document.getElementById("d-hist");
  host.innerHTML = "";
  document.getElementById("d-hist-note").textContent = "등가원 지름 (" + u.unit + ")" + (u.mixed ? " · 혼재" : "");
  if (!rows.length){ host.innerHTML = '<p style="font-size:12px;color:var(--ink-3)">저장된 입자가 없습니다.</p>'; return; }
  var vals = rows.map(function(r){ return r.eqd * u.k(r); });
  var W=460,H=210,padL=40,padR=12,padT=12,padB=34;
  var pw=W-padL-padR, ph=H-padT-padB;
  var hi=Math.max.apply(null,vals)*1.02, lo=0;
  var bins=Math.min(34,Math.max(10,Math.ceil(Math.sqrt(vals.length))));
  var cnt=new Array(bins).fill(0);
  vals.forEach(function(v){ cnt[Math.min(bins-1,Math.floor((v-lo)/(hi-lo)*bins))]++; });
  var mx=Math.max.apply(null,cnt);
  var X=function(v){return padL+(v-lo)/(hi-lo)*pw}, Y=function(v){return padT+ph-v/mx*ph};
  var svg=A.el("svg",{viewBox:"0 0 "+W+" "+H,width:"100%",role:"img"});
  [0,.5,1].forEach(function(f){
    var y=padT+ph-f*ph;
    svg.appendChild(A.el("line",{x1:padL,x2:W-padR,y1:y,y2:y,stroke:A.cssv("--grid")}));
    svg.appendChild(A.el("text",{x:padL-7,y:y+3.5,"text-anchor":"end","font-size":"9.5",fill:A.cssv("--ink-3")},[A.txt(String(Math.round(mx*f)))]));
  });
  var bw=pw/bins;
  cnt.forEach(function(c,i){
    if(!c) return;
    var v0=lo+i*(hi-lo)/bins, v1=v0+(hi-lo)/bins;
    var r=A.el("rect",{x:X(v0)+0.5,y:Y(c),width:Math.max(bw-2,1),height:padT+ph-Y(c),fill:A.cssv("--s1"),rx:1.5});
    r.style.cursor="crosshair";
    A.bindTip(r,function(){ return v0.toFixed(1)+'–'+v1.toFixed(1)+' '+u.unit+'<br><span class="hl">'+c+'개</span>'; });
    svg.appendChild(r);
  });
  svg.appendChild(A.el("line",{x1:padL,x2:W-padR,y1:padT+ph,y2:padT+ph,stroke:A.cssv("--line-2")}));
  [0,.25,.5,.75,1].forEach(function(f){
    var v=lo+f*(hi-lo);
    svg.appendChild(A.el("text",{x:X(v),y:H-16,"text-anchor":"middle","font-size":"9.5",fill:A.cssv("--ink-3")},[A.txt(v.toFixed(v<10?1:0))]));
  });
  var sorted = vals.slice().sort(function(a,b){return a-b});
  var med = sorted[Math.floor(sorted.length/2)];
  svg.appendChild(A.el("text",{x:padL,y:H-3,"font-size":"9.5",fill:A.cssv("--ink-3")},
    [A.txt("중앙 "+med.toFixed(2)+" "+u.unit+" · n="+vals.length+" · 시야 "+FIELDS.length+"장")]));
  host.appendChild(svg);
  if (u.mixed){
    host.appendChild(Object.assign(document.createElement("div"), {
      className:"callout",
      style:"margin-top:12px;border-left-color:var(--serious)",
      innerHTML:"보정된 시야와 미보정 시야가 섞여 있어 px 기준으로 합산했습니다. 배율이 다른 시야를 이렇게 합치면 크기 분포가 왜곡됩니다 — 시야마다 스케일을 보정한 뒤 다시 저장하세요."
    }));
  }
}

function renderByField(){
  var host = document.getElementById("d-byfield");
  host.innerHTML = "";
  if (!FIELDS.length){ host.innerHTML = '<p style="font-size:12px;color:var(--ink-3)">저장된 시야가 없습니다.</p>'; return; }
  var sorted = FIELDS.slice().sort(function(a,b){ return (a.savedAt||"") < (b.savedAt||"") ? 1 : -1; });
  var maxN = Math.max.apply(null, sorted.map(function(f){ return (f.rows||[]).length; })) || 1;
  var W=460, rowH=24, gap=9, padL=96, padR=34;
  var H=sorted.length*(rowH+gap)-gap+12;
  var svg=A.el("svg",{viewBox:"0 0 "+W+" "+H,width:"100%",role:"img"});
  var plotW=W-padL-padR;
  sorted.forEach(function(f,i){
    var y=i*(rowH+gap);
    var counts={};
    A.CLS.forEach(function(c){ counts[c]=0; });
    (f.rows||[]).forEach(function(r){ counts[A.CLS[r[1]]||"불규칙"]++; });
    var tot=(f.rows||[]).length;
    var short = f.name.length>12 ? f.name.slice(0,11)+"…" : f.name;
    svg.appendChild(A.el("text",{x:padL-9,y:y+rowH/2+4,"text-anchor":"end","font-size":"10.5"},[A.txt(short)]));
    svg.appendChild(A.el("rect",{x:padL,y:y+3,width:plotW,height:rowH-6,rx:3,fill:A.cssv("--surface-3")}));
    var x=padL;
    A.CLS.forEach(function(c){
      var v=counts[c]; if(!v) return;
      var w=v/maxN*plotW;
      var rect=A.el("rect",{x:x,y:y+3,width:Math.max(w-2,0.8),height:rowH-6,rx:2,fill:A.cssv(A.COL[c])});
      rect.style.cursor="crosshair";
      A.bindTip(rect,function(){ return '<span class="hl">'+A.esc(f.name)+'</span> · '+c+'<br>'+v+'개 ('+(tot?(v/tot*100).toFixed(0):0)+'%)'; });
      svg.appendChild(rect);
      x+=w;
    });
    svg.appendChild(A.el("text",{x:W-padR+7,y:y+rowH/2+4,"font-size":"10",fill:A.cssv("--ink-3")},[A.txt(String(tot))]));
  });
  host.appendChild(svg);
  document.getElementById("d-byfield-legend").innerHTML = A.CLS.map(function(c){
    return '<span><i class="swatch" style="background:'+A.cssv(A.COL[c])+'"></i>'+c+'</span>';
  }).join("");
}

function renderCross(withComp){
  var panel = document.getElementById("d-cross-panel");
  panel.hidden = !withComp.length;
  if (!withComp.length) return;
  document.getElementById("d-cross-note").textContent = "조성이 붙은 입자 " + withComp.length + "개";
  var cross={}, used={};
  A.CLS.forEach(function(c){ cross[c]={}; });
  withComp.forEach(function(r){
    if (!cross[r.cls]) cross[r.cls]={};
    cross[r.cls][r.v2]=(cross[r.cls][r.v2]||0)+1;
    used[r.v2]=1;
  });
  var usedCls=A.CLS2.filter(function(c){ return used[c]; });
  var maxTot=Math.max.apply(null,A.CLS.map(function(c){
    return usedCls.reduce(function(a,x){ return a+(cross[c][x]||0); },0);
  }))||1;
  var host=document.getElementById("d-cross"); host.innerHTML="";
  var W=520,rowH=28,gap=10,padL=72,padR=40;
  var H=A.CLS.length*(rowH+gap)-gap+16;
  var svg=A.el("svg",{viewBox:"0 0 "+W+" "+H,width:"100%",role:"img"});
  var plotW=W-padL-padR;
  A.CLS.forEach(function(c,i){
    var y=i*(rowH+gap);
    var tot=usedCls.reduce(function(a,x){ return a+(cross[c][x]||0); },0);
    svg.appendChild(A.el("text",{x:padL-10,y:y+rowH/2+4,"text-anchor":"end","font-size":"11"},[A.txt(c)]));
    svg.appendChild(A.el("rect",{x:padL,y:y+4,width:plotW,height:rowH-8,rx:3,fill:A.cssv("--surface-3")}));
    var x=padL;
    usedCls.forEach(function(cc){
      var v=cross[c][cc]||0; if(!v) return;
      var w=v/maxTot*plotW;
      var rect=A.el("rect",{x:x,y:y+4,width:Math.max(w-2,0.8),height:rowH-8,rx:2,fill:A.cssv(A.COL2[cc])});
      rect.style.cursor="crosshair";
      A.bindTip(rect,function(){ return '<span class="hl">'+c+'</span> · '+cc+'<br>'+v+'개 ('+(tot?(v/tot*100).toFixed(0):0)+'%)'; });
      svg.appendChild(rect); x+=w;
    });
    svg.appendChild(A.el("text",{x:W-padR+8,y:y+rowH/2+4,"font-size":"10.5",fill:A.cssv("--ink-3")},[A.txt(String(tot))]));
  });
  host.appendChild(svg);
  document.getElementById("d-cross-legend").innerHTML = usedCls.map(function(c){
    return '<span><i class="swatch" style="background:'+A.cssv(A.COL2[c])+'"></i>'+c+'</span>';
  }).join("");
}

/* ---------- 임계 제안 ---------- */
var METRICS = [
  {key:"ar",   label:"종횡비",  rule:"침상 임계",   slider:"s-ar",   cur:function(){return A.S.ar},   dec:2},
  {key:"sol",  label:"고형도",  rule:"응집형 임계", slider:"s-sol",  cur:function(){return A.S.sol},  dec:2},
  {key:"circ", label:"원형도",  rule:"구형 임계",   slider:"s-circ", cur:function(){return A.S.circ}, dec:2}
];
function renderSuggest(rows){
  var host = document.getElementById("d-suggest");
  if (rows.length < 30){
    host.innerHTML = '<p style="font-size:12.5px;color:var(--ink-3)">입자가 ' + rows.length +
      '개뿐입니다. 경계를 제안하려면 최소 30개는 쌓여야 합니다 — 시야를 더 저장해 주세요.</p>';
    return;
  }
  var cards = METRICS.map(function(m){
    var vals = rows.map(function(r){ return r[m.key]; }).filter(function(v){ return isFinite(v); });
    var t = otsu1d(vals);
    var cur = m.cur();
    if (t == null) return "";
    var drift = Math.abs(t-cur);
    var flag = drift < (m.key==="ar" ? 0.25 : 0.05) ? "ok" : "warn";
    return '<div style="border:1px solid var(--line);border-radius:5px;padding:12px 14px;background:var(--surface-2);display:flex;flex-direction:column;gap:8px">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">' +
        '<div style="font-size:13px;font-weight:500">'+m.label+' <span style="color:var(--ink-3);font-weight:400">— '+m.rule+'</span></div>' +
        '<span class="flag '+flag+'">'+(flag==="ok"?"현재 값과 근접":"현재 값과 차이")+'</span></div>' +
      '<div style="display:flex;gap:20px;align-items:baseline">' +
        '<div><div class="eyebrow">지금</div><div class="mono" style="font-size:16px">'+cur.toFixed(m.dec)+'</div></div>' +
        '<div style="color:var(--ink-3)">→</div>' +
        '<div><div class="eyebrow">데이터가 가리키는 값</div><div class="mono" style="font-size:16px;color:var(--accent)">'+t.toFixed(m.dec)+'</div></div>' +
      '</div>' +
      '<div>' + miniDist(vals, cur, t) + '</div>' +
      '<button class="btn d-apply" data-slider="'+m.slider+'" data-v="'+t.toFixed(m.dec)+'" type="button">이 값으로 바꾸기</button>' +
    '</div>';
  }).filter(Boolean).join("");
  host.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">'+cards+'</div>' +
    '<p class="lede" style="margin-top:14px;font-size:12px">분포를 두 덩어리로 가장 잘 가르는 자리(Otsu)를 찾은 값입니다. 데이터가 실제로 두 덩어리가 아닐 수도 있으니, 위 분포 그림에서 골이 뚜렷한지 먼저 보세요 — 봉우리가 하나뿐이면 제안값에 의미가 없습니다.</p>';
  host.querySelectorAll(".d-apply").forEach(function(b){
    b.addEventListener("click", function(){
      var sl = document.getElementById(b.dataset.slider);
      sl.value = b.dataset.v;
      sl.dispatchEvent(new Event("input", {bubbles:true}));
      msg("임계값을 " + b.dataset.v + "로 바꿨습니다. 형상 탭에서 결과가 어떻게 달라졌는지 확인하세요. 이미 저장된 시야는 그대로입니다 — 다시 저장해야 새 임계가 반영됩니다.");
    });
  });
}
function miniDist(vals, cur, sug){
  var W=240,H=54,B=42;
  var lo=Math.min.apply(null,vals), hi=Math.max.apply(null,vals);
  if (!(hi>lo)) return "";
  var cnt=new Array(B).fill(0);
  vals.forEach(function(v){ cnt[Math.min(B-1,Math.floor((v-lo)/(hi-lo)*B))]++; });
  var mx=Math.max.apply(null,cnt)||1;
  var bw=W/B;
  var bars=cnt.map(function(c,i){
    var h=c/mx*(H-12);
    return '<rect x="'+(i*bw).toFixed(2)+'" y="'+(H-h).toFixed(2)+'" width="'+Math.max(bw-1,0.7).toFixed(2)+'" height="'+h.toFixed(2)+'" fill="'+A.cssv("--neutral")+'" opacity="0.55" rx="1"/>';
  }).join("");
  function xAt(v){ return Math.max(0,Math.min(W,(v-lo)/(hi-lo)*W)); }
  return '<svg viewBox="0 0 '+W+' '+H+'" width="100%" role="img">'+bars+
    '<line x1="'+xAt(cur).toFixed(2)+'" x2="'+xAt(cur).toFixed(2)+'" y1="0" y2="'+H+'" stroke="'+A.cssv("--ink-3")+'" stroke-width="1.5" stroke-dasharray="3 3"/>'+
    '<line x1="'+xAt(sug).toFixed(2)+'" x2="'+xAt(sug).toFixed(2)+'" y1="0" y2="'+H+'" stroke="'+A.cssv("--accent")+'" stroke-width="2"/>'+
    '</svg>';
}

/* ---------- k-평균 군집 ---------- */
function kmeans(pts, k, iters){
  var n=pts.length, dim=pts[0].length, i, j, d;
  var best=null, bestCost=Infinity;
  for (var trial=0; trial<8; trial++){
    var cent=[], used={};
    for (i=0;i<k;i++){
      var idx; var guard=0;
      do { idx = Math.floor(Math.random()*n); guard++; } while (used[idx] && guard<50);
      used[idx]=1; cent.push(pts[idx].slice());
    }
    var assign=new Array(n).fill(0), cost=0;
    for (var it=0; it<iters; it++){
      cost=0;
      for (i=0;i<n;i++){
        var bi=0, bd=Infinity;
        for (j=0;j<k;j++){
          var s=0;
          for (d=0;d<dim;d++){ var df=pts[i][d]-cent[j][d]; s+=df*df; }
          if (s<bd){ bd=s; bi=j; }
        }
        assign[i]=bi; cost+=bd;
      }
      var sums=[], cnts=new Array(k).fill(0);
      for (j=0;j<k;j++) sums.push(new Array(dim).fill(0));
      for (i=0;i<n;i++){
        cnts[assign[i]]++;
        for (d=0;d<dim;d++) sums[assign[i]][d]+=pts[i][d];
      }
      for (j=0;j<k;j++) if (cnts[j]) for (d=0;d<dim;d++) cent[j][d]=sums[j][d]/cnts[j];
    }
    if (cost<bestCost){ bestCost=cost; best={assign:assign.slice(), cent:cent.map(function(c){return c.slice()}), cost:cost}; }
  }
  return best;
}
function runCluster(){
  var out=document.getElementById("d-cluster-out");
  var rows=allRows();
  if (rows.length < 20){
    out.innerHTML='<p style="font-size:12.5px;color:var(--ink-3)">입자가 '+rows.length+'개뿐입니다. 군집을 나누려면 20개 이상 쌓여야 합니다.</p>';
    return;
  }
  var k=parseInt(document.getElementById("d-k").value,10);
  var raw=rows.map(function(r){ return [r.circ, r.sol, Math.log(Math.max(r.ar,1.001))]; });
  var dim=3, mu=[0,0,0], sd=[0,0,0], i, d;
  for (d=0;d<dim;d++){
    for (i=0;i<raw.length;i++) mu[d]+=raw[i][d];
    mu[d]/=raw.length;
    for (i=0;i<raw.length;i++) sd[d]+=Math.pow(raw[i][d]-mu[d],2);
    sd[d]=Math.sqrt(sd[d]/raw.length)||1;
  }
  var z=raw.map(function(p){ return p.map(function(v,d2){ return (v-mu[d2])/sd[d2]; }); });
  var res=kmeans(z,k,40);
  if (!res){ out.innerHTML='<p style="font-size:12.5px;color:var(--ink-3)">군집을 나누지 못했습니다.</p>'; return; }

  var groups=[];
  for (i=0;i<k;i++) groups.push({n:0, circ:0, sol:0, ar:0, eqd:0, cls:{}, v2:{}});
  rows.forEach(function(r,idx){
    var gidx=res.assign[idx], gg=groups[gidx];
    gg.n++; gg.circ+=r.circ; gg.sol+=r.sol; gg.ar+=r.ar; gg.eqd+=r.eqd;
    gg.cls[r.cls]=(gg.cls[r.cls]||0)+1;
    if (r.v2) gg.v2[r.v2]=(gg.v2[r.v2]||0)+1;
  });
  var order=groups.map(function(gg,i2){ return i2; }).filter(function(i2){ return groups[i2].n; })
    .sort(function(a,b){ return groups[b].n-groups[a].n; });

  out.innerHTML = '<div class="scroll-x"><table><thead><tr>' +
    "<th class='plain'>군집</th><th class='n plain'>입자</th><th class='n plain'>원형도</th><th class='n plain'>고형도</th><th class='n plain'>종횡비</th>" +
    "<th class='plain'>규칙 분류 구성</th><th class='plain'>조성 판정 구성</th></tr></thead><tbody>" +
    order.map(function(gi,rank){
      var gg=groups[gi];
      var clsMix=Object.keys(gg.cls).sort(function(a,b){return gg.cls[b]-gg.cls[a]}).map(function(c){
        return '<i class="swatch" style="background:'+A.cssv(A.COL[c])+';margin-right:4px"></i>'+c+' '+gg.cls[c];
      }).join(" · ");
      var v2Mix=Object.keys(gg.v2).sort(function(a,b){return gg.v2[b]-gg.v2[a]}).map(function(c){
        return '<i class="swatch" style="background:'+A.cssv(A.COL2[c])+';margin-right:4px"></i>'+c+' '+gg.v2[c];
      }).join(" · ") || '<span style="color:var(--ink-3)">—</span>';
      return "<tr><td class='mono'>군집 "+(rank+1)+"</td><td class='n'>"+gg.n+"</td>" +
        "<td class='n'>"+(gg.circ/gg.n).toFixed(3)+"</td><td class='n'>"+(gg.sol/gg.n).toFixed(3)+"</td>" +
        "<td class='n'>"+(gg.ar/gg.n).toFixed(2)+"</td>" +
        "<td style='font-size:11.5px'>"+clsMix+"</td><td style='font-size:11.5px'>"+v2Mix+"</td></tr>";
    }).join("") + "</tbody></table></div>" +
    '<p class="lede" style="margin-top:12px;font-size:12px">한 군집 안에 규칙 분류가 여러 개 섞여 있다면, 그 경계에서는 규칙이 데이터를 실제 모양대로 가르고 있지 않다는 뜻입니다. 반대로 군집 하나가 규칙 분류 하나와 거의 일치하면 그 규칙은 이 시료에서 잘 작동하고 있는 겁니다.</p>';
}

/* ---------- CSV ---------- */
function exportCSV(){
  var rows=allRows();
  if (!rows.length){ msg("내보낼 데이터가 없습니다.", "bad"); return; }
  var elSet={};
  rows.forEach(function(r){ for (var k in r.comp) elSet[k]=1; });
  var els=Object.keys(elSet);
  var head=["field","saved_at","image","um_per_px","particle_id","shape_class",
            "eq_diameter_px","feret_px","area_px2","perimeter_px",
            "circularity","solidity","aspect_ratio","comp_source","v1","v2"].concat(els);
  var byId={};
  FIELDS.forEach(function(f){ byId[f.id]=f; });
  var out=[head];
  rows.forEach(function(r){
    var f=byId[r.fieldId]||{};
    out.push([r.field, f.savedAt||"", f.imageName||"", r.umPerPx==null?"":r.umPerPx,
      r.id, r.cls, r.eqd, r.feret, r.area, r.perim, r.circ, r.sol, r.ar,
      r.src||"", r.v1||"", r.v2||""].concat(els.map(function(e){
        return r.comp[e]==null ? "" : r.comp[e];
      })));
  });
  A.saveCSV("particle_dataset_"+FIELDS.length+"fields.csv", out);
}
function parseCSV(text){
  var rows=[], row=[], cur="", q=false, i;
  text = text.replace(/^﻿/, "");
  for (i=0;i<text.length;i++){
    var c=text[i];
    if (q){
      if (c === '"'){ if (text[i+1] === '"'){ cur+='"'; i++; } else q=false; }
      else cur+=c;
    } else if (c === '"') q=true;
    else if (c === ","){ row.push(cur); cur=""; }
    else if (c === "\n"){ row.push(cur); rows.push(row); row=[]; cur=""; }
    else if (c !== "\r") cur+=c;
  }
  if (cur.length || row.length){ row.push(cur); rows.push(row); }
  return rows.filter(function(r){ return r.length>1 || (r[0]||"").trim(); });
}
async function importCSV(file){
  var text = await file.text();
  var table = parseCSV(text);
  if (table.length < 2){ msg("CSV에서 행을 찾지 못했습니다.", "bad"); return; }
  var head = table[0].map(function(h){ return h.trim(); });
  var need = ["field","particle_id","shape_class","circularity","solidity","aspect_ratio"];
  var missing = need.filter(function(h){ return head.indexOf(h) < 0; });
  if (missing.length){ msg("이 페이지가 내보낸 누적 CSV가 아닙니다. 빠진 열: " + A.esc(missing.join(", ")), "bad"); return; }
  var ix = {}; head.forEach(function(h,i){ ix[h]=i; });
  var fixed = ["field","saved_at","image","um_per_px","particle_id","shape_class","eq_diameter_px",
               "feret_px","area_px2","perimeter_px","circularity","solidity","aspect_ratio",
               "comp_source","v1","v2"];
  var els = head.filter(function(h){ return fixed.indexOf(h) < 0 && h; });
  var groups = {};
  table.slice(1).forEach(function(r){
    if (!r[ix.field]) return;
    var key = r[ix.field] + "|" + (r[ix.saved_at]||"");
    if (!groups[key]) groups[key] = {name:r[ix.field], savedAt:r[ix.saved_at]||new Date().toISOString(),
      imageName:r[ix.image]||"", umPerPx: r[ix.um_per_px]==="" ? null : Number(r[ix.um_per_px]), rows:[]};
    var v2i = A.CLS2.indexOf(r[ix.v2]);
    var base = [Number(r[ix.particle_id])||0, Math.max(0,A.CLS.indexOf(r[ix.shape_class])),
      Number(r[ix.eq_diameter_px])||0, Number(r[ix.feret_px])||0, Number(r[ix.area_px2])||0,
      Number(r[ix.perimeter_px])||0, Number(r[ix.circularity])||0, Number(r[ix.solidity])||0,
      Number(r[ix.aspect_ratio])||0, r[ix.comp_source]||"", r[ix.v1]||"", v2i];
    els.forEach(function(e){ var v=r[ix[e]]; base.push(v===""||v==null ? "" : Number(v)); });
    groups[key].rows.push(base);
  });
  var keys = Object.keys(groups);
  if (!keys.length){ msg("합칠 시야를 찾지 못했습니다.", "bad"); return; }
  var added = 0, skipped = 0;
  for (var i=0;i<keys.length;i++){
    var gg = groups[keys[i]];
    if (FIELDS.some(function(f){ return f.name===gg.name && f.savedAt===gg.savedAt; })){ skipped++; continue; }
    await Store.put({
      id: "f" + Date.now().toString(36) + Math.random().toString(36).slice(2,6) + i,
      name: gg.name, imageName: gg.imageName, savedAt: gg.savedAt,
      umPerPx: isFinite(gg.umPerPx) ? gg.umPerPx : null,
      settings: {}, thumb: "", els: els, rows: gg.rows
    });
    added++;
  }
  FIELDS = await Store.list();
  msg("시야 " + added + "장을 합쳤습니다." + (skipped ? " 이미 있는 " + skipped + "장은 건너뛰었습니다." : ""));
  render();
}

/* ---------- 배선 ---------- */
document.getElementById("s-save-field").addEventListener("click", saveCurrent);
document.getElementById("d-cluster").addEventListener("click", runCluster);
document.getElementById("d-csv").addEventListener("click", exportCSV);
document.getElementById("d-import").addEventListener("click", function(){
  document.getElementById("d-import-file").click();
});
document.getElementById("d-import-file").addEventListener("change", function(e){
  if (e.target.files[0]) importCSV(e.target.files[0]);
  e.target.value="";
});
document.getElementById("d-clear").addEventListener("click", async function(){
  if (!FIELDS.length) return;
  if (!confirm("저장된 시야 " + FIELDS.length + "장을 모두 지웁니다. 되돌릴 수 없습니다.")) return;
  await Store.clearAll();
  FIELDS = await Store.list();
  msg("모두 지웠습니다.");
  render();
});
document.addEventListener("app:render", function(){
  var el = document.getElementById("s-save-field");
  if (el) el.disabled = !(A.S.result && A.S.result.props.length);
});

(async function(){
  await Store.init();
  FIELDS = await Store.list();
  render();
})();

window.ACCUM = {render:render, fields:function(){ return FIELDS; }};
})();
