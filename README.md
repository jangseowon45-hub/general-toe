# general-toe — 개인용 코인 차트

- 저장소: https://github.com/jangseowon45-hub/general-toe
- 배포(PWA 설치 가능): https://jangseowon45-hub.github.io/general-toe/

트레이딩뷰 대신 쓰는 개인용 차트. Binance USDT-M 선물 공개 시세를 브라우저가 직접 받는다. 서버·API 키 없음.

- 차트 엔진: [Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache 2.0, 트레이딩뷰 공식 오픈소스)
- 데이터: `fapi.binance.com` REST(과거 1000봉, 왼쪽 스크롤 시 추가 로드) + `fstream.binance.com` WebSocket(실시간, 자동 재접속·끊긴 구간 백필)
- 지표: MA20, EMA50, EMA200, 볼린저(20,2), RSI(14, 별도 패널)
- 봇 체결 표시: `public/trades.csv`(blog/tools/pull_ledger.sh 출력 형식)를 읽어 진입(화살표)·청산(원, 손익) 마커로 찍는다. 상단 CSV 버튼으로 다른 파일도 불러올 수 있다.
- 시각 표시는 PC/폰의 로컬 시간대(KST). 원장 CSV의 시각은 UTC로 해석한다.
- 설정(심볼·주기·지표)은 localStorage에 유지된다.

## 실행

```bash
npm install
npm run dev        # http://localhost:5173 (같은 Wi-Fi의 폰에서는 Network 주소로 접속)
npm run build      # dist/ 에 정적 파일 생성 → 아무 정적 호스팅에 올리면 끝
```

## 체결 데이터 갱신

```bash
wsl -e bash -lc "bash /mnt/e/money/blog/tools/pull_ledger.sh"
cp ../blog/data/trades_$(date +%F).csv public/trades.csv
```

CSV에 `symbol` 컬럼이 없으면 진입가로 심볼을 추정한다: >10,000 BTC · >1,000 ETH · >20 SOL · 그 외 XRP.
원장에 symbol 컬럼을 추가하면 추정 없이 그대로 쓴다.

## 폰에 앱으로 설치(PWA)

`main`에 푸시하면 GitHub Actions(.github/workflows/pages.yml)가 빌드해서 GitHub Pages에 올린다.
폰 Chrome으로 https://jangseowon45-hub.github.io/general-toe/ 를 열고 메뉴 → "홈 화면에 추가"(또는 설치 배너). HTTPS가 필요하므로 LAN IP(http://192.168.x.x:5173)로는 차트만 보이고 설치는 안 된다.

## 하지 않는 것 / 2차 후보

- 알림(가격·지표): 앱이 꺼져 있을 때 받으려면 서버가 필요 → 봇이 도는 Oracle VM에 중계기 얹기
- 주식·환율: 거래소 공짜 피드 없음 → 증권사 Open API(한국투자증권 등)
- 그리기 도구(추세선 등), 멀티차트, 리플레이
- 네이티브 APK: Capacitor로 감싸면 되지만 Android SDK 설치가 먼저

## 선

트레이딩뷰의 로고·이름·유료 Charting Library·비공개 API는 쓰지 않는다. 개인 사용 목적.
