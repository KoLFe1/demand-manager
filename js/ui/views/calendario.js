// Visualização "Calendário" (especificação 10.3): prazos de demandas e tarefas em visão mensal, semanal e
// diária, com inícios planejados opcionais, filtros, arrastar para mudar o prazo e, no dia, o tempo
// registrado numa linha do tempo.
//
// Estado da tela (ctx.state, salvo por dispositivo):
//   mode 'month' | 'week' | 'day'      date 'YYYY-MM-DD' (dia focado; null = hoje)
//   showDemands / showTasks (padrão ligados), showStarts (padrão desligado), overdueCollapsed, filters
//
// As partes ficam em js/ui/views/calendario/: model.js (dados), items.js (chips, cartões, linhas, arrastar,
// "Adicionar horas"), month.js, week.js e day.js. Esta casca da tela monta a barra, os filtros, os avisos e
// a legenda, e cuida do teclado (T = hoje, só com o foco no calendário).

import { cx, h } from '../../core/dom.js';
import { formatDate } from '../../core/dates.js';
import { defaultFilters } from '../../domain/filters.js';
import { button, iconButton, segmented } from '../kit/controls.js';
import { kbd } from '../kit/display.js';
import { icon } from '../kit/icons.js';
import { filterBar } from '../shared/filterbar.js';
import { openIcsDialog } from '../ics-export.js';
import { dayView } from './calendario/day.js';
import { monthView } from './calendario/month.js';
import {
  FILTER_FIELDS,
  MODES,
  MODE_LABELS,
  collectItems,
  nearestDateOutside,
  normalizeState,
  withDateSession,
  periodTitle,
  shiftDate,
  sumIn,
  viewRange,
} from './calendario/model.js';
import { weekView } from './calendario/week.js';

const MODE_ICONS = Object.freeze({ month: 'calendar', week: 'columns', day: 'list' });

/** Leva o foco ao dia `date` assim que ele aparecer na grade (depois do próximo desenho). */
function focusDayWhenReady(date) {
  let tries = 0;
  const attempt = () => {
    tries += 1;
    const doc = typeof document !== 'undefined' ? document : null;
    const el = doc ? doc.querySelector(`.v-calendario [data-cal-day="${date}"]`) : null;
    if (el && el.getAttribute('tabindex') === '0') {
      if (doc.activeElement !== el) el.focus({ preventScroll: false });
      return;
    }
    if (tries < 20) setTimeout(attempt, 25);
  };
  setTimeout(attempt, 0);
}

/** Contexto compartilhado pelas partes da tela. */
function makeCal(app, ctx, st, data, today) {
  const cal = {
    app,
    st,
    data,
    today,
    phone: !!ctx.isMobile,
    // Toda troca do dia focado leva o carimbo da sessão (normalizeState ignora dias de sessões anteriores).
    setState: (patch) => ctx.setState(withDateSession(patch)),
    /** Seleciona o dia e abre a criação rápida de tarefa com aquele prazo. */
    create(date) {
      if (date !== st.date) ctx.setState(withDateSession({ date }));
      app.ui.quickCreate('task', { due_date: date });
    },
    /** Move o dia focado (e o foco do teclado) para `date`. */
    focusDay(date) {
      ctx.setState(withDateSession({ date }));
      focusDayWhenReady(date);
    },
  };
  return cal;
}

// ---------------------------------------------------------------------------
// Barra superior
// ---------------------------------------------------------------------------

function toggle(label, glyph, active, onclick, key) {
  return button({
    label,
    icon: glyph,
    size: 'sm',
    active,
    ariaLabel: label,
    title: active ? `Ocultar ${label.toLowerCase()}` : `Mostrar ${label.toLowerCase()}`,
    class: cx('v-calendario-toggle', key === 'starts' && 'is-starts'),
    attrs: { 'data-cal-toggle': key },
    onclick,
  });
}

