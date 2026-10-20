import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers, CrosshairMode,
} from 'lightweight-charts';
import { INTERVALS, fetchKlines, subscribeKline } from './data.js';
import { CATALOG, PALETTE, GROUPS, paramLabel, shortName } from './catalog.js';
import { parseTrades, tradesToMarkers, summarize } from './trades.js';
import { createDrawings } from './drawings.js';
import { createAlerts } from './alerts.js';
import { createBotView, STRATEGIES } from './botview.js';
import { STRATEGY_CATALOG, signalMarkers, summarizeSignals, statsLabel, strategyLabel } from './strategies.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT'];
const UP = '#26a69a', DOWN = '#ef5350';

// ---- 상태 (localStorage 유지) ----
const KEY = 'coinchart.v1';
const state = Object.assign(
  { symbol: 'BTCUSDT', interval: '15m', trades: true },
  JSON.parse(localStorage.getItem(KEY) || '{}'),
);
if (!INTERVALS[state.interval]) state.interval = '15m';
// 알림 클릭으로 열렸을 때 ?symbol=... 로 해당 심볼을 연다.
const urlSym = new URLSearchParams(location.search).get('symbol');
if (urlSym && SYMBOLS.includes(urlSym.toUpperCase())) state.symbol = urlSym.toUpperCase();
if (!SYMBOLS.includes(state.symbol)) state.symbol = 'BTCUSDT';
const save = () => localStorage.setItem(KEY, JSON.stringify(state));
const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
// 지표 인스턴스 목록. 구버전(state.ind 불리언 맵)은 1회 변환.
if (!Array.isArray(state.indicators)) {
  const old = state.ind || { ma20: true, ema50: true, rsi: true };
  const map = { ma20: ['ma', { n: 20 }], ema50: ['ema', { n: 50 }], ema200: ['ema', { n: 200 }], bb: ['bb', { n: 20, k: 2 }], rsi: ['rsi', { n: 14 }] };
  state.indicators = Object.entries(map).filter(([k]) => old[k]).map(([, [type, params]], i) => ({ id: uid(), type, params, color: PALETTE[i % PALETTE.length] }));
  delete state.ind; save();
}
// 전략 인스턴스 목록 [{id,type,params,color}] — 지표와 같은 구조, 매수▲/매도▼ 화살표를 그린다.
if (!Array.isArray(state.strategies)) state.strategies = [];

// Lightweight Charts는 시각을 UTC로 그린다. 로컬(KST) 표시를 위해 오프셋만큼 밀어서 넣는다.
const TZ = -new Date().getTimezoneOffset() * 60;
const disp = t => t + TZ;

// ---- 차트 ----
const el = document.getElementById('chart');
const chart = createChart(el, {
  autoSize: true,
  layout: {
    background: { color: '#131722' }, textColor: '#d1d4dc',
    panes: { separatorColor: '#2a2e39', separatorHoverColor: '#2962ff', enableResize: true },
  },
  grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
  crosshair: { mode: CrosshairMode.Normal },
  rightPriceScale: { borderColor: '#2a2e39' },
  timeScale: { borderColor: '#2a2e39', timeVisible: true, secondsVisible: false, rightOffset: 6, barSpacing: 7 },
  localization: { locale: 'ko-KR' },
});
const candles = chart.addSeries(CandlestickSeries, {
  upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
  priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
});
const volume = chart.addSeries(HistogramSeries, {
  priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false,
});
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
const markers = createSeriesMarkers(candles, []);
const stratMarkers = createSeriesMarkers(candles, []); // 전략 신호 화살표 (봇 체결 마커와 별도 레이어)

