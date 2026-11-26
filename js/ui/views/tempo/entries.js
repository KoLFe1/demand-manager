// Lista de apontamentos do período, agrupada por dia (mais recente primeiro), com edição no lugar e
// exclusão com "Desfazer".

import { cx, h } from '../../../core/dom.js';
import { formatDate, relativeDay } from '../../../core/dates.js';
import { plural } from '../../../core/format.js';
import { ENTRY_SOURCE, TIMER, elapsedSeconds, formatDuration, timerState } from '../../../domain/timetracking.js';
import { button, dateInput, durationInput, iconButton, textInput } from '../../kit/controls.js';
import { alertBox, badge } from '../../kit/display.js';
import { icon } from '../../kit/icons.js';
import { entityAttrs, entityTitle, handleError, liveElapsed, notify } from '../../shared/entity.js';
import { confirmOverlap, isCommandError, timeInput } from './dialogs.js';
import { draftFromEntry, entryRangeText, patchFromDraft, recreateInput } from './model.js';

/** Elementos que tratam o próprio clique dentro de uma linha (o clique não abre o painel). */
const INTERACTIVE = 'button, a, input, textarea, select, label, form, [data-stop], [role="checkbox"]';

/** Clique no corpo de uma linha abre o painel da tarefa (controles tratam o próprio clique). */
export function openOnBodyClick(app, type, id) {
  return (ev) => {
    const row = ev.currentTarget;
    const hit = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest(INTERACTIVE) : null;
    if (hit && hit !== row && row.contains(hit)) return;
    if (id) app.ui.openPanel(type, id);
  };
}

/** Enter/Espaço com a linha focada abre o painel. */
export function openOnKey(app, type, id) {
  return (ev) => {
    if (ev.target !== ev.currentTarget || (ev.key !== 'Enter' && ev.key !== ' ')) return;
    ev.preventDefault();
    if (id) app.ui.openPanel(type, id);
  };
}

/** Texto da dica de sobreposição de um apontamento. */
function overlapTitle(app, list) {
  return list
    .slice(0, 4)
    .map(({ other, seconds }) => {
      const task = app.store.get('tasks', other.task_id);
      return `Sobrepõe ${formatDuration(seconds)} com “${task ? task.name || 'Sem nome' : 'outra tarefa'}” (${entryRangeText(other)})`;
    })
    .concat(list.length > 4 ? [`e mais ${list.length - 4}`] : [])
    .join('\n');
}

/** Exclui um apontamento e oferece "Desfazer" (recria com os mesmos dados). */
export function deleteEntry(app, entry) {
  try {
    app.cmd.deleteTimeEntry(entry.id);
  } catch (err) {
    handleError(app, err);
    return;
  }
  const input = recreateInput(entry);
  notify(app, `Apontamento de ${formatDuration(entry.duration_seconds)} excluído`, {
    duration: 8000,
    action: input
      ? {
          label: 'Desfazer',
          onclick: () => {
            try {
              app.cmd.addManualTime(input, { allowOverlap: true });
              notify(app, 'Apontamento restaurado', { tone: 'success' });
            } catch (err) {
              handleError(app, err);
            }
          },
        }
      : undefined,
  });
}

/** Grava o rascunho de edição; sobreposição pergunta antes; erros de validação ficam no formulário. */
export async function saveDraft(app, ctx, entry, draft) {
  const patch = patchFromDraft(entry, draft);
  if (!Object.keys(patch).length) {
    ctx.setState({ edit: null });
    return true;
  }
  const run = (allowOverlap) => app.cmd.updateTimeEntry(entry.id, patch, { allowOverlap });
  try {
    run(false);
  } catch (err) {
    if (isCommandError(err) && err.code === 'overlap') {
      const ok = await confirmOverlap(app, (err.data && err.data.overlaps) || []);
      if (!ok) return false;
      try {
        run(true);
      } catch (inner) {
        return failEdit(app, ctx, inner);
      }
    } else {
      return failEdit(app, ctx, err);
    }
  }
  ctx.setState({ edit: null });
  notify(app, 'Apontamento atualizado', { tone: 'success' });
  return true;
}

function failEdit(app, ctx, err) {
  if (isCommandError(err)) {
    ctx.setState((prev) => ({ edit: prev.edit ? { ...prev.edit, error: err.message, errorField: err.data && err.data.field ? err.data.field : null } : prev.edit }));
  } else {
    handleError(app, err);
  }
  return false;
}

/** Atualiza um campo do rascunho (forma funcional: nunca perde o que foi digitado em outro campo). */
function setDraft(ctx, patch) {
  ctx.setState((prev) => (prev.edit ? { edit: { ...prev.edit, ...patch, error: null, errorField: null } } : {}));
}

