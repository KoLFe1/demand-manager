// Renderização declarativa do Demand Manager. Sem dependências.
//
//   h('div', { class: 'card', onclick }, 'texto', h('b', null, 'filho'))   cria elementos HTML
//   s('svg', { viewBox: '0 0 16 16' }, s('path', { d: '…' }))              cria elementos SVG
//   morph(alvo, novo)      deixa `alvo` igual a `novo` mexendo só no que mudou
//   mount(container, fn)   liga uma função de renderização a um contêiner
//
// As telas são funções puras: devolvem a árvore inteira a cada mudança e o morph aplica a diferença no
// DOM vivo. Como os nós intactos nunca são recriados nem reinseridos, foco, rolagem, seleção de texto e
// transições CSS em andamento sobrevivem a cada atualização.
//
// O que o DOM não mostra (funções de evento, ref e propriedades controladas) fica anotado no próprio
// elemento, em `el.__h = { on: { onclick: fn, … } | null, ref: fn | null, props: máscara }`, para o morph
// conseguir copiar de um nó para o outro. `el.__n` é só uma dica de desempenho (tamanho da subárvore).

import { isUnsafeUrl, TrustedUrl } from './safeurl.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Propriedades controladas: estado que o usuário muda interagindo e que não aparece nos atributos. */
const P_VALUE = 1;
const P_CHECKED = 2;
const P_SELECTED = 4;
const P_INDETERMINATE = 8;
const CONTROLLED_BIT = { checked: P_CHECKED, selected: P_SELECTED, indeterminate: P_INDETERMINATE };

/** Subárvores até este tamanho são comparadas de uma vez (isEqualNode) antes de serem percorridas. */
const EQUAL_LIMIT = 256;

/** Se o requestAnimationFrame estiver suspenso (aba oculta, iframe fora da tela), o agendamento cai neste prazo. */
const FRAME_FALLBACK_MS = 100;

/** Tipos de <input> em que o usuário NÃO digita texto. */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'hidden', 'range', 'color']);

const isNode = (value) => value !== null && typeof value === 'object' && typeof value.nodeType === 'number';

function isPlainProps(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

function addClass(out, value) {
  if (!value) return out;
  const type = typeof value;
  if (type === 'string') {
    const text = value.trim();
    if (!text) return out;
    return out ? `${out} ${text}` : text;
  }
  if (type === 'number') return out ? `${out} ${value}` : String(value);
  if (type !== 'object') return out;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) out = addClass(out, value[i]);
    return out;
  }
  for (const name in value) {
    if (value[name]) out = out ? `${out} ${name}` : name;
  }
  return out;
}

/**
 * Monta a lista de classes CSS.
 * Aceita strings, números, arrays (aninhados) e objetos `{ nome: condição }`; valores falsos são ignorados.
 *   cx('btn', ativo && 'is-active', { 'is-busy': ocupado }, ['a', ['b']]) → 'btn is-active a b'
 * @param {...(string|number|Array|object|null|undefined|false)} args
 * @returns {string} classes separadas por um espaço ('' se não sobrar nenhuma)
 */
