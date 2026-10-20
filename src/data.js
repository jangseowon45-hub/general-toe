// Binance USDT-M 선물 공개 시세. API 키 불필요.
export const INTERVALS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const REST = 'https://fapi.binance.com/fapi/v1/klines';
const WS_BASE = 'wss://fstream.binance.com/ws';

function restToBar(k) {
  return { time: k[0] / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
}

/** 과거 캔들. endTime(ms)을 주면 그 이전 limit개. 오름차순 배열 반환. */
export async function fetchKlines(symbol, interval, limit = 1000, endTime) {
  const u = new URL(REST);
  u.searchParams.set('symbol', symbol);
  u.searchParams.set('interval', interval);
  u.searchParams.set('limit', String(limit));
  if (endTime) u.searchParams.set('endTime', String(endTime));
  const r = await fetch(u);
  if (!r.ok) throw new Error(`klines ${r.status}`);
  return (await r.json()).map(restToBar);
}

/**
 * 실시간 캔들 구독. onBar(bar) — bar.closed가 true면 확정 캔들.
 * onStatus(state, reconnected) — state: connecting|open|closed|reconnecting
 * 반환값은 구독 해제 함수.
 */
export function subscribeKline(symbol, interval, onBar, onStatus) {
  let ws, timer, attempt = 0, stopped = false;

  const connect = () => {
    if (stopped) return;
    onStatus(attempt ? 'reconnecting' : 'connecting', attempt > 0);
    ws = new WebSocket(`${WS_BASE}/${symbol.toLowerCase()}@kline_${interval}`);
    const reconnected = attempt > 0;
    ws.onopen = () => { attempt = 0; onStatus('open', reconnected); };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.e !== 'kline') return;
      const k = m.k;
      onBar({ time: k.t / 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, closed: !!k.x });
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onclose = () => {
      if (stopped) return;
      onStatus('closed', false);
      const delay = Math.min(30000, 1000 * 2 ** attempt++);
      timer = setTimeout(connect, delay);
    };
  };

  // 모바일에서 백그라운드 복귀 시 죽은 소켓을 바로 되살린다.
  const onVisible = () => {
    if (document.visibilityState === 'visible' && ws && ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) {
      clearTimeout(timer); connect();
    }
  };
  document.addEventListener('visibilitychange', onVisible);

  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
    try { ws && ws.close(); } catch {}
  };
}
