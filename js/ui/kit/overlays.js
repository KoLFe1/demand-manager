// Camadas flutuantes do kit: menus, popovers, diálogos e avisos (toasts).
//
// API IMPERATIVA: cada função abre uma camada e devolve como fechá-la. Tudo é montado dentro de um único
// <div id="overlay-root"> no fim do <body>, na ordem em que foi aberto (a de cima é a última).
//
// Regras comuns:
//   • Esc fecha a camada de cima; clicar fora fecha (a menos de `dismissible: false`);
//   • ao fechar, o foco volta para quem abriu;
//   • diálogos e popovers prendem o Tab dentro deles; diálogos travam a rolagem da página;
//   • no celular (até 640 px de largura) menus e popovers viram folhas inferiores e diálogos ocupam a tela;
//   • isOverlayOpen() diz se há alguma camada aberta (os atalhos de teclado se recolhem nesse caso).
//
// Exemplos vivos: dev/kit.html.

import { cx, h, morph } from '../../core/dom.js';
import { normalizeText } from '../../core/format.js';
import { button, field, textArea, textInput } from './controls.js';
import { icon as makeIcon } from './icons.js';

/** Largura até a qual a interface se comporta como celular (igual ao corte de css/base.css). */
export const MOBILE_MAX_WIDTH = 640;

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 4;
const TYPEAHEAD_RESET_MS = 700;
const MAX_TOASTS = 4;

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(', ');

/** Quem pede o foco inicial de uma camada: data-autofocus (controles do kit) ou o autofocus nativo. */
const AUTOFOCUS = '[data-autofocus]:not([disabled]), [autofocus]:not([disabled])';

/** Camadas abertas, de baixo para cima. */
const stack = [];
let root = null;
let toastHost = null;
let listening = false;
let uid = 0;
let repositionFrame = 0;
/** Elemento cujo próximo clique deve ser ignorado (clicar de novo em quem abriu só fecha). */
let suppressClickOn = null;
let suppressTimer = 0;

const nextId = (prefix) => `${prefix}-${++uid}`;

/**
 * A janela está na largura de celular? (menus e popovers viram folhas inferiores)
 * @returns {boolean}
 */