export function cx(...args) {
  let out = '';
  for (let i = 0; i < args.length; i++) out = addClass(out, args[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Criação de elementos
// ---------------------------------------------------------------------------

function record(el) {
  return el.__h || (el.__h = { on: null, ref: null, props: 0 });
}

function callRef(fn, el) {
  try {
    fn(el);
  } catch (err) {
    console.error('[dom] erro dentro de ref()', err);
  }
}

/** Despacha eventos que não têm propriedade on<evento> no navegador, procurando a função no registro do elemento. */
function dispatchRecorded(event) {
  const el = event.currentTarget;
  const rec = el.__h;
  const fn = rec !== undefined && rec.on !== null ? rec.on[`on${event.type}`] : undefined;
  if (typeof fn === 'function' && fn.call(el, event) === false) event.preventDefault();
}

/** Liga (fn) ou desliga (null) um tratador de evento no DOM. Não mexe no registro `el.__h`. */
function bindHandler(el, name, fn) {
  if (name in el) {
    el[name] = fn;
    return;
  }
  if (fn === null) return;
  // Este navegador não tem a propriedade (ex.: onfocusout no Chrome/Edge): instala um único ouvinte
  // por tipo de evento; ele lê a função atual do registro na hora em que o evento acontece.
  const wired = el.__w || (el.__w = {});
  if (wired[name] === true) return;
  wired[name] = true;
  el.addEventListener(name.slice(2), dispatchRecorded);
}

/** Estados ARIA do tipo verdadeiro/falso: aqui "false" tem significado próprio (ex.: aria-expanded="false"). */
const ARIA_STATES = new Set([
  'aria-atomic', 'aria-busy', 'aria-checked', 'aria-current', 'aria-disabled', 'aria-expanded', 'aria-grabbed',
  'aria-haspopup', 'aria-hidden', 'aria-invalid', 'aria-modal', 'aria-multiline', 'aria-multiselectable',
  'aria-pressed', 'aria-readonly', 'aria-required', 'aria-selected',
]);

/** Texto de um atributo cujo valor é booleano (null = atributo ausente). */
function booleanText(name, on) {
  const lower = name.toLowerCase();
  // Atributos enumerados: "false" tem significado próprio, então o valor é escrito por extenso.
  if (lower === 'draggable' || lower === 'spellcheck' || lower === 'contenteditable' || ARIA_STATES.has(lower)) {
    return on ? 'true' : 'false';
  }
  // Demais aria-* (aria-label, aria-describedby…) e data-*: `cond && 'texto'` falso não cria o atributo.
  if (lower.startsWith('aria-') || lower.startsWith('data-')) return on ? 'true' : null;
  return on ? '' : null;
}

/** Atributos que carregam um endereço: javascript:/data:/vbscript: nunca entram neles (ver safeurl.js). */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'background', 'cite', 'srcdoc']);

function setAttr(el, name, value) {
  if (value == null) return;
  let text;
  if (value instanceof TrustedUrl) {
    text = value.url; // endereço gerado pelo próprio app (ex.: o favorito javascript:)
  } else if (value === true || value === false) {
    text = booleanText(name, value);
    if (text === null) return;
  } else {
    const type = typeof value;
    if (type === 'function' || type === 'symbol') return;
    text = type === 'string' ? value : String(value);
    if (URL_ATTRS.has(name.toLowerCase()) && (name.toLowerCase() === 'srcdoc' || isUnsafeUrl(text))) {
      console.warn(`[dom] endereço recusado em ${name}`);
      return;
    }
  }
  if (name.charCodeAt(0) === 120 /* x */) {
    if (name.startsWith('xlink:')) {
      el.setAttributeNS(XLINK_NS, name, text);
      return;
    }
    if (name.startsWith('xml:')) {
      el.setAttributeNS(XML_NS, name, text);
      return;
    }
  }
  el.setAttribute(name, text);
}

function applyStyle(el, value) {
  if (value == null || value === false) return;
  const style = el.style;
  if (!style) return;
  if (typeof value === 'string') {
    if (value.trim()) style.cssText = value;
    return;
  }
  if (typeof value !== 'object') return;
  for (const name in value) {
    const v = value[name];
    if (v == null || v === false || v === '') continue;
    if (name.includes('-')) {
      style.setProperty(name, String(v)); // --variável ou nome-com-hífen
    } else if (typeof v === 'number') {
      const text = String(v);
      style[name] = text;
      // Número puro só vale para propriedades sem unidade (opacity, zIndex, flex…); nas demais vira px.
      if (v !== 0 && style[name] === '') style[name] = `${text}px`;
    } else {
      style[name] = v;
    }
  }
}

const dataNames = new Map();

function dataAttrName(name) {
  let attr = dataNames.get(name);
  if (attr === undefined) {
    attr = `data-${name.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`;
    dataNames.set(name, attr);
  }
  return attr;
}

function applyDataset(el, value) {
  if (value === null || typeof value !== 'object') return;
  for (const name in value) {
    const v = value[name];
    if (v == null || v === false) continue;
    el.setAttribute(dataAttrName(name), v === true ? 'true' : String(v));
  }
}

function assignValue(el, text) {
  try {
    el.value = text;
  } catch {
    /* <input type="file"> só aceita valor vazio */
  }
}

/** Aplica value/checked/selected/indeterminate como PROPRIEDADES (depois dos filhos: o <select> precisa das opções). */
function applyControlled(el, late) {
  const tag = el.nodeName;
  let mask = 0;
  for (const name in late) {
    const value = late[name];
    if (name === 'value') {
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        mask |= P_VALUE;
        if (tag === 'SELECT' && Array.isArray(value)) {
          const wanted = new Set(value.map(String));
          const options = el.options;
          for (let i = 0; i < options.length; i++) options[i].selected = wanted.has(options[i].value);
        } else {
          assignValue(el, value == null || value === false ? '' : String(value));
        }
      } else if (value != null && value !== false) {
        // <option>, <li>, <progress>, <button>…: a propriedade só espelha o atributo
        if ('value' in el) el.value = value;
        else setAttr(el, 'value', value);
      }
    } else if (name in el) {
      mask |= CONTROLLED_BIT[name];
      el[name] = !!value;
    } else {
      setAttr(el, name, value);
    }
  }
  if (mask !== 0) record(el).props |= mask;
}

