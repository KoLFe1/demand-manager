// Service worker do Demand Manager: guarda a "casca" do aplicativo (HTML, CSS, JS, ícones) para uso offline.
//
// Estratégia para requisições GET da MESMA origem:
//   - rede primeiro (com limite de 2,5 s); cada resposta bem-sucedida atualiza o cache;
//   - sem rede (ou rede lenta demais), usa a cópia do cache;
//   - navegações sem cópia própria caem no index.html do cache.
// Nunca toca em requisições de outra origem (Supabase) nem em métodos diferentes de GET.
//
// Na primeira visita a página envia { type: 'cache-urls', urls } com tudo o que carregou, para o cache
// ficar completo sem esperar uma segunda visita. Mude CACHE_VERSION a cada publicação: os caches antigos
// são apagados na ativação.

const CACHE_VERSION = 'v1';
const CACHE_PREFIX = 'dm-shell-';
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const NETWORK_TIMEOUT_MS = 2500;
const SHELL_URLS = ['./', './index.html', './manifest.webmanifest', './assets/icon.svg'];

/** Rotas internas do servidor de desenvolvimento/testes: nunca vão para o cache. */
const UNCACHED_PATHS = /\/__[a-z]/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await Promise.all(
        SHELL_URLS.map(async (url) => {
          try {
            const response = await fetch(url, { cache: 'no-store' });
            if (response.ok) await cache.put(url, response);
          } catch {
            /* sem rede na instalação: a página enviará a lista depois */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

/** A requisição é nossa responsabilidade? (GET, mesma origem, http(s), fora das rotas internas) */
function handles(request) {
  if (request.method !== 'GET') return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== self.location.origin) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return !UNCACHED_PATHS.test(url.pathname);
}

/** Guarda uma resposta boa no cache (sem esperar e sem deixar falhas escaparem). */
function remember(request, response) {
  if (!response || !response.ok || response.type !== 'basic') return;
  const copy = response.clone();
  caches
    .open(CACHE_NAME)
    .then((cache) => cache.put(request, copy))
    .catch(() => {
      /* cota cheia: segue sem cache */
    });
}

async function fromCache(request) {
  const cache = await caches.open(CACHE_NAME);
  const exact = await cache.match(request);
  if (exact) return exact;
  if (request.mode === 'navigate') {
    return (await cache.match('./index.html', { ignoreSearch: true })) || (await cache.match('./', { ignoreSearch: true })) || null;
  }
  return (await cache.match(request, { ignoreSearch: true })) || null;
}

async function networkFirst(request) {
  const network = fetch(request).then((response) => {
    remember(request, response);
    return response;
  });
  network.catch(() => {
    /* tratada abaixo; evita aviso de promessa rejeitada quando o cache já respondeu */
  });
  let timer = 0;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS);
  });
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    // Rede lenta: usa o cache se houver; senão continua esperando a rede.
    const cached = await fromCache(request);
    return cached || (await network);
  } catch (error) {
    const cached = await fromCache(request);
    if (cached) return cached;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!handles(request)) return;
  event.respondWith(networkFirst(request));
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'cache-urls' || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (const raw of data.urls.slice(0, 400)) {
        try {
          const url = new URL(String(raw), self.location.href);
          if (url.origin !== self.location.origin || UNCACHED_PATHS.test(url.pathname)) continue;
          url.hash = '';
          if (await cache.match(url.href)) continue;
          const response = await fetch(url.href, { credentials: 'same-origin' });
          if (response.ok && response.type === 'basic') await cache.put(url.href, response);
        } catch {
          /* um recurso que falhou não impede os outros */
        }
      }
    })(),
  );
});
