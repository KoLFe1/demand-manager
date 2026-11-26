// Cliente REST do Supabase: autenticação (GoTrue) + dados (PostgREST), só com fetch — sem supabase-js.
//
//   const remote = createSupabaseRemote({ url, key });
//   await remote.auth.signIn('ana@exemplo.com', 'senha');
//   const rows = await remote.upsert(tableDesc('tasks'), [toRemoteRow('tasks', task)]);
//   const page = await remote.pull(tableDesc('tasks'), cursor, 1000);
//
// Princípios:
//   - toda falha vira um `RemoteError` com `kind` (o que aconteceu), `message` (frase em pt-BR para
//     o usuário), `hint` (o que fazer) e `details` (a resposta original do servidor);
//   - a sessão mora no `sessionStore` (por padrão o localStorage, compartilhado entre as abas): o
//     token de acesso é renovado sozinho antes de vencer e depois de um 401, uma renovação por vez;
//   - uma resposta "200" que não é JSON (portal de Wi-Fi, proxy) NUNCA conta como gravação feita;
//   - nenhum token, senha ou corpo de requisição é escrito no console ou guardado nos erros.

/** Renova o token quando faltam menos de 60 s para vencer. */
const EXPIRY_MARGIN_MS = 60 * 1000;
/** Validade presumida quando o servidor não informa (padrão do Supabase: 1 hora). */
const DEFAULT_EXPIRES_IN_S = 3600;

/** Códigos que significam "o script do banco não foi executado ou está desatualizado". */
const SCHEMA_CODES = new Set(['PGRST204', 'PGRST205', 'PGRST202', '42P01', '42703', '42883']);

const HINT_OFFLINE = 'Verifique a internet. As alterações continuam guardadas neste aparelho e serão enviadas quando a conexão voltar.';
const HINT_CONFIG = 'Confira a URL do projeto e a chave pública (anon) do Supabase em Configurações.';
const HINT_LOGIN = 'Entre com seu e-mail e senha para sincronizar. Nada foi perdido: as alterações continuam guardadas neste aparelho.';
const HINT_SCHEMA = 'Abra o SQL Editor do Supabase e execute o arquivo supabase/schema.sql inteiro (pode ser executado de novo sem perder dados).';
const HINT_SERVER = 'Tente de novo em instantes; a sincronização repete sozinha.';
const HINT_RATE = 'Aguarde alguns minutos antes de tentar de novo.';
const HINT_REJECTED = 'O registro continua guardado neste aparelho. Confira os dados dele; se o problema continuar, exporte um backup.';

/**
 * Erro de comunicação com o Supabase.
 *
 * `kind`:
 *   - `'network'`  sem conexão, tempo esgotado, requisição abortada ou resposta que não veio do Supabase;
 *   - `'config'`   URL/chave ausentes ou chave recusada pelo servidor;
 *   - `'auth'`     sem sessão, sessão vencida/recusada ou credenciais incorretas;
 *   - `'schema'`   tabela/coluna/função inexistente: o script supabase/schema.sql não foi executado ou está desatualizado;
 *   - `'rejected'` o servidor recusou os dados (restrição, permissão por linha, validação) — repetir não adianta;
 *   - `'server'`   erro temporário do servidor (5xx, limite de requisições) — vale tentar de novo depois.
 */
