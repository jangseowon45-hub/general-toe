// 봇 뷰 — 봇(workspace_mo)이 쓰는 전략 지표를 봇과 같은 계산으로 차트에 겹친다.
// 두 전략 모두 4h 봉 기준이라, 차트 주기와 무관하게 4h 캔들을 따로 받아 계단식으로 그린다.
// 계산은 서버 전략 파일(strategy/DC_Trend/DC_Trend.py, strategy/SQZ_X/SQZ_X.py)의 get_indicators/get_signal 을
// pandas 의미 그대로 옮겼다: ewm(adjust=False) 첫값=첫 입력, rolling().std() 는 표본 표준편차(ddof=1), 채널은 shift(1).
import { LineSeries } from 'lightweight-charts';
import { fetchKlines } from './data.js';

const TF = '4h', STEP = 14400;
export const STRATEGIES = {
  DC_Trend: {
    label: 'DC_Trend', desc: '돈치안 20봉 돌파 · 10봉 채널 청산 · EMA200 필터 · ATR≥0.5%',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    p: { dc_n: 20, dc_exit_n: 10, ema: 200, atr: 14, atr_pct_min: 0.005, sl_mult: 3.0 },
    color: '#f5c542',
  },
  SQZ_X: {
    label: 'SQZ_X', desc: 'BB(20,2)가 KC(20,1.5×ATR) 안에 6봉+ 압축 → 6봉 박스 상단 돌파 · EMA200 필터',
    symbols: ['BTCUSDT'],
    p: { sqz_min_bars: 6, kc_mult: 1.5, bb_period: 20, bb_mult: 2.0, ema: 200, atr: 20, sl_mult: 1.5 },
    color: '#ff9800',
  },
};

// ── pandas 호환 수치 ──
const ewmSpan = (xs, span) => { const a = 2 / (span + 1); const out = new Array(xs.length); let y; for (let i = 0; i < xs.length; i++) { const x = xs[i]; y = y === undefined ? x : (1 - a) * y + a * x; out[i] = y; } return out; };
const ewmCom = (xs, com) => { const a = 1 / (1 + com); const out = new Array(xs.length); let y; for (let i = 0; i < xs.length; i++) { const x = xs[i]; y = y === undefined ? x : (1 - a) * y + a * x; out[i] = y; } return out; };
const rollMax = (xs, n) => xs.map((_, i) => i < n - 1 ? NaN : Math.max(...xs.slice(i - n + 1, i + 1)));
const rollMin = (xs, n) => xs.map((_, i) => i < n - 1 ? NaN : Math.min(...xs.slice(i - n + 1, i + 1)));
const rollMean = (xs, n) => { const out = new Array(xs.length).fill(NaN); let s = 0; for (let i = 0; i < xs.length; i++) { s += xs[i]; if (i >= n) s -= xs[i - n]; if (i >= n - 1) out[i] = s / n; } return out; };
const rollStd = (xs, n) => xs.map((_, i) => { if (i < n - 1) return NaN; const w = xs.slice(i - n + 1, i + 1); const m = w.reduce((a, b) => a + b, 0) / n; return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)); });
const shift1 = xs => [NaN, ...xs.slice(0, -1)];
function atr(bars, period) {
  const tr = bars.map((b, i) => i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)));
  return ewmCom(tr, period - 1);
}

// ── 전략 계산 (닫힌 봉 배열 기준; 마지막 형성 중 봉은 호출 전에 제거) ──
export function computeDC(bars, p = STRATEGIES.DC_Trend.p) {
  const hi = bars.map(b => b.high), lo = bars.map(b => b.low), cl = bars.map(b => b.close);
  const dc_hi = shift1(rollMax(hi, p.dc_n)), dc_lo = shift1(rollMin(lo, p.dc_n));
  const exit_lo = shift1(rollMin(lo, p.dc_exit_n)), exit_hi = shift1(rollMax(hi, p.dc_exit_n));
  const ema = ewmSpan(cl, p.ema), a = atr(bars, p.atr);
  const gate = cl.map((c, i) => a[i] / c >= p.atr_pct_min);
  const signal = cl.map((c, i) => i > 0 && gate[i] && c > dc_hi[i] && cl[i - 1] <= dc_hi[i - 1] && c > ema[i]);
  return { dc_hi, dc_lo, exit_lo, exit_hi, ema, atr: a, gate, signal };
}
export function computeSQZ(bars, p = STRATEGIES.SQZ_X.p) {
  const hi = bars.map(b => b.high), lo = bars.map(b => b.low), cl = bars.map(b => b.close);
  const n = p.bb_period, m = p.bb_mult;
  const mid = rollMean(cl, n), sd = rollStd(cl, n);
  const bb_up = mid.map((v, i) => v + m * sd[i]), bb_lo = mid.map((v, i) => v - m * sd[i]);
  const kc_mid = ewmSpan(cl, n), atr20 = atr(bars, n);
  const kc_up = kc_mid.map((v, i) => v + p.kc_mult * atr20[i]), kc_lo = kc_mid.map((v, i) => v - p.kc_mult * atr20[i]);
  const on = bb_up.map((v, i) => Number.isFinite(v) && v < kc_up[i] && bb_lo[i] > kc_lo[i]);
  const sqz_cnt = []; let c = 0; for (const o of on) { c = o ? c + 1 : 0; sqz_cnt.push(c); }
  const box_n = Math.max(p.sqz_min_bars, 4);
  const box_hi = shift1(rollMax(hi, box_n)), box_lo = shift1(rollMin(lo, box_n));
  const ema = ewmSpan(cl, p.ema), a = atr(bars, p.atr);
  const armed = cl.map((_, i) => i > 0 && sqz_cnt[i - 1] >= p.sqz_min_bars);
  const signal = cl.map((cv, i) => armed[i] && cv > box_hi[i] && cv > mid[i] && cv > ema[i]);
  return { bb_up, bb_lo, kc_up, kc_lo, mid, box_hi, box_lo, sqz_cnt, on, armed, ema, atr: a, signal };
}

