// 그리기 도구: 추세선·수평선·사각형 + 지우개. Lightweight Charts 시리즈 프리미티브로 캔버스에 직접 그린다.
// 좌표는 (UTC초, 가격)으로 저장하므로 봉 주기를 바꿔도 같은 자리에 그려진다.
// 시각→x 변환은 logical 인덱스( (t - 첫봉시각)/봉길이 )를 쓰므로 아직 로드되지 않은 과거나 미래 여백에도 그려진다.

const COLORS = { trend: '#2962ff', hline: '#f5c542', rect: 'rgba(41,98,255,0.18)', rectStroke: '#2962ff', preview: '#9aa4b8' };
const HIT_PX = 10;

export function createDrawings({ chart, series, getRange, undisp, onCustomClick }) {
  let symbol = null;
  let shapes = [];          // {type:'trend'|'hline'|'rect', p1:{t,price}, p2:{t,price}, price}
  let tool = 'cursor';
  let pending = null;       // 첫 점 찍은 상태 {type, p1, p2(미리보기)}
  let requestUpdate = () => {};
  const toolListeners = new Set();

  // ── 좌표 변환 ──
  const xOf = t => {
    const r = getRange(); if (!r) return null;
    const logical = (Math.floor(t / r.step) * r.step - r.firstTime) / r.step;
    return chart.timeScale().logicalToCoordinate(logical);
  };
  const yOf = p => series.priceToCoordinate(p);
  const tOf = logical => { const r = getRange(); return r ? r.firstTime + Math.round(logical) * r.step : null; };

  // ── 렌더러 ──
  function drawShape(ctx, s, hpr, vpr, preview) {
    const X = t => { const x = xOf(t); return x == null ? null : x * hpr; };
    const Y = p => { const y = yOf(p); return y == null ? null : y * vpr; };
    ctx.lineWidth = Math.max(1, Math.round(1.5 * hpr));
    if (s.type === 'hline') {
      const y = Y(s.price); if (y == null) return;
      ctx.strokeStyle = preview ? COLORS.preview : COLORS.hline; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(ctx.canvas.width, y); ctx.stroke();
      return;
    }
    const x1 = X(s.p1.t), y1 = Y(s.p1.price), x2 = X(s.p2.t), y2 = Y(s.p2.price);
    if ([x1, y1, x2, y2].some(v => v == null)) return;
    if (s.type === 'trend') {
      ctx.strokeStyle = preview ? COLORS.preview : COLORS.trend; ctx.setLineDash(preview ? [6 * hpr, 4 * hpr] : []);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      for (const [x, y] of [[x1, y1], [x2, y2]]) { ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(x, y, 3 * hpr, 0, Math.PI * 2); ctx.fill(); }
    } else if (s.type === 'rect') {
      const l = Math.min(x1, x2), t = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
      ctx.fillStyle = COLORS.rect; ctx.fillRect(l, t, w, h);
      ctx.strokeStyle = preview ? COLORS.preview : COLORS.rectStroke; ctx.setLineDash([]);
      ctx.strokeRect(l, t, w, h);
    }
  }
  const renderer = {
    draw(target) {
      target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr }) => {
        ctx.save();
        for (const s of shapes) drawShape(ctx, s, hpr, vpr, false);
        if (pending && pending.p2) drawShape(ctx, pending, hpr, vpr, true);
        ctx.restore();
      });
    },
  };
  const paneView = { renderer: () => renderer, zOrder: () => 'top' };
  const primitive = {
    attached({ requestUpdate: ru }) { requestUpdate = ru; },
    detached() { requestUpdate = () => {}; },
    paneViews: () => [paneView],
    updateAllViews() {},
  };
  series.attachPrimitive(primitive);

  // ── 저장 ──
  const key = sym => `general-toe.drawings.${sym}`;
  const save = () => { if (symbol) localStorage.setItem(key(symbol), JSON.stringify(shapes)); };
  function load(sym) {
    symbol = sym; pending = null;
    try { shapes = JSON.parse(localStorage.getItem(key(sym)) || '[]'); } catch { shapes = []; }
    requestUpdate();
  }

  // ── 히트 테스트(픽셀) ──
  const distSeg = (px, py, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1; const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };
  function hit(px, py) {
    let best = -1, bestD = HIT_PX;
    shapes.forEach((s, i) => {
      let d = Infinity;
      if (s.type === 'hline') { const y = yOf(s.price); if (y != null) d = Math.abs(py - y); }
      else {
        const x1 = xOf(s.p1.t), y1 = yOf(s.p1.price), x2 = xOf(s.p2.t), y2 = yOf(s.p2.price);
        if ([x1, y1, x2, y2].some(v => v == null)) return;
        if (s.type === 'trend') d = distSeg(px, py, x1, y1, x2, y2);
        else {
          const l = Math.min(x1, x2), r = Math.max(x1, x2), t = Math.min(y1, y2), b = Math.max(y1, y2);
          d = Math.min(distSeg(px, py, l, t, r, t), distSeg(px, py, l, b, r, b), distSeg(px, py, l, t, l, b), distSeg(px, py, r, t, r, b));
          if (px > l && px < r && py > t && py < b) d = Math.min(d, HIT_PX - 1);
        }
      }
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  // ── 입력 ──
  function pointFrom(param) {
    if (!param.point) return null;
    const price = series.coordinateToPrice(param.point.y);
    const t = param.logical != null ? tOf(param.logical) : null;
    return { x: param.point.x, y: param.point.y, price, t };
  }
  function handleClick(param) {
    if (tool === 'cursor') return;
    const p = pointFrom(param); if (!p || p.price == null) return;
    if (tool === 'erase') { const i = hit(p.x, p.y); if (i >= 0) { shapes.splice(i, 1); save(); requestUpdate(); } return; }
    if (tool === 'hline') { shapes.push({ type: 'hline', price: p.price }); save(); requestUpdate(); return; }
    if (tool === 'trend' || tool === 'rect') {
      if (p.t == null) return;
      if (!pending) { pending = { type: tool, p1: { t: p.t, price: p.price }, p2: null }; return; }
      shapes.push({ type: pending.type, p1: pending.p1, p2: { t: p.t, price: p.price } });
      pending = null; save(); requestUpdate(); return;
    }
    onCustomClick && onCustomClick(tool, p);
  }
  chart.subscribeClick(handleClick);
  // 두 점을 0.5초 안에 빠르게 찍으면 라이브러리가 두 번째 클릭을 더블클릭으로 바꿔 보낸다. 그것도 두 번째 점으로 받는다.
  chart.subscribeDblClick(param => { if (pending) handleClick(param); });
  chart.subscribeCrosshairMove(param => {
    if (!pending) return;
    const p = pointFrom(param); if (!p || p.price == null || p.t == null) return;
    pending.p2 = { t: p.t, price: p.price }; requestUpdate();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { pending = null; setTool('cursor'); requestUpdate(); } });

  function setTool(name) {
    tool = name; pending = null;
    const interactive = name === 'cursor';
    chart.applyOptions({ handleScroll: interactive, handleScale: interactive });
    toolListeners.forEach(cb => cb(tool));
    requestUpdate();
  }

  return {
    load, save, setTool, getTool: () => tool,
    onToolChange: cb => toolListeners.add(cb),
    clearAll() { shapes = []; pending = null; save(); requestUpdate(); },
    count: () => shapes.length,
    redraw: () => requestUpdate(),
  };
}
