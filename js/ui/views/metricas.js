// Visualização "Métricas" — indicadores operacionais (seção 11 do pedido).
//
// Todos os números vêm de app.sel.metrics() → computeMetrics (js/domain/metrics.js), que reconstrói o passado a
// partir do histórico de alterações (activity_log) — nunca só do status atual. A tela chama o seletor no máximo
// duas vezes por desenho (período atual e período anterior, para as variações); o seletor memoriza o resultado.
//
// Estado da tela (ctx.state, salvo por aparelho):
//   preset     '7d' | '30d' | '90d' | 'month' | 'lastMonth' | 'year' | 'custom'
//   from, to   datas do período personalizado ('YYYY-MM-DD')
//   projectId  null = todos; '' = sem projeto; id (o escopo global de projeto tem precedência)
//   demandId   null = todas; id (só vale se a demanda for do projeto escolhido)
//   statusIds  lista de status (filtra os números "de situação")
//
// Peças puras (períodos, formatação, variações, CSV, impedimentos): ./metricas/model.js; cartões e seções:
// ./metricas/cards.js e ./metricas/sections.js.

import { formatDate, isoToDateStr } from '../../core/dates.js';
import { cx, h } from '../../core/dom.js';
import { formatNumber } from '../../core/format.js';
import { button, dateInput } from '../kit/controls.js';
import { countBadge, emptyState, statusBadge } from '../kit/display.js';
import { icon } from '../kit/icons.js';
import { openMenu } from '../kit/overlays.js';
import { EMPTY_CHOICE, pickFromList } from '../kit/pickers.js';
import { handleError, notify, projectDot } from '../shared/entity.js';
import { deltaMaker } from './metricas/cards.js';
import { blockingSection, capacitySection, deadlinesSection, productivitySection } from './metricas/sections.js';
import {
  PERIOD_PRESETS,
  firstActivityDate,
  formatRange,
  hasAnyData,
  longestImpediments,
  metricsCsvRows,
  presetLabel,
  resolvePeriod,
  toCsv,
} from './metricas/model.js';

const NO_PROJECT = 'Sem projeto';
const IMPEDIMENT_LIMIT = 6;

// ---------------------------------------------------------------------------
// Seleção (período + filtros) a partir do estado da tela
// ---------------------------------------------------------------------------

