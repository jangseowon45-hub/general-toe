#!/usr/bin/env bash
# 서버에 중계 서비스를 설치/갱신한다. Windows Git Bash에서:
#   wsl -e bash -lc "bash /mnt/e/money/chart/relay/deploy.sh"
# 최초 1회: VAPID 키 생성, env 파일 작성(RELAY_KEY 생성, 봇 .env의 텔레그램 토큰 복사), Caddy 라우트 추가.
set -euo pipefail
SERVER=ubuntu@161.33.190.248
KEY=~/.ssh/id_ed25519
SRC=/mnt/e/money/chart/relay
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=10 $SERVER"

$SSH 'mkdir -p ~/general-toe-relay'
scp -q -i "$KEY" "$SRC/server.py" "$SRC/requirements.txt" "$SERVER:~/general-toe-relay/"
scp -q -i "$KEY" "$SRC/general-toe-relay.service" "$SERVER:/tmp/general-toe-relay.service"

$SSH 'bash -s' <<'REMOTE'
set -euo pipefail
cd ~/general-toe-relay
[ -d venv ] || python3 -m venv venv
venv/bin/pip install -q -r requirements.txt

# VAPID 키(최초 1회)
if [ ! -f vapid_private.pem ]; then
  venv/bin/python - <<'PY'
from py_vapid import Vapid
v = Vapid(); v.generate_keys(); v.save_key('vapid_private.pem')
print('vapid key generated')
PY
  chmod 600 vapid_private.pem
fi

# env 파일(최초 1회). RELAY_KEY는 랜덤 생성. 텔레그램 토큰은 봇 .env에서 복사(값은 출력하지 않음).
if [ ! -f /etc/general-toe-relay.env ]; then
  RELAY_KEY=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
  {
    echo "RELAY_KEY=$RELAY_KEY"
    echo "VAPID_PRIVATE_KEY_FILE=/home/ubuntu/general-toe-relay/vapid_private.pem"
    echo "VAPID_SUBJECT=mailto:general-toe@users.noreply.github.com"
    echo "ALLOWED_ORIGINS=https://jangseowon45-hub.github.io,http://localhost:5173"
    echo "DB_PATH=/home/ubuntu/general-toe-relay/relay.db"
    grep -E '^TELEGRAM_(BOT_TOKEN|CHAT_ID)=' ~/workspace_mo/.env || true
  } | sudo tee /etc/general-toe-relay.env >/dev/null
  sudo chmod 640 /etc/general-toe-relay.env
  sudo chown root:ubuntu /etc/general-toe-relay.env
  echo "env created"
fi

sudo mv /tmp/general-toe-relay.service /etc/systemd/system/general-toe-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now general-toe-relay >/dev/null
sudo systemctl restart general-toe-relay

# Caddy 라우트(최초 1회)
if ! sudo grep -q 'handle_path /relay/\*' /etc/caddy/Caddyfile; then
  sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%s)
  sudo python3 - <<'PY'
import re
p='/etc/caddy/Caddyfile'; s=open(p).read()
s=s.replace('    reverse_proxy 127.0.0.1:8000', '    handle_path /relay/* {\n        reverse_proxy 127.0.0.1:8787\n    }\n    reverse_proxy 127.0.0.1:8000', 1)
open(p,'w').write(s)
PY
  sudo caddy validate --config /etc/caddy/Caddyfile >/dev/null && sudo systemctl reload caddy
  echo "caddy route added"
fi

sleep 2
systemctl is-active general-toe-relay
curl -s http://127.0.0.1:8787/health; echo
REMOTE