/** Formulário de edição no lugar de um apontamento. */
function entryEditor(app, ctx, entry, draft) {
  const task = app.sel.task(entry.task_id);
  const err = (name) => (draft.errorField === name ? draft.error : null);
  const cancel = () => ctx.setState({ edit: null });
  const save = () => saveDraft(app, ctx, entry, draft);
  return h(
    'form',
    {
      class: 'v-tempo-entry v-tempo-entry-edit',
      key: entry.id,
      'data-entry': entry.id,
      'data-editing': 'true',
      novalidate: true,
      'aria-label': `Editar apontamento de ${task ? task.name : 'tarefa'}`,
      onsubmit: (ev) => {
        ev.preventDefault();
        save();
      },
      onkeydown: (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          cancel();
        } else if (ev.key === 'Enter' && !ev.isComposing && ev.target.tagName === 'INPUT') {
          ev.preventDefault();
          setTimeout(save, 0); // o campo de duração confirma o texto antes
        }
      },
    },
    h(
      'div',
      { class: 'v-tempo-edit-head' },
      icon('pencil', { size: 14 }),
      h('span', { class: 'strong truncate' }, task ? task.name || 'Sem nome' : 'Tarefa indisponível'),
    ),
    h(
      'div',
      { class: 'v-tempo-edit-grid' },
      labelled('Data', dateInput({ value: draft.date, size: 'sm', ariaLabel: 'Data', onchange: (value) => setDraft(ctx, { date: value || '' }), attrs: { name: 'date' } }), err('date')),
      labelled('Início', timeInput({ value: draft.start, size: 'sm', ariaLabel: 'Início', invalid: !!err('start'), oninput: (value) => setDraft(ctx, { start: value }), attrs: { name: 'start' } }), err('start')),
      labelled('Término', timeInput({ value: draft.end, size: 'sm', ariaLabel: 'Término', invalid: !!err('end'), oninput: (value) => setDraft(ctx, { end: value }), attrs: { name: 'end' } }), err('end')),
      labelled(
        'Duração',
        durationInput({ minutes: draft.duration, size: 'sm', ariaLabel: 'Duração', onchange: (minutes) => setDraft(ctx, { duration: minutes, durationTouched: true }), attrs: { name: 'duration' } }),
        err('duration'),
      ),
      labelled(
        'Descrição',
        textInput({ value: draft.description, size: 'sm', placeholder: 'O que foi feito?', ariaLabel: 'Descrição', oninput: (value) => setDraft(ctx, { description: value }), attrs: { name: 'description' } }),
        null,
        'is-wide',
      ),
    ),
    draft.error && !draft.errorField ? alertBox({ tone: 'danger', text: draft.error }) : null,
    h(
      'div',
      { class: 'v-tempo-edit-actions' },
      h('span', { class: 'v-tempo-edit-tip' }, 'Início e término recalculam a duração. Enter salva, Esc cancela.'),
      button({ label: 'Cancelar', size: 'sm', variant: 'ghost', onclick: cancel, attrs: { 'data-action': 'cancel-edit' } }),
      button({ label: 'Salvar', size: 'sm', variant: 'primary', type: 'submit', attrs: { 'data-action': 'save-edit' } }),
    ),
  );
}

function labelled(text, control, error, extra) {
  return h(
    'label',
    { class: cx('v-tempo-edit-field', extra, error && 'has-error') },
    h('span', { class: 'v-tempo-edit-label' }, text),
    control,
    error ? h('span', { class: 'field-error', role: 'alert' }, icon('alert-circle', { size: 12 }), h('span', null, error)) : null,
  );
}

