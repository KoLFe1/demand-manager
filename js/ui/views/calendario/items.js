// Calendário — peças de item: chip compacto (mês), cartão (semana), linhas padrão (dia / celular),
// mover prazo por arrasto (com Desfazer), lista "+N mais" e o diálogo "Adicionar horas".
//
// Os controles de status, prioridade, prazo e cronômetro vêm de shared/entity.js; aqui só há a apresentação
// própria do calendário (glifos compactos) e o arrastar entre dias.

import { cx, h } from '../../../core/dom.js';
import { formatDate, isValidDateStr } from '../../../core/dates.js';
import { plural } from '../../../core/format.js';
import { formatDuration } from '../../../domain/timetracking.js';
import { button, dateInput, field, formatDurationText, iconButton, parseDurationText, textInput } from '../../kit/controls.js';
import { STATUS_COLORS, STATUS_ICONS, alertBox, priorityBadge } from '../../kit/display.js';
import { dragSource, dropTarget } from '../../kit/dnd.js';
import { icon } from '../../kit/icons.js';
import { openModal, openPopover } from '../../kit/overlays.js';
import { pickFromList } from '../../kit/pickers.js';
import {
  checkControl,
  demandRow,
  entityAttrs,
  handleError,
  notify,
  projectDot,
  statusControl,
  surfaceOutcome,
  taskRow,
} from '../../shared/entity.js';
import { OVERDUE_LIMIT, longDay } from './model.js';

/** Tipo usado no arrastar e soltar entre dias. */
export const DRAG_TYPE = 'cal-item';

const nameOf = (entity) => (entity && typeof entity.name === 'string' && entity.name.trim() ? entity.name.trim() : 'Sem nome');
const quoted = (text) => `“${text}”`;

/** Abre o painel lateral do item. */
export function openItem(app, item) {
  if (app.ui && typeof app.ui.openPanel === 'function') app.ui.openPanel(item.type, item.id);
}

/** Dica (title) de um item: código, nome, status, tipo de marcação e atraso. */
function itemTitle(app, item) {
  const code = app.sel.code(item.type, item.entity);
  const status = app.sel.status(item.entity.status);
  const what = item.kind === 'start' ? 'Início planejado' : item.type === 'demand' ? 'Prazo da demanda' : 'Prazo da tarefa';
  const lines = [`${code ? code + ' · ' : ''}${nameOf(item.entity)}`, `${what} · ${status.label}`];
  if (item.overdue) lines.push('Atrasada');
  return lines.join('\n');
}

/** Glifo à esquerda do chip: anel vazado (início), camadas (demanda) ou o ícone do status (tarefa). */
function itemGlyph(app, item, size = 12) {
  const status = app.sel.status(item.entity.status);
  const color = STATUS_COLORS.includes(status.color) ? status.color : 'gray';
  if (item.kind === 'start') return h('span', { class: 'v-calendario-glyph is-start', 'aria-hidden': 'true' });
  const glyph = item.type === 'demand' ? 'layers' : STATUS_ICONS[status.category] || 'circle';
  return h('span', { class: cx('v-calendario-glyph', `status-${color}`), 'aria-hidden': 'true' }, icon(glyph, { size }));
}

/** Marca de prioridade só para P1/P2 (discreta). */
function priorityMark(item) {
  const p = item.entity.priority;
  if (p !== 'P1' && p !== 'P2') return null;
  return priorityBadge(p, { compact: true, class: 'v-calendario-prio' });
}

/** Props de arrasto de um item (prazo ou início) para outro dia. */
export function itemDrag(item) {
  return dragSource({ type: DRAG_TYPE, id: item.key, data: { type: item.type, id: item.id, kind: item.kind, date: item.date } });
}

/** Props de um dia que recebe itens arrastados. */
export function dayDrop(app, date) {
  return dropTarget({
    accept: [DRAG_TYPE],
    canDrop: ({ data }) => !!data && data.date !== date,
    ondrop: ({ data }) => moveItem(app, data, date),
  });
}

/** Classes comuns de estado de um item. */
function itemClasses(item) {
  return {
    'is-demand': item.type === 'demand',
    'is-task': item.type === 'task',
    'is-start': item.kind === 'start',
    'is-overdue': item.overdue,
    'is-closed': !item.open,
  };
}