function scopeProjectId(app) {
  try {
    const id = app.ui && app.ui.scope ? app.ui.scope.projectId : null;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** Projeto "dono" de uma demanda para o filtro: id do projeto existente ou '' (sem projeto). */
function demandProjectKey(app, demand) {
  return demand && demand.project_id && app.sel.project(demand.project_id) ? demand.project_id : '';
}

/**
 * Filtros efetivos: o escopo global manda no projeto; ids que sumiram (excluídos, de outro projeto) são ignorados.
 * @returns {{ scoped: boolean, projectId: string|null, demandId: string|null, statusIds: string[], active: boolean }}
 */
function resolveSelection(app, state) {
  const scoped = scopeProjectId(app);
  let projectId = scoped;
  if (projectId === null) {
    const saved = state.projectId;
    if (saved === '') projectId = '';
    else if (typeof saved === 'string' && saved && app.sel.project(saved)) projectId = saved;
  }
  let demandId = typeof state.demandId === 'string' && state.demandId ? state.demandId : null;
  if (demandId) {
    const demand = app.sel.demand(demandId);
    if (!demand || (projectId !== null && demandProjectKey(app, demand) !== projectId)) demandId = null;
  }
  const known = new Set(app.sel.statuses().map((s) => s.id));
  const statusIds = (Array.isArray(state.statusIds) ? state.statusIds : []).filter((id) => typeof id === 'string' && known.has(id));
  const active = (!scoped && projectId !== null) || demandId !== null || statusIds.length > 0;
  return { scoped: scoped !== null, projectId, demandId, statusIds, active };
}

function metricsFilters(sel) {
  return { projectId: sel.projectId, demandId: sel.demandId || undefined, statusIds: sel.statusIds.length ? sel.statusIds : undefined };
}

function projectName(app, projectId) {
  if (projectId === null) return null;
  if (projectId === '') return NO_PROJECT;
  const p = app.sel.project(projectId);
  return p ? p.name || 'Projeto sem nome' : 'Projeto removido';
}

function statusNames(app, ids) {
  return ids.map((id) => app.sel.status(id).label || id);
}

// ---------------------------------------------------------------------------
// Barra de controles
// ---------------------------------------------------------------------------

function toolButton({ id, iconName, label, value, count, active, disabled, title, onclick }) {
  return h(
    'button',
    {
      type: 'button',
      key: `tool-${id}`,
      class: cx('btn', 'btn-sm', 'fb-btn', 'v-metricas-tool', active && 'is-active'),
      'data-mx': id,
      'aria-haspopup': disabled ? null : id === 'period' ? 'menu' : 'dialog',
      disabled: !!disabled,
      title: title || null,
      onclick,
    },
    icon(iconName, { size: 14, class: 'fb-btn-icon' }),
    h('span', { class: 'btn-label' }, value ? h('span', null, `${label}: `, h('strong', { class: 'fb-btn-value' }, value)) : label),
    count ? countBadge(count, { tone: 'accent', class: 'fb-btn-count' }) : null,
    disabled ? icon('lock', { size: 12, class: 'fb-btn-caret' }) : icon('chevron-down', { size: 12, class: 'fb-btn-caret' }),
  );
}

function markExpanded(anchor) {
  if (!anchor || typeof anchor.setAttribute !== 'function') return () => {};
  anchor.setAttribute('aria-expanded', 'true');
  return () => anchor.removeAttribute('aria-expanded');
}

function openPeriodMenu(app, ctx, period, anchor) {
  const today = app.clock.today();
  openMenu(
    anchor,
    PERIOD_PRESETS.map((preset) => {
      const range = preset.id === 'custom' ? null : resolvePeriod({ preset: preset.id }, today);
      return {
      label: preset.label,
      checked: period.preset === preset.id,
      hint: range ? formatRange(range.from, range.to) : null,
      onclick: () => {
        if (preset.id === 'custom') {
          // começa do período que estava na tela: o usuário só ajusta as pontas
          ctx.setState({ preset: 'custom', from: period.from, to: period.to });
        } else {
          ctx.setState({ preset: preset.id });
        }
      },
      };
    }),
    { title: 'Período', minWidth: 330, onclose: markExpanded(anchor) },
  );
}

async function pickProject(app, ctx, selection, anchor) {
  const unmark = markExpanded(anchor);
  try {
    const items = [
      { id: '__all', label: 'Todos os projetos', icon: 'layers' },
      { id: '__none', label: NO_PROJECT, icon: 'circle-dashed' },
      ...app.sel.projects().map((p) => ({ id: p.id, label: p.name || 'Projeto sem nome', hint: p.code || null, icon: projectDot(p) })),
    ];
    const current = selection.projectId === null ? '__all' : selection.projectId === '' ? '__none' : selection.projectId;
    const chosen = await pickFromList(anchor, { items, current, title: 'Projeto', placeholder: 'Buscar projeto…' });
    if (chosen === null) return;
    const projectId = chosen === '__all' ? null : chosen === '__none' ? '' : chosen;
    const patch = { projectId };
    // A demanda escolhida só continua se for do novo projeto.
    if (selection.demandId && projectId !== null) {
      const demand = app.sel.demand(selection.demandId);
      if (!demand || demandProjectKey(app, demand) !== projectId) patch.demandId = null;
    }
    ctx.setState(patch);
  } catch (err) {
    handleError(app, err);
  } finally {
    unmark();
  }
}

async function pickDemand(app, ctx, selection, anchor) {
  const unmark = markExpanded(anchor);
  try {
    const projects = app.sel.projectsById();
    const list = app.sel.demands(selection.projectId === null ? undefined : { projectId: selection.projectId });
    const items = list.map((d) => {
      const p = d.project_id ? projects.get(d.project_id) : null;
      return { id: d.id, label: d.name || 'Demanda sem nome', hint: app.sel.code('demand', d), group: p ? p.name : NO_PROJECT, icon: projectDot(p) };
    });
    const chosen = await pickFromList(anchor, {
      items,
      current: selection.demandId,
      allowEmpty: true,
      emptyLabel: 'Todas as demandas',
      title: selection.projectId === null ? 'Demanda' : `Demanda — ${projectName(app, selection.projectId)}`,
      placeholder: 'Buscar demanda…',
      width: 320,
    });
    if (chosen === null) return;
    ctx.setState({ demandId: chosen === EMPTY_CHOICE ? null : chosen });
  } catch (err) {
    handleError(app, err);
  } finally {
    unmark();
  }
}

async function pickStatuses(app, ctx, selection, anchor) {
  const unmark = markExpanded(anchor);
  try {
    const items = app.sel.statuses().map((s) => ({ id: s.id, label: s.label || s.id, icon: statusBadge(s, { compact: true }) }));
    const chosen = await pickFromList(anchor, { items, current: selection.statusIds, multiple: true, title: 'Status', placeholder: 'Buscar status…', width: 260 });
    if (chosen === null) return;
    ctx.setState({ statusIds: chosen });
  } catch (err) {
    handleError(app, err);
  } finally {
    unmark();
  }
}

function toolbar(app, ctx, period, selection) {
  const today = app.clock.today();
  const isCustom = period.preset === 'custom';
  const project = projectName(app, selection.projectId);
  const demand = selection.demandId ? app.sel.demand(selection.demandId) : null;
  const statusLabels = statusNames(app, selection.statusIds);
  const setRange = (which) => (value) => {
    if (!value) return;
    const next = { from: period.from, to: period.to, [which]: value };
    if (next.from > next.to) {
      if (which === 'from') next.to = value;
      else next.from = value;
    }
    ctx.setState({ preset: 'custom', from: next.from, to: next.to });
  };
  return h(
    'div',
    { class: 'v-metricas-toolbar', role: 'toolbar', 'aria-label': 'Período e filtros das métricas' },
    toolButton({
      id: 'period',
      iconName: 'calendar',
      label: 'Período',
      value: presetLabel(period.preset),
      active: false,
      title: `Período: ${formatRange(period.from, period.to)}`,
      onclick: (ev) => openPeriodMenu(app, ctx, period, ev.currentTarget),
    }),
    isCustom
      ? h(
          'span',
          { key: 'custom', class: 'v-metricas-custom', 'data-mx': 'custom' },
          dateInput({ value: period.from, size: 'sm', ariaLabel: 'Início do período', max: today, onchange: setRange('from'), attrs: { 'data-mx': 'from' } }),
          h('span', { class: 'v-metricas-custom-sep', 'aria-hidden': 'true' }, 'até'),
          dateInput({ value: period.to, size: 'sm', ariaLabel: 'Fim do período', onchange: setRange('to'), attrs: { 'data-mx': 'to' } }),
        )
      : null,
    h('span', { key: 'sep', class: 'v-metricas-tool-sep', 'aria-hidden': 'true' }),
    toolButton({
      id: 'project',
      iconName: 'folder',
      label: 'Projeto',
      value: project,
      active: project !== null && !selection.scoped,
      disabled: selection.scoped,
      title: selection.scoped ? `Projeto definido pelo escopo global: ${project}. Para ver todos, limpe o escopo na barra superior.` : 'Filtrar por projeto',
      onclick: (ev) => pickProject(app, ctx, selection, ev.currentTarget),
    }),
    toolButton({
      id: 'demand',
      iconName: 'list',
      label: 'Demanda',
      value: demand ? demand.name || app.sel.code('demand', demand) : null,
      active: !!demand,
      title: demand ? `Demanda: ${demand.name}` : 'Filtrar por demanda',
      onclick: (ev) => pickDemand(app, ctx, selection, ev.currentTarget),
    }),
    toolButton({
      id: 'status',
      iconName: 'circle-half',
      label: 'Status',
      value: statusLabels.length === 1 ? statusLabels[0] : null,
      count: statusLabels.length > 1 ? statusLabels.length : 0,
      active: statusLabels.length > 0,
      title: statusLabels.length
        ? `Status: ${statusLabels.join(', ')} — vale para os números de situação (pendentes, WIP, atrasadas, bloqueadas)`
        : 'Filtrar por status — vale para os números de situação (pendentes, WIP, atrasadas, bloqueadas)',
      onclick: (ev) => pickStatuses(app, ctx, selection, ev.currentTarget),
    }),
    selection.active
      ? button({ label: 'Limpar filtros', size: 'sm', variant: 'ghost', class: 'v-metricas-clear', attrs: { 'data-mx': 'clear' }, onclick: () => ctx.setState({ projectId: null, demandId: null, statusIds: [] }) })
      : null,
  );
}

// ---------------------------------------------------------------------------
// Exportação
// ---------------------------------------------------------------------------

/** Nome do arquivo exportado. */
export function exportFileName(period) {
  return `metricas_${period.from}_a_${period.to}.csv`;
}

/** Texto CSV completo (com BOM) das métricas da seleção atual. */
export function buildExport(app, m, period, selection) {
  const demand = selection.demandId ? app.sel.demand(selection.demandId) : null;
  const rows = metricsCsvRows(m, {
    from: period.from,
    to: period.to,
    project: projectName(app, selection.projectId),
    demand: demand ? `${app.sel.code('demand', demand)} ${demand.name || ''}`.trim() : null,
    statuses: statusNames(app, selection.statusIds).join(', ') || null,
  });
  return `﻿${toCsv(rows)}`;
}

function exportCsv(app, m, period, selection, anchor) {
  try {
    const text = buildExport(app, m, period, selection);
    const doc = anchor && anchor.ownerDocument ? anchor.ownerDocument : document;
    const win = doc.defaultView || window;
    const blob = new win.Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = win.URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = exportFileName(period);
    link.style.display = 'none';
    doc.body.appendChild(link);
    link.click();
    link.remove();
    win.setTimeout(() => win.URL.revokeObjectURL(url), 2000);
    notify(app, `Métricas exportadas (${link.download})`, { tone: 'success' });
  } catch (err) {
    handleError(app, err);
  }
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

function header(app, period, compareText, exportNode) {
  return h(
    'div',
    { class: 'v-metricas-head' },
    h(
      'div',
      { class: 'v-metricas-titles' },
      h('h2', { class: 'v-metricas-title' }, 'Indicadores operacionais'),
      h(
        'p',
        { class: 'v-metricas-period', 'data-mx': 'period-line' },
        h('span', { class: 'v-metricas-period-range tabular' }, formatRange(period.from, period.to)),
        h('span', { class: 'v-metricas-dot', 'aria-hidden': 'true' }, '·'),
        h('span', null, period.days === 1 ? '1 dia' : `${formatNumber(period.days)} dias`),
        h('span', { class: 'v-metricas-dot', 'aria-hidden': 'true' }, '·'),
        h('span', null, 'calculado a partir do histórico de alterações'),
      ),
      compareText ? h('p', { class: 'v-metricas-compare' }, compareText) : null,
    ),
    exportNode,
  );
}

function render(app, ctx) {
  const state = ctx.state || {};
  const today = app.clock.today();
  const period = resolvePeriod(state, today);
  const selection = resolveSelection(app, state);
  const activity = app.store.all('activity_log');

  // Sem histórico nenhum: as métricas ainda não têm de onde sair.
  if (!activity.length) {
    return h(
      'div',
      { class: cx('v-metricas', ctx.isMobile && 'is-mobile'), 'data-state': 'no-history' },
      header(app, period, null, null),
      emptyState({
        icon: 'chart',
        title: 'As métricas aparecem conforme você usa o sistema',
        text: 'Cada criação, mudança de status, prazo e apontamento de tempo entra no histórico — é dele que saem os indicadores. Crie uma tarefa para começar.',
        action: button({ label: 'Nova tarefa', icon: 'plus', variant: 'primary', attrs: { 'data-mx': 'new-task' }, onclick: () => app.ui && app.ui.quickCreate && app.ui.quickCreate('task', {}) }),
        class: 'v-metricas-empty',
      }),
    );
  }

  const filters = metricsFilters(selection);
  const m = app.sel.metrics({ range: { from: period.from, to: period.to }, filters });
  const firstDay = firstActivityDate(activity, isoToDateStr);
  const comparable = firstDay !== null && firstDay <= period.previous.to;
  const prev = comparable ? app.sel.metrics({ range: { from: period.previous.from, to: period.previous.to }, filters }) : null;
  const compare = formatRange(period.previous.from, period.previous.to);
  const compareText = comparable ? `Variações em relação a ${compare}` : 'Sem histórico no período anterior para comparar';
  const asOfText = m.asOfDate >= today ? 'agora' : `em ${formatDate(m.asOfDate, 'short', today)} (fim do período)`;

  const exportNode = button({
    label: 'Exportar',
    icon: 'download',
    size: 'sm',
    class: 'v-metricas-export',
    title: 'Baixar os indicadores da seleção atual em CSV',
    attrs: { 'data-mx': 'export' },
    onclick: (ev) => exportCsv(app, m, period, selection, ev.currentTarget),
  });

  const hasData = hasAnyData(m);
  let body;
  if (!hasData) {
    body = selection.active
      ? emptyState({
          icon: 'filter',
          title: 'Nada encontrado com esses filtros',
          text: 'Não há atividade para o projeto, a demanda ou os status escolhidos neste período.',
          action: button({ label: 'Limpar filtros', attrs: { 'data-mx': 'empty-clear' }, onclick: () => ctx.setState({ projectId: null, demandId: null, statusIds: [] }) }),
          class: 'v-metricas-empty',
        })
      : emptyState({
          icon: 'calendar',
          title: 'Sem atividade neste período',
          text: 'Nenhuma tarefa foi concluída, apontada ou ficou em aberto entre essas datas.',
          action:
            period.preset !== 'year'
              ? button({ label: period.preset === '90d' ? 'Ver este ano' : 'Ver os últimos 90 dias', attrs: { 'data-mx': 'empty-widen' }, onclick: () => ctx.setState({ preset: period.preset === '90d' ? 'year' : '90d' }) })
              : null,
          class: 'v-metricas-empty',
        });
  } else {
    const delta = deltaMaker(m, prev, compare);
    const scope = { projectId: selection.projectId, demandId: selection.demandId, statusIds: new Set(selection.statusIds) };
    const imp = longestImpediments({
      tasks: app.sel.tasks(),
      statuses: app.sel.statuses(),
      eventsIndex: app.sel.eventsIndex(),
      nowIso: app.clock.nowIso(),
      limit: IMPEDIMENT_LIMIT,
      accept: (task) => {
        if (scope.statusIds.size && !scope.statusIds.has(task.status)) return false;
        if (scope.projectId !== null && (app.sel.projectIdOf('task', task) || '') !== scope.projectId) return false;
        if (scope.demandId !== null) {
          const demand = app.sel.demandOf(task);
          if (!demand || demand.id !== scope.demandId) return false;
        }
        return true;
      },
    });
    body = h(
      'div',
      { class: 'v-metricas-sections' },
      productivitySection(m, period, delta),
      deadlinesSection(m, delta, asOfText),
      capacitySection(m, delta, asOfText),
      blockingSection(app, m, delta, asOfText, imp),
    );
  }

  return h(
    'div',
    { class: cx('v-metricas', ctx.isMobile && 'is-mobile'), 'data-state': hasData ? 'data' : 'empty', 'data-from': period.from, 'data-to': period.to },
    header(app, period, compareText, exportNode),
    toolbar(app, ctx, period, selection),
    body,
  );
}

export default {
  id: 'metricas',
  path: '/metricas',
  title: 'Métricas',
  icon: 'chart',
  order: 100,
  section: 'analysis',
  /** Indicadores do período escolhido, calculados a partir do histórico. */
  render(app, ctx) {
    return render(app, ctx);
  },
};
