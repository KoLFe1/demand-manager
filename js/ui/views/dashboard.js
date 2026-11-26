// Visualização "Início" — painel operacional (seção 12 do pedido).
//
// Objetivo: em dez segundos o usuário sabe o que precisa de atenção agora. Mostra:
//   • cabeçalho com saudação, data de hoje e uma frase-resumo; cartões de número (Hoje, Atrasadas,
//     Em andamento, Bloqueadas/aguardando, Concluídas na semana) que levam à seção ou tela certa;
//   • coluna principal: Próximas ações (com os motivos e "Para destravar"), Minhas tarefas de hoje,
//     Atrasadas e Prioridades da semana;
//   • coluna lateral: Sugestões de prioridade, resumo da Semana, Próximos prazos, Demandas (em andamento ou
//     todas as abertas, com progresso e próxima ação editável) e Atividades bloqueadas.
//
// Estado da tela (ctx.state, salvo por dispositivo): `collapsed` e `expanded` ({ [seção]: true }),
// `demandFilter` ('active' | 'open') e `demandSort` ('deadline' | 'progress').
// Todo dado vem de ./dashboard/data.js (já recortado pelo escopo global de projeto e memorizado).

import { cx, h } from '../../core/dom.js';
import { MONTHS, formatDate, formatWeekRange, parseDate, weekdayIndex, WEEKDAYS_LONG, diffDays } from '../../core/dates.js';
import { formatPercent, plural } from '../../core/format.js';
import { button, segmented } from '../kit/controls.js';
import { emptyState, progressBar, statCard } from '../kit/display.js';
import { icon } from '../kit/icons.js';
import { demandRow, taskRow } from '../shared/entity.js';
import { digestButton } from '../digest.js';
import { dashboardData, overdueCount, sortDemandRows } from './dashboard/data.js';
import {
  actionRow,
  capped,
  demandProgressRow,
  isCollapsed,
  miniRow,
  moreToggle,
  quiet,
  sectionCard,
  setCollapsed,
  stuckRow,
  suggestionCard,
} from './dashboard/parts.js';

/** Quantos itens cada lista mostra antes de "Ver todas". */
export const CAPS = Object.freeze({ next: 6, unblock: 3, today: 8, overdue: 6, weekPriorities: 6, upcoming: 10, demands: 5, blocked: 6, suggestions: 3 });

/** Colunas das linhas padrão; no celular saem os indicadores e o status (que estão no painel e no ícone). */
const COLUMNS = Object.freeze({
  today: Object.freeze(['check', 'title', 'flags', 'status', 'priority', 'due', 'timer', 'menu']),
  todayMobile: Object.freeze(['check', 'title', 'priority', 'due', 'timer', 'menu']),
  tasks: Object.freeze(['check', 'title', 'flags', 'priority', 'due', 'menu']),
  tasksMobile: Object.freeze(['check', 'title', 'priority', 'due', 'menu']),
  week: Object.freeze(['check', 'title', 'status', 'priority', 'due', 'menu']),
  weekMobile: Object.freeze(['check', 'title', 'priority', 'due', 'menu']),
  demands: Object.freeze(['title', 'progress', 'priority', 'due', 'menu']),
});

const columnsFor = (ctx, name) => (ctx.isMobile && COLUMNS[`${name}Mobile`]) || COLUMNS[name];

const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');

