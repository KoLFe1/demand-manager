// Wrapper mínimo de IndexedDB baseado em Promises. Sem dependências.
//
// Só infraestrutura: nada aqui conhece tabelas do app. Quem usa é js/data/store.js.
//
//   const db = await openDb('dm-local', 1, (db, oldVersion, tx) => { db.createObjectStore('tasks', { keyPath: 'id' }); });
//   const tx = db.transaction(['tasks'], 'readwrite');
//   put(tx, 'tasks', { id: 'a', name: 'x' });
//   await txDone(tx);
//
// Regras:
//   • a conexão devolvida por openDb se fecha sozinha quando outra aba pede uma versão nova
//     (ou apaga o banco) — evento `versionchange` —, para nunca travar a atualização dos outros;
//   • bloqueio (`blocked`) e erro (`error`) viram rejeições com mensagem clara em pt-BR
//     (o erro original fica em `error.cause`). O bloqueio só vira rejeição se durar mais que
//     `blockedTimeoutMs`: é normal ele aparecer por alguns milissegundos enquanto a outra aba
//     termina a transação em curso antes de fechar a conexão.

/** Tempo padrão (ms) que uma abertura/exclusão espera bloqueada por outra conexão antes de desistir. */
export const BLOCKED_TIMEOUT_MS = 3000;

/** Erro com mensagem em pt-BR que preserva o erro original do navegador em `cause` e o nome em `name`. */
function idbError(message, cause) {
  const detail = cause && cause.message ? ` (${cause.name || 'Erro'}: ${cause.message})` : '';
  const err = new Error(`${message}${detail}`);
  if (cause) {
    err.cause = cause;
    if (cause.name) err.name = cause.name;
  }
  return err;
}

function factory() {
  const f = globalThis.indexedDB;
  if (!f) throw new Error('IndexedDB não está disponível neste navegador/contexto.');
  return f;
}

/**
 * Transforma um IDBRequest numa Promise.
 * @param {IDBRequest} request pedido já criado (get, put, getAll, delete…)
 * @returns {Promise<any>} resolve com `request.result`; rejeita com `request.error`.
 *   Atenção: a rejeição NÃO cancela o comportamento padrão do IndexedDB — um pedido com erro
 *   aborta a transação inteira (é o que queremos: tudo ou nada).
 */
export function reqP(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Pedido ao IndexedDB falhou.'));
  });
}

/**
 * Promise que acompanha o fim de uma transação.
 * @param {IDBTransaction} tx
 * @returns {Promise<void>} resolve em `complete`; rejeita em `abort`/`error` com o erro da transação
 *   (ou um AbortError quando ela foi abortada sem erro associado).
 */
export function txDone(tx) {
  return new Promise((resolve, reject) => {
    // Num pedido com erro, o evento `error` sobe até a transação ANTES de `tx.error` ser preenchido:
    // por isso o erro do próprio pedido (ev.target.error) também é consultado.
    const fail = (ev) => {
      const cause = tx.error || (ev && ev.target && ev.target.error) || null;
      reject(cause || new DOMException('A transação do IndexedDB foi abortada.', 'AbortError'));
    };
    tx.addEventListener('complete', () => resolve());
    tx.addEventListener('abort', fail);
    tx.addEventListener('error', fail);
  });
}

