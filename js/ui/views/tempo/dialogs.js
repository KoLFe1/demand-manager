// Diálogos da tela "Tempo": "Adicionar horas", confirmação de sobreposição e escolha de tarefa.
// Toda escrita passa por app.cmd.*; avisos e erros pelos utilitários de shared/entity.js.

import { cx, h } from '../../../core/dom.js';
import { formatDate } from '../../../core/dates.js';
import { entryDate, formatDuration } from '../../../domain/timetracking.js';
import { dateInput, durationInput, field, textArea } from '../../kit/controls.js';
import { alertBox } from '../../kit/display.js';
import { icon } from '../../kit/icons.js';
import { openModal } from '../../kit/overlays.js';
import { pickFromList } from '../../kit/pickers.js';
import { handleError, notify, projectDot } from '../../shared/entity.js';
import { entryRangeText } from './model.js';

/** Erro de regra de negócio vindo de um comando. */
export function isCommandError(err) {
  return !!err && typeof err === 'object' && err.name === 'CommandError' && typeof err.code === 'string';
}

/**
 * Campo de horário nativo ('HH:MM') com o visual dos campos do kit.
 * @param {{ value: string, oninput: (value: string) => void, ariaLabel: string, size?: 'sm'|'md', invalid?: boolean, attrs?: object }} options
 */
export function timeInput({ value, oninput, ariaLabel, size = 'md', invalid = false, attrs }) {
  return h(
    'span',
    { class: cx('input', 'input-time', 'v-tempo-time', size === 'sm' && 'input-sm', invalid && 'is-invalid') },
    h('input', {
      class: 'input-el tabular',
      type: 'time',
      step: 60,
      'aria-label': ariaLabel,
      'aria-invalid': invalid ? true : null,
      value: value || '',
      oninput: (ev) => oninput(ev.currentTarget.value),
      onchange: (ev) => oninput(ev.currentTarget.value),
      ...attrs,
    }),
  );
}

/** Nome legível de uma tarefa para listas (código + nome). */
function taskLabel(app, task) {
  if (!task) return 'Tarefa indisponível';
  const code = app.sel.code('task', task);
  return code ? `${code} · ${task.name || 'Sem nome'}` : task.name || 'Sem nome';
}

/** Linhas descrevendo as sobreposições (tarefa, horário e quanto se sobrepõe). */
export function overlapList(app, overlaps) {
  const list = Array.isArray(overlaps) ? overlaps : [];
  return h(
    'ul',
    { class: 'v-tempo-overlap-list' },
    list.slice(0, 6).map((pair) => {
      const other = pair.b || pair.other;
      const task = other ? app.store.get('tasks', other.task_id) : null;
      const day = other ? entryDate(other) : null;
      return h(
        'li',
        { key: other ? other.id : String(Math.random()) },
        h('span', { class: 'strong' }, task ? task.name || 'Sem nome' : 'Outra tarefa'),
        h('span', { class: 'muted' }, ` — ${day ? `${formatDate(day, 'weekday')}, ` : ''}${other ? entryRangeText(other) : ''}`),
        pair.seconds ? h('span', { class: 'faint' }, ` (${formatDuration(pair.seconds)} em comum)`) : null,
      );
    }),
    list.length > 6 ? h('li', { class: 'faint' }, `e mais ${list.length - 6}`) : null,
  );
}

/**
 * Pergunta se grava mesmo com sobreposição. Resolve true para "Registrar mesmo assim".
 * @param {object} app
 * @param {Array<object>} overlaps pares de findOverlaps (b = o outro apontamento)
 * @returns {Promise<boolean>}
 */
export function confirmOverlap(app, overlaps) {
  return new Promise((resolve) => {
    openModal({
      title: 'Horário sobreposto',
      class: 'v-tempo-overlap-dialog',
      render: () =>
        h(
          'div',
          { class: 'v-tempo-dialog-body' },
          h('p', { class: 'm-0' }, 'Este horário se sobrepõe a outro apontamento. Registros sobrepostos contam o mesmo tempo duas vezes.'),
          overlapList(app, overlaps),
        ),
      actions: [
        { label: 'Ajustar horário', value: false },
        { label: 'Registrar mesmo assim', variant: 'primary', value: true, autofocus: true },
      ],
      onclose: (result) => resolve(result === true),
    });
  });
}