export class RemoteError extends Error {
  /**
   * @param {'network'|'auth'|'schema'|'rejected'|'server'|'config'} kind
   * @param {string} message frase em pt-BR para o usuário
   * @param {{ status?: number, code?: string|null, details?: any, hint?: string, cause?: any }} [info]
   */
  constructor(kind, message, { status = 0, code = null, details = null, hint = '', cause } = {}) {
    super(message);
    this.name = 'RemoteError';
    this.kind = kind;
    /** Status HTTP (0 quando não houve resposta). */
    this.status = status;
    /** Código do PostgREST/Postgres (ex.: '23503', 'PGRST205') ou do GoTrue (ex.: 'invalid_credentials'). */
    this.code = code;
    /** Resposta original do servidor (objeto JSON ou texto), para diagnóstico. */
    this.details = details;
    /** O que o usuário pode fazer. */
    this.hint = hint;
    if (cause !== undefined) this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function firstString(...values) {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v;
  return '';
}

/** Lê o conteúdo (claims) de um JWT sem validar a assinatura; null se não for um JWT legível. */
function jwtClaims(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return isObject(claims) ? claims : null;
  } catch {
    return null;
  }
}

/** Sessão no formato canônico, ou null se o valor guardado não serve. */
function normalizeSession(value) {
  if (!isObject(value) || typeof value.access_token !== 'string' || !value.access_token) return null;
  const user = isObject(value.user) ? value.user : null;
  if (!user || typeof user.id !== 'string' || !user.id) return null;
  const expires = Number(value.expires_at);
  return {
    access_token: value.access_token,
    refresh_token: typeof value.refresh_token === 'string' && value.refresh_token ? value.refresh_token : null,
    expires_at: Number.isFinite(expires) ? expires : 0,
    user: { id: user.id, email: typeof user.email === 'string' ? user.email : null },
  };
}

/** Armazenamento padrão da sessão: uma chave JSON no localStorage (nunca lança). */
function localStorageSessionStore(storageKey) {
  return {
    get() {
      try {
        const raw = globalThis.localStorage.getItem(storageKey);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    set(session) {
      try {
        if (session) globalThis.localStorage.setItem(storageKey, JSON.stringify(session));
        else globalThis.localStorage.removeItem(storageKey);
      } catch {
        /* sem localStorage (modo privado, cota): a sessão fica só na memória desta aba */
      }
    },
  };
}

/** URL base sem barras no fim; '' quando não é um endereço http(s) válido. */
function normalizeUrl(url) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return trimmed;
  } catch {
    return '';
  }
}

/** Endereço do app (origem + caminho, sem ?/#) para os links de e-mail; '' fora de uma página http(s). */
function defaultRedirectTo() {
  try {
    const loc = globalThis.location;
    if (!loc || !/^https?:$/.test(loc.protocol)) return '';
    return `${loc.origin}${loc.pathname}`;
  } catch {
    return '';
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'sem-url';
  }
}

// ---------------------------------------------------------------------------
// Tradução de erros
// ---------------------------------------------------------------------------

function isInvalidApiKey(status, payload) {
  if (status !== 401 && status !== 403) return false;
  const text = isObject(payload) ? firstString(payload.message, payload.msg, payload.error_description, payload.error) : String(payload || '');
  return /invalid api key|no api key found|apikey/i.test(text);
}

function invalidApiKeyError(status, payload) {
  return new RemoteError('config', 'A chave do Supabase foi recusada pelo servidor.', {
    status, code: 'invalid_api_key', details: payload, hint: HINT_CONFIG,
  });
}

function sessionExpiredError(info = {}) {
  return new RemoteError('auth', 'Sua sessão expirou. Entre novamente.', { hint: HINT_LOGIN, ...info });
}

function noSessionError() {
  return new RemoteError('auth', 'Você não está conectado à sua conta.', { code: 'no_session', hint: HINT_LOGIN });
}

function notConfiguredError() {
  return new RemoteError('config', 'A sincronização não está configurada.', {
    code: 'not_configured',
    hint: 'Informe a URL do projeto e a chave pública (anon) do Supabase em Configurações.',
  });
}

function serverError(status, code, payload) {
  if (status === 429) {
    return new RemoteError('server', 'Muitas requisições em pouco tempo: o servidor pediu para aguardar.', {
      status, code, details: payload, hint: HINT_RATE,
    });
  }
  return new RemoteError('server', `O servidor de sincronização está com problemas no momento (erro ${status}).`, {
    status, code, details: payload, hint: HINT_SERVER,
  });
}

/** Frase para uma recusa do PostgREST/Postgres (4xx que não é sessão nem schema). */
function rejectedMessage(status, code) {
  if (code === '23503') return 'O servidor recusou o registro: ele está ligado a outro registro que não existe no servidor.';
  if (code === '23505') return 'O servidor recusou o registro: já existe outro com a mesma identificação.';
  if (code === '23502') return 'O servidor recusou o registro: falta um campo obrigatório.';
  if (code === '23514') return 'O servidor recusou o registro: um valor não é aceito pelas regras do banco.';
  if (code === '42501') return 'O servidor recusou a gravação: este registro não pertence à sua conta ou você não tem permissão.';
  if (code && /^22/.test(code)) return 'O servidor recusou o registro: há um valor em formato inválido.';
  if (code && /^23/.test(code)) return 'O servidor recusou o registro: ele não respeita as regras do banco de dados.';
  if (status === 413) return 'O envio é grande demais para o servidor.';
  if (code === 'PGRST102' || status === 400) return 'O servidor não conseguiu interpretar os dados enviados.';
  if (status === 409) return 'O servidor recusou o registro por conflito com os dados que já estão lá.';
  return `O servidor recusou a operação (erro ${status}).`;
}

/** Converte uma resposta de erro do PostgREST (/rest/v1) em RemoteError. */
function restError(status, payload) {
  const obj = isObject(payload) ? payload : null;
  const code = obj && typeof obj.code === 'string' && obj.code ? obj.code : null;
  if (isInvalidApiKey(status, payload)) return invalidApiKeyError(status, payload);
  if (code && SCHEMA_CODES.has(code)) {
    return new RemoteError('schema', 'O banco de dados do Supabase não está preparado para esta versão do aplicativo.', {
      status, code, details: payload, hint: HINT_SCHEMA,
    });
  }
  // PGRST3xx = problemas com o JWT (vencido, inválido, ausente).
  if (status === 401 || (code && /^PGRST3\d\d$/.test(code)) || (status === 403 && !code)) {
    return sessionExpiredError({ status, code, details: payload });
  }
  if (status === 408 || status === 429 || status >= 500) return serverError(status, code, payload);
  return new RemoteError('rejected', rejectedMessage(status, code), { status, code, details: payload, hint: HINT_REJECTED });
}

/** Tradução dos erros mais comuns do GoTrue: [teste, tipo, mensagem, dica]. */
const AUTH_TRANSLATIONS = [
  [(c, m) => c === 'email_not_confirmed' || /email not confirmed/i.test(m),
    'auth', 'Seu e-mail ainda não foi confirmado.', 'Abra a mensagem de confirmação enviada para o seu e-mail e clique no link; depois entre de novo.'],
  [(c, m) => c === 'invalid_credentials' || /invalid login credentials|invalid email or password/i.test(m),
    'auth', 'E-mail ou senha incorretos.', 'Confira os dados e tente de novo. Se esqueceu a senha, use "Esqueci minha senha".'],
  [(c, m) => c === 'user_already_exists' || c === 'email_exists' || /already registered|already exists/i.test(m),
    'rejected', 'Este e-mail já está cadastrado.', 'Use "Entrar" com este e-mail ou recupere a senha.'],
  // antes de weak_password: a frase do GoTrue ("New password should be different…") também casa com "password should"
  [(c, m) => c === 'same_password' || /different from the old password/i.test(m),
    'rejected', 'A nova senha precisa ser diferente da atual.', ''],
  [(c, m) => c === 'weak_password' || /password should|weak password/i.test(m),
    'rejected', null, 'Escolha uma senha mais longa e difícil de adivinhar.'],
  [(c, m, s) => s === 429 || /rate_limit/.test(c) || /rate limit|too many requests|only request this after/i.test(m),
    'server', 'Muitas tentativas em pouco tempo.', HINT_RATE],
  [(c, m) => c === 'email_address_invalid' || c === 'email_address_not_authorized' || /validate email|invalid email|email address.*invalid/i.test(m),
    'rejected', 'O e-mail informado não é válido.', 'Confira o endereço digitado.'],
  [(c, m) => c === 'signup_disabled' || c === 'email_provider_disabled' || /signups? not allowed|signup is disabled/i.test(m),
    'rejected', 'O cadastro de novas contas está desativado neste projeto.', 'Ative o cadastro por e-mail no painel do Supabase (Authentication → Providers).'],
  [(c, m) => c === 'user_banned' || /user is banned/i.test(m),
    'auth', 'Esta conta está bloqueada.', 'Fale com quem administra o projeto no Supabase.'],
  [(c, m) => /^refresh_token_|^session_|^bad_jwt$|^no_authorization$|^user_not_found$/.test(c) || /refresh token|jwt|session/i.test(m),
    'auth', 'Sua sessão expirou. Entre novamente.', HINT_LOGIN],
  [(c, m) => /requires a valid password|password.*required|missing password/i.test(m),
    'rejected', 'Informe uma senha.', ''],
];

function weakPasswordMessage(serverMessage) {
  const m = /at least (\d+) characters/i.exec(serverMessage || '');
  return m ? `Senha fraca: use pelo menos ${m[1]} caracteres.` : 'Senha fraca: escolha uma senha mais forte.';
}

/** Converte uma resposta de erro do GoTrue (/auth/v1) em RemoteError. Os corpos variam conforme a versão. */
function authError(status, payload) {
  const obj = isObject(payload) ? payload : null;
  if (isInvalidApiKey(status, payload)) return invalidApiKeyError(status, payload);
  // { code: 400, error_code, msg }  |  { error, error_description }  |  { code, msg }  |  { message }
  const code = obj ? firstString(obj.error_code, obj.error, typeof obj.code === 'string' ? obj.code : '') : '';
  const serverMessage = obj ? firstString(obj.msg, obj.error_description, obj.message, obj.error) : String(payload || '');
  const info = { status, code: code || null, details: payload };
  for (const [test, kind, message, hint] of AUTH_TRANSLATIONS) {
    if (!test(code, serverMessage, status)) continue;
    return new RemoteError(kind, message === null ? weakPasswordMessage(serverMessage) : message, { ...info, hint });
  }
  if (status === 408 || status >= 500) return serverError(status, code || null, payload);
  if (status === 401 || status === 403) return sessionExpiredError(info);
  // Corpo que não é JSON (página HTML de proxy, texto cru) não vai para a frase do usuário: fica em details.
  const suffix = obj && serverMessage ? ` (${serverMessage.slice(0, 200)})` : '';
  return new RemoteError('rejected', `O servidor de login recusou a operação${suffix}.`, { ...info, hint: 'Confira os dados informados e tente de novo.' });
}

function networkError(cause, timedOut, timeoutMs) {
  if (timedOut) {
    return new RemoteError('network', `O servidor demorou demais para responder (mais de ${Math.round(timeoutMs / 1000)} s).`, {
      code: 'timeout', hint: HINT_OFFLINE, cause,
    });
  }
  return new RemoteError('network', 'Sem conexão com o servidor de sincronização.', { code: 'network', hint: HINT_OFFLINE, cause });
}

function unexpectedBodyError(status, payload) {
  return new RemoteError('network', 'A resposta recebida não veio do servidor de sincronização.', {
    status,
    code: 'unexpected_response',
    details: typeof payload === 'string' ? payload.slice(0, 500) : payload,
    hint: 'Se você está numa rede com tela de login (Wi-Fi público, proxy), conecte-se a ela e tente de novo. ' + HINT_CONFIG,
  });
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

/**
 * Cria o cliente do Supabase (Auth + REST).
 *
 * @param {object} options
 * @param {string} options.url   URL do projeto (ex.: https://abc.supabase.co)
 * @param {string} options.key   chave pública (anon / publishable)
 * @param {(input: string, init: object) => Promise<Response>} [options.fetchImpl] substituto de `fetch` (testes usam o emulador)
 * @param {{ get(): object|null, set(session: object|null): void }} [options.sessionStore] onde a sessão é
 *   guardada; padrão: localStorage, na chave `'dm.session.' + host da URL` (JSON)
 * @param {number} [options.timeoutMs=20000] tempo máximo de cada requisição
 * @param {() => number} [options.now=Date.now] relógio em milissegundos (validade do token)
 * @param {string|null} [options.redirectTo] endereço do app para onde os links de e-mail (confirmação de
 *   cadastro, recuperação de senha) devolvem o usuário — vai como `?redirect_to=` em /signup e /recover.
 *   Padrão: `location.origin + location.pathname` quando existe; null ou '' = não enviar (vale o Site URL do projeto)
 * @returns {object} remote:
 *   - `configured` (URL e chave presentes e válidas), `url`
 *   - `auth.session()` → `{ access_token, refresh_token, expires_at, user: { id, email } } | null`
 *   - `auth.signIn(email, password)` → sessão
 *   - `auth.signUp(email, password)` → `{ session, user, needsConfirmation }`
 *   - `auth.signOut()`, `auth.recover(email)`, `auth.refresh()` → sessão, `auth.onChange(fn)` → função que cancela
 *   - `auth.updatePassword(password)` → `{ id, email }` (troca a senha de quem está conectado)
 *   - `upsert(desc, rows)`, `insertIgnore(desc, rows)`, `pull(desc, afterSeq, limit)` → linhas do servidor
 *   - `rpc(name, args)`, `schemaVersion()` → número ou null, `ping()` → `{ ok, latencyMs, error }`
 *   Todas as falhas são `RemoteError`.
 */
export function createSupabaseRemote({
  url,
  key,
  fetchImpl = null,
  sessionStore = null,
  timeoutMs = 20000,
  now = Date.now,
  redirectTo = undefined,
} = {}) {
  const baseUrl = normalizeUrl(url);
  const redirectQuery = (() => {
    const target = redirectTo === undefined ? defaultRedirectTo() : typeof redirectTo === 'string' ? redirectTo.trim() : '';
    return target ? `?redirect_to=${encodeURIComponent(target)}` : '';
  })();
  const apiKey = typeof key === 'string' ? key.trim() : '';
  const configured = !!baseUrl && !!apiKey;
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (input, init) => globalThis.fetch(input, init);
  const storageKey = `dm.session.${hostOf(baseUrl)}`;
  const usesLocalStorage = !sessionStore;
  const sessions = sessionStore || localStorageSessionStore(storageKey);
  const limitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000;

  // --- sessão ----------------------------------------------------------------
  /** Última sessão gravada por esta instância (usada quando o armazenamento não funciona). */
  let memory = null;
  let storeWorks = true;
  const listeners = new Set();

  function readSession() {
    if (!configured) return null;
    if (!storeWorks) return memory;
    try {
      return normalizeSession(sessions.get());
    } catch {
      return memory;
    }
  }

  let lastNotified = (readSession() || {}).access_token || null;

  function notifyIfChanged() {
    const session = readSession();
    const token = session ? session.access_token : null;
    if (token === lastNotified) return;
    lastNotified = token;
    for (const listener of [...listeners]) {
      try {
        listener(session);
      } catch (e) {
        console.error('[remote] Erro num ouvinte de sessão:', e);
      }
    }
  }

  function setSession(session) {
    memory = session;
    try {
      sessions.set(session);
      const back = normalizeSession(sessions.get());
      storeWorks = session ? !!back && back.access_token === session.access_token : back === null;
    } catch {
      storeWorks = false;
    }
    notifyIfChanged();
  }

  /** Outra aba entrou/saiu/renovou o token (só com o armazenamento padrão, que é compartilhado). */
  function onStorageEvent(event) {
    if (event && event.key !== null && event.key !== storageKey) return;
    notifyIfChanged();
  }

  /** Monta a sessão a partir da resposta do GoTrue (login, cadastro ou renovação). */
  function sessionFromResponse(data, previousUser = null) {
    if (!isObject(data) || typeof data.access_token !== 'string' || !data.access_token) return null;
    const user = isObject(data.user) && typeof data.user.id === 'string' ? data.user : previousUser;
    if (!user || !user.id) return null;
    // A validade é contada pelo relógio DESTE aparelho (agora + expires_in): assim um relógio local
    // errado não faz o token parecer vencido (ou eterno).
    const nowS = Math.floor(now() / 1000);
    const expiresIn = Number(data.expires_in);
    let expiresAt;
    if (Number.isFinite(expiresIn) && expiresIn > 0) expiresAt = nowS + Math.floor(expiresIn);
    else if (Number.isFinite(Number(data.expires_at)) && Number(data.expires_at) > 0) expiresAt = Number(data.expires_at);
    else {
      const claims = jwtClaims(data.access_token);
      expiresAt = claims && Number.isFinite(Number(claims.exp)) ? Number(claims.exp) : nowS + DEFAULT_EXPIRES_IN_S;
    }
    return normalizeSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: expiresAt,
      user: { id: user.id, email: user.email },
    });
  }

