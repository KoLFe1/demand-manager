// Visualização "Kanban" (especificação 10.2): colunas = status; arrastar um cartão para outra coluna troca o
// status na hora (salvo automaticamente, com os avisos do comando); dentro da coluna, com "Ordem manual",
// arrastar reordena. Cartões de tarefas ou de demandas, raias opcionais (demanda, projeto, prioridade),
// colunas recolhíveis, aviso de WIP em "Em andamento" e, no celular, colunas com rolagem lateral e uma faixa
// de status para pular entre elas (no toque, o status muda pelo controle do cartão — sem arrastar).
//
// A tela é uma função pura do estado do app + ctx.state (filtros, ordenação, modo, raias, colunas e raias
// recolhidas, limite de WIP…), que fica salvo por dispositivo. Toda escrita passa por app.cmd.* ou pelas
// ações de js/ui/shared/entity.js.

import { cx, h } from '../../core/dom.js';
import { plural } from '../../core/format.js';
import { defaultFilters } from '../../domain/filters.js';
import { button, formatDurationText, iconButton, segmented } from '../kit/controls.js';
import { emptyState, priorityBadge, statusBadge } from '../kit/display.js';
import { sortableItem, sortableList } from '../kit/dnd.js';
import { icon } from '../kit/icons.js';
import { entityCard, openEntityMenu, projectDot, quickAddRow } from '../shared/entity.js';
import { filterBar } from '../shared/filterbar.js';
import { NOUN, afterQuickCreate, openColumnMenu, openDisplayMenu, openLanesMenu, performDrop, quoted } from './kanban/actions.js';
import { LANE_LABELS, PAGE_SIZE, SORT_KEYS, buildBoard, canDropInto, normalizeState } from './kanban/model.js';

/** Filtros oferecidos na barra (sem status: as colunas já são os status). */
const FILTER_FIELDS = Object.freeze(['q', 'project', 'priority', 'deadline', 'tags', 'owner']);

// ---------------------------------------------------------------------------
// Cartões e células
// ---------------------------------------------------------------------------

function limitKey(st, statusId, laneKey) {
  return `${st.mode}:${statusId}:${laneKey === null ? '*' : laneKey}`;
}

/** Linha com o nome da tarefa principal (subtarefas mostradas como cartões). */
function parentLine(app, parent) {
  const code = app.sel.code('task', parent);
  return h(
    'span',
    { class: 'v-kanban-parent', title: `Subtarefa de ${quoted(parent.name || 'Sem nome')}` },
    icon('tree', { size: 12 }),
    code ? h('span', { class: 'tabular' }, code) : null,
    h('span', { class: 'truncate' }, parent.name || 'Sem nome'),
  );
}

function cardItem(app, ctx, st, column, laneKey, entity) {
  const kind = st.mode;
  const statusId = column.status.id;
  const parent = kind === 'task' ? app.sel.parentOf(entity) : null;
  const drag = sortableItem({
    type: kind,
    id: entity.id,
    data: { col: statusId, lane: laneKey },
    disabled: ctx.isMobile,
    canDrop: (drop) => st.sort.key === 'manual' && canDropInto(app, st, drop, statusId, laneKey),
    onmove: (move) => performDrop(app, st, { id: move.id, from: move.data, statusId, laneKey, place: move.place, event: move.event }),
  });
  const card = entityCard(app, kind, entity, {
    showDemand: st.lanes !== 'demand',
    showProject: kind === 'demand' ? st.lanes !== 'project' : false,
    footer: parent ? parentLine(app, parent) : null,
    class: 'v-kanban-card',
  });
  return h(
    'div',
    { ...drag, key: entity.id, class: cx('v-kanban-item', ctx.isMobile && 'is-static') },
    card,
    iconButton({
      icon: 'more-horizontal',
      title: 'Mais ações',
      size: 'sm',
      class: 'v-kanban-more',
      onclick: (ev) => {
        ev.stopPropagation();
        openEntityMenu(app, kind, entity.id, ev.currentTarget);
      },
    }),
  );
}

/** Props de destino de uma célula (lista de uma coluna, numa raia ou sem raias). */
function cellDrop(app, st, statusId, laneKey) {
  return sortableList({
    type: st.mode,
    canDrop: (drop) => canDropInto(app, st, drop, statusId, laneKey),
    onmove: (move) => performDrop(app, st, { id: move.id, from: move.data, statusId, laneKey, place: move.place, event: move.event }),
  });
}

