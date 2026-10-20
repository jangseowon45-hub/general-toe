// 전략 카탈로그 — 지표 카탈로그(catalog.js)와 같은 구조에 "신호"가 추가된다.
// 각 항목: build(bars, params) → { lines:{key:[{time,value}]}, signals:[{i, side:'buy'|'sell'}] }
// 신호는 닫힌 봉 기준(마지막 형성 중 봉은 호출 쪽에서 제외), 매수→매도→매수 순으로 번갈아만 남긴다(롱 온리 관점).
import { ema, rsi, bollinger, macd, donchian, keltner, supertrend } from './indicators.js';

// {time,value} 배열을 bars 인덱스에 맞춘 숫자 배열로 (빈 곳은 NaN)
function align(bars, pts) {
  const idx = new Map(); bars.forEach((b, i) => idx.set(b.time, i));
  const out = new Array(bars.length).fill(NaN);
  for (const p of pts) { const i = idx.get(p.time); if (i != null && p.value !== undefined) out[i] = p.value; }
  return out;
}
const at = (x, i) => (typeof x === 'number' ? x : x[i]);
const ok = (...v) => v.every(Number.isFinite);
// a가 b를 아래→위로 뚫음 (b는 배열 또는 상수)
const crossUp = (a, b, i) => i > 0 && ok(at(a, i), at(b, i), at(a, i - 1), at(b, i - 1)) && at(a, i - 1) <= at(b, i - 1) && at(a, i) > at(b, i);
const crossDn = (a, b, i) => i > 0 && ok(at(a, i), at(b, i), at(a, i - 1), at(b, i - 1)) && at(a, i - 1) >= at(b, i - 1) && at(a, i) < at(b, i);
const closes = bars => bars.map(b => b.close);

// 매수/매도 조건 배열 → 번갈아 나오는 신호 목록
function alternate(buy, sell) {
  const out = []; let inPos = false;
  for (let i = 0; i < buy.length; i++) {
    if (!inPos && buy[i]) { out.push({ i, side: 'buy' }); inPos = true; }
    else if (inPos && sell[i]) { out.push({ i, side: 'sell' }); inPos = false; }
  }
  return out;
}

