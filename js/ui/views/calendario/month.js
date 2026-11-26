// Calendário — visão mensal.
//
// Computador: grade segunda→domingo (monthMatrix) com os itens de cada dia em chips compactos; "+N mais"
// abre a lista completa; clicar na área vazia de um dia (ou no "+") cria uma tarefa com aquele prazo;
// arrastar um chip para outro dia muda o prazo. Teclado: setas movem o dia focado, Enter abre o dia,
// PageUp/PageDown trocam de mês, Home/End vão ao começo/fim da semana.
//
// Celular: grade compacta (número + pontinhos) e, abaixo, a lista do dia selecionado.

import { cx, h } from '../../../core/dom.js';
import { MONTHS, WEEKDAYS_LONG, WEEKDAYS_MIN, WEEKDAYS_SHORT, addDays, addMonths, endOfWeek, formatDate, parseDate, startOfWeek, weekdayIndex } from '../../../core/dates.js';
import { plural } from '../../../core/format.js';
import { button } from '../../kit/controls.js';
import { emptyState } from '../../kit/display.js';
import { addButton, dayDrop, itemChip, itemRow, openDayList } from './items.js';
import { itemsOn, longDay, shortDay } from './model.js';

/** Chips visíveis por dia antes do "+N mais". */
export const MAX_CHIPS = 3;