export function isMobileViewport() {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`).matches;
  } catch {
    return false;
  }
}

function ensureRoot() {
  if (root === null || !root.isConnected) {
    root = document.getElementById('overlay-root') || h('div', { id: 'overlay-root' });
    document.body.appendChild(root);
  }
  if (!listening) {
    listening = true;
    document.addEventListener('keydown', onDocumentKeydown);
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('click', onDocumentClickCapture, true);
    document.addEventListener('scroll', scheduleReposition, true);
    window.addEventListener('resize', scheduleReposition);
  }
  return root;
}

function focusables(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 || el === document.activeElement);
}

function focusFirst(container, fallback) {
  const marked = container.querySelector(AUTOFOCUS);
  const target = marked || focusables(container)[0] || fallback || container;
  if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  if (marked && typeof marked.select === 'function' && marked.matches('input[type="text"], input:not([type]), textarea')) marked.select();
}

function updateScrollLock() {
  const locked = stack.some((entry) => entry.lockScroll);
  document.documentElement.classList.toggle('has-overlay-lock', locked);
}

/**
 * Registra uma camada na pilha.
 * @returns {{ el: HTMLElement, content: HTMLElement, close: (reason?: any) => void, isOpen: () => boolean }}
 */
function pushLayer({ el, content, kind, anchor = null, dismissible = true, trapFocus = false, lockScroll = false, reposition = null, onclose }) {
  ensureRoot();
  const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const entry = { el, content, kind, anchor, dismissible, trapFocus, lockScroll, reposition, opener, open: true };

  entry.close = (reason) => {
    if (!entry.open) return;
    // Camadas abertas por cima desta (um menu dentro de um diálogo) fecham primeiro.
    const index = stack.indexOf(entry);
    if (index >= 0) {
      for (let i = stack.length - 1; i > index; i--) stack[i].close('parent');
    }
    entry.open = false;
    const at = stack.indexOf(entry);
    if (at >= 0) stack.splice(at, 1);
    const active = document.activeElement;
    const hadFocus = active === null || active === document.body || el.contains(active);
    el.remove();
    updateScrollLock();
    if (hadFocus && entry.opener && entry.opener.isConnected) entry.opener.focus({ preventScroll: true });
    if (typeof onclose === 'function') {
      try {
        onclose(reason);
      } catch (err) {
        console.error('[kit] erro em onclose', err);
      }
    }
  };
  entry.isOpen = () => entry.open;

  stack.push(entry);
  root.insertBefore(el, toastHost && toastHost.parentNode === root ? toastHost : null);
  updateScrollLock();
  return entry;
}

function topEntry() {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

function onDocumentKeydown(ev) {
  const top = topEntry();
  if (top === null) return;
  if (ev.key === 'Escape') {
    if (ev.defaultPrevented) return; // um campo interno já tratou (ex.: cancelar edição no lugar)
    ev.preventDefault();
    ev.stopPropagation();
    if (top.dismissible) top.close('escape');
    return;
  }
  if (ev.key === 'Tab' && top.trapFocus) {
    const items = focusables(top.content);
    if (items.length === 0) {
      ev.preventDefault();
      top.content.focus({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!top.content.contains(active)) {
      ev.preventDefault();
      first.focus();
    } else if (ev.shiftKey && (active === first || active === top.content)) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  }
}

function onDocumentPointerDown(ev) {
  if (stack.length === 0) return;
  const target = ev.target;
  if (!(target instanceof Node)) return;
  if (toastHost !== null && toastHost.contains(target)) return; // avisos não contam como "fora"
  for (let i = stack.length - 1; i >= 0; i--) {
    const entry = stack[i];
    if (entry.content.contains(target)) return;
    if (!entry.dismissible) return;
    const anchor = entry.anchor instanceof Element ? entry.anchor : null;
    if (anchor !== null && anchor.contains(target)) {
      // Clicou de novo em quem abriu: fecha e engole o clique (senão o botão reabriria na hora).
      suppressClickOn = anchor;
      clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => {
        suppressClickOn = null;
      }, 600);
    }
    entry.close('outside');
  }
}

function onDocumentClickCapture(ev) {
  if (suppressClickOn === null) return;
  const anchor = suppressClickOn;
  suppressClickOn = null;
  clearTimeout(suppressTimer);
  if (ev.target instanceof Node && anchor.contains(ev.target)) {
    ev.preventDefault();
    ev.stopPropagation();
  }
}

function scheduleReposition(ev) {
  if (stack.length === 0 || repositionFrame !== 0) return;
  if (ev && ev.target instanceof Node && root !== null && root.contains(ev.target)) return; // rolagem dentro da própria camada
  repositionFrame = requestAnimationFrame(() => {
    repositionFrame = 0;
    for (const entry of stack) {
      if (typeof entry.reposition === 'function') entry.reposition();
    }
  });
}

// ---------------------------------------------------------------------------
// Posicionamento
// ---------------------------------------------------------------------------

/**
 * Calcula onde colocar uma camada ancorada para que ela fique inteira dentro da janela.
 *
 *   computePosition({ left: 100, top: 40, right: 180, bottom: 68 }, { width: 220, height: 300 },
 *                   { width: 1280, height: 720 }, 'bottom-start')
 *   → { left: 100, top: 72, maxHeight: 640, placement: 'bottom-start' }
 *
 * Tenta o lado pedido; se não couber, vira para o lado oposto; se não couber em nenhum, usa o lado com mais
 * espaço e limita a altura (`maxHeight`). Na horizontal, desliza para não sair da janela.
 *
 * @param {{ left: number, top: number, right: number, bottom: number }} anchor retângulo da âncora (coordenadas da janela)
 * @param {{ width: number, height: number }} size tamanho natural da camada
 * @param {{ width: number, height: number }} viewport tamanho da janela
 * @param {'bottom-start'|'bottom-end'|'top-start'|'top-end'|'right-start'|'left-start'} [placement='bottom-start']
 * @param {{ gap?: number, margin?: number }} [options]
 * @returns {{ left: number, top: number, maxHeight: number, placement: string }}
 */
export function computePosition(anchor, size, viewport, placement = 'bottom-start', { gap = ANCHOR_GAP, margin = VIEWPORT_MARGIN } = {}) {
  const [side, align = 'start'] = String(placement).split('-');
  const vw = viewport.width;
  const vh = viewport.height;
  const clamp = (value, min, max) => (max < min ? min : Math.min(max, Math.max(min, value)));
  let left;
  let top;
  let maxHeight = Math.max(80, vh - margin * 2);
  let finalSide = side;

  if (side === 'left' || side === 'right') {
    const spaceRight = vw - margin - (anchor.right + gap);
    const spaceLeft = anchor.left - gap - margin;
    if (side === 'right' ? size.width > spaceRight && spaceLeft > spaceRight : size.width <= spaceLeft || spaceLeft >= spaceRight) finalSide = 'left';
    else finalSide = 'right';
    left = finalSide === 'right' ? anchor.right + gap : anchor.left - gap - size.width;
    left = clamp(left, margin, vw - margin - size.width);
    top = clamp(anchor.top, margin, vh - margin - Math.min(size.height, maxHeight));
  } else {
    const spaceBelow = vh - margin - (anchor.bottom + gap);
    const spaceAbove = anchor.top - gap - margin;
    const wantsTop = side === 'top';
    if (wantsTop) finalSide = size.height <= spaceAbove || spaceAbove >= spaceBelow ? 'top' : 'bottom';
    else finalSide = size.height <= spaceBelow || spaceBelow >= spaceAbove ? 'bottom' : 'top';
    const space = Math.max(80, finalSide === 'bottom' ? spaceBelow : spaceAbove);
    maxHeight = Math.min(maxHeight, space);
    const height = Math.min(size.height, maxHeight);
    top = finalSide === 'bottom' ? anchor.bottom + gap : anchor.top - gap - height;
    top = clamp(top, margin, vh - margin - height);
    left = align === 'end' ? anchor.right - size.width : anchor.left;
    left = clamp(left, margin, vw - margin - size.width);
  }
  return { left: Math.round(left), top: Math.round(top), maxHeight: Math.floor(maxHeight), placement: `${finalSide}-${align}` };
}

function anchorRect(anchor) {
  if (anchor instanceof Element) {
    const rect = anchor.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }
  const x = anchor && Number.isFinite(anchor.x) ? anchor.x : window.innerWidth / 2;
  const y = anchor && Number.isFinite(anchor.y) ? anchor.y : window.innerHeight / 3;
  return { left: x, top: y, right: x, bottom: y };
}

/** Posiciona `surface` junto à âncora (não faz nada no modo folha, que é posicionado pelo CSS). */
function placeSurface(surface, anchor, placement) {
  surface.style.maxHeight = '';
  surface.style.left = '0px';
  surface.style.top = '0px';
  const rect = surface.getBoundingClientRect();
  const viewport = { width: document.documentElement.clientWidth || window.innerWidth, height: window.innerHeight };
  const pos = computePosition(anchorRect(anchor), { width: rect.width, height: rect.height }, viewport, placement);
  surface.style.left = `${pos.left}px`;
  surface.style.top = `${pos.top}px`;
  surface.style.maxHeight = `${pos.maxHeight}px`;
  surface.dataset.placement = pos.placement;
}

/** Cria a camada ancorada (ou a folha inferior no celular) em volta de `surface`. */
function anchoredLayer(surface, { anchor, placement, kind, onclose, trapFocus, sheet }) {
  const asSheet = sheet === undefined ? isMobileViewport() : !!sheet;
  surface.classList.toggle('is-sheet', asSheet);
  const el = h('div', { class: cx('overlay', asSheet ? 'overlay-sheet' : 'overlay-anchored'), 'data-kind': kind }, surface);
  const reposition = asSheet
    ? null
    : () => {
        if (anchor instanceof Element && !anchor.isConnected) return; // a âncora sumiu num re-render: fica onde está
        placeSurface(surface, anchor, placement);
      };
  const entry = pushLayer({ el, content: surface, kind, anchor, trapFocus, lockScroll: asSheet, reposition, onclose });
  if (reposition) reposition();
  return entry;
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function menuIcon(value) {
  if (value == null || value === false || value === '') return null;
  return typeof value === 'string' ? makeIcon(value, { size: 14 }) : value;
}

/**
 * Abre um menu de ações.
 *
 *   const close = openMenu(ev.currentTarget, [
 *     { label: 'Abrir', icon: 'external', kbd: 'Enter', onclick: abrir },
 *     { label: 'Duplicar', icon: 'copy', onclick: duplicar },
 *     { separator: true },
 *     { heading: 'Zona de perigo' },
 *     { label: 'Excluir', icon: 'trash', danger: true, onclick: excluir },
 *   ]);
 *   openMenu({ x: ev.clientX, y: ev.clientY }, itens)            // menu de contexto na posição do mouse
 *   openMenu(botao, itens, { searchable: true, title: 'Mover para…', align: 'end' })
 *
 * Teclado: ↑ ↓ Home End, Enter/Espaço para escolher, digitar para pular até o item (ou filtrar, com
 * `searchable`), Esc/Tab fecham. O menu vira para cima / desliza para não sair da janela; no celular abre
 * como folha inferior. Ao escolher, o menu fecha ANTES de chamar o `onclick` do item.
 *
 * @param {Element|{ x: number, y: number }} anchor elemento âncora ou ponto da janela
 * @param {Array<object>} items cada item é
 *   `{ label, icon?, kbd?, checked?, danger?, disabled?, hint?, description?, onclick?, class? }`,
 *   `{ separator: true }` ou `{ heading: 'texto' }`. `icon` aceita nome ou nó; `checked` (booleano) mostra a
 *   marca de seleção; `hint` é um texto curto à direita; `description`, uma segunda linha.
 * @param {object} [options]
 * @param {'start'|'end'} [options.align='start'] alinha o menu à esquerda ou à direita da âncora
 * @param {string} [options.title] título (aparece no topo; sempre visível na folha do celular)
 * @param {boolean} [options.searchable] campo de busca no topo (filtra sem diferenciar acentos)
 * @param {number} [options.minWidth] largura mínima em px
 * @param {(reason: 'select'|'escape'|'outside'|'tab'|'api'|'parent') => void} [options.onclose]
 * @param {string|Array|object} [options.class]
 * @returns {() => void} função que fecha o menu
 */
export function openMenu(anchor, items, { align = 'start', title, searchable = false, minWidth, onclose, class: className } = {}) {
  const all = (Array.isArray(items) ? items : []).filter((item) => item && typeof item === 'object');
  const hasChecks = all.some((item) => typeof item.checked === 'boolean');
  const menuId = nextId('menu');
  let visible = []; // itens acionáveis visíveis, na ordem: { item, el }
  let active = -1;
  let typed = '';
  let typedAt = 0;
  let entry = null;

  const list = h('div', { class: 'menu-list', role: 'presentation' });
  const searchField = searchable
    ? h('input', {
        class: 'menu-search-input',
        type: 'text',
        placeholder: 'Buscar…',
        'aria-label': 'Buscar no menu',
        autocomplete: 'off',
        spellcheck: false,
        oninput: () => renderList(),
      })
    : null;

  const menu = h(
    'div',
    {
      class: cx('menu', className),
      role: 'menu',
      tabindex: -1,
      'aria-label': title || 'Menu',
      style: Number.isFinite(minWidth) ? { minWidth: `${minWidth}px` } : null,
      onkeydown: onKeydown,
    },
    title ? h('div', { class: 'menu-title' }, title) : null,
    searchField ? h('div', { class: 'menu-search' }, makeIcon('search', { size: 14 }), searchField) : null,
    list,
  );

  function setActive(index, scroll) {
    if (active >= 0 && visible[active]) visible[active].el.classList.remove('is-active');
    active = index >= 0 && index < visible.length ? index : -1;
    const focusOwner = searchField || menu;
    if (active < 0) {
      focusOwner.removeAttribute('aria-activedescendant');
      return;
    }
    const el = visible[active].el;
    el.classList.add('is-active');
    focusOwner.setAttribute('aria-activedescendant', el.id);
    if (scroll && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }

  function choose(index, ev) {
    const hit = visible[index];
    if (!hit || hit.item.disabled) return;
    entry.close('select');
    if (typeof hit.item.onclick === 'function') hit.item.onclick(ev);
  }

  function renderList() {
    const query = searchField ? normalizeText(searchField.value) : '';
    const nodes = [];
    visible = [];
    let pendingSeparator = false;
    let pendingHeading = null;
    for (const item of all) {
      if (item.separator) {
        pendingSeparator = nodes.length > 0;
        continue;
      }
      if (item.heading != null) {
        pendingHeading = item;
        continue;
      }
      if (query && !normalizeText(`${item.label ?? ''} ${item.hint ?? ''} ${item.description ?? ''}`).includes(query)) continue;
      if (pendingSeparator) nodes.push(h('div', { class: 'menu-separator', role: 'separator' }));
      if (pendingHeading) nodes.push(h('div', { class: 'menu-heading', role: 'presentation' }, pendingHeading.heading));
      pendingSeparator = false;
      pendingHeading = null;
      const index = visible.length;
      const checkable = typeof item.checked === 'boolean';
      const el = h(
        'div',
        {
          class: cx('menu-item', item.danger && 'is-danger', item.disabled && 'is-disabled', item.checked && 'is-checked', item.class),
          id: `${menuId}-item-${index}`,
          role: checkable ? 'menuitemcheckbox' : 'menuitem',
          'aria-checked': checkable ? item.checked : null,
          'aria-disabled': item.disabled ? true : null,
          'data-index': index,
          onclick: (ev) => choose(index, ev),
          onpointermove: () => {
            if (active !== index && !item.disabled) setActive(index, false);
          },
        },
        hasChecks ? h('span', { class: 'menu-check', 'aria-hidden': 'true' }, item.checked ? makeIcon('check', { size: 14 }) : null) : null,
        item.icon ? h('span', { class: 'menu-icon', 'aria-hidden': 'true' }, menuIcon(item.icon)) : null,
        h('span', { class: 'menu-label' }, h('span', { class: 'menu-text' }, item.label), item.description ? h('span', { class: 'menu-desc' }, item.description) : null),
        item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null,
        item.kbd
          ? h(
              'span',
              { class: 'kbd-group menu-kbd', 'aria-hidden': 'true' },
              (Array.isArray(item.kbd) ? item.kbd : String(item.kbd).split('+')).map((key) => h('kbd', { class: 'kbd' }, String(key).trim())),
            )
          : null,
      );
      visible.push({ item, el });
      nodes.push(el);
    }
    if (visible.length === 0) nodes.push(h('div', { class: 'menu-empty' }, query ? 'Nada encontrado' : 'Sem opções'));
    list.replaceChildren(...nodes);
    active = -1;
    const preferred = visible.findIndex((hit) => hit.item.checked === true && !hit.item.disabled);
    setActive(preferred >= 0 ? preferred : visible.findIndex((hit) => !hit.item.disabled), true);
    if (entry && typeof entry.reposition === 'function') entry.reposition();
  }

  function move(delta) {
    const count = visible.length;
    if (count === 0) return;
    let index = active;
    for (let step = 0; step < count; step++) {
      index = (index + delta + count) % count;
      if (active < 0 && step === 0) index = delta > 0 ? 0 : count - 1;
      if (!visible[index].item.disabled) {
        setActive(index, true);
        return;
      }
    }
  }

  function edge(last) {
    const order = visible.map((_, index) => index);
    if (last) order.reverse();
    const index = order.find((i) => !visible[i].item.disabled);
    if (index !== undefined) setActive(index, true);
  }

  function typeAhead(char) {
    const now = performance.now();
    typed = now - typedAt > TYPEAHEAD_RESET_MS ? char : typed + char;
    typedAt = now;
    const needle = normalizeText(typed);
    const count = visible.length;
    // Mesma letra repetida percorre os itens que começam com ela; senão procura a partir do item atual.
    const single = needle.length > 1 && [...needle].every((ch) => ch === needle[0]) ? needle[0] : null;
    const start = single !== null || needle.length === 1 ? active + 1 : Math.max(active, 0);
    for (let step = 0; step < count; step++) {
      const index = (start + step + count) % count;
      const hit = visible[index];
      if (hit.item.disabled) continue;
      if (normalizeText(hit.item.label).startsWith(single !== null ? single : needle)) {
        setActive(index, true);
        return;
      }
    }
  }

  function onKeydown(ev) {
    if (ev.isComposing) return;
    const inSearch = ev.target === searchField;
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        ev.preventDefault();
        move(-1);
        return;
      case 'Home':
        if (inSearch) return;
        ev.preventDefault();
        edge(false);
        return;
      case 'End':
        if (inSearch) return;
        ev.preventDefault();
        edge(true);
        return;
      case 'PageDown':
        ev.preventDefault();
        edge(true);
        return;
      case 'PageUp':
        ev.preventDefault();
        edge(false);
        return;
      case 'Enter':
        ev.preventDefault();
        ev.stopPropagation();
        if (active >= 0) choose(active, ev);
        return;
      case ' ':
        if (inSearch) return;
        ev.preventDefault();
        if (active >= 0) choose(active, ev);
        return;
      case 'Tab':
        ev.preventDefault();
        entry.close('tab');
        return;
      default:
        break;
    }
    if (!inSearch && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      ev.preventDefault();
      ev.stopPropagation();
      typeAhead(ev.key);
    }
  }

  renderList();
  entry = anchoredLayer(menu, { anchor, placement: align === 'end' ? 'bottom-end' : 'bottom-start', kind: 'menu', onclose, trapFocus: false });
  if (active >= 0) visible[active].el.scrollIntoView({ block: 'nearest' });
  (searchField || menu).focus({ preventScroll: true });
  return () => entry.close('api');
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

/**
 * Abre um popover (caixa flutuante com conteúdo livre) ancorado a um elemento.
 *
 *   const pop = openPopover(botao, (close) => h('div', { class: 'p-3' }, 'Conteúdo', button({ label: 'OK', onclick: close })));
 *   pop.update();   // chama render de novo e aplica a diferença (morph) — o que o usuário digitou é preservado
 *   pop.close();
 *
 * @param {Element|{ x: number, y: number }} anchor
 * @param {(close: (reason?: any) => void) => Node} render devolve o conteúdo (um único nó raiz)
 * @param {object} [options]
 * @param {'bottom-start'|'bottom-end'|'top-start'|'top-end'|'right-start'|'left-start'} [options.placement='bottom-start']
 * @param {(reason: any) => void} [options.onclose] recebe o motivo ('escape', 'outside', 'api'…) ou o valor passado a close()
 * @param {string|Array|object} [options.class]
 * @param {number} [options.width] largura fixa em px (ignorada na folha do celular)
 * @param {string} [options.ariaLabel]
 * @returns {{ close: (reason?: any) => void, update: () => void, reposition: () => void, isOpen: () => boolean, el: HTMLElement }}
 *          `reposition()` recalcula a posição (use quando o conteúdo mudar de tamanho por conta própria)
 */
export function openPopover(anchor, render, { placement = 'bottom-start', onclose, class: className, width, ariaLabel } = {}) {
  let entry = null;
  const close = (reason = 'api') => {
    if (entry) entry.close(reason);
  };
  const surface = h('div', {
    class: cx('popover', className),
    role: 'dialog',
    tabindex: -1,
    'aria-label': ariaLabel || null,
    style: Number.isFinite(width) ? { width: `${width}px` } : null,
  });
  let content = render(close);
  if (content != null && content !== false) surface.append(content);
  entry = anchoredLayer(surface, { anchor, placement, kind: 'popover', onclose, trapFocus: true });
  focusFirst(surface, surface);
  return {
    close,
    update() {
      if (!entry.isOpen()) return;
      const next = render(close);
      if (content && content.parentNode === surface && next) content = morph(content, next);
      else {
        surface.replaceChildren(...(next ? [next] : []));
        content = next;
      }
      if (typeof entry.reposition === 'function') entry.reposition();
    },
    reposition() {
      if (entry.isOpen() && typeof entry.reposition === 'function') entry.reposition();
    },
    isOpen: () => entry.isOpen(),
    el: surface,
  };
}

// ---------------------------------------------------------------------------
// Diálogo (modal)
// ---------------------------------------------------------------------------

function toBodyNode(value) {
  if (value == null || value === false) return null;
  if (typeof value === 'string' || typeof value === 'number') return h('p', { class: 'modal-message' }, String(value));
  return value;
}

/**
 * Abre um diálogo modal (prende o foco, trava a rolagem da página, Esc fecha).
 *
 *   const dlg = openModal({
 *     title: 'Nova demanda',
 *     render: (close) => h('div', { class: 'col' }, field({ label: 'Nome' }, textInput({ autofocus: true, oninput }))),
 *     actions: [
 *       { label: 'Cancelar' },                                             // sem onclick: só fecha
 *       { label: 'Criar', variant: 'primary', onclick: (close) => { salvar(); close(true); } },
 *     ],
 *     onclose: (resultado) => …,     // o que foi passado a close(), ou 'escape' / 'outside' / 'close'
 *   });
 *   dlg.update();   // re-renderiza o corpo (render) e os botões com morph
 *
 * @param {object} options
 * @param {string|(() => string)} [options.title] texto fixo, ou função reavaliada em update()
 * @param {string|Node} [options.body] conteúdo fixo (texto vira um parágrafo)
 * @param {(close: (result?: any) => void) => Node} [options.render] conteúdo dinâmico (tem precedência sobre body)
 * @param {Array<{ label: string, variant?: string, icon?: string, onclick?: (close: Function, ev: MouseEvent) => void,
 *         autofocus?: boolean, disabled?: boolean }>|(() => Array)} [options.actions] botões do rodapé (ou função
 *         que os devolve — reavaliada em update())
 * @param {'sm'|'md'|'lg'} [options.size='sm'] 400 / 560 / 760 px
 * @param {(result: any) => void} [options.onclose]
 * @param {boolean} [options.dismissible=true] false = não fecha com Esc, clique fora nem mostra o "x"
 * @param {string|Array|object} [options.class]
 * @returns {{ close: (result?: any) => void, update: () => void, el: HTMLElement }}
 */
export function openModal({ title, body, render, actions, size = 'sm', onclose, dismissible = true, class: className } = {}) {
  let entry = null;
  const close = (result = 'api') => {
    if (entry) entry.close(result);
  };
  const titleId = nextId('modal-title');
  // Título fixo (texto) ou dinâmico (função reavaliada em update()).
  const titleText = () => {
    const value = typeof title === 'function' ? title() : title;
    return value == null || value === false ? '' : String(value);
  };
  const hasTitle = typeof title === 'function' || !!title;

  const renderBody = () => h('div', { class: 'modal-body' }, typeof render === 'function' ? render(close) : toBodyNode(body));
  const renderFooter = () => {
    const list = (typeof actions === 'function' ? actions() : actions) || [];
    const buttons = (Array.isArray(list) ? list : []).filter(Boolean);
    return h(
      'div',
      { class: 'modal-footer', hidden: buttons.length === 0 },
      buttons.map((action) =>
        button({
          label: action.label,
          icon: action.icon,
          variant: action.variant || 'default',
          disabled: action.disabled,
          attrs: { 'data-autofocus': action.autofocus ? true : null },
          onclick: (ev) => {
            if (typeof action.onclick === 'function') action.onclick(close, ev);
            else close(action.value === undefined ? 'action' : action.value);
          },
        }),
      ),
    );
  };

  let bodyEl = renderBody();
  let footerEl = renderFooter();
  const dialog = h(
    'div',
    {
      class: cx('modal', `modal-${size === 'md' || size === 'lg' ? size : 'sm'}`, className),
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': hasTitle ? titleId : null,
      'aria-label': hasTitle ? null : 'Diálogo',
      tabindex: -1,
    },
    hasTitle || dismissible
      ? h(
          'div',
          { class: 'modal-header' },
          h('h2', { class: 'modal-title', id: titleId }, titleText()),
          dismissible
            ? h('button', { type: 'button', class: 'btn btn-icon btn-ghost modal-close', title: 'Fechar', 'aria-label': 'Fechar', onclick: () => close('close') }, makeIcon('x', { size: 16 }))
            : null,
        )
      : null,
    bodyEl,
    footerEl,
  );
  const el = h('div', { class: 'overlay overlay-modal', 'data-kind': 'modal' }, dialog);
  entry = pushLayer({ el, content: dialog, kind: 'modal', dismissible, trapFocus: true, lockScroll: true, onclose });

  // Foco inicial: [autofocus] do corpo → primeiro campo do corpo → botão marcado/primário → o diálogo.
  const inBody = bodyEl.querySelector(AUTOFOCUS) || focusables(bodyEl)[0];
  if (inBody) {
    focusFirst(bodyEl);
  } else {
    const preferred =
      footerEl.querySelector(AUTOFOCUS) ||
      footerEl.querySelector('.btn-primary:not([disabled]), .btn-danger:not([disabled])') ||
      focusables(footerEl)[0] ||
      dialog;
    preferred.focus({ preventScroll: true });
  }

  return {
    close,
    update() {
      if (!entry.isOpen()) return;
      if (typeof title === 'function') {
        const titleEl = dialog.querySelector(`#${titleId}`);
        const text = titleText();
        if (titleEl && titleEl.textContent !== text) titleEl.textContent = text;
      }
      bodyEl = morph(bodyEl, renderBody());
      footerEl = morph(footerEl, renderFooter());
    },
    el: dialog,
  };
}