/** Acrescenta um filho (qualquer formato aceito) e devolve quantos nós entraram. */
function append(parent, child) {
  if (child == null || child === false || child === true) return 0;
  const type = typeof child;
  if (type === 'string') {
    if (child === '') return 0;
    parent.appendChild(document.createTextNode(child));
    return 1;
  }
  if (type === 'object') {
    if (Array.isArray(child)) {
      let size = 0;
      for (let i = 0; i < child.length; i++) size += append(parent, child[i]);
      return size;
    }
    const nodeType = child.nodeType;
    if (typeof nodeType === 'number') {
      let size = 1;
      if (nodeType === 1) size = child.__n || 1;
      else if (nodeType === 11) size = child.__n || child.childNodes.length;
      parent.appendChild(child);
      return size;
    }
    if (typeof child[Symbol.iterator] === 'function') {
      let size = 0;
      for (const item of Array.from(child)) size += append(parent, item);
      return size;
    }
  }
  parent.appendChild(document.createTextNode(String(child)));
  return 1;
}

function build(el, props, children) {
  let size = 1;
  let rec = null;
  let late = null;
  if (isPlainProps(props)) {
    for (const key in props) {
      const value = props[key];
      switch (key) {
        case 'class':
        case 'className': {
          const cls = cx(value);
          if (cls) el.setAttribute('class', cls);
          break;
        }
        case 'style':
          applyStyle(el, value);
          break;
        case 'dataset':
          applyDataset(el, value);
          break;
        case 'key':
          if (value != null && value !== false && value !== '') el.setAttribute('data-key', String(value));
          break;
        case 'ref':
          if (typeof value === 'function') (rec || (rec = record(el))).ref = value;
          break;
        case 'html':
          break; // innerHTML não é aceito (proteção contra XSS): ícones e marcação são montados com h()/s()
        case 'value':
        case 'checked':
        case 'selected':
        case 'indeterminate':
          (late || (late = {}))[key] = value;
          break;
        case 'htmlFor':
          setAttr(el, 'for', value);
          break;
        default:
          if (typeof value === 'function') {
            // on<evento>: vira propriedade do DOM e fica anotado para o morph copiar
            if (key.length > 2 && key.charCodeAt(0) === 111 /* o */ && key.charCodeAt(1) === 110 /* n */) {
              const name = key.toLowerCase();
              if (rec === null) rec = record(el);
              (rec.on || (rec.on = {}))[name] = value;
              bindHandler(el, name, value);
            }
          } else {
            setAttr(el, key, value);
          }
      }
    }
  } else if (props !== undefined) {
    size += append(el, props); // sem props: o segundo argumento já é um filho
  }
  for (let i = 0; i < children.length; i++) size += append(el, children[i]);
  if (late !== null) {
    applyControlled(el, late);
    rec = el.__h || null;
  }
  if (size > 1) el.__n = size;
  if (rec !== null && rec.ref !== null) callRef(rec.ref, el);
  return el;
}

/**
 * Cria um elemento HTML.
 *
 * Props tratadas:
 *   - `class`: string | array | objeto (via cx); `style`: string | objeto (camelCase, `--variáveis`; número
 *     em propriedade de medida vira px);
 *   - `dataset`: objeto → atributos `data-*` (true → "true"; false/null/undefined → ausente);
 *   - `key`: string | número → atributo `data-key` (identidade do nó entre irmãos na reconciliação);
 *   - `on<evento>` em minúsculas (`onclick`, `oninput`, `onfocusout`…): função atribuída como propriedade
 *     do DOM (`el.onclick = fn`) e anotada em `el.__h.on`; eventos sem propriedade nativa (focusin/focusout)
 *     funcionam do mesmo jeito por um ouvinte interno;
 *   - `ref`: função(el) chamada logo após criar o elemento e de novo depois de cada mount/morph, sempre com
 *     o elemento vivo (na criação o elemento ainda está fora do documento);
 *   - `html`: IGNORADO (innerHTML não é usado em lugar nenhum: todo texto vira nó de texto);
 *   - `href`/`src`/`action`/`formaction`/`xlink:href`…: valores javascript:/data:/vbscript: (com truques de
 *     maiúsculas, espaços e entidades) são recusados; endereços de dados devem passar por safeHref()
 *     (core/safeurl.js). Exceção explícita: trustedUrl(…) para endereços gerados pelo próprio app;
 *   - `value` / `checked` / `selected` / `indeterminate`: propriedades do DOM. Basta a chave estar presente
 *     para o campo ser "controlado" (o morph passa a impor o valor); sem a chave, o que o usuário digitou
 *     é preservado. `value` funciona em input, textarea e select (array para seleção múltipla);
 *   - booleanos (`disabled`, `hidden`, `readonly`, `required`, `open`, `multiple`, `autofocus`…):
 *     true → atributo presente; false/null/undefined → ausente;
 *   - `draggable`, `spellcheck`, `contenteditable` e os estados ARIA verdadeiro/falso (`aria-expanded`,
 *     `aria-pressed`, `aria-selected`, `aria-checked`, `aria-hidden`, `aria-disabled`…): true/false viram
 *     "true"/"false". Nos demais `aria-*` (`aria-label`…) e em `data-*`, false não cria o atributo;
 *   - qualquer outra chave vira atributo (null/undefined/false → não define). `role` passa direto.
 *
 * Filhos: Node | string | número | arrays (achatados) | null/undefined/false/true (ignorados).
 * Se o segundo argumento não for um objeto simples, ele já é tratado como filho: `h('p', 'texto')`.
 *
 * @param {string} tag nome da tag (ex.: 'div')
 * @param {object|null} [props]
 * @param {...*} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  if (typeof tag !== 'string') throw new TypeError('h(): a tag precisa ser uma string');
  return build(document.createElement(tag), props, children);
}

/**
 * Cria um elemento SVG (namespace SVG). Mesmas props e filhos de h(); os atributos são definidos com
 * setAttribute preservando maiúsculas/minúsculas (`viewBox`, `strokeLinecap` não: use `stroke-linecap`).
 * `xlink:href` e `xml:*` recebem o namespace correto.
 * @param {string} tag nome da tag SVG (ex.: 'svg', 'path', 'g')
 * @param {object|null} [props]
 * @param {...*} children
 * @returns {SVGElement}
 */