/**
 * Itens do seletor de tarefas: tarefas visíveis do escopo, as em aberto primeiro (em andamento no topo).
 * @param {object} app
 * @param {string|null} projectId escopo global
 */
export function taskItems(app, projectId) {
  const sel = app.sel;
  const rows = [];
  for (const task of sel.tasks()) {
    const project = sel.projectOf('task', task);
    if (projectId && (!project || project.id !== projectId)) continue;
    const category = sel.status(task.status).category;
    const open = sel.isOpen(task);
    const rank = !open ? 3 : category === 'active' ? 0 : category === 'review' || category === 'waiting' || category === 'blocked' ? 1 : 2;
    rows.push({ task, project, rank });
  }
  rows.sort((a, b) => a.rank - b.rank || String(b.task.updated_at || '').localeCompare(String(a.task.updated_at || '')));
  return rows.map(({ task, project, rank }) => {
    const demand = sel.demandOf(task);
    const code = sel.code('task', task);
    return {
      id: task.id,
      label: task.name || 'Sem nome',
      hint: [code, demand ? demand.name : null].filter(Boolean).join(' · '),
      group: rank < 3 ? 'Em aberto' : 'Concluídas e canceladas',
      icon: projectDot(project),
    };
  });
}

/**
 * Abre o seletor de tarefa (pesquisável, abertas primeiro).
 * @returns {Promise<string|null>} id da tarefa ou null
 */
export function pickTask(app, anchor, { projectId = null, current = null, title = 'Tarefa' } = {}) {
  return pickFromList(anchor, {
    items: taskItems(app, projectId),
    current,
    placeholder: 'Buscar tarefa pelo nome ou código…',
    title,
    width: 360,
  });
}

/**
 * Diálogo "Adicionar horas": tarefa, data, início, término OU duração e descrição. Validação pelo comando
 * addManualTime; sobreposição → aviso com "Registrar mesmo assim".
 * @param {object} app
 * @param {{ taskId?: string|null, date?: string, projectId?: string|null, onSaved?: (entry: object) => void }} [options]
 * @returns {{ close: Function, update: Function, el: HTMLElement }}
 */
