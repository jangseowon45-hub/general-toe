"""
general-toe 알림 중계 서버.

- 앱(PWA)이 가격 알림 규칙을 등록하면, 서버가 Binance 선물 미니티커 스트림을 보고 조건 충족 시
  웹 푸시(앱 알림)로 보내고, 텔레그램 토큰이 있으면 같은 내용을 텔레그램에도 보낸다.
- Caddy가 /relay/* 를 이 서버(127.0.0.1:8787)로 넘긴다(접두사 제거).
- 인증: 모든 요청에 X-Relay-Key 헤더 == RELAY_KEY 환경변수. 키가 없으면 401.

환경변수(/etc/general-toe-relay.env):
  RELAY_KEY, VAPID_PRIVATE_KEY_FILE, VAPID_SUBJECT(mailto:...), ALLOWED_ORIGINS(쉼표),
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID(선택), DB_PATH(기본 ./relay.db)
"""
import asyncio
import json
import logging
import os
import sqlite3
import time
from contextlib import asynccontextmanager
from typing import Optional

import requests
import websockets
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from pywebpush import WebPushException, webpush
from py_vapid import Vapid

log = logging.getLogger("relay")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

RELAY_KEY = os.environ.get("RELAY_KEY", "")
VAPID_FILE = os.environ.get("VAPID_PRIVATE_KEY_FILE", "vapid_private.pem")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:relay@example.com")
ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o.strip()]
TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "")
DB_PATH = os.environ.get("DB_PATH", "relay.db")
# 주의: 이 VM에서는 /ws/<stream> 경로가 연결만 되고 데이터를 보내지 않는다. 기존 레코더처럼 /market/stream 을 쓴다.
WS_URL = os.environ.get("WS_URL", "wss://fstream.binance.com/market/stream?streams=!miniTicker@arr")

# ── VAPID ─────────────────────────────────────────────────────────
vapid = Vapid.from_file(VAPID_FILE)
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
import base64
_pub_raw = vapid.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
VAPID_PUBLIC_B64 = base64.urlsafe_b64encode(_pub_raw).rstrip(b"=").decode()

# ── DB ────────────────────────────────────────────────────────────
def db():
    c = sqlite3.connect(DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c

def init_db():
    with db() as c:
        c.executescript(
            """
            create table if not exists devices(
              id text primary key, endpoint text, p256dh text, auth text,
              created real, last_seen real);
            create table if not exists alerts(
              id integer primary key autoincrement, device_id text not null,
              symbol text not null, price real not null, direction text not null,
              note text default '', created real not null,
              triggered_at real, triggered_price real);
            create index if not exists alerts_active on alerts(symbol) where triggered_at is null;
            create table if not exists drawings(
              symbol text not null, shape_id text not null, data text, updated real not null,
              deleted integer not null default 0, primary key(symbol, shape_id));
            """
        )

# ── 모델 ──────────────────────────────────────────────────────────
class Keys(BaseModel):
    p256dh: str
    auth: str

class Subscription(BaseModel):
    endpoint: str
    keys: Keys

class RegisterBody(BaseModel):
    device_id: str = Field(min_length=8, max_length=64)
    subscription: Optional[Subscription] = None

class AlertBody(BaseModel):
    device_id: str = Field(min_length=8, max_length=64)
    symbol: str = Field(min_length=5, max_length=20)
    price: float = Field(gt=0)
    direction: str = Field(pattern="^(above|below)$")
    note: str = Field(default="", max_length=80)

# ── 인증 ──────────────────────────────────────────────────────────
def require_key(x_relay_key: str = Header(default="")):
    if not RELAY_KEY or x_relay_key != RELAY_KEY:
        raise HTTPException(401, "bad key")

# ── 전송 ──────────────────────────────────────────────────────────
def send_push(dev: sqlite3.Row, payload: dict) -> bool:
    if not dev["endpoint"]:
        return False
    try:
        webpush(
            subscription_info={"endpoint": dev["endpoint"], "keys": {"p256dh": dev["p256dh"], "auth": dev["auth"]}},
            data=json.dumps(payload, ensure_ascii=False),
            vapid_private_key=VAPID_FILE,
            vapid_claims={"sub": VAPID_SUBJECT},
            ttl=3600,
        )
        return True
    except WebPushException as e:
        code = getattr(e.response, "status_code", None)
        log.warning("push failed device=%s code=%s", dev["id"], code)
        if code in (404, 410):
            with db() as c:
                c.execute("update devices set endpoint=null, p256dh=null, auth=null where id=?", (dev["id"],))
        return False
    except Exception as e:  # noqa: BLE001
        log.warning("push error device=%s %s", dev["id"], e)
        return False

def send_telegram(text: str) -> bool:
    if not (TG_TOKEN and TG_CHAT):
        return False
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json={"chat_id": TG_CHAT, "text": text, "disable_web_page_preview": True},
            timeout=10,
        )
        return r.status_code == 200
    except Exception as e:  # noqa: BLE001
        log.warning("telegram error %s", e)
        return False

