// 그리기 엔진 v2 — 트레이딩뷰식 선택·편집.
//  - 도구: trend, ray, extended, hline, hray, vline, rect, channel, fib, text, arrow, measure
//  - 커서 모드에서 그림을 탭하면 선택 → 핸들 드래그로 점 이동, 몸통 드래그로 전체 이동, 플로팅 툴바로 속성 변경
//  - 실행취소/다시실행, 자석(고·저·시·종가에 붙기), Delete/Esc 키
//  - 저장: 점은 (UTC초, 가격). localStorage(심볼별) + 중계 서버 동기화(getRemote가 있으면)
// 시각→x 는 logical 인덱스 ((disp(t) - 첫봉시각)/봉길이) 를 쓰므로 미래 여백·미로드 과거에도 그려지고 주기를 바꿔도 같은 자리.

const PALETTE = ['#2962ff', '#f5c542', '#26a69a', '#ef5350', '#e040fb', '#e8eaf0'];
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, 2.618];
const FIB_COLORS = ['#787b86', '#ef5350', '#ff9800', '#26a69a', '#2962ff', '#e040fb', '#787b86', '#26a69a', '#f5c542', '#ef5350'];
const TOOLS = {
  trend:    { points: 2, label: '추세선',   color: '#2962ff' },
  ray:      { points: 2, label: '레이',     color: '#2962ff' },
  extended: { points: 2, label: '연장선',   color: '#2962ff' },
  hline:    { points: 1, label: '수평선',   color: '#f5c542' },
  hray:     { points: 1, label: '수평 레이', color: '#f5c542' },
  vline:    { points: 1, label: '수직선',   color: '#9aa4b8' },
  rect:     { points: 2, label: '사각형',   color: '#2962ff' },
  channel:  { points: 3, label: '평행 채널', color: '#26a69a' },
  fib:      { points: 2, label: '피보나치', color: '#f5c542' },
  text:     { points: 1, label: '텍스트',   color: '#e8eaf0' },
  arrow:    { points: 2, label: '화살표',   color: '#ef5350' },
  measure:  { points: 2, label: '측정',     color: '#9aa4b8' },
};
const LINE_TYPES = new Set(['trend', 'ray', 'extended', 'arrow']);
const EXTENDABLE = new Set(['trend', 'channel', 'fib']);
const uid = () => (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)) + Date.now().toString(36).slice(-4);
const fmtPrice = p => Math.abs(p) >= 1000 ? p.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) : p.toLocaleString('ko-KR', { maximumFractionDigits: Math.abs(p) >= 1 ? 3 : 5 });

export const TOOL_DEFS = TOOLS;