export function openAddTimeDialog(app, { taskId = null, date, projectId = null, onSaved } = {}) {
  const state = {
    taskId: taskId && app.sel.task(taskId) ? taskId : null,
    date: date || app.clock.today(),
    start: '',
    end: '',
    duration: null,
    description: '',
    error: null,
    errorField: null,
    overlaps: null,
  };
  let dlg = null;
  const refresh = () => dlg && dlg.update();
  const set = (patch) => {
    Object.assign(state, patch, { error: null, errorField: null, overlaps: null });
    refresh();
  };

  const submit = (allowOverlap) => {
    const input = {
      task_id: state.taskId,
      date: state.date,
      start: state.start || null,
      end: state.end || null,
      durationMinutes: state.duration === null ? undefined : state.duration,
      description: state.description,
    };
    try {
      const entry = app.cmd.addManualTime(input, { allowOverlap: !!allowOverlap });
      dlg.close('saved');
      notify(app, `Tempo registrado: ${formatDuration(entry.duration_seconds)}`, {
        tone: 'success',
        duration: 6000,
        action: {
          label: 'Desfazer',
          onclick: () => {
            try {
              app.cmd.deleteTimeEntry(entry.id);
            } catch (err) {
              handleError(app, err);
            }
          },
        },
      });
      if (typeof onSaved === 'function') onSaved(entry);
    } catch (err) {
      if (isCommandError(err) && err.code === 'overlap') {
        state.overlaps = (err.data && err.data.overlaps) || [];
        state.error = null;
        state.errorField = null;
      } else if (isCommandError(err)) {
        state.error = err.message;
        state.errorField = err.data && err.data.field ? err.data.field : null;
        state.overlaps = null;
      } else {
        handleError(app, err);
        return;
      }
      refresh();
    }
  };

  const errorFor = (name) => (state.errorField === name ? state.error : null);
  const task = () => (state.taskId ? app.sel.task(state.taskId) : null);

  const render = () => {
    const current = task();
    return h(
      'form',
      {
        class: 'v-tempo-add',
        'data-add-time': 'true',
        novalidate: true,
        onsubmit: (ev) => {
          ev.preventDefault();
          submit(false);
        },
        onkeydown: (ev) => {
          if (ev.key !== 'Enter' || ev.isComposing || ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'BUTTON') return;
          if (ev.target.tagName !== 'INPUT') return;
          ev.preventDefault();
          // Deixa o campo de duração confirmar o texto (change) antes de gravar.
          setTimeout(() => submit(!!state.overlaps), 0);
        },
      },
      field(
        { label: 'Tarefa', error: errorFor('task'), required: true },
        h(
          'button',
          {
            type: 'button',
            class: cx('v-tempo-task-pick', !current && 'is-empty', errorFor('task') && 'is-invalid'),
            'data-action': 'pick-task',
            'aria-label': current ? `Tarefa: ${current.name}. Clique para trocar` : 'Escolher a tarefa',
            onclick: async (ev) => {
              const chosen = await pickTask(app, ev.currentTarget, { projectId, current: state.taskId });
              if (chosen) set({ taskId: chosen });
            },
          },
          current ? projectDot(app.sel.projectOf('task', current)) : icon('search', { size: 14 }),
          h('span', { class: 'v-tempo-task-pick-text truncate' }, current ? taskLabel(app, current) : 'Escolher tarefa…'),
          icon('chevron-down', { size: 14, class: 'v-tempo-task-pick-caret' }),
        ),
      ),
      h(
        'div',
        { class: 'v-tempo-add-grid' },
        field({ label: 'Data', error: errorFor('date') }, dateInput({ value: state.date, ariaLabel: 'Data', onchange: (value) => set({ date: value || '' }), attrs: { name: 'date' } })),
        field({ label: 'Início', error: errorFor('start') }, timeInput({ value: state.start, ariaLabel: 'Início', invalid: !!errorFor('start'), oninput: (value) => set({ start: value }), attrs: { name: 'start' } })),
        field({ label: 'Término', error: errorFor('end') }, timeInput({ value: state.end, ariaLabel: 'Término', invalid: !!errorFor('end'), oninput: (value) => set({ end: value }), attrs: { name: 'end' } })),
        field(
          { label: 'Duração', error: errorFor('duration') },
          durationInput({ minutes: state.duration, ariaLabel: 'Duração', placeholder: 'ex.: 1h30', onchange: (minutes) => set({ duration: minutes }), attrs: { name: 'duration' } }),
        ),
      ),
      h('p', { class: 'v-tempo-add-hint' }, 'Informe início e término, ou só a duração (com ou sem o início).'),
      field(
        { label: 'Descrição', hint: 'Opcional' },
        textArea({
          value: state.description,
          rows: 2,
          autoGrow: true,
          placeholder: 'O que foi feito?',
          ariaLabel: 'Descrição',
          oninput: (value) => {
            state.description = value;
          },
          onsubmit: () => submit(!!state.overlaps),
          attrs: { name: 'description' },
        }),
      ),
      state.error && !state.errorField ? alertBox({ tone: 'danger', text: state.error }) : null,
      state.overlaps
        ? alertBox({
            tone: 'warning',
            title: 'Este horário se sobrepõe a outro apontamento',
            text: overlapList(app, state.overlaps),
            class: 'v-tempo-add-overlap',
          })
        : null,
    );
  };

  dlg = openModal({
    title: 'Adicionar horas',
    size: 'md',
    class: 'v-tempo-add-dialog',
    render,
    actions: () =>
      state.overlaps
        ? [
            { label: 'Cancelar', value: 'cancel' },
            { label: 'Ajustar horário', onclick: () => set({}) },
            { label: 'Registrar mesmo assim', variant: 'primary', icon: 'alert-triangle', onclick: () => submit(true) },
          ]
        : [
            { label: 'Cancelar', value: 'cancel' },
            { label: 'Registrar', variant: 'primary', icon: 'check', onclick: () => submit(false) },
          ],
  });
  return dlg;
}

