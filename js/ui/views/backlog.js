// Visualização "Backlog" (especificação, seção 10.5): atividades registradas e ainda NÃO planejadas — tarefas
// (ou, pelo controle segmentado, demandas) cujo status é da categoria 'backlog'.
//
//   • lista agrupada por demanda (padrão) | projeto | prioridade | sem agrupamento; dentro do grupo, ordem
//     manual (arrastar pela alça ou Alt+↑/↓) ou por prioridade / prazo / idade;
//   • cada linha: seleção, título, demanda · projeto, prioridade, prazo, estimativa, idade (destaque acima de
//     30 dias), cadeado de dependência e os atalhos Planejar / Adicionar à semana / menu;
//   • com itens selecionados, uma barra fixa com Planejar, Adicionar à semana, Definir prazo, Definir
//     prioridade, Arquivar e Cancelar;
//   • "Registrar no backlog" no topo (com a demanda escolhida ao lado) e por grupo;
//   • sugestões de prioridade como dicas na linha (Aplicar / Dispensar);
//   • resumo para o grooming: itens, estimativa total, sem estimativa, prioridade não revisada, sem demanda e
//     itens antigos — cada indicador funciona também como uma "lente" que filtra a lista.
//
// Estado da tela (ctx.state, salvo por dispositivo): mode, group, demandGroup, sort, filters, lens, collapsed,
// selected, anchorId, quickDemandId, addingIn — ver backlog/model.js (normalizeState).

import { cx, h } from '../../core/dom.js';
import { plural, truncate } from '../../core/format.js';
import { button, formatDurationText, segmented } from '../kit/controls.js';
import { emptyState } from '../kit/display.js';
import { icon } from '../kit/icons.js';
import { openMenu } from '../kit/overlays.js';
import { EMPTY_CHOICE, pickFromList } from '../kit/pickers.js';
import { notify, projectDot, quickAddRow } from '../shared/entity.js';
import { applyViewFilters, filterBar, normalizeFilters } from '../shared/filterbar.js';
import { archiveItems, cancelItems, countLabel, openAddToWeek, pickBulkDue, pickBulkPriority, planItems } from './backlog/actions.js';
import {
  DEMAND_GROUPS,
  GROUP_LABELS,
  OLD_DAYS,
  SORTS,
  TASK_GROUPS,
  ageText,
  applyLens,
  backlogBadge,
  buildGroups,
  computeStats,
  normalizeState,
  orderedIds,
  scopeProjectId,
  scopedItems,
  statusIdOf,
} from './backlog/model.js';
import { groupSection } from './backlog/rows.js';

const FILTER_FIELDS = Object.freeze(['q', 'project', 'priority', 'deadline', 'tags', 'owner']);

/**
 * Linhas desenhadas por "página": cada linha tem dezenas de elementos e a tela é redesenhada a cada mudança;
 * o backlog acumula itens com o uso, então o resto fica atrás de "Mostrar mais" (ctx.state.limit).
 */
const PAGE_ROWS = 100;

/** Limite atual de linhas desenhadas (estado da tela; null/ausente = primeira página). */
function rowLimit(raw) {
  const value = raw && typeof raw === 'object' ? raw.limit : null;
  return Number.isInteger(value) && value > PAGE_ROWS ? value : PAGE_ROWS;
}

/**
 * Reparte o limite de linhas entre os grupos, em ordem: define `group.visible` (fatia desenhada) e devolve
 * os grupos desenhados e quantos itens ficaram de fora. Grupo recolhido conta só o cabeçalho.
 */
function paginateGroups(groups, limit, isCollapsed) {
  let budget = limit;
  let hidden = 0;
  const out = [];
  for (const group of groups) {
    if (budget <= 0) {
      hidden += group.items.length;
      continue;
    }
    out.push(group);
    budget -= 1; // cabeçalho
    if (isCollapsed(group.key)) continue;
    const take = Math.max(1, Math.min(group.items.length, budget));
    group.visible = take < group.items.length ? group.items.slice(0, take) : group.items;
    hidden += group.items.length - group.visible.length;
    budget -= group.visible.length;
  }
  return { groups: out, hidden };
}

