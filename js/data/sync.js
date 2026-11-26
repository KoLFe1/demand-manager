// Motor de sincronização entre o banco local (js/data/store.js) e o Supabase (js/data/remote-supabase.js).
//
//   const sync = createSyncEngine({ store, remote, wall });
//   sync.subscribe((status) => atualizarIndicador(status));
//   sync.start();                      // sincroniza agora e passa a sincronizar sozinho
//   await sync.syncNow();              // { ok, pushed, pulled, failures }
//
// Um ciclo (ver docs/ARQUITETURA.md, seção 6):
//   1. confere, uma vez por sessão, a versão do schema instalada no servidor;
//   2. ENVIA as linhas pendentes, tabela por tabela na ordem de TABLES (pais antes dos filhos), em
//      lotes; a resposta do servidor (linhas já mescladas) entra no banco local e só então a
//      pendência é baixada — e só se a linha não mudou durante o envio;
//   3. RECEBE, de cada tabela, as linhas com server_seq acima do cursor, página por página até vir
//      uma página VAZIA (página curta não é fim: o servidor pode limitar as linhas por resposta).
//
// Garantias:
//   - nenhuma linha é dada como enviada sem a confirmação do servidor;
//   - reenviar as mesmas linhas quantas vezes for é inofensivo (o servidor mescla por carimbo), por
//     isso toda falha é tratada com "tenta de novo depois";
//   - uma linha recusada pelo servidor não trava as outras: fica registrada em `status().failures`;
//   - nada do banco local é apagado ou sobrescrito fora do merge campo a campo.

import { TABLES, SCHEMA_VERSION, DB_PREFIX, toRemoteRow } from './schema.js';
import { RemoteError } from './remote-supabase.js';
import { createWallClock } from '../core/wallclock.js';

const CURSOR_PREFIX = 'cursor:';
const META_LAST_SYNC = 'sync:lastSyncAt';
const META_LAST_FULL_PULL = 'sync:lastFullPullAt';
/** Conta dona do banco local (id do usuário): o motor só sincroniza com a sessão dela. */
const META_OWNER = 'sync:owner';

const DEFAULT_BACKOFF = Object.freeze([2000, 5000, 15000, 30000, 60000]);

/** Motivos de ciclos disparados pelo próprio motor (os demais são pedidos explícitos do app/usuário). */
const AUTOMATIC_REASONS = new Set(['change', 'interval', 'retry', 'online', 'visible']);

const HINT_OFFLINE = 'As alterações continuam guardadas neste aparelho e serão enviadas quando a conexão voltar.';
const HINT_SCHEMA = 'Abra o SQL Editor do Supabase e execute o arquivo supabase/schema.sql inteiro (pode ser executado de novo sem perder dados). Depois sincronize outra vez.';
const ACCOUNT_ERROR = Object.freeze({
  kind: 'account',
  message: 'A conta conectada não é a dona dos dados abertos nesta janela.',
  hint: 'Recarregue a página para abrir os dados da conta conectada. Nada foi enviado nem recebido; as alterações desta janela continuam guardadas neste dispositivo.',
});
const STORAGE_HINT = 'Libere espaço no dispositivo ou feche as outras abas do Demand Manager e recarregue a página. Se tiver dúvida, exporte um backup antes.';

/** Sinal interno: o motor foi parado (stop) no meio de um ciclo. */
class Aborted extends Error {}

/** Sinal interno: a sessão passou a ser de outra conta no meio de um ciclo. */
class AccountChanged extends Error {}

const UUID_TAIL = /(?:^|\.)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Dono que o NOME do banco revela (convenção do boot): 'dm-local'/'dm-demo' → null (ninguém);
 * 'dm-<id do usuário>' ou 'dm-<espaço>.<id do usuário>' → esse id; qualquer outro → undefined (não diz).
 */
function ownerFromDbName(name) {
  if (typeof name !== 'string' || !name.startsWith(DB_PREFIX)) return undefined;
  const rest = name.slice(DB_PREFIX.length);
  if (rest === 'local' || rest === 'demo') return null;
  const match = UUID_TAIL.exec(rest);
  return match ? match[1] : undefined;
}

/** Falha ao gravar no armazenamento deste navegador (IndexedDB). */
function storageError(cause) {
  const detail = cause && cause.message ? ` (${cause.message})` : '';
  return new RemoteError('storage', `Não foi possível gravar no armazenamento deste navegador${detail}.`, { code: 'local_storage', hint: STORAGE_HINT, cause });
}

const dirtyKey = (table, id) => `${table}:${id}`;