function toolbar(cal) {
  const { st, today } = cal;
  const isCurrent = viewRange(st.mode, st.date).days.includes(today);
  return h(
    'div',
    { class: 'v-calendario-bar' },
    h(
      'div',
      { class: 'v-calendario-nav' },
      iconButton({ icon: 'chevron-left', title: `${st.mode === 'week' ? 'Semana anterior' : st.mode === 'month' ? 'Mês anterior' : 'Dia anterior'}`, size: 'sm', variant: 'default', attrs: { 'data-cal-nav': 'prev' }, onclick: () => cal.setState({ date: shiftDate(st.mode, st.date, -1) }) }),
      button({ label: 'Hoje', size: 'sm', disabled: isCurrent && st.date === today, attrs: { 'data-cal-nav': 'today', title: `Ir para hoje (T) — ${formatDate(today, 'weekday', today)}` }, onclick: () => cal.focusDay(today) }),
      iconButton({ icon: 'chevron-right', title: `${st.mode === 'week' ? 'Próxima semana' : st.mode === 'month' ? 'Próximo mês' : 'Próximo dia'}`, size: 'sm', variant: 'default', attrs: { 'data-cal-nav': 'next' }, onclick: () => cal.setState({ date: shiftDate(st.mode, st.date, 1) }) }),
    ),
    h(
      'h2',
      { class: 'v-calendario-title', 'data-cal-title': 'true', 'aria-live': 'polite', title: periodTitle(st.mode, st.date) },
      // no celular o dia usa o formato curto ('qui, 26 nov') para caber ao lado da navegação
      cal.phone && st.mode === 'day' ? formatDate(st.date, 'weekday', today) : periodTitle(st.mode, st.date),
    ),
    h('span', { class: 'v-calendario-bar-spacer' }),
    h(
      'div',
      { class: 'v-calendario-toggles', role: 'group', 'aria-label': 'O que mostrar' },
      toggle('Demandas', 'layers', st.showDemands, () => cal.setState({ showDemands: !st.showDemands }), 'demands'),
      toggle('Tarefas', 'check-circle', st.showTasks, () => cal.setState({ showTasks: !st.showTasks }), 'tasks'),
      toggle('Inícios planejados', 'circle-dashed', st.showStarts, () => cal.setState({ showStarts: !st.showStarts }), 'starts'),
    ),
    segmented({
      size: 'sm',
      ariaLabel: 'Visualização',
      class: 'v-calendario-modes',
      value: st.mode,
      options: MODES.map((mode) => ({ value: mode, label: MODE_LABELS[mode], icon: MODE_ICONS[mode] })),
      onchange: (mode) => cal.setState({ mode }),
    }),
    button({
      label: cal.phone ? null : 'Exportar .ics',
      icon: 'download',
      size: 'sm',
      variant: 'ghost',
      ariaLabel: cal.phone ? 'Exportar prazos (.ics)' : null,
      title: 'Exportar prazos para o Outlook/Google Agenda (.ics)',
      class: 'v-calendario-ics',
      attrs: { 'data-action': 'export-ics' },
      onclick: () => openIcsDialog(cal.app),
    }),
  );
}

// ---------------------------------------------------------------------------
// Avisos (estado vazio)
// ---------------------------------------------------------------------------

function notice(glyph, text, actions, kind) {
  return h(
    'div',
    { class: cx('v-calendario-notice', `is-${kind}`), role: 'status', 'data-cal-notice': kind },
    icon(glyph, { size: 16, class: 'v-calendario-notice-icon' }),
    h('span', { class: 'v-calendario-notice-text' }, text),
    actions && actions.length ? h('span', { class: 'v-calendario-notice-actions' }, actions) : null,
  );
}