/**
 * Pede uma confirmação. Substitui o confirm() nativo.
 *
 *   if (await confirmDialog({ title: 'Excluir tarefa?', message: 'Ela vai para a lixeira.', confirmLabel: 'Excluir', danger: true })) { … }
 *
 * @param {object} options
 * @param {string} [options.title='Confirmar']
 * @param {string|Node} [options.message]
 * @param {string} [options.confirmLabel='Confirmar']
 * @param {string} [options.cancelLabel='Cancelar']
 * @param {boolean} [options.danger] botão de confirmação em vermelho
 * @returns {Promise<boolean>} true se confirmou; false se cancelou, fechou ou apertou Esc
 */
export function confirmDialog({ title = 'Confirmar', message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false } = {}) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: message,
      size: 'sm',
      class: 'modal-confirm',
      actions: [
        { label: cancelLabel, onclick: (close) => close(false) },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', autofocus: true, onclick: (close) => close(true) },
      ],
      onclose: (result) => resolve(result === true),
    });
  });
}

/**
 * Pede um texto. Substitui o prompt() nativo.
 *
 *   const motivo = await promptDialog({ title: 'Bloquear tarefa', label: 'Motivo do bloqueio', required: true });
 *   if (motivo !== null) …
 *
 * Enter confirma (com `multiline`, Ctrl+Enter). Com `required`, o botão fica desligado enquanto o texto está vazio.
 *
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.label] rótulo do campo
 * @param {string} [options.value] texto inicial
 * @param {string} [options.placeholder]
 * @param {boolean} [options.multiline]
 * @param {string} [options.confirmLabel='Salvar']
 * @param {string} [options.cancelLabel='Cancelar']
 * @param {boolean} [options.required]
 * @param {string} [options.hint] texto de apoio abaixo do campo
 * @returns {Promise<string|null>} o texto (sem espaços nas pontas) ou null se cancelou
 */
