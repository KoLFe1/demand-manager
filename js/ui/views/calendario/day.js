// Calendário — visão diária.
//
// Duas partes:
//   • "Vencem neste dia": tarefas e demandas com prazo no dia (linhas padrão), "Atrasadas" quando o dia é
//     hoje e os inícios planejados (se ligados);
//   • "Tempo registrado": os apontamentos do dia numa linha do tempo vertical (06:00–22:00, estendida para
//     cobrir os apontamentos), blocos posicionados por started_at/ended_at, cronômetros rodando ao vivo,
//     lançamentos sem horário listados embaixo e o total do dia. "Adicionar horas" abre o diálogo.

import { cx, h } from '../../../core/dom.js';
import { formatTime, parseDate } from '../../../core/dates.js';
import { TIMER, elapsedSeconds, formatDuration, timerState } from '../../../domain/timetracking.js';
import { button } from '../../kit/controls.js';
import { sectionHeader } from '../../kit/display.js';
import { entityAttrs, liveElapsed } from '../../shared/entity.js';
import { dayList } from './month.js';
import { itemRow, limitedOverdue, openAddHours } from './items.js';
import { itemsOn } from './model.js';

/** Altura de uma hora na linha do tempo (px). Mantenha igual a --v-cal-hour em calendario.css. */
export const HOUR_PX = 44;
/** Faixa padrão da linha do tempo (horas). */
export const DEFAULT_START_HOUR = 6;
export const DEFAULT_END_HOUR = 22;
/** Altura mínima de um bloco (minutos), para caber o nome. */
const MIN_BLOCK_MINUTES = 30;

const nameOf = (entity) => (entity && typeof entity.name === 'string' && entity.name.trim() ? entity.name.trim() : 'Sem nome');

/** Minutos desde a meia-noite LOCAL do dia `date` até o instante `ms` (limitado a 0…1440). */
function minutesInDay(date, ms) {
  const midnight = parseDate(date).getTime();
  const minutes = (ms - midnight) / 60000;
  return Math.max(0, Math.min(24 * 60, minutes));
}

/**
 * Apontamentos do dia (não excluídos, de tarefas visíveis e do projeto do escopo), já posicionados.
 * @param {object} app
 * @param {string} date
 * @returns {{ placed: Array<object>, loose: Array<object>, total: number, startHour: number, endHour: number }}
 */
export function dayEntries(app, date) {
  const nowMs = app.clock.now().getTime();
  const scope = app.ui && app.ui.scope ? app.ui.scope.projectId : null;
  const entries = app.store.byIndex('time_entries', 'entry_date', date).filter((entry) => {
    if (!entry || entry.deleted_at) return false;
    const task = app.sel.task(entry.task_id);
    if (!task) return false;
    return !scope || app.sel.projectIdOf('task', task) === scope;
  });
  const placed = [];
  const loose = [];
  let total = 0;
  let minStart = DEFAULT_START_HOUR * 60;
  let maxEnd = DEFAULT_END_HOUR * 60;
  for (const entry of entries) {
    const seconds = elapsedSeconds(entry, nowMs);
    total += seconds;
    const task = app.sel.task(entry.task_id);
    const state = timerState(entry);
    const startMs = Date.parse(entry.started_at);
    if (!Number.isFinite(startMs)) {
      loose.push({ entry, task, seconds, state });
      continue;
    }
    let endMs = Date.parse(entry.ended_at);
    if (state === TIMER.RUNNING || !Number.isFinite(endMs)) endMs = state === TIMER.DONE ? startMs + seconds * 1000 : nowMs;
    const start = minutesInDay(date, startMs);
    let end = minutesInDay(date, endMs);
    if (end <= start) end = Math.min(24 * 60, start + Math.max(1, seconds / 60));
    minStart = Math.min(minStart, start);
    maxEnd = Math.max(maxEnd, end);
    placed.push({ entry, task, seconds, state, start, end, lane: 0, lanes: 1 });
  }
  // Colunas para blocos sobrepostos: grupos de blocos que se tocam dividem a largura.
  placed.sort((a, b) => a.start - b.start || b.end - a.end);
  let group = [];
  let groupEnd = -1;
  const flush = () => {
    const lanesEnd = [];
    for (const block of group) {
      const visualEnd = Math.max(block.end, block.start + MIN_BLOCK_MINUTES);
      let lane = lanesEnd.findIndex((end) => end <= block.start);
      if (lane < 0) {
        lane = lanesEnd.length;
        lanesEnd.push(visualEnd);
      } else lanesEnd[lane] = visualEnd;
      block.lane = lane;
    }
    for (const block of group) block.lanes = Math.max(1, lanesEnd.length);
    group = [];
    groupEnd = -1;
  };
  for (const block of placed) {
    const visualEnd = Math.max(block.end, block.start + MIN_BLOCK_MINUTES);
    if (group.length && block.start >= groupEnd) flush();
    group.push(block);
    groupEnd = Math.max(groupEnd, visualEnd);
  }
  if (group.length) flush();
  loose.sort((a, b) => String(a.entry.created_at || '').localeCompare(String(b.entry.created_at || '')));
  return {
    placed,
    loose,
    total,
    startHour: Math.floor(minStart / 60),
    endHour: Math.min(24, Math.ceil(maxEnd / 60)),
  };
}