function moreView(ctx, limit, hidden) {
  const next = Math.min(PAGE_ROWS, hidden);
  return h(
    'div',
    { key: 'more', class: 'v-backlog-more', 'data-more': String(hidden) },
    h('span', { class: 'v-backlog-more-text' }, `${plural(hidden, 'item não exibido', 'itens não exibidos')} — use os filtros ou as lentes do resumo para encurtar a lista.`),
    button({ label: `Mostrar mais ${next}`, icon: 'chevron-down', size: 'sm', variant: 'ghost', class: 'v-backlog-more-action', attrs: { 'data-action': 'show-more' }, onclick: () => ctx.setState({ limit: limit + PAGE_ROWS }) }),
  );
}

// ---------------------------------------------------------------------------
// Cabeçalho, resumo e criação rápida
// ---------------------------------------------------------------------------

function headerView(app, st, ctx, counts) {
  return h(
    'div',
    { class: 'v-backlog-head' },
    h(
      'p',
      { class: 'v-backlog-lead' },
      'Atividades registradas e ainda não planejadas. Priorize, estime e escolha o que entra no planejamento.',
    ),
    segmented({
      value: st.mode,
      size: 'sm',
      ariaLabel: 'Mostrar tarefas ou demandas',
      class: 'v-backlog-mode',
      options: [
        { value: 'tasks', label: `Tarefas · ${counts.tasks}`, icon: 'circle' },
        { value: 'demands', label: `Demandas · ${counts.demands}`, icon: 'layers' },
      ],
      onchange: (mode) => ctx.setState({ mode, selected: [], anchorId: null, lens: null, addingIn: null, limit: null }),
    }),
  );
}

function summaryView(app, st, ctx, stats, type) {
  const cell = ({ key, label, value, hint, lens, tone, title }) => {
    const active = !!lens && st.lens === lens;
    const content = [
      h('span', { class: 'v-backlog-stat-value tabular' }, value),
      h('span', { class: 'v-backlog-stat-label' }, label),
      hint ? h('span', { class: 'v-backlog-stat-hint' }, hint) : null,
    ];
    if (!lens) return h('div', { key, class: 'v-backlog-stat', 'data-stat': key, title: title || null }, content);
    const disabled = !active && (value === 0 || value === '0');
    return h(
      'button',
      {
        key,
        type: 'button',
        class: cx('v-backlog-stat', 'is-lens', active && 'is-active', tone && !disabled && `tone-${tone}`),
        'data-stat': key,
        'data-lens': lens,
        'aria-pressed': active,
        disabled,
        title: active ? 'Mostrar todos os itens novamente' : title || `Mostrar só: ${label.toLowerCase()}`,
        onclick: () => ctx.setState({ lens: active ? null : lens, anchorId: null, limit: null }),
      },
      content,
      active ? icon('x', { size: 12, class: 'v-backlog-stat-clear' }) : null,
    );
  };
  const nouns = type === 'task' ? ['tarefa', 'tarefas'] : ['demanda', 'demandas'];
  return h(
    'div',
    { class: 'v-backlog-summary', role: 'group', 'aria-label': 'Resumo do backlog' },
    cell({ key: 'count', label: stats.count === 1 ? `${nouns[0]} no backlog` : `${nouns[1]} no backlog`, value: String(stats.count) }),
    cell({
      key: 'estimate',
      label: 'estimativa total',
      value: stats.estimateMinutes ? formatDurationText(stats.estimateMinutes) : '—',
      hint: stats.estimated ? `em ${plural(stats.estimated, 'item', 'itens')}` : null,
    }),
    cell({ key: 'no_estimate', label: 'sem estimativa', value: String(stats.noEstimate), lens: 'no_estimate', tone: 'warn' }),
    cell({
      key: 'unreviewed',
      label: 'prioridade não revisada',
      value: String(stats.unreviewed),
      lens: 'unreviewed',
      tone: 'warn',
      title: 'Ainda na prioridade padrão (P3) e nunca revisadas — mostrar só estas',
    }),
    cell({ key: 'orphan', label: type === 'task' ? 'sem demanda' : 'sem projeto', value: String(stats.orphan), lens: 'orphan' }),
    cell({
      key: 'old',
      label: `há mais de ${OLD_DAYS} dias`,
      value: String(stats.old),
      lens: 'old',
      tone: 'danger',
      hint: stats.oldest ? `mais antigo: ${ageText(stats.oldest.days)}` : null,
      title: stats.oldest ? `Item mais antigo: “${stats.oldest.entity.name}” (${ageText(stats.oldest.days)}) — mostrar só os antigos` : null,
    }),
  );
}

