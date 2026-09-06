/* My to-do list — service worker
   - offline shell cache
   - scheduled + background notifications
   - notification actions (add / done / snooze) */
var VER = 'wl-v14';
var SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VER).then(function (c) { return c.addAll(SHELL); }).catch(function () { }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.map(function (k) { return k === VER ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET') return;
  var u = new URL(r.url);
  if (u.origin !== location.origin) return;
  e.respondWith(
    fetch(r).then(function (res) {
      if (res && res.ok && res.type === 'basic') {
        var copy = res.clone();
        caches.open(VER).then(function (c) { c.put(r, copy); }).catch(function () { });
      }
      return res;
    }).catch(function () {
      return caches.match(r).then(function (hit) { return hit || caches.match('./index.html'); });
    })
  );
});

/* ---- tiny IndexedDB bridge (the page writes, the worker reads) ---- */
function idb() {
  return new Promise(function (res, rej) {
    var q = indexedDB.open('wardlist', 1);
    q.onupgradeneeded = function () { try { q.result.createObjectStore('kv'); } catch (e) { } };
    q.onsuccess = function () { res(q.result); };
    q.onerror = function () { rej(q.error); };
  });
}
function kvGet(k) {
  return idb().then(function (db) {
    return new Promise(function (res) {
      try {
        var r = db.transaction('kv', 'readonly').objectStore('kv').get(k);
        r.onsuccess = function () { res(r.result || null); };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  }).catch(function () { return null; });
}
function kvPut(k, v) {
  return idb().then(function (db) {
    return new Promise(function (res) {
      try {
        var t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').put(v, k);
        t.oncomplete = function () { res(true); };
        t.onerror = function () { res(false); };
      } catch (e) { res(false); }
    });
  }).catch(function () { return false; });
}

var ICON = './icon-192.png';
function dkey(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}

/* ---- daily digest fallback for devices without notification triggers ---- */
function digestNow() {
  return kvGet('noti').then(function (s) {
    if (!s || !s.cfg || !s.cfg.on || !s.cfg.digest) return;
    var today = dkey(new Date());
    return kvGet('shown').then(function (sh) {
      if (sh === today) return;
      var day = (s.days || {})[today] || { n: 0, over: 0 };
      var body = day.n
        ? ('มีงาน ' + day.n + ' รายการวันนี้' + (day.over ? ' · ค้างเก่า ' + day.over : ''))
        : (day.over ? 'ค้างเก่า ' + day.over + ' รายการ — เคลียร์วันนี้ไหม' : 'วันนี้ยังไม่มีงาน — แตะเพื่อเพิ่ม');
      return kvPut('shown', today).then(function () {
        return self.registration.showNotification('ตรวจสอบงานของวันนี้', {
          tag: 'wl-d-' + today, body: body, icon: ICON, badge: ICON,
          data: { kind: 'digest' },
          actions: [{ action: 'open', title: 'เปิดรายการ' }, { action: 'add', title: 'เพิ่มงาน' }]
        });
      });
    });
  });
}
self.addEventListener('periodicsync', function (e) {
  if (e.tag === 'wl-daily') e.waitUntil(digestNow());
});
self.addEventListener('sync', function (e) {
  if (e.tag === 'wl-daily') e.waitUntil(digestNow());
});

/* ---- pinned quick-add card ---- */
function showPin() {
  return self.registration.showNotification('เพิ่มงาน', {
    tag: 'wl-pin', body: 'เพลิดเพลินกับวันของคุณ!', icon: ICON, badge: ICON,
    silent: true, requireInteraction: true, renotify: false,
    data: { kind: 'pin' },
    actions: [{ action: 'add', title: '＋ เพิ่มงาน' }, { action: 'dismiss', title: 'ปิด' }]
  });
}
self.addEventListener('message', function (e) {
  var m = e.data || {};
  if (m.cmd === 'pin') e.waitUntil(showPin());
  else if (m.cmd === 'unpin') e.waitUntil(self.registration.getNotifications({ tag: 'wl-pin' }).then(function (l) { l.forEach(function (n) { n.close(); }); }));
  else if (m.cmd === 'digest') e.waitUntil(digestNow());
});

/* ---- taps ---- */
function openApp(qs) {
  var url = new URL(self.registration.scope);
  if (qs) url.search = qs;
  var href = url.href;
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
        if (qs) { try { c.postMessage({ from: 'sw', qs: qs }); } catch (e) { } }
        return c.focus();
      }
    }
    return self.clients.openWindow(href);
  });
}
self.addEventListener('notificationclick', function (e) {
  var n = e.notification, a = e.action, d = n.data || {};
  if (a === 'dismiss') { n.close(); return; }
  if (a === 'snooze') {
    n.close();
    var mins = d.snooze || 10;
    var when = Date.now() + mins * 60000;
    if (self.TimestampTrigger) {
      e.waitUntil(self.registration.showNotification(n.title, {
        tag: n.tag, body: n.body, icon: ICON, badge: ICON, data: d,
        showTrigger: new TimestampTrigger(when),
        actions: [{ action: 'done', title: 'เสร็จแล้ว' }, { action: 'snooze', title: 'เลื่อนอีก ' + mins + ' นาที' }]
      }));
    } else {
      e.waitUntil(openApp('snooze=' + encodeURIComponent(d.id || '') + '&min=' + mins));
    }
    return;
  }
  n.close();
  if (a === 'add' || d.kind === 'pin') { e.waitUntil(openApp('add=1')); return; }
  if (a === 'done' && d.id) { e.waitUntil(openApp('done=' + encodeURIComponent(d.id))); return; }
  if (d.kind === 'task' && d.id) { e.waitUntil(openApp('open=' + encodeURIComponent(d.id))); return; }
  e.waitUntil(openApp(''));
});
self.addEventListener('notificationclose', function (e) {
  var d = e.notification.data || {};
  if (d.kind === 'pin') {
    /* user swiped the pinned card away — bring it back on next app open, not now */
  }
});
