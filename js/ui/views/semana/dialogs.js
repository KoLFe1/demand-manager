// "Minha Semana" — ações e diálogos da tela: adicionar tarefas ao plano, transferir pendências, mover e
// retirar itens do plano. Toda escrita passa por app.cmd.*; erros aparecem com handleError.

import { addDays, formatDate, startOfWeek } from '../../../core/dates.js';
import { cx, h } from '../../../core/dom.js';
import { normalizeText, plural } from '../../../core/format.js';
import { categoryOf, firstOfCategory, isOpen } from '../../../domain/statuses.js';
import { checkbox, formatDurationText, searchInput, switchInput, tabs } from '../../kit/controls.js';
import { deadlineChip, emptyState, priorityBadge, statusBadge } from '../../kit/display.js';
import { icon } from '../../kit/icons.js';
import { openMenu, openModal } from '../../kit/overlays.js';
import { pickDate } from '../../kit/pickers.js';
import { handleError, notify, projectDot } from '../../shared/entity.js';
import { CANDIDATE_FILTERS, candidateTasks, groupByDemand, weekLabel } from './model.js';

/** Executa um comando tratando o erro; devolve o resultado ou null. */
function attempt(app, fn) {
  try {
    return fn();
  } catch (err) {
    handleError(app, err);
    return null;
  }
}

const nameOf = (task) => (task && typeof task.name === 'string' && task.name.trim() ? task.name.trim() : 'Sem nome');

// ---------------------------------------------------------------------------
// Ações sobre um item do plano
// ---------------------------------------------------------------------------

/**
 * Põe uma tarefa no plano da semana (com "Desfazer").
 * @returns {object|null} item criado/revivido
 */
export function addTaskToWeek(app, taskId, week) {
  const item = attempt(app, () => app.cmd.addToWeek(taskId, week));
  if (item) {
    notify(app, `Adicionada ao plano da semana de ${weekLabel(week)}`, {
      tone: 'success',
      action: { label: 'Desfazer', onclick: () => attempt(app, () => app.cmd.removeFromWeek(item.id)) },
    });
  }
  return item;
}

/** Retira o item do plano (a linha fica no histórico), com "Desfazer". */
export function removeFromPlan(app, item, week) {
  const row = attempt(app, () => app.cmd.removeFromWeek(item.id));
  if (row) {
    notify(app, 'Retirada do plano — fica registrada no histórico da semana', {
      action: { label: 'Desfazer', onclick: () => attempt(app, () => app.cmd.addToWeek(item.task_id, week, { kind: item.kind })) },
    });
  }
  return row;
}

/** Devolve ao plano um item retirado antes. */
export function restoreToPlan(app, item, week) {
  const row = attempt(app, () => app.cmd.addToWeek(item.task_id, week, { kind: item.kind }));
  if (row) notify(app, 'Devolvida ao plano da semana', { tone: 'success' });
  return row;
}

/**
 * Retrato das linhas da tarefa nas duas semanas, tirado ANTES de mover/transferir: é o que cmd.undoWeekMove usa
 * para devolver o plano exatamente como estava (sem "retirada do plano" no destino).
 */
function weekSnapshot(app, taskId, fromWeek, toWeek) {
  return { source: app.sel.weekItemRows(taskId, fromWeek), target: app.sel.weekItemRows(taskId, toWeek) };
}

/** Replaneja o item para outra semana (com "Desfazer"). */
export function moveToWeek(app, item, fromWeek, toWeek) {
  const snapshot = weekSnapshot(app, item.task_id, fromWeek, toWeek);
  const moved = attempt(app, () => app.cmd.moveWeekItem(item.id, toWeek));
  if (moved) {
    notify(app, `Movida para a semana de ${weekLabel(moved.week_start)}`, {
      tone: 'success',
      action: { label: 'Desfazer', onclick: () => attempt(app, () => app.cmd.undoWeekMove(moved.id, snapshot)) },
    });
  }
  return moved;
}