/** Cartões de uma célula com "Mostrar mais" e a dica de soltar quando vazia. */
function cardsOf(app, ctx, st, column, laneKey, items) {
  const key = limitKey(st, column.status.id, laneKey);
  const limit = st.limits[key] || PAGE_SIZE;
  const shown = items.length > limit ? items.slice(0, limit) : items;
  const rest = items.length - shown.length;
  return [
    shown.map((entity) => cardItem(app, ctx, st, column, laneKey, entity)),
    rest > 0
      ? button({
          label: `Mostrar mais ${Math.min(rest, PAGE_SIZE)} de ${rest}`,
          size: 'sm',
          variant: 'ghost',
          block: true,
          class: 'v-kanban-more-cards',
          attrs: { key: `more:${key}` },
          onclick: () => ctx.setState({ limits: { ...st.limits, [key]: limit + PAGE_SIZE } }),
        })
      : null,
  ];
}

function dropHint(text = 'Solte aqui') {
  return h('div', { class: 'v-kanban-hint', key: 'hint', 'aria-hidden': 'true' }, text);
}

function cellList(app, ctx, st, column, laneKey, items, { label } = {}) {
  return h(
    'div',
    {
      class: 'v-kanban-list',
      'data-col': column.status.id,
      'data-lane': laneKey === null ? null : laneKey,
      role: 'list',
      'aria-label': label || column.status.label,
      ...cellDrop(app, st, column.status.id, laneKey),
    },
    cardsOf(app, ctx, st, column, laneKey, items),
    items.length === 0 ? dropHint(st.mode === 'task' ? 'Nenhuma tarefa' : 'Nenhuma demanda') : null,
  );
}

// ---------------------------------------------------------------------------
// Cabeçalhos
// ---------------------------------------------------------------------------

function countText(st, column) {
  const wip = column.status.category === 'active';
  return wip ? `${column.count}/${st.wipLimit}` : String(column.count);
}

function columnHeader(app, ctx, st, column) {
  const status = column.status;
  const wip = status.category === 'active';
  const over = wip && column.count > st.wipLimit;
  const noun = NOUN[st.mode];
  return h(
    'header',
    { class: cx('v-kanban-head', over && 'is-over-wip'), 'data-col-head': status.id },
    statusBadge(status, { compact: true, class: 'v-kanban-glyph' }),
    h('h2', { class: 'v-kanban-name truncate', title: status.description || status.label }, status.label),
    h(
      'span',
      {
        class: cx('v-kanban-count', 'tabular', over && 'is-warn'),
        title: wip ? (over ? `Acima do limite de WIP: ${column.count} de no máximo ${st.wipLimit}` : `${plural(column.count, 'cartão', 'cartões')} · limite de WIP ${st.wipLimit}`) : plural(column.count, noun.one, noun.many),
        'data-count': String(column.count),
      },
      over ? icon('alert-triangle', { size: 12 }) : null,
      countText(st, column),
    ),
    column.estimate > 0 ? h('span', { class: 'v-kanban-est tabular', title: `Soma das estimativas: ${formatDurationText(column.estimate)}` }, formatDurationText(column.estimate)) : null,
    h('span', { class: 'v-kanban-spacer' }),
    h(
      'span',
      { class: 'v-kanban-actions' },
      ctx.isMobile
        ? null
        : iconButton({ icon: 'chevron-left', title: `Recolher a coluna ${status.label}`, size: 'sm', class: 'v-kanban-collapse', onclick: () => ctx.setState({ collapsed: { ...st.collapsed, [status.id]: true } }) }),
      iconButton({ icon: 'plus', title: `Adicionar ${noun.one} em ${status.label}`, size: 'sm', class: 'v-kanban-add', onclick: () => ctx.setState({ addTo: status.id }) }),
      iconButton({ icon: 'more-horizontal', title: `Opções da coluna ${status.label}`, size: 'sm', class: 'v-kanban-col-menu', onclick: (ev) => openColumnMenu(app, ctx, st, column, ev.currentTarget) }),
    ),
  );
}