// 그리기 도구 + 가격 알림 (bars/state는 아래에서 정의되지만 호출 시점에는 존재한다)
const drawings = createDrawings({
  chart, series: candles, container: el, toolbarEl: document.getElementById('shapeBar'),
  disp, undisp: t => t - TZ,
  getRange: () => (bars.length ? { firstTime: disp(bars[0].time), step: INTERVALS[state.interval] } : null),
  getBar: t => { if (!bars.length) return null; const step = INTERVALS[state.interval]; const bt = Math.floor(t / step) * step; let lo = 0, hi = bars.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].time === bt) return bars[m]; bars[m].time < bt ? lo = m + 1 : hi = m - 1; } return null; },
  getRemote: () => alerts.remoteDrawings(),
  onCustomClick: (tool, p) => { if (tool === 'alert') { drawings.setTool('cursor'); alerts.placeAtPrice(p.price); } },
  onStatus: msg => { const e = document.getElementById('alertStatus'); if (e) e.textContent = msg; },
});
const botView = createBotView({
  chart, series: candles, disp,
  getBars: () => bars, getStep: () => INTERVALS[state.interval], getSymbol: () => state.symbol,
  getRange: () => (bars.length ? { firstTime: disp(bars[0].time), step: INTERVALS[state.interval] } : null),
  panelEl: document.getElementById('botPanel'),
  onStatus: msg => { const e = document.getElementById('alertStatus'); if (e) e.textContent = msg; },
});
const alerts = createAlerts({
  series: candles,
  getSymbol: () => state.symbol,
  getPrice: () => (bars.length ? bars[bars.length - 1].close : 0),
  listEl: document.getElementById('alertList'),
  statusEl: document.getElementById('alertStatus'),
});

const toCandle = b => ({ time: disp(b.time), open: b.open, high: b.high, low: b.low, close: b.close });
const toVol = b => ({
  time: disp(b.time), value: b.volume,
  color: b.close >= b.open ? 'rgba(38,166,154,0.45)' : 'rgba(239,83,80,0.45)',
});

// ---- 지표 인스턴스 관리 (카탈로그 기반, 같은 지표 여러 개 가능) ----
const instSeries = new Map(); // inst.id -> { def, inst, series:{key: ISeriesApi}, pane, color }
const shiftPts = pts => pts.map(p => p.value === undefined ? { time: disp(p.time) } : { time: disp(p.time), value: p.value, ...(p.color ? { color: p.color } : {}) });
function buildIndicatorSeries() {
  for (const e of instSeries.values()) Object.values(e.series).forEach(x => chart.removeSeries(x));
  instSeries.clear();
  try { while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1); } catch {}
  let paneIdx = 1;
  state.indicators.forEach((inst, i) => {
    const def = CATALOG[inst.type]; if (!def) return;
    const pane = def.pane ? paneIdx++ : 0;
    const color = inst.color || PALETTE[i % PALETTE.length];
    const prec = def.precision ?? 2;
    const series = {};
    for (const [k, l] of Object.entries(def.lines)) {
      const common = {
        priceLineVisible: false, lastValueVisible: !!def.pane, crosshairMarkerVisible: false,
        title: l.title || (def.pane ? shortName(inst.type) : ''),
        ...(def.pane ? { priceFormat: { type: 'price', precision: prec, minMove: 1 / 10 ** prec } } : {}),
      };
      series[k] = l.type === 'hist'
        ? chart.addSeries(HistogramSeries, { ...common, color: l.color || color, base: 0 }, pane)
        : chart.addSeries(LineSeries, { ...common, color: l.color || color, lineWidth: l.width || 1.5, lineStyle: l.style || 0 }, pane);
    }
    if (def.pane) {
      const first = Object.values(series).find(x => x);
      (def.levels || []).forEach(lv => first.createPriceLine({ price: lv, color: '#787b86', lineWidth: 1, lineStyle: 3, axisLabelVisible: false }));
    }
    instSeries.set(inst.id, { def, inst, series, pane, color });
  });
  layoutPanes();
  setAllIndicatorData();
}
// 패널 높이: 지표 패널은 각각 같은 높이, 나머지는 메인 차트. 패널을 하나씩 만들며 setHeight 하면 라이브러리가 비율을 다시 나눠 이전 패널이 찌그러지므로 마지막에 한 번에 맞춘다.
function layoutPanes() {
  const panes = chart.panes(); const n = panes.length - 1; if (n <= 0) return;
  const total = el.clientHeight || 600;
  const h = Math.max(70, Math.min(130, Math.round(total * (n >= 3 ? 0.14 : 0.17))));
  // setHeight 는 마지막 호출만 정확히 반영되므로, 비율(stretch factor)을 전부 한 번에 준다.
  panes.forEach((p, i) => p.setStretchFactor(i === 0 ? Math.max(160, total - h * n) : h));
}
function setAllIndicatorData() {
  if (!bars.length) return;
  for (const e of instSeries.values()) { const r = e.def.build(bars, e.inst.params); for (const k of Object.keys(e.series)) e.series[k].setData(shiftPts(r[k] || [])); }
}
function updateIndicatorsLast() {
  for (const e of instSeries.values()) {
    const r = e.def.build(bars, e.inst.params);
    for (const k of Object.keys(e.series)) { const a = r[k]; if (a && a.length) e.series[k].update(shiftPts([a[a.length - 1]])[0]); }
  }
  updateStrategiesLast();
}