export function s(tag, props, ...children) {
  if (typeof tag !== 'string') throw new TypeError('s(): a tag precisa ser uma string');
  return build(document.createElementNS(SVG_NS, tag), props, children);
}

/**
 * Agrupa filhos num DocumentFragment (útil para devolver vários nós sem um elemento em volta).
 * Aceita os mesmos formatos de filho de h().
 * @param {...*} children
 * @returns {DocumentFragment}
 */
export function frag(...children) {
  const fragment = document.createDocumentFragment();
  let size = 0;
  for (let i = 0; i < children.length; i++) size += append(fragment, children[i]);
  fragment.__n = size;
  return fragment;
}

// ---------------------------------------------------------------------------
// morph
// ---------------------------------------------------------------------------

/** Elemento com foco quando o morph em curso começou (o usuário pode estar digitando nele). */
let focused = null;
/** A árvore nova usa o atributo data-morph em algum lugar? (evita consultas quando ninguém usa) */
let modes = false;

function activeElementOf(node) {
  const doc = node.ownerDocument || (node.nodeType === 9 ? node : null);
  let active = doc ? doc.activeElement : null;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  return active || null;
}

function hasMorphAttr(node) {
  if (node.nodeType === 1 && node.hasAttribute('data-morph')) return true;
  return node.firstElementChild !== null && node.querySelector('[data-morph]') !== null;
}

function isTextEntry(el) {
  const tag = el.nodeName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(el.type);
  return el.isContentEditable === true;
}

/** O usuário está digitando em `t`? (tem o foco, é campo de texto e o render novo não pediu data-controlled) */
function isTyping(t, n) {
  return t === focused && isTextEntry(t) && !n.hasAttribute('data-controlled');
}

/** Mesma identidade: mesmo tipo de nó, mesmo nome e mesma data-key (e o novo não pede data-morph="replace"). */
function same(o, n) {
  const type = o.nodeType;
  if (type !== n.nodeType || o.nodeName !== n.nodeName) return false;
  if (type !== 1) return true;
  if (o.getAttribute('data-key') !== n.getAttribute('data-key')) return false;
  return !(modes && n.getAttribute('data-morph') === 'replace');
}

/** Chama os ref() de uma subárvore que acabou de entrar no DOM vivo (filhos antes dos pais). */
function runRefs(node) {
  if (node.nodeType !== 1) return;
  let child = node.firstElementChild;
  while (child !== null) {
    const next = child.nextElementSibling;
    runRefs(child);
    child = next;
  }
  const rec = node.__h;
  if (rec !== undefined && rec.ref !== null) callRef(rec.ref, node);
}

function writeStyle(el, text) {
  const style = el.style;
  if (style) {
    style.cssText = text; // via CSSOM: funciona mesmo com Content-Security-Policy restritiva
    if (el.getAttribute('style') === text) return;
  }
  el.setAttribute('style', text);
}

function syncAttributes(t, n, typing) {
  const next = n.attributes;
  const count = next.length;
  let skipped = false;
  for (let i = 0; i < count; i++) {
    const attr = next[i];
    const name = attr.name;
    const value = attr.value;
    const ns = attr.namespaceURI;
    if (ns !== null) {
      if (t.getAttributeNS(ns, attr.localName) !== value) t.setAttributeNS(ns, name, value);
    } else if (t.getAttribute(name) !== value) {
      if (name === 'style') writeStyle(t, value);
      else if (typing && name === 'value') skipped = true;
      else t.setAttribute(name, value);
    }
  }
  const current = t.attributes;
  // t já contém todos os de n (se nada foi pulado): tamanhos iguais = conjuntos iguais
  if (!skipped && current.length === count) return;
  for (let i = current.length - 1; i >= 0; i--) {
    const attr = current[i];
    const ns = attr.namespaceURI;
    if (ns !== null) {
      if (!n.hasAttributeNS(ns, attr.localName)) t.removeAttributeNS(ns, attr.localName);
    } else {
      const name = attr.name;
      if (!n.hasAttribute(name) && !(typing && name === 'value')) t.removeAttribute(name);
    }
  }
}