function stampOf(map, field) {
  const n = map && typeof map === 'object' ? Number(map[field]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * true quando o servidor ficou com tudo o que esta linha local tem: nenhum campo de dados local
 * tem carimbo acima do carimbo devolvido. (Depois do merge com `confirm`, um carimbo local maior
 * significa que o servidor ficou com OUTRO valor naquele campo — a linha ainda precisa subir.)
 */
function serverHasEverything(desc, local, answer) {
  const localStamps = local.field_ts;
  const serverStamps = answer.field_ts;
  for (const [field, def] of Object.entries(desc.fields)) {
    if (field === desc.idField || field === 'created_at' || field === 'updated_at' || def.server) continue;
    if (stampOf(localStamps, field) > stampOf(serverStamps, field)) return false;
  }
  return true;
}

/**
 * Ordena as linhas de uma tabela que referencia a si mesma (subtarefa → tarefa) com os pais na
 * frente, para que a divisão em lotes nunca mande o filho antes do pai. Ordenação estável, por
 * profundidade entre as linhas PENDENTES (pai que já está no servidor não conta); dados
 * inconsistentes vindos de outro aparelho (ciclo, neto) não travam: o ciclo é cortado.
 */
function parentsFirst(desc, items) {
  const selfRefs = Object.entries(desc.fields).filter(([, def]) => def.ref === desc.name).map(([field]) => field);
  if (!selfRefs.length || items.length < 2) return items;
  const idField = desc.idField;
  const byId = new Map(items.map((item) => [item.row[idField], item]));
  const depth = new Map();
  const pendingParent = (item) => {
    for (const field of selfRefs) {
      const parentId = item.row[field];
      if (parentId != null && parentId !== item.row[idField] && byId.has(parentId)) return byId.get(parentId);
    }
    return null;
  };
  for (const item of items) {
    // Sobe pela cadeia de pais até achar uma profundidade conhecida, uma raiz ou um ciclo.
    const chain = [];
    const seen = new Set();
    let base = 0;
    for (let cur = item; cur; cur = pendingParent(cur)) {
      const id = cur.row[idField];
      if (depth.has(id)) {
        base = depth.get(id) + 1;
        break;
      }
      if (seen.has(id)) break;
      seen.add(id);
      chain.push(id);
    }
    for (let i = chain.length - 1; i >= 0; i--) depth.set(chain[i], base++);
  }
  if (!items.some((item) => depth.get(item.row[idField]) > 0)) return items;
  return items
    .map((item, index) => ({ item, index, level: depth.get(item.row[idField]) || 0 }))
    .sort((a, b) => a.level - b.level || a.index - b.index)
    .map((entry) => entry.item);
}

function defaultIsOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

const defaultTimers = Object.freeze({
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

/**
 * Cria o motor de sincronização.
 *
 * @param {object} params
 * @param {object} params.store   banco local (`createStore`)
 * @param {object|null} [params.remote] cliente do servidor (`createSupabaseRemote`); ausente ou não
 *   configurado → estado `'disabled'`
 * @param {object} [params.wall]  relógio de parede (`createWallClock`), usado em `lastSyncAt`
 * @param {object[]} [params.tables=TABLES] descritores das tabelas, na ordem de envio
 * @param {string|null} [params.owner] id do usuário DONO do banco local (o da sessão usada para escolher
 *   o banco); `null` = banco do modo local, que nunca sincroniza (os dados locais só chegam a uma conta
 *   pela pergunta do primeiro login). Omitido: vale a conta gravada no próprio banco ('sync:owner'), a
 *   que o nome do banco revela ('dm-local' → nenhuma; 'dm-<id>' → id) ou, na falta das duas, a da
 *   sessão aberta agora. A conta dona é gravada no banco; com uma sessão de OUTRA conta o motor não
 *   envia nem recebe nada (estado `'needs-reload'`) até a página ser recarregada.
 * @param {object} [params.options]
 * @param {number} [params.options.intervalMs=45000]  intervalo da sincronização periódica
 * @param {number} [params.options.debounceMs=1200]   espera depois de uma alteração local
 * @param {number} [params.options.pageSize=1000]     linhas pedidas por página no recebimento
 * @param {number} [params.options.chunkSize=200]     linhas por lote no envio
 * @param {number[]} [params.options.backoffMs=[2000, 5000, 15000, 30000, 60000]] esperas entre novas
 *   tentativas depois de falha de rede/servidor (a última se repete)
 * @param {number} [params.options.requiredSchemaVersion=SCHEMA_VERSION] versão mínima do schema no servidor
 * @param {() => boolean} [params.options.isOnline] `false` = sem rede: ciclos automáticos nem tentam
 * @param {{ setTimeout: Function, clearTimeout: Function }} [params.options.timers] temporizadores (testes)
 * @param {number} [params.options.errorRetryMs=300000] intervalo mínimo entre novas tentativas
 *   AUTOMÁTICAS de linhas que o servidor já recusou (pedidos explícitos sempre tentam)
 * @param {number} [params.options.fullPullIntervalMs=86400000] de tempos em tempos o recebimento
 *   recomeça do zero, como rede de segurança (0 desliga)
 *
 * @returns {object} sync:
 *   - `start()` / `stop()` — liga/desliga a sincronização automática (start sincroniza na hora)
 *   - `syncNow({ reason })` → `Promise<{ ok, pushed, pulled, failures, state, error }>` (nunca rejeita)
 *   - `requestSync()` — pede um ciclo daqui a `debounceMs` (várias chamadas viram uma)
 *   - `status()` → `{ state, pending, lastSyncAt, lastError, failures, user }`
 *   - `subscribe(fn)` → função que cancela; `fn(status)` é chamada a cada mudança de status
 *   - `resetCursors()` → Promise; o próximo ciclo baixa tudo de novo
 *
 * Estados: `'disabled'`, `'needs-login'`, `'needs-reload'` (sessão de outra conta), `'idle'`, `'syncing'`,
 * `'offline'`, `'error'`, `'schema-outdated'`.
 */
export function createSyncEngine({ store, remote = null, wall = null, tables = TABLES, owner, options = {} } = {}) {
  if (!store || typeof store.applyRemote !== 'function') throw new TypeError('createSyncEngine: informe o store.');
  const clockWall = wall || createWallClock();
  const given = options || {};
  const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
  const opts = {
    intervalMs: positive(given.intervalMs, 45000),
    debounceMs: Number.isFinite(given.debounceMs) && given.debounceMs >= 0 ? given.debounceMs : 1200,
    pageSize: Math.floor(positive(given.pageSize, 1000)),
    chunkSize: Math.max(1, Math.floor(positive(given.chunkSize, 200))),
    backoffMs: Array.isArray(given.backoffMs) && given.backoffMs.length ? given.backoffMs.map((ms) => positive(ms, 1000)) : DEFAULT_BACKOFF,
    requiredSchemaVersion: Number.isFinite(given.requiredSchemaVersion) ? given.requiredSchemaVersion : SCHEMA_VERSION,
    isOnline: typeof given.isOnline === 'function' ? given.isOnline : defaultIsOnline,
    timers: given.timers && typeof given.timers.setTimeout === 'function' ? given.timers : defaultTimers,
    errorRetryMs: positive(given.errorRetryMs, 5 * 60 * 1000),
    fullPullIntervalMs: Number.isFinite(given.fullPullIntervalMs) && given.fullPullIntervalMs >= 0 ? given.fullPullIntervalMs : 24 * 60 * 60 * 1000,
  };
  const enabled = !!(remote && remote.configured);

  // --- conta dona do banco local ---------------------------------------------------
  /** Id do usuário dono do banco; null = ninguém (modo local, ou conflito entre as fontes). */
  const ownerId = (() => {
    const stored = store.meta.get(META_OWNER);
    // Fontes, da mais forte para a mais fraca: o informado por quem criou o motor, o gravado no
    // banco e o nome do banco. Se duas delas discordam, o banco não sincroniza com ninguém.
    const sources = [];
    if (owner !== undefined) sources.push(typeof owner === 'string' && owner ? owner : null);
    if (typeof stored === 'string' && stored) sources.push(stored);
    const named = ownerFromDbName(store.dbName);
    if (named !== undefined) sources.push(named);
    if (sources.length) return sources.every((s) => s === sources[0]) ? sources[0] : null;
    if (!enabled) return null;
    try {
      const current = remote.auth.session();
      return current && current.user && typeof current.user.id === 'string' && current.user.id ? current.user.id : null;
    } catch {
      return null;
    }
  })();
  if (ownerId && store.meta.get(META_OWNER) !== ownerId) {
    try {
      store.meta.set(META_OWNER, ownerId).catch((e) => console.error('[sync] Falha ao gravar a conta dona do banco local:', e));
    } catch (e) {
      console.error('[sync] Falha ao gravar a conta dona do banco local:', e);
    }
  }

  /** A sessão é de outra conta (ou o banco é do modo local)? Então nada vai nem vem do servidor. */
  function foreign(session) {
    return !!session && (!ownerId || !session.user || session.user.id !== ownerId);
  }

  // --- estado -------------------------------------------------------------------
  /** Estado guardado; o estado PUBLICADO é calculado em currentState() (sessão pode mudar por fora). */
  let state = 'idle';
  /** { message, hint, kind } da última falha de ciclo (null depois de um ciclo completo). */
  let lastError = null;
  /** Token de acesso em uso quando o servidor recusou a sessão (para saber se já houve novo login). */
  let authFailedToken = null;
  const storedLastSync = store.meta.get(META_LAST_SYNC);
  let lastSyncAt = typeof storedLastSync === 'string' ? storedLastSync : null;

  let started = false;
  /** Cresce a cada stop(): ciclos em andamento percebem e param sem tocar no banco. */
  let epoch = 0;
  /** Há um ciclo em andamento? */
  let running = false;
  /** Pedido de ciclo feito durante outro ciclo: { promise, resolve, reason, epoch }. */
  let followUp = null;
  let schemaChecked = false;
  /** Quantas falhas de rede/servidor seguidas (posição na escada de esperas). */
  let attempt = 0;
  /** O navegador disse "offline" mas a rede funcionou: não confiar mais em isOnline(). */
  let distrustOnline = false;
  /** As linhas já recusadas podem ser tentadas de novo num ciclo automático? */
  let errorRetryDue = true;
  /** Cresce a cada resetCursors(): o recebimento em andamento recomeça. */
  let cursorEpoch = 0;
  /** Pode haver linhas com erro no store? (evita varrer as pendências a cada status()) */
  let mayHaveFailures = true;
  let failuresCache = [];
  /** Envio em curso: chave → rev das linhas tratadas neste ciclo (enviadas, recusadas ou adiadas). */
  let handled = new Map();
  /** Alguma linha foi recusada pelo servidor no envio em curso? */
  let rejectedInPush = false;
  let lastUserId = null;

  let debounceTimer = null;
  let retryTimer = null;
  let intervalTimer = null;
  let errorRetryTimer = null;
  let offStore = null;
  let offAuth = null;
  const subscribers = new Set();
  let lastSignature = null;

  const { timers } = opts;

  function clearTimer(id) {
    if (id !== null) timers.clearTimeout(id);
    return null;
  }

  // --- status -------------------------------------------------------------------
  function sessionOf() {
    if (!enabled) return null;
    try {
      return remote.auth.session();
    } catch {
      return null;
    }
  }

  function currentState(session) {
    if (!enabled) return 'disabled';
    if (running) return 'syncing';
    if (!session) return 'needs-login';
    if (foreign(session)) return 'needs-reload';
    if (state === 'needs-login') {
      // Sessão nova desde a recusa (o usuário entrou de novo): volta ao normal até o próximo ciclo.
      return session.access_token === authFailedToken ? 'needs-login' : 'idle';
    }
    return state === 'syncing' ? 'idle' : state;
  }

  function scanFailures() {
    if (!mayHaveFailures) return failuresCache;
    const list = [];
    for (const entry of store.dirty()) {
      if (entry.error) list.push({ table: entry.table, id: entry.id, message: entry.error });
    }
    failuresCache = list;
    mayHaveFailures = list.length > 0;
    return list;
  }

  /**
   * Situação atual da sincronização.
   * @returns {{ state: string, pending: number, lastSyncAt: string|null,
   *   lastError: { message: string, hint: string, kind: string }|null,
   *   failures: { table: string, id: string, message: string }[],
   *   user: { id: string, email: string|null }|null }}
   */
  function status() {
    const session = sessionOf();
    const current = currentState(session);
    const showError = current === 'offline' || current === 'error' || current === 'schema-outdated' || current === 'needs-login';
    const error = current === 'needs-reload' ? ACCOUNT_ERROR : showError ? lastError : null;
    let pending = 0;
    let failures = [];
    try {
      pending = store.pendingCount();
      failures = scanFailures().map((f) => ({ ...f }));
    } catch {
      /* store fechado: mostra o que der */
    }
    return {
      state: current,
      pending,
      lastSyncAt,
      lastError: error ? { ...error } : null,
      failures,
      user: session ? { id: session.user.id, email: session.user.email } : null,
    };
  }

  function emit() {
    if (!subscribers.size) {
      lastSignature = null;
      return;
    }
    const s = status();
    const signature = [
      s.state, s.pending, s.lastSyncAt, s.lastError ? `${s.lastError.kind}:${s.lastError.message}` : '',
      s.user ? s.user.id : '', s.failures.map((f) => `${f.table}:${f.id}`).join(','),
    ].join('|');
    if (signature === lastSignature) return;
    lastSignature = signature;
    for (const listener of [...subscribers]) {
      try {
        listener(s);
      } catch (e) {
        console.error('[sync] Erro num ouvinte de status:', e);
      }
    }
  }

  /**
   * Acompanha as mudanças de status.
   * @param {(status: object) => void} listener chamado a cada mudança (não é chamado na inscrição)
   * @returns {() => void} função que cancela a inscrição
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('subscribe: informe uma função.');
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  // --- agendamento ----------------------------------------------------------------
  function armInterval() {
    intervalTimer = clearTimer(intervalTimer);
    if (!started || !enabled) return;
    intervalTimer = timers.setTimeout(() => {
      intervalTimer = null;
      syncNow({ reason: 'interval' });
    }, opts.intervalMs);
  }

  function scheduleRetry() {
    retryTimer = clearTimer(retryTimer);
    if (!started) return;
    const delay = opts.backoffMs[Math.min(attempt, opts.backoffMs.length - 1)];
    attempt += 1;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      syncNow({ reason: 'retry' });
    }, delay);
  }

  /**
   * Pede um ciclo daqui a `debounceMs`; chamadas repetidas reiniciam a espera (várias alterações
   * seguidas viram um único envio).
   */
  function requestSync() {
    if (!enabled) return;
    debounceTimer = clearTimer(debounceTimer);
    debounceTimer = timers.setTimeout(() => {
      debounceTimer = null;
      syncNow({ reason: 'change' });
    }, opts.debounceMs);
  }

  // --- ciclo ------------------------------------------------------------------------
  function setError(error) {
    lastError = { message: error.message, hint: error.hint || '', kind: error.kind };
  }

  /** Converte qualquer falha num RemoteError-like { kind, message, hint }. */
  function describeFailure(e) {
    if (e instanceof RemoteError) return e;
    console.error('[sync] Erro inesperado na sincronização:', e);
    return {
      kind: 'internal',
      message: `Erro inesperado na sincronização: ${(e && e.message) || e}`,
      hint: 'Tente sincronizar de novo. Se o erro continuar, exporte um backup e recarregue o aplicativo.',
    };
  }

  function handleFailure(e) {
    const error = describeFailure(e);
    setError(error);
    switch (error.kind) {
      case 'network':
        state = 'offline';
        scheduleRetry();
        break;
      case 'server':
        state = 'error';
        scheduleRetry();
        break;
      case 'auth': {
        state = 'needs-login';
        // O token em uso AGORA (pode ter sido renovado durante o ciclo): enquanto ele não mudar,
        // o servidor continua recusando — só um novo login tira o motor deste estado.
        const current = sessionOf();
        authFailedToken = current ? current.access_token : null;
        break;
      }
      case 'schema':
        state = 'schema-outdated';
        schemaChecked = false;
        break;
      default: // 'config', 'rejected' fora de uma linha, erro interno: só o ciclo periódico tenta de novo
        state = 'error';
    }
  }

  async function checkSchema(guard) {
    if (schemaChecked) return;
    const installed = await remote.schemaVersion();
    guard();
    const required = opts.requiredSchemaVersion;
    if (installed === null || installed === undefined || !(Number(installed) >= required)) {
      const message = installed === null || installed === undefined
        ? 'O banco de dados do Supabase ainda não foi preparado para o Demand Manager.'
        : `O banco de dados do Supabase está desatualizado (versão ${installed}; este aplicativo precisa da versão ${required}).`;
      throw new RemoteError('schema', message, { code: 'schema_version', hint: HINT_SCHEMA, details: { installed: installed ?? null, required } });
    }
    schemaChecked = true;
  }

  /** Registra a recusa definitiva (neste ciclo) de uma linha pelo servidor. */
  function rejectRow(desc, item, error) {
    const id = item.row[desc.idField];
    // A linha mudou durante o envio: o que foi recusado já não é o que está guardado. Sem marca de
    // erro ela é enviada de novo no ciclo seguinte (e, se continuar inválida, marcada então).
    if (store.get(desc.name, id) !== item.row) return;
    const code = error.code ? ` [código ${error.code}]` : '';
    store.markError(desc.name, id, `${error.message}${code}`);
    mayHaveFailures = true;
    rejectedInPush = true;
  }

  /**
   * Envia um lote e baixa as pendências confirmadas. Devolve `{ accepted, unanswered }`: quantas
   * linhas o servidor confirmou e as linhas (de tabela mutável) que ele não devolveu na resposta.
   * Lança o erro do servidor sem ter marcado nada (o lote é uma transação só no servidor).
   */
  async function deliver(desc, items, guard) {
    const lww = desc.mode === 'lww';
    const payload = items.map(({ row }) => toRemoteRow(desc.name, row));
    const returned = lww ? await remote.upsert(desc, payload) : await remote.insertIgnore(desc, payload);
    guard();
    if (!Array.isArray(returned)) {
      throw new RemoteError('network', 'A resposta recebida não veio do servidor de sincronização.', { code: 'unexpected_response', hint: HINT_OFFLINE });
    }
    // `confirm`: estas linhas são a resposta ao NOSSO envio — carimbos reduzidos pelo servidor valem.
    store.applyRemote(desc.name, returned, { confirm: lww });
    const answers = new Map();
    for (const row of returned) if (row && typeof row === 'object') answers.set(row[desc.idField], row);
    let accepted = 0;
    const unanswered = [];
    for (const item of items) {
      const id = item.row[desc.idField];
      if (lww) {
        // Tabela mutável: a confirmação é a própria linha devolvida. (Na tabela de histórico a
        // linha ausente da resposta já existia no servidor — também está confirmada.)
        const answer = answers.get(id);
        if (!answer) {
          unanswered.push(item);
          continue;
        }
        const current = store.get(desc.name, id);
        if (current && !serverHasEverything(desc, current, answer)) {
          // Mudou durante o envio, ou o servidor ficou com outro valor: continua pendente.
          accepted += 1;
          continue;
        }
      }
      accepted += 1;
      store.markSynced(desc.name, id, item.rev); // false = a linha mudou durante o envio: segue pendente
    }
    return { accepted, unanswered };
  }

  /**
   * Envia um lote; se o servidor RECUSAR o lote, divide ao meio até isolar a(s) linha(s)
   * problemática(s), que ficam marcadas com o erro, enquanto as demais são entregues.
   * Soma em `result.pushed` as linhas aceitas (mesmo que uma metade seguinte falhe).
   */
  async function sendChunk(desc, items, guard, result) {
    let outcome;
    try {
      outcome = await deliver(desc, items, guard);
    } catch (e) {
      if (!(e instanceof RemoteError) || e.kind !== 'rejected') throw e;
      guard();
      if (items.length === 1) {
        rejectRow(desc, items[0], e);
        return;
      }
      const middle = Math.ceil(items.length / 2);
      await sendChunk(desc, items.slice(0, middle), guard, result);
      await sendChunk(desc, items.slice(middle), guard, result);
      return;
    }
    result.pushed += outcome.accepted;
    // O servidor aceitou o lote mas devolveu menos linhas do que recebeu (resposta limitada): sem a
    // linha devolvida não há confirmação. Reenvia as que faltaram em lotes que caibam na resposta
    // (reenviar é inofensivo); uma linha sozinha que continua sem resposta fica pendente.
    const missing = outcome.unanswered;
    if (!missing.length || items.length === 1) return;
    const answered = items.length - missing.length;
    const size = answered > 0 ? answered : Math.ceil(items.length / 2);
    for (let i = 0; i < missing.length; i += size) await sendChunk(desc, missing.slice(i, i + size), guard, result);
  }

  /** Envia as pendências; soma em `result.pushed` à medida que o servidor confirma (vale mesmo se falhar no meio). */
  async function push(guard, retryErrors, result) {
    handled = new Map();
    rejectedInPush = false;
    const erroredKeys = new Set();
    for (const entry of store.dirty()) if (entry.error) erroredKeys.add(dirtyKey(entry.table, entry.id));
    let retriedErrors = false;
    try {
      for (const desc of tables) {
        const snapshot = store.dirtySnapshot(desc.name);
        if (!snapshot.length) continue;
        const toSend = [];
        for (const item of snapshot) {
          const key = dirtyKey(desc.name, item.row[desc.idField]);
          handled.set(key, item.rev);
          if (erroredKeys.has(key)) {
            if (!retryErrors) continue; // já recusada: espera a próxima janela de novas tentativas
            retriedErrors = true;
          }
          toSend.push(item);
        }
        const ordered = parentsFirst(desc, toSend);
        for (let i = 0; i < ordered.length; i += opts.chunkSize) {
          await sendChunk(desc, ordered.slice(i, i + opts.chunkSize), guard, result);
          emit(); // o número de pendências caiu
        }
      }
    } finally {
      if (retriedErrors || rejectedInPush) {
        // Linhas recusadas raramente passam a ser aceitas sozinhas: não insistir a cada ciclo
        // automático (pedidos explícitos e linhas editadas pelo usuário são sempre enviados).
        errorRetryDue = false;
        errorRetryTimer = clearTimer(errorRetryTimer);
        errorRetryTimer = timers.setTimeout(() => {
          errorRetryTimer = null;
          errorRetryDue = true;
        }, opts.errorRetryMs);
      }
    }
  }

  function cursorOf(desc) {
    const n = Number(store.meta.get(CURSOR_PREFIX + desc.name));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function clearCursors() {
    cursorEpoch += 1;
    return Promise.all(tables.map((desc) => store.meta.set(CURSOR_PREFIX + desc.name, undefined)));
  }

  /** Rede de segurança: de tempos em tempos (fullPullIntervalMs) o recebimento recomeça do zero. */
  async function maybeRestartFromZero() {
    if (!opts.fullPullIntervalMs) return;
    const nowMs = clockWall.nowMs();
    const last = Date.parse(store.meta.get(META_LAST_FULL_PULL) || '');
    if (Number.isFinite(last) && nowMs - last < opts.fullPullIntervalMs) return;
    if (Number.isFinite(last)) await clearCursors(); // na primeira vez os cursores já estão no zero
    await store.meta.set(META_LAST_FULL_PULL, new Date(nowMs).toISOString());
  }

  /** Recebe o que há de novo; soma em `result.pulled` as linhas locais alteradas. */
  async function pull(guard, result) {
    await maybeRestartFromZero();
    guard();
    restart: for (;;) {
      const myEpoch = cursorEpoch;
      for (const desc of tables) {
        const key = CURSOR_PREFIX + desc.name;
        let cursor = cursorOf(desc);
        for (;;) {
          const rows = await remote.pull(desc, cursor, opts.pageSize);
          guard();
          if (cursorEpoch !== myEpoch) continue restart; // resetCursors() no meio do recebimento
          if (!Array.isArray(rows)) {
            throw new RemoteError('network', 'A resposta recebida não veio do servidor de sincronização.', { code: 'unexpected_response', hint: HINT_OFFLINE });
          }
          // Só uma página VAZIA encerra: o servidor pode devolver menos linhas do que foi pedido.
          if (rows.length === 0) break;
          const applied = store.applyRemote(desc.name, rows);
          result.pulled += applied.changed;
          // O cursor só avança depois que as linhas estão no disco: se a gravação falhar, elas são
          // baixadas de novo (depois de recarregar) em vez de ficarem para trás do cursor.
          try {
            await applied.persisted;
          } catch (e) {
            throw storageError(e);
          }
          guard();
          let highest = cursor;
          for (const row of rows) {
            const seq = Number(row && row.server_seq);
            if (Number.isFinite(seq) && seq > highest) highest = seq;
          }
          if (highest <= cursor) break; // resposta que não avança o cursor: evita repetir para sempre
          cursor = highest;
          await store.meta.set(key, cursor);
          guard();
          if (cursorEpoch !== myEpoch) continue restart;
        }
      }
      return;
    }
  }

  /** Há linhas pendentes que este ciclo não tratou (novas, ou alteradas durante o envio)? */
  function hasUnsentChanges() {
    for (const desc of tables) {
      for (const { row, rev } of store.dirtySnapshot(desc.name)) {
        if (handled.get(dirtyKey(desc.name, row[desc.idField])) !== rev) return true;
      }
    }
    return false;
  }

  /** Um ciclo completo. Nunca rejeita por falha de sincronização: o desfecho fica em `state`/`lastError`. */
  async function runCycle(reason) {
    const result = { ok: false, pushed: 0, pulled: 0, failures: [], state: 'idle', error: null };
    if (!enabled) return result;
    if (!sessionOf()) {
      if (state !== 'needs-login') lastError = null;
      state = 'needs-login';
      authFailedToken = null;
      return result;
    }
    // Sessão de outra conta: este banco não é dela. Nada é enviado nem recebido (status 'needs-reload').
    if (foreign(sessionOf())) return result;
    const explicit = !AUTOMATIC_REASONS.has(reason);
    if (!explicit && !distrustOnline && !opts.isOnline()) {
      state = 'offline';
      lastError = { message: 'Sem conexão com a internet.', hint: HINT_OFFLINE, kind: 'network' };
      scheduleRetry();
      return result;
    }

    const myEpoch = epoch;
    const guard = () => {
      if (epoch !== myEpoch) throw new Aborted();
      // Chamado depois de cada espera, antes da próxima requisição: a sessão pode ter mudado no meio.
      if (foreign(sessionOf())) throw new AccountChanged();
    };
    state = 'syncing';
    emit();
    try {
      await checkSchema(guard);
      // Envia mesmo com o armazenamento local falhando: no servidor as alterações ficam a salvo.
      await push(guard, explicit || errorRetryDue, result);
      // Mas não recebe: a memória já não bate com o disco e o cursor passaria por linhas não gravadas.
      if (store.persistError) throw storageError(store.persistError);
      await pull(guard, result);
      if (!opts.isOnline()) distrustOnline = true; // funcionou apesar do aviso de "offline"
      lastSyncAt = clockWall.nowIso();
      store.meta.set(META_LAST_SYNC, lastSyncAt).catch(() => {});
      attempt = 0;
      retryTimer = clearTimer(retryTimer);
      lastError = null;
      authFailedToken = null;
      state = 'idle';
      result.ok = true;
    } catch (e) {
      // Parado no meio (stop): qualquer falha a partir daí é consequência da parada, não um erro.
      if (e instanceof Aborted || epoch !== myEpoch) state = 'idle';
      else if (e instanceof AccountChanged || foreign(sessionOf())) state = 'idle'; // o status mostra 'needs-reload'
      else handleFailure(e);
    }
    return result;
  }

  function launch(reason) {
    debounceTimer = clearTimer(debounceTimer);
    retryTimer = clearTimer(retryTimer);
    // Marcado ANTES de o ciclo começar: quem consultar/for avisado durante o ciclo já vê 'syncing'.
    running = true;
    let cycle;
    try {
      cycle = runCycle(reason);
    } catch (e) {
      cycle = Promise.reject(e);
    }
    return cycle
      .catch((e) => {
        // runCycle trata as próprias falhas; isto só protege contra um defeito no próprio motor.
        state = 'error';
        setError(describeFailure(e));
        return { ok: false, pushed: 0, pulled: 0, failures: [], state: 'error', error: null };
      })
      .then((result) => {
        running = false;
        // Só agora (ciclo encerrado) o status mostra o desfecho de verdade.
        const s = status();
        result.failures = s.failures;
        result.state = s.state;
        result.error = s.lastError;
        const next = followUp;
        followUp = null;
        if (next && next.epoch === epoch) {
          launch(next.reason).then(next.resolve);
          return result;
        }
        // Pedido feito ANTES de um stop(): o motor foi parado, não começa outro ciclo por conta dele.
        if (next) next.resolve(result);
        armInterval();
        try {
          if (started && result.ok && hasUnsentChanges()) requestSync();
        } catch {
          /* store fechado logo depois do ciclo */
        }
        emit();
        return result;
      });
  }

  /**
   * Sincroniza agora. Nunca rejeita: as falhas ficam em `status()` e no resultado.
   * Chamadas feitas durante um ciclo viram UM único ciclo seguinte e resolvem com o resultado dele.
   *
   * @param {{ reason?: string }} [options] motivo (diagnóstico). Motivos automáticos ('change',
   *   'interval', 'retry', 'online', 'visible') respeitam `isOnline()` e a janela de novas tentativas
   *   de linhas recusadas; qualquer outro (padrão `'manual'`) é um pedido explícito e tenta tudo.
   * @returns {Promise<{ ok: boolean, pushed: number, pulled: number,
   *   failures: { table: string, id: string, message: string }[], state: string,
   *   error: { message: string, hint: string, kind: string }|null }>}
   *   `ok`: o ciclo foi até o fim (envio + recebimento); `pushed`: linhas aceitas pelo servidor;
   *   `pulled`: linhas locais alteradas pelo que veio do servidor; `failures`: linhas recusadas.
   */
  function syncNow({ reason = 'manual' } = {}) {
    if (running) {
      if (!followUp) {
        let resolve;
        const promise = new Promise((r) => {
          resolve = r;
        });
        followUp = { promise, resolve, reason, epoch };
      } else {
        followUp.epoch = epoch; // vale o pedido mais recente (pode ser posterior a um stop() + start())
        if (!AUTOMATIC_REASONS.has(reason)) followUp.reason = reason; // pedido explícito prevalece sobre automático
      }
      return followUp.promise;
    }
    return launch(reason);
  }

  // --- gatilhos -----------------------------------------------------------------------
  function onStoreChange(event) {
    if (event && (event.origin === 'local' || event.origin === 'load')) {
      let pending = 0;
      try {
        pending = store.pendingCount();
      } catch {
        return;
      }
      if (pending > 0) requestSync();
    }
    emit();
  }

  function onAuthChange(session) {
    const userId = session ? session.user.id : null;
    if (userId === lastUserId) return; // só renovação de token
    lastUserId = userId;
    schemaChecked = false;
    attempt = 0;
    emit();
    // Sem sessão, ou sessão de outra conta (entrou em outra aba): nada a sincronizar até recarregar.
    if (!session || foreign(session)) return;
    if (started) syncNow({ reason: 'login' });
  }

  function onOnline() {
    if (started) syncNow({ reason: 'online' });
  }

  function onOffline() {
    if (!started || running || !enabled || !sessionOf()) return;
    state = 'offline';
    lastError = { message: 'Sem conexão com a internet.', hint: HINT_OFFLINE, kind: 'network' };
    emit();
  }

  function onVisibility() {
    if (!started || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    const current = currentState(sessionOf());
    if (current === 'offline' || current === 'error') syncNow({ reason: 'visible' });
    else if (current === 'idle') requestSync();
  }

  /**
   * Liga a sincronização automática: sincroniza na hora, depois a cada alteração local (com
   * espera de `debounceMs`), a cada `intervalMs`, quando a conexão volta e quando a aba volta a
   * ficar visível. Chamar de novo não faz nada.
   */
  function start() {
    if (started) return;
    started = true;
    errorRetryDue = true;
    lastUserId = (sessionOf() || { user: { id: null } }).user.id;
    offStore = store.subscribe(onStoreChange);
    if (enabled && remote.auth && typeof remote.auth.onChange === 'function') offAuth = remote.auth.onChange(onAuthChange);
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('online', onOnline);
      globalThis.addEventListener('offline', onOffline);
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    emit();
    if (enabled) syncNow({ reason: 'start' });
  }

  /**
   * Desliga a sincronização automática: cancela temporizadores e ouvintes. Um ciclo em andamento
   * para na próxima etapa sem tocar no banco; o que não foi confirmado continua pendente.
   */
  function stop() {
    // Vale mesmo sem start(): um syncNow()/requestSync() avulso também é interrompido.
    epoch += 1;
    debounceTimer = clearTimer(debounceTimer);
    retryTimer = clearTimer(retryTimer);
    intervalTimer = clearTimer(intervalTimer);
    errorRetryTimer = clearTimer(errorRetryTimer);
    errorRetryDue = true;
    attempt = 0;
    if (!started) return;
    started = false;
    if (offStore) offStore();
    if (offAuth) offAuth();
    offStore = null;
    offAuth = null;
    if (typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('online', onOnline);
      globalThis.removeEventListener('offline', onOffline);
    }
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  }

  /**
   * Esquece os cursores de recebimento: o próximo ciclo baixa todas as linhas de novo (o merge
   * campo a campo garante que nada local se perde). Não dispara um ciclo por conta própria.
   * @returns {Promise<void>} resolvida quando os cursores foram apagados
   */
  async function resetCursors() {
    await clearCursors();
    await store.meta.set(META_LAST_FULL_PULL, clockWall.nowIso());
  }

  return { start, stop, syncNow, requestSync, status, subscribe, resetCursors };
}
