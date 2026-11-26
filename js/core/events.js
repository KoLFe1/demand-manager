// Emissor de eventos mínimo (publicar/assinar). Sem dependências.
//
//   const bus = createEmitter();
//   const off = bus.on('saved', (payload) => { … });
//   bus.emit('saved', { id });
//   off();

/**
 * Cria um emissor de eventos.
 *
 * Regras:
 *   - `on(type, fn)` assina e devolve uma função que cancela a assinatura (pode ser chamada mais de uma vez);
 *   - `once(type, fn)` assina para uma única emissão; também devolve a função de cancelamento;
 *   - `off(type, fn)` cancela (aceita a função original passada a `on` ou a `once`); sem `fn`, remove todos
 *     os ouvintes daquele tipo;
 *   - `emit(type, payload)` chama os ouvintes na ordem de assinatura e devolve quantos foram chamados.
 *     A emissão usa uma cópia da lista: quem assina durante a emissão só recebe a próxima; quem é cancelado
 *     durante a emissão não é mais chamado. Uma exceção num ouvinte é registrada com console.error e
 *     NÃO impede os demais de rodarem;
 *   - a mesma função assinada duas vezes no mesmo tipo conta uma vez só;
 *   - `clear()` remove tudo; `count(type)` informa quantos ouvintes há (de um tipo ou no total).
 *
 * @returns {{
 *   on: (type: string, fn: (payload: any) => void) => (() => void),
 *   once: (type: string, fn: (payload: any) => void) => (() => void),
 *   off: (type: string, fn?: Function) => void,
 *   emit: (type: string, payload?: any) => number,
 *   clear: () => void,
 *   count: (type?: string) => number,
 * }}
 */
export function createEmitter() {
  /** @type {Map<string, Array<{ fn: Function, once: boolean, active: boolean }>>} */
  const listeners = new Map();

  function add(type, fn, once) {
    if (typeof fn !== 'function') throw new TypeError('createEmitter: o ouvinte precisa ser uma função');
    let list = listeners.get(type);
    if (list === undefined) {
      list = [];
      listeners.set(type, list);
    }
    let entry = list.find((item) => item.fn === fn);
    if (entry === undefined) {
      entry = { fn, once, active: true };
      list.push(entry);
    }
    const mine = entry;
    return () => removeEntry(type, mine);
  }

  function removeEntry(type, entry) {
    if (!entry.active) return;
    entry.active = false;
    const list = listeners.get(type);
    if (list === undefined) return;
    const index = list.indexOf(entry);
    if (index >= 0) list.splice(index, 1);
    if (list.length === 0) listeners.delete(type);
  }

  function on(type, fn) {
    return add(type, fn, false);
  }

  function once(type, fn) {
    return add(type, fn, true);
  }

  function off(type, fn) {
    const list = listeners.get(type);
    if (list === undefined) return;
    if (fn === undefined) {
      for (const entry of list) entry.active = false;
      listeners.delete(type);
      return;
    }
    const entry = list.find((item) => item.fn === fn);
    if (entry !== undefined) removeEntry(type, entry);
  }

  function emit(type, payload) {
    const list = listeners.get(type);
    if (list === undefined) return 0;
    let called = 0;
    for (const entry of list.slice()) {
      if (!entry.active) continue; // cancelado por um ouvinte anterior nesta mesma emissão
      if (entry.once) removeEntry(type, entry);
      called++;
      try {
        entry.fn(payload);
      } catch (err) {
        console.error(`[events] erro num ouvinte de "${String(type)}"`, err);
      }
    }
    return called;
  }

  function clear() {
    for (const list of listeners.values()) {
      for (const entry of list) entry.active = false;
    }
    listeners.clear();
  }

  function count(type) {
    if (type !== undefined) {
      const list = listeners.get(type);
      return list === undefined ? 0 : list.length;
    }
    let total = 0;
    for (const list of listeners.values()) total += list.length;
    return total;
  }

  return { on, once, off, emit, clear, count };
}