// ---- 전략 인스턴스 (보조선은 메인 패널에, 신호는 ▲▼ 마커로) ----
const stratSeries = new Map(); // inst.id -> { def, inst, series:{key}, color, stats }
let stratSig = '';             // 마지막으로 그린 신호 요약(변했을 때만 setMarkers)
function buildStrategySeries() {
  for (const e of stratSeries.values()) Object.values(e.series).forEach(x => chart.removeSeries(x));
  stratSeries.clear();
  state.strategies.forEach((inst, i) => {
    const def = STRATEGY_CATALOG[inst.type]; if (!def) return;
    const color = inst.color || PALETTE[(i + 3) % PALETTE.length];
    const series = {};
    for (const [k, l] of Object.entries(def.lines)) {
      series[k] = chart.addSeries(LineSeries, {
        color: l.color || color, lineWidth: l.width || 1.5, lineStyle: l.style || 0,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: l.title || '',
      }, 0);
    }
    stratSeries.set(inst.id, { def, inst, series, color, stats: null });
  });
  stratSig = '';
  setAllStrategyData();
}
// 신호는 닫힌 봉까지만(형성 중 봉은 깜빡임 방지로 제외). 보조선은 형성 중 봉까지 그린다.
function computeStrategies() {
  const closed = bars.slice(0, -1); const all = []; const many = stratSeries.size > 1;
  for (const e of stratSeries.values()) {
    const full = e.def.build(bars, e.inst.params);
    const r = closed.length ? e.def.build(closed, e.inst.params) : { signals: [] };
    e.stats = summarizeSignals(closed, r.signals);
    e.lines = full.lines;
    all.push(...signalMarkers(closed, r.signals, many ? e.def.short : '', disp));
  }
  all.sort((a, b) => a.time - b.time);
  return all;
}
function applyStrategyMarkers(all) {
  const sig = all.length + ':' + (all.length ? all[all.length - 1].time + all[all.length - 1].text : '') + ':' + [...stratSeries.keys()].join(',');
  if (sig === stratSig) return;
  stratSig = sig; stratMarkers.setMarkers(all);
  renderChips(); if (indDlg.open) renderDialog();
}
function setAllStrategyData() {
  if (!bars.length || !stratSeries.size) { if (!stratSeries.size) { stratMarkers.setMarkers([]); stratSig = ''; } return; }
  const all = computeStrategies();
  for (const e of stratSeries.values()) for (const k of Object.keys(e.series)) e.series[k].setData(shiftPts(e.lines[k] || []));
  applyStrategyMarkers(all);
}
function updateStrategiesLast() {
  if (!bars.length || !stratSeries.size) return;
  const all = computeStrategies();
  for (const e of stratSeries.values()) for (const k of Object.keys(e.series)) { const a = e.lines[k]; if (a && a.length) e.series[k].update(shiftPts([a[a.length - 1]])[0]); }
  applyStrategyMarkers(all);
}

// ---- 데이터 ----
let bars = [];            // 오름차순, time=UTC초
let closeWs = null;
let token = 0;            // 심볼/주기 전환 시 늦게 도착한 응답 무시
let loadingOlder = false, noMoreOlder = false;
let trades = [];

const $ = id => document.getElementById(id);
const setConn = (s, label) => { const c = $('conn'); c.className = `conn ${s}`; c.textContent = label; };
const CONN_LABEL = {
  connecting: '연결 중…', open: '실시간', closed: '끊김', reconnecting: '재연결 중…', loading: '불러오는 중…', error: '오류',
};

