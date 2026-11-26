// Pequenos utilitários puros de formatação (pt-BR), texto e coleções. Sem dependências.

/** Texto mostrado no lugar de um número ausente. */
const EMPTY = '—';

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

function validDigits(digits) {
  const n = Math.floor(Number(digits));
  return Number.isFinite(n) ? Math.min(20, Math.max(0, n)) : 0;
}

/**
 * toFixed com arredondamento "meio para cima" imune ao ruído binário: 1.005 → '1.01' (o toFixed puro dá
 * '1.00') e 0.285 × 100 → '29'.
 */
function toFixedHalfUp(abs, places) {
  const clean = Number(abs.toPrecision(15)); // tira o ruído de contas como 0.285 * 100 = 28.499999999999996
  const text = String(clean);
  if (clean >= 1e21) return `${BigInt(clean)}${places > 0 ? `.${'0'.repeat(places)}` : ''}`; // toFixed daria '1e+21'
  if (text.includes('e')) return clean.toFixed(places); // muito pequeno: sem o truque do expoente
  const scaled = Math.round(Number(`${text}e${places}`));
  const back = Number(`${scaled}e-${places}`);
  return Number.isFinite(back) ? back.toFixed(places) : clean.toFixed(places);
}

/**
 * Formata um número no padrão brasileiro: vírgula decimal e ponto de milhar.
 *   formatNumber(1234.5, 1) → '1.234,5';  formatNumber(1234567) → '1.234.567';  formatNumber(-0.4) → '0'
 * @param {number|null|undefined} n
 * @param {number} [digits=0] casas decimais fixas (0 a 20)
 * @returns {string} '—' para null/undefined/NaN/infinito
 */
export function formatNumber(n, digits = 0) {
  if (n === null || n === undefined || n === '') return EMPTY;
  const value = Number(n);
  if (!Number.isFinite(value)) return EMPTY;
  const places = validDigits(digits);
  const fixed = toFixedHalfUp(Math.abs(value), places);
  const dot = fixed.indexOf('.');
  const whole = dot < 0 ? fixed : fixed.slice(0, dot);
  const fraction = dot < 0 ? '' : fixed.slice(dot + 1);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const negative = value < 0 && /[1-9]/.test(fixed); // evita "-0"
  return `${negative ? '-' : ''}${grouped}${fraction ? `,${fraction}` : ''}`;
}

/**
 * Formata uma fração como percentual: formatPercent(0.42) → '42%'; formatPercent(0.125, 1) → '12,5%'.
 * @param {number|null|undefined} fraction 0..1 (valores fora da faixa são mostrados como estão: 1.5 → '150%')
 * @param {number} [digits=0]
 * @returns {string} '—' para null/undefined/NaN
 */
export function formatPercent(fraction, digits = 0) {
  if (fraction === null || fraction === undefined || fraction === '') return EMPTY;
  const value = Number(fraction);
  if (!Number.isFinite(value)) return EMPTY;
  return `${formatNumber(value * 100, digits)}%`;
}

/**
 * Formata uma duração em segundos como horas decimais: formatHours(5400) → '1,5 h'.
 * @param {number|null|undefined} seconds
 * @param {number} [digits=1]
 * @returns {string} '—' para null/undefined/NaN
 */
export function formatHours(seconds, digits = 1) {
  if (seconds === null || seconds === undefined || seconds === '') return EMPTY;
  const value = Number(seconds);
  if (!Number.isFinite(value)) return EMPTY;
  return `${formatNumber(value / 3600, digits)} h`;
}

/**
 * Quantidade + substantivo no singular/plural: plural(1, 'tarefa', 'tarefas') → '1 tarefa';
 * plural(3, 'tarefa', 'tarefas') → '3 tarefas'; plural(0, 'tarefa', 'tarefas') → '0 tarefas'.
 * @param {number} n quantidade (não numérica conta como 0)
 * @param {string} singular
 * @param {string} [pluralForm] padrão: singular + 's'
 * @returns {string}
 */
export function plural(n, singular, pluralForm) {
  const raw = Number(n);
  const value = Number.isFinite(raw) ? raw : 0;
  const word = Math.abs(value) === 1 ? singular : pluralForm === undefined ? `${singular}s` : pluralForm;
  return `${formatNumber(value, Number.isInteger(value) ? 0 : 1)} ${word}`;
}

/**
 * Corta o texto para caber em `max` caracteres, terminando com '…' quando cortou.
 *   truncate('Relatório mensal', 10) → 'Relatório…'
 * @param {string|null|undefined} text
 * @param {number} max tamanho máximo do resultado, contando a reticência
 * @returns {string}
 */