export function createDrawings({ chart, series, container, toolbarEl, getRange, disp, undisp, getBar, getRemote, onCustomClick, onStatus }) {
  const isTouch = matchMedia('(pointer: coarse)').matches;
  const HIT = isTouch ? 14 : 8;
  const HANDLE = isTouch ? 7 : 5;

  let symbol = null;
  let shapes = [];           // {id,type,points:[{t,price}],props:{color,width,style,extendLeft,extendRight,text},updated,locked}
  let tombstones = [];       // {id, updated}
  let tool = 'cursor';
  let pending = null;        // {type, points:[], cursor:{t,price}|null}
  let selectedId = null;
  let drag = null;           // {mode:'point'|'body', idx, start:{x,y,t,price}, orig}
  let magnet = false;
  let history = [], future = [];
  let requestUpdate = () => {};
  const toolListeners = new Set();
  const say = msg => onStatus && onStatus(msg);

  // ── 좌표 ──
  const ts = () => chart.timeScale();
  // logicalToCoordinate 는 정수 인덱스에만 좌표를 주고 소수에는 0을 돌려준다(라이브러리 동작).
  // 다른 봉 주기에서 그린 점은 소수 인덱스가 되므로 이웃한 정수 두 점 사이를 선형 보간한다.
  const xOfT = t => {
    const r = getRange(); if (!r) return null;
    const l = (disp(t) - r.firstTime) / r.step; const i = Math.floor(l);
    const x0 = ts().logicalToCoordinate(i); if (x0 == null) return null;
    if (l === i) return x0;
    const x1 = ts().logicalToCoordinate(i + 1); if (x1 == null) return x0;
    return x0 + (l - i) * (x1 - x0);
  };
  const tOfX = x => { const r = getRange(); if (!r) return null; const l = ts().coordinateToLogical(x); return l == null ? null : undisp(r.firstTime + l * r.step); };
  const yOfP = p => series.priceToCoordinate(p);
  const pOfY = y => series.coordinateToPrice(y);
  const paneW = () => ts().width();
  const paneH = () => { const p = chart.panes()[0]; return p ? p.getHeight() : container.clientHeight; };
  const snapPoint = (t, price, y) => {
    if (!magnet || !getBar) return { t, price };
    const b = getBar(t); if (!b) return { t, price };
    let best = price, bestD = Infinity;
    for (const v of [b.open, b.high, b.low, b.close]) { const yy = yOfP(v); if (yy != null && Math.abs(yy - y) < bestD) { bestD = Math.abs(yy - y); best = v; } }
    return { t: b.time, price: best };
  };

  // ── 저장/동기화 ──
  const key = s => `general-toe.drawings2.${s}`;
  function saveLocal() { if (symbol) localStorage.setItem(key(symbol), JSON.stringify({ shapes, tombstones })); }
  let syncTimer = null;
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 1500); }
  async function syncNow() {
    const remote = getRemote && getRemote(); if (!remote || !symbol) return;
    const sym = symbol;
    try { const merged = await remote.push(sym, { shapes, tombstones }); if (sym === symbol) applyMerged(merged); }
    catch (e) { console.warn('drawings sync failed', e); }
  }
  async function pullRemote() {
    const remote = getRemote && getRemote(); if (!remote || !symbol) return;
    const sym = symbol;
    try { const doc = await remote.pull(sym); if (sym === symbol && doc) applyMerged(doc); }
    catch (e) { console.warn('drawings pull failed', e); }
  }
  function applyMerged(doc) {
    const byId = new Map(shapes.map(s => [s.id, s]));
    for (const s of doc.shapes || []) { const cur = byId.get(s.id); if (!cur || (s.updated || 0) > (cur.updated || 0)) byId.set(s.id, s); }
    const tomb = new Map(tombstones.map(t => [t.id, t.updated]));
    for (const t of doc.tombstones || []) if ((t.updated || 0) > (tomb.get(t.id) || 0)) tomb.set(t.id, t.updated);
    for (const [id, upd] of tomb) { const s = byId.get(id); if (s && (s.updated || 0) <= upd) byId.delete(id); }
    shapes = [...byId.values()];
    const cutoff = Date.now() / 1000 - 30 * 86400;
    tombstones = [...tomb].filter(([, u]) => u > cutoff).map(([id, updated]) => ({ id, updated }));
    if (selectedId && !byId.has(selectedId)) select(null);
    saveLocal(); requestUpdate();
  }
  function load(sym) {
    symbol = sym; pending = null; drag = null; select(null); history = []; future = [];
    try {
      const raw = JSON.parse(localStorage.getItem(key(sym)) || 'null');
      if (raw && raw.shapes) { shapes = raw.shapes; tombstones = raw.tombstones || []; }
      else {
        // v1(구버전) 마이그레이션
        const old = JSON.parse(localStorage.getItem(`general-toe.drawings.${sym}`) || '[]');
        shapes = old.map(o => o.type === 'hline'
          ? mk('hline', [{ t: 0, price: o.price }])
          : mk(o.type === 'rect' ? 'rect' : 'trend', [{ t: undisp(o.p1.t), price: o.p1.price }, { t: undisp(o.p2.t), price: o.p2.price }]));
        tombstones = [];
      }
    } catch { shapes = []; tombstones = []; }
    requestUpdate();
    pullRemote();
  }

  // ── 모델 ──
  function mk(type, points, props = {}) {
    const d = TOOLS[type];
    return { id: uid(), type, points, props: { color: d.color, width: 1.5, style: 'solid', extendLeft: false, extendRight: false, text: '', ...props }, updated: Date.now() / 1000, locked: false };
  }
  function commit(label) { history.push(JSON.stringify(shapes)); if (history.length > 60) history.shift(); future = []; }
  function touch(s) { s.updated = Date.now() / 1000; }
  function afterChange() { saveLocal(); scheduleSync(); requestUpdate(); renderToolbar(); }
  function removeShape(id) {
    const i = shapes.findIndex(s => s.id === id); if (i < 0) return;
    commit(); shapes.splice(i, 1); tombstones.push({ id, updated: Date.now() / 1000 });
    if (selectedId === id) select(null);
    afterChange();
  }
  function undo() { if (!history.length) return; future.push(JSON.stringify(shapes)); shapes = JSON.parse(history.pop()); shapes.forEach(touch); select(null); afterChange(); }
  function redo() { if (!future.length) return; history.push(JSON.stringify(shapes)); shapes = JSON.parse(future.pop()); shapes.forEach(touch); select(null); afterChange(); }

  // ── 기하 ──
  const shapeAt = id => shapes.find(s => s.id === id);
  const sel = () => shapeAt(selectedId);
  function pts(s) { return s.points.map(p => ({ x: xOfT(p.t), y: yOfP(p.price) })); }
  function lineAt(s, t) { const [a, b] = s.points; if (b.t === a.t) return a.price; return a.price + (b.price - a.price) * (t - a.t) / (b.t - a.t); }
  function channelOffset(s) { return s.points.length > 2 ? s.points[2].price - lineAt(s, s.points[2].t) : 0; }
  // 선분 끝점 확장: extendLeft/extendRight 또는 ray/extended 에 따라 캔버스 밖까지
  function extendLine(x1, y1, x2, y2, left, right, W) {
    const dx = x2 - x1, dy = y2 - y1; if (!dx && !dy) return [x1, y1, x2, y2];
    const L = Math.max(W * 4, 10000);
    const len = Math.hypot(dx, dy); const ux = dx / len, uy = dy / len;
    let ax = x1, ay = y1, bx = x2, by = y2;
    if (left) { ax = x1 - ux * L; ay = y1 - uy * L; }
    if (right) { bx = x2 + ux * L; by = y2 + uy * L; }
    return [ax, ay, bx, by];
  }
  function lineExtents(s) {
    if (s.type === 'ray') return [false, true];
    if (s.type === 'extended') return [true, true];
    return [!!s.props.extendLeft, !!s.props.extendRight];
  }
  const distSeg = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1; const l2 = dx * dx + dy * dy;
    let u = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; u = Math.max(0, Math.min(1, u));
    return Math.hypot(px - (x1 + u * dx), py - (y1 + u * dy));
  };
  function hitShape(s, px, py) {
    const P = pts(s); if (P.some(p => p.x == null || p.y == null)) return Infinity;
    const W = paneW();
    switch (s.type) {
      case 'hline': return Math.abs(py - P[0].y);
      case 'hray': return px >= P[0].x - HIT ? Math.abs(py - P[0].y) : Infinity;
      case 'vline': return Math.abs(px - P[0].x);
      case 'text': { const w = Math.max(40, (s.props.text || '').length * 7 + 12); return (px >= P[0].x && px <= P[0].x + w && py >= P[0].y - 20 && py <= P[0].y) ? 0 : Infinity; }
      case 'trend': case 'ray': case 'extended': case 'arrow': {
        const [l, r] = lineExtents(s); const [ax, ay, bx, by] = extendLine(P[0].x, P[0].y, P[1].x, P[1].y, l, r, W);
        return distSeg(px, py, ax, ay, bx, by);
      }
      case 'rect': case 'measure': {
        const l = Math.min(P[0].x, P[1].x), r = Math.max(P[0].x, P[1].x), t = Math.min(P[0].y, P[1].y), b = Math.max(P[0].y, P[1].y);
        const edge = Math.min(distSeg(px, py, l, t, r, t), distSeg(px, py, l, b, r, b), distSeg(px, py, l, t, l, b), distSeg(px, py, r, t, r, b));
        return (px > l && px < r && py > t && py < b) ? Math.min(edge, HIT - 1) : edge;
      }
      case 'channel': {
        const [l, r] = lineExtents(s); const off = channelOffset(s);
        const y1b = yOfP(s.points[0].price + off), y2b = yOfP(s.points[1].price + off);
        const [ax, ay, bx, by] = extendLine(P[0].x, P[0].y, P[1].x, P[1].y, l, r, W);
        const [cx, cy, dx, dy] = extendLine(P[0].x, y1b, P[1].x, y2b, l, r, W);
        return Math.min(distSeg(px, py, ax, ay, bx, by), distSeg(px, py, cx, cy, dx, dy));
      }
      case 'fib': {
        const l = Math.min(P[0].x, P[1].x), r = s.props.extendRight ? W : Math.max(P[0].x, P[1].x);
        if (px < l - HIT || px > r + HIT) return Infinity;
        let best = Infinity;
        for (const lv of FIB_LEVELS) { const y = yOfP(s.points[1].price + (s.points[0].price - s.points[1].price) * lv); if (y != null) best = Math.min(best, Math.abs(py - y)); }
        return best;
      }
    }
    return Infinity;
  }
  function hitTest(px, py) {
    let best = null, bestD = HIT;
    for (let i = shapes.length - 1; i >= 0; i--) { const d = hitShape(shapes[i], px, py); if (d < bestD) { bestD = d; best = shapes[i]; } }
    return best;
  }
  function handlePositions(s) {
    const P = pts(s);
    if (s.type === 'hline' || s.type === 'hray') return [{ x: s.type === 'hray' ? P[0].x : paneW() / 2, y: P[0].y }];
    if (s.type === 'vline') return [{ x: P[0].x, y: paneH() / 2 }];
    return P;
  }
  function hitHandle(s, px, py) {
    const H = handlePositions(s);
    for (let i = 0; i < H.length; i++) if (H[i].x != null && H[i].y != null && Math.hypot(px - H[i].x, py - H[i].y) <= HANDLE + 4) return i;
    return -1;
  }

  // ── 렌더링 ──
  function setStroke(ctx, s, hpr, preview) {
    ctx.strokeStyle = preview ? '#9aa4b8' : s.props.color;
    ctx.lineWidth = Math.max(1, Math.round((s.props.width || 1.5) * hpr));
    ctx.setLineDash(preview ? [6 * hpr, 4 * hpr] : s.props.style === 'dashed' ? [8 * hpr, 5 * hpr] : s.props.style === 'dotted' ? [2 * hpr, 4 * hpr] : []);
  }
  function label(ctx, text, x, y, hpr, vpr, { bg = '#1e222d', fg = '#d1d4dc', align = 'left', pad = 4 } = {}) {
    ctx.save(); ctx.setLineDash([]);
    ctx.font = `${Math.round(11 * hpr)}px -apple-system, "Segoe UI", Roboto, "Noto Sans KR", sans-serif`;
    const lines = String(text).split('\n'); const h = 14 * vpr; const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2 * hpr;
    const bx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    ctx.fillStyle = bg; ctx.fillRect(bx, y, w, h * lines.length + pad * vpr);
    ctx.fillStyle = fg; ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, bx + pad * hpr, y + pad * vpr / 2 + i * h));
    ctx.restore();
    return { x: bx, y, w, h: h * lines.length + pad * vpr };
  }
  function drawShape(ctx, s, hpr, vpr, W, H, preview) {
    const P = pts(s); if (P.some(p => p.x == null || p.y == null)) return;
    const X = P.map(p => ({ x: p.x * hpr, y: p.y * vpr })); const Wb = W * hpr, Hb = H * vpr;
    setStroke(ctx, s, hpr, preview);
    const color = preview ? '#9aa4b8' : s.props.color;
    const alpha = c => c.startsWith('#') && c.length === 7 ? c + '2e' : c;
    switch (s.type) {
      case 'hline': case 'hray': {
        ctx.beginPath(); ctx.moveTo(s.type === 'hray' ? X[0].x : 0, X[0].y); ctx.lineTo(Wb, X[0].y); ctx.stroke();
        if (s.props.text) label(ctx, s.props.text, (s.type === 'hray' ? X[0].x : 0) + 6 * hpr, X[0].y - 18 * vpr, hpr, vpr, { bg: color, fg: '#131722' });
        break;
      }
      case 'vline': ctx.beginPath(); ctx.moveTo(X[0].x, 0); ctx.lineTo(X[0].x, Hb); ctx.stroke(); break;
      case 'trend': case 'ray': case 'extended': case 'arrow': {
        const [l, r] = lineExtents(s); const [ax, ay, bx, by] = extendLine(X[0].x, X[0].y, X[1].x, X[1].y, l, r, Wb);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        if (s.type === 'arrow') {
          const ang = Math.atan2(X[1].y - X[0].y, X[1].x - X[0].x), L = 12 * hpr;
          ctx.setLineDash([]); ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(X[1].x, X[1].y);
          ctx.lineTo(X[1].x - L * Math.cos(ang - 0.45), X[1].y - L * Math.sin(ang - 0.45));
          ctx.lineTo(X[1].x - L * Math.cos(ang + 0.45), X[1].y - L * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fill();
        }
        if (s.props.text) label(ctx, s.props.text, (X[0].x + X[1].x) / 2, (X[0].y + X[1].y) / 2 - 20 * vpr, hpr, vpr, { align: 'center' });
        break;
      }
      case 'rect': {
        const l = Math.min(X[0].x, X[1].x), t = Math.min(X[0].y, X[1].y), w = Math.abs(X[1].x - X[0].x), h = Math.abs(X[1].y - X[0].y);
        ctx.fillStyle = alpha(color); ctx.fillRect(l, t, w, h); ctx.strokeRect(l, t, w, h);
        if (s.props.text) label(ctx, s.props.text, l + 4 * hpr, t + 4 * vpr, hpr, vpr);
        break;
      }
      case 'measure': {
        const l = Math.min(X[0].x, X[1].x), t = Math.min(X[0].y, X[1].y), w = Math.abs(X[1].x - X[0].x), h = Math.abs(X[1].y - X[0].y);
        const up = s.points[1].price >= s.points[0].price; const c = up ? '#26a69a' : '#ef5350';
        ctx.fillStyle = c + '26'; ctx.fillRect(l, t, w, h); ctx.strokeStyle = c; ctx.setLineDash([4 * hpr, 3 * hpr]); ctx.strokeRect(l, t, w, h);
        const dp = s.points[1].price - s.points[0].price, pct = dp / s.points[0].price * 100;
        const r = getRange(); const bars = r ? Math.round(Math.abs(s.points[1].t - s.points[0].t) / r.step) : 0;
        const secs = Math.abs(s.points[1].t - s.points[0].t); const dur = secs >= 86400 ? `${(secs / 86400).toFixed(1)}일` : secs >= 3600 ? `${(secs / 3600).toFixed(1)}시간` : `${Math.round(secs / 60)}분`;
        label(ctx, `${dp >= 0 ? '+' : ''}${fmtPrice(dp)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)\n${bars}봉 · ${dur}`, l + w / 2, (up ? t : t + h) - (up ? 36 * vpr : 0), hpr, vpr, { align: 'center', bg: c, fg: '#fff' });
        break;
      }
      case 'channel': {
        const [l, r] = lineExtents(s); const off = channelOffset(s);
        const y1b = yOfP(s.points[0].price + off) * vpr, y2b = yOfP(s.points[1].price + off) * vpr;
        const [ax, ay, bx, by] = extendLine(X[0].x, X[0].y, X[1].x, X[1].y, l, r, Wb);
        const [cx, cy, dx, dy] = extendLine(X[0].x, y1b, X[1].x, y2b, l, r, Wb);
        ctx.fillStyle = alpha(color); ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(dx, dy); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(dx, dy); ctx.stroke();
        if (s.points.length > 2) { ctx.setLineDash([3 * hpr, 3 * hpr]); ctx.globalAlpha = 0.5; const my1 = (X[0].y + y1b) / 2, my2 = (X[1].y + y2b) / 2; const [ex, ey, fx, fy] = extendLine(X[0].x, my1, X[1].x, my2, l, r, Wb); ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(fx, fy); ctx.stroke(); ctx.globalAlpha = 1; }
        break;
      }
      case 'fib': {
        const l = Math.min(X[0].x, X[1].x), r = s.props.extendRight ? Wb : Math.max(X[0].x, X[1].x);
        const base = s.points[1].price, diff = s.points[0].price - s.points[1].price;
        ctx.setLineDash([]); ctx.lineWidth = Math.max(1, Math.round(hpr));
        let prevY = null;
        FIB_LEVELS.forEach((lv, i) => {
          const price = base + diff * lv; const y = yOfP(price) * vpr; const c = preview ? '#9aa4b8' : FIB_COLORS[i];
          if (prevY != null) { ctx.fillStyle = c + '14'; ctx.fillRect(l, Math.min(prevY, y), r - l, Math.abs(y - prevY)); }
          ctx.strokeStyle = c; ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(r, y); ctx.stroke();
          label(ctx, `${lv}  ${fmtPrice(price)}`, r, y - 14 * vpr, hpr, vpr, { align: 'right', fg: c, bg: '#131722cc' });
          prevY = y;
        });
        ctx.setLineDash([2 * hpr, 3 * hpr]); ctx.strokeStyle = '#787b86'; ctx.beginPath(); ctx.moveTo(X[0].x, X[0].y); ctx.lineTo(X[1].x, X[1].y); ctx.stroke();
        break;
      }
      case 'text': {
        label(ctx, s.props.text || '텍스트', X[0].x, X[0].y - 20 * vpr, hpr, vpr, { bg: alpha(color).slice(0, 7) + 'cc', fg: '#131722' });
        break;
      }
    }
  }
  function drawHandles(ctx, s, hpr, vpr) {
    for (const h of handlePositions(s)) {
      if (h.x == null || h.y == null) continue;
      ctx.setLineDash([]); ctx.fillStyle = '#131722'; ctx.strokeStyle = s.props.color; ctx.lineWidth = 2 * hpr;
      ctx.beginPath(); ctx.arc(h.x * hpr, h.y * vpr, HANDLE * hpr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
  const renderer = {
    draw(target) {
      target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr, bitmapSize }) => {
        const W = bitmapSize.width / hpr, H = bitmapSize.height / vpr;
        ctx.save();
        for (const s of shapes) drawShape(ctx, s, hpr, vpr, W, H, false);
        if (pending && pending.cursor && pending.points.length) {
          const need = TOOLS[pending.type].points;
          const prev = { ...mk(pending.type, [...pending.points, pending.cursor]) };
          while (prev.points.length < need) prev.points.push(pending.cursor);
          drawShape(ctx, prev, hpr, vpr, W, H, true);
        }
        const s = sel(); if (s) drawHandles(ctx, s, hpr, vpr);
        ctx.restore();
      });
    },
  };
  const paneView = { renderer: () => renderer, zOrder: () => 'top' };
  // 가격축 라벨: 수평선·수평 레이는 항상, 선택된 도형의 점 가격도 표시
  function axisViews() {
    const out = [];
    const add = (price, color) => out.push({ coordinate: () => yOfP(price) ?? -100, text: () => fmtPrice(price), textColor: () => '#131722', backColor: () => color, visible: () => yOfP(price) != null, tickVisible: () => true });
    for (const s of shapes) if (s.type === 'hline' || s.type === 'hray') add(s.points[0].price, s.props.color);
    const s = sel(); if (s && s.type !== 'hline' && s.type !== 'hray' && s.type !== 'vline' && s.type !== 'text') s.points.forEach(p => add(p.price, s.props.color));
    return out;
  }
  const primitive = {
    attached({ requestUpdate: ru }) { requestUpdate = ru; },
    detached() { requestUpdate = () => {}; },
    paneViews: () => [paneView],
    priceAxisViews: () => axisViews(),
    updateAllViews() {},
  };
  series.attachPrimitive(primitive);

  // ── 입력 ──
  function pos(e) {
    const src = e.touches && e.touches[0] ? e.touches[0] : e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : e;
    const r = container.getBoundingClientRect(); return { x: src.clientX - r.left, y: src.clientY - r.top };
  }
  const inPane = p => p.x >= 0 && p.x < paneW() && p.y >= 0 && p.y < paneH();
  function pointAt(p) { const t = tOfX(p.x); const raw = pOfY(p.y); if (t == null || raw == null) return null; const sp = snapPoint(t, raw, p.y); return { t: sp.t, price: sp.price, x: p.x, y: p.y }; }

  function onDown(e) {
    if (!(e.target instanceof HTMLCanvasElement)) return;        // 오버레이 DOM 위는 무시
    if (e.type === 'mousedown' && e.button !== 0) return;
    const p = pos(e); if (!inPane(p)) return;
    if (tool !== 'cursor') { e.stopPropagation(); e.preventDefault(); placePoint(p); return; }
    const s = sel();
    if (s && !s.locked) {
      const hi = hitHandle(s, p.x, p.y);
      if (hi >= 0) { startDrag('point', hi, p, s, e); return; }
    }
    const hit = hitTest(p.x, p.y);
    if (hit) {
      select(hit.id);
      if (!hit.locked) startDrag('body', -1, p, hit, e); else { e.stopPropagation(); e.preventDefault(); }
      return;
    }
    if (selectedId) select(null);      // 빈 곳 탭 → 선택 해제, 차트 이동은 그대로 허용
  }
  function startDrag(mode, idx, p, s, e) {
    e.stopPropagation(); e.preventDefault();
    const pt = pointAt(p); if (!pt) return;
    drag = { mode, idx, id: s.id, start: { x: p.x, y: p.y, t: pt.t, price: pt.price, logical: ts().coordinateToLogical(p.x) }, orig: JSON.parse(JSON.stringify(s)), moved: false };
    window.addEventListener('mousemove', onDragMove); window.addEventListener('touchmove', onDragMove, { passive: false });
    window.addEventListener('mouseup', onDragEnd); window.addEventListener('touchend', onDragEnd); window.addEventListener('touchcancel', onDragEnd);
  }
  function onDragMove(e) {
    if (!drag) return; e.preventDefault();
    const s = shapeAt(drag.id); if (!s) return;
    const p = pos(e); const r = getRange(); if (!r) return;
    const l = ts().coordinateToLogical(p.x); const price = pOfY(p.y); if (l == null || price == null) return;
    const dt = (l - drag.start.logical) * r.step, dp = price - drag.start.price;
    if (Math.abs(p.x - drag.start.x) + Math.abs(p.y - drag.start.y) > 2) drag.moved = true;
    if (!drag.moved) return;
    if (drag.mode === 'point') {
      const pt = pointAt(p); if (!pt) return;
      const o = drag.orig.points[drag.idx];
      s.points[drag.idx] = { t: (s.type === 'hline' || s.type === 'hray') && drag.idx === 0 && s.type === 'hline' ? o.t : pt.t, price: s.type === 'vline' ? o.price : pt.price };
    } else {
      s.points = drag.orig.points.map(o => ({ t: s.type === 'hline' ? o.t : o.t + dt, price: s.type === 'vline' ? o.price : o.price + dp }));
    }
    requestUpdate(); renderToolbar();
  }
  function onDragEnd() {
    window.removeEventListener('mousemove', onDragMove); window.removeEventListener('touchmove', onDragMove);
    window.removeEventListener('mouseup', onDragEnd); window.removeEventListener('touchend', onDragEnd); window.removeEventListener('touchcancel', onDragEnd);
    if (!drag) return;
    const s = shapeAt(drag.id);
    if (drag.moved && s) {
      const cur = s.points; s.points = drag.orig.points; commit(); s.points = cur; touch(s); afterChange();
    }
    drag = null;
  }
  function onMove(e) {
    if (!pending || !pending.points.length) return;
    const p = pos(e); if (!inPane(p)) return;
    const pt = pointAt(p); if (!pt) return;
    pending.cursor = { t: pt.t, price: pt.price }; requestUpdate();
  }
  function placePoint(p) {
    const pt = pointAt(p); if (!pt) return;
    if (!TOOLS[tool]) { onCustomClick && onCustomClick(tool, pt); return; }
    const need = TOOLS[tool].points;
    if (!pending) pending = { type: tool, points: [], cursor: null };
    pending.points.push({ t: pt.t, price: pt.price });
    if (pending.points.length < need) { pending.cursor = { t: pt.t, price: pt.price }; requestUpdate(); return; }
    let props = {};
    if (tool === 'text') { const txt = prompt('텍스트', ''); if (txt == null || !txt.trim()) { pending = null; requestUpdate(); return; } props.text = txt.trim(); }
    commit(); const s = mk(tool, pending.points, props); shapes.push(s); pending = null;
    afterChange(); select(s.id);
    setTool('cursor');   // 그리고 나면 항상 커서로 돌아온다
  }
  container.addEventListener('mousedown', onDown, true);
  container.addEventListener('touchstart', onDown, { capture: true, passive: false });
  container.addEventListener('mousemove', onMove);
  container.addEventListener('touchmove', onMove, { passive: true });
  document.addEventListener('keydown', e => {
    const tag = (e.target && e.target.tagName) || ''; if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    if (e.key === 'Escape') { if (pending) { pending = null; requestUpdate(); } else if (selectedId) select(null); else setTool('cursor'); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) { e.preventDefault(); removeShape(selectedId); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  });

  // ── 선택 & 플로팅 툴바 ──
  function select(id) { selectedId = id; requestUpdate(); renderToolbar(); }
  function renderToolbar() {
    if (!toolbarEl) return;
    const s = sel();
    if (!s) { toolbarEl.hidden = true; toolbarEl.innerHTML = ''; return; }
    toolbarEl.hidden = false;
    const btn = (html, title, cls = '') => `<button type="button" class="${cls}" title="${title}">${html}</button>`;
    let html = `<span class="name">${TOOLS[s.type].label}</span>`;
    html += `<span class="sw">${PALETTE.map(c => `<button type="button" data-color="${c}" class="swatch ${c === s.props.color ? 'on' : ''}" style="--c:${c}" title="${c}"></button>`).join('')}</span>`;
    if (s.type !== 'text' && s.type !== 'measure') {
      html += `<span class="grp">${[1, 2, 3].map(w => `<button type="button" data-width="${w}" class="${Math.round(s.props.width) === w ? 'on' : ''}" title="굵기 ${w}"><i style="height:${w}px"></i></button>`).join('')}</span>`;
      html += `<span class="grp">${[['solid', '―'], ['dashed', '- -'], ['dotted', '···']].map(([k, l]) => `<button type="button" data-style="${k}" class="${s.props.style === k ? 'on' : ''}" title="${k}">${l}</button>`).join('')}</span>`;
    }
    if (EXTENDABLE.has(s.type)) {
      if (s.type !== 'fib') html += `<button type="button" data-toggle="extendLeft" class="${s.props.extendLeft ? 'on' : ''}" title="왼쪽 연장">←</button>`;
      html += `<button type="button" data-toggle="extendRight" class="${s.props.extendRight ? 'on' : ''}" title="오른쪽 연장">→</button>`;
    }
    if (s.type !== 'measure' && s.type !== 'fib' && s.type !== 'vline') html += btn('T', '텍스트', 'act-text');
    html += btn(s.locked ? '🔒' : '🔓', s.locked ? '잠금 해제' : '잠금', 'act-lock');
    html += btn('⧉', '복제', 'act-dup');
    html += btn('🗑', '삭제 (Delete)', 'act-del');
    html += btn('✕', '선택 해제 (Esc)', 'act-close');
    toolbarEl.innerHTML = html;
  }
  toolbarEl && toolbarEl.addEventListener('click', e => {
    const b = e.target.closest('button'); const s = sel(); if (!b || !s) return;
    const change = fn => { commit(); fn(); touch(s); afterChange(); };
    if (b.dataset.color) change(() => { s.props.color = b.dataset.color; });
    else if (b.dataset.width) change(() => { s.props.width = +b.dataset.width; });
    else if (b.dataset.style) change(() => { s.props.style = b.dataset.style; });
    else if (b.dataset.toggle) change(() => { s.props[b.dataset.toggle] = !s.props[b.dataset.toggle]; });
    else if (b.classList.contains('act-text')) { const t = prompt('텍스트', s.props.text || ''); if (t != null) change(() => { s.props.text = t.trim(); }); }
    else if (b.classList.contains('act-lock')) change(() => { s.locked = !s.locked; });
    else if (b.classList.contains('act-dup')) { commit(); const r = getRange(); const c = mk(s.type, s.points.map(p => ({ t: p.t + (r ? r.step * 3 : 0), price: p.price })), { ...s.props }); shapes.push(c); afterChange(); select(c.id); }
    else if (b.classList.contains('act-del')) removeShape(s.id);
    else if (b.classList.contains('act-close')) select(null);
  });

  function setTool(name) {
    tool = name; pending = null;
    if (name !== 'cursor') select(null);
    const interactive = name === 'cursor';
    chart.applyOptions({ handleScroll: interactive, handleScale: interactive });
    toolListeners.forEach(cb => cb(tool));
    requestUpdate();
  }

  return {
    load, setTool, getTool: () => tool, onToolChange: cb => toolListeners.add(cb),
    undo, redo, canUndo: () => history.length > 0, canRedo: () => future.length > 0,
    setMagnet: v => { magnet = !!v; }, getMagnet: () => magnet,
    clearAll() { if (!shapes.length) return; commit(); const now = Date.now() / 1000; for (const s of shapes) tombstones.push({ id: s.id, updated: now }); shapes = []; select(null); afterChange(); },
    count: () => shapes.length,
    redraw: () => requestUpdate(),
    sync: syncNow, pull: pullRemote,
    // 디버그: 좌표별 히트 거리와 도형 픽셀 좌표
    debug: (x, y) => { const r = getRange(); return { tool, selectedId, paneW: paneW(), paneH: paneH(), range: r, visible: ts().getVisibleLogicalRange(), shapes: shapes.map(s => ({ id: s.id, type: s.type, pts: pts(s), logical: r ? s.points.map(p => (disp(p.t) - r.firstTime) / r.step) : null, hit: hitShape(s, x, y) })) }; },
  };
}