/** Linha de criação rápida sob o cabeçalho (status da coluna; Esc com o campo vazio fecha). */
function quickAdd(app, ctx, st, column) {
  if (st.addTo !== column.status.id) return null;
  const kind = st.mode;
  const defaults = { status: column.status.id };
  const scope = app.ui && app.ui.scope ? app.ui.scope.projectId : null;
  if (kind === 'demand' && scope) defaults.project_id = scope;
  return h(
    'div',
    {
      class: 'v-kanban-quickadd',
      key: `add:${column.status.id}`,
      onkeydown: (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          ctx.setState({ addTo: null });
        }
      },
      ref: (el) => {
        if (el.isConnected && !el.__kbFocused) {
          el.__kbFocused = true;
          const input = el.querySelector('input');
          if (input) input.focus({ preventScroll: true });
        }
      },
    },
    quickAddRow(app, { type: kind, defaults, placeholder: `${NOUN[kind].new}…`, onCreated: (row) => afterQuickCreate(app, st, row) }),
    iconButton({ icon: 'x', title: 'Fechar a criação rápida', size: 'sm', onclick: () => ctx.setState({ addTo: null }) }),
  );
}

/** Coluna recolhida: faixa vertical com o nome e a contagem (também recebe cartões). */
function collapsedStrip(app, ctx, st, column, { lanes = false } = {}) {
  const status = column.status;
  const over = status.category === 'active' && column.count > st.wipLimit;
  return h(
    'button',
    {
      type: 'button',
      class: cx('v-kanban-strip', lanes && 'is-head', over && 'is-over-wip'),
      title: `Expandir a coluna ${status.label}`,
      'aria-label': `Expandir a coluna ${status.label} (${plural(column.count, 'cartão', 'cartões')})`,
      'aria-expanded': 'false',
      onclick: () => {
        const next = { ...st.collapsed };
        delete next[status.id];
        ctx.setState({ collapsed: next });
      },
    },
    statusBadge(status, { compact: true, class: 'v-kanban-glyph' }),
    h('span', { class: cx('v-kanban-count', 'tabular', over && 'is-warn') }, countText(st, column)),
    lanes ? null : h('span', { class: 'v-kanban-strip-name' }, status.label),
  );
}

function laneTitle(app, lane) {
  if (lane.kind === 'priority') return [priorityBadge(lane.priority, { compact: true }), h('span', { class: 'v-kanban-lane-name' }, lane.label)];
  if (lane.kind === 'project') return [projectDot(lane.project), h('span', { class: cx('v-kanban-lane-name', lane.empty && 'is-empty') }, lane.label)];
  return [
    lane.project ? projectDot(lane.project) : icon('layers', { size: 14, class: 'v-kanban-lane-icon' }),
    lane.code ? h('span', { class: 'v-kanban-lane-code tabular' }, lane.code) : null,
    h('span', { class: cx('v-kanban-lane-name', lane.empty && 'is-empty') }, lane.label),
  ];
}

function laneHeader(app, ctx, st, lane, collapsed, { compact = false } = {}) {
  const key = `${st.mode}:${st.lanes}:${lane.key}`;
  const toggle = () => {
    const next = { ...st.collapsedLanes };
    if (collapsed) delete next[key];
    else next[key] = true;
    ctx.setState({ collapsedLanes: next });
  };
  return h(
    'div',
    { class: cx('v-kanban-lane-head', compact && 'is-compact'), key: `lane-head:${lane.key}` },
    h(
      'button',
      { type: 'button', class: 'v-kanban-lane-toggle', 'aria-expanded': !collapsed, title: collapsed ? 'Expandir a raia' : 'Recolher a raia', onclick: toggle },
      icon(collapsed ? 'chevron-right' : 'chevron-down', { size: 14, class: 'v-kanban-lane-caret' }),
      laneTitle(app, lane),
      h('span', { class: 'v-kanban-lane-count tabular' }, String(lane.count)),
    ),
    lane.kind === 'demand' && lane.demand
      ? iconButton({ icon: 'panel-right', title: `Abrir a demanda ${lane.label}`, size: 'sm', class: 'v-kanban-lane-open', onclick: () => app.ui.openPanel('demand', lane.demand.id) })
      : null,
  );
}

const laneCollapsed = (st, lane) => st.collapsedLanes[`${st.mode}:${st.lanes}:${lane.key}`] === true;

// ---------------------------------------------------------------------------
// Quadro
// ---------------------------------------------------------------------------