/** Copia os tratadores de evento e passa o registro do nó novo para o nó vivo. Devolve o registro (ou undefined). */
function syncRecord(t, n) {
  const nr = n.__h;
  const tr = t.__h;
  if (nr === undefined && tr === undefined) return undefined;
  const nOn = nr !== undefined ? nr.on : null;
  const tOn = tr !== undefined ? tr.on : null;
  if (nOn !== null) {
    for (const name in nOn) {
      const fn = nOn[name];
      if (tOn === null || tOn[name] !== fn) bindHandler(t, name, fn);
    }
  }
  if (tOn !== null) {
    for (const name in tOn) {
      if (nOn === null || !(name in nOn)) bindHandler(t, name, null); // tratador que sumiu
    }
  }
  t.__h = nr;
  return nr;
}

/**
 * Estado de seleção de um <select> "controlado" (value no select ou selected em alguma opção);
 * null quando o render não opina. Índice para seleção simples, lista de booleanos para múltipla.
 */
function readSelection(select) {
  const rec = select.__h;
  let controlled = rec !== undefined && (rec.props & P_VALUE) !== 0;
  const options = select.options;
  const total = options.length;
  for (let i = 0; !controlled && i < total; i++) {
    const r = options[i].__h;
    if (r !== undefined && (r.props & P_SELECTED) !== 0) controlled = true;
  }
  if (!controlled) return null;
  if (!select.multiple) return select.selectedIndex;
  const flags = new Array(total);
  for (let i = 0; i < total; i++) flags[i] = options[i].selected;
  return flags;
}

function writeSelection(select, selection) {
  if (typeof selection === 'number') {
    if (select.selectedIndex !== selection) select.selectedIndex = selection;
    return;
  }
  const options = select.options;
  const total = Math.min(options.length, selection.length);
  for (let i = 0; i < total; i++) {
    if (options[i].selected !== selection[i]) options[i].selected = selection[i];
  }
}

/** Escreve o valor num campo; se ele estiver com o foco (data-controlled), tenta manter o cursor onde estava. */
function writeValue(el, value) {
  if (el !== focused) {
    assignValue(el, value);
    return;
  }
  let start = null;
  let end = null;
  let atEnd = true;
  try {
    start = el.selectionStart;
    end = el.selectionEnd;
    atEnd = start === null || (start === end && end === el.value.length);
  } catch {
    /* tipo de campo sem seleção de texto */
  }
  assignValue(el, value);
  if (atEnd || start === null || end === null) return; // cursor no fim continua no fim (padrão do navegador)
  try {
    const max = el.value.length;
    el.setSelectionRange(Math.min(start, max), Math.min(end, max));
  } catch {
    /* tipo de campo sem seleção de texto */
  }
}

/** Impõe ao nó vivo as propriedades controladas do nó novo. `skipSelect`: o <select> já foi tratado à parte. */
function syncControlled(t, n, mask, skipSelect) {
  if ((mask & P_CHECKED) !== 0) {
    const v = n.checked;
    if (t.checked !== v) t.checked = v;
  }
  if ((mask & P_INDETERMINATE) !== 0) {
    const v = n.indeterminate;
    if (t.indeterminate !== v) t.indeterminate = v;
  }
  if ((mask & P_SELECTED) !== 0) {
    const v = n.selected;
    if (t.selected !== v) t.selected = v;
  }
  if ((mask & P_VALUE) !== 0) {
    if (t.nodeName === 'SELECT') {
      if (!skipSelect) {
        const selection = readSelection(n);
        if (selection !== null) writeSelection(t, selection);
      }
    } else {
      const v = n.value;
      if (t.value !== v && !isTyping(t, n)) writeValue(t, v); // nunca atropela quem está digitando
    }
  }
}

/**
 * Caminho leve: `t` e `n` têm DOM idêntico (isEqualNode) e nenhum data-morph por dentro.
 * Só falta copiar o que o DOM não mostra: tratadores de evento, ref e propriedades controladas.
 */
function syncState(t, n) {
  const rec = syncRecord(t, n);
  let tc = t.firstElementChild;
  if (tc !== null) {
    let nc = n.firstElementChild;
    while (tc !== null && nc !== null) {
      const tNext = tc.nextElementSibling;
      const nNext = nc.nextElementSibling;
      syncState(tc, nc);
      tc = tNext;
      nc = nNext;
    }
  }
  if (rec !== undefined) {
    if (rec.props !== 0) syncControlled(t, n, rec.props, false);
    if (rec.ref !== null) callRef(rec.ref, t);
  }
}

