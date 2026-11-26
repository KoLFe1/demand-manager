// Banco local do Demand Manager: tabelas em memória + persistência no IndexedDB + eventos de mudança.
//
//   const store = await createStore({ dbName: 'dm-local' });
//   const task = store.insert('tasks', { name: 'Revisar relatório' });
//   store.update('tasks', task.id, { status: 'doing' });
//   store.subscribe(({ tables, origin }) => { ... });
//
// Princípios (ver docs/ARQUITETURA.md, seção 5):
//   - leituras são SÍNCRONAS e vêm da memória; escritas alteram a memória na hora (a tela atualiza
//     imediatamente) e são gravadas em seguida no IndexedDB, em ordem (fila de transações);
//   - linhas são imutáveis (congeladas): toda alteração cria uma linha nova;
//   - cada alteração local carimba os campos alterados (field_ts) e marca a linha como pendente de
//     envio, na MESMA transação do IndexedDB que grava a linha;
//   - linhas vindas do servidor, de outra aba ou de um backup entram por merge campo a campo
//     (js/data/merge.js).

import { uuid, createClock } from '../core/ids.js';
import { isValidDateStr } from '../core/dates.js';
import { TABLES, TABLE_NAMES, SCHEMA_VERSION, tableDesc, fromRemoteRow } from './schema.js';
import { openDb, txDone, getAll, deleteDb } from './idb.js';
import { mergeRow, applyPatch, rowsEqual, freezeDeep, frozenCopy } from './merge.js';

const META_STORE = '_meta';
const DIRTY_STORE = '_dirty';
const APP_ID = 'demand-manager';
const CREATED = 'created_at';
const UPDATED = 'updated_at';
const DELETED = 'deleted_at';

const EMPTY_ROWS = Object.freeze([]);
const EMPTY_STAMPS = Object.freeze({});
const noop = () => {};
const RESOLVED = Promise.resolve();

const dirtyKey = (table, id) => `${table}:${id}`;

/**
 * Apaga um banco local inteiro (usado pelos testes e pelo "sair e apagar dados deste aparelho").
 * Feche o store antes (`await store.close()`); conexões ainda abertas se fecham sozinhas.
 * @param {string} dbName nome do banco IndexedDB
 * @returns {Promise<void>}
 */
export function deleteDatabase(dbName) {
  return deleteDb(dbName);
}

// ---------------------------------------------------------------------------
// Validação de valores
// ---------------------------------------------------------------------------

/** Cópia imutável de um valor JSON; rejeita o que não pode ser gravado/sincronizado. */
function jsonValue(v, where) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`${where}: número inválido em valor JSON.`);
    return v;
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new TypeError(`${where}: data inválida em valor JSON.`);
    return v.toISOString();
  }
  if (Array.isArray(v)) return Object.freeze(v.map((item) => (item === undefined ? null : jsonValue(item, where))));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) out[k] = jsonValue(v[k], where);
    return Object.freeze(out);
  }
  throw new TypeError(`${where}: valor do tipo ${typeof v} não pode ser gravado como JSON.`);
}

/**
 * Valida um valor (diferente de undefined) contra a definição do campo e devolve a forma canônica
 * e imutável. Lança erro com mensagem em pt-BR quando o valor não serve.
 */
