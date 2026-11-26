// Visualização "Minha Semana" — planejamento semanal (seção 9 do pedido).
//
// Mostra, para a semana escolhida (padrão: a corrente):
//   • navegador de semanas (anterior / próxima / "Esta semana") com o período e a fase (atual, passada, futura);
//   • comparação Planejado × Realizado × Não concluído × Adicionado durante a semana, cumprimento do plano,
//     carga × capacidade ('capacity.hoursPerWeek') e as últimas 6 semanas;
//   • seções, na ordem da seção 9 do pedido: Programadas (o plano), Prioritárias, Atrasadas, Próximos
//     vencimentos, Bloqueadas e Concluídas na semana (pelo histórico de status);
//   • transferência das pendências para a semana seguinte sem perder o plano anterior;
//   • semanas passadas lidas como histórico: cada item do plano com o desfecho que teve.
//
// Estado da tela (ctx.state, salvo por dispositivo): week + weekSession (a semana escolhida só vale na mesma
// sessão), collapsed (seções recolhidas), groupByDay, showRemoved.

import { cx, h } from '../../core/dom.js';
import { addDays, isoToDateStr, weekDays } from '../../core/dates.js';
import { formatPercent, plural } from '../../core/format.js';
import { WEEK_KIND, WEEK_OUTCOME, WEEK_OUTCOME_LABELS, WEEK_PHASE } from '../../domain/weekplan.js';
import { button, formatDurationText, iconButton } from '../kit/controls.js';
import { alertBox, badge, emptyState, progressBar, statCard } from '../kit/display.js';
import { groupedBarChart, ring } from '../kit/charts.js';
import { icon } from '../kit/icons.js';
import { pickDate } from '../kit/pickers.js';
import { carryItems, dayText, openAddTasks, openCarryPicker, restoreToPlan } from './semana/dialogs.js';
import {
  PHASE_INFO,
  carryTarget,
  compareRows,
  currentWeekOf,
  dayOfTask,
  historySeries,
  phaseOf,
  scopeFilter,
  scopeId,
  scopedLoad,
  scopedSections,
  scopedSummary,
  selectedWeek,
  showCarryBanner,
  unfinishedRows,
  WATCH_CAP,
  weekLabel,
  weekPatch,
} from './semana/model.js';
import { addButton, mark, planButton, planMarks, weekRow, weekSection } from './semana/rows.js';

// ---------------------------------------------------------------------------
// Cabeçalho
// ---------------------------------------------------------------------------

function renderHeader(app, ctx, { week, phase, current }) {
  const info = PHASE_INFO[phase];
  const go = (w) => ctx.setState(weekPatch(w));
  return h(
    'header',
    { class: 'v-semana-head' },
    h(
      'div',
      { class: 'v-semana-nav' },
      h(
        'div',
        { class: 'v-semana-arrows', role: 'group', 'aria-label': 'Navegar entre semanas' },
        iconButton({ icon: 'chevron-left', title: 'Semana anterior', variant: 'default', class: 'v-semana-prev', onclick: () => go(addDays(week, -7)) }),
        iconButton({ icon: 'chevron-right', title: 'Próxima semana', variant: 'default', class: 'v-semana-next', onclick: () => go(addDays(week, 7)) }),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'v-semana-range',
          title: 'Escolher outra semana',
          'aria-label': `Semana de ${weekLabel(week)} — escolher outra semana`,
          onclick: async (ev) => {
            const picked = await pickDate(ev.currentTarget, { value: week, today: app.clock.today(), title: 'Ir para a semana de…', allowClear: false });
            if (picked && picked.value) go(picked.value);
          },
        },
        h('span', { class: 'v-semana-range-text tabular' }, weekLabel(week)),
        icon('chevron-down', { size: 14 }),
      ),
      badge(info.label, { tone: info.tone, class: 'v-semana-phase' }),
      phase !== WEEK_PHASE.CURRENT ? button({ label: 'Esta semana', size: 'sm', variant: 'ghost', icon: 'rotate-ccw', class: 'v-semana-today', onclick: () => go(current) }) : null,
    ),
    phase !== WEEK_PHASE.PAST
      ? h(
          'div',
          { class: 'v-semana-head-actions' },
          button({ label: 'Adicionar tarefas', icon: 'plus', variant: 'primary', size: 'sm', class: 'v-semana-add-open', onclick: () => openAddTasks(app, week) }),
        )
      : null,
  );
}

