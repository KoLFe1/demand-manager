// Roteador por hash. Sem dependências.
//
// Formato da URL:  #/caminho?chave=valor&k2=v2      (ex.: #/demandas?panel=task:ID)
//
//   const router = createRouter({ fallback: '/dashboard' });
//   router.subscribe((route, previous) => render(route));
//   router.start();
//   router.navigate('/kanban', { params: { q: 'abc' } });
//   router.setParams({ panel: 'task:123' });     // mantém o caminho; null remove a chave

const EMPTY_ROUTE = Object.freeze({ path: '', params: Object.freeze({}) });

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // sequência % inválida digitada à mão: usa o texto como está
  }
}

/** Codifica um valor/chave de parâmetro deixando legíveis os caracteres seguros dentro do hash (`:`, `,`, `/`, `@`). */
function encodePart(text) {
  return encodeURIComponent(text).replace(/%(3A|2C|2F|40)/gi, (m) => safeDecode(m));
}

/** Normaliza um caminho: começa com uma barra, sem barra no fim; '' quando não há caminho (ou é só '/'). */
function normalizePath(path) {
  if (typeof path !== 'string') return '';
  let out = path.trim();
  if (out === '') return '';
  if (out[0] !== '/') out = `/${out}`;
  out = out.replace(/\/{2,}/g, '/');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out === '/' ? '' : out;
}

/** Converte os parâmetros para texto, descartando null/undefined/''. Devolve um objeto novo. */
function cleanParams(params) {
  const out = {};
  if (params === null || typeof params !== 'object') return out;
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === null || value === undefined || value === '' || key === '') continue;
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    out[key] = String(value);
  }
  return out;
}

/** Texto canônico de uma rota (chaves em ordem alfabética), usado para saber se duas rotas são iguais. */
function signature(path, params) {
  const keys = Object.keys(params).sort();
  let out = path;
  for (const key of keys) out += `\u0000${key}\u0001${params[key]}`;
  return out;
}

/**
 * Interpreta um hash no formato `#/caminho?chave=valor&k2=v2`.
 *
 * Regras:
 *   - aceita com ou sem o `#` inicial;
 *   - hash vazio ou inválido (não começa com `/`) → `{ path: '', params: {} }`;
 *   - o caminho é devolvido sem barra final (`#/kanban/` → `/kanban`); `#/` sozinho → path '' (os parâmetros valem);
 *   - valores e chaves são decodificados (decodeURIComponent; sequências inválidas ficam como estão);
 *   - chave sem valor (`?a`) vira '' e, repetida, vale a última ocorrência.
 *
 * @param {string|null|undefined} hash
 * @returns {{ path: string, params: Record<string, string> }}
 */
export function parseHash(hash) {
  if (typeof hash !== 'string') return { path: '', params: {} };
  let text = hash.trim();
  if (text[0] === '#') text = text.slice(1);
  if (text[0] !== '/') return { path: '', params: {} };
  const cut = text.indexOf('?');
  const rawPath = cut < 0 ? text : text.slice(0, cut);
  const query = cut < 0 ? '' : text.slice(cut + 1);
  const params = {};
  if (query !== '') {
    for (const piece of query.split('&')) {
      if (piece === '') continue;
      const eq = piece.indexOf('=');
      const key = safeDecode(eq < 0 ? piece : piece.slice(0, eq));
      if (key === '') continue;
      params[key] = eq < 0 ? '' : safeDecode(piece.slice(eq + 1));
    }
  }
  return { path: normalizePath(safeDecode(rawPath)), params };
}

/**
 * Monta o hash de uma rota: `buildHash('/kanban', { q: 'a b' })` → `'#/kanban?q=a%20b'`.
 *
 * Regras:
 *   - parâmetros null/undefined/'' (e NaN) são omitidos; os demais viram texto e são codificados
 *     (`:`, `,`, `/` e `@` ficam legíveis: `panel=task:ID`);
 *   - as chaves saem na ordem em que estão no objeto;
 *   - caminho vazio vira `#/`.
 *
 * @param {string} path caminho começando com `/` (a barra é acrescentada se faltar)
 * @param {Record<string, unknown>|null} [params]
 * @returns {string}
 */