/**
 * Abre (criando/atualizando se preciso) um banco IndexedDB.
 *
 * @param {string} name     nome do banco
 * @param {number} version  versão desejada (inteiro >= 1)
 * @param {(db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void} [upgrade]
 *        chamado dentro da transação de atualização quando o banco é novo (oldVersion = 0) ou está
 *        numa versão anterior; deve criar object stores/índices de forma SÍNCRONA. Se lançar erro,
 *        a atualização é desfeita e a Promise rejeita com esse erro.
 * @param {{ blockedTimeoutMs?: number }} [options]
 *        `blockedTimeoutMs` (padrão BLOCKED_TIMEOUT_MS): quanto tempo esperar quando a atualização
 *        está bloqueada por outra conexão antes de rejeitar.
 * @returns {Promise<IDBDatabase>} conexão aberta. Ela se fecha sozinha no evento `versionchange`
 *        (outra aba atualizando ou apagando o banco); use `db.addEventListener('versionchange', …)`
 *        se precisar ser avisado.
 *
 * Rejeita com mensagem clara quando:
 *   • a atualização continua bloqueada por outra conexão que não se fechou (`blocked`) depois de
 *     `blockedTimeoutMs` — nesse caso, se o bloqueio acabar mais tarde, a atualização tardia é
 *     cancelada (o banco continua na versão antiga);
 *   • o banco está numa versão MAIS NOVA que a pedida (VersionError) ou qualquer outro erro de abertura.
 */
export function openDb(name, version, upgrade, { blockedTimeoutMs = BLOCKED_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof name !== 'string' || !name) {
      reject(new TypeError('openDb: informe o nome do banco.'));
      return;
    }
    if (!Number.isInteger(version) || version < 1) {
      reject(new TypeError(`openDb: versão inválida (${version}); use um inteiro >= 1.`));
      return;
    }
    let settled = false;
    let upgradeError = null;
    let blockedTimer = null;
    const clearBlocked = () => {
      if (blockedTimer !== null) clearTimeout(blockedTimer);
      blockedTimer = null;
    };
    const fail = (err) => {
      clearBlocked();
      if (settled) return;
      settled = true;
      reject(err);
    };

    let request;
    try {
      request = factory().open(name, version);
    } catch (e) {
      fail(idbError(`Não foi possível abrir o banco local "${name}".`, e));
      return;
    }

    request.onupgradeneeded = (ev) => {
      const tx = request.transaction;
      clearBlocked(); // o bloqueio acabou a tempo: segue normalmente
      if (settled) {
        // O bloqueio já foi informado a quem chamou: não atualiza "pelas costas".
        try { tx.abort(); } catch { /* transação já encerrada */ }
        return;
      }
      if (typeof upgrade !== 'function') return;
      try {
        upgrade(request.result, ev.oldVersion, tx);
      } catch (e) {
        upgradeError = e;
        try { tx.abort(); } catch { /* transação já encerrada */ }
      }
    };

    request.onblocked = () => {
      if (settled || blockedTimer !== null) return;
      blockedTimer = setTimeout(() => {
        blockedTimer = null;
        fail(new Error(
          `Não foi possível atualizar o banco local "${name}" para a versão ${version}: ` +
          'ele está aberto em outra aba ou janela que não se fechou. Feche as outras abas do app e recarregue a página.',
        ));
      }, Math.max(0, Number(blockedTimeoutMs) || 0));
    };

    request.onerror = (ev) => {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (upgradeError) {
        fail(upgradeError);
        return;
      }
      const cause = request.error;
      if (cause && cause.name === 'VersionError') {
        fail(idbError(
          `O banco local "${name}" foi criado por uma versão mais nova do app (versão pedida: ${version}). Recarregue a página para atualizar.`,
          cause,
        ));
        return;
      }
      fail(idbError(`Não foi possível abrir o banco local "${name}".`, cause));
    };

    request.onsuccess = () => {
      const db = request.result;
      clearBlocked();
      if (settled) {
        db.close(); // sucesso tardio depois de uma rejeição: não deixa conexão perdida aberta
        return;
      }
      db.addEventListener('versionchange', () => db.close());
      settled = true;
      resolve(db);
    };
  });
}

/**
 * Lê todos os registros de um object store.
 * @param {IDBDatabase | IDBTransaction} source conexão (abre uma transação só de leitura) ou uma
 *        transação já aberta que inclua o store (útil para ler vários stores no mesmo instantâneo)
 * @param {string} storeName
 * @param {IDBKeyRange | IDBValidKey | null} [query]  filtro opcional de chave
 * @param {number} [count]  limite opcional de registros
 * @returns {Promise<any[]>} registros em ordem de chave
 */