/** Bloco de um apontamento na linha do tempo. */
function timeBlock(app, block, startHour) {
  const { entry, task, state, start, end, lane, lanes } = block;
  const attrs = entityAttrs(app, 'task', task);
  const running = state === TIMER.RUNNING;
  const top = ((start - startHour * 60) / 60) * HOUR_PX;
  const height = Math.max((MIN_BLOCK_MINUTES / 60) * HOUR_PX - 2, ((end - start) / 60) * HOUR_PX - 2);
  const range = `${formatTime(entry.started_at)}–${running ? 'agora' : entry.ended_at ? formatTime(entry.ended_at) : ''}`;
  const short = height < HOUR_PX * 0.9;
  return h(
    'div',
    {
      ...attrs,
      key: entry.id,
      class: cx('v-calendario-block', attrs.class, running && 'is-running', state === TIMER.PAUSED && 'is-paused', short && 'is-short'),
      'data-cal-entry': entry.id,
      tabindex: 0,
      role: 'button',
      title: `${nameOf(task)}\n${range} · ${formatDuration(block.seconds)}${entry.description ? `\n${entry.description}` : ''}`,
      'aria-label': `${nameOf(task)}, ${range}, ${formatDuration(block.seconds)}`,
      style: {
        top: `${top}px`,
        height: `${height}px`,
        left: `calc(${(lane / lanes) * 100}% + 2px)`,
        width: `calc(${100 / lanes}% - 4px)`,
      },
      onclick: () => app.ui.openPanel('task', task.id),
      onkeydown: (ev) => {
        if (ev.target !== ev.currentTarget || (ev.key !== 'Enter' && ev.key !== ' ')) return;
        ev.preventDefault();
        app.ui.openPanel('task', task.id);
      },
    },
    h('span', { class: 'v-calendario-block-name' }, nameOf(task)),
    h(
      'span',
      { class: 'v-calendario-block-meta tabular' },
      h('span', null, range),
      h('span', { 'aria-hidden': 'true' }, ' · '),
      running ? liveElapsed(app, entry, { class: 'v-calendario-block-live' }) : h('span', null, formatDuration(block.seconds)),
    ),
  );
}

/** Linha do tempo vertical do dia. */
function timeline(cal, info) {
  const { app, today } = cal;
  const hours = [];
  for (let hour = info.startHour; hour <= info.endHour; hour++) hours.push(hour);
  const height = (info.endHour - info.startHour) * HOUR_PX;
  let nowLine = null;
  if (cal.st.date === today) {
    const minutes = minutesInDay(today, app.clock.now().getTime());
    if (minutes >= info.startHour * 60 && minutes <= info.endHour * 60) {
      nowLine = h('div', { key: 'now', class: 'v-calendario-now', style: { top: `${((minutes - info.startHour * 60) / 60) * HOUR_PX}px` }, 'aria-hidden': 'true' });
    }
  }
  return h(
    'div',
    { class: 'v-calendario-timeline', style: { height: `${height}px` }, 'data-cal-timeline': `${info.startHour}-${info.endHour}` },
    h(
      'div',
      { class: 'v-calendario-hours', 'aria-hidden': 'true' },
      hours.map((hour) =>
        h(
          'div',
          { key: `h${hour}`, class: 'v-calendario-hour', style: { top: `${(hour - info.startHour) * HOUR_PX}px` } },
          h('span', { class: 'v-calendario-hour-label tabular' }, `${String(hour).padStart(2, '0')}:00`),
        ),
      ),
    ),
    h('div', { class: 'v-calendario-lane' }, nowLine, info.placed.map((block) => timeBlock(app, block, info.startHour))),
  );
}