export function buildHash(path, params) {
  const cleanPath = normalizePath(path) || '/';
  const encodedPath = encodeURI(cleanPath).replace(/[?#]/g, (ch) => encodeURIComponent(ch));
  const clean = cleanParams(params);
  const query = Object.keys(clean)
    .map((key) => `${encodePart(key)}=${encodePart(clean[key])}`)
    .join('&');
  return query ? `#${encodedPath}?${query}` : `#${encodedPath}`;
}

/**
 * Cria o roteador por hash.
 *
 * - `current()` → `{ path, params }` (objeto congelado; `params` sempre com valores em texto). Hash vazio ou
 *   inválido resolve para o caminho `fallback` (a URL não é reescrita).
 * - `navigate(path, { params, replace })` muda a rota. `replace: true` troca a entrada atual do histórico em
 *   vez de criar outra. Navegar para a rota atual (mesmo caminho e mesmos parâmetros) não faz nada.
 *   Devolve true quando a rota mudou.
 * - `setParams(patch, { replace })` mescla `patch` nos parâmetros atuais mantendo o caminho; valor
 *   null/undefined/'' remove a chave. Devolve true quando a rota mudou.
 * - `subscribe(fn)` → função para cancelar. `fn(rota, rotaAnterior)` é chamado exatamente uma vez por
 *   mudança, seja ela feita por navigate/setParams ou pelo usuário (voltar/avançar, link, edição da URL).
 *   Exceção num ouvinte é registrada com console.error e não impede os outros.
 * - `start()` passa a ouvir `hashchange` e sincroniza com a URL do momento (avisa os ouvintes se ela mudou
 *   desde a criação). `stop()` deixa de ouvir. As mudanças externas só são percebidas entre start() e stop().
 *
 * @param {{ fallback?: string, win?: Window }} [options]
 * @returns {{
 *   current: () => { path: string, params: Record<string, string> },
 *   navigate: (path: string, options?: { params?: Record<string, unknown>, replace?: boolean }) => boolean,
 *   setParams: (patch: Record<string, unknown>, options?: { replace?: boolean }) => boolean,
 *   subscribe: (fn: (route: object, previous: object) => void) => (() => void),
 *   start: () => void,
 *   stop: () => void,
 * }}
 */
export function createRouter({ fallback = '/dashboard', win = window } = {}) {
  const fallbackPath = normalizePath(fallback) || '/dashboard';
  const listeners = new Set();
  let started = false;
  let route = EMPTY_ROUTE;
  let currentSignature = '';

  function makeRoute(path, params) {
    return Object.freeze({ path: normalizePath(path) || fallbackPath, params: Object.freeze(cleanParams(params)) });
  }

  function readLocation() {
    let hash = '';
    try {
      hash = win.location.hash || '';
    } catch {
      /* janela inacessível: fica na rota padrão */
    }
    const parsed = parseHash(hash);
    return makeRoute(parsed.path, parsed.params);
  }

  /** Adota `next` como rota atual; avisa os ouvintes se for diferente. Devolve true quando mudou. */
  function commit(next) {
    const nextSignature = signature(next.path, next.params);
    if (nextSignature === currentSignature) return false;
    const previous = route;
    route = next;
    currentSignature = nextSignature;
    for (const fn of Array.from(listeners)) {
      if (!listeners.has(fn)) continue; // cancelado por um ouvinte anterior
      try {
        fn(route, previous);
      } catch (err) {
        console.error('[router] erro num ouvinte de rota', err);
      }
    }
    return true;
  }

  /** A URL da janela já aponta para a rota `next`? */
  function locationMatches(next) {
    const seen = readLocation();
    return signature(seen.path, seen.params) === signature(next.path, next.params);
  }

  function writeLocation(next, replace) {
    const hash = buildHash(next.path, next.params);
    if (replace) {
      try {
        // URL absoluta: um "#..." relativo seria resolvido contra a URL base (<base href>, about:blank), não a do documento.
        const href = String(win.location.href || '');
        const cut = href.indexOf('#');
        const base = cut < 0 ? href : href.slice(0, cut);
        win.history.replaceState(win.history.state, '', base ? `${base}${hash}` : hash);
        if (locationMatches(next)) return;
      } catch {
        /* replaceState indisponível (ex.: documento sem origem): cai nas alternativas abaixo */
      }
      try {
        win.location.replace(hash);
        return;
      } catch {
        /* segue para a atribuição simples */
      }
    }
    win.location.hash = hash;
  }

  function onHashChange() {
    commit(readLocation());
  }

  function current() {
    return route;
  }

  function navigate(path, { params, replace = false } = {}) {
    const next = makeRoute(path, params);
    if (signature(next.path, next.params) === currentSignature) return false;
    // A URL muda primeiro; o hashchange que o navegador dispara depois encontra a rota já atualizada e é ignorado.
    writeLocation(next, replace);
    return commit(next);
  }

  function setParams(patch, { replace = false } = {}) {
    const merged = { ...route.params };
    if (patch !== null && typeof patch === 'object') {
      for (const key of Object.keys(patch)) {
        const value = patch[key];
        if (value === null || value === undefined || value === '') delete merged[key];
        else merged[key] = value;
      }
    }
    return navigate(route.path, { params: merged, replace });
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('router.subscribe: o ouvinte precisa ser uma função');
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  function start() {
    if (started) return;
    started = true;
    win.addEventListener('hashchange', onHashChange);
    commit(readLocation());
  }

  function stop() {
    if (!started) return;
    started = false;
    win.removeEventListener('hashchange', onHashChange);
  }

  // Estado inicial: a URL do momento da criação (sem avisar ninguém).
  route = readLocation();
  currentSignature = signature(route.path, route.params);

  return { current, navigate, setParams, subscribe, start, stop };
}