function patchElement(t, n) {
  // Atalho: subárvore pequena com DOM idêntico → comparação nativa de uma vez só, depois o caminho leve.
  const size = n.__n;
  if ((size === undefined || size <= EQUAL_LIMIT) && t.isEqualNode(n) && !(modes && hasMorphAttr(n))) {
    syncState(t, n);
    return;
  }
  const typing = isTyping(t, n);
  syncAttributes(t, n, typing);
  const rec = syncRecord(t, n);
  const skip = modes && n.getAttribute('data-morph') === 'skip';
  // O estado do <select> novo é lido ANTES de reconciliar os filhos (opções novas mudam de árvore).
  const selection = t.nodeName === 'SELECT' ? readSelection(n) : null;
  // data-morph="skip": filhos são de quem gerencia o widget. Digitando (textarea/contenteditable): filhos são o texto do usuário.
  if (!skip && !typing) patchChildren(t, n);
  if (selection !== null) writeSelection(t, selection);
  if (rec !== undefined) {
    if (rec.props !== 0) syncControlled(t, n, rec.props, true);
    if (rec.ref !== null) callRef(rec.ref, t);
  }
}

function patchNode(t, n) {
  const type = t.nodeType;
  if (type === 1) {
    patchElement(t, n);
  } else if (type === 3 || type === 8) {
    const text = n.nodeValue;
    if (t.nodeValue !== text) t.nodeValue = text;
  } else if (type === 11) {
    patchChildren(t, n);
  }
}

function detach(parent, node) {
  if (node.parentNode === parent) parent.removeChild(node);
}

/** Muda de posição um filho que já está em `parent`, preservando o estado (foco, animações) quando o navegador permite. */
function moveChild(parent, node, anchor) {
  if (typeof parent.moveBefore === 'function') {
    try {
      parent.moveBefore(node, anchor);
      return;
    } catch {
      /* movimento sem preservação de estado indisponível aqui: usa o insertBefore */
    }
  }
  parent.insertBefore(node, anchor);
}

/**
 * Maior subsequência crescente de `source` (ignorando os -1).
 * Devolve um Uint8Array marcando com 1 as posições que fazem parte dela — são os nós que NÃO precisam se mover.
 */
function longestIncreasing(source) {
  const count = source.length;
  const previous = new Int32Array(count);
  const tails = [];
  for (let j = 0; j < count; j++) {
    const value = source[j];
    if (value < 0) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (source[tails[mid]] < value) lo = mid + 1;
      else hi = mid;
    }
    previous[j] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = j;
  }
  const keep = new Uint8Array(count);
  let k = tails.length > 0 ? tails[tails.length - 1] : -1;
  while (k >= 0) {
    keep[k] = 1;
    k = previous[k];
  }
  return keep;
}

/**
 * Caso geral da reconciliação dos filhos, a partir do primeiro par que não bateu.
 *   - com chave (data-key): casa pelo par nodeName + chave entre os irmãos;
 *   - sem chave: casa, em ordem, com o próximo irmão antigo sem chave, ainda livre, de mesmo nodeName;
 *   - antigos sem par são removidos; novos sem par são inseridos;
 *   - só mudam de lugar os nós fora da maior subsequência já ordenada (mínimo de movimentos).
 */