function quickAddView(app, st, ctx, type) {
  const backlogId = statusIdOf(app, 'backlog');
  const scope = scopeProjectId(app);
  const base = backlogId ? { status: backlogId } : {};
  if (type === 'demand') {
    return h(
      'div',
      { class: 'v-backlog-add', 'data-quickadd': 'demand' },
      quickAddRow(app, {
        type: 'demand',
        defaults: { ...base, project_id: scope },
        placeholder: 'Registrar demanda no backlog — digite e tecle Enter',
        class: 'v-backlog-add-field',
      }),
    );
  }
  const demand = st.quickDemandId ? app.sel.demand(st.quickDemandId) : null;
  const project = demand ? app.sel.project(demand.project_id) : null;
  const pick = async (ev) => {
    const projects = app.sel.projectsById();
    const demands = app.sel.demands().filter((d) => !scope || d.project_id === scope);
    const chosen = await pickFromList(ev.currentTarget, {
      items: demands.map((d) => {
        const p = d.project_id ? projects.get(d.project_id) : null;
        return { id: d.id, label: d.name, hint: app.sel.code('demand', d), group: p ? p.name : 'Sem projeto', icon: projectDot(p) };
      }),
      current: demand ? demand.id : null,
      allowEmpty: true,
      emptyLabel: 'Sem demanda (tarefa avulsa)',
      placeholder: 'Buscar demanda…',
      title: 'Registrar na demanda',
      width: 320,
    });
    if (chosen === null) return;
    ctx.setState({ quickDemandId: chosen === EMPTY_CHOICE ? null : chosen });
  };
  return h(
    'div',
    { class: 'v-backlog-add', 'data-quickadd': 'task' },
    quickAddRow(app, {
      type: 'task',
      defaults: { ...base, demand_id: demand ? demand.id : null },
      placeholder: 'Registrar no backlog — digite e tecle Enter',
      class: 'v-backlog-add-field',
      onCreated: (row) => {
        if (scope && app.sel.projectIdOf('task', row) !== scope) {
          notify(app, 'Tarefa registrada sem demanda: ela fica fora do projeto filtrado. Escolha uma demanda ao lado para registrar no projeto.', { duration: 7000 });
        }
      },
    }),
    h(
      'button',
      {
        type: 'button',
        class: cx('v-backlog-add-demand', !demand && 'is-empty'),
        'data-action': 'quick-demand',
        'aria-haspopup': 'dialog',
        title: demand ? `Registrar na demanda ${demand.name}` : 'Escolher a demanda das novas tarefas',
        onclick: pick,
      },
      demand ? projectDot(project) : icon('layers', { size: 14 }),
      h('span', { class: 'v-backlog-add-demand-text' }, demand ? truncate(demand.name, 36) : 'Sem demanda'),
      icon('chevron-down', { size: 12, class: 'v-backlog-add-caret' }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Ferramentas (agrupar / ordenar)
// ---------------------------------------------------------------------------

function groupButton(st, ctx, type) {
  const options = type === 'task' ? TASK_GROUPS : DEMAND_GROUPS;
  const current = type === 'task' ? st.group : st.demandGroup;
  const field = type === 'task' ? 'group' : 'demandGroup';
  return button({
    label: GROUP_LABELS[current],
    icon: 'rows',
    iconRight: 'chevron-down',
    size: 'sm',
    variant: 'ghost',
    class: 'v-backlog-tool',
    title: `Agrupar por: ${GROUP_LABELS[current].toLowerCase()}`,
    ariaLabel: `Agrupar por: ${GROUP_LABELS[current]}`,
    attrs: { 'data-action': 'group-menu', 'aria-haspopup': 'menu' },
    onclick: (ev) =>
      openMenu(
        ev.currentTarget,
        options.map((key) => ({ label: GROUP_LABELS[key], checked: key === current, onclick: () => ctx.setState({ [field]: key, addingIn: null, limit: null }) })),
        { title: 'Agrupar por', align: 'end', minWidth: 200 },
      ),
  });
}

function sortButton(st, ctx) {
  const current = SORTS.find((s) => s.key === st.sort) || SORTS[0];
  return button({
    label: current.short,
    icon: 'sort',
    iconRight: 'chevron-down',
    size: 'sm',
    variant: 'ghost',
    class: 'v-backlog-tool',
    title: `Ordenar por: ${current.label.toLowerCase()}`,
    ariaLabel: `Ordenar por: ${current.label}`,
    attrs: { 'data-action': 'sort-menu', 'aria-haspopup': 'menu' },
    onclick: (ev) =>
      openMenu(
        ev.currentTarget,
        SORTS.map((s) => ({
          label: s.label,
          checked: s.key === current.key,
          description: s.key === 'manual' ? 'Arraste pela alça para definir o que vem primeiro' : null,
          onclick: () => ctx.setState({ sort: s.key }),
        })),
        { title: 'Ordenar dentro dos grupos', align: 'end', minWidth: 240 },
      ),
  });
}

// ---------------------------------------------------------------------------
// Barra de seleção
// ---------------------------------------------------------------------------

function actionBar(app, ctx, type, selectedIds, shownIds) {
  const n = selectedIds.length;
  const clear = () => ctx.setState({ selected: [], anchorId: null });
  const afterRemove = (done) => {
    if (done) clear();
  };
  const planned = statusIdOf(app, 'planned');
  const plannedLabel = planned ? app.sel.status(planned).label : 'Não iniciada';
  const word = type === 'task' ? (n === 1 ? 'tarefa selecionada' : 'tarefas selecionadas') : n === 1 ? 'demanda selecionada' : 'demandas selecionadas';
  return h(
    'div',
    { class: 'v-backlog-bar-wrap', key: 'bar' },
    h(
      'div',
      { class: 'v-backlog-bar', role: 'toolbar', 'aria-label': 'Ações para os itens selecionados', 'data-selection': String(n) },
      h(
        'div',
        { class: 'v-backlog-bar-info' },
        h(
          'button',
          { type: 'button', class: 'btn btn-icon btn-ghost btn-sm v-backlog-bar-clear', title: 'Limpar seleção', 'aria-label': 'Limpar seleção', 'data-action': 'clear-selection', onclick: clear },
          icon('x', { size: 14 }),
        ),
        h('span', { class: 'v-backlog-bar-count' }, h('strong', { class: 'tabular' }, String(n)), ` ${word}`),
        n < shownIds.length
          ? button({ label: `Selecionar todas (${shownIds.length})`, size: 'sm', variant: 'ghost', class: 'v-backlog-bar-all', attrs: { 'data-action': 'select-all' }, onclick: () => ctx.setState({ selected: [...shownIds] }) })
          : null,
      ),
      h(
        'div',
        { class: 'v-backlog-bar-actions' },
        button({ label: 'Planejar', icon: 'arrow-right', size: 'sm', variant: 'primary', title: `Mover para ${plannedLabel}`, attrs: { 'data-bulk': 'plan' }, onclick: () => afterRemove(planItems(app, type, selectedIds)) }),
        type === 'task'
          ? button({ label: 'Adicionar à semana', ariaLabel: 'Adicionar à semana', icon: 'calendar-week', size: 'sm', attrs: { 'data-bulk': 'week', 'aria-haspopup': 'dialog' }, onclick: (ev) => openAddToWeek(app, selectedIds, ev.currentTarget, afterRemove) })
          : null,
        button({ label: 'Definir prazo', ariaLabel: 'Definir prazo', icon: 'calendar', size: 'sm', attrs: { 'data-bulk': 'due', 'aria-haspopup': 'dialog' }, onclick: (ev) => pickBulkDue(app, type, selectedIds, ev.currentTarget) }),
        button({ label: 'Definir prioridade', ariaLabel: 'Definir prioridade', icon: 'signal-3', size: 'sm', attrs: { 'data-bulk': 'priority', 'aria-haspopup': 'menu' }, onclick: (ev) => pickBulkPriority(app, type, selectedIds, ev.currentTarget) }),
        button({ label: 'Arquivar', ariaLabel: 'Arquivar', icon: 'archive', size: 'sm', attrs: { 'data-bulk': 'archive' }, onclick: () => afterRemove(archiveItems(app, type, selectedIds)) }),
        button({ label: 'Cancelar', ariaLabel: 'Cancelar os itens selecionados', icon: 'x-circle', size: 'sm', title: 'Marcar como canceladas', attrs: { 'data-bulk': 'cancel' }, onclick: () => afterRemove(cancelItems(app, type, selectedIds)) }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Estados vazios
// ---------------------------------------------------------------------------

function focusQuickAdd(ev) {
  const root = ev.currentTarget.closest('.v-backlog');
  const input = root ? root.querySelector('.v-backlog-add .en-quickadd-input') : null;
  if (input) input.focus();
}

function emptyBacklog(type) {
  return emptyState({
    icon: 'check-circle',
    title: 'Nada no backlog',
    text:
      type === 'task'
        ? 'Tudo o que foi registrado já está planejado. Anote aqui novas ideias e pedidos: eles esperam no backlog até você decidir quando fazer.'
        : 'Nenhuma demanda aguardando planejamento. Registre novas demandas acima para priorizá-las depois.',
    action: button({ label: type === 'task' ? 'Registrar no backlog' : 'Registrar demanda', icon: 'plus', variant: 'primary', size: 'sm', attrs: { 'data-action': 'empty-add' }, onclick: focusQuickAdd }),
    class: 'v-backlog-empty is-positive',
  });
}

function emptyFiltered(ctx, total, type) {
  return emptyState({
    icon: 'search',
    title: 'Nenhum item corresponde aos filtros',
    text: `Há ${countLabel(total, type)} no backlog, mas nenhuma com os filtros atuais.`,
    action: button({
      label: 'Limpar filtros',
      icon: 'x',
      size: 'sm',
      attrs: { 'data-action': 'clear-filters' },
      onclick: () => ctx.setState({ filters: normalizeFilters(null), lens: null, limit: null }),
    }),
    class: 'v-backlog-empty',
  });
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

function render(app, ctx) {
  const st = normalizeState(ctx.state);
  const type = st.mode === 'demands' ? 'demand' : 'task';
  const all = scopedItems(app, type);
  const counts = { tasks: type === 'task' ? all.length : scopedItems(app, 'task').length, demands: type === 'demand' ? all.length : scopedItems(app, 'demand').length };
  const filtered = applyViewFilters(app, all, st.filters, type);
  const stats = computeStats(app, filtered, type);
  const shown = applyLens(app, filtered, st.lens, type);
  const groupKind = type === 'task' ? st.group : st.demandGroup;
  const groups = buildGroups(app, shown, groupKind, type, st.sort);
  for (const group of groups) group.ids = group.items.map((item) => item.id);

  const collapseKey = (key) => `${type}:${groupKind}:${key}`;
  const shownIds = groups.flatMap((g) => g.ids);
  const shownSet = new Set(shownIds);
  const selectedIds = st.selected.filter((id) => shownSet.has(id));
  const selectedSet = new Set(selectedIds);

  const suggestions = new Map();
  if (type === 'task' && shown.length) {
    for (const s of app.sel.prioritySuggestions()) if (shownSet.has(s.taskId)) suggestions.set(s.taskId, s);
  }

  const planned = statusIdOf(app, 'planned');
  const view = {
    type,
    groupKind,
    selectedSet,
    suggestions,
    addingIn: st.addingIn,
    plannedLabel: planned ? app.sel.status(planned).label : 'Não iniciada',
    dnd: !ctx.isMobile && st.sort === 'manual' && (type === 'demand' || groupKind === 'demand'),
    canReorder: st.sort === 'manual' && (type === 'demand' || groupKind === 'demand'),
    isCollapsed: (key) => st.collapsed[collapseKey(key)] === true,
    toggleCollapsed: (key) =>
      ctx.setState((prev) => {
        const next = { ...(prev.collapsed && typeof prev.collapsed === 'object' ? prev.collapsed : {}) };
        if (next[collapseKey(key)]) delete next[collapseKey(key)];
        else next[collapseKey(key)] = true;
        return { collapsed: next };
      }),
    toggleAdding: (addKey, groupKey) =>
      ctx.setState((prev) => {
        const collapsed = { ...(prev.collapsed && typeof prev.collapsed === 'object' ? prev.collapsed : {}) };
        delete collapsed[collapseKey(groupKey)];
        return { addingIn: prev.addingIn === addKey ? null : addKey, collapsed };
      }),
    toggle: (id, { range = false } = {}) =>
      ctx.setState((prev) => {
        const current = normalizeState(prev).selected;
        const set = new Set(current);
        const order = orderedIds(groups.filter((g) => st.collapsed[collapseKey(g.key)] !== true), null);
        const anchor = typeof prev.anchorId === 'string' ? prev.anchorId : null;
        if (range && anchor && anchor !== id && order.includes(anchor) && order.includes(id)) {
          const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
          const turnOn = !set.has(id);
          for (const item of order.slice(a, b + 1)) {
            if (turnOn) set.add(item);
            else set.delete(item);
          }
        } else if (set.has(id)) set.delete(id);
        else set.add(id);
        return { selected: [...set], anchorId: id };
      }),
    selectMany: (ids, on) =>
      ctx.setState((prev) => {
        const set = new Set(normalizeState(prev).selected);
        for (const id of ids) {
          if (on) set.add(id);
          else set.delete(id);
        }
        return { selected: [...set] };
      }),
    unselect: (id) => ctx.setState((prev) => ({ selected: normalizeState(prev).selected.filter((x) => x !== id) })),
  };

  let body;
  if (all.length === 0) body = emptyBacklog(type);
  else if (shown.length === 0) body = emptyFiltered(ctx, all.length, type);
  else {
    const limit = rowLimit(ctx.state);
    const page = paginateGroups(groups, limit, view.isCollapsed);
    body = h(
      'div',
      { class: cx('v-backlog-groups', `group-${groupKind}`, view.dnd && 'has-dnd'), 'data-groups': groupKind },
      page.groups.map((group) => groupSection(app, group, view)),
      page.hidden > 0 ? moreView(ctx, limit, page.hidden) : null,
    );
  }

  return h(
    'div',
    {
      class: cx('v-backlog', ctx.isMobile && 'is-mobile', selectedIds.length > 0 && 'has-selection'),
      'data-mode': st.mode,
      'data-type': type,
      // Esc limpa a seleção (quando não há painel aberto e o foco não está num campo)
      onkeydown: (ev) => {
        if (ev.key !== 'Escape' || !selectedIds.length || ev.defaultPrevented) return;
        const target = ev.target;
        if (target && typeof target.closest === 'function' && target.closest('input, textarea, select, [contenteditable="true"]')) return;
        if (app.ui && typeof app.ui.panel === 'function' && app.ui.panel()) return;
        ev.preventDefault();
        ev.stopPropagation();
        ctx.setState({ selected: [], anchorId: null });
      },
    },
    h(
      'div',
      { class: 'v-backlog-inner' },
      headerView(app, st, ctx, counts),
      all.length ? summaryView(app, st, ctx, stats, type) : null,
      quickAddView(app, st, ctx, type),
      all.length
        ? filterBar(app, {
            filters: st.filters,
            onchange: (next) => ctx.setState({ filters: next, anchorId: null, limit: null }),
            type,
            fields: FILTER_FIELDS,
            count: { shown: shown.length, total: all.length },
            extra: [groupButton(st, ctx, type), sortButton(st, ctx)],
          })
        : null,
      body,
      selectedIds.length ? actionBar(app, ctx, type, selectedIds, shownIds) : null,
    ),
  );
}

export default {
  id: 'backlog',
  path: '/backlog',
  title: 'Backlog',
  icon: 'inbox',
  order: 70,
  section: 'views',
  /** Número de tarefas no backlog (respeita o filtro global de projeto). */
  badge(app) {
    return backlogBadge(app);
  },
  /** Ao entrar, a lista volta à primeira página. */
  onEnter(app, ctx) {
    if (ctx && ctx.state && ctx.state.limit) ctx.setState({ limit: null });
  },
  render,
};