// ---------------------------------------------------------------------------
// Comparação planejado × realizado
// ---------------------------------------------------------------------------

function renderCompare(app, { week, phase, summary, keep }) {
  const c = summary.counts;
  const load = scopedLoad(app, week, keep);
  const history = historySeries(app, week, keep);
  const ratio = load.ratio;
  const loadTone = ratio === null ? 'neutral' : ratio > 1 ? 'danger' : ratio > 0.85 ? 'warning' : 'accent';
  const adherence = summary.adherence;
  const sofar = phase === WEEK_PHASE.PAST ? 'ao fim da semana' : 'até agora';

  const stats = h(
    'div',
    { class: 'v-semana-stats' },
    statCard({
      label: 'Planejado',
      value: String(c.planned),
      icon: 'target',
      hint: c.carriedIn ? `${plural(c.carriedIn, 'veio', 'vieram')} da semana anterior` : 'no início da semana',
      class: 'v-semana-stat',
    }),
    statCard({
      label: 'Realizado',
      value: String(c.completed),
      icon: 'check-circle',
      tone: c.completed ? 'success' : 'neutral',
      hint: c.completed ? `${c.completedPlanned} ${c.completedPlanned === 1 ? 'planejada' : 'planejadas'} · ${c.completedAdded} ${c.completedAdded === 1 ? 'adicionada' : 'adicionadas'}` : `nenhuma concluída ${sofar}`,
      class: 'v-semana-stat',
    }),
    statCard({
      label: 'Não concluído',
      value: String(c.notCompleted),
      icon: 'circle-dashed',
      tone: phase === WEEK_PHASE.PAST && c.notCompleted ? 'warning' : 'neutral',
      hint: c.carriedOut ? `${plural(c.carriedOut, 'transferida', 'transferidas')} · ${sofar}` : sofar,
      class: 'v-semana-stat',
    }),
    statCard({
      label: 'Adicionado durante a semana',
      value: String(c.added),
      icon: 'plus',
      hint: c.removed ? `${plural(c.removed, 'retirada', 'retiradas')} do plano` : 'depois do planejamento',
      class: 'v-semana-stat',
    }),
  );

  const adherenceCard = h(
    'div',
    { class: 'v-semana-card v-semana-health' },
    h(
      'div',
      { class: 'v-semana-adherence' },
      ring({ value: adherence, size: 64, stroke: 6, title: adherence === null ? 'Cumprimento: nada planejado' : `Cumprimento do plano: ${formatPercent(adherence)}` }),
      h(
        'div',
        { class: 'v-semana-card-text' },
        h('div', { class: 'v-semana-card-title' }, 'Cumprimento do plano'),
        h(
          'div',
          { class: 'v-semana-card-sub' },
          adherence === null ? 'Nada foi planejado no início da semana.' : `${c.completedPlanned} de ${plural(c.planned, 'tarefa planejada', 'tarefas planejadas')} ${c.completedPlanned === 1 ? 'concluída' : 'concluídas'}`,
        ),
      ),
    ),
    h(
      'div',
      { class: 'v-semana-load' },
      h(
        'div',
        { class: 'v-semana-load-head' },
        h('span', { class: 'v-semana-card-title' }, 'Carga × capacidade'),
        h('span', { class: 'v-semana-load-value tabular' }, `${formatDurationText(load.plannedMinutes) || '0h'} de ${formatDurationText(load.capacityMinutes) || '—'}`),
      ),
      progressBar(ratio === null ? 0 : Math.min(1, ratio), { tone: loadTone, title: ratio === null ? 'Sem capacidade definida' : `${formatPercent(ratio)} da capacidade`, class: 'v-semana-load-bar' }),
      h(
        'div',
        { class: 'v-semana-card-sub' },
        load.count === 0
          ? 'Nenhuma tarefa aberta no plano.'
          : [
              `${plural(load.count, 'tarefa aberta', 'tarefas abertas')} no plano`,
              ratio !== null && ratio > 1 ? ` · ${formatPercent(ratio - 1)} acima da capacidade` : '',
              load.unestimated ? ` · ${load.unestimated} sem estimativa` : '',
            ].join(''),
      ),
    ),
  );

  const chartCard = h(
    'div',
    { class: 'v-semana-card v-semana-trend' },
    h('div', { class: 'v-semana-card-title' }, `Últimas ${history.categories.length} semanas`),
    groupedBarChart({
      categories: history.categories,
      series: [
        { name: 'No plano', values: history.inPlan, color: 'muted' },
        { name: 'Concluídas', values: history.completed, color: 'accent' },
      ],
      height: 118,
      yTicks: 3,
      ariaLabel: 'Tarefas no plano e concluídas nas últimas semanas',
      class: 'v-semana-chart',
    }),
  );

  return h('section', { class: 'v-semana-compare', 'aria-label': 'Planejado × realizado' }, stats, h('div', { class: 'v-semana-cards' }, adherenceCard, chartCard));
}

