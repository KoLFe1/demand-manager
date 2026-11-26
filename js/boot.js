// Inicialização do Demand Manager: armazenamento do dispositivo, configuração do Supabase, banco local,
// sincronização, dados de demonstração e a casca da interface.
//
//   const app = await boot({ root: document.getElementById('app') });
//
// Parâmetros de URL (desenvolvimento e testes):
//   ?db=NOME     banco IndexedDB isolado 'dm-NOME' e chaves do localStorage com o prefixo 'NOME:' — vários
//                "dispositivos" independentes podem coexistir no mesmo navegador;
//   ?demo=1      banco 'dm-demo' preenchido com dados de exemplo (nunca sincroniza);
//   ?emulator=1  usa o emulador do Supabase exposto pela página pai em window.__DM_EMULATOR__ (testes);
//   ?accounts=1  (só junto com ?db=NOME) o espaço isolado segue as regras de produção para contas: banco
//                'dm-NOME' sem conta e 'dm-NOME.<usuário>' com sessão, com a oferta de trazer os dados locais
//                no primeiro login. Sem este parâmetro nada muda.
//
// Se algo falhar no caminho, a página mostra uma tela de erro legível (o que falhou + "Recarregar") em vez
// de ficar em branco.

import { createApp } from './app.js';
import { uuid } from './core/ids.js';
import { createWallClock } from './core/wallclock.js';
import { createSupabaseRemote } from './data/remote-supabase.js';
import { DB_PREFIX, TABLES, tableDesc } from './data/schema.js';
import { createStore } from './data/store.js';
import { createSyncEngine } from './data/sync.js';
import { startShell } from './ui/shell.js';
import { openNewPasswordDialog } from './ui/auth.js';
import { confirmDialog, toast } from './ui/kit/overlays.js';
import { loadViews } from './ui/views/index.js';

/**
 * Versão do aplicativo (mostrada em Configurações → Sobre). Deve ser IGUAL a CACHE_VERSION em sw.js
 * (um teste confere): mude as duas a cada publicação.
 */
export const APP_VERSION = 'v001';

/**
 * Endereços (sem query nem hash) dos recursos desta origem que a página carregou — a lista enviada ao service
 * worker. Tirar a query evita que textos passados por parâmetro (ex.: compartilhamento) vão para o cache.
 * @param {string} origin location.origin
 * @param {string} href location.href
 * @param {Array<{name?: string}>} entries performance.getEntriesByType('resource')
 * @returns {string[]}
 */
export function appResourceUrls(origin, href, entries = []) {
  const clean = (url) => String(url).split('#')[0].split('?')[0];
  const urls = new Set([clean(href)]);
  for (const entry of entries || []) {
    if (entry && typeof entry.name === 'string' && entry.name.startsWith(origin)) urls.add(clean(entry.name));
  }
  return [...urls];
}

// ---------------------------------------------------------------------------
// Captura rápida: "Compartilhar → Demand Manager" (share_target do manifest), Atalho do iPhone e favorito
// (bookmarklet) abrem o app com ?title=&text=&url= (ou ?capture=1&text=…). O boot lê esses parâmetros, tira-os
// JÁ da barra de endereço (recarregar não abre de novo; o texto não fica no histórico) e abre a criação rápida
// preenchida — nada é criado sem o usuário confirmar.
// ---------------------------------------------------------------------------

/** Parâmetros da captura (os demais, como db/demo, ficam na URL). */
export const CAPTURE_PARAMS = Object.freeze(['title', 'text', 'url', 'capture']);

/** Tamanho máximo do nome sugerido pela captura. */
export const CAPTURE_NAME_MAX = 120;

/**
 * Lê os parâmetros de captura da query.
 * @param {string|URLSearchParams} search location.search
 * @returns {{ title: string, text: string, url: string }|null} null quando não é uma captura
 */
export function readCaptureParams(search) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(typeof search === 'string' ? search : '');
  const get = (key) => (params.get(key) || '').replace(/\r\n?/g, '\n').trim();
  const value = { title: get('title'), text: get('text'), url: get('url') };
  if (params.get('capture') === '1' || value.title || value.text || value.url) return value;
  return null;
}

/**
 * Query sem os parâmetros de captura (mantém a ordem dos outros).
 * @param {string} search location.search
 * @returns {string} '' ou '?db=x…'
 */
export function stripCaptureParams(search) {
  const params = new URLSearchParams(typeof search === 'string' ? search : '');
  for (const key of CAPTURE_PARAMS) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/**
 * Valores iniciais da criação rápida a partir da captura: nome = título ou 1ª linha do texto (até 120 caracteres);
 * descrição = o resto do texto + o endereço numa linha própria (sem repetir um endereço que já está no texto).
 * @param {{ title?: string, text?: string, url?: string }} capture
 * @returns {{ name: string, description: string }}
 */
export function capturePrefill(capture) {
  const c = capture && typeof capture === 'object' ? capture : {};
  const clean = (v) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : '');
  const title = clean(c.title).replace(/\s+/g, ' ');
  const text = clean(c.text);
  const url = clean(c.url);
  let name = title;
  let rest = text;
  if (!name && text) {
    const lines = text.split('\n');
    name = lines[0].trim();
    rest = lines.slice(1).join('\n').trim();
  }
  if (!name && url) name = url;
  if (name.length > CAPTURE_NAME_MAX) {
    // o nome é cortado, mas nada se perde: a linha inteira abre a descrição
    rest = [name, rest].filter(Boolean).join('\n');
    name = `${name.slice(0, CAPTURE_NAME_MAX - 1).trimEnd()}…`;
  }
  const parts = [];
  if (rest) parts.push(rest);
  if (url && !rest.includes(url)) parts.push(url);
  return { name, description: parts.join('\n') };
}