export const STRATEGY_CATALOG = {
  macross: {
    name: 'EMA 크로스 (골든·데드)', short: 'EMA크로스', desc: '단기 EMA가 장기 EMA를 위로 뚫으면 매수, 아래로 뚫으면 매도',
    params: { fast: 9, slow: 21 },
    lines: { fast: { width: 1.5, title: 'EMA 단기' }, slow: { width: 1.5, style: 2, title: 'EMA 장기' } },
    build(bars, p) {
      const f = ema(bars, p.fast), s = ema(bars, p.slow); const fa = align(bars, f), sa = align(bars, s);
      return { lines: { fast: f, slow: s }, signals: alternate(bars.map((_, i) => crossUp(fa, sa, i)), bars.map((_, i) => crossDn(fa, sa, i))) };
    },
  },
  rsirev: {
    name: 'RSI 반전', short: 'RSI반전', desc: 'RSI가 과매도선(30)을 위로 되돌리면 매수, 과매수선(70)을 아래로 되돌리면 매도',
    params: { n: 14, low: 30, high: 70 }, lines: {},
    build(bars, p) {
      const r = align(bars, rsi(bars, p.n));
      return { lines: {}, signals: alternate(bars.map((_, i) => crossUp(r, p.low, i)), bars.map((_, i) => crossDn(r, p.high, i))) };
    },
  },
  macdcross: {
    name: 'MACD 크로스', short: 'MACD', desc: 'MACD선이 시그널선을 위로 뚫으면 매수, 아래로 뚫으면 매도',
    params: { fast: 12, slow: 26, signal: 9 }, lines: {},
    build(bars, p) {
      const m = macd(bars, p.fast, p.slow, p.signal); const a = align(bars, m.macd), s = align(bars, m.signal);
      return { lines: {}, signals: alternate(bars.map((_, i) => crossUp(a, s, i)), bars.map((_, i) => crossDn(a, s, i))) };
    },
  },
  bbrev: {
    name: '볼린저 반전', short: 'BB반전', desc: '종가가 하단밴드 아래서 다시 위로 올라오면 매수, 상단밴드 위에서 다시 아래로 내려오면 매도',
    params: { n: 20, k: 2 },
    lines: { upper: { width: 1 }, middle: { width: 1, style: 2 }, lower: { width: 1 } },
    build(bars, p) {
      const bb = bollinger(bars, p.n, p.k); const c = closes(bars); const lo = align(bars, bb.lower), up = align(bars, bb.upper);
      return { lines: bb, signals: alternate(bars.map((_, i) => crossUp(c, lo, i)), bars.map((_, i) => crossDn(c, up, i))) };
    },
  },
  dcbreak: {
    name: '돈치안 돌파 (터틀)', short: 'DC돌파', desc: '종가가 직전 n봉 최고가를 넘으면 매수, 직전 exit봉 최저가를 깨면 매도 (봇 DC_Trend 계열)',
    params: { n: 20, exit: 10 },
    lines: { upper: { width: 1.5, title: '진입선' }, lower: { width: 1, style: 2, title: '청산선' } },
    build(bars, p) {
      const d = donchian(bars, p.n), x = donchian(bars, p.exit); const c = closes(bars);
      const hi = align(bars, d.upper), lo = align(bars, x.lower);
      // 직전 봉까지의 채널(shift 1) 기준
      const buy = bars.map((_, i) => i > 0 && ok(hi[i - 1]) && c[i] > hi[i - 1] && c[i - 1] <= hi[i - 1]);
      const sell = bars.map((_, i) => i > 0 && ok(lo[i - 1]) && c[i] < lo[i - 1]);
      return { lines: { upper: d.upper, lower: x.lower }, signals: alternate(buy, sell) };
    },
  },
  stflip: {
    name: '슈퍼트렌드 전환', short: 'ST전환', desc: '슈퍼트렌드가 하락→상승으로 바뀌면 매수, 상승→하락으로 바뀌면 매도',
    params: { n: 10, mult: 3 },
    lines: { up: { width: 2, color: '#26a69a', title: 'ST↑' }, down: { width: 2, color: '#ef5350', title: 'ST↓' } },
    build(bars, p) {
      const st = supertrend(bars, p.n, p.mult); const dir = align(bars, st.map(x => ({ time: x.time, value: x.up ? 1 : 0 })));
      const buy = bars.map((_, i) => i > 0 && ok(dir[i - 1], dir[i]) && dir[i - 1] === 0 && dir[i] === 1);
      const sell = bars.map((_, i) => i > 0 && ok(dir[i - 1], dir[i]) && dir[i - 1] === 1 && dir[i] === 0);
      return {
        lines: {
          up: st.map(x => x.up ? { time: x.time, value: x.value } : { time: x.time }),
          down: st.map(x => !x.up ? { time: x.time, value: x.value } : { time: x.time }),
        },
        signals: alternate(buy, sell),
      };
    },
  },
  sqzbreak: {
    name: '스퀴즈 돌파', short: '스퀴즈', desc: 'BB가 KC 안에 min봉 이상 압축된 뒤 직전 박스 상단을 종가로 넘으면 매수, KC 중심선(EMA)을 깨면 매도 (봇 SQZ_X 계열)',
    params: { n: 20, k: 2, mult: 1.5, min: 6 },
    lines: { bbu: { width: 1, color: '#26a69a' }, bbl: { width: 1, color: '#26a69a' }, kcu: { width: 1, style: 2, color: '#ff9800' }, kcl: { width: 1, style: 2, color: '#ff9800' } },
    build(bars, p) {
      const bb = bollinger(bars, p.n, p.k), kc = keltner(bars, p.n, p.mult); const c = closes(bars);
      const bu = align(bars, bb.upper), bl = align(bars, bb.lower), ku = align(bars, kc.upper), kl = align(bars, kc.lower), km = align(bars, kc.middle);
      const on = bars.map((_, i) => ok(bu[i], ku[i], bl[i], kl[i]) && bu[i] < ku[i] && bl[i] > kl[i]);
      const cnt = []; let k = 0; for (const o of on) { k = o ? k + 1 : 0; cnt.push(k); }
      const box = Math.max(p.min, 4); const bh = align(bars, donchian(bars, box).upper);
      const buy = bars.map((_, i) => i > 0 && cnt[i - 1] >= p.min && ok(bh[i - 1]) && c[i] > bh[i - 1]);
      const sell = bars.map((_, i) => crossDn(c, km, i));
      return { lines: { bbu: bb.upper, bbl: bb.lower, kcu: kc.upper, kcl: kc.lower }, signals: alternate(buy, sell) };
    },
  },
  emapull: {
    name: 'EMA 눌림목', short: '눌림목', desc: '종가가 장기 EMA 위(상승장)일 때 저가가 단기 EMA를 건드리고 종가가 다시 그 위에서 반등하면 매수, 종가가 단기 EMA 아래로 내려가면 매도',
    params: { pull: 20, trend: 200 },
    lines: { pull: { width: 1.5, title: 'EMA 단기' }, trend: { width: 1, style: 1, title: 'EMA 장기' } },
    build(bars, p) {
      const pe = ema(bars, p.pull), te = ema(bars, p.trend); const pa = align(bars, pe), ta = align(bars, te); const c = closes(bars);
      const buy = bars.map((b, i) => i > 0 && ok(pa[i], ta[i]) && c[i] > ta[i] && b.low <= pa[i] && c[i] > pa[i] && c[i] > c[i - 1]);
      const sell = bars.map((_, i) => crossDn(c, pa, i));
      return { lines: { pull: pe, trend: te }, signals: alternate(buy, sell) };
    },
  },
};

