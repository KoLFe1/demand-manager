// Tela "Dependências" — o diagrama em SVG: nós (cartões em foreignObject), arestas (curvas de Bézier com
// seta), zoom e arraste para mover. Função pura de renderização: recebe o modelo e o estado da tela.

import { cx, h, s } from '../../../core/dom.js';
import { formatDate } from '../../../core/dates.js';
import { iconButton } from '../../kit/controls.js';
import { deadlineChip, statusBadge } from '../../kit/display.js';
import { icon } from '../../kit/icons.js';
import { entityAttrs } from '../../shared/entity.js';
import { NODE_H, NODE_W, highlightOf, taskName } from './model.js';

/** Níveis de zoom dos botões + / −. */
export const ZOOM_STEPS = Object.freeze([0.4, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]);
/** Menor escala do "ajustar à tela" (abaixo disso o texto fica ilegível: o diagrama rola). */
export const FIT_MIN_SCALE = 0.8;

const ARROWS = Object.freeze(['pending', 'satisfied', 'conflict', 'cycle', 'hl']);

/** Pedido de rolagem até um nó, atendido pelo `ref` do nó depois do desenho. */
let scrollRequest = null;

/** Pede para rolar o diagrama até o nó (atendido no próximo desenho em que o nó existir). */
export function requestScroll(id) {
  scrollRequest = id || null;
}

/** Cancela um pedido de rolagem pendente (ao sair da tela). */
export function clearScrollRequest() {
  scrollRequest = null;
}

function scrollRef(id) {
  return (el) => {
    if (scrollRequest !== id) return;
    const run = () => {
      if (scrollRequest !== id || !el.isConnected) return;
      scrollRequest = null;
      // Rola só a área do diagrama (a página fica onde está), centralizando o nó.
      const scroller = el.closest('.v-dependencias-scroller');
      if (!scroller) return;
      const box = scroller.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      scroller.scrollLeft += rect.left + rect.width / 2 - (box.left + box.width / 2);
      scroller.scrollTop += rect.top + rect.height / 2 - (box.top + box.height / 2);
    };
    if (el.isConnected) requestAnimationFrame(run);
    else requestAnimationFrame(() => requestAnimationFrame(run));
  };
}

/** Escala atual do SVG desenhado (lida do DOM no momento do clique). */
export function measuredScale(fromEl, width) {
  const root = fromEl && typeof fromEl.closest === 'function' ? fromEl.closest('.v-dependencias-canvas') : null;
  const svg = root ? root.querySelector('svg.v-dependencias-svg') : null;
  if (!svg || !width) return 1;
  const rect = svg.getBoundingClientRect();
  return rect.width > 0 ? rect.width / width : 1;
}

/** Próximo nível de zoom a partir da escala atual. */
export function nextZoom(current, direction) {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current + 0.01) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) if (ZOOM_STEPS[i] < current - 0.01) return ZOOM_STEPS[i];
  return ZOOM_STEPS[0];
}

function pathOf(points) {
  const [a, b, c, d] = points;
  return `M${a.x} ${a.y} C${b.x} ${b.y}, ${c.x} ${c.y}, ${d.x - 2} ${d.y}`;
}

function arrowDefs() {
  return s(
    'defs',
    null,
    ARROWS.map((kind) =>
      s(
        'marker',
        {
          id: `vdep-arrow-${kind}`,
          class: `v-dependencias-arrow v-dependencias-arrow-${kind}`,
          viewBox: '0 0 10 10',
          refX: 8.5,
          refY: 5,
          markerWidth: 7,
          markerHeight: 7,
          markerUnits: 'userSpaceOnUse',
          orient: 'auto',
        },
        s('path', { d: 'M0.5 1 L9 5 L0.5 9 Z' }),
      ),
    ),
  );
}

const EDGE_LABELS = Object.freeze({
  pending: 'pendente',
  satisfied: 'pré-requisito concluído',
  conflict: 'conflito de prazo',
  cycle: 'dependência circular',
});

/**
 * Corpo do cartão de um nó (HTML dentro do foreignObject).
 */
