// Painel lateral de edição de DEMANDA (seções 2, 3, 6, 8 e 13 do pedido).
//
//   export default { title(app, id), render(app, id, ctx) }      ctx = { state, setState(patch), close() }
//
// Tudo salva na hora pelos comandos. Abas: Detalhes | Tarefas | Histórico.
// Estado do painel (ctx.state): tab, useWeights (coluna de pesos ligada), collapsed (tarefas recolhidas).

import { cx, h } from '../../core/dom.js';
import { formatDateTime } from '../../core/dates.js';
import { plural } from '../../core/format.js';
import { dedupeCreated } from '../../domain/history.js';
import { isCountable, isWeightDefined } from '../../domain/progress.js';
import { isClosedCategory } from '../../domain/statuses.js';
import { formatDuration } from '../../domain/timetracking.js';
import { button, formatDurationText, iconButton, inlineEdit, numberInput, switchInput, tabs } from '../kit/controls.js';
import { alertBox, badge, progressBar } from '../kit/display.js';
import { sortableItem, sortableList } from '../kit/dnd.js';
import { icon } from '../kit/icons.js';
import { confirmDialog } from '../kit/overlays.js';
import { saveDemandAsTemplate } from '../templates.js';
import { openScheduleDialog } from '../schedule.js';
import { EMPTY_CHOICE, pickFromList } from '../kit/pickers.js';
import {
  dueControl,
  entityActions,
  estimateControl,
  handleError,
  openEntityMenu,
  ownerControl,
  priorityControl,
  progressSummary,
  projectControl,
  quickAddRow,
  statusControl,
  tagsControl,
  taskRow,
} from '../shared/entity.js';
import {
  actualStartField,
  archivedAlert,
  followUpRow,
  historyTab,
  impedimentAlert,
  longTextField,
  notFound,
  notesSection,
  panelContext,
  panelHeader,
  propRow,
  safely,
  saveFields,
  section,
} from './task-panel.js';
import { linksSection } from './links-section.js';

const DEMAND_TABS = ['details', 'tasks', 'history'];
const nameOf = (entity) => (entity && typeof entity.name === 'string' && entity.name.trim() ? entity.name.trim() : 'Sem nome');

// ---------------------------------------------------------------------------
// Cabeçalho e progresso
// ---------------------------------------------------------------------------

function progressBlock(app, demand) {
  const { progress, details, weightText } = progressSummary(app, demand.id);
  const text = progress.counted ? `${progress.completed} de ${plural(progress.counted, 'tarefa concluída', 'tarefas concluídas')}` : 'Nenhuma tarefa contável';
  const extras = [];
  if (progress.inProgress) extras.push(badge(`${progress.inProgress} em andamento`, { tone: 'info' }));
  for (const item of details) extras.push(badge(item, { tone: 'neutral' }));
  return h(
    'div',
    { class: 'pn-progress' },
    h(
      'div',
      { class: 'pn-progress-top' },
      h('span', { class: 'pn-progress-pct tabular' }, progress.percent === null ? '—' : `${progress.percent}%`),
      h('span', { class: 'pn-progress-text' }, text),
    ),
    progressBar(progress.value, { title: [text, ...details].join(' · ') }),
    extras.length ? h('div', { class: 'pn-progress-extra' }, extras) : null,
    weightText ? alertBox({ tone: 'warning', text: weightText, class: 'pn-weight-warning' }) : null,
  );
}

// ---------------------------------------------------------------------------
// Detalhes
// ---------------------------------------------------------------------------