function periodNotice(cal, range, counts) {
  const { st, data, today } = cal;
  if (!st.showDemands && !st.showTasks) {
    return notice('eye-off', 'Demandas e tarefas estão ocultas.', [button({ label: 'Mostrar tudo', size: 'sm', onclick: () => cal.setState({ showDemands: true, showTasks: true }) })], 'hidden');
  }
  if (data.allDue.size === 0) {
    return notice(
      'calendar',
      'Nenhuma tarefa ou demanda tem prazo ainda. Clique num dia para criar uma tarefa com aquele prazo.',
      [button({ label: 'Nova tarefa', icon: 'plus', size: 'sm', variant: 'primary', onclick: () => cal.create(st.date) })],
      'nothing',
    );
  }
  if (counts.shown === 0 && counts.total > 0) {
    return notice('filter', 'Nenhum prazo deste período corresponde aos filtros.', [button({ label: 'Limpar filtros', size: 'sm', onclick: () => cal.setState({ filters: defaultFilters() }) })], 'filtered');
  }
  if (counts.shown === 0 && st.mode !== 'day' && !data.overdue.length) {
    const next = nearestDateOutside(data.dates, range.from, range.to);
    return notice(
      'calendar',
      `Nada vence ${st.mode === 'month' ? 'neste mês' : 'nesta semana'}.`,
      next ? [button({ label: `Ir para ${formatDate(next, 'weekday', today)}`, size: 'sm', iconRight: 'arrow-right', attrs: { 'data-cal-jump': next }, onclick: () => cal.focusDay(next) })] : [],
      'empty',
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Legenda
// ---------------------------------------------------------------------------

function legend(cal) {
  if (cal.phone || cal.st.mode === 'day') return null;
  const item = (marker, text) => h('span', { class: 'v-calendario-legend-item' }, marker, h('span', null, text));
  return h(
    'footer',
    { class: 'v-calendario-legend', 'aria-label': 'Legenda' },
    item(h('span', { class: 'v-calendario-glyph status-blue' }, icon('circle-half', { size: 12 })), 'Tarefa (ícone do status)'),
    item(h('span', { class: 'v-calendario-glyph status-blue' }, icon('layers', { size: 12 })), 'Demanda'),
    item(h('span', { class: 'v-calendario-glyph is-start' }), 'Início planejado'),
    item(h('span', { class: 'v-calendario-legend-swatch is-overdue' }), 'Atrasada'),
    item(h('span', { class: 'v-calendario-legend-prio' }, icon('signal-4', { size: 12 })), 'P1 / P2'),
    item(h('span', { class: 'v-calendario-legend-done' }, 'abc'), 'Concluída'),
    h('span', { class: 'v-calendario-legend-spacer' }),
    h(
      'span',
      { class: 'v-calendario-legend-keys' },
      'Arraste para mudar o prazo',
      cal.st.mode === 'month' ? [' · ', kbd('←'), kbd('→'), kbd('↑'), kbd('↓'), ' dia · ', kbd('Enter'), ' abrir · ', kbd('T'), ' hoje'] : [' · ', kbd('T'), ' hoje'],
    ),
  );
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

/** Teclado da tela: T volta para hoje (só com o foco no calendário, fora de campos e de itens). */
function rootKeydown(cal) {
  return (ev) => {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || ev.shiftKey) return;
    if (ev.key !== 't' && ev.key !== 'T') return;
    const target = ev.target && ev.target.closest ? ev.target : null;
    if (!target || target.closest('input, textarea, select, [contenteditable="true"], [data-entity], .fb')) return;
    ev.preventDefault();
    cal.focusDay(cal.today);
  };
}

export default {
  id: 'calendario',
  path: '/calendario',
  title: 'Calendário',
  icon: 'calendar',
  order: 50,
  section: 'views',

  /**
   * @param {object} app
   * @param {{ state: object, setState: Function, params: object, isMobile: boolean }} ctx
   * @returns {HTMLElement}
   */
  render(app, ctx) {
    const today = app.clock.today();
    const st = normalizeState(ctx.state, today);
    const data = collectItems(app, st);
    const range = viewRange(st.mode, st.date);
    const cal = makeCal(app, ctx, st, data, today);
    const counts = { shown: sumIn(data.dueCount, range.from, range.to), total: sumIn(data.allDue, range.from, range.to) };

    let body;
    if (st.mode === 'week') body = weekView(cal, range);
    else if (st.mode === 'day') body = dayView(cal);
    else body = monthView(cal, range);

    return h(
      'div',
      {
        class: cx('v-calendario', `is-${st.mode}`, cal.phone && 'is-phone'),
        'data-cal-mode': st.mode,
        'data-cal-date': st.date,
        onkeydown: rootKeydown(cal),
      },
      toolbar(cal),
      h(
        'div',
        { class: 'v-calendario-filters' },
        filterBar(app, {
          filters: st.filters,
          onchange: (next) => ctx.setState({ filters: next }),
          fields: FILTER_FIELDS,
          count: { shown: counts.shown, total: counts.total, singular: 'prazo', plural: 'prazos' },
        }),
      ),
      periodNotice(cal, range, counts),
      h('div', { class: 'v-calendario-body', key: `body-${st.mode}-${cal.phone ? 'p' : 'd'}` }, body),
      legend(cal),
    );
  },
};