/** Quadro sem raias (ou celular): colunas lado a lado, cada uma com a própria rolagem. */
function plainBoard(app, ctx, st, board) {
  const mobile = ctx.isMobile;
  return h(
    'div',
    {
      class: cx('v-kanban-board', mobile && 'is-phone'),
      'data-board': 'columns',
      onscroll: mobile ? (ev) => syncPhoneColumn(ctx, st, ev.currentTarget) : null,
      ref: mobile ? (el) => restorePhoneColumn(st, el) : null,
    },
    board.columns.map((column) => {
      const status = column.status;
      if (!mobile && st.collapsed[status.id]) {
        return h('section', { class: 'v-kanban-col is-collapsed', key: status.id, 'data-col': status.id, 'aria-label': `${status.label} (recolhida)`, ...cellDrop(app, st, status.id, null) }, collapsedStrip(app, ctx, st, column));
      }
      let body;
      if (mobile && board.lanes) {
        // Celular com raias: as raias viram grupos dentro de cada coluna.
        const groups = board.lanes.filter((lane) => lane.cells[board.columns.indexOf(column)].length > 0);
        const index = board.columns.indexOf(column);
        body = h(
          'div',
          { class: 'v-kanban-list is-grouped', 'data-col': status.id, role: 'list', 'aria-label': status.label, ...cellDrop(app, st, status.id, null) },
          groups.map((lane) => {
            const collapsed = laneCollapsed(st, lane);
            return h(
              'div',
              { class: 'v-kanban-group', key: `g:${lane.key}` },
              laneHeader(app, ctx, st, { ...lane, count: lane.cells[index].length }, collapsed, { compact: true }),
              collapsed ? null : cardsOf(app, ctx, st, column, lane.key, lane.cells[index]),
            );
          }),
          groups.length === 0 ? dropHint(st.mode === 'task' ? 'Nenhuma tarefa' : 'Nenhuma demanda') : null,
        );
      } else {
        body = cellList(app, ctx, st, column, null, column.items);
      }
      return h(
        'section',
        { class: 'v-kanban-col', key: status.id, 'data-col': status.id, 'aria-label': `${status.label}: ${plural(column.count, 'cartão', 'cartões')}` },
        columnHeader(app, ctx, st, column),
        quickAdd(app, ctx, st, column),
        body,
      );
    }),
  );
}

/** Quadro com raias (computador): cabeçalhos fixos no topo e uma faixa horizontal por raia. */
function laneBoard(app, ctx, st, board) {
  const widthOf = (column) => (st.collapsed[column.status.id] ? 'is-collapsed' : null);
  return h(
    'div',
    { class: 'v-kanban-board has-lanes', 'data-board': 'lanes' },
    h(
      'div',
      { class: 'v-kanban-headrow', key: 'headrow' },
      board.columns.map((column) =>
        h(
          'div',
          { class: cx('v-kanban-headcell', widthOf(column)), key: column.status.id, 'data-col': column.status.id, ...cellDrop(app, st, column.status.id, null) },
          st.collapsed[column.status.id] ? collapsedStrip(app, ctx, st, column, { lanes: true }) : [columnHeader(app, ctx, st, column), quickAdd(app, ctx, st, column)],
        ),
      ),
    ),
    board.lanes.map((lane) => {
      const collapsed = laneCollapsed(st, lane);
      return h(
        'section',
        { class: cx('v-kanban-lane', collapsed && 'is-collapsed'), key: `lane:${lane.key}`, 'data-lane': lane.key, 'aria-label': `Raia ${lane.label}` },
        laneHeader(app, ctx, st, lane, collapsed),
        collapsed
          ? null
          : h(
              'div',
              { class: 'v-kanban-lane-row' },
              board.columns.map((column, index) => {
                const items = lane.cells[index];
                if (st.collapsed[column.status.id]) {
                  return h(
                    'div',
                    { class: 'v-kanban-cell is-collapsed', key: column.status.id, 'data-col': column.status.id, 'data-lane': lane.key, ...cellDrop(app, st, column.status.id, lane.key) },
                    items.length ? h('span', { class: 'v-kanban-count tabular' }, String(items.length)) : null,
                  );
                }
                return h('div', { class: 'v-kanban-cell', key: column.status.id }, cellList(app, ctx, st, column, lane.key, items, { label: `${column.status.label} · ${lane.label}` }));
              }),
            ),
      );
    }),
  );
}

