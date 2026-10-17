// 暗号化公開版専用。開発用 sw.js は変更しない。
const VERSION = '2b24a4ebb07f423490e15f6eb8d6e59f63870ac50c398164786cb718b5427c83';
const BASE = self.registration.scope;
const PREFIX = `charilog-locked:${encodeURIComponent(new URL(BASE).pathname)}:`;
const SHELL = `${PREFIX}shell:${VERSION}`, APP = `${PREFIX}app:${VERSION}`;
const urlFor = name => new URL(name, BASE).href;
const READY = urlFor('__charilog_ready__');
const PUBLIC = ['index.html', 'lock.js', 'lock.css', 'manifest.webmanifest', 'img/icons/icon-192.png', 'img/icons/icon-512.png', 'img/icons/apple-touch-icon.png', 'app.bin'];
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(SHELL);
  // 配信途中の混在は install を失敗させ、旧版のオフライン起動を残す。
  try {
    for (const name of PUBLIC) {
      const response = await fetch(new Request(`${urlFor(name)}?v=${VERSION}`, { cache: 'reload' }));
      if (!response.ok) throw new Error('公開ファイルを取得できません。');
      if (name === 'index.html' && !(await response.clone().text()).includes(`content="${VERSION}"`)) throw new Error('公開版が混在しています。');
      if (name === 'app.bin') {
        const hash = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
        if ([...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('') !== VERSION) throw new Error('暗号化ファイルが一致しません。');
      }
      await cache.put(urlFor(name), response);
    }
  } catch (error) { await caches.delete(SHELL); throw error; }
  // 自動 skipWaiting はしない。走行中のページは既存の更新ボタンで保護する。
})()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
async function onlyWindow(event) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return !windows.some(client => client.id !== event.source?.id && client.url.startsWith(BASE));
}
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') { event.waitUntil((async () => { if (await onlyWindow(event)) await self.skipWaiting(); })()); return; }
  if (event.data?.type === 'STATUS') { event.ports[0]?.postMessage({ version: VERSION }); return; }
  if (event.data?.type === 'CHECK_CLIENTS') { event.waitUntil((async () => { event.ports[0]?.postMessage({ ok: await onlyWindow(event) }); })()); return; }
  if (event.data?.type === 'LOCK') event.waitUntil((async () => {
    try {
      if (!(await onlyWindow(event))) { event.ports[0]?.postMessage({ ok: false }); return; }
      // 他のアプリ・別サブパスのキャッシュと、記録の IndexedDB は触らない。
      for (const key of await caches.keys()) if (key.startsWith(`${PREFIX}app:`)) await caches.delete(key);
      event.ports[0]?.postMessage({ ok: true });
    } catch { event.ports[0]?.postMessage({ ok: false }); }
  })());
});

async function gatePage() {
  try {
    const response = await fetch(urlFor('index.html'), { cache: 'no-store' });
    if (response.ok && /name="charilog-version" content="[a-f0-9]{64}"/.test(await response.clone().text())) return response;
  } catch { /* オフラインでは最後に完全取得した鍵画面を使う。 */ }
  return (await caches.open(SHELL)).match(urlFor('index.html'));
}
async function route(request, name) {
  if (request.mode === 'navigate' && (name === '' || name === 'index.html')) {
    const gate = await gatePage();
    if (!gate) return new Response('接続して開き直してください。', { status: 503, headers });
    const version = (await gate.clone().text()).match(/name="charilog-version" content="([a-f0-9]{64})"/)?.[1];
    const app = await caches.open(APP);
    if (version === VERSION && !new URL(request.url).searchParams.has('lock') && await app.match(READY)) {
      const page = await app.match(urlFor('index.html'));
      if (page) return page;
    }
    return gate;
  }
  // 鍵画面は更新確認のため network first。アプリ本体は復号済みキャッシュだけ。
  if (PUBLIC.includes(name) || name === 'sw.js') {
    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (response.ok) return response;
    } catch { /* オフライン */ }
    const cached = await (await caches.open(SHELL)).match(urlFor(name));
    return cached ?? new Response('接続して開き直してください。', { status: 503, headers });
  }
  const app = await caches.open(APP);
  if (await app.match(READY)) {
    const cached = await app.match(urlFor(name));
    if (cached) return cached;
  }
  return new Response('パスワードを入力して開いてください。', { status: 404, headers });
}
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url), base = new URL(BASE);
  if (event.request.method !== 'GET' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
  // 地図タイル・Overpass・Nominatim はそのままネットワークへ渡す。
  event.respondWith(route(event.request, url.pathname.slice(base.pathname.length)));
});