// ---------------------------------------------------------------------------
// Avisos e estado vazio
// ---------------------------------------------------------------------------

function renderCarryBanner(app, ctx, { week, phase, pending }) {
  const target = carryTarget(app, week);
  const go = (w) => ctx.setState(weekPatch(w));
  const ids = pending.map((row) => row.item.id);
  const where = phase === WEEK_PHASE.PAST && target === currentWeekOf(app) ? 'esta semana' : 'a próxima semana';
  return alertBox({
    tone: 'warning',
    icon: 'arrow-right',
    class: 'v-semana-carry-banner',
    title: `${plural(pending.length, 'tarefa não concluída', 'tarefas não concluídas')} — Transferir para ${where}`,
    text: `Elas seguem para a semana de ${weekLabel(target)}; o plano desta semana continua guardado, com cada uma marcada como transferida.`,
    actions: [
      button({ label: 'Transferir todas', icon: 'arrow-right', size: 'sm', variant: 'primary', class: 'v-semana-carry-all', onclick: () => carryItems(app, week, target, ids, { onGo: go }) }),
      button({ label: 'Escolher…', size: 'sm', class: 'v-semana-carry-pick', onclick: () => openCarryPicker(app, { week, target, rows: pending, onGo: go }) }),
    ],
  });
}