/** "a, b e c" */
function joinPt(parts) {
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Navegação a partir da tela
// ---------------------------------------------------------------------------

/** Rola até uma seção da própria tela (abrindo-a se estiver recolhida) e dá o foco ao título dela. */
function jumpTo(ctx, id, ev) {
  const doc = ev && ev.currentTarget && ev.currentTarget.ownerDocument ? ev.currentTarget.ownerDocument : document;
  const win = doc.defaultView || window;
  const wasCollapsed = isCollapsed(ctx, id);
  if (wasCollapsed) setCollapsed(ctx, id, false);
  const go = () => {
    const el = doc.querySelector(`.v-dashboard [data-section="${id}"]`);
    if (!el) return;
    const reduce = win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    const toggle = el.querySelector('.section-toggle');
    if (toggle) toggle.focus({ preventScroll: true });
    el.classList.remove('is-flash');
    void el.offsetWidth; // reinicia a animação
    el.classList.add('is-flash');
    win.setTimeout(() => el.classList.remove('is-flash'), 1200);
  };
  if (wasCollapsed) win.setTimeout(go, 180);
  else go();
}

/**
 * Abre a lista de Demandas já filtrada por prazo (?deadline=…&mode=…). A tela Demandas lê esses parâmetros
 * ao entrar (onEnter) e grava o filtro pelo próprio estado da tela. Abre no modo Tarefas quando há tarefas na
 * lista (o caso comum); só demandas atrasadas → modo Demandas.
 */
function openDeadlineList(app, deadline, items) {
  const hasTasks = !items || items.some((i) => i.type === 'task');
  app.ui.navigate('/demandas', { deadline, mode: hasTasks ? 'tasks' : 'demands' });
}

function newTask(app, defaults) {
  if (app.ui && typeof app.ui.quickCreate === 'function') app.ui.quickCreate('task', defaults);
}

function newDemand(app, defaults) {
  if (app.ui && typeof app.ui.quickCreate === 'function') app.ui.quickCreate('demand', defaults);
}

function linkButton(label, onclick, glyph = 'arrow-right', action) {
  return button({ label, iconRight: glyph, size: 'sm', variant: 'ghost', class: 'v-dashboard-link', onclick, attrs: action ? { 'data-action': action } : undefined });
}

// ---------------------------------------------------------------------------
// Cabeçalho e números
// ---------------------------------------------------------------------------

function greetingOf(app) {
  const hour = app.clock.now().getHours();
  if (hour < 5) return 'Boa noite';
  if (hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

function longToday(today) {
  const d = parseDate(today);
  if (!d) return '';
  return `${capitalize(WEEKDAYS_LONG[weekdayIndex(today)])}, ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
}

function summaryText(data) {
  const bits = [];
  if (data.todayTasks.length) bits.push(plural(data.todayTasks.length, 'tarefa para hoje', 'tarefas para hoje'));
  if (data.overdue.length) bits.push(plural(data.overdue.length, 'item atrasado', 'itens atrasados'));
  const stuck = data.stuckCount + data.byDependency.length;
  if (stuck) bits.push(plural(stuck, 'tarefa travada', 'tarefas travadas'));
  if (!bits.length) return 'Nada urgente por aqui. Bom momento para adiantar o que vem pela frente.';
  return `Você tem ${joinPt(bits)}.`;
}

function header(app, data, { showSummary = true } = {}) {
  return h(
    'header',
    { class: 'v-dashboard-head' },
    h(
      'div',
      { class: 'v-dashboard-head-text' },
      h('div', { class: 'v-dashboard-date', 'data-today': data.today }, longToday(data.today)),
      h('h2', { class: 'v-dashboard-greeting' }, greetingOf(app)),
      showSummary ? h('p', { class: 'v-dashboard-summary' }, summaryText(data)) : null,
    ),
    h('div', { class: 'v-dashboard-head-actions' }, digestButton(app)),
  );
}

function stats(app, ctx, data) {
  const overdueTasks = data.overdue.filter((i) => i.type === 'task').length;
  const overdueDemands = data.overdue.length - overdueTasks;
  const overdueHint = data.overdue.length
    ? [overdueTasks ? plural(overdueTasks, 'tarefa', 'tarefas') : null, overdueDemands ? plural(overdueDemands, 'demanda', 'demandas') : null].filter(Boolean).join(' · ')
    : 'tudo em dia';
  const cards = [
    {
      id: 'today',
      label: 'Hoje',
      value: data.todayTasks.length,
      icon: 'target',
      tone: 'accent',
      hint: data.dueToday ? (data.dueToday === 1 ? '1 vence hoje' : `${data.dueToday} vencem hoje`) : 'nenhuma vence hoje',
      onclick: (ev) => jumpTo(ctx, 'today', ev),
      title: 'Ir para Minhas tarefas de hoje',
    },
    {
      id: 'overdue',
      label: 'Atrasadas',
      value: data.overdue.length,
      icon: 'alert-circle',
      tone: data.overdue.length ? 'danger' : 'neutral',
      hint: overdueHint,
      onclick: (ev) => jumpTo(ctx, 'overdue', ev),
      title: 'Ir para Atrasadas',
    },
    {
      id: 'wip',
      label: 'Em andamento',
      value: data.active.length,
      icon: 'circle-half',
      tone: 'info',
      hint:
        [data.review.length ? `+${data.review.length} em revisão` : null, data.activeSubtasks ? `+${plural(data.activeSubtasks, 'subtarefa', 'subtarefas')}` : null].filter(Boolean).join(' · ') ||
        'tarefas em execução',
      onclick: () => app.ui.navigate('/kanban'),
      title: 'Abrir o Kanban',
    },
    {
      id: 'stuck',
      label: 'Bloqueadas / aguardando',
      value: data.stuckCount,
      icon: 'ban',
      tone: data.stuckCount ? 'warning' : 'neutral',
      hint: data.byDependency.length ? `+${data.byDependency.length} por dependência` : data.stuckCount ? `${data.blocked.length} bloq. · ${data.waiting.length} aguard.` : 'nada travado',
      onclick: (ev) => jumpTo(ctx, 'blocked', ev),
      title: 'Ir para Atividades bloqueadas',
    },
    {
      id: 'done',
      label: 'Concluídas na semana',
      value: data.week.completedAll,
      icon: 'check-circle',
      tone: 'success',
      hint: data.week.total ? `${data.week.done} de ${data.week.total} do plano` : 'sem plano na semana',
      onclick: () => app.ui.navigate('/semana'),
      title: 'Abrir Minha Semana',
    },
  ];
  return h(
    'div',
    { class: 'v-dashboard-stats', role: 'list', 'aria-label': 'Resumo' },
    cards.map((c) =>
      h(
        'div',
        { class: 'v-dashboard-stat', key: c.id, 'data-stat': c.id, role: 'listitem', title: c.title },
        statCard({ label: c.label, value: String(c.value), icon: c.icon, tone: c.tone, hint: c.hint, onclick: c.onclick }),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Coluna principal
// ---------------------------------------------------------------------------

function nextSection(app, ctx, data) {
  const doList = capped(ctx, 'next', data.actionsDo, CAPS.next);
  const unblock = data.actionsUnblock.slice(0, CAPS.unblock);
  const body = [
    doList.length
      ? h('div', { class: 'v-dashboard-list v-dashboard-actions', key: 'do' }, doList.map((item, index) => actionRow(app, item, index + 1)))
      : quiet({
          icon: 'check-circle',
          tone: 'success',
          text: 'Nenhuma ação pendente agora',
          hint: data.actionsUnblock.length ? 'O que sobrou está travado: veja abaixo o que destravar.' : 'Quando houver tarefas planejadas, as mais importantes aparecem aqui.',
          action: button({ label: 'Nova tarefa', icon: 'plus', size: 'sm', onclick: () => newTask(app) }),
        }),
    moreToggle(ctx, 'next', data.actionsDo.length, CAPS.next),
    unblock.length
      ? h(
          'div',
          { class: 'v-dashboard-sub', key: 'unblock', 'data-subsection': 'unblock' },
          h(
            'div',
            { class: 'v-dashboard-sub-head' },
            icon('unlink', { size: 13 }),
            h('span', { class: 'v-dashboard-sub-title' }, 'Para destravar'),
            h('span', { class: 'v-dashboard-sub-count tabular' }, String(data.actionsUnblock.length)),
            data.actionsUnblock.length > unblock.length
              ? h('button', { type: 'button', class: 'v-dashboard-sub-link', 'data-action': 'see-blocked', onclick: (ev) => jumpTo(ctx, 'blocked', ev) }, 'ver todas')
              : null,
          ),
          h('div', { class: 'v-dashboard-list' }, unblock.map((item) => stuckRow(app, item.task))),
        )
      : null,
  ];
  return sectionCard(ctx, {
    id: 'next',
    title: 'Próximas ações',
    icon: 'zap',
    count: data.actionsDo.length,
    class: 'is-primary',
    actions: h('span', { class: 'v-dashboard-help', title: 'Ordenadas por prioridade, prazo, status e por quantas tarefas cada uma destrava.', 'aria-label': 'Como a lista é ordenada' }, icon('help-circle', { size: 14 })),
    body,
  });
}

function todaySection(app, ctx, data) {
  const list = capped(ctx, 'today', data.todayTasks, CAPS.today);
  return sectionCard(ctx, {
    id: 'today',
    title: 'Minhas tarefas de hoje',
    icon: 'sun',
    count: data.todayTasks.length,
    body: list.length
      ? [
          h('div', { class: 'v-dashboard-list v-dashboard-rows', key: 'list' }, list.map((t) => taskRow(app, t, { columns: columnsFor(ctx, 'today'), showDemand: true }))),
          moreToggle(ctx, 'today', data.todayTasks.length, CAPS.today),
        ]
      : quiet({
          icon: 'sun',
          text: 'Nada marcado para hoje',
          hint: 'Aparecem aqui as tarefas que vencem ou começam hoje, as em andamento e as com cronômetro ligado.',
        }),
  });
}

function overdueSection(app, ctx, data) {
  const list = capped(ctx, 'overdue', data.overdue, CAPS.overdue);
  return sectionCard(ctx, {
    id: 'overdue',
    title: 'Atrasadas',
    icon: 'alert-circle',
    tone: data.overdue.length ? 'danger' : null,
    count: data.overdue.length,
    actions: data.overdue.length ? linkButton('Ver na lista', () => openDeadlineList(app, 'overdue', data.overdue), 'arrow-right', 'open-overdue-list') : null,
    body: list.length
      ? [
          h(
            'div',
            { class: 'v-dashboard-list v-dashboard-rows', key: 'list' },
            list.map((item) =>
              item.type === 'task'
                ? taskRow(app, item.entity, { columns: columnsFor(ctx, 'tasks'), showDemand: true })
                : demandRow(app, item.entity, { columns: COLUMNS.demands, class: 'v-dashboard-demand-line' }),
            ),
          ),
          moreToggle(ctx, 'overdue', data.overdue.length, CAPS.overdue),
        ]
      : quiet({ icon: 'check-circle', tone: 'success', text: 'Nada atrasado', hint: 'Todos os prazos de tarefas e demandas abertas estão em dia.' }),
  });
}

function weekPrioritiesSection(app, ctx, data) {
  const list = capped(ctx, 'weekPriorities', data.weekPriorities, CAPS.weekPriorities);
  return sectionCard(ctx, {
    id: 'weekPriorities',
    title: 'Prioridades da semana',
    icon: 'flag',
    count: data.weekPriorities.length,
    actions: linkButton('Minha Semana', () => app.ui.navigate('/semana')),
    body: list.length
      ? [
          h('div', { class: 'v-dashboard-list v-dashboard-rows', key: 'list' }, list.map((t) => taskRow(app, t, { columns: columnsFor(ctx, 'week'), showDemand: true }))),
          moreToggle(ctx, 'weekPriorities', data.weekPriorities.length, CAPS.weekPriorities),
        ]
      : quiet({
          icon: 'flag',
          text: 'Nenhuma P1 ou P2 nesta semana',
          hint: 'Tarefas críticas ou de prioridade alta que estão no plano da semana ou vencem nela aparecem aqui.',
          action: button({ label: 'Planejar a semana', size: 'sm', onclick: () => app.ui.navigate('/semana') }),
        }),
  });
}

// ---------------------------------------------------------------------------
// Coluna lateral
// ---------------------------------------------------------------------------

function suggestionsSection(app, ctx, data) {
  if (!data.suggestions.length) return null;
  const list = capped(ctx, 'suggestions', data.suggestions, CAPS.suggestions);
  return sectionCard(ctx, {
    id: 'suggestions',
    title: 'Sugestões de prioridade',
    icon: 'sparkles',
    count: data.suggestions.length,
    class: 'is-hint',
    body: [
      h('div', { class: 'v-dashboard-suggestions', key: 'list' }, list.map((s) => suggestionCard(app, s))),
      moreToggle(ctx, 'suggestions', data.suggestions.length, CAPS.suggestions),
    ],
  });
}

function weekSection(app, ctx, data) {
  const w = data.week;
  const ratio = w.total ? w.done / w.total : null;
  return sectionCard(ctx, {
    id: 'week',
    title: 'Semana',
    icon: 'calendar-week',
    actions: linkButton('Abrir', () => app.ui.navigate('/semana'), 'arrow-right', 'open-week'),
    body: w.total
      ? h(
          'div',
          { class: 'v-dashboard-week' },
          h(
            'div',
            { class: 'v-dashboard-week-top' },
            h('span', { class: 'v-dashboard-week-value tabular', 'data-week-done': w.done }, `${w.done}`, h('span', { class: 'v-dashboard-week-of' }, `/${w.total}`)),
            h('span', { class: 'v-dashboard-week-label' }, 'concluídas do plano', h('span', { class: 'v-dashboard-week-range' }, formatWeekRange(w.start))),
          ),
          progressBar(ratio, { title: `${w.done} de ${w.total} tarefas do plano concluídas` }),
          h(
            'dl',
            { class: 'v-dashboard-week-facts' },
            h('div', null, h('dt', null, 'Planejadas'), h('dd', { class: 'tabular' }, String(w.planned))),
            h('div', null, h('dt', null, 'Adicionadas'), h('dd', { class: 'tabular' }, String(w.added))),
            h('div', { title: 'Concluídas entre as planejadas até segunda-feira ÷ planejadas' }, h('dt', null, 'Cumprimento'), h('dd', { class: 'tabular', 'data-adherence': w.adherence === null ? '' : String(Math.round(w.adherence * 100)) }, w.adherence === null ? '—' : formatPercent(w.adherence))),
          ),
        )
      : quiet({
          icon: 'calendar-week',
          text: 'Nada planejado nesta semana',
          hint: `${formatWeekRange(w.start)} · escolha o que fazer e acompanhe o planejado × realizado.`,
          action: button({ label: 'Planejar a semana', size: 'sm', onclick: () => app.ui.navigate('/semana') }),
        }),
  });
}

function dayLabel(date, today) {
  const n = diffDays(today, date);
  if (n === 0) return 'Hoje';
  if (n === 1) return 'Amanhã';
  return capitalize(formatDate(date, 'weekday', today));
}

function upcomingSection(app, ctx, data) {
  const limit = ctx.state.expanded && ctx.state.expanded.upcoming ? Infinity : CAPS.upcoming;
  const groups = [];
  let shown = 0;
  for (const group of data.upcoming) {
    if (shown >= limit) break;
    const items = group.items.slice(0, limit - shown);
    shown += items.length;
    groups.push(
      h(
        'div',
        { class: 'v-dashboard-day', key: group.date, 'data-day': group.date },
        h('div', { class: cx('v-dashboard-day-label', group.date === data.today && 'is-today') }, h('span', null, dayLabel(group.date, data.today)), h('span', { class: 'v-dashboard-day-count tabular' }, String(group.items.length))),
        h('div', { class: 'v-dashboard-list' }, items.map((item) => miniRow(app, item))),
      ),
    );
  }
  return sectionCard(ctx, {
    id: 'upcoming',
    title: 'Próximos prazos',
    icon: 'calendar',
    count: data.upcomingCount,
    actions: linkButton('Calendário', () => app.ui.navigate('/calendario')),
    body: groups.length
      ? [h('div', { class: 'v-dashboard-days', key: 'days' }, groups), moreToggle(ctx, 'upcoming', data.upcomingCount, CAPS.upcoming)]
      : quiet({ icon: 'calendar', text: 'Nenhum prazo nos próximos 7 dias', hint: 'Tarefas e demandas abertas com prazo até a próxima semana aparecem aqui, por dia.' }),
  });
}

function demandsSection(app, ctx, data) {
  const filter = ctx.state.demandFilter === 'open' ? 'open' : 'active';
  const sort = ctx.state.demandSort === 'progress' ? 'progress' : 'deadline';
  const rows = sortDemandRows(filter === 'open' ? data.demands : data.demands.filter((d) => d.inFlight), sort);
  const list = capped(ctx, 'demands', rows, CAPS.demands);
  const toolbar = h(
    'div',
    { class: 'v-dashboard-toolbar', key: 'toolbar' },
    segmented({
      size: 'sm',
      ariaLabel: 'Quais demandas mostrar',
      value: filter,
      options: [
        { value: 'active', label: `Em andamento · ${data.inFlightCount}` },
        { value: 'open', label: `Abertas · ${data.demands.length}` },
      ],
      onchange: (value) => ctx.setState({ demandFilter: value }),
      class: 'v-dashboard-demand-filter',
    }),
    segmented({
      size: 'sm',
      ariaLabel: 'Ordenar demandas',
      value: sort,
      options: [
        { value: 'deadline', label: 'Prazo', title: 'Ordenar por prazo' },
        { value: 'progress', label: 'Progresso', title: 'Ordenar por progresso (menor primeiro)' },
      ],
      onchange: (value) => ctx.setState({ demandSort: value }),
      class: 'v-dashboard-demand-sort',
    }),
  );
  let content;
  if (list.length) {
    content = [h('div', { class: 'v-dashboard-list', key: 'list' }, list.map((row) => demandProgressRow(app, row))), moreToggle(ctx, 'demands', rows.length, CAPS.demands)];
  } else if (filter === 'active' && data.demands.length) {
    content = quiet({
      icon: 'layers',
      text: 'Nenhuma demanda em andamento',
      hint: `${plural(data.demands.length, 'demanda aberta', 'demandas abertas')} ainda não começaram.`,
      action: button({ label: 'Ver as abertas', size: 'sm', onclick: () => ctx.setState({ demandFilter: 'open' }) }),
    });
  } else {
    content = quiet({
      icon: 'layers',
      text: 'Nenhuma demanda aberta',
      hint: 'Crie uma demanda para acompanhar o progresso e a próxima ação.',
      action: button({ label: 'Nova demanda', icon: 'plus', size: 'sm', onclick: () => newDemand(app, data.scope ? { project_id: data.scope } : undefined) }),
    });
  }
  return sectionCard(ctx, {
    id: 'demands',
    title: 'Demandas',
    icon: 'layers',
    count: rows.length,
    body: [data.demands.length ? toolbar : null, content],
  });
}

function blockedSection(app, ctx, data) {
  const groups = [
    { id: 'blocked', label: 'Bloqueadas', glyph: 'ban', list: data.blocked },
    { id: 'waiting', label: 'Aguardando terceiros', glyph: 'hourglass', list: data.waiting },
    { id: 'dependency', label: 'Bloqueadas por dependência', glyph: 'lock', list: data.byDependency },
  ];
  const total = groups.reduce((n, g) => n + g.list.length, 0);
  let left = ctx.state.expanded && ctx.state.expanded.blocked ? Infinity : CAPS.blocked;
  const blocks = [];
  for (const group of groups) {
    if (!group.list.length || left <= 0) continue;
    const items = group.list.slice(0, left);
    left -= items.length;
    blocks.push(
      h(
        'div',
        { class: 'v-dashboard-group', key: group.id, 'data-group': group.id },
        h('div', { class: 'v-dashboard-group-label' }, icon(group.glyph, { size: 12 }), h('span', null, group.label), h('span', { class: 'tabular' }, String(group.list.length))),
        h('div', { class: 'v-dashboard-list' }, items.map((t) => stuckRow(app, t))),
      ),
    );
  }
  return sectionCard(ctx, {
    id: 'blocked',
    title: 'Atividades bloqueadas',
    icon: 'ban',
    count: total,
    actions: data.byDependency.length ? linkButton('Dependências', () => app.ui.navigate('/dependencias')) : null,
    body: blocks.length
      ? [h('div', { class: 'v-dashboard-groups', key: 'groups' }, blocks), moreToggle(ctx, 'blocked', total, CAPS.blocked)]
      : quiet({ icon: 'check-circle', tone: 'success', text: 'Nada travado', hint: 'Nenhuma tarefa bloqueada, aguardando terceiros ou presa a um pré-requisito.' }),
  });
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

function emptyDashboard(app, data) {
  if (data.scope) {
    const project = app.sel.project(data.scope);
    return emptyState({
      icon: 'folder',
      title: `Nada em ${project ? `“${project.name}”` : 'este projeto'} ainda`,
      text: 'Este projeto ainda não tem demandas nem tarefas. Crie a primeira ou volte a ver todos os projetos.',
      action: [
        button({ label: 'Nova demanda', icon: 'plus', variant: 'primary', onclick: () => newDemand(app, { project_id: data.scope }), attrs: { 'data-action': 'new-demand' } }),
        button({ label: 'Mostrar todos os projetos', onclick: () => app.ui.setScope({ projectId: null }), attrs: { 'data-action': 'clear-scope' } }),
      ],
      class: 'v-dashboard-empty',
    });
  }
  return emptyState({
    icon: 'home',
    title: 'Comece pela primeira demanda',
    text: 'Cadastre uma demanda e as tarefas dela. O Início passa a mostrar o que fazer agora, os prazos, os bloqueios e o andamento da semana.',
    action: [
      button({ label: 'Nova demanda', icon: 'plus', variant: 'primary', onclick: () => newDemand(app), attrs: { 'data-action': 'new-demand' } }),
      button({ label: 'Nova tarefa', icon: 'plus', onclick: () => newTask(app), attrs: { 'data-action': 'new-task' } }),
    ],
    class: 'v-dashboard-empty',
  });
}

export default {
  id: 'dashboard',
  path: '/dashboard',
  title: 'Início',
  icon: 'home',
  order: 10,
  section: 'main',

  /** Selo da navegação: itens atrasados (tarefas e demandas) no escopo atual. */
  badge(app) {
    try {
      return overdueCount(app);
    } catch {
      return 0;
    }
  },

  render(app, ctx) {
    const data = dashboardData(app);
    if (!data.hasAny) {
      return h('div', { class: 'v-dashboard is-empty', 'data-dashboard': 'empty' }, header(app, data, { showSummary: false }), emptyDashboard(app, data));
    }
    return h(
      'div',
      { class: cx('v-dashboard', ctx.isMobile && 'is-mobile'), 'data-dashboard': 'ready' },
      header(app, data),
      stats(app, ctx, data),
      h(
        'div',
        { class: 'v-dashboard-grid' },
        h('div', { class: 'v-dashboard-col is-main', key: 'main' }, nextSection(app, ctx, data), todaySection(app, ctx, data), overdueSection(app, ctx, data), weekPrioritiesSection(app, ctx, data)),
        h('div', { class: 'v-dashboard-col is-side', key: 'side' }, suggestionsSection(app, ctx, data), weekSection(app, ctx, data), upcomingSection(app, ctx, data), demandsSection(app, ctx, data), blockedSection(app, ctx, data)),
      ),
    );
  },
};