/**
 * Transfere itens não concluídos de uma semana para outra (carryOverWeek), sem apagar o plano de origem.
 * Sem `onGo` (transferência de um item pelo menu), o aviso traz "Desfazer" (cmd.undoWeekMove).
 * @param {object} app
 * @param {string} fromWeek
 * @param {string} toWeek
 * @param {string[]} itemIds itens a transferir
 * @param {{ onGo?: (week: string) => void }} [options] onGo: abre a semana de destino (ação do aviso)
 * @returns {number} quantas tarefas foram transferidas
 */
export function carryItems(app, fromWeek, toWeek, itemIds, { onGo } = {}) {
  if (!itemIds.length) return 0;
  const wanted = new Set(itemIds);
  const snapshots = new Map();
  for (const item of app.sel.weekItems(fromWeek)) {
    if (wanted.has(item.id)) snapshots.set(item.task_id, weekSnapshot(app, item.task_id, fromWeek, toWeek));
  }
  const result = attempt(app, () => app.cmd.carryOverWeek(fromWeek, toWeek, { itemIds }));
  if (!result) return 0;
  const tasks = new Set([...result.inserted.map((row) => row.task_id), ...result.updated.map((row) => row.task_id)]);
  const count = tasks.size;
  if (count === 0) {
    notify(app, 'Nenhuma tarefa precisou ser transferida.');
    return 0;
  }
  // Desfazer: descarta cada item criado no destino e devolve a origem como era (sem carried_to_week).
  const undoable = result.inserted.filter((row) => snapshots.has(row.task_id));
  const undo =
    undoable.length && undoable.length === count
      ? {
          label: 'Desfazer',
          onclick: () => {
            for (const row of undoable) if (!attempt(app, () => app.cmd.undoWeekMove(row.id, snapshots.get(row.task_id)))) break;
          },
        }
      : undefined;
  notify(app, `${plural(count, 'tarefa transferida', 'tarefas transferidas')} para a semana de ${weekLabel(toWeek)}`, {
    tone: 'success',
    action: typeof onGo === 'function' ? { label: 'Ver a semana', onclick: () => onGo(toWeek) } : undo,
  });
  return count;
}

/**
 * Levar o item para outra semana. Da semana corrente (já em andamento) para uma semana posterior, uma tarefa
 * não concluída é TRANSFERIDA (carryOverWeek): o plano desta semana guarda o item como "não concluída —
 * transferida" (seção 9 do pedido: sem perder o histórico do planejamento anterior). Numa semana futura (que
 * ainda não começou) ou para uma semana anterior é só um replanejamento (moveWeekItem, com "Desfazer").
 */
function sendToWeek(app, item, week, target, { transfer }) {
  if (transfer && startOfWeek(target) > week) return carryItems(app, week, startOfWeek(target), [item.id]);
  return moveToWeek(app, item, week, target);
}

/**
 * Menu de planejamento de um item: transferir/mover para a próxima semana, escolher a semana, retirar do plano.
 * @param {object} app
 * @param {Element} anchor
 * @param {object} item linha de week_items
 * @param {string} week semana mostrada
 */
export function openPlanMenu(app, anchor, item, week) {
  const next = addDays(week, 7);
  const task = app.sel.task(item.task_id);
  const statuses = app.sel.statuses();
  // Semana corrente + tarefa ainda aberta: o que sai daqui é trabalho não concluído — transferir, não apagar.
  const transfer = week === startOfWeek(app.clock.today()) && !!task && isOpen(task, statuses);
  const verb = transfer ? 'Transferir' : 'Mover';
  return openMenu(
    anchor,
    [
      { heading: 'Planejamento' },
      {
        label: `${verb} para a próxima semana`,
        icon: 'arrow-right',
        hint: weekLabel(next),
        description: transfer ? 'Fica neste plano como não concluída e transferida' : undefined,
        onclick: () => sendToWeek(app, item, week, next, { transfer }),
      },
      {
        label: transfer ? 'Transferir para a semana…' : 'Escolher a semana…',
        icon: 'calendar',
        onclick: async () => {
          const picked = await pickDate(anchor && anchor.isConnected ? anchor : null, {
            value: next,
            today: app.clock.today(),
            title: `${verb} para a semana de…`,
            allowClear: false,
          });
          if (!picked || !picked.value) return;
          sendToWeek(app, item, week, picked.value, { transfer });
        },
      },
      { separator: true },
      {
        label: 'Remover do plano',
        icon: 'x-circle',
        danger: true,
        description: 'A tarefa continua existindo; o plano guarda o histórico',
        onclick: () => removeFromPlan(app, item, week),
      },
    ],
    { title: task ? nameOf(task) : 'Item do plano', minWidth: 260, align: 'end', class: 'v-semana-menu' },
  );
}