/**
 * Endereço para o Atalho do iPhone ("Abrir URL"): termina em `text=`, onde o atalho acrescenta a Entrada.
 * @param {string} origin location.origin
 * @param {string} pathname location.pathname
 */
export function captureUrl(origin, pathname) {
  return `${origin}${pathname}?capture=1&text=`;
}

/**
 * Código do favorito (bookmarklet) que abre o app com o título da página, o texto selecionado e o endereço.
 * @param {string} appUrl endereço do app (origin + pathname)
 * @returns {string} 'javascript:…'
 */
export function bookmarkletCode(appUrl) {
  const base = JSON.stringify(String(appUrl));
  return (
    'javascript:(function(){var e=encodeURIComponent,s=String(window.getSelection?getSelection():"").trim().slice(0,3000);' +
    `window.open(${base}+"?capture=1&title="+e(document.title.slice(0,300))+"&text="+e(s)+"&url="+e(location.href),"_blank");})();`
  );
}

/** Tira os parâmetros de captura da barra de endereço (e do histórico), mantendo os outros e o fragmento. */
function clearCaptureParams(win) {
  try {
    const { pathname, search, hash } = win.location;
    win.history.replaceState(win.history.state, '', `${pathname}${stripCaptureParams(search)}${hash}`);
  } catch {
    /* sem histórico: segue */
  }
}

/** Chave (no armazenamento do dispositivo) da configuração do Supabase gravada pela tela de Configurações. */
export const CONFIG_KEY = 'dm.config';

/** Chave do identificador deste dispositivo. */
export const DEVICE_KEY = 'dm.device';

/** Banco local usado sem conta (modo local). */
export const LOCAL_DB = `${DB_PREFIX}local`;

/** Banco de demonstração. */
export const DEMO_DB = `${DB_PREFIX}demo`;

/** Chave de `store.meta` que registra a decisão sobre importar os dados locais no primeiro login. */
export const ADOPTED_META_KEY = 'adopted';

/**
 * Chave (no armazenamento do dispositivo) da última conta que abriu o app: { id, email }. Gravada a cada início com
 * sessão e apagada por "Sair". Se a sessão some sem "Sair" (renovação recusada pelo servidor), o próximo início
 * continua abrindo o banco dessa conta — dados e pendências à vista, pedindo para entrar de novo.
 */
export const LAST_ACCOUNT_KEY = 'dm.lastAccount';

/**
 * Última conta registrada neste dispositivo.
 * @param {{ getItem: Function }} storage
 * @returns {{ id: string, email: string|null }|null}
 */
export function readLastAccount(storage) {
  try {
    const raw = storage.getItem(LAST_ACCOUNT_KEY);
    const value = raw ? JSON.parse(raw) : null;
    const id = value && typeof value.id === 'string' ? value.id.trim() : '';
    return id ? { id, email: typeof value.email === 'string' && value.email ? value.email : null } : null;
  } catch {
    return null;
  }
}

function rememberAccount(storage, session) {
  const id = session && session.user && typeof session.user.id === 'string' ? session.user.id.trim() : '';
  if (!id) return;
  try {
    storage.setItem(LAST_ACCOUNT_KEY, JSON.stringify({ id, email: session.user.email || null }));
  } catch {
    /* sem armazenamento */
  }
}

// ---------------------------------------------------------------------------
// Armazenamento do dispositivo (localStorage com prefixo opcional)
// ---------------------------------------------------------------------------

/** localStorage da janela, ou null quando o acesso é negado (modo privado, iframe isolado…). */
function safeLocalStorage(win) {
  try {
    const storage = win && win.localStorage;
    return storage && typeof storage.getItem === 'function' ? storage : null;
  } catch {
    return null;
  }
}

/**
 * Normaliza o nome de um espaço isolado (?db=NOME): só letras, dígitos, '-', '_' e '.'; até 80 caracteres.
 * @param {string|null|undefined} value
 * @returns {string} '' quando não há espaço isolado
 */
export function cleanNamespace(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);
}

/**
 * Armazenamento chave/valor do dispositivo com prefixo de espaço isolado. Com `namespace` = 'abc', a chave
 * 'dm.config' é gravada como 'abc:dm.config'; sem espaço, as chaves ficam como estão. Nunca lança erro: se o
 * localStorage falhar (cota, bloqueio), os valores ficam só na memória desta sessão.
 *
 * @param {string} [namespace] nome do espaço isolado ('' = nenhum)
 * @param {Storage|null} [backing] armazenamento real (padrão: o localStorage desta janela)
 * @returns {{ namespace: string, prefix: string, getItem(key: string): string|null, setItem(key: string, value: string): void,
 *             removeItem(key: string): void, keys(): string[], clear(): void }}
 */