  // --- requisição ------------------------------------------------------------
  function assertConfigured() {
    if (!configured) throw notConfiguredError();
  }

  /**
   * Uma requisição HTTP com tempo limite. Devolve `{ status, ok, payload, json }` (payload = JSON já
   * interpretado, ou o texto cru com `json: false`; null quando não há corpo). Só lança
   * `RemoteError('network')`.
   */
  async function send(method, path, { token = null, body, prefer = null } = {}) {
    const headers = {
      apikey: apiKey,
      Authorization: `Bearer ${token || apiKey}`,
      'Content-Type': 'application/json',
    };
    if (prefer) headers.Prefer = prefer;
    const init = { method, headers, cache: 'no-store' };
    if (body !== undefined) init.body = JSON.stringify(body);

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) init.signal = controller.signal;
    let timedOut = false;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        if (controller) controller.abort();
        reject(new Error('timeout'));
      }, limitMs);
    });
    const work = (async () => {
      const response = await doFetch(baseUrl + path, init);
      const text = await response.text();
      return { status: response.status, text };
    })();
    work.catch(() => {}); // se o tempo esgotar primeiro, a falha tardia do fetch não fica "solta"
    let result;
    try {
      result = await Promise.race([work, timeout]);
    } catch (cause) {
      throw networkError(cause, timedOut, limitMs);
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    let json = true; // corpo vazio conta como "sem conteúdo", não como resposta estranha
    if (result.text) {
      try {
        payload = JSON.parse(result.text);
      } catch {
        payload = result.text;
        json = false;
      }
    }
    return { status: result.status, ok: result.status >= 200 && result.status < 300, payload, json };
  }

  /** Requisição ao GoTrue; devolve o corpo JSON (ou null) e lança RemoteError nas falhas. */
  async function authCall(method, path, { body, token = null } = {}) {
    assertConfigured();
    const res = await send(method, path, { body, token });
    if (!res.ok) throw authError(res.status, res.payload);
    if (!res.json) throw unexpectedBodyError(res.status, res.payload);
    return res.payload;
  }

  // --- renovação do token ------------------------------------------------------
  let refreshing = null;

  async function doRefresh() {
    assertConfigured();
    const before = readSession();
    if (!before) throw noSessionError();
    if (!before.refresh_token) {
      setSession(null);
      throw sessionExpiredError({ code: 'no_refresh_token' });
    }
    // Falha de rede aqui é lançada por send() e NÃO apaga a sessão: sem internet ninguém é deslogado.
    const res = await send('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: before.refresh_token } });
    if (res.ok) {
      const next = sessionFromResponse(res.payload, before.user);
      if (!next) throw unexpectedBodyError(res.status, res.payload);
      setSession(next);
      return next;
    }
    const error = authError(res.status, res.payload);
    // Problema temporário ou de configuração: o token de renovação continua valendo.
    if (error.kind === 'server' || error.kind === 'config' || error.kind === 'network') throw error;
    // O servidor recusou o token. Outra aba pode tê-lo renovado antes (o token é de uso único):
    // nesse caso a sessão nova já está guardada e é ela que vale.
    const latest = readSession();
    if (latest && latest.refresh_token && latest.refresh_token !== before.refresh_token) return latest;
    setSession(null);
    throw sessionExpiredError({ status: res.status, code: error.code, details: res.payload });
  }

  /** Renova o token (uma requisição por vez: quem chamar durante a renovação recebe a mesma promessa). */
  function refresh() {
    if (!refreshing) {
      refreshing = doRefresh().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  /** Sessão com token válido por pelo menos mais 60 s (renova antes, se preciso). */
  async function freshSession() {
    const session = readSession();
    if (!session) throw noSessionError();
    const remaining = session.expires_at * 1000 - now();
    if (remaining >= EXPIRY_MARGIN_MS || !session.refresh_token) return session;
    try {
      return await refresh();
    } catch (e) {
      // O token atual ainda vale por alguns segundos: um tropeço temporário na renovação não impede o uso.
      if (remaining > 0 && e instanceof RemoteError && (e.kind === 'server' || e.kind === 'network')) return session;
      throw e;
    }
  }

  /** Requisição ao PostgREST com o token do usuário; renova e repete UMA vez depois de um 401. */
  async function rest(method, path, { body, prefer = null } = {}) {
    assertConfigured();
    let session = await freshSession();
    let res = await send(method, path, { token: session.access_token, body, prefer });
    if (res.status === 401 && !isInvalidApiKey(res.status, res.payload)) {
      const current = readSession();
      // Se o token guardado já é outro (renovado por outra chamada ou outra aba), basta repetir com ele.
      session = current && current.access_token !== session.access_token ? current : await refresh();
      res = await send(method, path, { token: session.access_token, body, prefer });
    }
    if (!res.ok) throw restError(res.status, res.payload);
    return res;
  }

  /** Resposta de leitura/gravação: precisa ser uma lista JSON — qualquer outra coisa não é confirmação. */
  function rowsOf(res) {
    if (res.json && Array.isArray(res.payload)) return res.payload;
    throw unexpectedBodyError(res.status, res.payload);
  }

  function tableName(desc) {
    const name = desc && desc.remote;
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError('remote: descritor de tabela inválido (falta "remote").');
    }
    return name;
  }

  async function write(desc, rows, resolution) {
    const name = tableName(desc);
    if (!Array.isArray(rows)) throw new TypeError('remote: esperava uma lista de linhas.');
    assertConfigured();
    if (rows.length === 0) return [];
    const conflict = desc.onConflict ? `?on_conflict=${desc.onConflict}` : '';
    const res = await rest('POST', `/rest/v1/${name}${conflict}`, {
      body: rows,
      prefer: `resolution=${resolution},return=representation`,
    });
    return rowsOf(res);
  }

  /**
   * Chama uma função do banco (`POST /rest/v1/rpc/<nome>`).
   * @param {string} name nome da função
   * @param {object} [args] argumentos nomeados
   * @returns {Promise<any>} o valor devolvido (null para funções sem retorno)
   */
  async function rpc(name, args = {}) {
    if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError('rpc: nome de função inválido.');
    const res = await rest('POST', `/rest/v1/rpc/${name}`, { body: isObject(args) ? args : {} });
    if (!res.json) throw unexpectedBodyError(res.status, res.payload);
    return res.payload;
  }

  /**
   * Versão do schema instalada no servidor (`dm_schema_version()`).
   * @returns {Promise<number|null>} null quando a função não existe (o script ainda não foi executado)
   */
  async function schemaVersion() {
    let value;
    try {
      value = await rpc('dm_schema_version');
    } catch (e) {
      if (e instanceof RemoteError && e.kind === 'schema') return null;
      throw e;
    }
    if (Array.isArray(value)) value = value[0];
    if (isObject(value)) value = Object.values(value)[0];
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  const auth = {
    /**
     * Sessão atual (lida do armazenamento, compartilhado entre as abas) ou null.
     * @returns {{ access_token: string, refresh_token: string|null, expires_at: number, user: { id: string, email: string|null } } | null}
     */
    session() {
      return readSession();
    },

    /**
     * Entra com e-mail e senha.
     * @param {string} email
     * @param {string} password
     * @returns {Promise<object>} a sessão criada
     * @throws {RemoteError} `auth` para credenciais incorretas ou e-mail não confirmado
     */
    async signIn(email, password) {
      assertConfigured();
      const address = String(email || '').trim();
      if (!address || !password) {
        throw new RemoteError('rejected', 'Informe o e-mail e a senha.', { code: 'validation_failed', hint: '' });
      }
      const data = await authCall('POST', '/auth/v1/token?grant_type=password', { body: { email: address, password: String(password) } });
      const session = sessionFromResponse(data);
      if (!session) throw unexpectedBodyError(200, null);
      setSession(session);
      return session;
    },

    /**
     * Cria uma conta. Quando o projeto exige confirmação de e-mail não há sessão: o usuário precisa
     * clicar no link recebido e depois entrar.
     * @param {string} email
     * @param {string} password
     * @returns {Promise<{ session: object|null, user: { id: string, email: string|null }|null, needsConfirmation: boolean }>}
     */
    async signUp(email, password) {
      assertConfigured();
      const address = String(email || '').trim();
      if (!address || !password) {
        throw new RemoteError('rejected', 'Informe o e-mail e a senha.', { code: 'validation_failed', hint: '' });
      }
      const data = await authCall('POST', `/auth/v1/signup${redirectQuery}`, { body: { email: address, password: String(password) } });
      const session = sessionFromResponse(data);
      if (session) {
        setSession(session);
        return { session, user: session.user, needsConfirmation: false };
      }
      const raw = isObject(data) ? (isObject(data.user) ? data.user : data) : null;
      // Com confirmação de e-mail ligada, o Supabase não diz que o e-mail já tem conta: devolve um
      // usuário "de mentira", reconhecível pela lista de identidades vazia.
      if (raw && Array.isArray(raw.identities) && raw.identities.length === 0) {
        throw new RemoteError('rejected', 'Este e-mail já está cadastrado.', {
          status: 200, code: 'user_already_exists', hint: 'Use "Entrar" com este e-mail ou recupere a senha.',
        });
      }
      const user = raw && typeof raw.id === 'string' ? { id: raw.id, email: typeof raw.email === 'string' ? raw.email : address } : null;
      return { session: null, user, needsConfirmation: true };
    },

    /**
     * Sai da conta NESTE aparelho. A sessão local é sempre apagada, mesmo sem internet; o aviso ao
     * servidor é feito por melhor esforço.
     * @returns {Promise<void>}
     */
    async signOut() {
      const session = readSession();
      setSession(null);
      if (!configured || !session) return;
      try {
        await send('POST', '/auth/v1/logout?scope=local', { token: session.access_token });
      } catch {
        /* melhor esforço: sem conexão a sessão do servidor vence sozinha */
      }
    },

    /**
     * Pede o e-mail de recuperação de senha.
     * @param {string} email
     * @returns {Promise<void>}
     */
    async recover(email) {
      assertConfigured();
      const address = String(email || '').trim();
      if (!address) throw new RemoteError('rejected', 'Informe o e-mail.', { code: 'validation_failed', hint: '' });
      await authCall('POST', `/auth/v1/recover${redirectQuery}`, { body: { email: address } });
    },

    /**
     * Troca a senha de quem está conectado (inclusive pela sessão aberta pelo link de recuperação).
     * Usa o token da sessão atual, renovado antes se estiver para vencer. O GoTrue encerra as outras
     * sessões do usuário; a deste aparelho continua (e é substituída se a resposta trouxer uma nova).
     * @param {string} password a senha nova
     * @returns {Promise<{ id: string, email: string|null }>} o usuário
     * @throws {RemoteError} `rejected` para senha igual à atual (`same_password`) ou fraca (`weak_password`);
     *   `auth` sem sessão ou com a sessão recusada
     */
    async updatePassword(password) {
      assertConfigured();
      if (!password) throw new RemoteError('rejected', 'Informe a nova senha.', { code: 'validation_failed', hint: '' });
      const session = await freshSession();
      const data = await authCall('PUT', '/auth/v1/user', { body: { password: String(password) }, token: session.access_token });
      const next = sessionFromResponse(data, session.user);
      if (next) setSession(next);
      const raw = isObject(data) ? (isObject(data.user) ? data.user : data) : null;
      if (!raw || typeof raw.id !== 'string' || !raw.id) {
        if (next) return { ...next.user };
        throw unexpectedBodyError(200, data);
      }
      return { id: raw.id, email: typeof raw.email === 'string' ? raw.email : session.user.email };
    },

    /**
     * Renova o token de acesso. Chamadas simultâneas compartilham UMA requisição. Se o servidor
     * recusar o token de renovação, a sessão é apagada e o erro é `auth`; falha de rede não apaga nada.
     * @returns {Promise<object>} a sessão nova
     */
    refresh,

    /**
     * Avisa quando a sessão muda (entrar, sair, renovar, sessão recusada — inclusive em outra aba).
     * @param {(session: object|null) => void} listener
     * @returns {() => void} função que cancela a inscrição
     */
    onChange(listener) {
      if (typeof listener !== 'function') throw new TypeError('onChange: informe uma função.');
      const canListen = usesLocalStorage && typeof globalThis.addEventListener === 'function';
      if (listeners.size === 0 && canListen) globalThis.addEventListener('storage', onStorageEvent);
      listeners.add(listener);
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0 && canListen) globalThis.removeEventListener('storage', onStorageEvent);
      };
    },
  };

  return {
    /** true quando URL e chave foram informadas (e a URL é um endereço http(s) válido). */
    configured,
    /** URL base do projeto (sem barra no fim). */
    url: baseUrl,
    auth,

    /**
     * Grava linhas de uma tabela mutável ('lww'): inclui ou mescla campo a campo no servidor.
     * @param {object} desc descritor da tabela (js/data/schema.js)
     * @param {object[]} rows linhas já no formato do servidor (`toRemoteRow`)
     * @returns {Promise<object[]>} as linhas como ficaram no servidor (mescladas)
     */
    upsert(desc, rows) {
      return write(desc, rows, 'merge-duplicates');
    },

    /**
     * Inclui linhas numa tabela imutável ('append'); as que já existem são ignoradas.
     * @param {object} desc descritor da tabela
     * @param {object[]} rows linhas no formato do servidor
     * @returns {Promise<object[]>} só as linhas realmente incluídas agora
     */
    insertIgnore(desc, rows) {
      return write(desc, rows, 'ignore-duplicates');
    },

    /**
     * Baixa uma página de linhas com `server_seq` maior que `afterSeq`, em ordem crescente.
     * O servidor pode devolver MENOS linhas que `limit` mesmo havendo mais (teto "Max rows"):
     * quem chama deve continuar até receber uma página vazia.
     * @param {object} desc descritor da tabela
     * @param {number} afterSeq cursor (último `server_seq` já recebido; 0 = desde o início)
     * @param {number} limit tamanho da página
     * @returns {Promise<object[]>}
     */
    async pull(desc, afterSeq, limit) {
      const name = tableName(desc);
      const after = Number.isFinite(Number(afterSeq)) && Number(afterSeq) > 0 ? Math.floor(Number(afterSeq)) : 0;
      const size = Number.isFinite(Number(limit)) && Number(limit) >= 1 ? Math.floor(Number(limit)) : 1000;
      const res = await rest('GET', `/rest/v1/${name}?select=*&server_seq=gt.${after}&order=server_seq.asc&limit=${size}`);
      return rowsOf(res);
    },

    rpc,
    schemaVersion,

    /**
     * Testa a conexão com o projeto (não precisa de login).
     * @returns {Promise<{ ok: boolean, latencyMs: number, error: RemoteError|null }>}
     */
    async ping() {
      const clock = typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : now;
      const started = clock();
      const elapsed = () => Math.max(0, Math.round(clock() - started));
      try {
        assertConfigured();
        const res = await send('GET', '/auth/v1/settings');
        if (!res.ok) throw authError(res.status, res.payload);
        if (!res.json || !isObject(res.payload)) throw unexpectedBodyError(res.status, res.payload);
        return { ok: true, latencyMs: elapsed(), error: null };
      } catch (e) {
        const error = e instanceof RemoteError ? e : networkError(e, false, limitMs);
        return { ok: false, latencyMs: elapsed(), error };
      }
    },
  };
}
