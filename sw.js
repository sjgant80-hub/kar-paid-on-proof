// Offline: network first, the last good copy when offline. Nothing here touches a wallet or a key.
const CACHE = 'kar-paid-on-proof-v2';
const CORE = ['./', 'index.html', 'fixtures/job.json', 'runs/local.json', 'app/evm.js', 'icon.svg', 'manifest.webmanifest',
  'artifacts/AgentIdentityRegistry.json', 'artifacts/ValidationRegistry.json', 'artifacts/Fallmarket.json',
  'artifacts/AgentAccount.json', 'artifacts/FulfilmentGate.json', 'artifacts/MockUSD8.json'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {})));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) {
      const copy = r.clone(); // clone before the page reads the body
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return r;
  }).catch(() => caches.match(e.request)));
});
