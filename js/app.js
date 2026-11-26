// Montagem do aplicativo: junta banco local, relógio, seletores, comandos, configurações e preferências.
//
//   const wall = createWallClock();
//   const store = await createStore({ dbName, now: wall.now });
//   const app = createApp({ store, wall, deviceId: deviceId() });
//
//   app.sel.*       consultas memorizadas (js/services/selectors.js)
//   app.cmd.*       ÚNICO caminho de escrita usado pela interface (js/services/commands.js)
//   app.settings    configurações SINCRONIZADAS entre dispositivos (tabela `settings`)
//   app.prefs       preferências SÓ deste dispositivo (localStorage)
//   app.clock       relógio de parede (a única fonte de "agora" dos serviços)
//   app.events      emissor de eventos da aplicação (ex.: 'command' depois de cada comando)
//
// O motor de sincronização (`sync`) e o cliente remoto (`remote`) são INJETADOS por quem inicializa o
// app (js/main.js): este módulo não os importa.

import { createEmitter } from './core/events.js';
import { createWallClock } from './core/wallclock.js';
import { createCommands } from './services/commands.js';
import { createSelectors } from './services/selectors.js';

/** Valores padrão das configurações sincronizadas (usados enquanto a chave não foi gravada). */
export const SETTINGS_DEFAULTS = Object.freeze({
  'owner.default': '',
  'capacity.hoursPerDay': 8,
  'capacity.hoursPerWeek': 40,
  'deadline.soonDays': 3,
  'workflow.autoStartDemand': true,
  statuses: null,
  'suggestions.dismissed': Object.freeze([]),
});

/** Prefixo das chaves de preferência no armazenamento do dispositivo. */
export const PREF_PREFIX = 'dm.pref.';

