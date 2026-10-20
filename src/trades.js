// 봇 원장 CSV(blog/tools/pull_ledger.sh 출력) → 차트 마커.
// 컬럼: id,strategy,side,entry_price,exit_price,margin_usdt,pnl_usdt,reason,opened_at,closed_at
// 시각은 UTC "YYYY-MM-DDTHH:MM". symbol 컬럼이 있으면 그대로 쓰고, 없으면 진입가로 추정한다.

export function parseTrades(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map(s => s.trim());
  const idx = Object.fromEntries(head.map((h, i) => [h, i]));
  const num = (row, k) => { const v = row[idx[k]]; return v === undefined || v === '' ? NaN : +v; };
  const ts = (row, k) => { const v = row[idx[k]]; if (!v) return NaN; const t = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(v) ? v : v + (v.length === 16 ? ':00Z' : 'Z')); return t / 1000; };
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i].split(',');
    if (row.length < head.length) continue;
    const entry = num(row, 'entry_price');
    const t = {
      id: row[idx.id], strategy: row[idx.strategy] || '', side: (row[idx.side] || '').toLowerCase(),
      entry, exit: num(row, 'exit_price'), margin: num(row, 'margin_usdt'), pnl: num(row, 'pnl_usdt'),
      reason: row[idx.reason] || '', opened: ts(row, 'opened_at'), closed: ts(row, 'closed_at'),
      symbol: idx.symbol !== undefined ? row[idx.symbol].toUpperCase() : inferSymbol(entry),
    };
    if (!Number.isFinite(t.opened)) continue;
    out.push(t);
  }
  return out;
}

/** 원장에 심볼이 없을 때 진입가 범위로 추정. 봇은 BTC·ETH·SOL(+조건부 XRP)만 거래한다. */
export function inferSymbol(price) {
  if (!Number.isFinite(price)) return null;
  if (price > 10000) return 'BTCUSDT';
  if (price > 1000) return 'ETHUSDT';
  if (price > 20) return 'SOLUSDT';
  return 'XRPUSDT';
}

const shortName = s => (s || '').split('_')[0];

/**
 * @param trades parseTrades 결과
 * @param symbol 현재 차트 심볼
 * @param step 봉 길이(초) — 마커 시각을 봉 시작으로 내림
 * @param minTime 로드된 첫 봉 시각(초, UTC)
 * @param disp 표시용 시각 변환(UTC초 → 차트 시각)
 */
export function tradesToMarkers(trades, symbol, step, minTime, disp) {
  const snap = t => Math.floor(t / step) * step;
  const m = [];
  for (const t of trades) {
    if (t.symbol !== symbol) continue;
    const long = t.side === 'long';
    const te = snap(t.opened);
    if (te >= minTime) m.push({
      time: disp(te), position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown',
      color: long ? '#26a69a' : '#ef5350', text: `${long ? 'L' : 'S'} ${shortName(t.strategy)}`, size: 1, id: `e${t.id}`,
    });
    if (Number.isFinite(t.closed)) {
      const tx = snap(t.closed);
      if (tx >= minTime) m.push({
        time: disp(tx), position: long ? 'aboveBar' : 'belowBar', shape: 'circle',
        color: t.pnl >= 0 ? '#26a69a' : '#ef5350', text: `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(1)}`, size: 1, id: `x${t.id}`,
      });
    }
  }
  m.sort((a, b) => a.time - b.time);
  return m;
}

export function summarize(trades, symbol) {
  const mine = trades.filter(t => t.symbol === symbol && Number.isFinite(t.pnl));
  if (!mine.length) return '';
  const pnl = mine.reduce((s, t) => s + t.pnl, 0);
  const wins = mine.filter(t => t.pnl > 0).length;
  return `${symbol.replace('USDT', '')} 체결 ${mine.length}건 · 승 ${wins} · 합계 ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`;
}
