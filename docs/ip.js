/* 입자 분석 파이프라인 — 브라우저에서 도는 SEM 이미지 분할·형상지표 계산.
   좌표계는 전부 "분석 이미지" 픽셀 기준. 외부 의존성 없음. */
(function(global){
"use strict";

/* ---------- 1. 그레이스케일 ---------- */
function toGray(imgData){
  var d = imgData.data, n = imgData.width * imgData.height;
  var g = new Float32Array(n);
  for (var i=0;i<n;i++){
    var o = i*4;
    g[i] = 0.299*d[o] + 0.587*d[o+1] + 0.114*d[o+2];
  }
  return g;
}

/* ---------- 2. 가우시안 블러 (분리형) ---------- */
function gaussian(src, W, H, sigma){
  if (sigma <= 0.05) return Float32Array.from(src);
  var r = Math.max(1, Math.ceil(sigma*3));
  var k = new Float32Array(2*r+1), sum = 0;
  for (var i=-r;i<=r;i++){
    var v = Math.exp(-(i*i)/(2*sigma*sigma));
    k[i+r] = v; sum += v;
  }
  for (i=0;i<k.length;i++) k[i] /= sum;
  var tmp = new Float32Array(W*H), out = new Float32Array(W*H);
  var x,y,j,acc,xx,yy;
  for (y=0;y<H;y++){
    for (x=0;x<W;x++){
      acc = 0;
      for (j=-r;j<=r;j++){
        xx = x+j; if (xx<0) xx = -xx; if (xx>=W) xx = 2*W-2-xx;
        acc += src[y*W+xx]*k[j+r];
      }
      tmp[y*W+x] = acc;
    }
  }
  for (y=0;y<H;y++){
    for (x=0;x<W;x++){
      acc = 0;
      for (j=-r;j<=r;j++){
        yy = y+j; if (yy<0) yy = -yy; if (yy>=H) yy = 2*H-2-yy;
        acc += tmp[yy*W+x]*k[j+r];
      }
      out[y*W+x] = acc;
    }
  }
  return out;
}

/* ---------- 3. Otsu 임계 ---------- */
function otsu(gray){
  var hist = new Float64Array(256), n = gray.length, i;
  for (i=0;i<n;i++){
    var b = gray[i]|0; if (b<0) b=0; if (b>255) b=255;
    hist[b]++;
  }
  var total = n, sumAll = 0;
  for (i=0;i<256;i++) sumAll += i*hist[i];
  var sumB=0, wB=0, best=0, bestVar=-1;
  for (i=0;i<256;i++){
    wB += hist[i];
    if (!wB) continue;
    var wF = total - wB;
    if (!wF) break;
    sumB += i*hist[i];
    var mB = sumB/wB, mF = (sumAll-sumB)/wF;
    var between = wB*wF*(mB-mF)*(mB-mF);
    if (between > bestVar){ bestVar = between; best = i; }
  }
  return best;
}

/* ---------- 4. 이진화 ---------- */
function binarize(gray, W, H, thr, bright){
  var n = W*H, bw = new Uint8Array(n);
  for (var i=0;i<n;i++){
    var on = bright ? (gray[i] > thr) : (gray[i] < thr);
    bw[i] = on ? 1 : 0;
  }
  return bw;
}

/* ---------- 5. 구멍 채우기 ---------- */
function fillHoles(bw, W, H){
  var n = W*H, seen = new Uint8Array(n), stack = new Int32Array(n), sp = 0, i, x, y;
  for (x=0;x<W;x++){
    if (!bw[x] && !seen[x]){ seen[x]=1; stack[sp++]=x; }
    var b = (H-1)*W+x;
    if (!bw[b] && !seen[b]){ seen[b]=1; stack[sp++]=b; }
  }
  for (y=0;y<H;y++){
    var l = y*W, r = y*W+W-1;
    if (!bw[l] && !seen[l]){ seen[l]=1; stack[sp++]=l; }
    if (!bw[r] && !seen[r]){ seen[r]=1; stack[sp++]=r; }
  }
  while (sp>0){
    var p = stack[--sp], px = p%W, py = (p/W)|0;
    if (px>0   && !bw[p-1] && !seen[p-1]){ seen[p-1]=1; stack[sp++]=p-1; }
    if (px<W-1 && !bw[p+1] && !seen[p+1]){ seen[p+1]=1; stack[sp++]=p+1; }
    if (py>0   && !bw[p-W] && !seen[p-W]){ seen[p-W]=1; stack[sp++]=p-W; }
    if (py<H-1 && !bw[p+W] && !seen[p+W]){ seen[p+W]=1; stack[sp++]=p+W; }
  }
  var out = new Uint8Array(n);
  for (i=0;i<n;i++) out[i] = bw[i] ? 1 : (seen[i] ? 0 : 1);
  return out;
}

/* ---------- 6. 연결 성분 (8-이웃) ---------- */
function label(bw, W, H){
  var n = W*H, lab = new Int32Array(n), stack = new Int32Array(n), cur = 0, i;
  for (i=0;i<n;i++){
    if (!bw[i] || lab[i]) continue;
    cur++;
    var sp = 0; stack[sp++] = i; lab[i] = cur;
    while (sp>0){
      var p = stack[--sp], px = p%W, py = (p/W)|0;
      for (var dy=-1;dy<=1;dy++){
        var ny = py+dy; if (ny<0||ny>=H) continue;
        for (var dx=-1;dx<=1;dx++){
          var nx = px+dx; if (nx<0||nx>=W) continue;
          var q = ny*W+nx;
          if (bw[q] && !lab[q]){ lab[q] = cur; stack[sp++] = q; }
        }
      }
    }
  }
  return {lab:lab, count:cur};
}

/* ---------- 7. 작은 객체 / 가장자리 접촉 제거 ---------- */
function filterRegions(lab, count, W, H, minArea, dropBorder){
  var n = W*H, area = new Int32Array(count+1), border = new Uint8Array(count+1), i, x, y;
  for (i=0;i<n;i++) if (lab[i]) area[lab[i]]++;
  if (dropBorder){
    for (x=0;x<W;x++){ if (lab[x]) border[lab[x]]=1; if (lab[(H-1)*W+x]) border[lab[(H-1)*W+x]]=1; }
    for (y=0;y<H;y++){ if (lab[y*W]) border[lab[y*W]]=1; if (lab[y*W+W-1]) border[lab[y*W+W-1]]=1; }
  }
  var remap = new Int32Array(count+1), next = 0;
  for (i=1;i<=count;i++){
    if (area[i] >= minArea && !(dropBorder && border[i])) remap[i] = ++next;
  }
  for (i=0;i<n;i++) if (lab[i]) lab[i] = remap[lab[i]];
  return next;
}

/* ---------- 8. 정확 유클리드 거리변환 (Felzenszwalb) ---------- */
function edt(bw, W, H){
  var INF = 1e20, n = W*H, f = new Float64Array(Math.max(W,H));
  var d = new Float64Array(n), v = new Int32Array(Math.max(W,H)), z = new Float64Array(Math.max(W,H)+1);
  var x, y, i;
  function dt1d(f, len, out){
    var k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (var q=1;q<len;q++){
      var s;
      while (true){
        s = ((f[q]+q*q) - (f[v[k]]+v[k]*v[k])) / (2*q - 2*v[k]);
        if (s <= z[k]) k--; else break;
      }
      k++; v[k] = q; z[k] = s; z[k+1] = INF;
    }
    k = 0;
    for (q=0;q<len;q++){
      while (z[k+1] < q) k++;
      out[q] = (q-v[k])*(q-v[k]) + f[v[k]];
    }
  }
  var col = new Float64Array(Math.max(W,H));
  for (y=0;y<H;y++){
    for (x=0;x<W;x++) f[x] = bw[y*W+x] ? INF : 0;
    dt1d(f, W, col);
    for (x=0;x<W;x++) d[y*W+x] = col[x];
  }
  for (x=0;x<W;x++){
    for (y=0;y<H;y++) f[y] = d[y*W+x];
    dt1d(f, H, col);
    for (y=0;y<H;y++) d[y*W+x] = col[y];
  }
  var out = new Float32Array(n);
  for (i=0;i<n;i++) out[i] = Math.sqrt(d[i]);
  return out;
}

/* ---------- 9. 접촉 입자 분할 (거리변환 + 마커 watershed) ----------
   성분마다 최대 거리의 frac 이상인 영역을 씨앗으로 잡고, 거리 내림차순으로
   흘려보내 먼저 닿은 씨앗에 귀속시킨다. frac=1이면 분할하지 않는다. */
function splitTouching(lab, count, W, H, frac){
  if (frac >= 0.999) return {lab:lab, count:count};
  var n = W*H, i;
  var mask = new Uint8Array(n);
  for (i=0;i<n;i++) mask[i] = lab[i] ? 1 : 0;
  var dist = edt(mask, W, H);

  var maxd = new Float32Array(count+1);
  for (i=0;i<n;i++){
    var L = lab[i];
    if (L && dist[i] > maxd[L]) maxd[L] = dist[i];
  }
  // 씨앗 후보
  var seedMask = new Uint8Array(n);
  for (i=0;i<n;i++){
    var L2 = lab[i];
    if (L2 && dist[i] >= frac*maxd[L2] && maxd[L2] > 1.5) seedMask[i] = 1;
  }
  var seeds = label(seedMask, W, H);
  var out = new Int32Array(n);
  for (i=0;i<n;i++) out[i] = seeds.lab[i];

  // 거리 내림차순 버킷 큐
  var maxAll = 0;
  for (i=0;i<n;i++) if (dist[i] > maxAll) maxAll = dist[i];
  var Q = Math.max(1, Math.ceil(maxAll*2));
  var buckets = new Array(Q+1);
  for (i=0;i<=Q;i++) buckets[i] = [];
  function prio(dv){
    var p = Q - Math.round(dv*2);
    return p < 0 ? 0 : (p > Q ? Q : p);
  }
  for (i=0;i<n;i++) if (out[i]) buckets[prio(dist[i])].push(i);

  for (var b=0;b<=Q;b++){
    var bucket = buckets[b];
    for (var s=0;s<bucket.length;s++){
      var p = bucket[s], px = p%W, py = (p/W)|0, L3 = out[p];
      if (!L3) continue;
      for (var dy=-1;dy<=1;dy++){
        var ny = py+dy; if (ny<0||ny>=H) continue;
        for (var dx=-1;dx<=1;dx++){
          if (!dx && !dy) continue;
          var nx = px+dx; if (nx<0||nx>=W) continue;
          var q = ny*W+nx;
          if (!lab[q] || out[q]) continue;
          out[q] = L3;
          var bp = prio(dist[q]);
          buckets[bp < b ? b : bp].push(q);
        }
      }
    }
    buckets[b] = null;
  }
  // 씨앗을 못 받은 잔여 픽셀은 원래 성분 유지
  var extra = 0, remap = {};
  for (i=0;i<n;i++){
    if (lab[i] && !out[i]){
      var key = lab[i];
      if (!remap[key]) remap[key] = seeds.count + (++extra);
      out[i] = remap[key];
    }
  }
  return {lab:out, count:seeds.count + extra, dist:dist};
}

/* ---------- 10. 윤곽 추적 (Moore) ---------- */
function traceContour(lab, W, H, target, startIdx){
  var dirs = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
  function at(x,y){ return (x<0||y<0||x>=W||y>=H) ? 0 : (lab[y*W+x]===target ? 1 : 0); }
  var sx = startIdx%W, sy = (startIdx/W)|0;
  var cx = sx, cy = sy, dir = 6, pts = [], guard = 0, maxSteps = 8*(W+H)+4000;
  do {
    pts.push([cx, cy]);
    var found = false;
    for (var k=0;k<8;k++){
      var nd = (dir + 6 + k) % 8;
      var nx = cx + dirs[nd][0], ny = cy + dirs[nd][1];
      if (at(nx,ny)){ cx = nx; cy = ny; dir = nd; found = true; break; }
    }
    if (!found) break;
    guard++;
  } while ((cx !== sx || cy !== sy) && guard < maxSteps);
  return pts;
}

/* ---------- 11. 볼록 껍질 (Andrew monotone chain) ---------- */
function convexHull(pts){
  if (pts.length < 3) return pts.slice();
  var p = pts.slice().sort(function(a,b){ return a[0]-b[0] || a[1]-b[1]; });
  function cross(o,a,b){ return (a[0]-o[0])*(b[1]-o[1]) - (a[1]-o[1])*(b[0]-o[0]); }
  var lower = [], i;
  for (i=0;i<p.length;i++){
    while (lower.length>=2 && cross(lower[lower.length-2], lower[lower.length-1], p[i]) <= 0) lower.pop();
    lower.push(p[i]);
  }
  var upper = [];
  for (i=p.length-1;i>=0;i--){
    while (upper.length>=2 && cross(upper[upper.length-2], upper[upper.length-1], p[i]) <= 0) upper.pop();
    upper.push(p[i]);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}
function polyArea(poly){
  var a = 0;
  for (var i=0, j=poly.length-1; i<poly.length; j=i++){
    a += (poly[j][0]*poly[i][1] - poly[i][0]*poly[j][1]);
  }
  return Math.abs(a)/2;
}

/* ---------- 12. 영역 지표 ---------- */
function regionProps(lab, count, W, H){
  var n = W*H;
  var A = new Float64Array(count+1), SX = new Float64Array(count+1), SY = new Float64Array(count+1);
  var SXX = new Float64Array(count+1), SYY = new Float64Array(count+1), SXY = new Float64Array(count+1);
  var minX = new Int32Array(count+1).fill(1e9), minY = new Int32Array(count+1).fill(1e9);
  var maxX = new Int32Array(count+1).fill(-1), maxY = new Int32Array(count+1).fill(-1);
  var first = new Int32Array(count+1).fill(-1);
  var i, x, y, L;
  for (i=0;i<n;i++){
    L = lab[i]; if (!L) continue;
    x = i%W; y = (i/W)|0;
    A[L]++; SX[L]+=x; SY[L]+=y; SXX[L]+=x*x; SYY[L]+=y*y; SXY[L]+=x*y;
    if (x<minX[L]) minX[L]=x;
    if (y<minY[L]) minY[L]=y;
    if (x>maxX[L]) maxX[L]=x;
    if (y>maxY[L]) maxY[L]=y;
    if (first[L] < 0) first[L] = i;
  }
  var out = [];
  for (L=1;L<=count;L++){
    if (!A[L]) continue;
    var a = A[L], cx = SX[L]/a, cy = SY[L]/a;
    var mxx = SXX[L]/a - cx*cx + 1/12;
    var myy = SYY[L]/a - cy*cy + 1/12;
    var mxy = SXY[L]/a - cx*cy;
    var tmp = Math.sqrt(Math.max((mxx-myy)*(mxx-myy) + 4*mxy*mxy, 0));
    var l1 = (mxx+myy+tmp)/2, l2 = (mxx+myy-tmp)/2;
    var major = 4*Math.sqrt(Math.max(l1,0)), minor = 4*Math.sqrt(Math.max(l2,0));

    var pts = traceContour(lab, W, H, L, first[L]);
    var per = 0;
    for (i=1;i<pts.length;i++){
      var dx = pts[i][0]-pts[i-1][0], dy = pts[i][1]-pts[i-1][1];
      per += (dx && dy) ? Math.SQRT2 : 1;
    }
    if (pts.length > 2){
      var dxc = pts[0][0]-pts[pts.length-1][0], dyc = pts[0][1]-pts[pts.length-1][1];
      per += (dxc && dyc) ? Math.SQRT2 : ((dxc||dyc) ? 1 : 0);
    }
    per *= 0.95; // 디지털 곡선 과대추정 보정
    if (per < 1) per = 1;

    var hull = convexHull(pts);
    var hullA = Math.max(polyArea(hull), a);
    var circ = 4*Math.PI*a/(per*per);
    if (circ > 1) circ = 1;

    // 최대 Feret 지름
    var feret = 0;
    for (i=0;i<hull.length;i++){
      for (var j=i+1;j<hull.length;j++){
        var ddx = hull[i][0]-hull[j][0], ddy = hull[i][1]-hull[j][1];
        var dd = ddx*ddx + ddy*ddy;
        if (dd > feret) feret = dd;
      }
    }
    feret = Math.sqrt(feret);

    out.push({
      id: L, area: a, cx: cx, cy: cy,
      bbox: [minY[L], minX[L], maxY[L]+1, maxX[L]+1],
      perim: per, circ: circ,
      sol: a/hullA,
      ar: minor > 0.5 ? major/minor : (major > 0 ? major/0.5 : 1),
      major: major, minor: minor,
      eqd: 2*Math.sqrt(a/Math.PI),
      feret: feret,
      contour: pts, hull: hull
    });
  }
  return out;
}

/* ---------- 13. 전체 파이프라인 ---------- */
function analyze(imgData, opt){
  var W = imgData.width, H0 = imgData.height;
  var cropBottom = Math.max(0, Math.min(H0-10, Math.round(H0*(opt.cropBottom||0))));
  var H = H0 - cropBottom;
  var gAll = toGray(imgData);
  var gray = cropBottom ? gAll.subarray(0, W*H) : gAll;

  var blurred = gaussian(gray, W, H, opt.sigma);
  var thr = opt.autoThreshold ? otsu(blurred) : opt.threshold;
  var bw = binarize(blurred, W, H, thr, opt.bright);
  if (opt.fillHoles) bw = fillHoles(bw, W, H);

  var L0 = label(bw, W, H);
  var count = filterRegions(L0.lab, L0.count, W, H, opt.minArea, opt.dropBorder);
  var split = splitTouching(L0.lab, count, W, H, opt.splitFrac);
  count = filterRegions(split.lab, split.count, W, H, opt.minArea, false);

  var props = regionProps(split.lab, count, W, H);
  return {W:W, H:H, cropBottom:cropBottom, threshold:thr, lab:split.lab, props:props, dist:split.dist};
}

global.IP = {
  toGray:toGray, gaussian:gaussian, otsu:otsu, binarize:binarize, fillHoles:fillHoles,
  label:label, edt:edt, splitTouching:splitTouching, regionProps:regionProps, analyze:analyze
};
})(window);
