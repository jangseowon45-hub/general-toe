// Binance USDT-M 선물 공개 시세. API 키 불필요.
export const INTERVALS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
const REST = 'https://fapi.binance.com/fapi/v1/klines';
// 주의(2026-10 실측): fstream.binance.com 의 /ws/<stream> 과 /stream?streams= 경로는 연결은 되지만
// 메시지를 한 건도 보내지 않는 경우가 잦다(한국 브라우저·Oracle VM 모두). /market/stream 경로만 안정적이다.
// 순서대로 시도하고, 데이터가 STALE_MS 동안 없으면 다음 경로로 넘어간다.
const WS_URLS = [
  (s, iv) => `wss://fstream.binance.com/market/stream?streams=${s}@kline_${iv}`,
  (s, iv) => `wss://fstream.binance.com/stream?streams=${s}@kline_${iv}`,
  (s, iv) => `wss://fstream.binance.com/ws/${s}@kline_${iv}`,
];
const STALE_MS = 20000;

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
  let ws, timer, staleTimer, attempt = 0, urlIdx = 0, stopped = false, gotData = false;

  const armStale = () => {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      // 연결은 살아있는데 데이터가 없다 → 죽은 소켓. 다음 경로로 넘기고 재연결.
      if (!gotData) urlIdx = (urlIdx + 1) % WS_URLS.length;
      gotData = false;
      console.warn(`kline stream stale ${STALE_MS / 1000}s → reconnect (url #${urlIdx})`);
      try { ws && ws.close(); } catch {}
    }, STALE_MS);
  };

  const connect = () => {
    if (stopped) return;
    const reconnected = attempt > 0;
    onStatus(reconnected ? 'reconnecting' : 'connecting', reconnected);
    gotData = false;
    ws = new WebSocket(WS_URLS[urlIdx](symbol.toLowerCase(), interval));
    ws.onopen = () => { attempt = 0; onStatus('open', reconnected); armStale(); };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.data) m = m.data;              // combined stream 래핑 {stream, data}
      if (m.e !== 'kline') return;
      gotData = true; armStale();
      const k = m.k;
      onBar({ time: k.t / 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, closed: !!k.x });
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onclose = () => {
      clearTimeout(staleTimer);
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
    clearTimeout(timer); clearTimeout(staleTimer);
    document.removeEventListener('visibilitychange', onVisible);
    try { ws && ws.close(); } catch {}
  };
}