/** Teclado de um elemento focável que abre o item (Enter / Espaço). */
function openOnKey(app, item) {
  return (ev) => {
    if (ev.target !== ev.currentTarget || (ev.key !== 'Enter' && ev.key !== ' ')) return;
    ev.preventDefault();
    openItem(app, item);
  };
}

/**
 * Chip compacto do mês: glifo + nome (+ marca P1/P2). Clicar abre o painel; arrastável para outro dia.
 * @param {object} app
 * @param {import('./model.js').CalItem} item
 * @param {{ draggable?: boolean, onopen?: Function }} [options]
 */
export function itemChip(app, item, { draggable = true, onopen } = {}) {
  const attrs = entityAttrs(app, item.type, item.entity);
  return h(
    'div',
    {
      ...(draggable ? itemDrag(item) : null),
      ...attrs,
      key: item.key,
      class: cx('v-calendario-chip', attrs.class, itemClasses(item)),
      tabindex: 0,
      role: 'button',
      title: itemTitle(app, item),
      'aria-label': `${item.kind === 'start' ? 'Início planejado: ' : ''}${item.type === 'demand' ? 'Demanda' : 'Tarefa'} ${nameOf(item.entity)}${item.overdue ? ' (atrasada)' : ''}`,
      onclick: (ev) => {
        ev.stopPropagation();
        if (typeof onopen === 'function') onopen(item);
        openItem(app, item);
      },
      onkeydown: (ev) => {
        if (ev.target !== ev.currentTarget || (ev.key !== 'Enter' && ev.key !== ' ')) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (typeof onopen === 'function') onopen(item);
        openItem(app, item);
      },
    },
    itemGlyph(app, item),
    h('span', { class: 'v-calendario-chip-name' }, nameOf(item.entity)),
    priorityMark(item),
  );
}

/**
 * Cartão da semana: controle de conclusão/status, código, prioridade, nome (duas linhas) e contexto.
 * @param {object} app
 * @param {import('./model.js').CalItem} item
 */
export function itemCard(app, item) {
  const { entity } = item;
  const attrs = entityAttrs(app, item.type, entity);
  const demand = item.type === 'task' ? app.sel.demandOf(entity) : null;
  const project = item.type === 'demand' ? app.sel.project(entity.project_id) : null;
  const estimate = item.type === 'task' && Number(entity.estimate_minutes) > 0 ? formatDurationText(entity.estimate_minutes) : '';
  return h(
    'div',
    {
      ...itemDrag(item),
      ...attrs,
      key: item.key,
      class: cx('v-calendario-card', attrs.class, itemClasses(item)),
      tabindex: 0,
      title: itemTitle(app, item),
      onclick: (ev) => {
        const hit = ev.target && ev.target.closest ? ev.target.closest('button, a, input, [data-stop]') : null;
        if (hit && ev.currentTarget.contains(hit)) return;
        ev.stopPropagation();
        openItem(app, item);
      },
      onkeydown: openOnKey(app, item),
    },
    h(
      'div',
      { class: 'v-calendario-card-top' },
      item.kind === 'start'
        ? itemGlyph(app, item)
        : item.type === 'task'
          ? checkControl(app, entity, { size: 'sm' })
          : statusControl(app, 'demand', entity, { compact: true }),
      h('span', { class: 'en-code tabular' }, app.sel.code(item.type, entity)),
      item.kind === 'start' ? h('span', { class: 'v-calendario-tag' }, 'Início') : null,
      h('span', { class: 'v-calendario-card-spacer' }),
      priorityMark(item),
    ),
    h('div', { class: 'v-calendario-card-name' }, item.type === 'demand' ? icon('layers', { size: 12, class: 'v-calendario-card-kind' }) : null, h('span', null, nameOf(entity))),
    demand || project || estimate
      ? h(
          'div',
          { class: 'v-calendario-card-meta' },
          demand ? h('span', { class: 'v-calendario-card-context', title: `Demanda: ${demand.name}` }, icon('layers', { size: 11 }), h('span', { class: 'truncate' }, demand.name)) : null,
          project ? h('span', { class: 'v-calendario-card-context', title: `Projeto: ${project.name}` }, projectDot(project), h('span', { class: 'truncate' }, project.name)) : null,
          estimate ? h('span', { class: 'v-calendario-card-estimate tabular', title: 'Estimativa' }, icon('clock', { size: 11 }), estimate) : null,
        )
      : null,
  );
}