// 신호 → 차트 마커 (매수 ▲ 초록, 봉 아래 / 매도 ▼ 빨강, 봉 위). 캔들 색보다 밝게 해서 구분.
// label 이 있으면 "매수·EMA크로스" 식으로 붙인다(전략이 2개 이상일 때).
export const BUY_COLOR = '#00e676', SELL_COLOR = '#ff1744';
export function signalMarkers(bars, signals, label, disp) {
  return signals.map(s => ({
    time: disp(bars[s.i].time), position: s.side === 'buy' ? 'belowBar' : 'aboveBar',
    shape: s.side === 'buy' ? 'arrowUp' : 'arrowDown', color: s.side === 'buy' ? BUY_COLOR : SELL_COLOR, size: 1,
    text: (s.side === 'buy' ? '매수' : '매도') + (label ? '·' + label : ''),
  }));
}

// 단순 롱 온리 성과: 매수 종가→다음 매도 종가 수익률 합(수수료·레버리지 없음). 열린 포지션은 마지막 봉 종가로 평가.
export function summarizeSignals(bars, signals) {
  let trades = 0, wins = 0, total = 0, entry = null, open = null;
  for (const s of signals) {
    if (s.side === 'buy') entry = bars[s.i].close;
    else if (entry != null) { const r = bars[s.i].close / entry - 1; total += r; trades++; if (r > 0) wins++; entry = null; }
  }
  if (entry != null && bars.length) open = bars[bars.length - 1].close / entry - 1;
  const buys = signals.filter(s => s.side === 'buy').length, sells = signals.length - buys;
  return { buys, sells, trades, wins, total, open };
}
export function statsLabel(st) {
  const pc = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  let s = `매수 ▲${st.buys} · 매도 ▼${st.sells}`;
  if (st.trades) s += ` · ${st.trades}회 누적 ${pc(st.total)} · 승률 ${Math.round(st.wins / st.trades * 100)}%`;
  if (st.open != null) s += ` · 보유 중 ${pc(st.open)}`;
  return s;
}
export function strategyLabel(type, params) {
  const def = STRATEGY_CATALOG[type]; if (!def) return type;
  const vals = Object.values(params || {});
  return vals.length ? `${def.short} ${vals.join(',')}` : def.short;
}