/** Linha de um apontamento. */
function entryRow(app, ctx, entry, overlaps, nowMs) {
  const task = app.sel.task(entry.task_id);
  const demand = task ? app.sel.demandOf(task) : null;
  const state = timerState(entry);
  const active = state !== TIMER.DONE;
  const attrs = entityAttrs(app, 'task', task);
  const conflicts = overlaps.get(entry.id) || null;
  return h(
    'div',
    {
      ...attrs,
      key: entry.id,
      class: cx('v-tempo-entry', attrs.class, conflicts && 'has-overlap', active && 'is-active'),
      'data-entry': entry.id,
      tabindex: 0,
      onclick: openOnBodyClick(app, 'task', task ? task.id : null),
      onkeydown: openOnKey(app, 'task', task ? task.id : null),
    },
    h('span', { class: cx('v-tempo-entry-time tabular', !entry.started_at && 'is-untimed') }, entryRangeText(entry)),
    h(
      'span',
      { class: 'v-tempo-entry-dur tabular' },
      state === TIMER.RUNNING ? liveElapsed(app, entry) : formatDuration(elapsedSeconds(entry, nowMs)),
    ),
    h(
      'span',
      { class: 'v-tempo-entry-main' },
      h(
        'span',
        { class: 'v-tempo-entry-task' },
        task ? entityTitle(app, 'task', task) : h('span', { class: 'en-title is-missing' }, 'Tarefa indisponível'),
        demand ? h('span', { class: 'v-tempo-entry-demand truncate', title: `Demanda: ${demand.name}` }, demand.name) : null,
      ),
      entry.description ? h('span', { class: 'v-tempo-entry-desc', title: entry.description }, entry.description) : null,
    ),
    h(
      'span',
      { class: 'v-tempo-entry-tags' },
      active
        ? badge(state === TIMER.RUNNING ? 'em andamento' : 'pausado', { tone: state === TIMER.RUNNING ? 'success' : 'neutral', icon: state === TIMER.RUNNING ? 'play' : 'pause' })
        : null,
      h(
        'span',
        { class: 'v-tempo-source', title: entry.source === ENTRY_SOURCE.TIMER ? 'Registrado pelo cronômetro' : 'Lançado manualmente' },
        icon(entry.source === ENTRY_SOURCE.TIMER ? 'timer' : 'pencil', { size: 12 }),
        h('span', null, entry.source === ENTRY_SOURCE.TIMER ? 'cronômetro' : 'manual'),
      ),
      conflicts ? badge('sobreposto', { tone: 'danger', icon: 'alert-triangle', title: overlapTitle(app, conflicts), class: 'v-tempo-overlap' }) : null,
    ),
    h(
      'span',
      { class: 'v-tempo-entry-actions', 'data-stop': true },
      active
        ? null
        : iconButton({
            icon: 'pencil',
            title: 'Editar apontamento',
            size: 'sm',
            attrs: { 'data-action': 'edit-entry' },
            onclick: (ev) => {
              ev.stopPropagation();
              ctx.setState({ edit: draftFromEntry(entry) });
            },
          }),
      active
        ? null
        : iconButton({
            icon: 'trash',
            title: 'Excluir apontamento',
            size: 'sm',
            attrs: { 'data-action': 'delete-entry' },
            onclick: (ev) => {
              ev.stopPropagation();
              deleteEntry(app, entry);
            },
          }),
    ),
  );
}

/** Quantos apontamentos mostrar antes do "Mostrar mais". */
export const ENTRY_PAGE = 150;

/**
 * Seção "Apontamentos": dias (cabeçalho com o total) e as linhas.
 * @param {object} app
 * @param {object} ctx
 * @param {object} data resultado de computePeriod
 */
export function entriesSection(app, ctx, data) {
  const today = app.clock.today();
  const edit = ctx.state.edit && typeof ctx.state.edit === 'object' ? ctx.state.edit : null;
  const limit = Number.isInteger(ctx.state.entryLimit) && ctx.state.entryLimit > ENTRY_PAGE ? ctx.state.entryLimit : ENTRY_PAGE;
  let shown = 0;
  const groups = [];
  for (const group of data.days) {
    if (shown >= limit) break;
    const list = group.entries.slice(0, Math.max(0, limit - shown));
    shown += list.length;
    const rel = relativeDay(group.day, today);
    groups.push(
      h(
        'div',
        { class: 'v-tempo-day', key: group.day, 'data-day': group.day },
        h(
          'div',
          { class: 'v-tempo-day-head' },
          h('span', { class: 'v-tempo-day-name' }, formatDate(group.day, 'weekday', today)),
          rel === 'hoje' || rel === 'ontem' ? h('span', { class: 'v-tempo-day-rel' }, rel) : null,
          group.overlapping ? badge(plural(group.overlapping, 'sobreposto', 'sobrepostos'), { tone: 'danger', icon: 'alert-triangle' }) : null,
          h('span', { class: 'v-tempo-day-spacer' }),
          h('span', { class: 'v-tempo-day-count' }, plural(group.entries.length, 'apontamento', 'apontamentos')),
          h('span', { class: 'v-tempo-day-total tabular', 'data-day-total': group.day }, formatDuration(group.seconds)),
        ),
        h(
          'div',
          { class: 'v-tempo-day-list' },
          list.map((entry) => (edit && edit.id === entry.id && timerState(entry) === TIMER.DONE ? entryEditor(app, ctx, entry, edit) : entryRow(app, ctx, entry, data.overlaps, data.nowMs))),
        ),
      ),
    );
  }
  const rest = data.count - shown;
  return h(
    'div',
    { class: 'v-tempo-days' },
    groups,
    rest > 0
      ? h(
          'div',
          { class: 'v-tempo-more' },
          button({ label: `Mostrar mais ${plural(Math.min(rest, ENTRY_PAGE), 'apontamento', 'apontamentos')}`, size: 'sm', variant: 'ghost', icon: 'chevron-down', onclick: () => ctx.setState({ entryLimit: limit + ENTRY_PAGE }) }),
        )
      : null,
  );
}
