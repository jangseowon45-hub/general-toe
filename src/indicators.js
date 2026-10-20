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
