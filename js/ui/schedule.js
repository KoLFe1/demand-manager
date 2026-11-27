// "Agendar datas vazias" de uma demanda: diálogo com data de início, prévia (tarefa, início, prazo, "mantida")
// e aplicação num único comando (app.cmd.scheduleEmptyDates), com [Desfazer] no aviso.
//
//   await openScheduleDialog(app, demandId);   // true se aplicou
//
// Aberto pelo menu "…" do painel da demanda e pelo cabeçalho da lista "Sem datas" do Cronograma.

import { cx, h } from '../core/dom.js';
import { addDays, addWorkdays, formatDate } from '../core/dates.js';
import { dateInput, field } from './kit/controls.js';
import { icon } from './kit/icons.js';
import { openModal } from './kit/overlays.js';
import { handleError, notify } from './shared/entity.js';

const isCommandError = (err) => !!err && typeof err === 'object' && err.name === 'CommandError' && typeof err.code === 'string';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Próximo dia útil depois de hoje (padrão do início). */
export function nextBusinessDay(today) {
  return addWorkdays(addDays(today, 1), 0);
}

/**
 * Abre o diálogo "Agendar datas vazias".
 * @param {object} app
 * @param {string} demandId
 * @returns {Promise<boolean>} true se o agendamento foi aplicado
 */
export function openScheduleDialog(app, demandId) {
  return new Promise((resolve) => {
    const demand = app.sel.demand(demandId);
    if (!demand) {
      resolve(false);
      return;
    }
    const today = app.clock.today();
    const form = { startDate: nextBusinessDay(today), error: null };
    let applied = false;
    let dialog = null;
    const refresh = () => dialog && dialog.update();
    const plan = () => (form.startDate ? app.sel.schedulePlan(demandId, form.startDate) : null);
    const fmt = (d) => (d ? formatDate(d, 'daymonth', today) : '—');

    const apply = () => {
      const p = plan();
      if (!p) {
        form.error = 'Informe a data de início.';
        refresh();
        return;
      }
      if (!p.changes.length) {
        dialog.close('nothing');
        return;
      }
      let result;
      try {
        result = app.cmd.scheduleEmptyDates(demandId, { startDate: form.startDate });
      } catch (err) {
        if (isCommandError(err)) {
          form.error = err.message;
          refresh();
        } else handleError(app, err);
        return;
      }
      applied = true;
      dialog.close('applied');
      const changes = result.changes;
      notify(app, result.count ? `${plural(result.count, 'tarefa agendada', 'tarefas agendadas')}${result.end ? ` até ${fmt(result.end)}` : ''}` : 'Datas da demanda preenchidas', {
        tone: 'success',
        duration: 8000,
        action: {
          label: 'Desfazer',
          onclick: () => {
            try {
              app.cmd.undoScheduleEmptyDates(changes);
              notify(app, 'Agendamento desfeito', { duration: 2500 });
            } catch (err) {
              handleError(app, err);
            }
          },
        },
      });
    };

    const preview = () => {
      const p = plan();
      if (!p) return h('p', { class: 'sch-empty' }, 'Escolha a data de início para ver a prévia.');
      const head = h(
        'div',
        { class: 'sch-head' },
        h('span', { class: 'sch-count' }, p.count ? `${plural(p.count, 'tarefa', 'tarefas')} sem datas ${p.count === 1 ? 'será agendada' : 'serão agendadas'}` : 'Nenhuma tarefa aberta sem datas'),
        p.demandPatch.planned_start || p.demandPatch.due_date
          ? h('span', { class: 'sch-demand' }, `Demanda: ${p.demandPatch.planned_start ? `início ${fmt(p.demandPatch.planned_start)}` : ''}${p.demandPatch.planned_start && p.demandPatch.due_date ? ' · ' : ''}${p.demandPatch.due_date ? `prazo ${fmt(p.demandPatch.due_date)}` : ''}`)
          : null,
      );
      const warning = p.warning ? h('p', { class: 'sch-warning', role: 'alert' }, icon('alert-triangle', { size: 14 }), h('span', null, p.warning)) : null;
      if (!p.rows.length) return h('div', { class: 'sch-preview' }, head, warning);
      return h(
        'div',
        { class: 'sch-preview' },
        head,
        warning,
        h(
          'table',
          { class: 'sch-table' },
          h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Tarefa'), h('th', { scope: 'col' }, 'Início'), h('th', { scope: 'col' }, 'Prazo'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Situação')))),
          h(
            'tbody',
            null,
            p.rows.map((row) =>
              h(
                'tr',
                { key: row.id, class: cx('sch-row', `is-${row.state}`, row.depth && 'is-sub', row.overDue && 'is-over'), 'data-sch-task': row.id, 'data-state': row.state },
                h('td', { class: 'sch-name' }, row.depth ? '↳ ' : null, row.task.name),
                h('td', { class: 'sch-date tabular' }, fmt(row.planned_start)),
                h('td', { class: 'sch-date tabular', title: row.overDue ? 'Passa do prazo da demanda' : null }, fmt(row.due_date), row.overDue ? h('span', { class: 'sch-over', 'aria-label': 'Passa do prazo da demanda' }, ' !') : null),
                h('td', { class: 'sch-state' }, row.state === 'kept' ? 'mantida' : row.state === 'empty' ? h('span', { title: row.reason }, 'sem datas') : 'nova'),
              ),
            ),
          ),
        ),
      );
    };

    const render = () =>
      h(
        'div',
        { class: 'sch-form' },
        h('p', { class: 'sch-intro' }, 'Preenche só as datas vazias das tarefas abertas, seguindo dependências e estimativas (dias úteis). Datas existentes não mudam.'),
        field(
          { label: 'Início', error: form.error },
          dateInput({
            value: form.startDate,
            ariaLabel: 'Data de início',
            class: 'sch-start',
            onchange: (value) => {
              form.startDate = value || null;
              form.error = null;
              refresh();
            },
          }),
        ),
        preview(),
      );

    dialog = openModal({
      title: `Agendar datas vazias — ${demand.name}`,
      size: 'md',
      class: 'sch-modal',
      render,
      actions: () => [
        { label: 'Cancelar', value: 'cancel' },
        { label: 'Agendar', variant: 'primary', onclick: () => apply() },
      ],
      onclose: () => resolve(applied),
    });
  });
}