// ---------------------------------------------------------------------------
// "Adicionar tarefas"
// ---------------------------------------------------------------------------

function matchesQuery(app, task, query) {
  if (!query) return true;
  const name = normalizeText(task.name);
  const code = normalizeText(app.sel.code('task', task));
  return query.split(/\s+/).every((term) => name.includes(term) || code.includes(term));
}

function candidateItem(app, task, selected, onToggle) {
  const parent = app.sel.parentOf(task);
  const checked = selected.has(task.id);
  const estimate = task.estimate_minutes ? formatDurationText(task.estimate_minutes) : '';
  return h(
    'div',
    { class: cx('v-semana-cand', checked && 'is-selected'), key: task.id, 'data-task': task.id },
    checkbox({
      checked,
      class: 'v-semana-cand-check',
      onchange: (value) => onToggle(task.id, value),
      label: h(
        'span',
        { class: 'v-semana-cand-main' },
        h(
          'span',
          { class: 'v-semana-cand-title' },
          h('span', { class: 'en-code tabular' }, app.sel.code('task', task)),
          h('span', { class: 'v-semana-cand-name' }, nameOf(task)),
        ),
        parent ? h('span', { class: 'v-semana-cand-parent' }, icon('chevron-right', { size: 12 }), h('span', { class: 'truncate' }, `Subtarefa de ${nameOf(parent)}`)) : null,
      ),
    }),
    h(
      'span',
      { class: 'v-semana-cand-meta' },
      statusBadge(app.sel.status(task.status), { compact: true }),
      priorityBadge(task.priority, { compact: true }),
      deadlineChip(app.sel.deadline(task)),
      estimate ? h('span', { class: 'v-semana-cand-est tabular', title: 'Estimativa' }, icon('clock', { size: 12 }), estimate) : null,
    ),
  );
}

/**
 * Diálogo "Adicionar tarefas": candidatas que ainda não estão no plano da semana, com filtros (Backlog, Não
 * iniciadas, Atrasadas, Todas abertas), busca, grupos por demanda e seleção múltipla. Planejar NÃO muda o status;
 * a opção "Marcar como Não iniciada ao adicionar" (ligada por padrão) passa as tarefas do Backlog para o status
 * de "não iniciada".
 * @param {object} app
 * @param {string} week semana do plano
 * @returns {{ close: Function, update: Function, el: HTMLElement }}
 */
