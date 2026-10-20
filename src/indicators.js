// 모두 {time, value} 배열을 돌려준다. 1000~3000봉 기준 전체 재계산해도 1ms 안팎.
export function sma(bars, n) {
  const out = []; let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= n) sum -= bars[i - n].close;
    if (i >= n - 1) out.push({ time: bars[i].time, value: sum / n });
  }
  return out;
}

export function ema(bars, n) {
  const out = []; const k = 2 / (n + 1); let prev; let seed = 0;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].close;
    if (i < n - 1) { seed += c; continue; }
    if (prev === undefined) prev = (seed + c) / n;
    else prev = c * k + prev * (1 - k);
    out.push({ time: bars[i].time, value: prev });
  }
  return out;
}

/** Wilder RSI */
export function rsi(bars, n = 14) {
  const out = []; let gain = 0, loss = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    if (i <= n) { gain += g; loss += l; if (i < n) continue; gain /= n; loss /= n; }
    else { gain = (gain * (n - 1) + g) / n; loss = (loss * (n - 1) + l) / n; }
    const v = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    out.push({ time: bars[i].time, value: v });
  }
  return out;
}

export function bollinger(bars, n = 20, k = 2) {
  const upper = [], middle = [], lower = [];
  let sum = 0, sq = 0;
  for (let i = 0; i < bars.length; i++) {
    const c = bars[i].close; sum += c; sq += c * c;
    if (i >= n) { const o = bars[i - n].close; sum -= o; sq -= o * o; }
    if (i >= n - 1) {
      const m = sum / n; const sd = Math.sqrt(Math.max(0, sq / n - m * m));
      middle.push({ time: bars[i].time, value: m });
      upper.push({ time: bars[i].time, value: m + k * sd });
      lower.push({ time: bars[i].time, value: m - k * sd });
    }
  }
  return { upper, middle, lower };
}

// ── 추가 지표 (지표 메뉴용) ──
// EMA(판다스 adjust=False 방식: 첫값 = 첫 입력). 기존 ema()는 SMA 시드라 초반 값이 다르다.
export function emaFrom(values, n) { const a = 2 / (n + 1); let y; return values.map(v => (y = y === undefined ? v : (1 - a) * y + a * v)); }
export function wilder(values, n) { const a = 1 / n; let y; return values.map(v => (y = y === undefined ? v : (1 - a) * y + a * v)); }
export function trueRange(bars) { return bars.map((b, i) => i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))); }
const pts = (bars, arr, from = 0) => { const out = []; for (let i = from; i < bars.length; i++) if (Number.isFinite(arr[i])) out.push({ time: bars[i].time, value: arr[i] }); return out; };

export function atrSeries(bars, n = 14) { return pts(bars, wilder(trueRange(bars), n), n); }

export function macd(bars, fast = 12, slow = 26, signal = 9) {
  const c = bars.map(b => b.close); const f = emaFrom(c, fast), s = emaFrom(c, slow);
  const line = f.map((v, i) => v - s[i]); const sig = emaFrom(line, signal);
  const hist = line.map((v, i) => v - sig[i]);
  return { macd: pts(bars, line, slow), signal: pts(bars, sig, slow), hist: pts(bars, hist, slow) };
}

export function donchian(bars, n = 20) {
  const up = [], lo = [], mid = [];
  for (let i = n - 1; i < bars.length; i++) {
    let h = -Infinity, l = Infinity; for (let j = i - n + 1; j <= i; j++) { if (bars[j].high > h) h = bars[j].high; if (bars[j].low < l) l = bars[j].low; }
    up.push({ time: bars[i].time, value: h }); lo.push({ time: bars[i].time, value: l }); mid.push({ time: bars[i].time, value: (h + l) / 2 });
  }
  return { upper: up, lower: lo, middle: mid };
}

export function keltner(bars, n = 20, mult = 1.5) {
  const mid = emaFrom(bars.map(b => b.close), n); const a = wilder(trueRange(bars), n);
  return { upper: pts(bars, mid.map((v, i) => v + mult * a[i]), n), middle: pts(bars, mid, n), lower: pts(bars, mid.map((v, i) => v - mult * a[i]), n) };
}

/** 슈퍼트렌드. 반환: 한 줄(value)과 방향(up=true). 색은 호출 쪽에서 segment 로 나눈다. */
export function supertrend(bars, n = 10, mult = 3) {
  const a = wilder(trueRange(bars), n); const out = [];
  let fu = NaN, fl = NaN, up = true;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]; const hl2 = (b.high + b.low) / 2; const bu = hl2 + mult * a[i], bl = hl2 - mult * a[i];
    if (i === 0 || !Number.isFinite(fu)) { fu = bu; fl = bl; out.push({ time: b.time, value: bl, up: true }); continue; }
    const pc = bars[i - 1].close;
    fl = (bl > fl || pc < fl) ? bl : fl;
    fu = (bu < fu || pc > fu) ? bu : fu;
    if (up && b.close < fl) up = false; else if (!up && b.close > fu) up = true;
    out.push({ time: b.time, value: up ? fl : fu, up });
  }
  return out.slice(n);
}

export function stochRsi(bars, rsiLen = 14, stochLen = 14, k = 3, d = 3) {
  const r = rsi(bars, rsiLen); const vals = r.map(p => p.value); const kraw = [];
  for (let i = 0; i < vals.length; i++) {
    if (i < stochLen - 1) { kraw.push(NaN); continue; }
    const w = vals.slice(i - stochLen + 1, i + 1); const lo = Math.min(...w), hi = Math.max(...w);
    kraw.push(hi === lo ? 0 : (vals[i] - lo) / (hi - lo) * 100);
  }
  const sma = (xs, n) => xs.map((_, i) => { if (i < n - 1 || xs.slice(i - n + 1, i + 1).some(v => !Number.isFinite(v))) return NaN; return xs.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n; });
  const kk = sma(kraw, k), dd = sma(kk, d);
  const mk = arr => r.map((p, i) => ({ time: p.time, value: arr[i] })).filter(p => Number.isFinite(p.value));
  return { k: mk(kk), d: mk(dd) };
}

/** 세션 VWAP (UTC 일 단위 리셋) */
export function vwap(bars) {
  const out = []; let day = null, pv = 0, vol = 0;
  for (const b of bars) {
    const d = Math.floor(b.time / 86400); if (d !== day) { day = d; pv = 0; vol = 0; }
    const tp = (b.high + b.low + b.close) / 3; pv += tp * b.volume; vol += b.volume;
    if (vol > 0) out.push({ time: b.time, value: pv / vol });
  }
  return out;
}

export function obv(bars) {
  const out = []; let v = 0;
  for (let i = 0; i < bars.length; i++) { if (i > 0) v += bars[i].close > bars[i - 1].close ? bars[i].volume : bars[i].close < bars[i - 1].close ? -bars[i].volume : 0; out.push({ time: bars[i].time, value: v }); }
  return out;
}