/** Rótulo acessível de um dia: 'sábado, 21 de novembro — 3 itens'. */
function dayLabel(date, count) {
  const d = parseDate(date);
  const i = weekdayIndex(date);
  const base = `${WEEKDAYS_LONG[i]}, ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
  return count ? `${base} — ${plural(count, 'item', 'itens')}` : `${base} — sem itens`;
}

/** Elemento que trata o próprio clique dentro de um dia (o clique não cria tarefa). */
const OWN_CLICK = '.v-calendario-chip, button, a, input, [data-stop]';

/**
 * Teclado da grade (setas, Enter, PageUp/PageDown, Home/End). Só age quando o foco está no PRÓPRIO dia
 * (não num chip ou botão dentro dele).
 * @param {object} cal contexto da tela (ver calendario.js)
 */
function gridKeydown(cal) {
  return (ev) => {
    if (ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const cell = ev.target && ev.target.closest ? ev.target.closest('[data-cal-day]') : null;
    if (!cell || cell !== ev.target) return;
    const date = cell.getAttribute('data-cal-day');
    let next = null;
    switch (ev.key) {
      case 'ArrowLeft':
        next = addDays(date, -1);
        break;
      case 'ArrowRight':
        next = addDays(date, 1);
        break;
      case 'ArrowUp':
        next = addDays(date, -7);
        break;
      case 'ArrowDown':
        next = addDays(date, 7);
        break;
      case 'Home':
        next = startOfWeek(date);
        break;
      case 'End':
        next = endOfWeek(date);
        break;
      case 'PageUp':
        next = addMonths(date, -1);
        break;
      case 'PageDown':
        next = addMonths(date, 1);
        break;
      case 'Enter':
        ev.preventDefault();
        cal.setState({ mode: 'day', date });
        return;
      default:
        return;
    }
    ev.preventDefault();
    cal.focusDay(next);
  };
}

/** Uma célula do mês (computador). */
function dayCell(cal, date, monthIndex) {
  const { app, st, data, today } = cal;
  const items = itemsOn(data, date);
  const d = parseDate(date);
  const outside = d.getMonth() !== monthIndex;
  const weekend = weekdayIndex(date) >= 5;
  const visible = items.length > MAX_CHIPS ? items.slice(0, MAX_CHIPS - 1) : items;
  const hidden = items.length - visible.length;
  const hasOverdue = items.some((item) => item.overdue);
  return h(
    'div',
    {
      key: date,
      class: cx('v-calendario-day', {
        'is-today': date === today,
        'is-outside': outside,
        'is-weekend': weekend,
        'is-selected': date === st.date,
        'has-overdue': hasOverdue,
      }),
      role: 'gridcell',
      tabindex: date === st.date ? 0 : -1,
      'data-cal-day': date,
      'aria-selected': date === st.date,
      'aria-label': dayLabel(date, items.length),
      ...dayDrop(app, date),
      onclick: (ev) => {
        const hit = ev.target && ev.target.closest ? ev.target.closest(OWN_CLICK) : null;
        if (hit && ev.currentTarget.contains(hit)) return;
        cal.create(date);
      },
    },
    h(
      'div',
      { class: 'v-calendario-day-head' },
      h(
        'button',
        {
          type: 'button',
          class: 'v-calendario-day-num tabular',
          tabindex: -1,
          title: `Abrir ${longDay(date)}`,
          'aria-label': `Abrir o dia ${formatDate(date, 'long')}`,
          onclick: (ev) => {
            ev.stopPropagation();
            cal.setState({ mode: 'day', date });
          },
        },
        d.getDate() === 1 ? shortDay(date) : String(d.getDate()),
      ),
      addButton(date, () => cal.create(date), today),
    ),
    h(
      'div',
      { class: 'v-calendario-day-items' },
      visible.map((item) => itemChip(app, item)),
      hidden > 0
        ? h(
            'button',
            {
              type: 'button',
              key: 'more',
              class: 'v-calendario-more',
              'data-cal-more': date,
              'aria-label': `Mostrar mais ${plural(hidden, 'item', 'itens')} de ${formatDate(date, 'long')}`,
              onclick: (ev) => {
                ev.stopPropagation();
                openDayList(app, ev.currentTarget, date, itemsOn(cal.data, date), {
                  onOpenDay: () => cal.setState({ mode: 'day', date }),
                  onCreate: () => cal.create(date),
                });
              },
            },
            `+${hidden} mais`,
          )
        : null,
    ),
  );
}

/** Grade mensal do computador. */
function monthGrid(cal, range) {
  const monthIndex = parseDate(cal.st.date).getMonth();
  return h(
    'div',
    {
      class: cx('v-calendario-month', range.weeks.length === 6 && 'has-6-weeks'),
      role: 'grid',
      'aria-label': `Calendário de ${formatDate(cal.st.date, 'month')}`,
      onkeydown: gridKeydown(cal),
    },
    h(
      'div',
      { class: 'v-calendario-weekdays', role: 'row' },
      WEEKDAYS_SHORT.map((name, i) => h('div', { key: name + i, class: cx('v-calendario-weekday', i >= 5 && 'is-weekend'), role: 'columnheader', 'aria-label': WEEKDAYS_LONG[i] }, name)),
    ),
    range.weeks.map((week) => h('div', { key: week[0], class: 'v-calendario-week-row', role: 'row' }, week.map((date) => dayCell(cal, date, monthIndex)))),
  );
}

// ---------------------------------------------------------------------------
// Celular
// ---------------------------------------------------------------------------

/** Pontinhos de um dia (até 3) — demanda, tarefa, atrasada, concluída. */
function dots(items) {
  const shown = items.slice(0, 3);
  return h(
    'span',
    { class: 'v-calendario-dots', 'aria-hidden': 'true' },
    shown.map((item) =>
      h('span', {
        key: item.key,
        class: cx('v-calendario-dot', {
          'is-demand': item.type === 'demand',
          'is-overdue': item.overdue,
          'is-closed': !item.open,
          'is-start': item.kind === 'start',
        }),
      }),
    ),
    items.length > 3 ? h('span', { key: 'more', class: 'v-calendario-dots-more tabular' }, `+${items.length - 3}`) : null,
  );
}

function phoneGrid(cal, range) {
  const { st, data, today } = cal;
  const monthIndex = parseDate(st.date).getMonth();
  return h(
    'div',
    { class: 'v-calendario-mini', role: 'grid', 'aria-label': `Calendário de ${formatDate(st.date, 'month')}`, onkeydown: gridKeydown(cal) },
    h(
      'div',
      { class: 'v-calendario-mini-weekdays', role: 'row' },
      WEEKDAYS_MIN.map((name, i) => h('div', { key: `w${i}`, class: cx('v-calendario-mini-weekday', i >= 5 && 'is-weekend'), role: 'columnheader', 'aria-label': WEEKDAYS_LONG[i] }, name)),
    ),
    range.weeks.map((week) =>
      h(
        'div',
        { key: week[0], class: 'v-calendario-mini-row', role: 'row' },
        week.map((date) => {
          const items = itemsOn(data, date);
          const d = parseDate(date);
          return h(
            'button',
            {
              key: date,
              type: 'button',
              role: 'gridcell',
              class: cx('v-calendario-mini-day', {
                'is-today': date === today,
                'is-outside': d.getMonth() !== monthIndex,
                'is-weekend': weekdayIndex(date) >= 5,
                'is-selected': date === st.date,
                'has-overdue': items.some((item) => item.overdue),
              }),
              tabindex: date === st.date ? 0 : -1,
              'data-cal-day': date,
              'aria-selected': date === st.date,
              'aria-label': dayLabel(date, items.length),
              ...dayDrop(cal.app, date),
              onclick: () => cal.setState({ date }),
            },
            h('span', { class: 'v-calendario-mini-num tabular' }, String(d.getDate())),
            items.length ? dots(items) : h('span', { class: 'v-calendario-dots', 'aria-hidden': 'true' }),
          );
        }),
      ),
    ),
  );
}

/** Lista do dia selecionado (celular), separada em prazos e inícios (chaves únicas por contêiner). */
export function dayList(cal, date, { phone = true, emptyText = 'Nada vence neste dia.' } = {}) {
  const { app, data } = cal;
  const items = itemsOn(data, date);
  const due = items.filter((item) => item.kind === 'due');
  const starts = items.filter((item) => item.kind === 'start');
  if (!items.length) {
    return emptyState({
      icon: 'calendar',
      title: emptyText,
      compact: true,
      class: 'v-calendario-day-empty',
      action: button({ label: 'Nova tarefa para este dia', icon: 'plus', size: 'sm', onclick: () => cal.create(date) }),
    });
  }
  return h(
    'div',
    { class: 'v-calendario-list' },
    due.length ? h('div', { key: 'due', class: 'v-calendario-rows' }, due.map((item) => itemRow(app, item, { phone }))) : null,
    starts.length
      ? h(
          'div',
          { key: 'starts', class: 'v-calendario-rows-group' },
          h('div', { class: 'v-calendario-rows-label' }, 'Inícios planejados'),
          h('div', { class: 'v-calendario-rows' }, starts.map((item) => itemRow(app, item, { phone }))),
        )
      : null,
  );
}

function phoneSelected(cal) {
  const { st, data } = cal;
  const count = itemsOn(data, st.date).length;
  return h(
    'section',
    { class: 'v-calendario-selected', 'aria-label': `Itens de ${longDay(st.date)}` },
    h(
      'div',
      { class: 'v-calendario-selected-head' },
      h('div', { class: 'v-calendario-selected-title' }, h('span', { class: 'strong' }, longDay(st.date)), h('span', { class: 'faint tabular' }, count ? plural(count, 'item', 'itens') : 'sem itens')),
      button({ label: 'Abrir o dia', size: 'sm', variant: 'ghost', iconRight: 'chevron-right', onclick: () => cal.setState({ mode: 'day' }) }),
    ),
    dayList(cal, st.date, { phone: true }),
  );
}

/**
 * Visão mensal.
 * @param {object} cal contexto da tela
 * @param {{ weeks: string[][] }} range
 */
export function monthView(cal, range) {
  if (cal.phone) return h('div', { class: 'v-calendario-month-phone' }, phoneGrid(cal, range), phoneSelected(cal));
  return monthGrid(cal, range);
}