/** Soma das estimativas das tarefas (a de uma tarefa sem estimativa vem das subtarefas dela). */
function tasksEstimate(app, demand) {
  let total = 0;
  let any = false;
  for (const task of app.sel.topTasks(demand.id)) {
    if (app.sel.status(task.status).category === 'cancelled') continue;
    if (Number.isFinite(task.estimate_minutes) && task.estimate_minutes > 0) {
      total += task.estimate_minutes;
      any = true;
      continue;
    }
    for (const sub of app.sel.subtasks(task.id)) {
      if (app.sel.status(sub.status).category === 'cancelled') continue;
      if (Number.isFinite(sub.estimate_minutes) && sub.estimate_minutes > 0) {
        total += sub.estimate_minutes;
        any = true;
      }
    }
  }
  return any ? total : null;
}

function categoryControl(app, demand) {
  const onclick = async (ev) => {
    const chosen = await pickFromList(ev.currentTarget, {
      items: app.sel.categories().map((c) => ({ id: c, label: c, icon: 'folder' })),
      current: demand.category || null,
      allowEmpty: true,
      emptyLabel: 'Sem categoria',
      placeholder: 'Buscar ou criar categoria…',
      title: 'Categoria',
      create: { label: (text) => `Criar categoria “${text}”`, oncreate: (text) => text.trim() },
    });
    if (chosen === null) return;
    saveFields(app, 'demand', demand.id, { category: chosen === EMPTY_CHOICE ? null : chosen });
  };
  return h(
    'button',
    { type: 'button', class: cx('en-picker', 'pn-category', !demand.category && 'is-empty'), onclick, title: 'Alterar categoria' },
    icon('folder', { size: 14 }),
    h('span', { class: 'en-picker-text' }, demand.category || 'Sem categoria'),
  );
}

function detailsTab(app, demand, pctx) {
  const sum = tasksEstimate(app, demand);
  const tracked = app.sel.trackedSecondsOfDemand(demand.id);
  return h(
    'div',
    { class: 'pn-tab pn-details', key: 'details' },
    h(
      'div',
      { class: 'pn-next' },
      h('span', { class: 'pn-next-label' }, icon('target', { size: 14 }), 'Próxima ação'),
      inlineEdit({
        value: demand.next_action || '',
        placeholder: 'Qual é o próximo passo concreto?',
        ariaLabel: 'Próxima ação',
        allowEmpty: true,
        class: 'pn-next-edit',
        onsave: (text) => saveFields(app, 'demand', demand.id, { next_action: text || null }),
      }),
    ),
    h(
      'div',
      { class: 'pn-props' },
      propRow('Status', statusControl(app, 'demand', demand, { soft: true })),
      propRow('Prioridade', priorityControl(app, 'demand', demand, { showLabel: true })),
      propRow('Projeto', projectControl(app, demand)),
      propRow('Responsável', ownerControl(app, 'demand', demand)),
      propRow('Prazo', dueControl(app, 'demand', demand, { placeholder: 'Sem prazo' })),
      followUpRow(app, 'demand', demand),
      propRow('Início planejado', dueControl(app, 'demand', demand, { field: 'planned_start', placeholder: 'Sem data' })),
      propRow('Início real', actualStartField(app, 'demand', demand)),
      propRow('Conclusão', h('span', { class: cx('pn-static tabular', !demand.completed_at && 'is-empty') }, demand.completed_at ? formatDateTime(demand.completed_at) : '—')),
      propRow('Criação', h('span', { class: cx('pn-static tabular', !demand.created_at && 'is-empty') }, formatDateTime(demand.created_at) || '—')),
      propRow('Estimativa', estimateControl(app, 'demand', demand), { hint: sum === null ? 'Tarefas sem estimativa' : `Soma das tarefas: ${formatDurationText(sum)}` }),
      propRow('Tempo gasto', h('span', { class: 'pn-static tabular' }, formatDuration(tracked)), { hint: 'Soma das tarefas e subtarefas' }),
      propRow('Categoria', categoryControl(app, demand)),
      propRow('Tags', tagsControl(app, 'demand', demand), { full: true }),
    ),
    section('Objetivo', { icon: 'target', key: 'objective' }, longTextField(app, 'demand', demand, 'objective', { placeholder: 'Por que esta demanda existe? Qual resultado se espera?', ariaLabel: 'Objetivo' })),
    section('Entregáveis', { icon: 'check-circle', key: 'deliverables' }, longTextField(app, 'demand', demand, 'deliverables', { placeholder: 'O que será entregue ao final?', ariaLabel: 'Entregáveis' })),
    section('Descrição', { icon: 'file-text', key: 'description' }, longTextField(app, 'demand', demand, 'description', { placeholder: 'Adicione uma descrição…', ariaLabel: 'Descrição', rows: 3 })),
    linksSection(app, 'demand', demand.id, pctx),
    notesSection(app, 'demand', demand.id),
  );
}