/** Colunas das linhas padrão no calendário (o prazo continua: mostra "hoje", "há 2 dias"…). */
const TASK_COLUMNS = Object.freeze(['check', 'title', 'flags', 'status-compact', 'priority', 'due', 'menu']);
const TASK_COLUMNS_PHONE = Object.freeze(['check', 'title', 'priority', 'due', 'menu']);
const DEMAND_COLUMNS = Object.freeze(['title', 'progress', 'status-compact', 'priority', 'due', 'menu']);
const DEMAND_COLUMNS_PHONE = Object.freeze(['title', 'priority', 'due', 'menu']);

/**
 * Linha PADRÃO (taskRow / demandRow) de um item — listas do dia e do celular. Arrastável para outro dia.
 * @param {object} app
 * @param {import('./model.js').CalItem} item
 * @param {{ phone?: boolean }} [options]
 */
export function itemRow(app, item, { phone = false } = {}) {
  const extra = { ...itemDrag(item), class: cx('v-calendario-row', itemClasses(item)) };
  if (item.type === 'task') {
    return taskRow(app, item.entity, { columns: phone ? TASK_COLUMNS_PHONE : TASK_COLUMNS, showDemand: true, attrs: extra });
  }
  return demandRow(app, item.entity, { columns: phone ? DEMAND_COLUMNS_PHONE : DEMAND_COLUMNS, attrs: extra });
}

// ---------------------------------------------------------------------------
// Mover para outro dia (arrastar e soltar)
// ---------------------------------------------------------------------------

/**
 * Muda o prazo (ou o início planejado) de um item para `date` pelo comando, com aviso e "Desfazer".
 * @param {object} app
 * @param {{ type: 'task'|'demand', id: string, kind?: 'due'|'start' }} ref
 * @param {string} date 'YYYY-MM-DD'
 * @returns {object|null} a entidade atualizada, ou null
 */
export function moveItem(app, ref, date) {
  if (!ref || !isValidDateStr(date)) return null;
  const { type, id } = ref;
  const kind = ref.kind === 'start' ? 'start' : 'due';
  const entity = type === 'task' ? app.sel.task(id) : type === 'demand' ? app.sel.demand(id) : null;
  if (!entity) return null;
  const field = kind === 'start' ? 'planned_start' : 'due_date';
  const previous = entity[field] || null;
  if (previous === date) return null;
  const apply = (value) => {
    if (field === 'due_date') return app.cmd.setDueDate(type, id, value);
    return type === 'task' ? app.cmd.updateTask(id, { planned_start: value }) : app.cmd.updateDemand(id, { planned_start: value });
  };
  let row = null;
  try {
    row = apply(date);
    surfaceOutcome(app, app.cmd.lastOutcome(), { type, id });
  } catch (err) {
    handleError(app, err);
    return null;
  }
  const what = field === 'due_date' ? 'Prazo' : 'Início planejado';
  notify(app, `${what} de ${quoted(nameOf(entity))} movido para ${formatDate(date, 'weekday', app.clock.today())}`, {
    duration: 7000,
    action: {
      label: 'Desfazer',
      onclick: () => {
        try {
          apply(previous);
        } catch (err) {
          handleError(app, err);
        }
      },
    },
  });
  return row;
}

// ---------------------------------------------------------------------------
// "+N mais": lista completa de um dia
// ---------------------------------------------------------------------------

/**
 * Popover com todos os itens de um dia.
 * @param {object} app
 * @param {Element} anchor
 * @param {string} date
 * @param {ReadonlyArray<object>} items
 * @param {{ onOpenDay: () => void, onCreate: () => void }} actions
 */
export function openDayList(app, anchor, date, items, { onOpenDay, onCreate }) {
  return openPopover(
    anchor,
    (close) =>
      h(
        'div',
        { class: 'v-calendario-pop', 'data-cal-pop': date },
        h(
          'div',
          { class: 'v-calendario-pop-head' },
          h('span', { class: 'v-calendario-pop-title' }, longDay(date)),
          h('span', { class: 'v-calendario-pop-count tabular' }, plural(items.length, 'item', 'itens')),
        ),
        h(
          'div',
          { class: 'v-calendario-pop-list' },
          items.map((item) => itemChip(app, item, { draggable: false, onopen: () => close('open') })),
        ),
        h(
          'div',
          { class: 'v-calendario-pop-actions' },
          button({ label: 'Abrir o dia', icon: 'calendar', size: 'sm', variant: 'ghost', onclick: () => { close('day'); onOpenDay(); } }),
          button({ label: 'Nova tarefa', icon: 'plus', size: 'sm', variant: 'ghost', onclick: () => { close('create'); onCreate(); } }),
        ),
      ),
    { placement: 'bottom-start', width: 300, class: 'v-calendario-popover', ariaLabel: `Itens de ${longDay(date)}` },
  );
}