const fmt = p => Math.abs(p) >= 1000 ? p.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) : p.toLocaleString('ko-KR', { maximumFractionDigits: Math.abs(p) >= 1 ? 3 : 5 });
const pct = (a, b) => `${a >= b ? '+' : ''}${((a / b - 1) * 100).toFixed(2)}%`;

export function createBotView({ chart, series, getBars, getStep, getSymbol, disp, getRange, panelEl, onStatus }) {
  let enabled = false, symbol = null, bars4h = [], closed = [], calc = {}, lines = {}, timer = null, token = 0;
  let stratOn = { DC_Trend: true, SQZ_X: true };
  let collapsed = (() => { try { return localStorage.getItem('general-toe.botpanel.collapsed') === '1' || matchMedia('(max-width: 600px)').matches; } catch { return false; } })();
  let requestUpdate = () => {};

  // 4h 값 → 차트 봉 시각 매핑. 차트 주기 ≤ 4h: 봉이 속한 4h 구간. > 4h(일봉): 구간의 마지막 4h.
  const idx4h = new Map();
  function keyFor(t) { const step = getStep(); let k = step > STEP ? t + step - STEP : Math.floor(t / STEP) * STEP; if (bars4h.length && k > bars4h[bars4h.length - 1].time) k = bars4h[bars4h.length - 1].time; return k; }
  function stepSeries(arr) {
    const out = []; const bars = getBars();
    for (const b of bars) { const i = idx4h.get(keyFor(b.time)); if (i == null) continue; const v = arr[i]; if (Number.isFinite(v)) out.push({ time: disp(b.time), value: v }); }
    return out;
  }
  const LINE_DEFS = {
    DC_Trend: [
      ['dc_hi', { color: '#f5c542', lineWidth: 2, title: 'DC20 상단' }],
      ['dc_lo', { color: '#f5c54266', lineWidth: 1, title: 'DC20 하단' }],
      ['exit_lo', { color: '#ef5350', lineWidth: 1, lineStyle: 2, title: 'DC10 청산' }],
      ['ema', { color: '#e040fb', lineWidth: 1, lineStyle: 1, title: '봇 EMA200(4h)' }],
    ],
    SQZ_X: [
      ['bb_up', { color: '#26a69a', lineWidth: 1, title: 'BB 상단' }],
      ['bb_lo', { color: '#26a69a', lineWidth: 1, title: 'BB 하단' }],
      ['kc_up', { color: '#ff9800', lineWidth: 1, lineStyle: 2, title: 'KC 상단' }],
      ['kc_lo', { color: '#ff9800', lineWidth: 1, lineStyle: 2, title: 'KC 하단' }],
      ['box_hi', { color: '#e8eaf0', lineWidth: 1, lineStyle: 3, title: '박스 상단' }],
    ],
  };
  function ensureLines(name) {
    if (lines[name]) return lines[name];
    lines[name] = {};
    for (const [k, o] of LINE_DEFS[name]) lines[name][k] = chart.addSeries(LineSeries, { ...o, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false });
    return lines[name];
  }
  function removeLines(name) { if (!lines[name]) return; Object.values(lines[name]).forEach(s => chart.removeSeries(s)); delete lines[name]; }
  function activeStrats() { return Object.entries(STRATEGIES).filter(([n, d]) => stratOn[n] && d.symbols.includes(symbol)).map(([n]) => n); }

  function render() {
    for (const name of Object.keys(STRATEGIES)) {
      if (!enabled || !activeStrats().includes(name) || !calc[name]) { removeLines(name); continue; }
      const L = ensureLines(name);
      for (const k of Object.keys(L)) L[k].setData(stepSeries(calc[name][k]));
    }
    requestUpdate(); renderPanel();
  }

  // ── 마커 프리미티브: 스퀴즈 점(하단), 신호 화살표 ──
  const xOfT = t => { const r = getRange(); if (!r) return null; const l = (disp(t) - r.firstTime) / r.step; const i = Math.floor(l); const x0 = chart.timeScale().logicalToCoordinate(i); if (x0 == null) return null; if (l === i) return x0; const x1 = chart.timeScale().logicalToCoordinate(i + 1); return x1 == null ? x0 : x0 + (l - i) * (x1 - x0); };
  const renderer = {
    draw(target) {
      if (!enabled) return;
      target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hpr, verticalPixelRatio: vpr, bitmapSize }) => {
        const H = bitmapSize.height; const step = getStep(); const w4 = Math.max(2, (xOfT(STEP) ?? 0) - (xOfT(0) ?? 0)); // 4h 폭(px)
        ctx.save(); ctx.font = `${Math.round(10 * hpr)}px sans-serif`; ctx.textAlign = 'center';
        // 스퀴즈 점: 4h 봉마다 하단에 점. 6봉 이상(무장)은 노란색.
        if (activeStrats().includes('SQZ_X') && calc.SQZ_X) {
          const { on, sqz_cnt } = calc.SQZ_X;
          for (let i = 0; i < closed.length; i++) {
            if (!on[i]) continue; const x = xOfT(closed[i].time + STEP / 2); if (x == null || x < -20) continue;
            ctx.fillStyle = sqz_cnt[i] >= STRATEGIES.SQZ_X.p.sqz_min_bars ? '#f5c542' : '#787b86';
            ctx.beginPath(); ctx.arc(x * hpr, H - 6 * vpr, 2.5 * hpr, 0, Math.PI * 2); ctx.fill();
          }
        }
        // 신호 화살표
        for (const name of activeStrats()) {
          const c = calc[name]; if (!c) continue;
          for (let i = 0; i < closed.length; i++) {
            if (!c.signal[i]) continue;
            const x = xOfT(closed[i].time + Math.min(step, STEP) / 2); const y = series.priceToCoordinate(closed[i].low); if (x == null || y == null) continue;
            const X = x * hpr, Y = (y + 10) * vpr; const col = STRATEGIES[name].color;
            ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X - 6 * hpr, Y + 10 * vpr); ctx.lineTo(X + 6 * hpr, Y + 10 * vpr); ctx.closePath(); ctx.fill();
            ctx.fillStyle = col; ctx.fillText(name === 'DC_Trend' ? 'DC' : 'SQZ', X, Y + 22 * vpr);
          }
        }
        ctx.restore();
      });
    },
  };
  const primitive = { attached({ requestUpdate: ru }) { requestUpdate = ru; }, detached() { requestUpdate = () => {}; }, paneViews: () => [{ renderer: () => renderer, zOrder: () => 'top' }], updateAllViews() {} };
  series.attachPrimitive(primitive);

  // ── 상태 패널 ──
  function renderPanel() {
    if (!panelEl) return;
    if (!enabled) { panelEl.hidden = true; return; }
    panelEl.hidden = false;
    const sym = (symbol || '').replace('USDT', '');
    const strats = Object.entries(STRATEGIES).filter(([, d]) => d.symbols.includes(symbol));
    if (!strats.length) { panelEl.innerHTML = `<div class="hdr">🤖 봇 뷰</div><p class="setup">${sym}에는 봇 전략이 없어요. 봇은 BTC(DC_Trend, SQZ_X), ETH·SOL(DC_Trend)만 거래해요.</p>`; return; }
    if (!closed.length) { panelEl.innerHTML = `<div class="hdr">🤖 봇 뷰</div><p class="setup">4h 데이터 불러오는 중…</p>`; return; }
    const last = closed[closed.length - 1], i = closed.length - 1;
    const when = new Date((last.time + STEP) * 1000).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    let html = `<div class="hdr" title="탭하면 접기/펼치기">🤖 봇 뷰 · ${sym} 4h <span class="muted">닫힌 봉 ${when}</span><span class="caret">${collapsed ? '▸' : '▾'}</span></div>`;
    html += `<p class="note">실제 시장(Binance 선물) 캔들 기준. 봇은 OKX <b>데모</b> 시장 캔들로 계산해 ATR·스퀴즈 수치가 다를 수 있어요(EMA200은 거의 같음).</p>`;
    for (const [name, d] of strats) {
      const c = calc[name]; const on = stratOn[name];
      html += `<label class="strat"><input type="checkbox" data-strat="${name}" ${on ? 'checked' : ''}> <b style="color:${d.color}">${d.label}</b> <span class="muted">${d.desc}</span></label>`;
      if (!on || !c) continue;
      const regime = last.close > c.ema[i];
      const rows = [`국면 ${regime ? '<span class="up">상승(롱 허용)</span>' : '<span class="down">하락(관망)</span>'} · 종가 ${fmt(last.close)} vs EMA200 ${fmt(c.ema[i])}`];
      if (name === 'DC_Trend') {
        const ap = c.atr[i] / last.close * 100;
        rows.push(`ATR ${fmt(c.atr[i])} (${ap.toFixed(2)}%) ${c.gate[i] ? '<span class="up">게이트 통과</span>' : '<span class="down">0.5% 미만 → 진입 금지</span>'}`);
        rows.push(`돌파선 DC20 상단 ${fmt(c.dc_hi[i])} (${pct(c.dc_hi[i], last.close)}) · 청산선 DC10 하단 ${fmt(c.exit_lo[i])}`);
        rows.push(`재난 SL 폭 ${fmt(c.atr[i] * d.p.sl_mult)} (ATR×${d.p.sl_mult})`);
      } else {
        const cnt = c.sqz_cnt[i];
        rows.push(`스퀴즈 ${c.on[i] ? `<span class="up">ON</span> ${cnt}봉 연속` : '<span class="muted">OFF</span>'} ${cnt >= d.p.sqz_min_bars ? '· <span class="up">무장(6봉+)</span>' : `· 무장까지 ${Math.max(0, d.p.sqz_min_bars - cnt)}봉`}`);
        rows.push(`박스 상단 ${fmt(c.box_hi[i])} (${pct(c.box_hi[i], last.close)}) · BB 중심 ${fmt(c.mid[i])}`);
        rows.push(`BB ${fmt(c.bb_lo[i])}~${fmt(c.bb_up[i])} · KC ${fmt(c.kc_lo[i])}~${fmt(c.kc_up[i])}`);
      }
      const lastSig = c.signal.lastIndexOf(true);
      rows.push(c.signal[i] ? `<b class="up">▲ 이번 닫힌 봉에 롱 신호</b>` : lastSig >= 0 ? `최근 신호 ${new Date(closed[lastSig].time * 1000).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })} (${i - lastSig}봉 전)` : '최근 신호 없음(로드 구간)');
      html += `<ul>${rows.map(r => `<li>${r}</li>`).join('')}</ul>`;
    }
    panelEl.innerHTML = html;
    panelEl.classList.toggle('collapsed', collapsed);
    panelEl.querySelector('.hdr').addEventListener('click', () => { collapsed = !collapsed; try { localStorage.setItem('general-toe.botpanel.collapsed', collapsed ? '1' : ''); } catch {} renderPanel(); });
    panelEl.querySelectorAll('input[data-strat]').forEach(cb => cb.addEventListener('change', e => { stratOn[e.target.dataset.strat] = e.target.checked; render(); }));
  }

  async function refresh() {
    if (!enabled || !symbol) return;
    const my = ++token;
    try {
      const data = await fetchKlines(symbol, TF, 1000);
      if (my !== token) return;
      bars4h = data; closed = data.slice(0, -1);        // 형성 중 봉 제거 (봇과 동일)
      idx4h.clear(); closed.forEach((b, i) => idx4h.set(b.time, i));
      calc = {};
      if (STRATEGIES.DC_Trend.symbols.includes(symbol)) calc.DC_Trend = computeDC(closed);
      if (STRATEGIES.SQZ_X.symbols.includes(symbol)) calc.SQZ_X = computeSQZ(closed);
      render();
    } catch (e) { console.warn('botview refresh failed', e); onStatus && onStatus(`봇 뷰 4h 로드 실패: ${e.message}`); }
  }

  return {
    setEnabled(v) { enabled = !!v; clearInterval(timer); if (enabled) { refresh(); timer = setInterval(refresh, 60000); } else { render(); } },
    isEnabled: () => enabled,
    setSymbol(sym) { if (sym !== symbol) { symbol = sym; bars4h = []; closed = []; calc = {}; idx4h.clear(); } if (enabled) refresh(); else render(); },
    onBarsChanged() { if (enabled && closed.length) render(); },   // 차트 주기 변경·과거 로드 후 재매핑
    setStrategy(name, on) { if (name in stratOn) { stratOn[name] = !!on; render(); } },
    getStrategies: () => ({ ...stratOn }),
    refresh,
  };
}
