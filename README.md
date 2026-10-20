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
- 그리기 도구: 추세선(두 점 탭), 수평선(가격 탭), 사각형(두 점 탭), 지우개(그림 탭), 모두 삭제. 심볼별로 localStorage에 저장되며 봉 주기를 바꿔도 같은 자리에 그려진다. 도구가 켜진 동안은 차트 이동/확대가 꺼진다(탭이 이동으로 먹히지 않게). Esc로 커서 복귀.
- 가격 알림(🔔): 차트의 가격을 탭 → 가격 확인 → 중계 서버에 등록. 현재가보다 위면 ▲(상향 돌파), 아래면 ▼(하향 돌파). 발동하면 앱 알림(웹 푸시) + 텔레그램으로 온다. 알림 선은 노란 점선으로 표시. "알림 목록"에서 삭제·테스트.

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

## 알림 중계 서버 (relay/)

Oracle VM(봇 서버)에서 돌아가는 작은 FastAPI 서비스. 코드는 `relay/server.py`, 배포는 `relay/deploy.sh`.

- 주소: `https://161.33.190.248.sslip.io/relay/` (기존 Caddy 사이트에 `handle_path /relay/*` 로 추가, 내부 127.0.0.1:8787)
- 시세: Binance 선물 `!miniTicker@arr` 전 종목 1초 스트림. **이 VM에서는 `/ws/` 경로가 연결만 되고 데이터를 안 보내므로 `/market/stream?streams=` 경로를 쓴다**(기존 레코더와 동일).
- 인증: 모든 요청에 `X-Relay-Key` 헤더. 키는 서버 `/etc/general-toe-relay.env`의 `RELAY_KEY`. 앱의 ⚙에서 한 번 입력하면 그 기기에 저장된다.
- 전달: 웹 푸시(VAPID, 키는 서버 `vapid_private.pem`) + 텔레그램(봇 `.env`의 시장 알림 봇 토큰 재사용). 푸시 권한을 거부해도 텔레그램으로는 온다.
- 데이터: `relay.db`(SQLite) — devices(기기·푸시 구독), alerts(규칙·발동 기록). 기기당 활성 알림 50개 제한.
- 운영: `systemctl status general-toe-relay`, 로그 `journalctl -u general-toe-relay -f`, 헬스 `GET /relay/health`(인증 불필요).
- 갱신: `server.py` 고치고 `wsl -e bash -lc "bash /mnt/e/money/chart/relay/deploy.sh"` — venv·키·env·Caddy는 최초 1회만 만들고 이후엔 코드만 올리고 재시작한다.

## 하지 않는 것 / 2차 후보

- 지표 조건 알림(RSI 과매도 등): 봇의 alerts.py가 이미 텔레그램으로 보냄. 앱 통합은 미정
- 주식·환율: 거래소 공짜 피드 없음 → 증권사 Open API(한국투자증권 등)
- 그리기 도구(추세선 등), 멀티차트, 리플레이
- 네이티브 APK: Capacitor로 감싸면 되지만 Android SDK 설치가 먼저

## 선

트레이딩뷰의 로고·이름·유료 Charting Library·비공개 API는 쓰지 않는다. 개인 사용 목적.