// ---------------------------------------------------------------------------
// Adicionar horas
// ---------------------------------------------------------------------------

function isCommandError(err) {
  return !!err && typeof err === 'object' && err.name === 'CommandError' && typeof err.code === 'string';
}

/** Texto curto de sobreposição (apontamentos conflitantes). */
function overlapText(app, overlaps) {
  const list = (Array.isArray(overlaps) ? overlaps : []).map((o) => (o && o.b ? o.b : o)).filter((e) => e && e.task_id);
  if (!list.length) return 'Este horário se sobrepõe a outro apontamento.';
  const names = list.slice(0, 2).map((entry) => {
    const task = app.store.get('tasks', entry.task_id);
    return task ? quoted(nameOf(task)) : 'outra tarefa';
  });
  return `Este horário se sobrepõe a ${list.length === 1 ? 'um apontamento' : `${list.length} apontamentos`} (${names.join(', ')}).`;
}

/** Tarefas oferecidas no seletor (abertas primeiro; respeita o escopo de projeto). */
function taskChoices(app) {
  const scope = app.ui && app.ui.scope ? app.ui.scope.projectId : null;
  const out = [];
  for (const task of app.sel.tasks()) {
    if (scope && app.sel.projectIdOf('task', task) !== scope) continue;
    const demand = app.sel.demandOf(task);
    out.push({ id: task.id, label: nameOf(task), hint: app.sel.code('task', task), group: app.sel.isOpen(task) ? (demand ? demand.name : 'Sem demanda') : 'Concluídas', open: app.sel.isOpen(task) });
  }
  out.sort((a, b) => (a.open === b.open ? 0 : a.open ? -1 : 1));
  return out.map(({ open, ...rest }) => rest);
}

/**
 * Diálogo "Adicionar horas": tarefa, dia, início/fim ou duração e descrição; grava com cmd.addManualTime
 * (sobreposição pede confirmação).
 * @param {object} app
 * @param {{ date: string, taskId?: string|null }} options
 * @returns {{ close: Function }}
 */