def fmt(p: float) -> str:
    return f"{p:,.1f}" if p >= 1000 else f"{p:,.4f}".rstrip("0").rstrip(".")

def fire(alert: sqlite3.Row, price: float):
    now = time.time()
    with db() as c:
        cur = c.execute(
            "update alerts set triggered_at=?, triggered_price=? where id=? and triggered_at is null",
            (now, price, alert["id"]),
        )
        if cur.rowcount == 0:
            return
        dev = c.execute("select * from devices where id=?", (alert["device_id"],)).fetchone()
    sym = alert["symbol"].replace("USDT", "")
    arrow = "▲" if alert["direction"] == "above" else "▼"
    title = f"{sym} {arrow} {fmt(alert['price'])}"
    body = f"현재 {fmt(price)}" + (f" · {alert['note']}" if alert["note"] else "")
    payload = {"title": title, "body": body, "alert_id": alert["id"], "symbol": alert["symbol"], "price": price}
    ok_push = send_push(dev, payload) if dev else False
    ok_tg = send_telegram(f"🔔 general-toe {title}\n{body}")
    log.info("fired alert=%s %s push=%s tg=%s", alert["id"], title, ok_push, ok_tg)

# ── 시세 감시 ──────────────────────────────────────────────────────
last_price: dict[str, float] = {}
ws_state = {"connected": False, "last_msg": 0.0}

def evaluate(prices: dict[str, float]):
    if not prices:
        return
    with db() as c:
        rows = c.execute("select * from alerts where triggered_at is null").fetchall()
    for a in rows:
        p = prices.get(a["symbol"])
        if p is None:
            continue
        if (a["direction"] == "above" and p >= a["price"]) or (a["direction"] == "below" and p <= a["price"]):
            fire(a, p)

async def watch_prices():
    delay = 1
    while True:
        try:
            async with websockets.connect(WS_URL, ping_interval=180, ping_timeout=10, max_size=8_000_000, open_timeout=15) as ws:
                ws_state["connected"] = True
                delay = 1
                log.info("ws connected")
                async for raw in ws:
                    msg = json.loads(raw)
                    arr = msg.get("data", msg) if isinstance(msg, dict) else msg  # combined stream은 {stream,data} 래핑
                    if not isinstance(arr, list):
                        arr = [arr]
                    ws_state["last_msg"] = time.time()
                    for t in arr:
                        s = t.get("s")
                        if s and s.endswith("USDT"):
                            last_price[s] = float(t["c"])
                    await asyncio.to_thread(evaluate, dict(last_price))
        except Exception as e:  # noqa: BLE001
            ws_state["connected"] = False
            log.warning("ws closed: %s — retry in %ss", e, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)

# ── 앱 ────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    task = asyncio.create_task(watch_prices())
    yield
    task.cancel()

app = FastAPI(title="general-toe relay", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=ORIGINS, allow_methods=["*"], allow_headers=["*"], allow_credentials=False,
)

@app.get("/health")
def health():
    with db() as c:
        n = c.execute("select count(*) from alerts where triggered_at is null").fetchone()[0]
    return {"ok": True, "ws": ws_state["connected"], "last_msg_age": round(time.time() - ws_state["last_msg"], 1) if ws_state["last_msg"] else None,
            "active_alerts": n, "symbols": len(last_price), "telegram": bool(TG_TOKEN and TG_CHAT)}

@app.get("/vapid", dependencies=[Depends(require_key)])
def vapid_key():
    return {"publicKey": VAPID_PUBLIC_B64}

@app.post("/register", dependencies=[Depends(require_key)])
def register(b: RegisterBody):
    now = time.time()
    with db() as c:
        if b.subscription:
            c.execute(
                """insert into devices(id,endpoint,p256dh,auth,created,last_seen) values(?,?,?,?,?,?)
                   on conflict(id) do update set endpoint=excluded.endpoint, p256dh=excluded.p256dh,
                   auth=excluded.auth, last_seen=excluded.last_seen""",
                (b.device_id, b.subscription.endpoint, b.subscription.keys.p256dh, b.subscription.keys.auth, now, now),
            )
        else:
            c.execute(
                """insert into devices(id,created,last_seen) values(?,?,?)
                   on conflict(id) do update set last_seen=excluded.last_seen""",
                (b.device_id, now, now),
            )
        dev = c.execute("select * from devices where id=?", (b.device_id,)).fetchone()
    return {"device_id": b.device_id, "push": bool(dev["endpoint"])}

