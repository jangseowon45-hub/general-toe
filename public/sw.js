// 앱 셸만 캐시한다. 거래소 데이터(binance)는 절대 캐시하지 않는다.
const CACHE = 'general-toe-v2';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate') {
    // GitHub Pages는 HTML에 max-age=600을 주므로 HTTP 캐시를 건너뛰고 서버에 재확인한다(해시 자산은 그대로 캐시).
    e.respondWith(fetch(new Request(e.request, { cache: 'no-cache' })).then(r => { caches.open(CACHE).then(c => c.put(self.registration.scope, r.clone())); return r; }).catch(() => caches.match(self.registration.scope)));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
    if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
    return r;
  })));
});

// ── 웹 푸시(가격 알림) ──
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'general-toe', body: e.data && e.data.text() }; }
  const title = d.title || 'general-toe 알림';
  const opts = {
    body: d.body || '',
    icon: new URL('icon-192.png', self.registration.scope).href,
    badge: new URL('icon-192.png', self.registration.scope).href,
    tag: d.alert_id ? `alert-${d.alert_id}` : undefined,
    data: { url: self.registration.scope + (d.symbol ? `?symbol=${encodeURIComponent(d.symbol)}` : ''), ...d },
    vibrate: [100, 50, 100],
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if (c.url.startsWith(self.registration.scope) && 'focus' in c) { c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