export function createNamespacedStorage(namespace = '', backing = safeLocalStorage(globalThis)) {
  const ns = cleanNamespace(namespace);
  const prefix = ns ? `${ns}:` : '';
  const memory = new Map();
  const full = (key) => prefix + String(key);

  return {
    namespace: ns,
    prefix,
    getItem(key) {
      const k = full(key);
      if (memory.has(k)) return memory.get(k);
      if (!backing) return null;
      try {
        return backing.getItem(k);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      const k = full(key);
      const text = String(value);
      if (backing) {
        try {
          backing.setItem(k, text);
          memory.delete(k);
          return;
        } catch {
          /* cota excedida ou acesso negado: guarda só na memória */
        }
      }
      memory.set(k, text);
    },
    removeItem(key) {
      const k = full(key);
      memory.delete(k);
      if (!backing) return;
      try {
        backing.removeItem(k);
      } catch {
        /* nada a fazer */
      }
    },
    /** Chaves (sem o prefixo) que pertencem a este espaço. Sem espaço isolado, só as chaves 'dm.*'. */
    keys() {
      const out = new Set();
      for (const k of memory.keys()) if (k.startsWith(prefix)) out.add(k.slice(prefix.length));
      if (backing) {
        try {
          for (let i = 0; i < backing.length; i++) {
            const k = backing.key(i);
            if (typeof k !== 'string' || !k.startsWith(prefix)) continue;
            const rest = k.slice(prefix.length);
            if (prefix || rest.startsWith('dm.')) out.add(rest);
          }
        } catch {
          /* armazenamento inacessível */
        }
      }
      return [...out];
    },
    /** Apaga todas as chaves deste espaço (ver keys()). */
    clear() {
      for (const key of this.keys()) this.removeItem(key);
    },
  };
}

/**
 * Identificador estável deste dispositivo (gerado na primeira vez e guardado no armazenamento).
 * @param {{ getItem: Function, setItem: Function }} storage
 * @returns {string}
 */
export function readDeviceId(storage) {
  let id = null;
  try {
    id = storage.getItem(DEVICE_KEY);
  } catch {
    id = null;
  }
  if (typeof id === 'string' && id.trim()) return id;
  id = uuid();
  try {
    storage.setItem(DEVICE_KEY, id);
  } catch {
    /* sem armazenamento: o id vale só nesta sessão */
  }
  return id;
}

// ---------------------------------------------------------------------------
// Configuração do Supabase
// ---------------------------------------------------------------------------

function validConfig(value) {
  if (!value || typeof value !== 'object') return null;
  const supabaseUrl = typeof value.supabaseUrl === 'string' ? value.supabaseUrl.trim() : '';
  const supabaseKey = typeof value.supabaseKey === 'string' ? value.supabaseKey.trim() : '';
  return supabaseUrl && supabaseKey ? { supabaseUrl, supabaseKey } : null;
}

/**
 * Configuração do Supabase em vigor: a gravada pela tela de Configurações (armazenamento do dispositivo,
 * chave 'dm.config') tem prioridade sobre a de config.js (window.DM_CONFIG).
 * @param {{ getItem: Function }} storage armazenamento do dispositivo (com o prefixo do espaço isolado)
 * @param {Window|object} [win] janela que pode trazer DM_CONFIG
 * @returns {{ supabaseUrl: string, supabaseKey: string, source: 'local'|'file' }|null}
 */
export function readConfig(storage, win = globalThis) {
  try {
    const raw = storage.getItem(CONFIG_KEY);
    const saved = validConfig(raw ? JSON.parse(raw) : null);
    if (saved) return { ...saved, source: 'local' };
  } catch {
    /* configuração corrompida: ignora */
  }
  let fromFile = null;
  try {
    fromFile = validConfig(win && win.DM_CONFIG);
  } catch {
    fromFile = null;
  }
  return fromFile ? { ...fromFile, source: 'file' } : null;
}

/**
 * Grava (ou apaga, com null) a configuração do Supabase deste dispositivo.
 * @param {{ setItem: Function, removeItem: Function }} storage
 * @param {{ supabaseUrl: string, supabaseKey: string }|null} config
 * @returns {boolean} true quando gravou; false quando a configuração é inválida (nada muda)
 */
export function saveConfig(storage, config) {
  if (config === null) {
    storage.removeItem(CONFIG_KEY);
    return true;
  }
  const clean = validConfig(config);
  if (!clean) return false;
  storage.setItem(CONFIG_KEY, JSON.stringify(clean));
  return true;
}

/** Emulador do Supabase oferecido pela página pai (só com ?emulator=1; usado pelos testes). */
function emulatorHook(params, win) {
  if (params.get('emulator') !== '1') return null;
  try {
    const parent = win.parent;
    if (!parent || parent === win) return null;
    const emu = parent.__DM_EMULATOR__;
    if (emu && typeof emu.url === 'string' && typeof emu.key === 'string' && typeof emu.fetch === 'function') return emu;
  } catch {
    /* página pai de outra origem */
  }
  return null;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'sem-url';
  }
}