function checkValue(table, field, def, v) {
  const where = `${table}.${field}`;
  if (v === null) {
    if (def.required) throw new Error(`${where}: campo obrigatório não pode ficar vazio.`);
    if (def.type === 'text[]') throw new TypeError(`${where}: esperava uma lista (array), recebeu null.`);
    return null;
  }
  switch (def.type) {
    case 'text':
    case 'uuid':
      if (typeof v !== 'string') throw new TypeError(`${where}: esperava texto, recebeu ${typeof v}.`);
      if (def.required && v.trim() === '') throw new Error(`${where}: campo obrigatório não pode ficar vazio.`);
      return v;
    case 'date':
      if (!isValidDateStr(v)) throw new TypeError(`${where}: data inválida (${String(v)}); use 'AAAA-MM-DD' ou null.`);
      return v;
    case 'timestamp': {
      const d = v instanceof Date ? v : typeof v === 'string' ? new Date(v) : null;
      if (!d || Number.isNaN(d.getTime())) throw new TypeError(`${where}: instante inválido (${String(v)}); use ISO UTC ou null.`);
      return d.toISOString();
    }
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new TypeError(`${where}: esperava número inteiro, recebeu ${String(v)}.`);
      return v;
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${where}: esperava número, recebeu ${String(v)}.`);
      return v;
    case 'bool':
      if (typeof v !== 'boolean') throw new TypeError(`${where}: esperava verdadeiro/falso, recebeu ${String(v)}.`);
      return v;
    case 'text[]':
      if (!Array.isArray(v)) throw new TypeError(`${where}: esperava uma lista (array) de textos.`);
      for (const item of v) if (typeof item !== 'string') throw new TypeError(`${where}: a lista só pode conter textos.`);
      return Object.freeze([...v]);
    case 'json':
      return jsonValue(v, where);
    default:
      throw new Error(`${where}: tipo de campo desconhecido no schema (${def.type}).`);
  }
}

/** Maior carimbo de um mapa field_ts (0 se vazio). */
function maxStamp(fieldTs) {
  let max = 0;
  if (fieldTs && typeof fieldTs === 'object') {
    for (const k in fieldTs) {
      const n = fieldTs[k];
      if (typeof n === 'number' && n > max) max = n;
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Cria (abrindo ou inicializando o IndexedDB) o banco local.
 *
 * @param {object} options
 * @param {string} options.dbName            nome do banco IndexedDB (ex.: 'dm-local', 'test-<uuid>')
 * @param {{now():number, observe(ts:number, options?:{trusted?:boolean}):void}} [options.clock]  relógio lógico dos carimbos (`createClock()`)
 * @param {() => Date} [options.now]         relógio de parede (created_at/updated_at/deleted_at)
 * @param {boolean} [options.broadcast=true] avisa/escuta outras abas por BroadcastChannel('dm-store-' + dbName)
 * @param {boolean} [options.guardUnload=true] enquanto houver gravação na fila do IndexedDB, fechar ou
 *   recarregar a página pede confirmação (beforeunload) — senão o navegador aborta a transação
 * @returns {Promise<object>} store já carregado em memória, com a API:
 *
 * Leitura (síncrona, da memória):
 *   - `get(table, id)` → linha ou undefined (inclui excluídas)
 *   - `all(table, { includeDeleted = false })` → array congelado, em cache até a tabela mudar
 *   - `byIndex(table, field, value, { includeDeleted = false })` → array congelado das linhas com
 *     `row[field] === value` (campo lista: linhas cuja lista contém o valor); índice preguiçoso
 *   - `version()` → inteiro que cresce uma vez por lote que mudou algo
 *
 * Escrita local (cada chamada fora de `transact` é um lote de uma operação):
 *   - `insert(table, values)` → linha criada (id, padrões, created_at/updated_at; sem carimbos)
 *   - `update(table, id, patch)` → nova linha; carimba TODAS as chaves do patch
 *   - `put(table, id, values)` → insere ou altera pelo id, carimbando os campos informados
 *   - `remove(table, id)` / `restore(table, id)` → exclusão lógica (deleted_at)
 *   - `transact(fn)` → agrupa escritas: 1 evento + 1 transação IndexedDB; desfaz tudo se `fn` lançar
 *   - `subscribe(listener)` → `listener({ tables: Set<string>, origin: 'local' | 'remote' | 'load' })`,
 *     chamado de forma síncrona ao fim de cada lote; devolve a função que cancela
 *
 * Sincronização:
 *   - `applyRemote(table, remoteRows, { confirm = false })` → `{ changed, persisted }` (quantidade de
 *     linhas alteradas pelo merge; Promise que resolve quando elas estão no IndexedDB e rejeita se a
 *     gravação falhar). `confirm: true` SÓ para a resposta do servidor ao envio dessas mesmas
 *     linhas: carimbos que o servidor reduziu (relógio local adiantado) são adotados quando o valor
 *     é o mesmo. Os carimbos recebidos alimentam o relógio lógico como confiáveis (`trusted`)
 *   - `dirty()` → `[{ table, id, rev, error }]`; `pendingCount()`
 *   - `dirtySnapshot(table, limit = Infinity)` → `[{ row, rev }]` com o estado ATUAL das pendentes
 *   - `markSynced(table, id, rev)` → boolean (só limpa se `rev` ainda é o da pendência)
 *   - `markError(table, id, message)`
 *   - `meta.get(key)` / `meta.set(key, value)` (Promise resolvida quando gravado)
 *
 * Manutenção:
 *   - `flush()` → Promise: fila de gravação esvaziada
 *   - `exportData()` → `{ app, schemaVersion, exportedAt, tables }`
 *   - `importData(data, { mode: 'merge' | 'replace' })` → `Promise<{ total, changed }>`; num banco que
 *     já sincronizou, 'replace' é uma restauração (valores do backup carimbados agora; o que não está
 *     no backup é excluído logicamente), para o servidor e os outros aparelhos ficarem iguais ao backup
 *   - `wipe()` → Promise; `close()` → Promise
 *   - `onPersistError` (atribuível): chamado com o erro quando uma gravação no IndexedDB falha
 *   - `persistError` → a primeira falha de gravação desta sessão (ou null): a partir dela a memória
 *     pode ter o que o disco não tem, até a página ser recarregada
 *   - `busy()` → há gravações na fila do IndexedDB? (enquanto houver, fechar a página pede confirmação)
 *   - `clock`, `dbName`
 */
export async function createStore({ dbName, clock = createClock(), now = () => new Date(), broadcast = true, guardUnload = true } = {}) {
  if (typeof dbName !== 'string' || !dbName) throw new TypeError('createStore: informe dbName.');

  const instanceId = uuid();
  const allStoreNames = [...TABLE_NAMES, META_STORE, DIRTY_STORE];

  /** Estado em memória de cada tabela. */
  const tables = new Map();
  for (const desc of TABLES) {
    tables.set(desc.name, {
      name: desc.name,
      desc,
      lww: desc.mode === 'lww',
      fields: Object.entries(desc.fields),
      rows: new Map(), // id -> linha congelada
      dirty: new Map(), // id -> pendência congelada { key, table, id, rev, error, owner }
      allCache: null,
      liveCache: null,
      indexes: new Map(), // campo -> { all: Map<valor, linhas[]>, live: Map<valor, linhas[]> }
    });
  }
  const metaMap = new Map();
  /** Último rev emitido por linha nesta sessão (evita reusar um rev depois de markSynced). */
  const lastRev = new Map();
  const listeners = new Set();

  let version = 0;
  let closed = false;
  /** Lote de escrita em andamento (null fora de transact). */
  let batch = null;

  // --- canal entre abas: aberto ANTES de ler o banco, para não perder avisos durante a carga -------
  let channel = null;
  let loading = true;
  const earlyMessages = [];
  if (broadcast && typeof BroadcastChannel === 'function') {
    try {
      channel = new BroadcastChannel(`dm-store-${dbName}`);
      channel.onmessage = (ev) => {
        if (loading) earlyMessages.push(ev.data);
        else receive(ev.data);
      };
    } catch {
      channel = null; // contexto sem BroadcastChannel utilizável: segue sem aviso entre abas
    }
  }

  let db;
  try {
    db = await openDb(dbName, SCHEMA_VERSION, (database) => {
      for (const desc of TABLES) {
        if (!database.objectStoreNames.contains(desc.name)) database.createObjectStore(desc.name, { keyPath: desc.idField });
      }
      for (const name of [META_STORE, DIRTY_STORE]) {
        if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: 'key' });
      }
    });

    // --- carga inicial: um único instantâneo de todos os object stores ------------------------------
    const tx = db.transaction(allStoreNames, 'readonly');
    const loaded = await Promise.all(allStoreNames.map((name) => getAll(tx, name)));
    let newestStamp = 0;
    allStoreNames.forEach((name, i) => {
      const records = loaded[i];
      if (name === META_STORE) {
        for (const rec of records) metaMap.set(rec.key, freezeDeep(rec.value));
      } else if (name === DIRTY_STORE) {
        for (const rec of records) {
          const t = tables.get(rec.table);
          if (!t || rec.id == null) continue; // pendência de tabela que este app não conhece
          t.dirty.set(rec.id, Object.freeze({
            key: rec.key,
            table: rec.table,
            id: rec.id,
            rev: Number(rec.rev) || 1,
            error: rec.error == null ? null : String(rec.error),
            owner: rec.owner,
          }));
        }
      } else {
        const t = tables.get(name);
        const idField = t.desc.idField;
        for (const rec of records) {
          const s = maxStamp(rec.field_ts);
          if (s > newestStamp) newestStamp = s;
          t.rows.set(rec[idField], freezeDeep(rec));
        }
      }
    });
    // Nunca gerar carimbos menores que os já gravados (relógio do sistema que andou para trás).
    if (newestStamp) clock.observe(newestStamp);
    // Linhas SEM pendência estão como o servidor as devolveu: os carimbos delas já foram limitados
    // por ele e valem mesmo que o relógio deste aparelho esteja atrasado (ver createClock().observe).
    // As pendentes ficam de fora: podem ter carimbos de um relógio errado ou de um backup importado.
    let newestConfirmed = 0;
    for (const t of tables.values()) {
      if (!t.lww) continue;
      for (const [id, row] of t.rows) {
        if (t.dirty.has(id)) continue;
        const s = maxStamp(row.field_ts);
        if (s > newestConfirmed) newestConfirmed = s;
      }
    }
    if (newestConfirmed) clock.observe(newestConfirmed, { trusted: true });
  } catch (e) {
    if (db) db.close();
    if (channel) channel.close();
    throw e;
  }

  // ---------------------------------------------------------------------------
  // Fila de gravação (write-behind)
  // ---------------------------------------------------------------------------
  let queue = Promise.resolve();
  /** Operações de pendência (markSynced/markError) acumuladas para uma única transação. */
  let dirtyOps = [];
  let dirtyOpsScheduled = false;

  /** Primeira falha de gravação no IndexedDB desta sessão (a memória deixou de bater com o disco). */
  let persistError = null;

  function reportPersistError(err) {
    if (!persistError) persistError = err || new Error('Falha ao gravar no IndexedDB.');
    console.error(`[store ${dbName}] Falha ao gravar no IndexedDB:`, err);
    if (typeof store.onPersistError === 'function') {
      try {
        store.onPersistError(err);
      } catch (e) {
        console.error(`[store ${dbName}] Erro em onPersistError:`, e);
      }
    }
  }

  function runTx(names, work) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(names, 'readwrite');
      } catch (e) {
        reject(e);
        return;
      }
      txDone(tx).then(resolve, reject);
      try {
        work(tx);
      } catch (e) {
        try { tx.abort(); } catch { /* transação já encerrada */ }
        reject(e);
      }
    });
  }

  // --- gravações em andamento: fechar/recarregar a página agora abortaria a transação -----------
  /** Itens da fila ainda não gravados. */
  let inFlight = 0;
  const unloadTarget = guardUnload && typeof window !== 'undefined' && window && typeof window.addEventListener === 'function' ? window : null;
  let unloadArmed = false;

  function onBeforeUnload(ev) {
    if (inFlight === 0) return;
    // O navegador pergunta antes de sair: um lote grande ainda está sendo gravado no IndexedDB.
    ev.preventDefault();
    ev.returnValue = '';
  }

  function setUnloadGuard(on) {
    if (!unloadTarget || on === unloadArmed) return;
    unloadArmed = on;
    // Só fica registrado enquanto há gravação pendente (um ouvinte permanente atrapalharia o cache de navegação).
    if (on) unloadTarget.addEventListener('beforeunload', onBeforeUnload);
    else unloadTarget.removeEventListener('beforeunload', onBeforeUnload);
  }

  function enqueueRaw(names, work, after) {
    inFlight += 1;
    setUnloadGuard(true);
    const p = queue.then(() => runTx(names, work));
    // `after` (aviso às outras abas) roda depois da gravação — com ou sem falha — e antes do próximo item.
    queue = p.then(noop, reportPersistError).then(after || noop).catch((e) => {
      console.error(`[store ${dbName}] Erro depois da gravação:`, e);
    }).then(() => {
      inFlight -= 1;
      if (inFlight === 0) setUnloadGuard(false);
    });
    p.catch(noop); // a falha já é informada pela fila; evita "unhandled rejection" quando ninguém espera `p`
    return p;
  }

  function flushDirtyOps() {
    dirtyOpsScheduled = false;
    if (!dirtyOps.length) return;
    const ops = dirtyOps;
    dirtyOps = [];
    // As outras abas abertas também guardam as pendências (podem enviá-las): avisa o que mudou.
    const put = [];
    const del = [];
    for (const op of ops) {
      if (op.put) put.push(op.put);
      else del.push({ table: op.table, id: op.id, rev: op.rev, owner: op.owner });
    }
    enqueueRaw([DIRTY_STORE], (tx) => {
      const os = tx.objectStore(DIRTY_STORE);
      for (const op of ops) {
        if (op.put) {
          os.put(op.put);
          continue;
        }
        // Só apaga a marca se ela ainda é a que esta aba conhecia: outra aba pode ter alterado a
        // mesma linha nesse meio-tempo, e a pendência dela não pode se perder.
        const rq = os.get(op.key);
        rq.onsuccess = () => {
          const cur = rq.result;
          if (cur && cur.rev === op.rev && cur.owner === op.owner) os.delete(op.key);
        };
      }
    }, () => post({ kind: 'dirty', put, del }));
  }

  function queueDirtyOp(op) {
    dirtyOps.push(op);
    if (!dirtyOpsScheduled) {
      dirtyOpsScheduled = true;
      queueMicrotask(flushDirtyOps);
    }
  }

  /** Enfileira uma transação de gravação, preservando a ordem em relação às operações de pendência. */
  function enqueue(names, work, after) {
    flushDirtyOps();
    return enqueueRaw(names, work, after);
  }

  function post(message) {
    if (!channel) return;
    try {
      channel.postMessage({ ...message, from: instanceId });
    } catch (e) {
      console.error(`[store ${dbName}] Falha ao avisar as outras abas:`, e);
    }
  }

  // ---------------------------------------------------------------------------
  // Infraestrutura de lotes
  // ---------------------------------------------------------------------------
  function assertOpen() {
    if (closed) throw new Error(`O banco local "${dbName}" está fechado.`);
  }

  function table(name) {
    const t = tables.get(name);
    if (!t) tableDesc(name); // lança "Tabela desconhecida"
    return t;
  }

  function invalidate(t) {
    t.allCache = null;
    t.liveCache = null;
    if (t.indexes.size) t.indexes.clear();
  }

  function newBatch(origin, { postRows = true } = {}) {
    return {
      origin,
      postRows,
      rows: new Map(), // estado da tabela -> Map<id, linha anterior | undefined>
      dirty: new Map(), // chave -> { t, id, prev }
      noPersist: null, // Set de linhas que não precisam ser gravadas (já gravadas por outra aba)
    };
  }

  function touchRow(b, t, id, row) {
    let undo = b.rows.get(t);
    if (!undo) b.rows.set(t, (undo = new Map()));
    if (!undo.has(id)) undo.set(id, t.rows.get(id));
    t.rows.set(id, row);
    invalidate(t);
  }

  function touchDirty(b, t, id, entry) {
    const key = dirtyKey(t.name, id);
    if (!b.dirty.has(key)) b.dirty.set(key, { t, id, prev: t.dirty.get(id) });
    if (entry) t.dirty.set(id, entry);
    else t.dirty.delete(id);
  }

  /** Marca (table, id) como pendente de envio com um rev novo e sem erro. */
  function bumpDirty(b, t, id) {
    const key = dirtyKey(t.name, id);
    const prev = t.dirty.get(id);
    const rev = Math.max(prev ? prev.rev : 0, lastRev.get(key) || 0) + 1;
    lastRev.set(key, rev);
    touchDirty(b, t, id, Object.freeze({ key, table: t.name, id, rev, error: null, owner: instanceId }));
  }

  function rollback(b) {
    for (const [t, undo] of b.rows) {
      for (const [id, prev] of undo) {
        if (prev === undefined) t.rows.delete(id);
        else t.rows.set(id, prev);
      }
      invalidate(t);
    }
    for (const { t, id, prev } of b.dirty.values()) {
      if (prev === undefined) t.dirty.delete(id);
      else t.dirty.set(id, prev);
    }
  }

  function notify(tableSet, origin) {
    const event = { tables: tableSet, origin };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (e) {
        console.error(`[store ${dbName}] Erro num ouvinte de mudanças:`, e);
      }
    }
  }

  /**
   * Fecha um lote: grava (1 transação), avisa os ouvintes (1 evento) e as outras abas.
   * `alsoChanged` = tabelas que mudaram fora do lote (ex.: esvaziadas) e entram no mesmo evento.
   */
  function commit(b, alsoChanged = null) {
    const changed = new Set(alsoChanged || []);
    let persisted = RESOLVED;
    if (b.rows.size === 0 && b.dirty.size === 0 && changed.size === 0) return persisted;
    const rowOps = []; // [nome do store, linhas a gravar]
    const message = {};
    let posted = false;
    for (const [t, undo] of b.rows) {
      const rows = [];
      for (const id of undo.keys()) {
        const row = t.rows.get(id);
        if (row !== undefined) rows.push(row);
      }
      if (!rows.length) continue;
      changed.add(t.name);
      message[t.name] = rows;
      posted = true;
      const toPersist = b.noPersist ? rows.filter((r) => !b.noPersist.has(r)) : rows;
      if (toPersist.length) rowOps.push([t.name, toPersist]);
    }
    const dirtyPuts = [];
    const dirtyDels = [];
    const clearedMarks = []; // pendências baixadas neste lote, para as outras abas baixarem também
    for (const [key, { t, id, prev }] of b.dirty) {
      const entry = t.dirty.get(id);
      if (entry) dirtyPuts.push(entry);
      else {
        dirtyDels.push(key);
        if (prev) clearedMarks.push({ table: prev.table, id: prev.id, rev: prev.rev, owner: prev.owner });
      }
    }

    if (rowOps.length || dirtyPuts.length || dirtyDels.length) {
      const names = rowOps.map(([name]) => name);
      if (dirtyPuts.length || dirtyDels.length) names.push(DIRTY_STORE);
      // `trusted`/`confirm` contam às outras abas que as linhas vieram do servidor (carimbos
      // confiáveis) e, se for o caso, que são a confirmação de um envio (carimbos reduzidos valem).
      // As pendências vão junto: a aba que ficar aberta envia o que esta não chegou a enviar.
      const flags = b.fromServer ? { trusted: true, confirm: b.confirm === true } : null;
      let after = null;
      if (b.postRows && posted) after = () => post({ kind: 'rows', tables: message, ...flags, dirty: dirtyPuts, cleared: clearedMarks });
      else if (b.postRows && (dirtyPuts.length || clearedMarks.length)) after = () => post({ kind: 'dirty', put: dirtyPuts, del: clearedMarks });
      persisted = enqueue(names, (tx) => {
        for (const [name, rows] of rowOps) {
          const os = tx.objectStore(name);
          for (const row of rows) os.put(row);
        }
        if (dirtyPuts.length || dirtyDels.length) {
          const os = tx.objectStore(DIRTY_STORE);
          for (const entry of dirtyPuts) os.put(entry);
          for (const key of dirtyDels) os.delete(key);
        }
      }, after);
    }

    if (changed.size) {
      version++;
      notify(changed, b.origin);
    }
    return persisted;
  }

  /** Executa `fn(lote)` dentro do lote aberto ou de um lote próprio de uma operação. */
  function run(fn) {
    if (batch) return fn(batch);
    const b = (batch = newBatch('local'));
    let result;
    try {
      result = fn(b);
    } catch (e) {
      batch = null;
      rollback(b);
      throw e;
    }
    batch = null;
    commit(b);
    return result;
  }

  function assertNoBatch(what) {
    if (batch) throw new Error(`${what} não pode ser chamado dentro de transact().`);
  }

  // ---------------------------------------------------------------------------
  // Escrita local
  // ---------------------------------------------------------------------------
  function assertKnownFields(t, values, what) {
    if (values === null || typeof values !== 'object' || Array.isArray(values)) {
      throw new TypeError(`${what}: esperava um objeto com os campos de "${t.name}".`);
    }
    for (const key of Object.keys(values)) {
      if (!Object.prototype.hasOwnProperty.call(t.desc.fields, key)) {
        throw new Error(`${what}: o campo "${key}" não existe na tabela "${t.name}".`);
      }
    }
  }

  /** Monta a linha de uma inserção (id, padrões, datas de controle), validando os valores. */
  function buildNewRow(t, values, nowIso) {
    const idField = t.desc.idField;
    const row = {};
    for (const [field, def] of t.fields) {
      const v = values[field];
      if (field === idField) {
        if (v === undefined || v === null || v === '') {
          if (def.type !== 'uuid') throw new Error(`insert: informe "${idField}" para a tabela "${t.name}".`);
          row[field] = uuid();
        } else {
          if (typeof v !== 'string') throw new TypeError(`${t.name}.${idField}: o identificador precisa ser texto.`);
          row[field] = v;
        }
        continue;
      }
      if ((field === CREATED || field === UPDATED) && (v === undefined || v === null)) {
        row[field] = nowIso;
        continue;
      }
      if (v === undefined) {
        if (def.required) throw new Error(`${t.name}.${field}: campo obrigatório não informado.`);
        row[field] = def.default === undefined ? null : frozenCopy(def.default);
        continue;
      }
      row[field] = checkValue(t.name, field, def, v);
    }
    if (t.lww) row.field_ts = EMPTY_STAMPS;
    row.server_seq = null;
    return Object.freeze(row);
  }

  /** Valida um patch e devolve um objeto novo só com as chaves definidas, em forma canônica. */
  function cleanPatch(t, patch, what) {
    assertKnownFields(t, patch, what);
    const out = {};
    for (const key of Object.keys(patch)) {
      const v = patch[key];
      if (v === undefined) continue;
      if (key === t.desc.idField) throw new Error(`${what}: o identificador ("${key}") não pode ser alterado.`);
      if (key === CREATED) throw new Error(`${what}: created_at não pode ser alterado.`);
      out[key] = checkValue(t.name, key, t.desc.fields[key], v);
    }
    return out;
  }

  function assertMutable(t, what) {
    if (!t.lww) throw new Error(`${what}: a tabela "${t.name}" é imutável (só aceita inserções).`);
  }

  function existing(t, id, what) {
    const row = t.rows.get(id);
    if (!row) throw new Error(`${what}: registro não encontrado em "${t.name}" (${String(id)}).`);
    return row;
  }

  function insert(tableName, values = {}) {
    assertOpen();
    const t = table(tableName);
    assertKnownFields(t, values, 'insert');
    const row = buildNewRow(t, values, now().toISOString());
    const id = row[t.desc.idField];
    if (t.rows.has(id)) throw new Error(`insert: já existe um registro em "${t.name}" com o identificador ${id}.`);
    return run((b) => {
      touchRow(b, t, id, row);
      bumpDirty(b, t, id);
      return row;
    });
  }

  function writePatch(t, id, patch) {
    return run((b) => {
      const row = applyPatch(t.desc, t.rows.get(id), patch, clock.now(), now().toISOString());
      touchRow(b, t, id, row);
      bumpDirty(b, t, id);
      return row;
    });
  }

  function update(tableName, id, patch) {
    assertOpen();
    const t = table(tableName);
    assertMutable(t, 'update');
    const current = existing(t, id, 'update');
    const clean = cleanPatch(t, patch, 'update');
    if (Object.keys(clean).length === 0) return current;
    return writePatch(t, id, clean);
  }

  function put(tableName, id, values = {}) {
    assertOpen();
    const t = table(tableName);
    assertMutable(t, 'put');
    assertKnownFields(t, values, 'put');
    const idField = t.desc.idField;
    if (id === undefined || id === null || id === '') throw new Error(`put: informe o identificador do registro de "${t.name}".`);
    let rest = values;
    if (values[idField] !== undefined) {
      if (values[idField] !== id) throw new Error(`put: o campo "${idField}" difere do identificador informado.`);
      rest = { ...values };
      delete rest[idField];
    }
    const clean = cleanPatch(t, rest, 'put');
    if (t.rows.has(id)) {
      if (Object.keys(clean).length === 0) return t.rows.get(id);
      return writePatch(t, id, clean);
    }
    // Linha nova: nasce com os padrões e já com os campos informados carimbados, para que o merge
    // entre aparelhos que criaram a mesma chave (ex.: uma configuração) seja campo a campo.
    const nowIso = now().toISOString();
    const base = buildNewRow(t, { ...clean, [idField]: id }, nowIso);
    return run((b) => {
      const row = applyPatch(t.desc, base, clean, clock.now(), base[UPDATED] || nowIso);
      touchRow(b, t, id, row);
      bumpDirty(b, t, id);
      return row;
    });
  }

  function assertSoftDelete(t, what) {
    if (!t.desc.softDelete) throw new Error(`${what}: a tabela "${t.name}" não tem exclusão lógica.`);
  }

  function remove(tableName, id) {
    assertOpen();
    const t = table(tableName);
    assertMutable(t, 'remove');
    assertSoftDelete(t, 'remove');
    const current = existing(t, id, 'remove');
    if (current[DELETED]) return current;
    return writePatch(t, id, { [DELETED]: now().toISOString() });
  }

  function restore(tableName, id) {
    assertOpen();
    const t = table(tableName);
    assertMutable(t, 'restore');
    assertSoftDelete(t, 'restore');
    const current = existing(t, id, 'restore');
    if (!current[DELETED]) return current;
    return writePatch(t, id, { [DELETED]: null });
  }

  function transact(fn) {
    assertOpen();
    if (typeof fn !== 'function') throw new TypeError('transact: informe uma função.');
    const result = run(() => fn(store));
    if (result && typeof result.then === 'function') {
      console.warn(`[store ${dbName}] transact() recebeu uma função assíncrona: só as escritas feitas de forma síncrona entram no lote.`);
    }
    return result;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('subscribe: informe uma função.');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // ---------------------------------------------------------------------------
  // Leitura
  // ---------------------------------------------------------------------------
  function get(tableName, id) {
    return table(tableName).rows.get(id);
  }

  function all(tableName, { includeDeleted = false } = {}) {
    const t = table(tableName);
    if (includeDeleted || !t.desc.softDelete) {
      if (!t.allCache) t.allCache = Object.freeze([...t.rows.values()]);
      return t.allCache;
    }
    if (!t.liveCache) {
      const live = [];
      for (const row of t.rows.values()) if (!row[DELETED]) live.push(row);
      t.liveCache = Object.freeze(live);
    }
    return t.liveCache;
  }

  function buildIndex(t, field) {
    const index = { all: new Map(), live: new Map() };
    const add = (map, key, row) => {
      const list = map.get(key);
      if (list) list.push(row);
      else map.set(key, [row]);
    };
    const soft = t.desc.softDelete;
    for (const row of t.rows.values()) {
      const v = row[field];
      const live = !soft || !row[DELETED];
      if (Array.isArray(v)) {
        for (const key of new Set(v)) {
          add(index.all, key, row);
          if (live) add(index.live, key, row);
        }
      } else {
        const key = v === undefined ? null : v;
        add(index.all, key, row);
        if (live) add(index.live, key, row);
      }
    }
    for (const map of [index.all, index.live]) for (const list of map.values()) Object.freeze(list);
    return index;
  }

  function byIndex(tableName, field, value, { includeDeleted = false } = {}) {
    const t = table(tableName);
    if (!Object.prototype.hasOwnProperty.call(t.desc.fields, field)) {
      throw new Error(`byIndex: o campo "${field}" não existe na tabela "${t.name}".`);
    }
    let index = t.indexes.get(field);
    if (!index) t.indexes.set(field, (index = buildIndex(t, field)));
    const map = includeDeleted || !t.desc.softDelete ? index.all : index.live;
    return map.get(value === undefined ? null : value) || EMPTY_ROWS;
  }

  // ---------------------------------------------------------------------------
  // Suporte à sincronização
  // ---------------------------------------------------------------------------

  /**
   * Faz o merge de uma lista de linhas canônicas contra a memória (sem aplicar nada).
   * @returns {{ results: Map<id, linha>, pending: Map<id, boolean>, same: Set<linha> }}
   *   `same` = linhas resultantes idênticas à recebida (quem enviou já as gravou).
   */
  function mergeList(t, rows, { confirm = false, tieBreak = false, trusted = false } = {}) {
    const idField = t.desc.idField;
    const results = new Map();
    const pending = new Map();
    const same = new Set();
    const mergeOptions = confirm || tieBreak ? { confirm, tieBreak } : undefined;
    let newest = 0;
    for (const incoming of rows) {
      const id = incoming[idField];
      const s = maxStamp(incoming.field_ts);
      if (s > newest) newest = s;
      const local = results.has(id) ? results.get(id) : t.rows.get(id);
      const merged = mergeRow(t.desc, local, incoming, mergeOptions);
      pending.set(id, merged.pending);
      if (!merged.changed) continue;
      results.set(id, merged.row);
      if (rowsEqual(merged.row, incoming)) same.add(merged.row);
    }
    // `trusted`: carimbos vindos do servidor (já limitados por ele) valem mesmo com o relógio local atrasado.
    if (newest) clock.observe(newest, { trusted });
    return { results, pending, same };
  }

  function toCanonical(t, raw, what) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new TypeError(`${what}: linha inválida recebida para "${t.name}".`);
    }
    const row = fromRemoteRow(t.name, raw);
    const id = row[t.desc.idField];
    if (id === null || id === undefined || id === '') {
      throw new TypeError(`${what}: linha de "${t.name}" sem identificador (${t.desc.idField}).`);
    }
    return row;
  }

  /**
   * Merge de linhas vindas do SERVIDOR. `confirm: true` só quando `remoteRows` é a resposta do
   * servidor ao envio dessas mesmas linhas (ver `mergeRow`): adota os carimbos que o servidor
   * reduziu, em vez de deixar a linha pendente para sempre. Nunca use `confirm` em linhas baixadas.
   */
  function applyRemote(tableName, remoteRows, { confirm = false } = {}) {
    assertOpen();
    assertNoBatch('applyRemote');
    const t = table(tableName);
    if (!Array.isArray(remoteRows)) throw new TypeError('applyRemote: esperava uma lista de linhas.');
    const canonical = remoteRows.map((raw) => toCanonical(t, raw, 'applyRemote'));
    const { results, pending } = mergeList(t, canonical, { confirm: confirm === true, trusted: true });
    const b = newBatch('remote');
    b.fromServer = true; // as outras abas também podem confiar nesses carimbos
    b.confirm = confirm === true;
    for (const [id, row] of results) touchRow(b, t, id, row);
    // Defensivo: campo local mais novo que o do servidor numa linha sem pendência → reenviar.
    for (const [id, isPending] of pending) if (isPending && !t.dirty.has(id)) bumpDirty(b, t, id);
    const persisted = commit(b);
    persisted.catch(noop); // a falha já é informada pela fila (onPersistError); quem quiser, espera `persisted`
    const outcome = { changed: results.size };
    // Não enumerável: o resultado continua sendo { changed } para quem só olha a contagem.
    Object.defineProperty(outcome, 'persisted', { value: persisted, enumerable: false });
    return outcome;
  }

  function publicDirty(entry) {
    return { table: entry.table, id: entry.id, rev: entry.rev, error: entry.error };
  }

  function dirty() {
    const out = [];
    for (const t of tables.values()) for (const entry of t.dirty.values()) out.push(publicDirty(entry));
    return out;
  }

  function pendingCount() {
    let n = 0;
    for (const t of tables.values()) n += t.dirty.size;
    return n;
  }

  function dirtySnapshot(tableName, limit = Infinity) {
    const t = table(tableName);
    const max = typeof limit === 'number' && limit >= 0 ? limit : Infinity;
    const out = [];
    for (const entry of t.dirty.values()) {
      if (out.length >= max) break;
      const row = t.rows.get(entry.id);
      if (row) out.push({ row, rev: entry.rev });
    }
    return out;
  }

  function markSynced(tableName, id, rev) {
    assertOpen();
    const t = table(tableName);
    const entry = t.dirty.get(id);
    if (!entry || entry.rev !== rev) return false;
    if (batch) touchDirty(batch, t, id, null);
    else {
      t.dirty.delete(id);
      queueDirtyOp({ key: entry.key, table: entry.table, id: entry.id, rev: entry.rev, owner: entry.owner });
    }
    return true;
  }

  function markError(tableName, id, message) {
    assertOpen();
    const t = table(tableName);
    const entry = t.dirty.get(id);
    if (!entry) return false;
    const next = Object.freeze({ ...entry, error: message == null ? null : String(message) });
    if (batch) touchDirty(batch, t, id, next);
    else {
      t.dirty.set(id, next);
      queueDirtyOp({ put: next });
    }
    return true;
  }

  const meta = {
    /** Valor guardado (ou undefined). Não altere o objeto devolvido. */
    get(key) {
      return metaMap.get(key);
    },
    /** Grava (ou apaga, com `undefined`) uma chave; a Promise resolve quando está no IndexedDB. */
    set(key, value) {
      assertOpen();
      if (typeof key !== 'string' || !key) return Promise.reject(new TypeError('meta.set: informe a chave.'));
      if (value === undefined) {
        metaMap.delete(key);
        return enqueue([META_STORE], (tx) => { tx.objectStore(META_STORE).delete(key); });
      }
      let stored;
      try {
        stored = jsonValue(value, `meta.${key}`);
      } catch (e) {
        return Promise.reject(e);
      }
      metaMap.set(key, stored);
      return enqueue([META_STORE], (tx) => { tx.objectStore(META_STORE).put({ key, value: stored }); });
    },
  };

  async function flush() {
    flushDirtyOps();
    let seen;
    do {
      seen = queue;
      await seen;
      flushDirtyOps();
    } while (seen !== queue);
  }

  // ---------------------------------------------------------------------------
  // Backup, limpeza e fechamento
  // ---------------------------------------------------------------------------
  function exportData() {
    const out = {};
    for (const t of tables.values()) out[t.name] = [...t.rows.values()];
    return { app: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: now().toISOString(), tables: out };
  }

  function clearMemory({ withMeta }) {
    for (const t of tables.values()) {
      t.rows = new Map();
      t.dirty = new Map();
      invalidate(t);
    }
    if (withMeta) metaMap.clear();
  }

  /** Alguma linha deste banco já veio do (ou foi confirmada pelo) servidor? */
  function hasServerRows() {
    for (const t of tables.values()) {
      for (const row of t.rows.values()) if (row.server_seq !== null && row.server_seq !== undefined) return true;
    }
    return false;
  }

  /**
   * Restauração de um backup num banco sincronizado (ver importData): calcula, sem aplicar, as
   * linhas resultantes no mesmo formato de mergeList ({ results, pending }) para cada tabela.
   *   - tabela mutável: cada linha do backup fica com TODOS os campos de dados do backup, carimbados
   *     agora (vencem os do servidor); linhas vivas que não estão no backup são excluídas
   *     (exclusão lógica; tabela sem exclusão lógica — configurações — fica como está);
   *   - histórico (imutável): só acrescenta as linhas do backup que faltam (nada é apagado).
   */
  function restoreResults(prepared) {
    const fromBackup = new Map(prepared);
    const nowIso = now().toISOString();
    const out = [];
    for (const t of tables.values()) {
      const rows = fromBackup.get(t) || [];
      if (!t.lww) {
        if (rows.length) out.push([t, mergeList(t, rows)]);
        continue;
      }
      const idField = t.desc.idField;
      const results = new Map();
      const keep = new Set();
      for (const backupRow of rows) {
        const id = backupRow[idField];
        keep.add(id);
        const patch = {};
        for (const [field, def] of t.fields) {
          if (field === idField || field === CREATED || field === UPDATED || def.server) continue;
          const v = backupRow[field];
          patch[field] = v === undefined ? (def.default === undefined ? null : frozenCopy(def.default)) : v;
        }
        const current = results.get(id) || t.rows.get(id);
        const base = current || Object.freeze({ ...backupRow, field_ts: EMPTY_STAMPS, server_seq: null });
        results.set(id, applyPatch(t.desc, base, patch, clock.now(), nowIso));
      }
      if (t.desc.softDelete) {
        for (const [id, row] of t.rows) {
          if (keep.has(id) || row[DELETED]) continue;
          results.set(id, applyPatch(t.desc, row, { [DELETED]: nowIso }, clock.now(), nowIso));
        }
      }
      if (results.size) out.push([t, { results, pending: new Map() }]);
    }
    return out;
  }

  async function importData(data, { mode = 'merge' } = {}) {
    assertOpen();
    assertNoBatch('importData');
    if (mode !== 'merge' && mode !== 'replace') throw new Error(`importData: modo desconhecido (${String(mode)}); use 'merge' ou 'replace'.`);
    if (data === null || typeof data !== 'object' || data.app !== APP_ID) {
      throw new Error('importData: o arquivo não é um backup do Demand Manager.');
    }
    if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) {
      throw new Error('importData: backup sem versão de schema válida.');
    }
    if (data.schemaVersion > SCHEMA_VERSION) {
      throw new Error('importData: o backup foi criado por uma versão mais nova do app. Atualize o app antes de importar.');
    }
    if (data.tables === null || typeof data.tables !== 'object' || Array.isArray(data.tables)) {
      throw new Error('importData: backup sem a lista de tabelas.');
    }
    // 1) valida e converte tudo ANTES de mexer em qualquer coisa
    const prepared = [];
    let total = 0;
    for (const t of tables.values()) {
      const list = data.tables[t.name];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list)) throw new Error(`importData: a tabela "${t.name}" do backup não é uma lista.`);
      const rows = list.map((raw) => {
        const row = toCanonical(t, raw, 'importData');
        row.server_seq = null; // a ordem do servidor de onde veio o backup não vale para este banco
        return row;
      });
      total += rows.length;
      prepared.push([t, rows]);
    }

    // 2) aplica na memória
    // Banco que já sincronizou com o servidor: apagar e regravar com os carimbos antigos não
    // restauraria nada (o servidor ficaria com os valores mais novos e as linhas criadas depois do
    // backup voltariam). Ali "substituir" é uma RESTAURAÇÃO: os valores do backup entram como
    // alterações locais novas e o que não está no backup é excluído (exclusão lógica) — o envio
    // seguinte leva o mesmo estado ao servidor e aos outros aparelhos.
    const restore = mode === 'replace' && hasServerRows();
    const replace = mode === 'replace' && !restore;
    const changedTables = new Set();
    if (replace) {
      for (const t of tables.values()) if (t.rows.size) changedTables.add(t.name);
      clearMemory({ withMeta: false });
    }
    const rowOps = [];
    const dirtyPuts = [];
    const message = {};
    let changed = 0;
    const b = newBatch('load'); // só para reaproveitar touchRow/bumpDirty (não há o que desfazer)
    const merged = restore ? restoreResults(prepared) : prepared.map(([t, rows]) => [t, mergeList(t, rows)]);
    for (const [t, { results, pending }] of merged) {
      for (const [id, row] of results) {
        touchRow(b, t, id, row);
        bumpDirty(b, t, id);
      }
      for (const [id, isPending] of pending) if (isPending && !t.dirty.has(id)) bumpDirty(b, t, id);
      if (results.size) {
        changed += results.size;
        changedTables.add(t.name);
        const list = [...results.values()];
        rowOps.push([t.name, list]);
        message[t.name] = list;
      }
    }
    for (const { t, id } of b.dirty.values()) {
      const entry = t.dirty.get(id);
      if (entry) dirtyPuts.push(entry);
    }

    // 3) grava tudo numa única transação e avisa
    let persisted = Promise.resolve();
    if (replace || rowOps.length || dirtyPuts.length) {
      const names = replace ? [...TABLE_NAMES, DIRTY_STORE] : [...rowOps.map(([name]) => name), DIRTY_STORE];
      persisted = enqueue(names, (tx) => {
        if (replace) for (const name of names) tx.objectStore(name).clear();
        for (const [name, list] of rowOps) {
          const os = tx.objectStore(name);
          for (const row of list) os.put(row);
        }
        const os = tx.objectStore(DIRTY_STORE);
        for (const entry of dirtyPuts) os.put(entry);
      }, () => post({ kind: 'rows', replace, tables: message, dirty: dirtyPuts }));
    }
    if (changedTables.size) {
      version++;
      notify(changedTables, 'load');
    }
    await persisted;
    return { total, changed };
  }

  function wipe() {
    assertOpen();
    assertNoBatch('wipe');
    const changedTables = new Set();
    for (const t of tables.values()) if (t.rows.size) changedTables.add(t.name);
    clearMemory({ withMeta: true });
    dirtyOps = [];
    const persisted = enqueueRaw(allStoreNames, (tx) => {
      for (const name of allStoreNames) tx.objectStore(name).clear();
    }, () => post({ kind: 'wipe' }));
    if (changedTables.size) {
      version++;
      notify(changedTables, 'load');
    }
    return persisted;
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      await flush();
    } finally {
      listeners.clear();
      setUnloadGuard(false);
      if (channel) {
        channel.onmessage = null;
        channel.close();
        channel = null;
      }
      db.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Outras abas
  // ---------------------------------------------------------------------------

  /**
   * Adota as pendências de outra aba (só na memória: quem avisou já as gravou no disco). Assim
   * qualquer aba aberta envia o que está pendente, mesmo que a aba que fez a alteração feche antes.
   * Uma pendência desta aba (alteração própria) não é trocada pela de outra; uma pendência só é
   * baixada se ainda é exatamente a que a outra aba baixou (mesmo rev e mesmo dono).
   * @returns {Set<string>} tabelas cujas pendências mudaram
   */
  function applyPeerDirty(put, del) {
    const touched = new Set();
    if (Array.isArray(put)) {
      for (const e of put) {
        const t = e && tables.get(e.table);
        if (!t || e.id == null || typeof e.owner !== 'string') continue;
        const cur = t.dirty.get(e.id);
        const rev = Number(e.rev) || 1;
        if (cur && !(cur.owner === e.owner && cur.rev <= rev)) continue;
        t.dirty.set(e.id, Object.freeze({
          key: dirtyKey(t.name, e.id),
          table: t.name,
          id: e.id,
          rev,
          error: e.error == null ? null : String(e.error),
          owner: e.owner,
        }));
        touched.add(t.name);
      }
    }
    if (Array.isArray(del)) {
      for (const e of del) {
        const t = e && tables.get(e.table);
        if (!t) continue;
        const cur = t.dirty.get(e.id);
        if (cur && cur.rev === e.rev && cur.owner === e.owner) {
          t.dirty.delete(e.id);
          touched.add(t.name);
        }
      }
    }
    return touched;
  }

  function receive(message) {
    if (closed || !message || typeof message !== 'object' || message.from === instanceId) return;
    if (batch) {
      // Não deveria acontecer (mensagens chegam fora de código síncrono), mas nunca mistura lotes.
      queueMicrotask(() => receive(message));
      return;
    }
    try {
      if (message.kind === 'wipe') {
        const changedTables = new Set();
        for (const t of tables.values()) if (t.rows.size) changedTables.add(t.name);
        clearMemory({ withMeta: true });
        dirtyOps = [];
        if (changedTables.size) {
          version++;
          notify(changedTables, 'remote');
        }
        return;
      }
      if (message.kind === 'dirty') {
        const touched = applyPeerDirty(message.put, message.del);
        if (touched.size) notify(touched, 'remote');
        return;
      }
      if (message.kind !== 'rows' || !message.tables || typeof message.tables !== 'object') return;
      const cleared = new Set();
      if (message.replace) {
        for (const t of tables.values()) if (t.rows.size) cleared.add(t.name);
        clearMemory({ withMeta: false });
      }
      const b = newBatch('remote', { postRows: false });
      b.noPersist = new Set();
      for (const [name, rows] of Object.entries(message.tables)) {
        const t = tables.get(name);
        if (!t || !Array.isArray(rows)) continue;
        const idField = t.desc.idField;
        const valid = rows.filter((r) => r && typeof r === 'object' && r[idField] != null);
        // Alteração local de outra aba: empate exato de carimbo é desempatado pelo valor (as duas
        // abas chegam ao mesmo resultado). Linhas que a outra aba recebeu do servidor (`trusted`)
        // mantêm "empate → vence o servidor" e, se confirmam um envio, os carimbos reduzidos valem.
        const fromServer = message.trusted === true;
        const { results, same } = mergeList(t, valid, {
          tieBreak: !fromServer,
          confirm: fromServer && message.confirm === true,
          trusted: fromServer,
        });
        for (const [id, row] of results) touchRow(b, t, id, row);
        // Igual à recebida → a aba que enviou já gravou; diferente → este merge precisa ser gravado.
        for (const row of same) b.noPersist.add(row);
      }
      for (const name of applyPeerDirty(message.dirty, message.cleared)) cleared.add(name);
      commit(b, cleared);
    } catch (e) {
      console.error(`[store ${dbName}] Falha ao aplicar o aviso de outra aba:`, e);
    }
  }

  const store = {
    dbName,
    clock,
    /** Atribua uma função para ser avisado de falhas de gravação no IndexedDB. */
    onPersistError: null,
    get persistError() {
      return persistError;
    },
    busy: () => inFlight > 0,
    get,
    all,
    byIndex,
    insert,
    update,
    put,
    remove,
    restore,
    transact,
    subscribe,
    version: () => version,
    applyRemote,
    dirty,
    pendingCount,
    dirtySnapshot,
    markSynced,
    markError,
    meta,
    flush,
    exportData,
    importData,
    /** Há linhas já confirmadas pelo servidor? (com elas, importar "Substituir tudo" vira restauração) */
    hasServerRows,
    wipe,
    close,
  };

  loading = false;
  for (const message of earlyMessages.splice(0)) receive(message);

  return store;
}
