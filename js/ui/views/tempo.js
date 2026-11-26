// Visualização "Tempo" (seção 8 do pedido): histórico e resumos do tempo apontado.
//
//   • período (Hoje, Esta semana, Semana passada, Este mês, Mês passado, Personalizado) com setas;
//   • "Em andamento agora": cronômetros rodando/pausados com o tempo correndo e os controles padrão
//     (timerControl de shared/entity.js) + aviso de cronômetros simultâneos ou esquecidos;
//   • resumo (realizado, estimado, diferença, dias com registro, média), gráficos por dia e por projeto,
//     tabelas por demanda e por tarefa;
//   • apontamentos por dia com edição no lugar, exclusão com desfazer e marca de sobreposição;
//   • "Adicionar horas" (lançamento manual) e "Exportar CSV".
//
// Estado da tela (ctx.state, salvo por dispositivo): period, offset, from, to (personalizado), demandId,
// edit (rascunho da edição), collapsed { demands, tasks }, showAllTasks, showAllDemands, entryLimit.

import { cx, h } from '../../core/dom.js';
import { WEEKDAYS_SHORT, addDays, formatDate, rangeDays, startOfWeek, timeOfIso, weekdayIndex } from '../../core/dates.js';
import { formatHours, formatNumber, plural, truncate } from '../../core/format.js';
import { TIMER, estimateVsActual, formatDuration, isLongRunning, timerState } from '../../domain/timetracking.js';
import { barChart, hbarList } from '../kit/charts.js';
import { button, dateInput, iconButton, segmented, selectInput } from '../kit/controls.js';
import { STATUS_COLORS, alertBox, emptyState, sectionHeader, statCard } from '../kit/display.js';
import { icon } from '../kit/icons.js';
import { EMPTY_CHOICE, pickFromList } from '../kit/pickers.js';
import { entityAttrs, entityTitle, handleError, notify, projectDot, startTimer, statusControl, stopTimer, timerControl } from '../shared/entity.js';
import { openAddTimeDialog, pickTask } from './tempo/dialogs.js';
import { entriesSection, openOnBodyClick, openOnKey } from './tempo/entries.js';
import { NO_DEMAND, PERIODS, activeTimersInScope, buildCsv, computePeriod, csvFileName, csvRows, dailySeries, periodRange } from './tempo/model.js';

/** Linhas visíveis das tabelas antes do "Mostrar todas". */
const TABLE_PAGE = 12;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const hoursText = (value) => `${formatNumber(value, value >= 10 || Number.isInteger(value) ? 0 : 1)} h`;

/** Diferença em horas com sinal: '+1,5 h' / '−2,0 h'. */
function signedHours(seconds) {
  const value = Math.abs(seconds) / 3600;
  if (Math.round(value * 10) === 0) return '0 h';
  return `${seconds > 0 ? '+' : '−'}${formatNumber(value, 1)} h`;
}

/** Diferença em duração curta com sinal: '+1h 20min' / '−45min'. */
function signedDuration(seconds) {
  if (Math.abs(seconds) < 60) return '0min';
  return `${seconds > 0 ? '+' : '−'}${formatDuration(Math.abs(seconds))}`;
}

function minutesText(minutes) {
  return minutes > 0 ? formatDuration(minutes * 60) : '—';
}

/** Projeto do escopo global (filtro da barra superior). */
function scopeOf(app) {
  return app.ui && app.ui.scope && app.ui.scope.projectId ? app.ui.scope.projectId : null;
}

/** Filtro de demanda válido para o escopo atual (demanda excluída ou de outro projeto é ignorada). */
function demandFilter(app, value, projectId) {
  if (value === NO_DEMAND) return NO_DEMAND;
  if (typeof value !== 'string' || !value) return null;
  const demand = app.sel.demand(value);
  if (!demand) return null;
  if (projectId && demand.project_id !== projectId) return null;
  return value;
}

function card(title, { key, actions, subtitle, class: className } = {}, ...children) {
  return h(
    'section',
    { class: cx('v-tempo-card', className), key, 'aria-label': typeof title === 'string' ? title : null },
    h(
      'div',
      { class: 'v-tempo-card-head' },
      h('div', { class: 'v-tempo-card-titles' }, h('h3', { class: 'v-tempo-card-title' }, title), subtitle ? h('span', { class: 'v-tempo-card-sub' }, subtitle) : null),
      actions ? h('div', { class: 'v-tempo-card-actions' }, actions) : null,
    ),
    children,
  );
}