// ---------------------------------------------------------------------------
// Tarefas
// ---------------------------------------------------------------------------

async function toggleWeights(app, demand, on, tops, setState) {
  if (on) {
    setState({ useWeights: true });
    return;
  }
  const weighted = tops.filter((t) => isWeightDefined(t.weight));
  if (weighted.length) {
    const ok = await confirmDialog({
      title: 'Remover os pesos?',
      message: `${plural(weighted.length, 'tarefa tem', 'tarefas têm')} peso definido. Ao desligar, os pesos são apagados e o progresso volta a ser dividido igualmente.`,
      confirmLabel: 'Remover pesos',
      danger: true,
    });
    if (!ok) return;
    try {
      for (const task of weighted) app.cmd.updateTask(task.id, { weight: null });
    } catch (err) {
      handleError(app, err);
    }
  }
  setState({ useWeights: false });
}

function weightColumn(app, effective) {
  return (task) => {
    const auto = effective.get(task.id);
    return numberInput({
      value: isWeightDefined(task.weight) ? task.weight : null,
      min: 0,
      max: 100,
      step: 5,
      suffix: '%',
      size: 'sm',
      ariaLabel: `Peso de “${nameOf(task)}” (%)`,
      placeholder: auto === undefined ? '—' : String(auto).replace('.', ','),
      class: 'pn-weight-input',
      onchange: (n) => saveFields(app, 'task', task.id, { weight: n && n > 0 ? n : null }),
    });
  };
}

