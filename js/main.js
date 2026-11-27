// Ponto de entrada do Demand Manager (carregado por index.html).
//
// Lê os parâmetros da URL, registra o service worker (cache do app para uso offline) e inicializa o app.
// O service worker NÃO é registrado fora de http(s), nem com ?nosw=1, ?demo=1 ou ?db=NOME (testes e
// demonstração não devem deixar caches para trás).

import { APP_VERSION, appResourceUrls, boot, shouldRegisterServiceWorker, workerVersion } from './boot.js';
import { toast } from './ui/kit/overlays.js';

/** Lista de recursos que esta página já carregou, sem query/hash (o worker guarda tudo no cache já na primeira visita). */
function loadedResources() {
  let entries = [];
  try {
    entries = performance.getEntriesByType('resource');
  } catch {
    /* API de desempenho indisponível */
  }
  return appResourceUrls(location.origin, location.href, entries);
}

/** Registra o service worker e avisa quando uma versão nova assumir o controle da página. */
async function registerServiceWorker() {
  const container = navigator.serviceWorker;
  const hadController = !!container.controller;
  let reloading = false;
  container.addEventListener('controllerchange', async () => {
    const worker = container.controller;
    // O worker novo tem cache próprio (o antigo foi apagado): manda a lista do que esta página carregou, senão
    // quem escolher "Depois" fica sem o app offline até a próxima abertura com rede.
    if (worker) worker.postMessage({ type: 'cache-urls', urls: loadedResources() });
    // Primeira instalação: o worker passa a controlar a página, mas o app não mudou — nada a avisar.
    if (!hadController || reloading) return;
    // A página já roda a versão que o worker novo serve (ela veio da rede pelo worker antigo): nada a recarregar.
    if ((await workerVersion(worker)) === APP_VERSION) return;
    if (reloading) return;
    toast('Nova versão disponível', {
      id: 'sw-update',
      duration: 0,
      actions: [
        {
          label: 'Recarregar',
          onclick: () => {
            reloading = true;
            location.reload();
          },
        },
        { label: 'Depois' },
      ],
    });
  });
  try {
    const registration = await container.register('sw.js');
    const ready = await container.ready;
    const worker = ready.active || registration.active;
    if (worker) worker.postMessage({ type: 'cache-urls', urls: loadedResources() });
  } catch (error) {
    console.warn('[sw] não foi possível registrar o service worker (o app funciona, mas sem cache offline).', error);
  }
}

const params = new URLSearchParams(location.search);
if (shouldRegisterServiceWorker(location, params)) {
  // Depois do carregamento: o registro não disputa banda com o primeiro uso.
  if (document.readyState === 'complete') registerServiceWorker();
  else window.addEventListener('load', () => registerServiceWorker(), { once: true });
}

boot({ root: document.getElementById('app'), params, win: window }).catch(() => {
  /* a tela de erro já foi mostrada pelo boot */
});
