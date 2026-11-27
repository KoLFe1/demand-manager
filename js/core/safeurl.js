// Endereços seguros para href/src. Puro: sem DOM.
//
//   safeHref('https://x.com')          → 'https://x.com'
//   safeHref(' JaVaScRiPt:alert(1)')   → null
//   safeHref('#/relatorio?panel=…')    → '#/relatorio?panel=…' (fragmento interno)
//   isUnsafeUrl('java\tscript:x')      → true   (o que dom.js recusa em href/src)
//
// Regra: todo href que vem de dados (links, relatório, resumo, capturas) passa por safeHref, que só deixa
// passar os esquemas da lista (http, https, mailto, tel, ms-excel/ms-word/ms-powerpoint) e fragmentos '#…'.
// Como o navegador ignora espaços/controles no começo e TAB/LF/CR no meio do esquema, e entidades HTML
// (&#x09;, &colon;) seriam decodificadas se o texto um dia passasse por HTML, a verificação olha o texto
// já "achatado" desses truques. dom.js aplica isUnsafeUrl a href/src/action/formaction/xlink:href de
// qualquer elemento, como segunda barreira (exceção explícita: trustedUrl(), usado só pelo favorito gerado
// pelo próprio app).

/** Esquemas aceitos por safeHref (minúsculos, sem ':'). */
export const SAFE_SCHEMES = Object.freeze(['http', 'https', 'mailto', 'tel', 'ms-excel', 'ms-word', 'ms-powerpoint']);

const SAFE_SET = new Set(SAFE_SCHEMES);
const UNSAFE_SET = new Set(['javascript', 'vbscript', 'data', 'livescript', 'mocha', 'jscript']);
const MAX_URL = 8000;

const NAMED = { colon: ':', tab: '\t', newline: '\n', sol: '/', amp: '&', lpar: '(', rpar: ')', nbsp: ' ' };

/** Decodifica entidades numéricas e algumas nomeadas (sem ';' também, como o navegador faz). */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    const named = NAMED[body.toLowerCase()];
    return named === undefined ? all : named;
  });
}

/** Esquema (minúsculo) de um endereço já sem truques, ou null quando é relativo. */
function schemeOf(flat) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(flat);
  return m ? m[1].toLowerCase() : null;
}

const INVISIBLE = /[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g;

/**
 * Formas achatadas do começo do texto: entidades decodificadas (duas passadas) e, se houver %xx, também a forma
 * decodificada (%6Aavascript: não é esquema para o navegador, mas viraria se alguém decodificasse); sem
 * espaços/controles/invisíveis em lugar nenhum.
 */
function flatForms(text) {
  const decoded = decodeEntities(decodeEntities(text));
  const forms = [decoded.replace(INVISIBLE, '')];
  if (/%[0-9a-f]{2}/i.test(decoded)) {
    try {
      forms.push(decodeURIComponent(decoded).replace(INVISIBLE, ''));
    } catch {
      /* sequência % inválida: fica só a primeira forma */
    }
  }
  return forms;
}

/**
 * O endereço usa um esquema que executa código ou carrega conteúdo arbitrário (javascript:, data:, vbscript:…)?
 * Considera maiúsculas, espaços/controles no começo e no meio e entidades HTML.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUnsafeUrl(value) {
  if (value === null || value === undefined) return false;
  const text = String(value);
  if (!text) return false;
  for (const flat of flatForms(text.slice(0, 200))) {
    const scheme = schemeOf(flat);
    if (scheme !== null && UNSAFE_SET.has(scheme)) return true;
  }
  return false;
}

/**
 * href seguro a partir de um texto vindo de dados (usuário, servidor, captura).
 * @param {unknown} value
 * @param {{ allowFragment?: boolean, schemes?: string[] }} [options] `allowFragment` (padrão true) aceita '#…';
 *        `schemes` troca a lista de esquemas aceitos
 * @returns {string|null} o endereço aparado, ou null quando não é permitido
 */
export function safeHref(value, { allowFragment = true, schemes } = {}) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_URL) return null;
  if (isUnsafeUrl(text)) return null;
  if (text[0] === '#') return allowFragment ? text : null;
  // O texto como o navegador vê (sem controles/TAB/LF): o esquema precisa estar na lista.
  const raw = text.replace(/[\u0000-\u001f]/g, '');
  const scheme = schemeOf(raw);
  if (scheme === null) return null; // relativo ou esquema escondido por entidades/espaços: recusa
  if (raw !== text) return null; // controle no meio do endereço: recusa (ninguém digita isso)
  const allowed = schemes ? new Set(schemes.map((s) => String(s).toLowerCase())) : SAFE_SET;
  return allowed.has(scheme) ? text : null;
}

/** Endereço gerado pelo próprio app que pode usar um esquema que dom.js recusaria (ex.: o favorito javascript:). */
export class TrustedUrl {
  constructor(url) {
    this.url = String(url);
    Object.freeze(this);
  }
  toString() {
    return this.url;
  }
}

/**
 * Marca um endereço gerado pelo próprio código (NUNCA com dados do usuário) como confiável para href.
 * @param {string} url
 * @returns {TrustedUrl}
 */
export function trustedUrl(url) {
  return new TrustedUrl(url);
}