function reconcile(parent, oldFirst, newFirst) {
  const olds = [];
  for (let node = oldFirst; node !== null; node = node.nextSibling) olds.push(node);
  const news = [];
  for (let node = newFirst; node !== null; node = node.nextSibling) news.push(node);
  let oldEnd = olds.length - 1;
  let newEnd = news.length - 1;

  // Sufixo comum. Só para nós com chave: para os sem chave vale estritamente a ordem da fila (acima).
  while (oldEnd >= 0 && newEnd >= 0) {
    const o = olds[oldEnd];
    const n = news[newEnd];
    if (n.nodeType !== 1 || n.getAttribute('data-key') === null || !same(o, n)) break;
    patchNode(o, n);
    oldEnd--;
    newEnd--;
  }
  const tail = oldEnd + 1 < olds.length ? olds[oldEnd + 1] : null; // primeiro nó já posicionado depois do miolo

  if (newEnd < 0) {
    for (let i = 0; i <= oldEnd; i++) detach(parent, olds[i]);
    return;
  }
  if (oldEnd < 0) {
    for (let j = 0; j <= newEnd; j++) parent.insertBefore(news[j], tail);
    for (let j = 0; j <= newEnd; j++) runRefs(news[j]);
    return;
  }

  // Índice dos antigos
  const byKey = new Map();
  const queues = new Map();
  for (let i = 0; i <= oldEnd; i++) {
    const node = olds[i];
    const key = node.nodeType === 1 ? node.getAttribute('data-key') : null;
    if (key !== null) {
      const id = `${node.nodeName}\u0000${key}`;
      if (!byKey.has(id)) byKey.set(id, i); // chave repetida: vale a primeira; as demais sobram e são removidas
    } else {
      const queue = queues.get(node.nodeName);
      if (queue === undefined) queues.set(node.nodeName, { list: [i], next: 0 });
      else queue.list.push(i);
    }
  }

  // Par de cada nó novo: source[j] = índice em olds, ou -1 quando o nó é realmente novo
  const count = newEnd + 1;
  const source = new Int32Array(count);
  const used = new Uint8Array(oldEnd + 1);
  let inOrder = true;
  let last = -1;
  for (let j = 0; j < count; j++) {
    const node = news[j];
    let found = -1;
    const isElement = node.nodeType === 1;
    if (!(isElement && modes && node.getAttribute('data-morph') === 'replace')) {
      const key = isElement ? node.getAttribute('data-key') : null;
      if (key !== null) {
        const hit = byKey.get(`${node.nodeName}\u0000${key}`);
        if (hit !== undefined && used[hit] === 0) found = hit;
      } else {
        const queue = queues.get(node.nodeName);
        if (queue !== undefined && queue.next < queue.list.length) found = queue.list[queue.next++];
      }
    }
    source[j] = found;
    if (found >= 0) {
      used[found] = 1;
      if (found < last) inOrder = false;
      else last = found;
    }
  }

  for (let i = 0; i <= oldEnd; i++) {
    if (used[i] === 0) detach(parent, olds[i]);
  }
  // Atualiza todos os pares ANTES de qualquer nó novo sair da árvore nova (o estado dela ainda é lido aqui).
  for (let j = 0; j < count; j++) {
    if (source[j] >= 0) patchNode(olds[source[j]], news[j]);
  }

  // Posiciona de trás para frente: cada nó entra logo antes do seu sucessor definitivo.
  const keep = inOrder ? null : longestIncreasing(source);
  let anchor = tail;
  for (let j = count - 1; j >= 0; j--) {
    const from = source[j];
    let node;
    if (from < 0) {
      node = news[j];
      parent.insertBefore(node, anchor);
    } else {
      node = olds[from];
      if (keep !== null && keep[j] === 0 && node.nextSibling !== anchor) moveChild(parent, node, anchor);
    }
    anchor = node;
  }
  for (let j = 0; j < count; j++) {
    if (source[j] < 0) runRefs(news[j]);
  }
}

function patchChildren(parent, source) {
  let o = parent.firstChild;
  let n = source.firstChild;
  // Prefixo comum: enquanto os pares na mesma posição forem "o mesmo nó", atualiza no lugar.
  while (o !== null && n !== null && same(o, n)) {
    const oNext = o.nextSibling;
    const nNext = n.nextSibling;
    patchNode(o, n);
    o = oNext;
    n = nNext;
  }
  if (n === null) {
    while (o !== null) {
      const next = o.nextSibling;
      detach(parent, o);
      o = next;
    }
    return;
  }
  if (o === null) {
    const added = [];
    while (n !== null) {
      const next = n.nextSibling;
      parent.appendChild(n);
      added.push(n);
      n = next;
    }
    for (let i = 0; i < added.length; i++) runRefs(added[i]);
    return;
  }
  reconcile(parent, o, n);
}

/**
 * Atualiza `target` no lugar para ficar igual a `next`, tocando só no que mudou.
 *
 * Regras:
 *   - Dois nós são "o mesmo nó" quando nodeType, nodeName e o atributo data-key são iguais (os dois sem
 *     chave também conta). Senão o nó antigo é trocado pelo novo.
 *   - Texto: nodeValue só é escrito quando difere.
 *   - Elementos: sincroniza atributos (remove os que sumiram), tratadores de evento (os que sumiram são
 *     desligados), ref (chamado de novo com o elemento vivo) e as propriedades controladas
 *     value/checked/selected/indeterminate.
 *   - NUNCA sobrescreve o valor/a seleção do campo de texto que está com o foco (input de texto, textarea,
 *     contenteditable) — o usuário está digitando. Exceção: quando `next` traz o atributo data-controlled.
 *   - Filhos com chave são casados pela chave e só mudam de lugar quando necessário (mínimo de movimentos);
 *     filhos sem chave são casados em ordem com o próximo irmão antigo sem chave de mesmo nodeName; o que
 *     sobra é removido.
 *   - data-morph="skip" (no nó novo): sincroniza o próprio elemento e deixa os filhos intactos (widgets
 *     gerenciados à mão). data-morph="replace" (no nó novo): o nó é sempre trocado.
 *   - Subárvores SVG funcionam (namespaces preservados).
 *
 * `next` é consumido: seus nós são movidos para dentro de `target` ou descartados — não o reutilize.
 *
 * @param {Node} target nó vivo (elemento, texto, comentário ou fragmento)
 * @param {Node} next   nó recém-criado com o estado desejado
 * @returns {Node} o nó vivo: `target`, ou `next` quando a raiz precisou ser trocada
 */