/** Barra estimado × realizado: a marca é a estimativa; acima dela a barra fica em tom de alerta. */
function evaBar(estimateSeconds, actualSeconds) {
  const est = Math.max(0, estimateSeconds || 0);
  const actual = Math.max(0, actualSeconds || 0);
  if (!est && !actual) return h('span', { class: 'v-tempo-eva is-empty', 'aria-hidden': 'true' });
  const top = Math.max(est, actual) || 1;
  const cmp = estimateVsActual(est / 60, actual);
  const text = est ? `Realizado ${formatDuration(actual)} de ${formatDuration(est)} estimados (${formatNumber((actual / est) * 100)}%)` : `Realizado ${formatDuration(actual)} (sem estimativa)`;
  return h(
    'span',
    { class: cx('v-tempo-eva', `is-${cmp.state}`), role: 'img', 'aria-label': text, title: text },
    h('span', { class: 'v-tempo-eva-fill', style: { width: `${Math.round((actual / top) * 1000) / 10}%` } }),
    est ? h('span', { class: 'v-tempo-eva-mark', style: { left: `${Math.round((est / top) * 1000) / 10}%` } }) : null,
  );
}

/** Baixa um texto como arquivo (Blob + âncora temporária). */
function downloadText(text, fileName, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Exporta os apontamentos do período (com os filtros aplicados) em CSV. */
export function exportCsv(app, data, range) {
  if (!data.count) {
    notify(app, 'Não há apontamentos no período para exportar.');
    return null;
  }
  const text = buildCsv(csvRows(app, data.entries, app.clock.now().getTime()));
  const name = csvFileName(range);
  try {
    downloadText(text, name);
    notify(app, `${plural(data.count, 'apontamento exportado', 'apontamentos exportados')} (${name})`, { tone: 'success' });
  } catch (err) {
    handleError(app, err);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Barra de ferramentas (período, demanda, exportar, adicionar)
// ---------------------------------------------------------------------------

function periodControls(app, ctx, range) {
  const set = (patch) => ctx.setState({ edit: null, entryLimit: null, ...patch });
  const options = PERIODS.map((p) => ({ value: p.id, label: p.label }));
  const picker = ctx.isMobile
    ? selectInput({ value: range.period, options, size: 'sm', ariaLabel: 'Período', onchange: (value) => set({ period: value, offset: 0 }), class: 'v-tempo-period-select', attrs: { 'data-period-select': 'true' } })
    : segmented({ value: range.period, options, size: 'sm', ariaLabel: 'Período', onchange: (value) => set({ period: value, offset: 0 }), class: 'v-tempo-period-seg' });
  const unitWord = range.unitName === 'mês' ? 'Mês' : range.unitName === 'semana' ? 'Semana' : 'Dia';
  const nav = range.unit
    ? h(
        'div',
        { class: 'v-tempo-range' },
        iconButton({ icon: 'chevron-left', title: `${unitWord} anterior`, size: 'sm', onclick: () => set({ offset: range.offset - 1 }), attrs: { 'data-action': 'prev-period' } }),
        h('span', { class: 'v-tempo-range-label tabular', 'data-period-label': range.period, 'aria-live': 'polite' }, range.label),
        iconButton({ icon: 'chevron-right', title: `Próxim${range.unit === 'week' ? 'a' : 'o'} ${range.unitName}`, size: 'sm', disabled: range.to >= app.clock.today(), onclick: () => set({ offset: range.offset + 1 }), attrs: { 'data-action': 'next-period' } }),
        range.offset !== 0 ? button({ label: range.unit === 'day' ? 'Hoje' : 'Atual', size: 'sm', variant: 'ghost', onclick: () => set({ offset: 0 }), attrs: { 'data-action': 'current-period' } }) : null,
      )
    : h(
        'div',
        { class: 'v-tempo-range is-custom' },
        dateInput({ value: range.from, size: 'sm', ariaLabel: 'De', max: range.to, onchange: (value) => value && set({ from: value }), attrs: { 'data-custom': 'from' } }),
        h('span', { class: 'v-tempo-range-sep', 'aria-hidden': 'true' }, 'até'),
        dateInput({ value: range.to, size: 'sm', ariaLabel: 'Até', min: range.from, onchange: (value) => value && set({ to: value }), attrs: { 'data-custom': 'to' } }),
        h('span', { class: 'v-tempo-range-days' }, plural(range.days, 'dia', 'dias')),
      );
  return [picker, nav];
}

function demandButton(app, ctx, demandId, projectId) {
  const demand = demandId && demandId !== NO_DEMAND ? app.sel.demand(demandId) : null;
  const label = demandId === NO_DEMAND ? 'Sem demanda' : demand ? truncate(demand.name, 26) : 'Todas as demandas';
  const open = async (ev) => {
    const projects = app.sel.projectsById();
    const items = [{ id: NO_DEMAND, label: 'Sem demanda (tarefas avulsas)', icon: 'inbox' }];
    for (const d of app.sel.demands({ includeArchived: true, projectId: projectId || undefined })) {
      const p = d.project_id ? projects.get(d.project_id) : null;
      items.push({ id: d.id, label: d.name || 'Sem nome', hint: app.sel.code('demand', d), group: p ? p.name : 'Sem projeto', icon: projectDot(p) });
    }
    const chosen = await pickFromList(ev.currentTarget, {
      items,
      current: demandId || null,
      allowEmpty: true,
      emptyLabel: 'Todas as demandas',
      placeholder: 'Buscar demanda…',
      title: 'Filtrar por demanda',
      width: 320,
    });
    if (chosen === null) return;
    ctx.setState({ demandId: chosen === EMPTY_CHOICE ? null : chosen, edit: null, entryLimit: null });
  };
  return h(
    'div',
    { class: cx('v-tempo-demand-filter', demandId && 'is-active') },
    button({
      label: ctx.isMobile && !demandId ? 'Demanda' : label,
      icon: 'layers',
      iconRight: 'chevron-down',
      size: 'sm',
      variant: demandId ? 'subtle' : 'default',
      title: demand ? `Mostrando só a demanda ${demand.name}` : 'Filtrar por demanda',
      onclick: open,
      attrs: { 'data-action': 'filter-demand' },
    }),
    demandId ? iconButton({ icon: 'x', title: 'Mostrar todas as demandas', size: 'sm', onclick: () => ctx.setState({ demandId: null }), attrs: { 'data-action': 'clear-demand' } }) : null,
  );
}

function addHours(app, projectId) {
  const panel = app.ui && typeof app.ui.panel === 'function' ? app.ui.panel() : null;
  openAddTimeDialog(app, { taskId: panel && panel.type === 'task' ? panel.id : null, date: app.clock.today(), projectId });
}

function toolbar(app, ctx, range, data, demandId, projectId) {
  const [picker, nav] = periodControls(app, ctx, range);
  return h(
    'div',
    { class: 'v-tempo-toolbar' },
    h('div', { class: 'v-tempo-toolbar-period' }, picker, nav),
    h(
      'div',
      { class: 'v-tempo-toolbar-actions' },
      demandButton(app, ctx, demandId, projectId),
      ctx.isMobile
        ? iconButton({ icon: 'download', title: 'Exportar CSV', variant: 'default', size: 'sm', disabled: !data.count, onclick: () => exportCsv(app, data, range), attrs: { 'data-action': 'export-csv' } })
        : button({ label: 'Exportar CSV', icon: 'download', size: 'sm', disabled: !data.count, title: data.count ? 'Baixar os apontamentos do período (CSV para Excel)' : 'Nenhum apontamento no período', onclick: () => exportCsv(app, data, range), attrs: { 'data-action': 'export-csv' } }),
      button({ label: 'Adicionar horas', icon: 'plus', variant: 'primary', size: 'sm', onclick: () => addHours(app, projectId), attrs: { 'data-action': 'add-time' } }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Em andamento agora
// ---------------------------------------------------------------------------

function liveWarning(app, all, nowMs) {
  const running = all.filter((entry) => timerState(entry) === TIMER.RUNNING && app.sel.task(entry.task_id));
  const long = running.filter((entry) => isLongRunning(entry, nowMs));
  if (running.length < 2 && !long.length) return null;
  const nameOf = (entry) => {
    const task = app.sel.task(entry.task_id);
    return `“${truncate(task ? task.name || 'Sem nome' : 'tarefa', 40)}”`;
  };
  const newest = [...running].sort((a, b) => String(b.segment_started_at || '').localeCompare(String(a.segment_started_at || '')))[0];
  const pause = (list) => {
    try {
      for (const entry of list) app.cmd.pauseTimer(entry.id);
      notify(app, list.length === 1 ? 'Cronômetro pausado' : `${list.length} cronômetros pausados`, { tone: 'success' });
    } catch (err) {
      handleError(app, err);
    }
  };
  const texts = [];
  const actions = [];
  if (running.length > 1) {
    texts.push(`${running.length} cronômetros estão rodando ao mesmo tempo (${running.map(nameOf).join(', ')}). Cada um gera o próprio registro, e as horas acabam contadas em dobro.`);
    actions.push(
      button({ label: `Manter só ${nameOf(newest)}`, size: 'sm', variant: 'primary', onclick: () => pause(running.filter((e) => e !== newest)), attrs: { 'data-action': 'keep-newest' } }),
      button({ label: 'Pausar todos', icon: 'pause', size: 'sm', onclick: () => pause(running), attrs: { 'data-action': 'pause-all' } }),
    );
  }
  for (const entry of long.slice(0, 2)) {
    texts.push(`O cronômetro de ${nameOf(entry)} está ligado há mais de 10 horas (desde ${timeOfIso(entry.segment_started_at || entry.started_at)}) — provavelmente foi esquecido. Encerre e ajuste o horário no apontamento.`);
    actions.push(button({ label: `Encerrar ${nameOf(entry)}`, icon: 'stop', size: 'sm', onclick: () => stopTimer(app, entry.id), attrs: { 'data-action': 'stop-long' } }));
  }
  return alertBox({
    tone: 'warning',
    title: running.length > 1 ? 'Cronômetros simultâneos geram registros sobrepostos' : 'Cronômetro ligado há mais de 10 horas',
    text: texts.join(' '),
    actions,
    class: 'v-tempo-live-warning',
  });
}

function liveRow(app, entry, nowMs) {
  const task = app.sel.task(entry.task_id);
  if (!task) return null;
  const state = timerState(entry);
  const running = state === TIMER.RUNNING;
  const demand = app.sel.demandOf(task);
  const project = app.sel.projectOf('task', task);
  const attrs = entityAttrs(app, 'task', task);
  const since = running ? `desde ${timeOfIso(entry.segment_started_at || entry.started_at)}` : entry.ended_at ? `pausado às ${timeOfIso(entry.ended_at)}` : 'pausado';
  return h(
    'div',
    {
      ...attrs,
      key: entry.id,
      class: cx('v-tempo-live-row', attrs.class, running ? 'is-running' : 'is-paused', running && isLongRunning(entry, nowMs) && 'is-long'),
      'data-live-entry': entry.id,
      tabindex: 0,
      onclick: openOnBodyClick(app, 'task', task.id),
      onkeydown: openOnKey(app, 'task', task.id),
    },
    h('span', { class: 'v-tempo-live-dot', 'aria-hidden': 'true' }),
    h(
      'span',
      { class: 'v-tempo-live-main' },
      entityTitle(app, 'task', task),
      h(
        'span',
        { class: 'v-tempo-live-meta' },
        project ? h('span', { class: 'v-tempo-ctx' }, projectDot(project), h('span', { class: 'truncate' }, project.name)) : null,
        demand ? h('span', { class: 'v-tempo-ctx' }, icon('layers', { size: 12 }), h('span', { class: 'truncate' }, demand.name)) : null,
        h('span', { class: 'v-tempo-ctx' }, icon(running ? 'play' : 'pause', { size: 12 }), h('span', null, since)),
      ),
    ),
    h('span', { class: 'v-tempo-live-ctl' }, timerControl(app, task)),
  );
}

function liveSection(app, timers, allTimers, nowMs) {
  const warning = liveWarning(app, allTimers, nowMs);
  if (!timers.length && !warning) return null;
  const seen = new Set();
  const rows = [];
  for (const entry of timers) {
    if (seen.has(entry.task_id)) continue; // um controle por tarefa (timerControl mostra o cronômetro dela)
    seen.add(entry.task_id);
    rows.push(liveRow(app, entry, nowMs));
  }
  const hidden = allTimers.length - timers.length;
  return h(
    'section',
    { class: 'v-tempo-live', 'aria-label': 'Em andamento agora', 'data-live': 'true' },
    sectionHeader({ title: 'Em andamento agora', count: timers.length, icon: 'timer' }),
    warning,
    rows.length ? h('div', { class: 'v-tempo-live-list' }, rows) : null,
    hidden > 0 ? h('p', { class: 'v-tempo-live-hidden' }, `${plural(hidden, 'cronômetro', 'cronômetros')} em outros projetos (fora do filtro atual).`) : null,
  );
}

// ---------------------------------------------------------------------------
// Resumo e gráficos
// ---------------------------------------------------------------------------

function statsRow(data, range) {
  // Estimativa e realizado na mesma base: tarefas com estimativa trabalhadas no período, pelo total acumulado
  // de cada uma (a estimativa é da tarefa inteira, não do período) — igual à tabela "Tarefas".
  const est = data.estimateSeconds;
  const actual = data.estimatedTrackedSeconds;
  const diff = actual - est;
  const cmp = estimateVsActual(est / 60, actual);
  const diffHint = est
    ? `${cmp.state === 'over' ? 'acima do estimado' : cmp.state === 'under' ? 'abaixo do estimado' : 'dentro do estimado (±10%)'} · total acumulado das tarefas trabalhadas`
    : 'sem estimativas para comparar';
  return h(
    'div',
    { class: 'v-tempo-stats', 'data-stats': 'true' },
    statCard({ label: 'Horas realizadas', value: formatHours(data.total), hint: plural(data.count, 'apontamento', 'apontamentos'), icon: 'clock', class: 'v-tempo-stat', tone: 'accent' }),
    statCard({
      label: 'Horas estimadas',
      value: est ? formatHours(est) : '—',
      hint: data.withEstimate ? `${plural(data.withEstimate, 'tarefa trabalhada', 'tarefas trabalhadas')} com estimativa` : 'nenhuma tarefa trabalhada tem estimativa',
      icon: 'target',
      class: 'v-tempo-stat',
    }),
    statCard({ label: 'Diferença', value: est ? signedHours(diff) : '—', tone: !est ? 'neutral' : cmp.state === 'over' ? 'warning' : 'success', hint: diffHint, icon: 'signal-3', class: 'v-tempo-stat' }),
    statCard({ label: 'Dias com registro', value: String(data.daysWithRecord), hint: `de ${plural(range.days, 'dia', 'dias')} no período`, icon: 'calendar', class: 'v-tempo-stat' }),
    statCard({ label: 'Média por dia', value: data.daysWithRecord ? formatHours(data.total / data.daysWithRecord) : '—', hint: 'nos dias com registro', icon: 'chart', class: 'v-tempo-stat' }),
  );
}

function dayChart(app, data, range, projectId, demandId) {
  const today = app.clock.today();
  if (range.days === 1) {
    // Um dia só: mostra a semana dele, com o dia em destaque.
    const ws = startOfWeek(range.from);
    const week = computePeriod(app, { from: ws, to: addDays(ws, 6), projectId, demandId });
    const items = rangeDays(ws, addDays(ws, 6)).map((day, i) => {
      const seconds = week.byDay.get(day) || 0;
      return { label: WEEKDAYS_SHORT[i], value: seconds / 3600, color: day === range.from ? 'accent' : 'muted', title: `${formatDate(day, 'weekday', today)}: ${formatDuration(seconds)}` };
    });
    return card('Horas por dia', { subtitle: 'semana do dia escolhido', class: 'v-tempo-chart-day' }, barChart({ data: items, height: 180, format: hoursText, ariaLabel: 'Horas por dia da semana' }));
  }
  const series = dailySeries(data, range);
  const items = series.points.map((point) => {
    const label = series.bucket === 'week' ? formatDate(point.from, 'daymonth') : range.days <= 7 ? `${WEEKDAYS_SHORT[weekdayIndex(point.from)]} ${Number(point.from.slice(8))}` : String(Number(point.from.slice(8)));
    const title = series.bucket === 'week' ? `Semana de ${formatDate(point.from, 'short', today)}: ${formatDuration(point.seconds)}` : `${formatDate(point.from, 'weekday', today)}: ${formatDuration(point.seconds)}`;
    return { label, value: point.seconds / 3600, title, color: series.bucket === 'day' && point.from === today ? 'accent' : undefined };
  });
  return card(
    'Horas por dia',
    { subtitle: series.bucket === 'week' ? 'somadas por semana' : null, class: 'v-tempo-chart-day' },
    barChart({ data: items, height: 180, format: hoursText, ariaLabel: series.bucket === 'week' ? 'Horas por semana' : 'Horas por dia' }),
  );
}

function projectChart(data) {
  const total = data.total || 1;
  const items = data.projects.map((row) => ({
    label: row.project ? row.project.name : row.projectId ? 'Projeto indisponível' : 'Sem projeto',
    value: row.seconds / 3600,
    color: row.project ? (STATUS_COLORS.includes(row.project.color) ? row.project.color : 'blue') : 'muted',
    hint: `${formatNumber((row.seconds / total) * 100)}% · ${formatDuration(row.seconds)}`,
  }));
  return card('Horas por projeto', { class: 'v-tempo-chart-project' }, hbarList({ items, format: hoursText, ariaLabel: 'Horas por projeto', emptyText: 'Nenhuma hora no período' }));
}

// ---------------------------------------------------------------------------
// Tabelas
// ---------------------------------------------------------------------------

function collapsedOf(ctx, name) {
  const c = ctx.state.collapsed && typeof ctx.state.collapsed === 'object' ? ctx.state.collapsed : {};
  return c[name] === true;
}

function toggleCollapsed(ctx, name) {
  ctx.setState((prev) => {
    const c = prev.collapsed && typeof prev.collapsed === 'object' ? prev.collapsed : {};
    return { collapsed: { ...c, [name]: !(c[name] === true) } };
  });
}

function moreButton(ctx, key, total, showAll) {
  if (total <= TABLE_PAGE) return null;
  return h(
    'div',
    { class: 'v-tempo-more' },
    button({
      label: showAll ? 'Mostrar menos' : `Mostrar todas (${total})`,
      size: 'sm',
      variant: 'ghost',
      icon: showAll ? 'chevron-up' : 'chevron-down',
      onclick: () => ctx.setState({ [key]: !showAll }),
      attrs: { 'data-action': `toggle-${key}` },
    }),
  );
}

function diffCell(seconds, cmp) {
  if (!cmp || cmp.state === 'none') return h('span', { class: 'v-tempo-cell v-tempo-num v-tempo-diff', 'data-label': 'Diferença' }, '—');
  return h('span', { class: cx('v-tempo-cell v-tempo-num v-tempo-diff', `is-${cmp.state}`), 'data-label': 'Diferença' }, signedDuration(seconds));
}

function numCell(label, text, extra) {
  return h('span', { class: cx('v-tempo-cell v-tempo-num', extra), 'data-label': label }, text);
}

function demandsTable(app, ctx, data) {
  const collapsed = collapsedOf(ctx, 'demands');
  const showAll = ctx.state.showAllDemands === true;
  const rows = showAll ? data.demands : data.demands.slice(0, TABLE_PAGE);
  return h(
    'section',
    { class: 'v-tempo-block', 'data-block': 'demands' },
    sectionHeader({ title: 'Horas por demanda', count: data.demands.length, icon: 'layers', collapsed, ontoggle: () => toggleCollapsed(ctx, 'demands') }),
    collapsed
      ? null
      : h(
          'div',
          { class: 'v-tempo-table v-tempo-table-demands', role: 'table', 'aria-label': 'Horas por demanda' },
          h(
            'div',
            { class: 'v-tempo-thead', role: 'row' },
            ['Demanda', 'Projeto', 'Estimado', 'No período', 'Total', 'Diferença', 'Estimado × realizado'].map((t, i) => h('span', { role: 'columnheader', class: cx('v-tempo-th', i >= 2 && i <= 5 && 'v-tempo-num') }, t)),
          ),
          rows.map((row) => {
            const over = row.cmp && row.cmp.state === 'over';
            if (!row.demand) {
              return h(
                'div',
                { class: 'v-tempo-tr is-loose', key: row.demandId || 'none', role: 'row', 'data-demand-row': row.demandId || 'none' },
                h('span', { class: 'v-tempo-cell v-tempo-name', role: 'cell' }, h('span', { class: 'muted' }, row.demandId ? 'Demanda indisponível' : 'Sem demanda (tarefas avulsas)')),
                h('span', { class: 'v-tempo-cell v-tempo-proj', role: 'cell' }),
                numCell('Estimado', '—'),
                numCell('No período', formatDuration(row.seconds), 'strong'),
                numCell('Total', '—'),
                numCell('Diferença', '—'),
                h('span', { class: 'v-tempo-cell v-tempo-bar', role: 'cell' }),
              );
            }
            const attrs = entityAttrs(app, 'demand', row.demand);
            const estimateTitle = row.estimateSource === 'tasks' ? 'Soma das estimativas das tarefas' : row.estimateSource === 'demand' ? 'Estimativa da demanda' : 'Sem estimativa';
            return h(
              'div',
              {
                ...attrs,
                key: row.demandId,
                class: cx('v-tempo-tr', attrs.class, over && 'is-over'),
                role: 'row',
                tabindex: 0,
                'data-demand-row': row.demandId,
                onclick: openOnBodyClick(app, 'demand', row.demandId),
                onkeydown: openOnKey(app, 'demand', row.demandId),
              },
              h('span', { class: 'v-tempo-cell v-tempo-name', role: 'cell' }, entityTitle(app, 'demand', row.demand)),
              h('span', { class: 'v-tempo-cell v-tempo-proj', role: 'cell' }, row.project ? [projectDot(row.project), h('span', { class: 'truncate' }, row.project.name)] : h('span', { class: 'faint' }, 'Sem projeto')),
              h('span', { class: 'v-tempo-cell v-tempo-num', 'data-label': 'Estimado', title: estimateTitle }, minutesText(row.estimateMinutes), row.estimateSource === 'tasks' ? h('span', { class: 'v-tempo-sum-mark', 'aria-hidden': 'true' }, 'Σ') : null),
              numCell('No período', formatDuration(row.seconds), 'strong'),
              numCell('Total', formatDuration(row.totalSeconds)),
              diffCell(row.totalSeconds - row.estimateMinutes * 60, row.cmp),
              h('span', { class: 'v-tempo-cell v-tempo-bar', role: 'cell' }, evaBar(row.estimateMinutes * 60, row.totalSeconds)),
            );
          }),
          moreButton(ctx, 'showAllDemands', data.demands.length, showAll),
        ),
  );
}

function tasksTable(app, ctx, data) {
  const collapsed = collapsedOf(ctx, 'tasks');
  const showAll = ctx.state.showAllTasks === true;
  const rows = showAll ? data.tasks : data.tasks.slice(0, TABLE_PAGE);
  return h(
    'section',
    { class: 'v-tempo-block', 'data-block': 'tasks' },
    sectionHeader({ title: 'Tarefas', count: data.tasks.length, icon: 'list', collapsed, ontoggle: () => toggleCollapsed(ctx, 'tasks') }),
    collapsed
      ? null
      : h(
          'div',
          { class: 'v-tempo-table v-tempo-table-tasks', role: 'table', 'aria-label': 'Tempo por tarefa' },
          h(
            'div',
            { class: 'v-tempo-thead', role: 'row' },
            ['Tarefa', 'Status', 'Estimado', 'No período', 'Total', 'Diferença'].map((t, i) => h('span', { role: 'columnheader', class: cx('v-tempo-th', i >= 2 && 'v-tempo-num') }, t)),
          ),
          rows.map((row) => {
            const task = row.task;
            const over = row.cmp.state === 'over';
            const attrs = entityAttrs(app, 'task', task);
            return h(
              'div',
              {
                ...attrs,
                key: row.taskId,
                class: cx('v-tempo-tr', attrs.class, over && 'is-over'),
                role: 'row',
                tabindex: task ? 0 : null,
                'data-task-row': row.taskId,
                onclick: openOnBodyClick(app, 'task', task ? task.id : null),
                onkeydown: openOnKey(app, 'task', task ? task.id : null),
              },
              h(
                'span',
                { class: 'v-tempo-cell v-tempo-name', role: 'cell' },
                task ? entityTitle(app, 'task', task) : h('span', { class: 'muted' }, 'Tarefa indisponível'),
                row.demand ? h('span', { class: 'v-tempo-sub truncate', title: `Demanda: ${row.demand.name}` }, row.demand.name) : null,
              ),
              h('span', { class: 'v-tempo-cell v-tempo-status', role: 'cell' }, task ? statusControl(app, 'task', task, { soft: true }) : null),
              numCell('Estimado', minutesText(row.estimateMinutes)),
              numCell('No período', formatDuration(row.seconds), 'strong'),
              numCell('Total', formatDuration(row.totalSeconds)),
              diffCell(row.totalSeconds - row.estimateMinutes * 60, row.cmp),
            );
          }),
          moreButton(ctx, 'showAllTasks', data.tasks.length, showAll),
        ),
  );
}

// ---------------------------------------------------------------------------
// Estados vazios
// ---------------------------------------------------------------------------

async function pickAndStart(app, anchor, projectId) {
  const id = await pickTask(app, anchor, { projectId, title: 'Iniciar cronômetro em…' });
  if (id) await startTimer(app, id);
}

function emptyAll(app, projectId) {
  const project = projectId ? app.sel.project(projectId) : null;
  return h(
    'div',
    { class: 'v-tempo-empty', 'data-empty': 'all' },
    emptyState({
      icon: 'timer',
      title: project ? `Nenhuma hora registrada em ${project.name}` : 'Nenhuma hora registrada ainda',
      text: h(
        'div',
        { class: 'v-tempo-ways' },
        h('p', { class: 'm-0' }, 'Há duas formas de registrar o tempo de trabalho:'),
        h(
          'ul',
          { class: 'v-tempo-ways-list' },
          h('li', null, icon('play', { size: 14 }), h('span', null, h('strong', null, 'Cronômetro'), ' — em qualquer tarefa, clique em ▶ (ou aperte T com a tarefa selecionada). Pause, retome e encerre descrevendo o que foi feito.')),
          h('li', null, icon('plus', { size: 14 }), h('span', null, h('strong', null, 'Adicionar horas'), ' — lance manualmente o dia, o horário de início e término (ou só a duração) e a descrição.')),
        ),
      ),
      action: [
        button({ label: 'Adicionar horas', icon: 'plus', variant: 'primary', onclick: () => addHours(app, projectId), attrs: { 'data-action': 'empty-add-time' } }),
        button({ label: 'Iniciar cronômetro numa tarefa', icon: 'play', onclick: (ev) => pickAndStart(app, ev.currentTarget, projectId), attrs: { 'data-action': 'empty-start-timer' } }),
      ],
    }),
  );
}

function emptyPeriod(app, ctx, range, demandId, projectId) {
  const filtered = !!demandId;
  const atDefault = range.period === 'week' && range.offset === 0;
  return h(
    'div',
    { class: 'v-tempo-empty is-period', 'data-empty': 'period' },
    emptyState({
      compact: true,
      icon: filtered ? 'filter' : 'calendar',
      title: filtered ? 'Nenhum apontamento desta demanda no período' : range.isFuture ? 'Este período ainda não começou' : 'Nenhum apontamento no período',
      text: filtered ? 'Mostre todas as demandas ou escolha outro período.' : 'Escolha outro período ou registre as horas trabalhadas.',
      action: [
        filtered ? button({ label: 'Mostrar todas as demandas', size: 'sm', onclick: () => ctx.setState({ demandId: null }), attrs: { 'data-action': 'empty-clear-demand' } }) : null,
        !atDefault ? button({ label: 'Ver esta semana', size: 'sm', onclick: () => ctx.setState({ period: 'week', offset: 0, edit: null }), attrs: { 'data-action': 'empty-this-week' } }) : null,
        button({ label: 'Adicionar horas', size: 'sm', icon: 'plus', variant: 'primary', onclick: () => addHours(app, projectId) }),
      ],
    }),
  );
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

function render(app, ctx) {
  const state = ctx.state && typeof ctx.state === 'object' ? ctx.state : {};
  const view = { ...ctx, state };
  const today = app.clock.today();
  const range = periodRange(state, today);
  const projectId = scopeOf(app);
  const demandId = demandFilter(app, state.demandId, projectId);
  const data = computePeriod(app, { from: range.from, to: range.to, projectId, demandId });
  const allTimers = app.sel.activeTimers();
  const timers = activeTimersInScope(app, projectId);
  const nowMs = app.clock.now().getTime();
  const nothingAtAll = !data.anyInScope && timers.length === 0;

  return h(
    'div',
    { class: cx('v-tempo', ctx.isMobile && 'is-mobile'), 'data-tempo': range.period },
    toolbar(app, view, range, data, demandId, projectId),
    liveSection(app, timers, allTimers, nowMs),
    nothingAtAll
      ? emptyAll(app, projectId)
      : [
          statsRow(data, range),
          data.count === 0
            ? emptyPeriod(app, view, range, demandId, projectId)
            : [
                h('div', { class: 'v-tempo-charts' }, dayChart(app, data, range, projectId, demandId), projectChart(data)),
                demandsTable(app, view, data),
                tasksTable(app, view, data),
                h(
                  'section',
                  { class: 'v-tempo-block', 'data-block': 'entries' },
                  sectionHeader({
                    title: 'Apontamentos',
                    count: data.count,
                    icon: 'clock',
                    actions: data.overlapCount
                      ? h('span', { class: 'v-tempo-overlap-sum', title: 'Apontamentos cujo horário coincide com outro' }, icon('alert-triangle', { size: 12 }), plural(data.overlapCount, 'sobreposto', 'sobrepostos'))
                      : null,
                  }),
                  entriesSection(app, view, data),
                ),
              ],
        ],
  );
}

export default {
  id: 'tempo',
  path: '/tempo',
  title: 'Tempo',
  icon: 'timer',
  order: 90,
  section: 'analysis',
  /** Histórico e resumos do tempo apontado (seção 8 do pedido). */
  render(app, ctx) {
    return render(app, ctx);
  },
};