function renderEmpty(app, ctx, { week, phase, keep }) {
  const go = (w) => ctx.setState(weekPatch(w));
  if (keep && app.sel.weekSummary(week).rows.some((row) => row.outcome !== WEEK_OUTCOME.REMOVED)) {
    const project = app.sel.project(scopeId(app));
    return emptyState({
      icon: 'filter',
      title: `Nada de ${project ? project.name : 'este projeto'} no plano desta semana`,
      text: 'O plano tem tarefas de outros projetos. Mostre todos os projetos ou adicione tarefas deste.',
      action: [
        button({ label: 'Mostrar todos os projetos', size: 'sm', onclick: () => app.ui.setScope({ projectId: null }) }),
        phase !== WEEK_PHASE.PAST ? button({ label: 'Adicionar tarefas', icon: 'plus', size: 'sm', variant: 'primary', onclick: () => openAddTasks(app, week) }) : null,
      ],
      class: 'v-semana-empty',
    });
  }
  if (phase === WEEK_PHASE.PAST) {
    return emptyState({
      icon: 'calendar-week',
      title: 'Nenhum plano registrado nesta semana',
      text: 'Nenhuma tarefa foi planejada para esta semana. As tarefas concluídas nela aparecem abaixo.',
      action: button({ label: 'Ir para esta semana', size: 'sm', icon: 'rotate-ccw', onclick: () => go(currentWeekOf(app)) }),
      class: 'v-semana-empty',
    });
  }
  if (!app.sel.tasks().length) {
    return emptyState({
      icon: 'calendar-week',
      title: 'Planeje a sua semana',
      text: 'Ainda não há tarefas cadastradas. Crie a primeira e depois traga para o plano da semana as que você vai executar.',
      action: button({ label: 'Nova tarefa', icon: 'plus', size: 'sm', variant: 'primary', onclick: () => app.ui && app.ui.quickCreate && app.ui.quickCreate('task') }),
      class: 'v-semana-empty',
    });
  }
  const prev = addDays(week, -7);
  const prevPending = unfinishedRows(app, scopedSummary(app, prev, keep));
  return emptyState({
    icon: 'calendar-week',
    title: 'Nada planejado para esta semana',
    text: 'Escolha as tarefas em que você vai trabalhar. Ao longo da semana, compare o planejado com o realizado; o que ficar pendente pode ser transferido para a semana seguinte sem perder o histórico deste plano.',
    action: [
      button({ label: 'Adicionar tarefas', icon: 'plus', size: 'sm', variant: 'primary', class: 'v-semana-empty-add', onclick: () => openAddTasks(app, week) }),
      button({
        label: prevPending.length ? `Trazer as não concluídas da semana passada (${prevPending.length})` : 'Trazer as não concluídas da semana passada',
        icon: 'rotate-ccw',
        size: 'sm',
        class: 'v-semana-empty-carry',
        disabled: !prevPending.length,
        title: prevPending.length ? `Transferir ${plural(prevPending.length, 'tarefa', 'tarefas')} da semana de ${weekLabel(prev)}` : 'A semana passada não deixou tarefas pendentes',
        onclick: () => carryItems(app, prev, week, prevPending.map((row) => row.item.id)),
      }),
    ],
    class: 'v-semana-empty',
  });
}

// ---------------------------------------------------------------------------
// Seções
// ---------------------------------------------------------------------------

/** Linhas de "Programadas" (semana corrente ou futura), opcionalmente agrupadas por dia. */
function scheduledBody(app, ctx, { week, phase, tasks, rowByTask }) {
  const today = app.clock.today();
  const line = (task) => {
    const row = rowByTask.get(task.id);
    return weekRow(app, task, {
      marks: planMarks(app, row, week),
      action: row ? planButton(app, row.item, week) : null,
      timer: phase === WEEK_PHASE.CURRENT,
    });
  };
  if (!ctx.state.groupByDay) return tasks.map(line);
  const byDay = new Map();
  for (const task of tasks) {
    const day = dayOfTask(task, week) || '';
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(task);
  }
  const out = [];
  for (const day of [...weekDays(week), '']) {
    const list = byDay.get(day);
    if (!list) continue;
    out.push(
      h(
        'div',
        { class: cx('v-semana-day', day === today && 'is-today'), key: `day-${day || 'none'}`, role: 'presentation' },
        h('span', { class: 'v-semana-day-name' }, day ? dayText(app, day) : 'Sem data nesta semana'),
        day === today ? badge('Hoje', { tone: 'accent', class: 'v-semana-day-today' }) : null,
        h('span', { class: 'v-semana-day-count tabular' }, String(list.length)),
      ),
      ...list.map(line),
    );
  }
  return out;
}

/** Retiradas do plano (com "Devolver ao plano"). */
function removedBody(app, rows, week) {
  return rows.map((row) =>
    weekRow(app, row.task, {
      marks: [mark('Retirada do plano', { tone: 'gray', glyph: 'minus' })],
      compactStatus: true,
      class: 'is-removed',
      action: iconButton({
        icon: 'undo',
        title: 'Devolver ao plano',
        size: 'sm',
        onclick: (ev) => {
          ev.stopPropagation();
          restoreToPlan(app, row.item, week);
        },
      }),
    }),
  );
}