/** Lançamentos sem horário. */
function looseList(app, loose) {
  if (!loose.length) return null;
  return h(
    'div',
    { class: 'v-calendario-loose' },
    h('div', { class: 'v-calendario-rows-label' }, 'Sem horário'),
    loose.map(({ entry, task, seconds, state }) => {
      const attrs = entityAttrs(app, 'task', task);
      return h(
        'div',
        {
          ...attrs,
          key: entry.id,
          class: cx('v-calendario-loose-row', attrs.class),
          'data-cal-entry': entry.id,
          tabindex: 0,
          role: 'button',
          onclick: () => app.ui.openPanel('task', task.id),
          onkeydown: (ev) => {
            if (ev.target !== ev.currentTarget || (ev.key !== 'Enter' && ev.key !== ' ')) return;
            ev.preventDefault();
            app.ui.openPanel('task', task.id);
          },
        },
        h('span', { class: 'v-calendario-loose-name truncate' }, nameOf(task)),
        entry.description ? h('span', { class: 'v-calendario-loose-desc truncate' }, entry.description) : null,
        state === TIMER.RUNNING ? liveElapsed(app, entry) : h('span', { class: 'v-calendario-loose-dur tabular' }, formatDuration(seconds)),
      );
    }),
  );
}

/** Painel "Tempo registrado". */
function timePanel(cal) {
  const { app, st } = cal;
  const info = dayEntries(app, st.date);
  const count = info.placed.length + info.loose.length;
  const panelTask = app.ui && typeof app.ui.panel === 'function' ? app.ui.panel() : null;
  const add = button({
    label: 'Adicionar horas',
    icon: 'plus',
    size: 'sm',
    attrs: { 'data-action': 'cal-add-hours' },
    onclick: () => openAddHours(app, { date: st.date, taskId: panelTask && panelTask.type === 'task' ? panelTask.id : null }),
  });
  return h(
    'section',
    { class: 'v-calendario-time', 'aria-label': 'Tempo registrado' },
    h(
      'header',
      { class: 'v-calendario-time-head' },
      h('div', { class: 'v-calendario-time-title' }, h('span', { class: 'strong' }, 'Tempo registrado'), h('span', { class: 'v-calendario-time-total tabular', 'data-cal-total': String(info.total) }, count ? formatDuration(info.total) : '—')),
      add,
    ),
    count
      ? null
      : h('p', { class: 'v-calendario-time-empty' }, 'Nenhum apontamento neste dia. Use “Adicionar horas” ou o cronômetro de uma tarefa.'),
    h('div', { class: 'v-calendario-timeline-wrap' }, timeline(cal, info)),
    looseList(app, info.loose),
  );
}

/** Parte "Vencem neste dia" (+ Atrasadas quando é hoje). */
function duePanel(cal) {
  const { app, st, data, today } = cal;
  const items = itemsOn(data, st.date);
  const due = items.filter((item) => item.kind === 'due');
  const overdue = st.date === today ? data.overdue : [];
  const limited = overdue.length ? limitedOverdue(cal, (item) => itemRow(app, item, { phone: cal.phone })) : null;
  return h(
    'section',
    { class: 'v-calendario-due', 'aria-label': 'Vencem neste dia' },
    sectionHeader({ title: 'Vencem neste dia', count: due.length, icon: 'calendar', class: 'v-calendario-section-head' }),
    dayList(cal, st.date, { phone: cal.phone, emptyText: 'Nada vence neste dia.' }),
    overdue.length
      ? h(
          'div',
          { key: 'overdue', class: 'v-calendario-due-overdue', 'data-cal-overdue': 'true' },
          sectionHeader({ title: 'Atrasadas', count: overdue.length, icon: 'alert-circle', class: 'v-calendario-section-head is-danger' }),
          h('div', { class: 'v-calendario-rows' }, limited.nodes),
          limited.toggle,
        )
      : null,
  );
}

/**
 * Visão diária.
 * @param {object} cal
 */
export function dayView(cal) {
  return h('div', { class: cx('v-calendario-dayview', cal.phone && 'is-phone') }, duePanel(cal), timePanel(cal));
}