@app.get("/alerts", dependencies=[Depends(require_key)])
def list_alerts(device_id: str):
    with db() as c:
        active = c.execute("select * from alerts where device_id=? and triggered_at is null order by id", (device_id,)).fetchall()
        done = c.execute("select * from alerts where device_id=? and triggered_at is not null order by triggered_at desc limit 20", (device_id,)).fetchall()
    return {"active": [dict(r) for r in active], "triggered": [dict(r) for r in done], "prices": {s: last_price.get(s) for s in {r["symbol"] for r in active}}}

@app.post("/alerts", dependencies=[Depends(require_key)])
def create_alert(b: AlertBody):
    sym = b.symbol.upper()
    with db() as c:
        n = c.execute("select count(*) from alerts where device_id=? and triggered_at is null", (b.device_id,)).fetchone()[0]
        if n >= 50:
            raise HTTPException(400, "too many active alerts")
        cur = c.execute(
            "insert into alerts(device_id,symbol,price,direction,note,created) values(?,?,?,?,?,?)",
            (b.device_id, sym, b.price, b.direction, b.note.strip(), time.time()),
        )
        row = c.execute("select * from alerts where id=?", (cur.lastrowid,)).fetchone()
    return dict(row)

@app.delete("/alerts/{alert_id}", dependencies=[Depends(require_key)])
def delete_alert(alert_id: int, device_id: str):
    with db() as c:
        cur = c.execute("delete from alerts where id=? and device_id=?", (alert_id, device_id))
    if cur.rowcount == 0:
        raise HTTPException(404, "not found")
    return {"deleted": alert_id}

# ── 그리기 동기화 ──────────────────────────────────────────────────
# 키(=계정) 단위로 심볼별 도형을 저장한다. 도형별 updated 로 최신 것이 이기고, 삭제는 tombstone 으로 전파한다.
class DrawingsDoc(BaseModel):
    shapes: list = Field(default_factory=list)
    tombstones: list = Field(default_factory=list)

def _drawings_doc(c: sqlite3.Connection, symbol: str) -> dict:
    rows = c.execute("select shape_id, data, updated, deleted from drawings where symbol=?", (symbol,)).fetchall()
    shapes, tombs = [], []
    for r in rows:
        if r["deleted"]:
            tombs.append({"id": r["shape_id"], "updated": r["updated"]})
        else:
            try:
                shapes.append(json.loads(r["data"]))
            except Exception:  # noqa: BLE001
                pass
    return {"shapes": shapes, "tombstones": tombs}

@app.get("/drawings/{symbol}", dependencies=[Depends(require_key)])
def get_drawings(symbol: str):
    with db() as c:
        return _drawings_doc(c, symbol.upper())

@app.put("/drawings/{symbol}", dependencies=[Depends(require_key)])
def put_drawings(symbol: str, doc: DrawingsDoc):
    sym = symbol.upper()
    if len(doc.shapes) > 500:
        raise HTTPException(400, "too many shapes")
    with db() as c:
        for s in doc.shapes:
            sid = str(s.get("id", ""))[:40]
            upd = float(s.get("updated") or 0)
            if not sid:
                continue
            cur = c.execute("select updated, deleted from drawings where symbol=? and shape_id=?", (sym, sid)).fetchone()
            if cur is None or upd > cur["updated"]:
                c.execute(
                    """insert into drawings(symbol,shape_id,data,updated,deleted) values(?,?,?,?,0)
                       on conflict(symbol,shape_id) do update set data=excluded.data, updated=excluded.updated, deleted=0""",
                    (sym, sid, json.dumps(s, ensure_ascii=False), upd),
                )
        for t in doc.tombstones:
            sid = str(t.get("id", ""))[:40]
            upd = float(t.get("updated") or 0)
            if not sid:
                continue
            cur = c.execute("select updated from drawings where symbol=? and shape_id=?", (sym, sid)).fetchone()
            if cur is None or upd >= cur["updated"]:
                c.execute(
                    """insert into drawings(symbol,shape_id,data,updated,deleted) values(?,?,null,?,1)
                       on conflict(symbol,shape_id) do update set data=null, updated=excluded.updated, deleted=1""",
                    (sym, sid, upd),
                )
        c.execute("delete from drawings where deleted=1 and updated < ?", (time.time() - 30 * 86400,))
        return _drawings_doc(c, sym)

@app.post("/test", dependencies=[Depends(require_key)])
def test_push(device_id: str):
    with db() as c:
        dev = c.execute("select * from devices where id=?", (device_id,)).fetchone()
    if not dev:
        raise HTTPException(404, "unknown device")
    ok = send_push(dev, {"title": "general-toe 테스트", "body": "알림이 이 기기로 도착합니다.", "test": True})
    tg = send_telegram("🔔 general-toe 테스트 알림")
    return {"push": ok, "telegram": tg}