export function getAll(source, storeName, query = null, count = undefined) {
  try {
    const tx = typeof source.objectStore === 'function' ? source : source.transaction(storeName, 'readonly');
    const os = tx.objectStore(storeName);
    return reqP(count === undefined ? os.getAll(query) : os.getAll(query, count));
  } catch (e) {
    return Promise.reject(e);
  }
}

/**
 * Grava (insere ou substitui) um registro dentro de uma transação de escrita.
 * @param {IDBTransaction} tx  transação 'readwrite' que inclua o store
 * @param {string} storeName
 * @param {any} value  registro (a chave vem do keyPath do store)
 * @returns {IDBRequest} pedido criado; falhas aparecem em `txDone(tx)` (a transação aborta)
 */
export function put(tx, storeName, value) {
  return tx.objectStore(storeName).put(value);
}

/**
 * Grava vários registros no mesmo store, na ordem dada, dentro de uma transação de escrita.
 * @param {IDBTransaction} tx
 * @param {string} storeName
 * @param {Iterable<any>} values
 * @returns {number} quantidade de pedidos de gravação criados
 */
export function bulkPut(tx, storeName, values) {
  const os = tx.objectStore(storeName);
  let n = 0;
  for (const value of values) {
    os.put(value);
    n++;
  }
  return n;
}

/**
 * Apaga um registro (ou uma faixa de chaves) dentro de uma transação de escrita.
 * @param {IDBTransaction} tx
 * @param {string} storeName
 * @param {IDBValidKey | IDBKeyRange} key
 * @returns {IDBRequest}
 */
export function del(tx, storeName, key) {
  return tx.objectStore(storeName).delete(key);
}

/**
 * Esvazia um object store dentro de uma transação de escrita.
 * @param {IDBTransaction} tx
 * @param {string} storeName
 * @returns {IDBRequest}
 */
export function clear(tx, storeName) {
  return tx.objectStore(storeName).clear();
}

/**
 * Apaga um banco inteiro. Conexões abertas por `openDb` se fecham sozinhas (evento `versionchange`).
 * @param {string} name
 * @param {{ blockedTimeoutMs?: number }} [options] quanto esperar por conexões que ainda não fecharam
 * @returns {Promise<void>} resolve quando o banco foi apagado (ou não existia). Rejeita com mensagem
 *   clara em caso de erro ou se outra conexão continuar aberta depois de `blockedTimeoutMs` — nesse
 *   último caso o navegador ainda conclui a exclusão quando a conexão for fechada.
 */
export function deleteDb(name, { blockedTimeoutMs = BLOCKED_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof name !== 'string' || !name) {
      reject(new TypeError('deleteDb: informe o nome do banco.'));
      return;
    }
    let request;
    try {
      request = factory().deleteDatabase(name);
    } catch (e) {
      reject(idbError(`Não foi possível apagar o banco local "${name}".`, e));
      return;
    }
    let blockedTimer = null;
    const clearBlocked = () => {
      if (blockedTimer !== null) clearTimeout(blockedTimer);
      blockedTimer = null;
    };
    request.onsuccess = () => {
      clearBlocked();
      resolve();
    };
    request.onerror = () => {
      clearBlocked();
      reject(idbError(`Não foi possível apagar o banco local "${name}".`, request.error));
    };
    request.onblocked = () => {
      if (blockedTimer !== null) return;
      blockedTimer = setTimeout(() => {
        blockedTimer = null;
        reject(new Error(
          `Não foi possível apagar o banco local "${name}" agora: ele está aberto em outra aba ou janela que não se fechou.`,
        ));
      }, Math.max(0, Number(blockedTimeoutMs) || 0));
    };
  });
}
