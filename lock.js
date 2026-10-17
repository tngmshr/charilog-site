const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
const hex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
const displayError = error => /[\u3040-\u30ff\u3400-\u9fff]/.test(error?.message ?? '') ? error.message : '操作を完了できませんでした。接続と空き容量を確認して再試行してください。';

export async function decryptBundle(data, password, cryptoApi = globalThis.crypto) {
  if (data?.v !== 1 || data.kdf !== 'PBKDF2-SHA256' || data.iter !== 600000 || unb64(data.salt).length !== 16 || unb64(data.iv).length !== 12) throw new Error('暗号化ファイルの形式が違います。');
  const base = await cryptoApi.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await cryptoApi.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(data.salt), iterations: data.iter }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  let plain;
  try { plain = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv: unb64(data.iv) }, key, unb64(data.ct)); }
  catch { throw new Error('パスワードが違います'); }
  const bundle = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  if (bundle?.v !== 1 || !Array.isArray(bundle.files)) throw new Error('アプリの形式が違います。');
  return bundle;
}

export async function saveApp(bundle, base, version, cacheStorage = globalThis.caches) {
  const prefix = `charilog-locked:${encodeURIComponent(new URL(base).pathname)}:`;
  const name = `${prefix}app:${version}`;
  const paths = new Set();
  // URL の範囲と重複を、保存開始前に全件確認する。
  for (const file of bundle.files) {
    if (typeof file.path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').some(p => !p || p.startsWith('.')) || paths.has(file.path)) throw new Error('アプリのファイル名が不正です。');
    paths.add(file.path);
  }
  if (!paths.has('index.html') || !paths.has('js/app.js') || !paths.has('data/handbook.json')) throw new Error('アプリのファイルが不足しています。');
  await cacheStorage.delete(name);
  try {
    const cache = await cacheStorage.open(name);
    for (const file of bundle.files) await cache.put(new URL(file.path, base).href, new Response(unb64(file.body), {
      headers: { 'Content-Type': file.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    }));
    // 最後に完了印を置く。容量不足・途中終了したキャッシュからは起動しない。
    await cache.put(new URL('__charilog_ready__', base).href, new Response(version));
    for (const old of await cacheStorage.keys()) if (old.startsWith(prefix) && old !== name && !old.endsWith(`shell:${version}`)) await cacheStorage.delete(old);
  } catch (error) { await cacheStorage.delete(name); throw error; }
}

export function workerMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('オフライン準備が応答しません。開き直してください。')); }, 5000);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
    worker.postMessage({ type }, [channel.port2]);
  });
}

async function checkOtherWindows(worker) {
  if (!(await workerMessage(worker, 'CHECK_CLIENTS')).ok) throw new Error('別の画面でチャリログが開いています。そちらを閉じて再試行してください。');
}

async function prepareWorker(version) {
  if (navigator.serviceWorker.controller) await checkOtherWindows(navigator.serviceWorker.controller);
  const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  try { await registration.update(); } catch { /* オフラインは登録済みの同じ版だけ使う。 */ }
  for (let attempt = 0; attempt < 300; attempt++) {
    if (registration.waiting) {
      await checkOtherWindows(registration.waiting);
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    const controller = navigator.serviceWorker.controller;
    if (controller && (await workerMessage(controller, 'STATUS')).version === version) {
      await checkOtherWindows(controller); return controller;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('更新を準備できませんでした。接続して再試行してください。');
}

async function start() {
  const status = document.getElementById('lock-status'), input = document.getElementById('password'), button = document.getElementById('unlock');
  const retry = document.getElementById('retry');
  retry.onclick = () => location.reload();
  try {
    if (!globalThis.isSecureContext || !globalThis.crypto?.subtle || !('serviceWorker' in navigator) || !globalThis.caches) throw new Error('HTTPS 接続と Service Worker に対応した Safari で開いてください。');
    const version = document.querySelector('meta[name="charilog-version"]').content;
    const base = new URL('./', location.href).href;
    const worker = await prepareWorker(version);
    if (new URL(location.href).searchParams.has('lock')) {
      if (!(await workerMessage(worker, 'LOCK')).ok) throw new Error('ロックし直せませんでした。再試行してください。');
    }
    status.textContent = 'パスワードを入力してください。'; input.disabled = false; button.disabled = false;
    document.getElementById('lock-form').onsubmit = async event => {
      event.preventDefault(); button.disabled = true; input.disabled = true; retry.hidden = true; status.textContent = 'アプリを開いています…';
      try {
        const response = await fetch(`./app.bin?v=${version}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('暗号化ファイルを取得できません。接続して再試行してください。');
        const text = await response.text();
        if (hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))) !== version) throw new Error('公開ファイルが更新されました。ページを開き直してください。');
        const bundle = await decryptBundle(JSON.parse(text), input.value);
        input.value = '';
        await checkOtherWindows(worker);
        await saveApp(bundle, base, version);
        const next = new URL(location.href); next.searchParams.delete('lock'); location.replace(next.href);
      } catch (error) {
        status.textContent = error.name === 'QuotaExceededError' ? '保存容量が足りません。端末の空き容量を確認してください。' : displayError(error);
        input.value = ''; input.disabled = false; button.disabled = false; retry.hidden = false; input.focus();
      }
    };
  } catch (error) { status.textContent = displayError(error); retry.hidden = false; }
}
// 解錠画面でも記録画面と同じ排他を、画面の終了まで保持する。
export async function withWriterLock(locks, task) {
  if (!locks?.request) throw new Error('安全に解錠するための Web Locks が使えません。Safari を更新して開き直してください。');
  return locks.request('charilog-pwa-writer', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('別の画面でチャリログが開いています。そちらを閉じて再試行してください。');
    await task();
    await new Promise(() => {});
  });
}
if (typeof document !== 'undefined') void withWriterLock(navigator.locks, start).catch(error => {
  document.getElementById('lock-status').textContent = displayError(error);
  const retry = document.getElementById('retry'); retry.hidden = false; retry.onclick = () => location.reload();
});