export function promptDialog({ title, label, value = '', placeholder, multiline = false, confirmLabel = 'Salvar', cancelLabel = 'Cancelar', required = false, hint } = {}) {
  return new Promise((resolve) => {
    let text = value == null ? '' : String(value);
    let dialog = null;
    const valid = () => !required || text.trim() !== '';
    const submit = () => {
      if (valid()) dialog.close({ text: text.trim() });
    };
    const oninput = (next) => {
      const before = valid();
      text = next;
      if (before !== valid()) dialog.update();
    };
    dialog = openModal({
      title: title || label || 'Informe',
      size: 'sm',
      class: 'modal-prompt',
      render: () =>
        field(
          { label: title ? label : null, hint },
          multiline
            ? textArea({ value: text, placeholder, rows: 4, autofocus: true, oninput, onsubmit: submit, ariaLabel: label || title })
            : textInput({ value: text, placeholder, autofocus: true, oninput, onenter: submit, ariaLabel: label || title }),
        ),
      actions: () => [
        { label: cancelLabel, onclick: (close) => close(null) },
        { label: confirmLabel, variant: 'primary', disabled: !valid(), onclick: submit },
      ],
      onclose: (result) => resolve(result && typeof result === 'object' && typeof result.text === 'string' ? result.text : null),
    });
  });
}

