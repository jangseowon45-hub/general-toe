// 가격 알림: Oracle VM 중계 서버(relay/server.py)에 규칙을 등록하고, 서버가 웹 푸시 + 텔레그램으로 보낸다.
// 설정(중계 주소, 키)은 localStorage. 기기 ID는 최초 1회 생성.

const KEY = 'general-toe.alerts';
const DEFAULT_RELAY = 'https://161.33.190.248.sslip.io/relay';

function loadCfg() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  if (!c.deviceId) { c.deviceId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/-/g, '').slice(0, 32); }
  if (!c.relay) c.relay = DEFAULT_RELAY;
  localStorage.setItem(KEY, JSON.stringify(c));
  return c;
}
const b64ToU8 = s => { const pad = '='.repeat((4 - s.length % 4) % 4); const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, ch => ch.charCodeAt(0)); };
const fmt = p => p >= 1000 ? p.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) : p.toLocaleString('ko-KR', { maximumFractionDigits: p >= 1 ? 3 : 5 });

export function createAlerts({ series, getSymbol, getPrice, listEl, statusEl }) {
  const cfg = loadCfg();
  let active = [], triggered = [], lines = new Map();
  let pushState = 'unknown'; // unknown|on|off|unsupported
  let timer = null;

  const api = async (path, opts = {}) => {
    if (!cfg.key) throw new Error('중계 키가 설정되지 않았어요(⚙)');
    const r = await fetch(cfg.relay.replace(/\/$/, '') + path, {
      ...opts, headers: { 'Content-Type': 'application/json', 'X-Relay-Key': cfg.key, ...(opts.headers || {}) },
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text().catch(() => '')}`.trim());
    return r.json();
  };

  async function ensureRegistered() {
    let subscription = null;
    if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) {
      try {
        // dev 서버(SW 미등록)에서는 ready가 영원히 안 풀리므로 getRegistration으로 확인한다.
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) throw new Error('no service worker (dev)');
        let perm = Notification.permission;
        if (perm === 'default') perm = await Notification.requestPermission();
        if (perm === 'granted') {
          let sub = await reg.pushManager.getSubscription();
          if (!sub) {
            const { publicKey } = await api('/vapid');
            sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey) });
          }
          subscription = sub.toJSON();
          pushState = 'on';
        } else pushState = 'off';
      } catch (e) { console.warn('push subscribe failed', e); pushState = 'off'; }
    } else pushState = 'unsupported';
    await api('/register', { method: 'POST', body: JSON.stringify({ device_id: cfg.deviceId, subscription }) });
  }

  // ── 차트 선 ──
  function drawLines() {
    for (const l of lines.values()) series.removePriceLine(l);
    lines.clear();
    const sym = getSymbol();
    for (const a of active) {
      if (a.symbol !== sym) continue;
      lines.set(a.id, series.createPriceLine({
        price: a.price, color: '#f5c542', lineWidth: 1, lineStyle: 2, axisLabelVisible: true,
        title: `🔔 ${a.direction === 'above' ? '▲' : '▼'}${a.note ? ' ' + a.note : ''}`,
      }));
    }
  }

  // ── 목록 ──
  function renderList() {
    if (!listEl) return;
    const sym = getSymbol();
    const row = a => `<li data-id="${a.id}"><span class="sym">${a.symbol.replace('USDT', '')}</span>
      <span class="dir ${a.direction}">${a.direction === 'above' ? '▲' : '▼'}</span>
      <span class="px">${fmt(a.price)}</span><span class="note">${a.note || ''}</span>
      <button class="del" title="삭제">✕</button></li>`;
    const done = a => `<li class="done"><span class="sym">${a.symbol.replace('USDT', '')}</span>
      <span class="dir ${a.direction}">${a.direction === 'above' ? '▲' : '▼'}</span>
      <span class="px">${fmt(a.price)}</span><span class="note">${new Date(a.triggered_at * 1000).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 발동</span></li>`;
    const mine = active.filter(a => a.symbol === sym), others = active.filter(a => a.symbol !== sym);
    if (!cfg.key) {
      listEl.innerHTML = `<div class="hdr">알림 중계 미설정</div>
        <p class="setup">가격 알림을 쓰려면 중계 서버 키를 한 번 입력해야 해요. 키는 PC의 <code>chart/.relay-key.local</code> 또는 서버의 <code>/etc/general-toe-relay.env</code>에 있어요.</p>
        <button class="chip open-settings">⚙ 설정 열기</button>`;
      return;
    }
    listEl.innerHTML = `
      <div class="hdr">활성 알림 ${active.length}개 <span class="push ${pushState}">${{ on: '앱 알림 켜짐', off: '앱 알림 꺼짐 · 텔레그램만', unsupported: '이 브라우저는 푸시 미지원', unknown: '' }[pushState]}</span></div>
      <ul>${mine.map(row).join('')}${others.map(row).join('')}${active.length ? '' : '<li class="empty">알림 없음. 🔔 도구를 켜고 차트의 가격을 탭하세요.</li>'}</ul>
      ${triggered.length ? `<div class="hdr">최근 발동</div><ul>${triggered.slice(0, 5).map(done).join('')}</ul>` : ''}`;
    listEl.querySelectorAll('button.del').forEach(b => b.addEventListener('click', async e => {
      const id = +e.target.closest('li').dataset.id;
      try { await api(`/alerts/${id}?device_id=${cfg.deviceId}`, { method: 'DELETE' }); } catch (err) { say(`삭제 실패: ${err.message}`); }
      await refresh();
    }));
  }
  const say = msg => { if (statusEl) { statusEl.textContent = msg; setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 6000); } };

  async function refresh() {
    if (!cfg.key) { renderList(); drawLines(); return; }
    try {
      const r = await api(`/alerts?device_id=${cfg.deviceId}`);
      active = r.active; triggered = r.triggered;
    } catch (e) { say(`중계 서버 연결 실패: ${e.message}`); }
    drawLines(); renderList();
  }

  async function placeAtPrice(price) {
    const sym = getSymbol(); const cur = getPrice();
    if (!cur) return;
    const digits = price >= 1000 ? 1 : price >= 10 ? 2 : 4;
    const input = prompt(`${sym.replace('USDT', '')} 알림 가격 (현재 ${fmt(cur)})`, price.toFixed(digits));
    if (input == null) return;
    const target = parseFloat(input.replace(/,/g, ''));
    if (!Number.isFinite(target) || target <= 0) { say('가격이 올바르지 않아요'); return; }
    const direction = target >= cur ? 'above' : 'below';
    try {
      say('등록 중…');
      await ensureRegistered();
      await api('/alerts', { method: 'POST', body: JSON.stringify({ device_id: cfg.deviceId, symbol: sym, price: target, direction, note: '' }) });
      say(`🔔 ${sym.replace('USDT', '')} ${direction === 'above' ? '▲' : '▼'} ${fmt(target)} 등록됨`);
    } catch (e) { say(`등록 실패: ${e.message}`); }
    await refresh();
  }

  async function testPush() {
    try { say('테스트 전송 중…'); await ensureRegistered(); const r = await api(`/test?device_id=${cfg.deviceId}`, { method: 'POST' }); say(`테스트: 푸시 ${r.push ? '성공' : '실패'} · 텔레그램 ${r.telegram ? '성공' : '없음'}`); }
    catch (e) { say(`테스트 실패: ${e.message}`); }
    renderList();
  }

  function start() {
    refresh();
    clearInterval(timer); timer = setInterval(refresh, 60000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  }

  // 그리기 동기화용 원격 저장소(같은 중계 서버·키 사용). 키가 없으면 null → 로컬만.
  const remoteDrawings = {
    pull: sym => api(`/drawings/${sym}`),
    push: (sym, doc) => api(`/drawings/${sym}`, { method: 'PUT', body: JSON.stringify(doc) }),
  };

  return {
    start, refresh, placeAtPrice, testPush,
    remoteDrawings: () => (cfg.key ? remoteDrawings : null),
    onSymbolChange: () => { drawLines(); renderList(); },
    getConfig: () => ({ relay: cfg.relay, key: cfg.key || '' }),
    setConfig: ({ relay, key }) => { if (relay) cfg.relay = relay.trim(); cfg.key = (key || '').trim(); localStorage.setItem(KEY, JSON.stringify(cfg)); return refresh(); },
    hasKey: () => !!cfg.key,
  };
}