/** Armazenamento em memória usado quando o localStorage não existe ou está bloqueado. */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/** localStorage do navegador, ou null quando o acesso é negado (modo privado, iframe isolado…). */
function defaultStorage() {
  try {
    const storage = globalThis.localStorage;
    return storage && typeof storage.getItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}

/**
 * Preferências por dispositivo: JSON gravado em `storage` sob 'dm.pref.' + chave.
 * Nunca lança erro: se o armazenamento falhar (cota, bloqueio), o valor fica só na memória desta sessão.
 */
function createPrefs(storage) {
  const primary = storage || null;
  const fallback = memoryStorage();
  /** Chaves cujo valor mais recente está só na memória (a gravação no armazenamento falhou). */
  const volatile = new Set();
  const fullKey = (key) => PREF_PREFIX + String(key);

  function read(key) {
    const k = fullKey(key);
    if (primary && !volatile.has(k)) {
      try {
        return primary.getItem(k);
      } catch {
        /* armazenamento indisponível: cai na memória */
      }
    }
    return fallback.getItem(k);
  }

  return {
    /**
     * Lê uma preferência deste dispositivo.
     * @param {string} key chave (sem o prefixo)
     * @param {*} [fallbackValue] devolvido quando a chave não existe ou o conteúdo está corrompido
     * @returns {*}
     */
    get(key, fallbackValue) {
      const raw = read(key);
      if (raw === null || raw === undefined) return fallbackValue;
      try {
        const value = JSON.parse(raw);
        return value === undefined ? fallbackValue : value;
      } catch {
        return fallbackValue;
      }
    },
    /**
     * Grava uma preferência deste dispositivo (qualquer valor serializável em JSON). `undefined` apaga a chave.
     * @param {string} key
     * @param {*} value
     * @returns {boolean} true quando foi gravada no armazenamento do dispositivo; false quando ficou só na memória
     */
    set(key, value) {
      if (value === undefined) {
        this.remove(key);
        return true;
      }
      const k = fullKey(key);
      let text;
      try {
        text = JSON.stringify(value);
      } catch {
        return false; // valor não serializável (ex.: referência circular): ignora
      }
      if (text === undefined) return false;
      if (primary) {
        try {
          primary.setItem(k, text);
          volatile.delete(k);
          fallback.removeItem(k);
          return true;
        } catch {
          /* cota excedida ou acesso negado: guarda só na memória */
        }
      }
      fallback.setItem(k, text);
      volatile.add(k);
      return false;
    },
    /**
     * Apaga uma preferência deste dispositivo.
     * @param {string} key
     */
    remove(key) {
      const k = fullKey(key);
      volatile.delete(k);
      fallback.removeItem(k);
      if (primary) {
        try {
          primary.removeItem(k);
        } catch {
          /* nada a fazer */
        }
      }
    },
  };
}

/**
 * Cria o objeto `app` usado por toda a interface. Síncrono: o banco local já chega aberto.
 *
 * @param {object} options
 * @param {object} options.store        banco local (createStore) — criado com `now: wall.now`
 * @param {object} [options.wall]       relógio de parede (createWallClock); padrão: um relógio de tempo real
 * @param {object|null} [options.remote] cliente do Supabase (injetado; pode ser null no modo local)
 * @param {object|null} [options.sync]  motor de sincronização (injetado; pode ser null)
 * @param {string} [options.deviceId='dispositivo'] identificador deste dispositivo (vai no histórico)
 * @param {{getItem: Function, setItem: Function, removeItem: Function}} [options.prefsStorage]
 *        armazenamento das preferências (padrão: localStorage; sem ele, memória)
 * @returns {{ store: object, remote: object|null, sync: object|null, wall: object, clock: object, deviceId: string,
 *             events: object, sel: object, cmd: object,
 *             settings: { get(key: string, fallback?: any): any, set(key: string, value: any): object, all(): object },
 *             prefs: { get(key: string, fallback?: any): any, set(key: string, value: any): boolean, remove(key: string): void } }}
 */
export function createApp({ store, wall, remote = null, sync = null, deviceId = 'dispositivo', prefsStorage } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.transact !== 'function') {
    throw new TypeError('createApp: informe o banco local (store).');
  }
  const clock = wall || createWallClock();

  const app = {
    store,
    remote,
    sync,
    wall: clock,
    clock,
    deviceId: typeof deviceId === 'string' && deviceId ? deviceId : 'dispositivo',
    events: createEmitter(),
    sel: null,
    cmd: null,
    settings: null,
    prefs: createPrefs(prefsStorage === undefined ? defaultStorage() : prefsStorage),
  };

  let allVersion = -1;
  let allCache = null;

  app.settings = {
    /**
     * Valor de uma configuração sincronizada.
     * Ordem: valor gravado (diferente de null) → `fallback` informado → SETTINGS_DEFAULTS → undefined.
     * O valor devolvido é imutável (não altere listas/objetos: grave um novo com `set`).
     * @param {string} key
     * @param {*} [fallback]
     * @returns {*}
     */
    get(key, fallback) {
      const row = store.get('settings', key);
      if (row && row.value !== null && row.value !== undefined) return row.value;
      if (fallback !== undefined) return fallback;
      return Object.prototype.hasOwnProperty.call(SETTINGS_DEFAULTS, key) ? SETTINGS_DEFAULTS[key] : undefined;
    },
    /**
     * Grava uma configuração sincronizada (passa pela validação de `app.cmd.setSetting`).
     * @param {string} key
     * @param {*} value qualquer valor JSON; null volta ao padrão
     * @returns {object} linha da tabela `settings`
     */
    set(key, value) {
      return app.cmd.setSetting(key, value);
    },
    /**
     * Todas as configurações: os padrões sobrepostos pelos valores gravados.
     * @returns {object} objeto congelado `chave → valor` (o mesmo objeto até o banco mudar)
     */
    all() {
      const version = store.version();
      if (allCache && allVersion === version) return allCache;
      const out = { ...SETTINGS_DEFAULTS };
      for (const row of store.all('settings')) {
        if (row && row.value !== null && row.value !== undefined) out[row.key] = row.value;
      }
      allVersion = version;
      allCache = Object.freeze(out);
      return allCache;
    },
  };

  app.sel = createSelectors(app);
  app.cmd = createCommands(app);
  return app;
}