// ---------------------------------------------------------------------------
// Avisos (toasts)
// ---------------------------------------------------------------------------

const TOAST_ICONS = { success: 'check-circle', warn: 'alert-triangle', danger: 'alert-circle' };
const TOAST_TONES = { default: 'default', success: 'success', warn: 'warn', warning: 'warn', danger: 'danger', error: 'danger' };
/** Avisos visíveis: { key, el, timer, dismiss } */
const toasts = [];

function ensureToastHost() {
  ensureRoot();
  if (toastHost === null || !toastHost.isConnected) {
    toastHost = h('div', { class: 'toast-stack', role: 'region', 'aria-label': 'Avisos', 'aria-live': 'polite', 'aria-relevant': 'additions text' });
    root.appendChild(toastHost);
  }
  return toastHost;
}

/**
 * Mostra um aviso rápido no rodapé (centro), acima da barra de abas do celular.
 *
 *   toast('Tarefa concluída', { tone: 'success' })
 *   toast('Tarefa excluída', { action: { label: 'Desfazer', onclick: () => app.cmd.restoreTask(id) } })
 *   const fechar = toast('Sincronizando…', { id: 'sync', duration: 0 });   // fica até fechar()
 *   toast('Sincronizado', { id: 'sync', tone: 'success' });                // substitui o anterior (mesmo id)
 *
 * @param {string|Node} message
 * @param {object} [options]
 * @param {'default'|'success'|'warn'|'danger'} [options.tone='default']
 * @param {{ label: string, onclick: () => void }} [options.action] botão de ação (ex.: Desfazer); clicar fecha o aviso
 * @param {Array<{ label: string, onclick?: () => void }>} [options.actions] até 2 botões (ex.: [Recarregar] [Depois]);
 *   somados a `action` (que vem primeiro), no máximo 2; clicar qualquer um fecha o aviso
 * @param {number} [options.duration=4000] ms até sumir; 0 = fica até ser fechado
 * @param {string} [options.id] um aviso com o mesmo id substitui o anterior no lugar
 * @returns {() => void} função que fecha o aviso
 */