export function openAddTasks(app, week) {
  const ui = { filter: null, q: '', selected: new Set(), markTodo: true };
  let dlg = null;
  let last = { all: [], byId: new Map() };
  const update = () => {
    if (dlg) dlg.update();
  };
  const statuses = app.sel.statuses();
  const todo = firstOfCategory(statuses, 'planned');
  const todoLabel = todo ? todo.label : 'Não iniciada';

  const toggle = (id, value) => {
    if (value) ui.selected.add(id);
    else ui.selected.delete(id);
    update();
  };

  const render = () => {
    const data = candidateTasks(app, week);
    if (ui.filter === null) ui.filter = data.counts.backlog > 0 ? 'backlog' : 'open';
    const byId = new Map(data.all.map((task) => [task.id, task]));
    for (const id of [...ui.selected]) if (!byId.has(id)) ui.selected.delete(id);
    last = { all: data.all, byId };
    const query = normalizeText(ui.q);
    const visible = data.all.filter((task) => data.matches(task, ui.filter) && matchesQuery(app, task, query));
    const groups = groupByDemand(app, visible);
    const backlogSelected = [...ui.selected].filter((id) => categoryOf(statuses, byId.get(id).status) === 'backlog').length;

    let list;
    if (!data.all.length) {
      list = emptyState({ icon: 'check-circle', compact: true, title: 'Todas as tarefas abertas já estão no plano', text: 'Crie uma tarefa nova ou escolha outra semana.' });
    } else if (!visible.length) {
      list = emptyState({
        icon: 'search',
        compact: true,
        title: query ? 'Nenhuma tarefa encontrada' : 'Nada neste filtro',
        text: query ? 'Tente outro termo ou outro filtro.' : 'Escolha outro filtro acima.',
      });
    } else {
      list = groups.map((group) => {
        const ids = group.tasks.map((task) => task.id);
        const count = ids.filter((id) => ui.selected.has(id)).length;
        const title = group.demand ? group.demand.name : 'Sem demanda';
        return h(
          'div',
          { class: 'v-semana-cand-group', key: group.key, role: 'group', 'aria-label': title },
          h(
            'div',
            { class: 'v-semana-cand-group-head' },
            checkbox({
              checked: count > 0 && count === ids.length,
              indeterminate: count > 0 && count < ids.length,
              ariaLabel: `Selecionar todas de ${title}`,
              title: 'Selecionar todas do grupo',
              onchange: (value) => {
                for (const id of ids) {
                  if (value) ui.selected.add(id);
                  else ui.selected.delete(id);
                }
                update();
              },
            }),
            group.demand ? projectDot(group.project) : icon('inbox', { size: 14 }),
            h('span', { class: 'v-semana-cand-group-name truncate' }, title),
            group.project ? h('span', { class: 'v-semana-cand-group-project truncate' }, group.project.name) : null,
            h('span', { class: 'v-semana-cand-group-count tabular' }, String(group.tasks.length)),
          ),
          group.tasks.map((task) => candidateItem(app, task, ui.selected, toggle)),
        );
      });
    }

    return h(
      'div',
      { class: 'v-semana-add' },
      h(
        'div',
        { class: 'v-semana-add-tools' },
        h(
          'div',
          { class: 'v-semana-add-tabs' },
          tabs({
            ariaLabel: 'Filtrar candidatas',
            active: ui.filter,
            tabs: CANDIDATE_FILTERS.map((f) => ({ id: f.id, label: f.label, count: data.counts[f.id] })),
            onchange: (id) => {
              ui.filter = id;
              update();
            },
          }),
        ),
        searchInput({
          value: ui.q,
          autofocus: true,
          placeholder: 'Buscar por nome ou código…',
          class: 'v-semana-add-search',
          oninput: (value) => {
            ui.q = value;
            update();
          },
        }),
      ),
      h('div', { class: 'v-semana-add-list' }, list),
      h(
        'div',
        { class: 'v-semana-add-options' },
        switchInput({
          checked: ui.markTodo,
          label: `Marcar como ${todoLabel} ao adicionar`,
          onchange: (value) => {
            ui.markTodo = value;
            update();
          },
        }),
        h(
          'span',
          { class: 'v-semana-add-hint' },
          ui.markTodo
            ? backlogSelected
              ? `${plural(backlogSelected, 'tarefa do Backlog passa', 'tarefas do Backlog passam')} para ${todoLabel}.`
              : `Tarefas do Backlog passam para ${todoLabel}; as demais ficam como estão.`
            : 'Planejar não muda o status das tarefas.',
        ),
      ),
    );
  };

  const apply = (close) => {
    const chosen = last.all.filter((task) => ui.selected.has(task.id));
    if (!chosen.length) return;
    let added = 0;
    let promoted = 0;
    for (const task of chosen) {
      const item = attempt(app, () => app.cmd.addToWeek(task.id, week));
      if (!item) continue;
      added += 1;
      if (ui.markTodo && todo && categoryOf(statuses, task.status) === 'backlog') {
        const done = attempt(app, () => app.cmd.setStatus('task', task.id, todo.id));
        if (done) promoted += 1;
      }
    }
    close('added');
    if (added) {
      const extra = promoted ? ` · ${plural(promoted, 'marcada', 'marcadas')} como ${todoLabel}` : '';
      notify(app, `${plural(added, 'tarefa adicionada', 'tarefas adicionadas')} ao plano${extra}`, { tone: 'success' });
    }
  };

  dlg = openModal({
    title: `Adicionar tarefas · ${weekLabel(week)}`,
    size: 'lg',
    class: 'v-semana-modal v-semana-add-modal',
    render,
    actions: () => {
      const n = ui.selected.size;
      return [
        { label: 'Cancelar', value: 'cancel' },
        {
          label: n ? `Adicionar ${plural(n, 'tarefa', 'tarefas')}` : 'Adicionar tarefas',
          variant: 'primary',
          icon: 'plus',
          disabled: n === 0,
          onclick: (close) => apply(close),
        },
      ];
    },
  });
  return dlg;
}