function nodeCard(app, task, { blocked, conflicts, external }) {
  const status = app.sel.status(task.status);
  const info = app.sel.deadline(task);
  const code = app.sel.code('task', task);
  const severe = conflicts.some((c) => c.severity === 'danger');
  const blockers = blocked ? app.sel.blockers(task.id) : [];
  const demand = external ? app.sel.demandOf(task) : null;
  const tooltip = [
    `${code ? `${code} · ` : ''}${taskName(task)}`,
    `Status: ${status.label}`,
    task.due_date ? `Prazo: ${formatDate(task.due_date, 'long')}` : 'Sem prazo',
    demand ? `Demanda: ${demand.name}` : null,
    blockers.length ? `Bloqueada por: ${blockers.map((b) => `“${taskName(b)}”`).join(', ')}` : null,
    ...conflicts.map((c) => `⚠ ${c.message}`),
  ]
    .filter(Boolean)
    .join('\n');
  return h(
    'div',
    { class: 'v-dependencias-card', title: tooltip },
    h(
      'div',
      { class: 'v-dependencias-card-top' },
      statusBadge(status, { compact: true, size: 14, class: 'v-dependencias-card-status' }),
      code ? h('span', { class: 'v-dependencias-card-code tabular' }, code) : null,
      external ? h('span', { class: 'v-dependencias-card-ext', title: demand ? `Fora do filtro — demanda: ${demand.name}` : 'Fora do filtro' }, icon('external', { size: 11 })) : null,
      h('span', { class: 'v-dependencias-card-spacer' }),
      blocked ? h('span', { class: 'v-dependencias-card-lock', 'aria-label': 'Bloqueada por dependência' }, icon('lock', { size: 12 })) : null,
      conflicts.length ? h('span', { class: cx('v-dependencias-card-warn', severe ? 'is-danger' : 'is-warning'), 'aria-label': 'Conflito de prazo' }, icon('alert-triangle', { size: 12 })) : null,
      task.due_date ? deadlineChip(info, { class: 'v-dependencias-card-due' }) : null,
    ),
    h('div', { class: 'v-dependencias-card-name' }, taskName(task)),
  );
}

/**
 * Diagrama completo (cartão com a barra de zoom e a área rolável).
 * @param {object} app
 * @param {object} model resultado de buildModel
 * @param {object} opts { state, selectedId, activeId, linking, linkFrom, handlers }
 */