/** Linha de um item cuja tarefa foi excluída (histórico). */
function missingRow(row) {
  return h(
    'div',
    { class: 'en-row v-semana-row v-semana-missing', key: `missing-${row.item.id}` },
    icon('trash', { size: 14 }),
    h('span', { class: 'v-semana-missing-text' }, 'Tarefa excluída'),
    mark(WEEK_OUTCOME_LABELS.missing, { tone: 'gray' }),
  );
}

function renderSections(app, ctx, { week, phase, summary, sections, hasPlan }) {
  const rowByTask = new Map(summary.rows.filter((row) => row.task).map((row) => [row.item.task_id, row]));
  const activeByTask = new Map(summary.active.map((row) => [row.item.task_id, row]));
  const inPlanMark = () => mark('No plano', { tone: 'accent', glyph: 'calendar-week', title: 'Já está no plano desta semana' });
  const out = [];

  /** Linha para as listas de acompanhamento (atrasadas, prioritárias, bloqueadas). */
  const watchLine = (task) => {
    const row = activeByTask.get(task.id);
    const planned = !!row && !row.item.removed_at;
    return weekRow(app, task, {
      marks: planned ? [inPlanMark()] : [],
      action: planned ? planButton(app, row.item, week) : addButton(app, task, week),
    });
  };

  /**
   * Lista de acompanhamento limitada a WATCH_CAP linhas (estado `expanded[id]` mostra todas). Devolve o corpo
   * e o rodapé ("Ver todas as N" / "Mostrar menos", mais `extra` quando a lista passa do limite).
   */
  const capped = (id, list, line, extra = null) => {
    const expandedMap = ctx.state.expanded && typeof ctx.state.expanded === 'object' ? ctx.state.expanded : {};
    const open = !!expandedMap[id];
    if (list.length <= WATCH_CAP) return { body: list.map(line), footer: null };
    const toggle = button({
      label: open ? 'Mostrar menos' : `Ver todas as ${list.length}`,
      size: 'sm',
      variant: 'ghost',
      icon: open ? 'chevron-up' : 'chevron-down',
      class: 'v-semana-more-btn',
      attrs: { 'data-action': 'show-all', 'aria-expanded': open ? 'true' : 'false' },
      onclick: () =>
        ctx.setState((prev) => {
          const map = prev.expanded && typeof prev.expanded === 'object' ? prev.expanded : {};
          return { expanded: { ...map, [id]: !map[id] } };
        }),
    });
    return { body: (open ? list : list.slice(0, WATCH_CAP)).map(line), footer: [toggle, extra] };
  };

  // Programadas — o plano.
  if (phase === WEEK_PHASE.PAST && hasPlan) {
    const rows = [...summary.rows].sort(compareRows);
    out.push(
      weekSection(ctx, {
        id: 'scheduled',
        title: 'Programadas',
        icon: 'calendar-week',
        count: rows.length,
        desc: rows.length ? 'Semana encerrada: o plano aparece como ficou, com o desfecho de cada tarefa.' : null,
        body: rows.map((row) => (row.task && !row.task.deleted_at ? weekRow(app, row.task, { marks: planMarks(app, row, week, { history: true }), compactStatus: true, class: `is-outcome-${row.outcome}` }) : missingRow(row))),
        empty: 'Nenhuma tarefa foi planejada nesta semana.',
      }),
    );
  } else if (phase !== WEEK_PHASE.PAST && hasPlan) {
    const tasks = sections.scheduled;
    const showRemoved = !!ctx.state.showRemoved;
    const removed = summary.removed.filter((row) => row.task && !app.sel.isHidden('task', row.task));
    const doneCount = summary.completed.length + summary.doneBefore.length;
    const footer = [];
    if (doneCount) footer.push(h('span', { class: 'v-semana-foot-text' }, `${plural(doneCount, 'concluída', 'concluídas')} — veja em “Concluídas na semana”`));
    if (removed.length) {
      footer.push(
        button({
          label: showRemoved ? 'Ocultar as retiradas do plano' : `Mostrar ${plural(removed.length, 'retirada', 'retiradas')} do plano`,
          size: 'sm',
          variant: 'ghost',
          icon: showRemoved ? 'eye-off' : 'eye',
          class: 'v-semana-toggle-removed',
          onclick: () => ctx.setState({ showRemoved: !showRemoved }),
        }),
      );
    }
    const body = [...scheduledBody(app, ctx, { week, phase, tasks, rowByTask }), ...(showRemoved ? removedBody(app, removed, week) : [])];
    out.push(
      h(
        'div',
        { class: 'v-semana-planblock', key: 'planblock' },
        weekSection(ctx, {
          id: 'scheduled',
          title: 'Programadas',
          icon: 'calendar-week',
          count: tasks.length,
          body,
          empty: summary.active.length ? 'Tudo o que foi planejado está concluído.' : 'Nenhuma tarefa aberta no plano.',
          actions: button({
            label: 'Agrupar por dia',
            icon: 'calendar',
            size: 'sm',
            variant: 'ghost',
            active: !!ctx.state.groupByDay,
            class: 'v-semana-group-toggle',
            onclick: () => ctx.setState({ groupByDay: !ctx.state.groupByDay }),
          }),
        }),
        footer.length && !(ctx.state.collapsed && ctx.state.collapsed.scheduled) ? h('div', { class: 'v-semana-foot' }, footer) : null,
      ),
    );
  }

  if (phase !== WEEK_PHASE.PAST) {
    const priority = capped('priority', sections.priority, watchLine);
    const overdue = capped(
      'overdue',
      sections.overdue,
      watchLine,
      button({
        label: 'Ver na lista',
        size: 'sm',
        variant: 'ghost',
        iconRight: 'arrow-right',
        class: 'v-semana-more-link',
        attrs: { 'data-action': 'open-overdue-list' },
        onclick: () => app.ui.navigate('/demandas', { deadline: 'overdue', mode: 'tasks' }),
      }),
    );
    out.push(
      weekSection(ctx, {
        id: 'priority',
        title: 'Prioritárias',
        icon: 'flag',
        count: sections.priority.length,
        body: priority.body,
        footer: priority.footer,
        empty: 'Nenhuma tarefa P1 ou P2 no plano ou vencendo nesta semana.',
      }),
      weekSection(ctx, {
        id: 'overdue',
        title: 'Atrasadas',
        icon: 'alert-circle',
        tone: 'danger',
        count: sections.overdue.length,
        body: overdue.body,
        footer: overdue.footer,
        empty: 'Nenhuma tarefa atrasada. Bom trabalho!',
      }),
    );
  }

  if (phase !== WEEK_PHASE.PAST) {
    const upcoming = capped('upcoming', sections.upcoming, (task) => weekRow(app, task, { action: addButton(app, task, week, { labelled: true }) }));
    const blocked = capped('blocked', sections.blocked, watchLine);
    out.push(
      weekSection(ctx, {
        id: 'upcoming',
        title: 'Próximos vencimentos',
        icon: 'clock',
        count: sections.upcoming.length,
        desc: sections.upcoming.length ? 'Vencem nesta semana e ainda não estão no plano.' : null,
        body: upcoming.body,
        footer: upcoming.footer,
        empty: 'Nada vence nesta semana fora do plano.',
      }),
      // Bloqueadas e aguardando terceiros juntas (o ícone de status de cada linha diferencia uma da outra).
      weekSection(ctx, {
        id: 'blocked',
        title: 'Bloqueadas / aguardando',
        icon: 'ban',
        tone: 'warning',
        count: sections.blocked.length,
        body: blocked.body,
        footer: blocked.footer,
        empty: 'Nenhuma tarefa da semana está bloqueada ou aguardando terceiros.',
      }),
    );
  }

  if (phase !== WEEK_PHASE.FUTURE) {
    const completed = capped('completed', sections.completed, (task) => {
      const row = rowByTask.get(task.id);
      const inPlan = !!row && row.outcome !== WEEK_OUTCOME.REMOVED;
      const at = row && row.completedAt ? row.completedAt : task.completed_at;
      const marks = [];
      if (at) marks.push(h('span', { class: 'v-semana-when', title: 'Concluída em' }, dayText(app, isoToDateStr(at))));
      if (!inPlan) marks.push(mark('Fora do plano', { tone: 'neutral', title: 'Concluída sem estar no plano desta semana' }));
      else if (row.kind === WEEK_KIND.ADDED) marks.push(mark('Adicionada na semana', { tone: 'violet', glyph: 'plus', title: 'Adicionada durante a semana' }));
      return weekRow(app, task, { marks, compactStatus: true });
    });
    out.push(
      weekSection(ctx, {
        id: 'completed',
        title: 'Concluídas na semana',
        icon: 'check-circle',
        tone: 'success',
        count: sections.completed.length,
        body: completed.body,
        footer: completed.footer,
        empty: phase === WEEK_PHASE.PAST ? 'Nenhuma tarefa concluída nesta semana.' : 'Nenhuma tarefa concluída ainda nesta semana.',
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

function renderWeek(app, ctx) {
  const state = ctx.state || {};
  const safeCtx = { ...ctx, state };
  const week = selectedWeek(app, state);
  const current = currentWeekOf(app);
  const phase = phaseOf(app, week);
  const keep = scopeFilter(app);
  const summary = scopedSummary(app, week, keep);
  const sections = scopedSections(app, week, keep);
  // Semana encerrada: qualquer linha é histórico (inclusive as retiradas). Semana atual/futura: só retiradas
  // não fazem um plano — a tela mostra o estado vazio, com "Adicionar tarefas" e "Trazer as não concluídas".
  const hasPlan = phase === WEEK_PHASE.PAST ? summary.rows.length > 0 : summary.rows.some((row) => row.outcome !== WEEK_OUTCOME.REMOVED);
  const pending = phase === WEEK_PHASE.FUTURE ? [] : unfinishedRows(app, summary);

  return h(
    'div',
    { class: cx('v-semana', `is-${phase}`, ctx.isMobile && 'is-mobile'), 'data-week': week, 'data-phase': phase },
    h(
      'div',
      { class: 'v-semana-inner' },
      renderHeader(app, safeCtx, { week, phase, current }),
      showCarryBanner(app, week, phase, pending.length) ? renderCarryBanner(app, safeCtx, { week, phase, pending }) : null,
      hasPlan ? renderCompare(app, { week, phase, summary, keep }) : h('div', { class: 'v-semana-empty-wrap', key: 'empty' }, renderEmpty(app, safeCtx, { week, phase, keep })),
      // Sem nenhuma tarefa no app, as listas vazias só fariam ruído: fica o convite do estado vazio.
      hasPlan || app.sel.tasks().length ? h('div', { class: 'v-semana-sections' }, renderSections(app, safeCtx, { week, phase, summary, sections, hasPlan })) : null,
    ),
  );
}

export default {
  id: 'semana',
  path: '/semana',
  title: 'Minha Semana',
  icon: 'calendar-week',
  order: 20,
  section: 'main',
  /**
   * Desenha a tela inteira a partir do estado do app e de ctx.state.
   * @param {object} app
   * @param {{ state: object, setState: Function, params: object, isMobile: boolean }} ctx
   * @returns {HTMLElement}
   */
  render(app, ctx) {
    return renderWeek(app, ctx);
  },
};