export function truncate(text, max) {
  if (text === null || text === undefined) return '';
  const value = String(text);
  const limit = Math.floor(Number(max));
  if (!Number.isFinite(limit)) return value;
  if (limit <= 0) return '';
  if (value.length <= limit) return value;
  const chars = Array.from(value); // por ponto de código: não parte emoji/pares substitutos ao meio
  if (chars.length <= limit) return value;
  if (limit === 1) return '…';
  return `${chars.slice(0, limit - 1).join('').trimEnd()}…`;
}

/**
 * Iniciais de um nome, em maiúsculas: primeira letra do primeiro e do último nome.
 *   initials('Ana Souza') → 'AS';  initials('maria da silva') → 'MS';  initials('Ana') → 'A'
 * @param {string|null|undefined} name
 * @returns {string} '' quando não há nome
 */
export function initials(name) {
  if (name === null || name === undefined) return '';
  const words = String(name).trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = Array.from(words[0])[0];
  if (words.length === 1) return first.toLocaleUpperCase('pt-BR');
  const last = Array.from(words[words.length - 1])[0];
  return (first + last).toLocaleUpperCase('pt-BR');
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Escapa texto para uso seguro dentro de HTML (conteúdo e valores de atributo).
 * @param {unknown} text null/undefined viram ''
 * @returns {string}
 */
export function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Normaliza texto para busca sem diferenciar acentos nem maiúsculas: minúsculas, sem diacríticos, sem
 * espaços nas pontas.  normalizeText('  Ação Urgente ') → 'acao urgente'
 * @param {unknown} text null/undefined viram ''
 * @returns {string}
 */
export function normalizeText(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Limita `n` ao intervalo [min, max]. Se os limites vierem invertidos, são trocados; NaN devolve `min`.
 * @param {number} n
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(n, min, max) {
  let lo = min;
  let hi = max;
  if (lo > hi) {
    lo = max;
    hi = min;
  }
  const value = Number(n);
  if (Number.isNaN(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

function toGetter(key) {
  if (typeof key === 'function') return key;
  if (typeof key === 'string' || typeof key === 'number' || typeof key === 'symbol') {
    return (item) => (item === null || item === undefined ? undefined : item[key]);
  }
  throw new TypeError('Chave inválida: informe uma função ou o nome de uma propriedade');
}

/**
 * Soma os valores de uma lista. Valores não numéricos (null, undefined, NaN, infinito) contam como 0.
 *   sum([1, 2, 3]) → 6;  sum(tarefas, (t) => t.estimate_minutes) → total;  sum(tarefas, 'estimate_minutes')
 * @param {Iterable<any>|null|undefined} list
 * @param {((item: any, index: number) => number)|string} [fn] função ou nome da propriedade
 * @returns {number}
 */
export function sum(list, fn) {
  if (list === null || list === undefined) return 0;
  const getter = fn === undefined ? null : toGetter(fn);
  let total = 0;
  let index = 0;
  for (const item of list) {
    const value = Number(getter === null ? item : getter(item, index));
    if (Number.isFinite(value)) total += value;
    index++;
  }
  return total;
}

/**
 * Agrupa os itens pela chave. O Map preserva a ordem em que cada chave apareceu e a ordem dos itens.
 *   groupBy(tarefas, (t) => t.status) → Map { 'todo' → [...], 'done' → [...] }
 * @param {Iterable<any>|null|undefined} list
 * @param {((item: any, index: number) => any)|string} keyFn função ou nome da propriedade
 * @returns {Map<any, any[]>}
 */
export function groupBy(list, keyFn) {
  const groups = new Map();
  if (list === null || list === undefined) return groups;
  const getter = toGetter(keyFn);
  let index = 0;
  for (const item of list) {
    const key = getter(item, index++);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
}

function isBlank(value) {
  return value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));
}

/** Compara duas chaves de ordenação: vazios por último; números e datas por valor; textos na ordem do pt-BR. */
function compareKeys(a, b) {
  const blankA = isBlank(a);
  const blankB = isBlank(b);
  if (blankA || blankB) return blankA && blankB ? 0 : blankA ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  return collator.compare(String(a), String(b));
}

/**
 * Devolve uma CÓPIA ordenada da lista (ordenação estável), pelas chaves informadas em ordem de prioridade.
 *   sortBy(tarefas, (t) => t.priority, 'name')
 *   sortBy(tarefas, { key: 'due_date', dir: 'desc' }, 'name')
 * Cada chave é uma função, o nome de uma propriedade ou `{ key, dir: 'asc' | 'desc' }`.
 * Regras de comparação: valores vazios (null, undefined, '', NaN) ficam sempre por último; números, booleanos
 * (false antes de true) e datas pelo valor; textos sem diferenciar acentos/maiúsculas e com números em ordem
 * natural ('T-2' antes de 'T-10'). Sem chaves, ordena pelos próprios itens.
 * @param {Iterable<any>|null|undefined} list
 * @param {...(((item: any) => any)|string|{ key: ((item: any) => any)|string, dir?: 'asc'|'desc' })} keyFns
 * @returns {any[]}
 */
export function sortBy(list, ...keyFns) {
  if (list === null || list === undefined) return [];
  const items = Array.from(list);
  const specs = (keyFns.length > 0 ? keyFns : [(item) => item]).map((spec) => {
    if (spec !== null && typeof spec === 'object') {
      return { get: toGetter(spec.key), desc: spec.dir === 'desc' || spec.desc === true };
    }
    return { get: toGetter(spec), desc: false };
  });
  // Calcula as chaves uma vez só por item (as funções de chave podem ser caras).
  const rows = items.map((item, index) => ({ item, index, keys: specs.map((spec) => spec.get(item)) }));
  rows.sort((a, b) => {
    for (let i = 0; i < specs.length; i++) {
      const ka = a.keys[i];
      const kb = b.keys[i];
      let result = compareKeys(ka, kb);
      // "desc" inverte a ordem dos valores, mas os vazios continuam no fim.
      if (result !== 0 && specs[i].desc && !isBlank(ka) && !isBlank(kb)) result = -result;
      if (result !== 0) return result;
    }
    return a.index - b.index;
  });
  return rows.map((row) => row.item);
}

/**
 * Remove repetidos preservando a primeira ocorrência e a ordem.
 *   uniq([3, 1, 3, 2, 1]) → [3, 1, 2];  uniq(tarefas, (t) => t.demand_id) → uma tarefa por demanda
 * @param {Iterable<any>|null|undefined} list
 * @param {((item: any) => any)|string} [keyFn] identidade usada na comparação (padrão: o próprio item)
 * @returns {any[]}
 */
export function uniq(list, keyFn) {
  if (list === null || list === undefined) return [];
  if (keyFn === undefined) return Array.from(new Set(list));
  const getter = toGetter(keyFn);
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = getter(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Adia a chamada de `fn` até passarem `ms` milissegundos sem novas chamadas (usa os últimos argumentos).
 * A função devolvida tem `cancel()` (descarta a chamada pendente), `flush()` (executa agora, se houver
 * pendente) e `pending()` (há chamada aguardando?).
 * @param {Function} fn
 * @param {number} [ms=0]
 * @returns {Function & { cancel: () => void, flush: () => void, pending: () => boolean }}
 */
export function debounce(fn, ms = 0) {
  if (typeof fn !== 'function') throw new TypeError('debounce: fn precisa ser uma função');
  let timer = null;
  let lastArgs = null;
  let lastThis = null;

  function fire() {
    timer = null;
    const args = lastArgs;
    const self = lastThis;
    lastArgs = null;
    lastThis = null;
    fn.apply(self, args);
  }

  function debounced(...args) {
    lastArgs = args;
    lastThis = this;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(fire, ms);
  }

  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
    lastThis = null;
  };
  debounced.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    fire();
  };
  debounced.pending = () => timer !== null;
  return debounced;
}

/**
 * Limita `fn` a no máximo uma execução a cada `ms` milissegundos: a primeira chamada executa na hora; as
 * que chegarem dentro do intervalo viram UMA execução no fim dele, com os últimos argumentos.
 * A função devolvida tem `cancel()` (descarta a execução pendente e zera o intervalo).
 * @param {Function} fn
 * @param {number} [ms=0]
 * @returns {Function & { cancel: () => void }}
 */
export function throttle(fn, ms = 0) {
  if (typeof fn !== 'function') throw new TypeError('throttle: fn precisa ser uma função');
  let timer = null;
  let lastRun = -Infinity;
  let lastArgs = null;
  let lastThis = null;

  function run() {
    timer = null;
    lastRun = performance.now();
    const args = lastArgs;
    const self = lastThis;
    lastArgs = null;
    lastThis = null;
    fn.apply(self, args);
  }

  function throttled(...args) {
    lastArgs = args;
    lastThis = this;
    if (timer !== null) return; // já existe uma execução marcada para o fim do intervalo
    const wait = ms - (performance.now() - lastRun);
    if (wait <= 0) run();
    else timer = setTimeout(run, wait);
  }

  throttled.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastRun = -Infinity;
    lastArgs = null;
    lastThis = null;
  };
  return throttled;
}