export function morph(target, next) {
  if (!isNode(target) || !isNode(next)) throw new TypeError('morph(alvo, novo): os dois argumentos precisam ser nós do DOM');
  if (target === next) return target;
  if (next.nodeType === 11 && target.nodeType !== 11) {
    throw new TypeError('morph(): não dá para transformar um nó num fragmento; use um único nó raiz');
  }
  const previousFocused = focused;
  const previousModes = modes;
  focused = activeElementOf(target);
  modes = next.nodeType === 1 || next.nodeType === 11 ? hasMorphAttr(next) : false;
  try {
    if (!same(target, next)) {
      const parent = target.parentNode;
      if (parent !== null) parent.replaceChild(next, target);
      runRefs(next);
      return next;
    }
    patchNode(target, next);
    return target;
  } finally {
    focused = previousFocused;
    modes = previousModes;
  }
}

// ---------------------------------------------------------------------------
// mount
// ---------------------------------------------------------------------------

/** Converte o que o render devolveu num único nó raiz. */
function toRoot(value) {
  if (isNode(value)) {
    if (value.nodeType !== 11) return value;
    const total = value.childNodes.length;
    if (total === 1) return value.firstChild;
    if (total === 0) return document.createComment('');
    throw new TypeError(`mount(): render() precisa devolver um único nó raiz (o fragmento tem ${total} nós)`);
  }
  if (value == null || value === false || value === true || value === '') return document.createComment('');
  if (typeof value === 'string' || typeof value === 'number') return document.createTextNode(String(value));
  if (Array.isArray(value)) return toRoot(frag(value));
  throw new TypeError('mount(): render() devolveu um valor que não é um nó do DOM');
}

/**
 * Liga uma função de renderização a um contêiner.
 *
 *   const view = mount(document.querySelector('#app'), () => h('div', null, estado.texto));
 *   view.update();     // primeira vez: chama render() e acrescenta o resultado ao contêiner
 *   view.schedule();   // pede uma atualização no próximo quadro (várias chamadas = uma atualização)
 *
 * - `update()` renderiza na hora: depois da primeira vez usa morph(raiz, render()). Cancela qualquer
 *   atualização agendada. Devolve a raiz viva. Chamado de dentro do próprio render/ref, apenas agenda.
 * - `schedule()` agrupa por requestAnimationFrame (com prazo de segurança se os quadros estiverem suspensos).
 * - Se render() lançar erro: console.error, o DOM anterior é mantido (a tela nunca fica em branco) e o erro
 *   fica disponível em `lastError()` até a próxima renderização bem-sucedida.
 * - `destroy()` remove a raiz do DOM e cancela o que estiver agendado; depois disso update/schedule não fazem nada.
 * - render() pode devolver um elemento, texto, null/false (vira um comentário vazio) ou um fragmento com um único nó.
 *
 * @param {Element|DocumentFragment} container onde a raiz é acrescentada (os filhos existentes não são tocados)
 * @param {() => (Node|string|number|null|false)} render função pura que devolve a árvore inteira
 * @returns {{ update: () => (Node|null), schedule: () => void, destroy: () => void, root: () => (Node|null), lastError: () => (unknown|null) }}
 */
export function mount(container, render) {
  if (!isNode(container)) throw new TypeError('mount(): o contêiner precisa ser um elemento do DOM');
  if (typeof render !== 'function') throw new TypeError('mount(): render precisa ser uma função');

  let root = null;
  let error = null;
  let frame = 0;
  let timer = 0;
  let destroyed = false;
  let rendering = false;
  let again = false;

  function cancel() {
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    if (timer !== 0) {
      clearTimeout(timer);
      timer = 0;
    }
  }

  function schedule() {
    if (destroyed || frame !== 0 || timer !== 0) return;
    frame = requestAnimationFrame(update);
    timer = setTimeout(update, FRAME_FALLBACK_MS);
  }

  function update() {
    if (destroyed) return null;
    cancel();
    if (rendering) {
      again = true; // pedido feito durante a própria renderização: roda depois, num novo quadro
      return root;
    }
    rendering = true;
    try {
      const next = toRoot(render());
      if (root === null) {
        container.appendChild(next);
        root = next;
        runRefs(root);
      } else {
        if (root.parentNode === null) container.appendChild(root); // alguém esvaziou o contêiner: recoloca
        root = morph(root, next);
      }
      error = null;
    } catch (err) {
      error = err === null || err === undefined ? new Error('render() lançou um valor vazio') : err;
      console.error('[dom] erro ao renderizar — a tela anterior foi mantida', err);
    } finally {
      rendering = false;
    }
    if (again) {
      again = false;
      schedule();
    }
    return root;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancel();
    if (root !== null && root.parentNode !== null) root.parentNode.removeChild(root);
    root = null;
  }

  return {
    update,
    schedule,
    destroy,
    root: () => root,
    lastError: () => error,
  };
}