export function openAddHours(app, { date, taskId = null }) {
  const form = { taskId: taskId && app.sel.task(taskId) ? taskId : null, date, start: '', end: '', duration: '', description: '', error: null, overlap: null };
  let dlg = null;
  const refresh = () => dlg && dlg.update();

  const submit = (allowOverlap = false) => {
    if (!form.taskId) {
      form.error = 'Escolha a tarefa.';
      refresh();
      return;
    }
    let durationMinutes;
    if (form.duration.trim()) {
      const minutes = parseDurationText(form.duration);
      if (minutes === null || minutes <= 0) {
        form.error = 'Duração inválida. Exemplos: 45min, 1h30, 1,5h.';
        refresh();
        return;
      }
      durationMinutes = minutes;
    }
    const input = {
      task_id: form.taskId,
      date: form.date || date,
      start: form.start || undefined,
      end: form.end || undefined,
      durationMinutes,
      description: form.description.trim() || undefined,
    };
    try {
      const entry = app.cmd.addManualTime(input, { allowOverlap });
      dlg.close('saved');
      notify(app, `Horas registradas: ${formatDuration(entry.duration_seconds)}`, { tone: 'success' });
    } catch (err) {
      if (isCommandError(err) && err.code === 'overlap') {
        form.error = null;
        form.overlap = overlapText(app, err.data && err.data.overlaps);
      } else if (isCommandError(err)) {
        form.error = err.message;
        form.overlap = null;
      } else {
        handleError(app, err);
        return;
      }
      refresh();
    }
  };

  const chooseTask = async (ev) => {
    const chosen = await pickFromList(ev.currentTarget, { items: taskChoices(app), current: form.taskId, title: 'Tarefa', placeholder: 'Buscar tarefa…', width: 340 });
    if (chosen === null) return;
    form.taskId = chosen;
    form.error = null;
    refresh();
  };

  dlg = openModal({
    title: 'Adicionar horas',
    size: 'md',
    class: 'v-calendario-hours-dialog',
    render: () => {
      const task = form.taskId ? app.sel.task(form.taskId) : null;
      return h(
        'form',
        {
          class: 'v-calendario-hours-form',
          onsubmit: (ev) => {
            ev.preventDefault();
            submit(false);
          },
        },
        field(
          { label: 'Tarefa' },
          h(
            'button',
            { type: 'button', class: cx('btn', 'btn-default', 'v-calendario-hours-task', !task && 'is-empty'), 'data-cal-hours-task': 'true', onclick: chooseTask, 'data-autofocus': task ? null : true },
            icon('circle', { size: 14 }),
            h('span', { class: 'truncate' }, task ? nameOf(task) : 'Escolher a tarefa…'),
            icon('chevron-down', { size: 12 }),
          ),
        ),
        h(
          'div',
          { class: 'v-calendario-hours-grid' },
          field({ label: 'Dia' }, dateInput({ value: form.date, ariaLabel: 'Dia', onchange: (v) => { form.date = v || date; } })),
          field({ label: 'Início' }, textInput({ type: 'time', value: form.start, ariaLabel: 'Início', attrs: { name: 'start' }, oninput: (v) => { form.start = v; } })),
          field({ label: 'Fim' }, textInput({ type: 'time', value: form.end, ariaLabel: 'Fim', attrs: { name: 'end' }, oninput: (v) => { form.end = v; } })),
          field({ label: 'Duração' }, textInput({ value: form.duration, placeholder: 'ex.: 1h30', ariaLabel: 'Duração', attrs: { name: 'duration' }, oninput: (v) => { form.duration = v; } })),
        ),
        h('p', { class: 'v-calendario-hours-hint' }, 'Informe início e fim, ou só a duração (ex.: 45min, 1h30).'),
        field({ label: 'Descrição' }, textInput({ value: form.description, placeholder: 'O que foi feito? (opcional)', ariaLabel: 'Descrição', attrs: { name: 'description' }, oninput: (v) => { form.description = v; } })),
        form.error ? h('p', { class: 'field-error', role: 'alert' }, icon('alert-circle', { size: 12 }), h('span', null, form.error)) : null,
        form.overlap
          ? alertBox({
              tone: 'warning',
              title: 'Horário sobreposto',
              text: form.overlap,
              actions: [
                button({ label: 'Registrar mesmo assim', size: 'sm', variant: 'primary', attrs: { 'data-action': 'force-hours' }, onclick: () => submit(true) }),
                button({ label: 'Ajustar', size: 'sm', variant: 'ghost', onclick: () => { form.overlap = null; refresh(); } }),
              ],
            })
          : null,
        // Enter em qualquer campo envia o formulário.
        h('button', { type: 'submit', hidden: true, tabindex: -1, 'aria-hidden': 'true' }),
      );
    },
    actions: () => [
      { label: 'Cancelar', value: 'cancel' },
      { label: 'Registrar', variant: 'primary', icon: 'check', onclick: () => submit(false) },
    ],
  });
  return dlg;
}

/**
 * Atrasadas limitadas a OVERDUE_LIMIT, com "Mostrar todas (N)" / "Mostrar menos" (estado da tela).
 * @param {object} cal
 * @param {(item: object) => Node} renderItem
 * @returns {{ nodes: Node[], toggle: Node|null }}
 */
export function limitedOverdue(cal, renderItem) {
  const list = cal.data.overdue;
  const all = cal.st.overdueAll || list.length <= OVERDUE_LIMIT;
  const shown = all ? list : list.slice(0, OVERDUE_LIMIT);
  const toggle =
    list.length > OVERDUE_LIMIT
      ? button({
          label: cal.st.overdueAll ? 'Mostrar menos' : `Mostrar todas (${list.length})`,
          size: 'sm',
          variant: 'ghost',
          class: 'v-calendario-overdue-toggle',
          attrs: { 'data-cal-overdue-all': 'true' },
          onclick: () => cal.setState({ overdueAll: !cal.st.overdueAll }),
        })
      : null;
  return { nodes: shown.map(renderItem), toggle };
}

/** Botão "+" (só ícone) de criar tarefa num dia. */
export function addButton(date, onclick, today) {
  return iconButton({
    icon: 'plus',
    title: `Nova tarefa para ${formatDate(date, 'weekday', today)}`,
    size: 'sm',
    class: 'v-calendario-add',
    attrs: { 'data-cal-add': date },
    onclick: (ev) => {
      ev.stopPropagation();
      onclick();
    },
  });
}
