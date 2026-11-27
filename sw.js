// Service worker do Demand Manager: guarda a "casca" do aplicativo (HTML, CSS, JS, ícones) para uso offline.
//
// Estratégia para requisições GET da MESMA origem:
//   - rede primeiro (com limite de 2,5 s); cada resposta bem-sucedida atualiza o cache;
//   - sem rede (ou rede lenta demais), usa a cópia do cache;
//   - navegações sem cópia própria caem no index.html do cache.
// Nunca toca em requisições de outra origem (Supabase) nem em métodos diferentes de GET.
// Toda busca na rede usa cache: 'no-cache' (revalida pelo ETag): o cache HTTP do navegador (GitHub Pages manda
// max-age=600) não pode misturar módulos velhos com uma publicação nova.
// Navegações são normalizadas para o caminho SEM query/hash (na rede e na chave do cache): textos passados por
// parâmetro (ex.: compartilhamento) nunca vão para logs de rede nem para o cache. A página lê a query dela mesma.
//
// Na primeira visita a página envia { type: 'cache-urls', urls } com tudo o que carregou, para o cache
// ficar completo sem esperar uma segunda visita. Mude CACHE_VERSION a cada publicação (igual a APP_VERSION
// em js/boot.js — um teste confere): os caches antigos são apagados na ativação, e os endereços que eles
// guardavam são baixados de novo (da rede) para o cache novo. A página pode perguntar { type: 'version' }
// (resposta pela porta: { version }) para não avisar "Nova versão" quando já roda a mesma versão do worker.

const CACHE_VERSION = 'v001';
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
      const old = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);
      // Endereços que a versão anterior guardava (a lista completa do app): baixados de novo da REDE para o
      // cache novo — o conteúdo velho nunca é copiado (misturaria módulos). Sem isso, quem atualiza e escolhe
      // "Depois" (ou fecha a página) ficaria com um cache só com SHELL_URLS e o app não abriria offline.
      const previous = [];
      for (const name of old) {
        try {
          for (const request of await (await caches.open(name)).keys()) previous.push(request.url);
        } catch {
          /* cache ilegível: segue */
        }
      }
      await Promise.all(old.map((name) => caches.delete(name)));
      await self.clients.claim();
      await cacheUrls(previous);
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

/** Caminho da pasta do app (escopo do service worker), ex.: '/demand-manager/'. */
function scopePath() {
  const scope = (self.registration && self.registration.scope) || new URL('./', self.location.href).href;
  return new URL(scope).pathname;
}

async function fromCache(request, navigate) {
  const cache = await caches.open(CACHE_NAME);
  const exact = await cache.match(request);
  if (exact) return exact;
  if (navigate) {
    // Só dentro da pasta do app: '/demand-manager' (sem a barra) servido com o index.html quebraria os caminhos
    // relativos — ali vale o redirecionamento do servidor (301 para '/demand-manager/').
    if (!new URL(typeof request === 'string' ? request : request.url).pathname.startsWith(scopePath())) return null;
    return (await cache.match('./index.html', { ignoreSearch: true })) || (await cache.match('./', { ignoreSearch: true })) || null;
  }
  return (await cache.match(request, { ignoreSearch: true })) || null;
}

/**
 * Requisição que vai para a rede/cache: navegações viram GET do caminho sem query nem hash.
 * @param {Request} request
 * @returns {Request|string}
 */
function normalized(request) {
  if (request.mode !== 'navigate') return request;
  const url = new URL(request.url);
  url.search = '';
  url.hash = '';
  return url.href;
}

async function networkFirst(original) {
  const navigate = original.mode === 'navigate';
  const request = normalized(original);
  // Navegação: redirect 'manual' como a requisição original (responder uma navegação com uma resposta
  // "redirected" é erro de rede; a opaqueredirect volta ao navegador, que segue o redirecionamento — ex.:
  // GitHub Pages manda '/demand-manager' → 301 '/demand-manager/'). Ela nunca vai para o cache (remember só
  // guarda respostas ok do tipo 'basic').
  const init = navigate ? { cache: 'no-cache', redirect: 'manual' } : { cache: 'no-cache' };
  const network = fetch(request, init).then((response) => {
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
    const cached = await fromCache(request, navigate);
    return cached || (await network);
  } catch (error) {
    const cached = await fromCache(request, navigate);
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

/** Baixa da rede (revalidando) e guarda no cache atual os endereços da lista que ainda não estão nele. */
async function cacheUrls(urls) {
  const cache = await caches.open(CACHE_NAME);
  for (const raw of urls.slice(0, 400)) {
    try {
      const url = new URL(String(raw), self.location.href);
      if (url.origin !== self.location.origin || UNCACHED_PATHS.test(url.pathname)) continue;
      url.hash = '';
      url.search = '';
      if (await cache.match(url.href)) continue;
      const response = await fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' });
      if (response.ok && response.type === 'basic') await cache.put(url.href, response);
    } catch {
      /* um recurso que falhou não impede os outros */
    }
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;
  // A página pergunta qual versão este worker serve (para não avisar "Nova versão" quando já roda a mesma).
  if (data.type === 'version') {
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ version: CACHE_VERSION });
    return;
  }
  if (data.type !== 'cache-urls' || !Array.isArray(data.urls)) return;
  event.waitUntil(cacheUrls(data.urls));
});