export function renderDiagram(app, model, opts) {
  const { zoom, selectedId, activeId, linking, linkFrom, handlers } = opts;
  const hl = highlightOf(model, activeId);
  const fit = !(typeof zoom === 'number' && zoom > 0);
  const W = model.width;
  const H = model.height;
  const svgStyle = fit
    ? { width: `clamp(${Math.round(W * FIT_MIN_SCALE)}px, 100%, ${W}px)`, height: 'auto' }
    : { width: `${Math.round(W * zoom)}px`, height: `${Math.round(H * zoom)}px` };

  const edgeNodes = model.edges
    .filter((edge) => edge.points)
    .map((edge) => {
      const lit = hl ? hl.edges.has(edge.key) : false;
      const dim = hl ? !lit : false;
      const prereq = model.byId.get(edge.from);
      const dependent = model.byId.get(edge.to);
      const label = `“${taskName(dependent)}” depende de “${taskName(prereq)}” (${EDGE_LABELS[edge.kind]})`;
      const marker = lit && edge.kind !== 'cycle' && edge.kind !== 'conflict' ? 'hl' : edge.kind;
      const d = pathOf(edge.points);
      return s(
        'g',
        {
          key: edge.key,
          class: cx('v-dependencias-edge', `is-${edge.kind}`, lit && 'is-lit', dim && 'is-dimmed'),
          'data-edge': edge.key,
          'data-kind': edge.kind,
        },
        s('path', { class: 'v-dependencias-edge-line', d, 'marker-end': `url(#vdep-arrow-${marker})` }),
        s(
          'path',
          {
            class: 'v-dependencias-edge-hit',
            d,
            role: 'button',
            'aria-label': `${label}. Clique para remover.`,
            onclick: (ev) => {
              ev.stopPropagation();
              handlers.onEdge(edge, { x: ev.clientX, y: ev.clientY });
            },
          },
          s('title', null, label),
        ),
      );
    });

  const nodeEls = model.nodes.map((node) => {
    const task = node.task;
    const base = entityAttrs(app, 'task', task);
    const blocked = app.sel.isBlockedByDependency(task.id);
    const conflicts = app.sel.conflictsOf(task.id);
    const open = app.sel.isOpen(task);
    const status = app.sel.status(task.status);
    const selected = node.id === selectedId;
    const lit = hl ? hl.nodes.has(node.id) : false;
    const role = hl ? (node.id === activeId ? 'active' : hl.up.has(node.id) ? 'up' : hl.down.has(node.id) ? 'down' : null) : null;
    const code = app.sel.code('task', task);
    const aria = [
      `${code ? `${code} ` : ''}${taskName(task)}`,
      status.label,
      blocked ? 'bloqueada por dependência' : null,
      conflicts.length ? 'com conflito de prazo' : null,
      linking ? (linkFrom ? 'Enter: escolher como dependente' : 'Enter: escolher como pré-requisito') : 'Enter abre a tarefa',
    ]
      .filter(Boolean)
      .join(', ');
    return s(
      'g',
      {
        ...base,
        class: cx('v-dependencias-node', base.class, `st-${status.color || 'gray'}`, {
          'is-open': open,
          'is-closed': !open,
          'is-selected': selected,
          'is-lit': lit,
          'is-dimmed': hl && !lit,
          'is-up': role === 'up',
          'is-down': role === 'down',
          'is-external': node.external,
          'is-link-source': linking && linkFrom === node.id,
          'has-conflict': conflicts.length > 0,
        }),
        transform: `translate(${node.x} ${node.y})`,
        tabindex: 0,
        role: 'button',
        'aria-label': aria,
        'aria-pressed': selected,
        ref: scrollRef(node.id),
        onpointerenter: () => handlers.onHover(node.id),
        onpointerleave: () => handlers.onHoverEnd(node.id),
        onfocus: () => handlers.onHover(node.id),
        onblur: () => handlers.onHoverEnd(node.id),
        onclick: (ev) => {
          ev.stopPropagation();
          handlers.onNodeClick(node.id, ev);
        },
        ondblclick: (ev) => {
          ev.stopPropagation();
          handlers.onNodeOpen(node.id);
        },
        onkeydown: (ev) => handlers.onNodeKey(node.id, ev),
      },
      s('rect', { class: 'v-dependencias-node-ring', x: -3, y: -3, width: NODE_W + 6, height: NODE_H + 6, rx: 11 }),
      s(
        'foreignObject',
        { x: 0, y: 0, width: NODE_W, height: NODE_H },
        nodeCard(app, task, { blocked, conflicts, external: node.external }),
      ),
    );
  });

  return h(
    'div',
    { class: cx('v-dependencias-canvas', linking && 'is-linking'), 'data-zoom': fit ? 'fit' : String(zoom) },
    h(
      'div',
      { class: 'v-dependencias-canvas-bar' },
      linking
        ? h(
            'div',
            { class: 'v-dependencias-linkhint', role: 'status' },
            icon('link', { size: 14 }),
            h(
              'span',
              { class: 'v-dependencias-linkhint-text' },
              linkFrom
                ? ['Agora clique na tarefa que depende de ', h('strong', null, `“${taskName(model.byId.get(linkFrom))}”`)]
                : 'Modo ligar: clique no pré-requisito (o que precisa ficar pronto antes)',
            ),
            h('button', { type: 'button', class: 'v-dependencias-linkhint-cancel', 'data-action': 'link-cancel', onclick: () => handlers.onLinkCancel() }, linkFrom ? 'Trocar' : 'Sair'),
          )
        : h('span', { class: 'v-dependencias-canvas-hint' }, 'Clique numa tarefa para ver a cadeia · duplo clique abre · arraste o fundo para mover'),
      h(
        'div',
        { class: 'v-dependencias-zoom', role: 'group', 'aria-label': 'Zoom do diagrama' },
        iconButton({ icon: 'minus', title: 'Diminuir zoom', size: 'sm', onclick: (ev) => handlers.onZoom(-1, ev.currentTarget), attrs: { 'data-action': 'zoom-out' } }),
        h('span', { class: 'v-dependencias-zoom-value tabular', 'aria-live': 'polite' }, fit ? 'Ajustado' : `${Math.round(zoom * 100)}%`),
        iconButton({ icon: 'plus', title: 'Aumentar zoom', size: 'sm', onclick: (ev) => handlers.onZoom(1, ev.currentTarget), attrs: { 'data-action': 'zoom-in' } }),
        iconButton({ icon: 'maximize', title: 'Ajustar à tela', size: 'sm', active: fit, onclick: () => handlers.onZoomFit(), attrs: { 'data-action': 'zoom-fit' } }),
      ),
    ),
    h(
      'div',
      {
        class: 'v-dependencias-scroller',
        tabindex: -1,
        onpointerdown: handlers.onPanStart,
        onwheel: handlers.onWheel,
        onclick: (ev) => {
          if (ev.target.closest('.v-dependencias-node, .v-dependencias-edge')) return;
          handlers.onBackground();
        },
      },
      s(
        'svg',
        {
          class: 'v-dependencias-svg',
          viewBox: `0 0 ${W} ${H}`,
          width: W,
          height: H,
          style: svgStyle,
          role: 'group',
          'aria-label': `Diagrama de dependências: ${model.nodes.length} tarefas, ${model.edges.length} ligações`,
          preserveAspectRatio: 'xMinYMin meet',
        },
        arrowDefs(),
        s('g', { class: 'v-dependencias-edges' }, edgeNodes),
        s('g', { class: 'v-dependencias-nodes' }, nodeEls),
      ),
    ),
  );
}
