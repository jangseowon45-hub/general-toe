import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, createSeriesMarkers, CrosshairMode,
} from 'lightweight-charts';
import { INTERVALS, fetchKlines, subscribeKline } from './data.js';
import { sma, ema, rsi, bollinger } from './indicators.js';
import { parseTrades, tradesToMarkers, summarize } from './trades.js';
import { createDrawings } from './drawings.js';
import { createAlerts } from './alerts.js';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT'];
const INDICATORS = [
  { id: 'ma20', label: 'MA20', color: '#f5c542', calc: b => ({ main: sma(b, 20) }) },
  { id: 'ema50', label: 'EMA50', color: '#2962ff', calc: b => ({ main: ema(b, 50) }) },
  { id: 'ema200', label: 'EMA200', color: '#e040fb', calc: b => ({ main: ema(b, 200) }) },
  { id: 'bb', label: 'BB', color: '#26a69a', calc: b => bollinger(b, 20, 2) },
  { id: 'rsi', label: 'RSI', color: '#ff9800', pane: 1, calc: b => ({ main: rsi(b, 14) }) },
];
const UP = '#26a69a', DOWN = '#ef5350';

// ---- 상태 (localStorage 유지) ----
const KEY = 'coinchart.v1';
const state = Object.assign(
  { symbol: 'BTCUSDT', interval: '15m', ind: { ma20: true, ema50: true, rsi: true }, trades: true },
  JSON.parse(localStorage.getItem(KEY) || '{}'),
);
if (!INTERVALS[state.interval]) state.interval = '15m';
// 알림 클릭으로 열렸을 때 ?symbol=... 로 해당 심볼을 연다.
const urlSym = new URLSearchParams(location.search).get('symbol');
if (urlSym && SYMBOLS.includes(urlSym.toUpperCase())) state.symbol = urlSym.toUpperCase();
if (!SYMBOLS.includes(state.symbol)) state.symbol = 'BTCUSDT';
const save = () => localStorage.setItem(KEY, JSON.stringify(state));

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
const shift = pts => pts.map(p => ({ time: disp(p.time), value: p.value }));

// ---- 지표 시리즈 관리 ----
const indSeries = {}; // id -> { key: ISeriesApi }
function ensureIndicator(def) {
  if (indSeries[def.id]) return indSeries[def.id];
  const mk = (color, width = 1.5, style = 0) => chart.addSeries(LineSeries, {
    color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: def.pane === 1,
    crosshairMarkerVisible: false,
    ...(def.pane === 1 ? { priceFormat: { type: 'price', precision: 1, minMove: 0.1 } } : {}),
  }, def.pane || 0);
  const s = def.id === 'bb'
    ? { upper: mk(def.color, 1), middle: mk(def.color, 1, 2), lower: mk(def.color, 1) }
    : { main: mk(def.color) };
  indSeries[def.id] = s;
  if (def.pane === 1) {
    const p = chart.panes()[1];
    if (p) p.setHeight(Math.max(90, Math.round(el.clientHeight * 0.2)));
    s.main.createPriceLine({ price: 70, color: '#787b86', lineWidth: 1, lineStyle: 3, axisLabelVisible: false });
    s.main.createPriceLine({ price: 30, color: '#787b86', lineWidth: 1, lineStyle: 3, axisLabelVisible: false });
  }
  return s;
}
function removeIndicator(id) {
  const s = indSeries[id]; if (!s) return;
  Object.values(s).forEach(x => chart.removeSeries(x));
  delete indSeries[id];
}
function setIndicatorData(def, bars) {
  const s = ensureIndicator(def); const r = def.calc(bars);
  for (const k of Object.keys(s)) s[k].setData(shift(r[k] || []));
}
function updateIndicatorLast(def, bars) {
  const s = indSeries[def.id]; if (!s) return; const r = def.calc(bars);
  for (const k of Object.keys(s)) {
    const a = r[k];
    if (a && a.length) { const p = a[a.length - 1]; s[k].update({ time: disp(p.time), value: p.value }); }
  }
}
const activeIndicators = () => INDICATORS.filter(d => state.ind[d.id]);

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
  for (const def of INDICATORS) {
    if (state.ind[def.id]) setIndicatorData(def, bars); else removeIndicator(def.id);
  }
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
  for (const def of activeIndicators()) updateIndicatorLast(def, bars);
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
const indBox = $('indicators');
for (const def of INDICATORS) {
  const b = document.createElement('button'); b.textContent = def.label; b.style.setProperty('--c', def.color);
  b.className = `ind ${state.ind[def.id] ? 'on' : ''}`;
  b.addEventListener('click', () => {
    state.ind[def.id] = !state.ind[def.id]; save(); b.className = `ind ${state.ind[def.id] ? 'on' : ''}`;
    if (state.ind[def.id]) setIndicatorData(def, bars); else removeIndicator(def.id);
  });
  indBox.appendChild(b);
}
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
window.__drawings = drawings; // 콘솔 디버그용
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