export function toast(message, { tone = 'default', action, actions, duration = 4000, id } = {}) {
  const host = ensureToastHost();
  const resolvedTone = TOAST_TONES[tone] || 'default';
  const key = id == null ? null : String(id);
  const record = { key, el: null, timer: 0 };

  const dismiss = () => {
    const index = toasts.indexOf(record);
    if (index < 0) return;
    toasts.splice(index, 1);
    clearTimeout(record.timer);
    record.el.remove();
  };
  const arm = () => {
    clearTimeout(record.timer);
    if (Number.isFinite(duration) && duration > 0) record.timer = setTimeout(dismiss, duration);
  };

  record.dismiss = dismiss;
  record.el = h(
    'div',
    {
      class: cx('toast', `toast-${resolvedTone}`),
      role: resolvedTone === 'danger' ? 'alert' : 'status',
      'data-toast-id': key,
      onpointerenter: () => clearTimeout(record.timer),
      onpointerleave: arm,
    },
    TOAST_ICONS[resolvedTone] ? h('span', { class: 'toast-icon' }, makeIcon(TOAST_ICONS[resolvedTone], { size: 16 })) : null,
    h('span', { class: 'toast-message' }, message),
    ...[action, ...(Array.isArray(actions) ? actions : [])]
      .filter((item) => item && item.label)
      .slice(0, 2)
      .map((item) =>
        h(
          'button',
          {
            type: 'button',
            class: 'toast-action',
            onclick: (ev) => {
              dismiss();
              if (typeof item.onclick === 'function') item.onclick(ev);
            },
          },
          item.label,
        ),
      ),
    h('button', { type: 'button', class: 'toast-close', title: 'Fechar aviso', 'aria-label': 'Fechar aviso', onclick: dismiss }, makeIcon('x', { size: 14 })),
  );

  const previous = key === null ? null : toasts.find((item) => item.key === key);
  if (previous) {
    clearTimeout(previous.timer);
    host.replaceChild(record.el, previous.el);
    toasts[toasts.indexOf(previous)] = record;
  } else {
    host.appendChild(record.el);
    toasts.push(record);
    while (toasts.length > MAX_TOASTS) toasts[0].dismiss();
  }
  arm();
  return dismiss;
}

// ---------------------------------------------------------------------------
// Controle geral
// ---------------------------------------------------------------------------

/**
 * Fecha todas as camadas abertas (menus, popovers, diálogos). Avisos (toasts) só fecham com `{ toasts: true }`.
 * Use ao trocar de tela.
 * @param {{ toasts?: boolean }} [options]
 */
export function closeAllOverlays({ toasts: alsoToasts = false } = {}) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]) stack[i].close('all');
  }
  if (alsoToasts) {
    for (const item of [...toasts]) item.dismiss();
  }
}

/**
 * Há algum menu, popover ou diálogo aberto? (avisos não contam)
 * Os atalhos de teclado globais devem se recolher enquanto isso for verdadeiro.
 * @returns {boolean}
 */
export function isOverlayOpen() {
  return stack.length > 0;
}