function fmtPrice(p) {
  return p >= 1000
    ? p.toLocaleString('ko-KR', { maximumFractionDigits: 1 })
    : p.toLocaleString('ko-KR', { maximumFractionDigits: p >= 1 ? 3 : 5 });
}
function updatePriceLabel() {
  if (bars.length < 2) return;
  const last = bars[bars.length - 1], prev = bars[bars.length - 2];
  const chg = (last.close / prev.close - 1) * 100;
  const e = $('price');
  e.textContent = `${fmtPrice(last.close)}  ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
  e.className = last.close >= prev.close ? 'up' : 'down';
}

function applyPrecision() {
  const p = bars.length ? bars[bars.length - 1].close : 1000;
  const precision = p >= 1000 ? 1 : p >= 10 ? 2 : p >= 1 ? 3 : 5;
  candles.applyOptions({ priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision } });
}

function renderAll({ fit }) {
  candles.setData(bars.map(toCandle));
  volume.setData(bars.map(toVol));
  setAllIndicatorData();
  setAllStrategyData();
  renderMarkers();
  applyPrecision();
  updatePriceLabel();
  if (fit) chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 120), to: bars.length + 6 });
}
function renderMarkers() {
  if (!state.trades || !bars.length) { markers.setMarkers([]); $('tradeinfo').textContent = ''; return; }
  markers.setMarkers(tradesToMarkers(trades, state.symbol, INTERVALS[state.interval], bars[0].time, disp));
  $('tradeinfo').textContent = summarize(trades, state.symbol);
}

function onLiveBar(bar) {
  const last = bars[bars.length - 1];
  if (!last) return;
  if (bar.time === last.time) bars[bars.length - 1] = bar;
  else if (bar.time > last.time) bars.push(bar);
  else return;
  candles.update(toCandle(bar)); volume.update(toVol(bar));
  updateIndicatorsLast();
  updatePriceLabel();
}

async function backfillGap(myToken) {
  // 재연결 후 끊긴 동안의 봉을 REST로 메운다.
  try {
    const recent = await fetchKlines(state.symbol, state.interval, 200);
    if (myToken !== token) return;
    const byTime = new Map(bars.map(b => [b.time, b]));
    for (const b of recent) byTime.set(b.time, b);
    bars = [...byTime.values()].sort((a, b) => a.time - b.time);
    renderAll({ fit: false });
  } catch (e) { console.warn('backfill failed', e); }
}

async function loadOlder() {
  if (loadingOlder || noMoreOlder || !bars.length) return;
  loadingOlder = true; const myToken = token;
  try {
    const older = await fetchKlines(state.symbol, state.interval, 1000, bars[0].time * 1000 - 1);
    if (myToken !== token) return;
    if (!older.length) { noMoreOlder = true; return; }
    const range = chart.timeScale().getVisibleLogicalRange();
    const lastOld = older[older.length - 1].time;
    bars = older.concat(bars.filter(b => b.time > lastOld));
    renderAll({ fit: false });
    botView.onBarsChanged();
    if (range) chart.timeScale().setVisibleLogicalRange({ from: range.from + older.length, to: range.to + older.length });
  } catch (e) { console.warn('loadOlder failed', e); }
  finally { loadingOlder = false; }
}
chart.timeScale().subscribeVisibleLogicalRangeChange(r => { if (r && r.from < 40) loadOlder(); });

async function loadSymbol() {
  const myToken = ++token;
  if (closeWs) { closeWs(); closeWs = null; }
  noMoreOlder = false; loadingOlder = false;
  setConn('loading', CONN_LABEL.loading);
  document.title = `${state.symbol.replace('USDT', '')} · ${state.interval} · general-toe`;
  try {
    const data = await fetchKlines(state.symbol, state.interval, 1000);
    if (myToken !== token) return;
    bars = data;
    renderAll({ fit: true });
    drawings.load(state.symbol);
    alerts.onSymbolChange();
    botView.setSymbol(state.symbol);
  } catch (e) {
    console.error(e); setConn('error', `시세 로드 실패: ${e.message}`); return;
  }
  closeWs = subscribeKline(state.symbol, state.interval, onLiveBar, (s, reconnected) => {
    if (myToken !== token) return;
    setConn(s, CONN_LABEL[s] || s);
    if (s === 'open' && reconnected) backfillGap(myToken);
  });
}

// ---- 봇 체결 CSV ----
async function loadDefaultTrades() {
  try {
    const r = await fetch(import.meta.env.BASE_URL + 'trades.csv', { cache: 'no-store' });
    if (r.ok) { trades = parseTrades(await r.text()); renderMarkers(); }
  } catch (e) { console.warn('trades.csv 없음', e); }
}
$('csvFile').addEventListener('change', async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  trades = parseTrades(await f.text());
  state.trades = true; $('showTrades').checked = true; save(); renderMarkers();
  e.target.value = '';
});

// ---- UI ----
const symSel = $('symbol');
for (const s of SYMBOLS) {
  const o = document.createElement('option'); o.value = s; o.textContent = s.replace('USDT', '/USDT'); symSel.appendChild(o);
}
symSel.value = state.symbol;
symSel.addEventListener('change', () => { state.symbol = symSel.value; save(); loadSymbol(); });

const ivBox = $('intervals');
for (const iv of Object.keys(INTERVALS)) {
  const b = document.createElement('button'); b.textContent = iv; b.className = iv === state.interval ? 'on' : '';
  b.addEventListener('click', () => {
    state.interval = iv; save();
    [...ivBox.children].forEach(x => { x.className = x.textContent === iv ? 'on' : ''; });
    loadSymbol();
  });
  ivBox.appendChild(b);
}
// ---- 지표 칩 + 지표 메뉴 ----
function renderChips() {
  const box = $('indicators'); box.innerHTML = '';
  state.indicators.forEach((inst, i) => {
    const e = instSeries.get(inst.id); const color = (e && e.color) || inst.color || PALETTE[i % PALETTE.length];
    const c = document.createElement('span'); c.className = 'ichip'; c.style.setProperty('--c', color); c.title = (CATALOG[inst.type] && CATALOG[inst.type].name) || inst.type;
    c.innerHTML = `<span class="lbl">${paramLabel(inst.type, inst.params)}</span><button class="rm" title="제거">✕</button>`;
    c.querySelector('.lbl').addEventListener('click', () => editIndicator(inst.id));
    c.querySelector('.rm').addEventListener('click', ev => { ev.stopPropagation(); removeIndicatorInst(inst.id); });
    box.appendChild(c);
  });
  state.strategies.forEach((inst, i) => {
    const def = STRATEGY_CATALOG[inst.type]; if (!def) return;
    const e = stratSeries.get(inst.id); const color = (e && e.color) || inst.color || PALETTE[(i + 3) % PALETTE.length];
    const c = document.createElement('span'); c.className = 'ichip strat'; c.style.setProperty('--c', color);
    c.title = `${def.name}\n${def.desc}` + (e && e.stats ? '\n' + statsLabel(e.stats) : '');
    c.innerHTML = `<span class="lbl">⚡ ${esc(strategyLabel(inst.type, inst.params))}</span><button class="rm" title="제거">✕</button>`;
    c.querySelector('.lbl').addEventListener('click', () => editStrategy(inst.id));
    c.querySelector('.rm').addEventListener('click', ev => { ev.stopPropagation(); removeStrategyInst(inst.id); });
    box.appendChild(c);
  });
}
function afterIndicatorsChange() { save(); buildIndicatorSeries(); renderChips(); renderDialog(); }
function afterStrategiesChange() { save(); buildStrategySeries(); renderChips(); renderDialog(); }
function addStrategy(type) {
  const def = STRATEGY_CATALOG[type]; if (!def) return;
  state.strategies.push({ id: uid(), type, params: { ...def.params }, color: PALETTE[(state.strategies.length + 3) % PALETTE.length] });
  afterStrategiesChange();
}
function removeStrategyInst(id) { state.strategies = state.strategies.filter(x => x.id !== id); afterStrategiesChange(); }
function editStrategy(id) {
  const inst = state.strategies.find(x => x.id === id); if (!inst) return;
  const def = STRATEGY_CATALOG[inst.type]; const keys = Object.keys(def.params); if (!keys.length) return;
  const ans = prompt(`${def.name} 파라미터 (${keys.join(', ')})`, keys.map(k => inst.params[k]).join(', '));
  if (ans == null) return;
  const vals = ans.split(',').map(v => parseFloat(v.trim()));
  if (vals.length !== keys.length || vals.some(v => !Number.isFinite(v) || v <= 0)) { alert('값이 올바르지 않아요'); return; }
  keys.forEach((k, i) => { inst.params[k] = vals[i]; });
  afterStrategiesChange();
}
function addIndicator(type) {
  const def = CATALOG[type]; if (!def) return;
  state.indicators.push({ id: uid(), type, params: { ...def.params }, color: PALETTE[state.indicators.length % PALETTE.length] });
  afterIndicatorsChange();
}
function removeIndicatorInst(id) { state.indicators = state.indicators.filter(x => x.id !== id); afterIndicatorsChange(); }
function editIndicator(id) {
  const inst = state.indicators.find(x => x.id === id); if (!inst) return;
  const def = CATALOG[inst.type]; const keys = Object.keys(def.params); if (!keys.length) return;
  const ans = prompt(`${def.name} 파라미터 (${keys.join(', ')})`, keys.map(k => inst.params[k]).join(', '));
  if (ans == null) return;
  const vals = ans.split(',').map(v => parseFloat(v.trim()));
  if (vals.length !== keys.length || vals.some(v => !Number.isFinite(v) || v <= 0)) { alert('값이 올바르지 않아요'); return; }
  keys.forEach((k, i) => { inst.params[k] = vals[i]; });
  afterIndicatorsChange();
}
const indDlg = $('indicatorDialog');
const esc = t => String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
function renderDialog() {
  if (!indDlg.open) return;
  const q = ($('indSearch').value || '').trim().toLowerCase();
  const match = txt => !q || txt.toLowerCase().includes(q);
  const pstr = p => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' ');
  let html = '';
  const mine = state.indicators.filter(inst => CATALOG[inst.type] && match(CATALOG[inst.type].name + ' ' + inst.type));
  const myStrats = state.strategies.filter(inst => STRATEGY_CATALOG[inst.type] && match(STRATEGY_CATALOG[inst.type].name + ' ' + inst.type + ' 전략'));
  if (mine.length || myStrats.length) html += '<h4>적용 중</h4>'
    + mine.map(inst => { const d = CATALOG[inst.type]; return `<div class="item active" style="--c:${inst.color}"><span class="nm">${d.name} <span class="muted">${esc(pstr(inst.params))}</span></span><span class="ds">${d.desc}</span><span class="act"><button data-edit="${inst.id}" ${Object.keys(d.params).length ? '' : 'disabled'}>설정</button><button class="danger" data-rm="${inst.id}">제거</button></span></div>`; }).join('')
    + myStrats.map(inst => { const d = STRATEGY_CATALOG[inst.type]; const e = stratSeries.get(inst.id); return `<div class="item active" style="--c:${inst.color}"><span class="nm">⚡ ${d.name} <span class="muted">${esc(pstr(inst.params))}</span></span><span class="ds">${d.desc}</span>${e && e.stats ? `<span class="st">${statsLabel(e.stats)}</span>` : ''}<span class="act"><button data-edit-strat="${inst.id}">설정</button><button class="danger" data-rm-strat="${inst.id}">제거</button></span></div>`; }).join('');
  const sitems = Object.entries(STRATEGY_CATALOG).filter(([t, d]) => match(`${d.name} ${d.desc} ${t} ${d.short} 전략 매수 매도`));
  if (sitems.length) html += '<h4>전략 (매수 ▲ · 매도 ▼ 화살표 · 닫힌 봉 기준)</h4>' + sitems.map(([t, d]) => `<div class="item"><span class="nm">⚡ ${d.name}</span><span class="ds">${d.desc} · 기본 ${esc(pstr(d.params))}</span><span class="act"><button class="primary" data-add-strat="${t}">추가</button></span></div>`).join('');
  const strats = Object.entries(STRATEGIES).filter(([n, d]) => match(n + ' ' + d.desc + ' 봇 전략'));
  if (strats.length) html += '<h4>봇 전략 (4h · 봇과 같은 계산)</h4>' + strats.map(([n, d]) => `<label class="strat"><input type="checkbox" data-strat="${n}" ${state.botView && botView.getStrategies()[n] ? 'checked' : ''}><span><b style="color:${d.color}">${d.label}</b> <span class="muted">${d.symbols.map(x => x.replace('USDT', '')).join('·')}</span><br><span class="ds muted">${d.desc}</span></span></label>`).join('');
  for (const g of GROUPS) {
    const items = Object.entries(CATALOG).filter(([t, d]) => d.group === g && match(`${d.name} ${d.desc} ${t} ${shortName(t)}`));
    if (!items.length) continue;
    html += `<h4>${g}</h4>` + items.map(([t, d]) => `<div class="item"><span class="nm">${d.name}</span><span class="ds">${d.desc}${Object.keys(d.params).length ? ' · 기본 ' + esc(pstr(d.params)) : ''}</span><span class="act"><button class="primary" data-add="${t}">추가</button></span></div>`).join('');
  }
  $('indBody').innerHTML = html || '<p class="empty">검색 결과 없음</p>';
}
$('indBody').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.add) addIndicator(b.dataset.add);
  else if (b.dataset.rm) removeIndicatorInst(b.dataset.rm);
  else if (b.dataset.edit) editIndicator(b.dataset.edit);
  else if (b.dataset.addStrat) addStrategy(b.dataset.addStrat);
  else if (b.dataset.rmStrat) removeStrategyInst(b.dataset.rmStrat);
  else if (b.dataset.editStrat) editStrategy(b.dataset.editStrat);
});
$('indBody').addEventListener('change', e => {
  const cb = e.target.closest('input[data-strat]'); if (!cb) return;
  if (cb.checked && !state.botView) { state.botView = true; $('botView').checked = true; save(); botView.setEnabled(true); }
  botView.setStrategy(cb.dataset.strat, cb.checked);
});
$('indSearch').addEventListener('input', renderDialog);
$('addIndicator').addEventListener('click', () => { $('indSearch').value = ''; indDlg.showModal(); renderDialog(); $('indSearch').focus(); });
$('indClose').addEventListener('click', () => indDlg.close());
indDlg.addEventListener('click', e => { if (e.target === indDlg) indDlg.close(); });
buildIndicatorSeries(); buildStrategySeries(); renderChips();
$('botView').checked = !!state.botView;
$('botView').addEventListener('change', e => { state.botView = e.target.checked; save(); botView.setEnabled(state.botView); });
if (state.botView) botView.setEnabled(true);
$('showTrades').checked = !!state.trades;
$('showTrades').addEventListener('change', e => { state.trades = e.target.checked; save(); renderMarkers(); });

// ---- 그리기 도구 / 알림 UI ----
const toolBox = $('tools');
toolBox.querySelectorAll('button[data-tool]').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.tool;
  if (t === 'alert' && !alerts.hasKey()) { openSettings(); return; }
  drawings.setTool(drawings.getTool() === t && t !== 'cursor' ? 'cursor' : t);
}));
drawings.onToolChange(t => {
  toolBox.querySelectorAll('button[data-tool]').forEach(b => { b.className = b.dataset.tool === t ? 'on' : ''; });
  el.classList.toggle('tool-active', t !== 'cursor');
});
$('clearDrawings').addEventListener('click', () => {
  if (drawings.count() && confirm(`${state.symbol.replace('USDT', '')} 차트의 그림 ${drawings.count()}개를 모두 지울까요?`)) drawings.clearAll();
});
window.__drawings = drawings; window.__chart = chart; // 콘솔 디버그용
$('undoBtn').addEventListener('click', () => drawings.undo());
$('redoBtn').addEventListener('click', () => drawings.redo());
$('magnetBtn').addEventListener('click', () => { drawings.setMagnet(!drawings.getMagnet()); $('magnetBtn').classList.toggle('on', drawings.getMagnet()); });
const panel = $('alertPanel');
$('toggleAlerts').addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) alerts.refresh(); });
$('testPush').addEventListener('click', () => { if (!alerts.hasKey()) { openSettings(); return; } alerts.testPush(); });
$('alertList').addEventListener('click', e => { if (e.target.closest('.open-settings')) openSettings(); });

const dlg = $('settings');
function openSettings() {
  const c = alerts.getConfig(); $('relayUrl').value = c.relay; $('relayKey').value = c.key;
  dlg.showModal();
}
$('settingsBtn').addEventListener('click', openSettings);
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'ok') return;
  alerts.setConfig({ relay: $('relayUrl').value, key: $('relayKey').value });
});

// ---- 시작 ----
loadSymbol();
loadDefaultTrades();
alerts.start();
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch(e => console.warn('sw', e)));
}