/** Coluna mais visível na rolagem lateral do celular → ctx.state.phoneCol (só quando muda). */
function syncPhoneColumn(ctx, st, board) {
  const cols = board.querySelectorAll(':scope > .v-kanban-col');
  if (!cols.length) return;
  const center = board.scrollLeft + board.clientWidth / 2;
  let best = null;
  let bestDistance = Infinity;
  for (const col of cols) {
    const distance = Math.abs(col.offsetLeft + col.offsetWidth / 2 - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = col.getAttribute('data-col');
    }
  }
  if (best && best !== (ctx.state && ctx.state.phoneCol)) ctx.setState({ phoneCol: best });
}

/** Ao montar o quadro no celular, volta para a coluna em que o usuário estava. */
function restorePhoneColumn(st, board) {
  if (!board.isConnected || board.__kbRestored) return;
  board.__kbRestored = true;
  if (!st.phoneCol) return;
  const col = board.querySelector(`:scope > [data-col="${CSS.escape(st.phoneCol)}"]`);
  // O quadro é posicionado (CSS): offsetLeft da coluna é relativo a ele.
  if (col) board.scrollLeft = col.offsetLeft - (parseFloat(getComputedStyle(board).paddingLeft) || 0);
}

/** Mantém a aba selecionada visível na faixa (rolando só a faixa, nunca a página). */
function revealTab(el, selected) {
  const was = el.__kbSelected === true;
  el.__kbSelected = selected;
  if (!selected || was || !el.isConnected) return;
  const strip = el.parentElement;
  if (!strip) return;
  const left = el.offsetLeft; // a faixa é posicionada (CSS)
  if (left < strip.scrollLeft) strip.scrollLeft = left - 8;
  else if (left + el.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + el.offsetWidth - strip.clientWidth + 8;
}

/** Faixa de status do celular: pula para a coluna (rolagem lateral). */
function phoneTabs(ctx, st, board, active) {
  const jump = (statusId, ev) => {
    const root = ev.currentTarget.closest('.v-kanban');
    const el = root ? root.querySelector('.v-kanban-board') : null;
    const col = el ? el.querySelector(`:scope > [data-col="${CSS.escape(statusId)}"]`) : null;
    if (el && col) {
      const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
      el.scrollTo({ left: col.offsetLeft - pad, behavior: 'smooth' });
    }
    ctx.setState({ phoneCol: statusId });
  };
  return h(
    'div',
    { class: 'v-kanban-tabs', role: 'tablist', 'aria-label': 'Colunas do quadro' },
    board.columns.map((column) => {
      const status = column.status;
      const selected = status.id === active;
      return h(
        'button',
        {
          type: 'button',
          key: status.id,
          role: 'tab',
          class: cx('v-kanban-tab', selected && 'is-active'),
          'aria-selected': selected,
          'data-tab-col': status.id,
          onclick: (ev) => jump(status.id, ev),
          ref: (el) => revealTab(el, selected),
        },
        statusBadge(status, { compact: true, class: 'v-kanban-glyph' }),
        h('span', { class: 'v-kanban-tab-name' }, status.label),
        h('span', { class: 'v-kanban-tab-count tabular' }, String(column.count)),
      );
    }),
  );
}

function toolbar(app, ctx, st, board) {
  const lanesActive = st.lanes !== 'none';
  const displayChanges = (st.mode === 'task' && st.subtasks ? 1 : 0) + (st.showCancelled ? 1 : 0);
  const extra = [
    button({
      label: lanesActive ? `Raias: ${LANE_LABELS[st.lanes]}` : 'Raias',
      icon: 'rows',
      size: 'sm',
      variant: 'ghost',
      ariaLabel: lanesActive ? `Raias: ${LANE_LABELS[st.lanes]}` : 'Agrupar em raias',
      class: cx('v-kanban-opt', lanesActive && 'is-on'),
      attrs: { 'data-kb': 'lanes', 'aria-haspopup': 'menu' },
      onclick: (ev) => openLanesMenu(ctx, st, ev.currentTarget),
    }),
    button({
      label: displayChanges ? `Exibição (${displayChanges})` : 'Exibição',
      icon: 'eye',
      size: 'sm',
      variant: 'ghost',
      ariaLabel: 'Opções de exibição',
      class: cx('v-kanban-opt', displayChanges > 0 && 'is-on'),
      attrs: { 'data-kb': 'display', 'aria-haspopup': 'menu' },
      onclick: (ev) => openDisplayMenu(ctx, st, ev.currentTarget),
    }),
  ];
  const noun = NOUN[st.mode];
  // No celular, modo e opções dividem a primeira linha; a barra de filtros fica inteira na segunda.
  const mode = segmented({
    value: st.mode,
    size: 'sm',
    ariaLabel: 'Tipo de cartão',
    class: 'v-kanban-mode',
    options: [
      { value: 'task', label: 'Tarefas', icon: 'circle' },
      { value: 'demand', label: 'Demandas', icon: 'layers' },
    ],
    onchange: (value) => ctx.setState({ mode: value === 'demand' ? 'demand' : 'task', addTo: null }),
  });
  const bar = filterBar(app, {
    filters: st.filters,
    onchange: (next) => ctx.setState({ filters: next }),
    type: st.mode,
    fields: FILTER_FIELDS,
    sort: st.sort,
    onsort: (next) => ctx.setState({ sort: next }),
    sortKeys: SORT_KEYS,
    count: { shown: board.shown, total: board.total, singular: noun.one, plural: noun.many },
    extra: ctx.isMobile ? [] : extra,
  });
  if (ctx.isMobile) {
    return h('div', { class: 'v-kanban-bar' }, h('div', { class: 'v-kanban-bar-top' }, mode, h('span', { class: 'v-kanban-spacer' }), extra), bar);
  }
  return h('div', { class: 'v-kanban-bar' }, mode, bar);
}

function emptyBoard(app, ctx, st, board) {
  const noun = NOUN[st.mode];
  if (board.total === 0) {
    const scoped = app.ui && app.ui.scope && app.ui.scope.projectId ? app.sel.project(app.ui.scope.projectId) : null;
    return emptyState({
      icon: 'kanban',
      title: noun.none,
      text: scoped
        ? `O projeto ${quoted(scoped.name)} ainda não tem ${noun.many}. Crie a primeira para organizar o quadro.`
        : `Crie a primeira ${noun.one} para começar a organizar o quadro por status.`,
      action: button({ label: noun.new, icon: 'plus', variant: 'primary', attrs: { 'data-kb': 'create-first' }, onclick: () => app.ui.quickCreate(st.mode) }),
      class: 'v-kanban-empty',
    });
  }
  return emptyState({
    icon: 'search',
    title: 'Nenhum cartão corresponde aos filtros',
    text: `Há ${plural(board.total, noun.one, noun.many)} no quadro, mas nenhuma passa pelos filtros atuais.`,
    action: button({ label: 'Limpar filtros', icon: 'x', attrs: { 'data-kb': 'clear-filters' }, onclick: () => ctx.setState({ filters: defaultFilters() }) }),
    class: 'v-kanban-empty',
  });
}

export default {
  id: 'kanban',
  path: '/kanban',
  title: 'Kanban',
  icon: 'kanban',
  order: 40,
  section: 'main',

  /**
   * Desenha o quadro inteiro a partir do app + ctx.state.
   * @param {object} app
   * @param {{ state: object, setState: Function, params: object, isMobile: boolean }} ctx
   * @returns {HTMLElement}
   */
  render(app, ctx) {
    const st = normalizeState(ctx.state);
    const board = buildBoard(app, st);
    const empty = board.shown === 0;
    const active = board.columns.some((c) => c.status.id === st.phoneCol) ? st.phoneCol : board.columns.length ? board.columns[0].status.id : null;
    let body;
    if (empty) body = h('div', { class: 'v-kanban-empty-wrap', key: 'empty' }, emptyBoard(app, ctx, st, board));
    else if (board.lanes && !ctx.isMobile) body = laneBoard(app, ctx, st, board);
    else body = plainBoard(app, ctx, st, board);
    return h(
      'div',
      { class: cx('v-kanban', ctx.isMobile && 'is-mobile', `is-${st.mode}`), 'data-mode': st.mode, 'data-lanes': st.lanes, 'data-sort': st.sort.key },
      toolbar(app, ctx, st, board),
      ctx.isMobile && !empty ? phoneTabs(ctx, st, board, active) : null,
      body,
    );
  },
};
