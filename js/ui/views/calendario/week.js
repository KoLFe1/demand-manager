// Calendário — visão semanal.
//
// Computador: faixa "Atrasadas" (itens abertos com prazo vencido, arrastáveis para um dia) e sete colunas
// (segunda→domingo) com todos os itens de cada dia, a contagem e a soma das estimativas. Arrastar entre
// colunas muda o prazo; clicar na área vazia de uma coluna (ou no "+") cria uma tarefa para aquele dia.
//
// Celular: lista vertical agrupada por dia.

import { cx, h } from '../../../core/dom.js';
import { WEEKDAYS_LONG, WEEKDAYS_SHORT, formatDate, parseDate, weekdayIndex } from '../../../core/dates.js';
import { plural } from '../../../core/format.js';
import { formatDurationText } from '../../kit/controls.js';
import { sectionHeader } from '../../kit/display.js';
import { addButton, dayDrop, itemCard, itemChip, itemRow, limitedOverdue } from './items.js';
import { itemsOn, longDay } from './model.js';

/** Resumo do dia: '3 itens · 4h 30min'. */
function daySummary(cal, date) {
  const items = itemsOn(cal.data, date);
  const minutes = cal.data.estimateByDay.get(date) || 0;
  const parts = [items.length ? plural(items.length, 'item', 'itens') : 'Nenhum item'];
  if (minutes > 0) parts.push(formatDurationText(minutes));
  return { count: items.length, minutes, text: parts.join(' · ') };
}

/**
 * Faixa "Atrasadas" (abertas com prazo vencido). Recolhível; os chips podem ser arrastados para um dia.
 * @param {object} cal
 * @param {{ phone?: boolean }} [options]
 */
export function overdueStrip(cal, { phone = false } = {}) {
  const { app, st, data } = cal;
  const list = data.overdue;
  if (!list.length) return null;
  const collapsed = st.overdueCollapsed;
  return h(
    'section',
    { class: cx('v-calendario-overdue', collapsed && 'is-collapsed'), 'aria-label': 'Atrasadas', 'data-cal-overdue': 'true' },
    sectionHeader({
      title: 'Atrasadas',
      count: list.length,
      icon: 'alert-circle',
      collapsed,
      ontoggle: () => cal.setState({ overdueCollapsed: !collapsed }),
      class: 'v-calendario-overdue-head',
    }),
    collapsed ? null : overdueBody(cal, phone),
  );
}

function overdueBody(cal, phone) {
  const { app } = cal;
  const { nodes, toggle } = limitedOverdue(cal, (item) => (phone ? itemRow(app, item, { phone: true }) : itemChip(app, item)));
  if (phone) return [h('div', { key: 'rows', class: 'v-calendario-rows' }, nodes), toggle];
  return h('div', { class: 'v-calendario-overdue-list' }, nodes, toggle);
}

/** Coluna de um dia (computador). */
function dayColumn(cal, date) {
  const { app, st, today } = cal;
  const items = itemsOn(cal.data, date);
  const summary = daySummary(cal, date);
  const d = parseDate(date);
  const i = weekdayIndex(date);
  return h(
    'section',
    {
      key: date,
      class: cx('v-calendario-col', { 'is-today': date === today, 'is-weekend': i >= 5, 'is-selected': date === st.date, 'is-past': date < today }),
      'data-cal-col': date,
      'aria-label': `${WEEKDAYS_LONG[i]}, ${formatDate(date, 'long')} — ${summary.text}`,
      ...dayDrop(app, date),
    },
    h(
      'header',
      { class: 'v-calendario-col-head' },
      h(
        'button',
        {
          type: 'button',
          class: 'v-calendario-col-title',
          title: `Abrir ${longDay(date)}`,
          onclick: () => cal.setState({ mode: 'day', date }),
        },
        h('span', { class: 'v-calendario-col-weekday' }, WEEKDAYS_SHORT[i]),
        h('span', { class: 'v-calendario-col-num tabular' }, String(d.getDate())),
      ),
      addButton(date, () => cal.create(date), today),
      h('div', { class: 'v-calendario-col-meta tabular', 'data-cal-summary': date }, summary.text),
    ),
    h(
      'div',
      {
        class: 'v-calendario-col-body',
        onclick: (ev) => {
          if (ev.target !== ev.currentTarget) return;
          cal.create(date);
        },
      },
      items.map((item) => itemCard(app, item)),
    ),
  );
}

/** Lista por dia (celular). */
function phoneWeek(cal, range) {
  const { app, today } = cal;
  return h(
    'div',
    { class: 'v-calendario-week-phone' },
    overdueStrip(cal, { phone: true }),
    range.days.map((date) => {
      const items = itemsOn(cal.data, date);
      const summary = daySummary(cal, date);
      const i = weekdayIndex(date);
      const d = parseDate(date);
      const due = items.filter((item) => item.kind === 'due');
      const starts = items.filter((item) => item.kind === 'start');
      return h(
        'section',
        { key: date, class: cx('v-calendario-wday', date === today && 'is-today'), 'data-cal-col': date, ...dayDrop(app, date) },
        h(
          'header',
          { class: 'v-calendario-wday-head' },
          h(
            'button',
            { type: 'button', class: 'v-calendario-wday-title', onclick: () => cal.setState({ mode: 'day', date }), title: `Abrir ${longDay(date)}` },
            h('span', { class: 'v-calendario-wday-num tabular' }, String(d.getDate())),
            h('span', { class: 'v-calendario-wday-name' }, WEEKDAYS_LONG[i]),
          ),
          h('span', { class: 'v-calendario-wday-meta tabular' }, summary.text),
          addButton(date, () => cal.create(date), today),
        ),
        due.length ? h('div', { key: 'due', class: 'v-calendario-rows' }, due.map((item) => itemRow(app, item, { phone: true }))) : null,
        starts.length ? h('div', { key: 'starts', class: 'v-calendario-rows is-starts' }, starts.map((item) => itemRow(app, item, { phone: true }))) : null,
      );
    }),
  );
}

/**
 * Visão semanal.
 * @param {object} cal
 * @param {{ days: string[] }} range
 */
export function weekView(cal, range) {
  if (cal.phone) return phoneWeek(cal, range);
  return h(
    'div',
    { class: 'v-calendario-week' },
    overdueStrip(cal),
    h('div', { class: 'v-calendario-week-scroll' }, h('div', { class: 'v-calendario-week-grid' }, range.days.map((date) => dayColumn(cal, date)))),
  );
}