// ---------------------------------------------------------------------------
// "Escolher" o que transferir
// ---------------------------------------------------------------------------

/**
 * Diálogo para escolher quais pendências transferir.
 * @param {object} app
 * @param {{ week: string, target: string, rows: object[], onGo?: Function }} options
 */
export function openCarryPicker(app, { week, target, rows, onGo }) {
  const selected = new Set(rows.map((row) => row.item.id));
  let dlg = null;
  const update = () => dlg && dlg.update();
  const render = () =>
    h(
      'div',
      { class: 'v-semana-carry' },
      h('p', { class: 'v-semana-carry-text' }, `Escolha o que segue para a semana de ${weekLabel(target)}. O plano desta semana continua guardado, com cada tarefa marcada como transferida.`),
      h(
        'div',
        { class: 'v-semana-carry-list' },
        rows.map((row) =>
          h(
            'div',
            { class: cx('v-semana-cand', selected.has(row.item.id) && 'is-selected'), key: row.item.id },
            checkbox({
              checked: selected.has(row.item.id),
              class: 'v-semana-cand-check',
              onchange: (value) => {
                if (value) selected.add(row.item.id);
                else selected.delete(row.item.id);
                update();
              },
              label: h(
                'span',
                { class: 'v-semana-cand-main' },
                h('span', { class: 'v-semana-cand-title' }, h('span', { class: 'en-code tabular' }, app.sel.code('task', row.task)), h('span', { class: 'v-semana-cand-name' }, nameOf(row.task))),
              ),
            }),
            h('span', { class: 'v-semana-cand-meta' }, statusBadge(app.sel.status(row.task.status), { compact: true }), priorityBadge(row.task.priority, { compact: true }), deadlineChip(app.sel.deadline(row.task))),
          ),
        ),
      ),
    );
  dlg = openModal({
    title: 'Transferir tarefas não concluídas',
    size: 'md',
    class: 'v-semana-modal v-semana-carry-modal',
    render,
    actions: () => [
      { label: 'Cancelar', value: 'cancel' },
      {
        label: selected.size ? `Transferir ${plural(selected.size, 'tarefa', 'tarefas')}` : 'Transferir',
        variant: 'primary',
        icon: 'arrow-right',
        disabled: selected.size === 0,
        onclick: (close) => {
          const ids = rows.filter((row) => selected.has(row.item.id)).map((row) => row.item.id);
          close('carried');
          carryItems(app, week, target, ids, { onGo });
        },
      },
    ],
  });
  return dlg;
}

/** Texto curto de um dia ('qui, 26 nov'). */
export function dayText(app, date) {
  return formatDate(date, 'weekday', app.clock.today());
}