/** Sessão do Supabase guardada no armazenamento do espaço isolado (mesma chave do padrão do cliente). */
function storageSessionStore(storage, url) {
  const key = `dm.session.${hostOf(url)}`;
  return {
    get() {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    },
    set(session) {
      if (session) storage.setItem(key, JSON.stringify(session));
      else storage.removeItem(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Volta de um link do Supabase (recuperação de senha, confirmação de e-mail)
// ---------------------------------------------------------------------------

/** Lê as declarações (payload) de um JWT sem validar a assinatura — quem valida é o servidor. */
function jwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const value = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Interpreta o fragmento (#...) com que o Supabase devolve o usuário ao app depois de um link de e-mail:
 *   '#access_token=…&refresh_token=…&expires_in=3600&token_type=bearer&type=recovery'
 *   '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'
 * Rotas do app ('#/kanban?panel=…') não são resultado de link: devolve null.
 *
 * @param {string} hash location.hash
 * @param {{ now?: () => number }} [options] relógio em ms (validade da sessão)
 * @returns {{ type: string|null, session: object|null, error: { code: string|null, description: string|null }|null }|null}
 */
export function parseAuthRedirect(hash, { now = Date.now } = {}) {
  if (typeof hash !== 'string') return null;
  const raw = hash.replace(/^#/, '');
  if (!raw || raw.startsWith('/')) return null;
  const params = new URLSearchParams(raw);
  const accessToken = params.get('access_token');
  const errorName = params.get('error') || params.get('error_code');
  if (!accessToken && !errorName) return null;
  const type = params.get('type') || null;
  if (!accessToken) {
    return { type, session: null, error: { code: params.get('error_code') || params.get('error') || null, description: params.get('error_description') || null } };
  }
  const claims = jwtPayload(accessToken);
  const userId = claims && typeof claims.sub === 'string' ? claims.sub : '';
  if (!userId) return { type, session: null, error: { code: 'invalid_token', description: null } };
  const nowS = Math.floor(now() / 1000);
  const expiresIn = Number(params.get('expires_in'));
  const expiresAtParam = Number(params.get('expires_at'));
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? nowS + Math.floor(expiresIn)
    : Number.isFinite(expiresAtParam) && expiresAtParam > 0
      ? expiresAtParam
      : Number.isFinite(Number(claims.exp)) ? Number(claims.exp) : nowS + 3600;
  return {
    type,
    session: {
      access_token: accessToken,
      refresh_token: params.get('refresh_token') || null,
      expires_at: expiresAt,
      user: { id: userId, email: typeof claims.email === 'string' ? claims.email : null },
    },
    error: null,
  };
}

/** Tira os tokens da barra de endereço (e do histórico): a página fica na rota padrão. */
function clearAuthHash(win) {
  try {
    const { pathname, search } = win.location;
    win.history.replaceState(win.history.state, '', `${pathname}${search}`);
  } catch {
    try {
      win.location.hash = '';
    } catch {
      /* janela inacessível */
    }
  }
}

/** Mensagem legível de um link que falhou (expirado, já usado, inválido). */
export function authRedirectErrorText(error) {
  const code = error && error.code ? String(error.code) : '';
  const description = error && error.description ? String(error.description) : '';
  if (/otp_expired|expired/i.test(code) || /expired|invalid/i.test(description)) {
    return 'O link do e-mail expirou ou já foi usado. Peça um novo em Conta → “Esqueci minha senha”.';
  }
  return `Não foi possível usar o link do e-mail${description ? ` (${description.slice(0, 160)})` : ''}. Peça um novo em Conta → “Esqueci minha senha”.`;
}

/** Sessão só em memória (clientes temporários, ex.: "Testar conexão"). */
function memorySessionStore() {
  let value = null;
  return {
    get: () => value,
    set(session) {
      value = session || null;
    },
  };
}

/**
 * Nome do banco local a abrir.
 *   ?db=NOME → 'dm-NOME'; senão ?demo=1 → 'dm-demo'; senão sessão ativa → 'dm-' + id do usuário; senão 'dm-local'.
 *   ?db=NOME&accounts=1 (testes) → o espaço isolado se comporta como um navegador separado com as regras de produção:
 *   'dm-NOME' sem conta (o "modo local" do espaço) e 'dm-NOME.<id do usuário>' com sessão.
 * @param {{ namespace?: string, demo?: boolean, session?: { user?: { id?: string } }|null, accounts?: boolean }} options
 * @returns {string}
 */
export function databaseName({ namespace = '', demo = false, session = null, accounts = false } = {}) {
  const ns = cleanNamespace(namespace);
  const userId = session && session.user && typeof session.user.id === 'string' ? session.user.id.trim() : '';
  if (ns) return accounts && !demo && userId ? `${DB_PREFIX}${ns}.${userId}` : `${DB_PREFIX}${ns}`;
  if (demo) return DEMO_DB;
  if (userId) return `${DB_PREFIX}${userId}`;
  return LOCAL_DB;
}

/**
 * Banco do "modo local" correspondente: 'dm-local' em produção; 'dm-NOME' num espaço isolado com ?accounts=1.
 * @param {{ namespace?: string, accounts?: boolean }} options
 * @returns {string}
 */
export function localDatabaseName({ namespace = '', accounts = false } = {}) {
  const ns = cleanNamespace(namespace);
  return ns && accounts ? `${DB_PREFIX}${ns}` : LOCAL_DB;
}

// ---------------------------------------------------------------------------
// Primeiro login: trazer os dados do modo local para a conta
// ---------------------------------------------------------------------------

/**
 * Chave de `store.meta` NO BANCO LOCAL ('dm-local') com as contas que já receberam uma cópia destes dados:
 * `[{ userId, at }]`. Uma segunda conta que aceitar a cópia recebe os registros com identificadores NOVOS — os
 * originais já pertencem à primeira conta no servidor, que recusaria a gravação (RLS, código 42501).
 */
export const ADOPTED_BY_META_KEY = 'adoptedBy';

function adoptersOf(value) {
  return (Array.isArray(value) ? value : []).filter((entry) => entry && typeof entry.userId === 'string' && entry.userId);
}

/**
 * Cópia de um backup (exportData) com identificadores novos em todas as tabelas com `id`, e todas as referências
 * remapeadas: project_id, demand_id, parent_id, task_id, depends_on_id, carried_from_id, entity_id — e qualquer
 * id citado dentro de campos JSON (old_value/new_value/meta do histórico, valores de configuração). Assim os
 * registros viram uma cópia independente que pode ser enviada a OUTRA conta.
 * @param {{ tables: Record<string, object[]> }} data backup (não é alterado)
 * @param {() => string} [newId] gerador de ids (padrão: uuid v4)
 * @returns {object} backup novo, com os mesmos campos de topo
 */
export function rekeyBackup(data, newId = uuid) {
  const tables = data && data.tables && typeof data.tables === 'object' ? data.tables : {};
  const map = new Map();
  for (const desc of TABLES) {
    if (desc.idField !== 'id') continue;
    for (const row of Array.isArray(tables[desc.name]) ? tables[desc.name] : []) {
      if (row && typeof row.id === 'string' && row.id && !map.has(row.id)) map.set(row.id, newId());
    }
  }
  const remapJson = (value) => {
    if (typeof value === 'string') return map.has(value) ? map.get(value) : value;
    if (Array.isArray(value)) return value.map(remapJson);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = remapJson(v);
      return out;
    }
    return value;
  };
  const outTables = {};
  for (const [name, list] of Object.entries(tables)) {
    let desc = null;
    try {
      desc = tableDesc(name);
    } catch {
      desc = null;
    }
    if (!desc || !Array.isArray(list)) {
      outTables[name] = list;
      continue;
    }
    outTables[name] = list.map((row) => {
      if (!row || typeof row !== 'object') return row;
      const copy = { ...row };
      for (const [field, def] of Object.entries(desc.fields)) {
        if (!(field in copy)) continue;
        if (def.type === 'uuid' && typeof copy[field] === 'string' && map.has(copy[field])) copy[field] = map.get(copy[field]);
        else if (def.type === 'json') copy[field] = remapJson(copy[field]);
      }
      return copy;
    });
  }
  return { ...data, tables: outTables };
}

/** O banco existe neste navegador? (true quando o navegador não sabe responder) */
async function databaseExists(name) {
  try {
    if (typeof indexedDB === 'undefined' || typeof indexedDB.databases !== 'function') return true;
    const list = await indexedDB.databases();
    return list.some((info) => info && info.name === name);
  } catch {
    return true;
  }
}

/** Quantidades de linhas vivas que interessam ao usuário num banco local. */
function countData(store) {
  const live = (table) => store.all(table).length;
  return { projects: live('projects'), demands: live('demands'), tasks: live('tasks') };
}

/**
 * No primeiro uso de uma conta neste navegador, oferece copiar para ela os dados criados no modo local.
 *
 * Só pergunta quando o banco da conta nunca passou por esta decisão (`store.meta` 'adopted' vazio) e o banco
 * local tem projetos, demandas ou tarefas. "Sim" copia TODAS as linhas (exportData do banco local →
 * importData no banco da conta, modo 'merge', que marca as linhas para envio); a decisão (sim ou não) fica
 * registrada e não é perguntada de novo. O banco local nunca é alterado: continua como cópia de segurança.
 *
 * O banco local guarda QUAIS contas já receberam a cópia (meta 'adoptedBy'). Se outra conta já recebeu e esta
 * ainda não, a pergunta avisa disso e a cópia vai com identificadores novos (rekeyBackup): os originais pertencem
 * à outra conta no servidor e seriam recusados para sempre.
 *
 * @param {object} options
 * @param {object} options.store banco da conta (já aberto)
 * @param {string} [options.localDbName='dm-local'] banco do modo local
 * @param {string|null} [options.userId] conta que está recebendo os dados
 * @param {(counts: { projects: number, demands: number, tasks: number }, info: { adoptedElsewhere: boolean }) => Promise<boolean>} [options.ask]
 *        pergunta ao usuário (padrão: diálogo do kit)
 * @param {() => Date} [options.now] relógio (registro da decisão)
 * @returns {Promise<{ asked: boolean, imported: boolean, rekeyed: boolean, total: number, changed: number }>}
 */
export async function adoptLocalData({ store, localDbName = LOCAL_DB, userId = null, ask = askAdoption, now = () => new Date() } = {}) {
  const result = { asked: false, imported: false, rekeyed: false, total: 0, changed: 0 };
  if (!store || store.dbName === localDbName) return result;
  if (store.meta.get(ADOPTED_META_KEY) !== undefined) return result;
  if (!(await databaseExists(localDbName))) return result;

  let local = null;
  try {
    local = await createStore({ dbName: localDbName, broadcast: false });
    const counts = countData(local);
    if (counts.projects + counts.demands + counts.tasks === 0) return result;
    const adopters = adoptersOf(local.meta.get(ADOPTED_BY_META_KEY));
    const account = typeof userId === 'string' && userId ? userId : null;
    const adoptedElsewhere = !!account && adopters.length > 0 && !adopters.some((entry) => entry.userId === account);
    result.asked = true;
    const yes = await ask(counts, { adoptedElsewhere });
    if (yes) {
      let data = local.exportData();
      if (adoptedElsewhere) {
        data = rekeyBackup(data);
        result.rekeyed = true;
      }
      const outcome = await store.importData(data, { mode: 'merge' });
      result.imported = true;
      result.total = outcome && Number.isFinite(outcome.total) ? outcome.total : 0;
      result.changed = outcome && Number.isFinite(outcome.changed) ? outcome.changed : 0;
      if (account && !adopters.some((entry) => entry.userId === account)) {
        await local.meta.set(ADOPTED_BY_META_KEY, [...adopters, { userId: account, at: now().toISOString(), rekeyed: adoptedElsewhere }]);
      }
    }
    await store.meta.set(ADOPTED_META_KEY, { choice: yes ? 'imported' : 'declined', at: now().toISOString() });
    return result;
  } finally {
    if (local) {
      try {
        await local.close();
      } catch {
        /* já fechado */
      }
    }
  }
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Pergunta padrão do primeiro login. */
function askAdoption(counts, { adoptedElsewhere = false } = {}) {
  const parts = [];
  if (counts.projects) parts.push(plural(counts.projects, 'projeto', 'projetos'));
  if (counts.demands) parts.push(plural(counts.demands, 'demanda', 'demandas'));
  if (counts.tasks) parts.push(plural(counts.tasks, 'tarefa', 'tarefas'));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}` : parts[0];
  return confirmDialog({
    title: 'Trazer os dados deste dispositivo para a conta?',
    message:
      `Este navegador tem ${list} criados antes de você entrar na conta.\n\n` +
      (adoptedElsewhere
        ? 'Atenção: estes dados já foram copiados para OUTRA conta neste navegador. Se continuar, esta conta recebe uma cópia independente (alterações numa conta não aparecem na outra).\n\n'
        : '') +
      'Deseja copiá-los para a sua conta? Eles passarão a sincronizar com seus outros dispositivos. ' +
      'Os dados locais continuam guardados neste navegador como cópia de segurança.',
    confirmLabel: 'Trazer para a conta',
    cancelLabel: 'Agora não',
  });
}

/**
 * Depois de montar a casca: o que fazer com a volta de um link do e-mail.
 *   recuperação de senha → diálogo "Nova senha"; confirmação de conta → aviso de que entrou;
 *   link expirado/inválido → aviso com o motivo.
 */
function handleAuthRedirect(app, redirect, { configured }) {
  try {
    if (redirect.error || !redirect.session) {
      toast(authRedirectErrorText(redirect.error), { id: 'auth-link', tone: 'danger', duration: 0 });
      return;
    }
    if (!configured) return;
    if (redirect.type === 'recovery') {
      openNewPasswordDialog(app);
      return;
    }
    toast(`Você entrou na conta${redirect.session.user.email ? ` ${redirect.session.user.email}` : ''}.`, { id: 'auth-link', tone: 'success' });
  } catch (err) {
    console.error('[boot] falha ao tratar o link do e-mail', err);
  }
}

// ---------------------------------------------------------------------------
// Tela de erro
// ---------------------------------------------------------------------------

/** Dica prática para as falhas mais comuns. */
function hintFor(error) {
  const text = `${error && error.name ? error.name : ''} ${error && error.message ? error.message : ''}`.toLowerCase();
  if (/indexeddb|idb|quota|database|versionerror|invalidstate/.test(text)) {
    return 'O navegador não conseguiu abrir o banco local. Feche outras abas do Demand Manager, confira se o navegador não está em modo privado e se há espaço livre, e recarregue.';
  }
  if (/import|module|failed to fetch|script/.test(text)) {
    return 'Um arquivo do aplicativo não pôde ser carregado. Confira a conexão (ou se o servidor local está aberto) e recarregue.';
  }
  return 'Recarregue a página. Se o problema continuar, abra Configurações → Dados para exportar um backup e avise o suporte.';
}

/**
 * Mostra uma tela de erro legível no lugar do aplicativo (nunca deixa a página em branco).
 * @param {Element} root contêiner do app
 * @param {unknown} error o erro capturado
 * @param {string} [stage] o que estava sendo feito ('abrir o banco local'…)
 * @param {Window} [win] janela (para o botão "Recarregar")
 * @returns {HTMLElement} o elemento da tela de erro
 */
export function renderBootError(root, error, stage = 'iniciar o aplicativo', win = globalThis) {
  const doc = root && root.ownerDocument ? root.ownerDocument : document;
  const el = (tag, cls, text) => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const message = error && typeof error.message === 'string' && error.message ? error.message : String(error || 'Erro desconhecido.');
  const box = el('div', 'boot-error');
  box.setAttribute('role', 'alert');
  box.dataset.bootError = 'true';
  const card = el('div', 'boot-error-card');
  card.append(
    el('div', 'boot-error-title', 'Não foi possível abrir o Demand Manager'),
    el('p', 'boot-error-stage', `Falha ao ${stage}.`),
    el('pre', 'boot-error-message', message),
    el('p', 'boot-error-hint', hintFor(error)),
  );
  const actions = el('div', 'boot-error-actions');
  const reload = el('button', 'btn btn-primary', 'Recarregar');
  reload.type = 'button';
  reload.addEventListener('click', () => {
    try {
      win.location.reload();
    } catch {
      /* janela inacessível */
    }
  });
  actions.append(reload);
  card.append(actions);
  box.append(card);
  if (root) root.replaceChildren(box);
  return box;
}

/**
 * O service worker deve ser registrado nesta página?
 * @param {Location|URL} location endereço da página
 * @param {URLSearchParams} params parâmetros da URL
 * @param {Navigator} [nav] navegador (precisa ter serviceWorker)
 * @returns {boolean}
 */
export function shouldRegisterServiceWorker(location, params, nav = globalThis.navigator) {
  if (!location || !/^https?:$/.test(location.protocol)) return false;
  if (params.has('nosw') || params.get('demo') === '1' || params.has('db')) return false;
  return !!(nav && 'serviceWorker' in nav);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

/**
 * Inicializa o aplicativo inteiro e monta a interface em `root`.
 *
 * Etapas: armazenamento do dispositivo (com o prefixo de ?db=) → configuração do Supabase (Configurações,
 * config.js ou emulador) → sessão → banco local ('dm-NOME', 'dm-demo', 'dm-<usuário>' ou 'dm-local') →
 * relógio, sincronização e app → dados de demonstração (?demo=1, banco vazio) → oferta de trazer os dados
 * locais no primeiro login → casca → sincronização automática → window.DM = { app, ready: true, version }.
 *
 * Em `app.env` ficam os dados do ambiente usados pela tela de Configurações:
 * `{ version, dbName, demo, namespace, storage, config, emulator, deviceId, createRemote(url, key), saveConfig(cfg),
 *    reload() }`.
 *
 * @param {object} [options]
 * @param {Element} options.root contêiner do app (ex.: #app)
 * @param {URLSearchParams} [options.params] parâmetros da URL (padrão: os da página)
 * @param {Window} [options.win] janela (padrão: window)
 * @returns {Promise<object>} o app pronto
 * @throws o erro original, depois de mostrar a tela de erro
 */
export async function boot({ root, params = new URLSearchParams(globalThis.location ? globalThis.location.search : ''), win = globalThis } = {}) {
  let stage = 'preparar o armazenamento do dispositivo';
  try {
    // Marca "iniciando" já no começo: ferramentas e testes esperam por DM.ready === true.
    win.DM = { app: null, ready: false, version: APP_VERSION };
  } catch {
    /* janela inacessível */
  }
  try {
    if (!root) throw new Error('Contêiner do aplicativo (#app) não encontrado na página.');
    // Captura rápida (compartilhar/atalho/favorito): o texto sai da barra de endereço antes de qualquer outra coisa.
    const capture = readCaptureParams(win.location ? win.location.search : '');
    if (capture) clearCaptureParams(win);
    const namespace = cleanNamespace(params.get('db'));
    const demo = params.get('demo') === '1';
    // Só vale com ?db=NOME: o espaço isolado passa a ter um banco por conta, como um navegador de verdade.
    const accounts = !!namespace && params.get('accounts') === '1';
    const storage = createNamespacedStorage(namespace, safeLocalStorage(win));
    const deviceId = readDeviceId(storage);

    stage = 'ler a configuração da sincronização';
    const emulator = emulatorHook(params, win);
    // Espaço isolado (?db=NOME: testes, desenvolvimento) ignora o config.js publicado: nunca fala com o Supabase
    // real por acidente. Lá vale só a configuração gravada no próprio espaço (ou o emulador).
    const config = emulator ? { supabaseUrl: emulator.url, supabaseKey: emulator.key, source: 'emulator' } : readConfig(storage, namespace ? {} : win);
    const fetchImpl = emulator ? (input, init) => emulator.fetch(input, init) : null;

    // Volta de um link do e-mail (recuperar senha, confirmar conta): os tokens saem JÁ da barra de endereço e do
    // histórico (um refresh_token vivo não pode ficar num favorito ou num link compartilhado); a sessão que o
    // link trouxe é guardada antes de o cliente do Supabase ler a sessão — o app abre já na conta.
    const authRedirect = parseAuthRedirect(win.location ? win.location.hash : '');
    if (authRedirect) {
      clearAuthHash(win);
      if (authRedirect.session && config && !demo) {
        try {
          storageSessionStore(storage, config.supabaseUrl).set(authRedirect.session);
        } catch {
          /* sem armazenamento: segue sem a sessão do link */
        }
      }
    }

    let remote = null;
    if (config && !demo) {
      stage = 'preparar a conexão com o Supabase';
      remote = createSupabaseRemote({
        url: config.supabaseUrl,
        key: config.supabaseKey,
        fetchImpl,
        // Sem espaço isolado vale o padrão do cliente (localStorage compartilhado entre as abas, com aviso de troca).
        sessionStore: namespace || emulator ? storageSessionStore(storage, config.supabaseUrl) : null,
      });
    }
    const session = remote ? remote.auth.session() : null;
    // Sessão perdida SEM "Sair" (renovação recusada, sessão encerrada no servidor): continua no banco da última conta,
    // com as pendências à vista, até o usuário entrar de novo — em vez de abrir o modo local como se nada existisse.
    if (remote && session) rememberAccount(storage, session);
    const lastAccount = remote && !session && !demo ? readLastAccount(storage) : null;
    const dbName = databaseName({ namespace, demo, session: session || (lastAccount ? { user: { id: lastAccount.id } } : null), accounts });

    stage = 'abrir o banco local';
    const wall = createWallClock();
    const store = await createStore({ dbName, now: wall.now });

    stage = 'preparar a sincronização';
    const sync = remote && !demo ? createSyncEngine({ store, remote, wall }) : null;
    const app = createApp({ store, wall, remote, sync, deviceId, prefsStorage: storage });
    app.env = {
      version: APP_VERSION,
      dbName,
      demo,
      namespace,
      accounts,
      storage,
      deviceId,
      emulator: !!emulator,
      config: config ? { ...config } : null,
      /**
       * Conta cujo banco está aberto SEM sessão (a sessão foi perdida sem "Sair", no início ou durante o uso):
       * { id, email } ou null.
       */
      get lastAccount() {
        try {
          return remote && !demo && !remote.auth.session() ? readLastAccount(storage) : null;
        } catch {
          return null;
        }
      },
      /** Esquece a última conta (chamado por "Sair": o próximo início abre o modo local). */
      forgetAccount: () => storage.removeItem(LAST_ACCOUNT_KEY),
      /** Cliente temporário do Supabase (sessão só em memória), para testar valores digitados. */
      createRemote: (url, key) => createSupabaseRemote({ url, key, fetchImpl, sessionStore: memorySessionStore() }),
      /** Grava (ou apaga, com null) a configuração do Supabase deste dispositivo. */
      saveConfig: (value) => saveConfig(storage, value),
      /** Recarrega a página (o boot abre o banco certo para a conta/configuração atual). */
      reload: () => win.location.reload(),
    };

    if (demo) {
      stage = 'gerar os dados de demonstração';
      const empty = store.all('projects', { includeDeleted: true }).length === 0 && store.all('demands', { includeDeleted: true }).length === 0 && store.all('tasks', { includeDeleted: true }).length === 0;
      if (empty) {
        // Os dados de exemplo (js/dev/seed.js) existem só na cópia local: não vão para o site publicado.
        // Sem o arquivo, o modo demonstração abre vazio em vez de quebrar.
        let seedDemo = null;
        try {
          ({ seedDemo } = await import('./dev/seed.js'));
        } catch (err) {
          console.warn('[boot] dados de demonstração indisponíveis nesta cópia (js/dev/seed.js ausente).', err);
        }
        if (seedDemo) seedDemo(app);
      }
    }

    if (!demo && (!namespace || accounts) && session) {
      stage = 'verificar os dados do modo local';
      try {
        await adoptLocalData({ store, localDbName: localDatabaseName({ namespace, accounts }), userId: session.user.id, now: wall.now });
      } catch (err) {
        // Não impede o uso da conta: o banco local continua intacto e a pergunta volta no próximo início.
        console.error('[boot] falha ao trazer os dados locais para a conta', err);
      }
    }

    // Cada tela carrega isolada: uma tela com defeito vira um cartão de erro, o resto do app funciona.
    stage = 'carregar as telas';
    await loadViews();

    stage = 'montar a interface';
    startShell(app, root);

    if (sync) {
      stage = 'iniciar a sincronização';
      sync.start();
    }

    if (authRedirect) handleAuthRedirect(app, authRedirect, { configured: !!(remote && remote.configured) });
    else if (capture && app.ui && typeof app.ui.quickCreate === 'function') app.ui.quickCreate('task', capturePrefill(capture));

    win.DM = { app, ready: true, version: APP_VERSION };
    return app;
  } catch (error) {
    console.error(`[boot] falha ao ${stage}`, error);
    try {
      renderBootError(root, error, stage, win);
    } catch {
      /* sem DOM: nada a mostrar */
    }
    try {
      win.DM = { app: null, ready: false, error: error && error.message ? error.message : String(error), version: APP_VERSION };
    } catch {
      /* janela inacessível */
    }
    throw error;
  }
}
