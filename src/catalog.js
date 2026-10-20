// 지표 카탈로그 — 트레이딩뷰 Indicators 메뉴처럼 이름·설명·기본 파라미터·그리기 규칙을 한곳에 둔다.
// 각 항목: build(bars, params) → { key: [{time, value, color?}] }  (time=UTC초; 표시 변환은 호출 쪽)
// lines: key → { type:'line'|'hist', color, width, style, title }   pane: true 면 별도 패널
import { sma, ema, rsi, bollinger, atrSeries, macd, donchian, keltner, supertrend, stochRsi, vwap, obv } from './indicators.js';

export const PALETTE = ['#f5c542', '#2962ff', '#e040fb', '#26a69a', '#ff9800', '#ef5350', '#00bcd4', '#e8eaf0'];

export const CATALOG = {
  ma:    { name: '이동평균 (SMA)', group: '추세', desc: '단순 이동평균', params: { n: 20 },
           lines: { main: { type: 'line', width: 1.5 } }, build: (b, p) => ({ main: sma(b, p.n) }) },
  ema:   { name: '지수이동평균 (EMA)', group: '추세', desc: '최근 가격에 가중치', params: { n: 50 },
           lines: { main: { type: 'line', width: 1.5 } }, build: (b, p) => ({ main: ema(b, p.n) }) },
  vwap:  { name: 'VWAP', group: '추세', desc: '거래량 가중 평균가 (UTC 일 세션)', params: {},
           lines: { main: { type: 'line', width: 1.5, style: 2 } }, build: b => ({ main: vwap(b) }) },
  supertrend: { name: '슈퍼트렌드', group: '추세', desc: 'ATR 기반 추세 추적선', params: { n: 10, mult: 3 },
           lines: { up: { type: 'line', width: 2, color: '#26a69a', title: 'ST↑' }, down: { type: 'line', width: 2, color: '#ef5350', title: 'ST↓' } },
           build: (b, p) => { const st = supertrend(b, p.n, p.mult); return {
             up: st.map(x => x.up ? { time: x.time, value: x.value } : { time: x.time }),
             down: st.map(x => !x.up ? { time: x.time, value: x.value } : { time: x.time }) }; } },
  bb:    { name: '볼린저 밴드', group: '변동성', desc: 'SMA ± k×표준편차', params: { n: 20, k: 2 },
           lines: { upper: { type: 'line', width: 1 }, middle: { type: 'line', width: 1, style: 2 }, lower: { type: 'line', width: 1 } },
           build: (b, p) => bollinger(b, p.n, p.k) },
  donchian: { name: '돈치안 채널', group: '변동성', desc: 'n봉 최고·최저 (봇 DC_Trend 계열)', params: { n: 20 },
           lines: { upper: { type: 'line', width: 1.5 }, middle: { type: 'line', width: 1, style: 1 }, lower: { type: 'line', width: 1.5 } },
           build: (b, p) => donchian(b, p.n) },
  keltner: { name: '켈트너 채널', group: '변동성', desc: 'EMA ± mult×ATR (봇 SQZ_X 계열)', params: { n: 20, mult: 1.5 },
           lines: { upper: { type: 'line', width: 1 }, middle: { type: 'line', width: 1, style: 2 }, lower: { type: 'line', width: 1 } },
           build: (b, p) => keltner(b, p.n, p.mult) },
  rsi:   { name: 'RSI', group: '모멘텀', desc: '상대강도지수 (70/30)', params: { n: 14 }, pane: true, levels: [70, 30], precision: 1,
           lines: { main: { type: 'line', width: 1.5 } }, build: (b, p) => ({ main: rsi(b, p.n) }) },
  stochrsi: { name: '스토캐스틱 RSI', group: '모멘텀', desc: 'RSI의 스토캐스틱 (80/20)', params: { rsi: 14, stoch: 14, k: 3, d: 3 }, pane: true, levels: [80, 20], precision: 1,
           lines: { k: { type: 'line', width: 1.5, color: '#2962ff', title: 'K' }, d: { type: 'line', width: 1, color: '#ff9800', title: 'D' } },
           build: (b, p) => stochRsi(b, p.rsi, p.stoch, p.k, p.d) },
  macd:  { name: 'MACD', group: '모멘텀', desc: 'EMA 차이 + 시그널 + 히스토그램', params: { fast: 12, slow: 26, signal: 9 }, pane: true, precision: 2,
           lines: { hist: { type: 'hist' }, macd: { type: 'line', width: 1.5, color: '#2962ff', title: 'MACD' }, signal: { type: 'line', width: 1, color: '#ff9800', title: 'Signal' } },
           build: (b, p) => { const m = macd(b, p.fast, p.slow, p.signal); m.hist = m.hist.map(x => ({ ...x, color: x.value >= 0 ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)' })); return m; } },
  atr:   { name: 'ATR', group: '변동성', desc: '평균 진폭 (Wilder)', params: { n: 14 }, pane: true, precision: 2,
           lines: { main: { type: 'line', width: 1.5 } }, build: (b, p) => ({ main: atrSeries(b, p.n) }) },
  obv:   { name: 'OBV', group: '거래량', desc: '누적 거래량 흐름', params: {}, pane: true, precision: 0,
           lines: { main: { type: 'line', width: 1.5 } }, build: b => ({ main: obv(b) }) },
};

export const GROUPS = ['추세', '변동성', '모멘텀', '거래량'];

export function paramLabel(type, params) {
  const def = CATALOG[type]; if (!def) return type;
  const vals = Object.values(params || {});
  return vals.length ? `${shortName(type)} ${vals.join(',')}` : shortName(type);
}
export function shortName(type) {
  return { ma: 'MA', ema: 'EMA', vwap: 'VWAP', supertrend: 'ST', bb: 'BB', donchian: 'DC', keltner: 'KC', rsi: 'RSI', stochrsi: 'StochRSI', macd: 'MACD', atr: 'ATR', obv: 'OBV' }[type] || type;
}