function tasksTab(app, demand, { state, setState }) {
  const tops = app.sel.topTasks(demand.id);
  const archivedCount = app.sel.topTasks(demand.id, { includeArchived: true }).length - tops.length;
  const useWeights = typeof state.useWeights === 'boolean' ? state.useWeights : tops.some((t) => isWeightDefined(t.weight));
  const collapsed = state.collapsed && typeof state.collapsed === 'object' ? state.collapsed : {};
  const progress = app.sel.demandProgress(demand.id);
  const effective = new Map(progress.items.map((it) => [it.id, Math.round(it.weight * 1000) / 10]));
  const statuses = app.sel.statuses();

  const topMove = ({ id, place }) => safely(app, () => app.cmd.moveTask(id, place));
  const subMove = ({ id, place }) => safely(app, () => app.cmd.moveTask(id, place));
  const baseColumns = ['grip', null, 'check', 'title', 'flags', 'status-compact', 'priority', 'due'];
  const rows = [];
  for (const task of tops) {
    const subs = app.sel.subtasks(task.id);
    const isCollapsed = collapsed[task.id] === true;
    const expandColumn = () =>
      subs.length
        ? iconButton({
            icon: isCollapsed ? 'chevron-right' : 'chevron-down',
            title: isCollapsed ? `Mostrar ${plural(subs.length, 'subtarefa', 'subtarefas')}` : 'Recolher subtarefas',
            size: 'sm',
            class: 'pn-expand',
            onclick: (ev) => {
              ev.stopPropagation();
              setState({ collapsed: { ...collapsed, [task.id]: !isCollapsed } });
            },
          })
        : h('span', { class: 'pn-expand-spacer' });
    const columns = baseColumns.map((c) => (c === null ? expandColumn : c));
    if (useWeights) columns.push(isCountable(task, statuses) ? weightColumn(app, effective) : () => h('span', { class: 'pn-weight-na', title: 'Fora do cálculo de progresso' }, '—'));
    columns.push('menu');
    rows.push(taskRow(app, task, { columns, class: 'pn-task-row', attrs: sortableItem({ type: 'task-top', id: task.id, onmove: topMove, handle: '.en-grip' }) }));
    if (!isCollapsed) {
      for (const sub of subs) {
        rows.push(
          taskRow(app, sub, {
            columns: ['grip', 'check', 'title', 'flags', 'status-compact', 'priority', 'due', 'menu'],
            indent: 1,
            class: 'pn-task-row is-sub',
            attrs: sortableItem({ type: `sub:${task.id}`, id: sub.id, onmove: subMove, handle: '.en-grip' }),
          }),
        );
      }
    }
  }

  const all = app.sel.allTasksOfDemand(demand.id).filter((t) => !app.sel.isHidden('task', t));
  const doneCount = all.filter((t) => app.sel.status(t.status).category === 'done').length;
  const estimate = tasksEstimate(app, demand);
  const tracked = app.sel.trackedSecondsOfDemand(demand.id);
  const weightSum = tops.reduce((sum, t) => sum + (isWeightDefined(t.weight) && isCountable(t, statuses) ? t.weight : 0), 0);

  return h(
    'div',
    { class: 'pn-tab pn-tasks', key: 'tasks' },
    h(
      'div',
      { class: 'pn-toolbar' },
      switchInput({ checked: useWeights, label: 'Usar pesos', onchange: (on) => toggleWeights(app, demand, on, tops, setState), class: 'pn-weights-toggle' }),
      useWeights ? h('span', { class: cx('pn-weight-sum tabular', Math.abs(weightSum - 100) > 0.01 && weightSum > 0 && 'is-off') }, `Pesos definidos: ${String(Math.round(weightSum * 10) / 10).replace('.', ',')}%`) : null,
      h('span', { class: 'pn-toolbar-spacer' }),
      tops.some((t) => app.sel.subtasks(t.id).length)
        ? button({
            label: Object.values(collapsed).some(Boolean) ? 'Expandir tudo' : 'Recolher tudo',
            size: 'sm',
            variant: 'ghost',
            onclick: () => {
              const any = Object.values(collapsed).some(Boolean);
              const next = {};
              if (!any) for (const t of tops) next[t.id] = true;
              setState({ collapsed: next });
            },
          })
        : null,
    ),
    rows.length
      ? h('div', { class: cx('pn-rows', 'pn-task-list', useWeights && 'has-weights'), ...sortableList({ type: 'task-top' }) }, rows)
      : h('div', { class: 'pn-empty-tasks' }, h('p', { class: 'pn-empty-line' }, 'Esta demanda ainda não tem tarefas. Digite abaixo para criar a primeira.')),
    quickAddRow(app, { type: 'task', defaults: { demand_id: demand.id }, placeholder: 'Adicionar tarefa', class: 'pn-quickadd' }),
    h(
      'div',
      { class: 'pn-tasks-foot' },
      h('span', null, plural(all.length, 'tarefa', 'tarefas')),
      h('span', null, `${doneCount} ${doneCount === 1 ? 'concluída' : 'concluídas'}`),
      estimate !== null ? h('span', null, `Estimativa: ${formatDurationText(estimate)}`) : null,
      h('span', null, `Tempo: ${formatDuration(tracked)}`),
      archivedCount > 0 ? h('span', { class: 'pn-muted' }, plural(archivedCount, 'arquivada', 'arquivadas')) : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------------

function renderDemand(app, id, ctx) {
  const pctx = panelContext(ctx);
  const demand = app.sel.demand(id);
  if (!demand) return notFound(app, 'demand', id, pctx.close);
  const status = app.sel.status(demand.status);
  const closed = isClosedCategory(status.category);
  const tab = DEMAND_TABS.includes(pctx.state.tab) ? pctx.state.tab : 'details';
  const code = app.sel.code('demand', demand);
  const taskCount = app.sel.topTasks(demand.id).length;
  const history = dedupeCreated(app.sel.history('demand', demand.id));
  const alerts = [archivedAlert(app, 'demand', demand), closed ? null : impedimentAlert(app, 'demand', demand)].filter(Boolean);

  return h(
    'div',
    { class: cx('pn', 'pn-demand', closed && 'is-closed'), key: `demand:${demand.id}`, dataset: { entity: `demand:${demand.id}` }, role: 'region', 'aria-label': `Demanda ${code} ${nameOf(demand)}`.trim() },
    panelHeader(app, {
      crumbs: h('div', { class: 'pn-crumbs' }, projectControl(app, demand, { compact: true })),
      close: pctx.close,
      actions: [
        button({
          label: closed ? 'Reabrir' : 'Concluir',
          icon: closed ? 'rotate-ccw' : 'check',
          size: 'sm',
          class: cx('pn-complete', status.category === 'done' && 'is-done'),
          onclick: () => entityActions.complete(app, 'demand', demand.id),
        }),
        iconButton({ icon: 'more-horizontal', title: 'Mais ações', onclick: (ev) => openEntityMenu(app, 'demand', demand.id, ev.currentTarget, { items: [{ label: 'Agendar datas vazias…', icon: 'calendar', onclick: () => openScheduleDialog(app, demand.id) }, { label: 'Salvar como modelo…', icon: 'copy', onclick: () => saveDemandAsTemplate(app, demand.id) }] }), class: 'pn-menu' }),
      ],
    }),
    h(
      'div',
      { class: 'pn-scroll' },
      h(
        'div',
        { class: 'pn-titlebar' },
        code ? h('span', { class: 'pn-code tabular' }, code) : null,
        h('span', { class: 'pn-kind' }, 'Demanda'),
        statusControl(app, 'demand', demand, { soft: true }),
      ),
      h(
        'div',
        { class: cx('pn-title', closed && 'is-closed') },
        inlineEdit({ value: demand.name, ariaLabel: 'Nome da demanda', placeholder: 'Sem nome', class: 'pn-title-edit', onsave: (name) => saveFields(app, 'demand', demand.id, { name }) }),
      ),
      progressBlock(app, demand),
      alerts.length ? h('div', { class: 'pn-alerts' }, alerts) : null,
      tabs({
        class: 'pn-tabs',
        active: tab,
        ariaLabel: 'Seções da demanda',
        onchange: (next) => pctx.setState({ tab: next }),
        tabs: [
          { id: 'details', label: 'Detalhes' },
          { id: 'tasks', label: 'Tarefas', count: taskCount || null },
          { id: 'history', label: 'Histórico', count: history.length || null },
        ],
      }),
      tab === 'tasks' ? tasksTab(app, demand, pctx) : tab === 'history' ? historyTab(app, 'demand', demand.id, pctx) : detailsTab(app, demand, pctx),
    ),
  );
}

/** Painel de demanda: { title(app, id), render(app, id, ctx) }. */
export default {
  /**
   * Título do painel.
   * @param {object} app
   * @param {string} id
   * @returns {string}
   */
  title(app, id) {
    const demand = app && app.sel ? app.sel.demand(id) : null;
    if (!demand) return 'Demanda';
    const code = app.sel.code('demand', demand);
    return code ? `${code} · ${nameOf(demand)}` : nameOf(demand);
  },

  /**
   * Desenha o painel (função pura de renderização; a casca aplica com morph).
   * @param {object} app
   * @param {string} id
   * @param {{ state: object, setState: (patch: object) => void, close: () => void }} ctx
   * @returns {HTMLElement}
   */
  render(app, id, ctx) {
    return renderDemand(app, id, ctx);
  },
};
