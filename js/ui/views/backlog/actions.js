// Backlog — ações de planejamento sobre um ou vários itens (barra de seleção, botões da linha e menu de
// contexto). Toda escrita passa por app.cmd.*; falhas aparecem com handleError; cada ação em lote termina
// com UM aviso (com "Desfazer" quando dá para desfazer).

import { h } from '../../../core/dom.js';
import { addDays, formatDate, formatWeekRange, startOfWeek } from '../../../core/dates.js';
import { plural, truncate } from '../../../core/format.js';
import { button, checkbox, segmented } from '../../kit/controls.js';
import { openMenu, openPopover } from '../../kit/overlays.js';
import { EMPTY_CHOICE, pickDate, pickFromList, pickPriority } from '../../kit/pickers.js';
import { entityActions, handleError, notify, openEntityMenu, projectDot, surfaceOutcome } from '../../shared/entity.js';
import { statusIdOf } from './model.js';

const NOUNS = Object.freeze({
  task: { one: 'tarefa', many: 'tarefas' },
  demand: { one: 'demanda', many: 'demandas' },
});

const count = (n, type) => plural(n, NOUNS[type].one, NOUNS[type].many);
const quoted = (text) => `“${text}”`;
const nameOf = (entity) => (entity && entity.name ? entity.name : 'Sem nome');
const entityOf = (app, type, id) => (type === 'task' ? app.sel.task(id) : app.sel.demand(id));

/**
 * Executa `fn(entity)` para cada id e devolve o que deu certo. Erros não interrompem os demais itens;
 * o primeiro é mostrado ao final.
 * @returns {{ done: Array<{ id: string, before: object, result: any }>, failed: number }}
 */
function runBulk(app, type, ids, fn) {
  const done = [];
  let failed = 0;
  let firstError = null;
  for (const id of ids) {
    const before = entityOf(app, type, id);
    if (!before) continue;
    try {
      const result = fn(before);
      done.push({ id, before, result });
    } catch (err) {
      failed += 1;
      if (!firstError) firstError = err;
    }
  }
  if (firstError) handleError(app, firstError);
  return { done, failed };
}

/** Frase "“Nome”" para um item, "3 tarefas" para vários. */
function subject(app, type, done) {
  if (done.length === 1) return quoted(truncate(nameOf(done[0].before), 48));
  return count(done.length, type);
}

/** Volta cada item ao status que tinha antes (Desfazer). */
function restoreStatuses(app, type, done) {
  runBulk(app, type, done.map((d) => d.id), (entity) => {
    const prev = done.find((d) => d.id === entity.id).before.status;
    return app.cmd.setStatus(type, entity.id, prev);
  });
}

// ---------------------------------------------------------------------------
// Planejar
// ---------------------------------------------------------------------------

/**
 * Planeja os itens: status → "Não iniciada" (primeiro status de categoria 'planned').
 * @returns {number} quantos foram planejados
 */
export function planItems(app, type, ids) {
  const target = statusIdOf(app, 'planned');
  if (!target) return 0;
  const { done } = runBulk(app, type, ids, (entity) => app.cmd.setStatus(type, entity.id, target));
  if (!done.length) return 0;
  if (done.length === 1) surfaceOutcome(app, done[0].result, { type, id: done[0].id });
  const label = app.sel.status(target).label;
  notify(app, `${subject(app, type, done)} ${done.length === 1 ? 'movida' : 'movidas'} para ${label}`, {
    tone: 'success',
    duration: 6000,
    action: { label: 'Desfazer', onclick: () => restoreStatuses(app, type, done) },
  });
  return done.length;
}

// ---------------------------------------------------------------------------
// Semana
// ---------------------------------------------------------------------------

/** Segunda-feira da semana escolhida ('this' | 'next'). */
export function weekStartOf(app, which) {
  const monday = startOfWeek(app.clock.today());
  return which === 'next' ? addDays(monday, 7) : monday;
}

/**
 * Põe as tarefas no plano da semana e (por padrão) as move para "Não iniciada".
 * @param {object} app
 * @param {string[]} ids
 * @param {{ week?: 'this'|'next', plan?: boolean }} [options]
 * @returns {number} quantas entraram no plano
 */
export function addItemsToWeek(app, ids, { week = 'this', plan = true } = {}) {
  const weekStart = weekStartOf(app, week);
  const planned = plan ? statusIdOf(app, 'planned') : null;
  const { done } = runBulk(app, 'task', ids, (task) => {
    const already = app.sel.weekOfTask(task.id, weekStart);
    const item = app.cmd.addToWeek(task.id, weekStart);
    let moved = false;
    if (planned && app.sel.status(task.status).category === 'backlog') {
      app.cmd.setStatus('task', task.id, planned);
      moved = true;
    }
    return { item, added: !already, moved };
  });
  if (!done.length) return 0;
  const which = week === 'next' ? 'à próxima semana' : 'a esta semana';
  notify(app, `${subject(app, 'task', done)} ${done.length === 1 ? 'adicionada' : 'adicionadas'} ${which} (${formatWeekRange(weekStart)})`, {
    tone: 'success',
    duration: 7000,
    action: {
      label: 'Desfazer',
      onclick: () => {
        runBulk(app, 'task', done.map((d) => d.id), (task) => {
          const entry = done.find((d) => d.id === task.id);
          if (entry.result.added && entry.result.item) app.cmd.removeFromWeek(entry.result.item.id);
          if (entry.result.moved) app.cmd.setStatus('task', task.id, entry.before.status);
          return true;
        });
      },
    },
  });
  return done.length;
}

/**
 * Popover "Adicionar à semana": esta semana / próxima semana e a opção de mover para "Não iniciada".
 * @param {object} app
 * @param {string[]} ids
 * @param {Element|{x: number, y: number}} anchor
 * @param {(n: number) => void} [onDone]
 */
export function openAddToWeek(app, ids, anchor, onDone) {
  let week = 'this';
  let plan = true;
  const plannedLabel = (() => {
    const id = statusIdOf(app, 'planned');
    return id ? app.sel.status(id).label : 'Não iniciada';
  })();
  const pop = openPopover(
    anchor,
    (close) =>
      h(
        'div',
        { class: 'v-backlog-week', 'data-week-popover': 'true' },
        h('div', { class: 'v-backlog-week-title' }, ids.length === 1 ? 'Adicionar à semana' : `Adicionar ${count(ids.length, 'task')} à semana`),
        segmented({
          value: week,
          size: 'sm',
          ariaLabel: 'Semana',
          class: 'v-backlog-week-choice',
          options: [
            { value: 'this', label: 'Esta semana' },
            { value: 'next', label: 'Próxima semana' },
          ],
          onchange: (value) => {
            week = value;
            pop.update();
          },
        }),
        h('div', { class: 'v-backlog-week-range tabular' }, formatWeekRange(weekStartOf(app, week))),
        checkbox({
          checked: plan,
          label: `Mover também para “${plannedLabel}”`,
          class: 'v-backlog-week-plan',
          onchange: (checked) => {
            plan = checked;
          },
        }),
        h(
          'div',
          { class: 'v-backlog-week-actions' },
          button({ label: 'Cancelar', size: 'sm', variant: 'ghost', onclick: () => close('cancel') }),
          button({
            label: 'Adicionar',
            size: 'sm',
            variant: 'primary',
            icon: 'calendar-week',
            attrs: { 'data-action': 'confirm-week' },
            onclick: () => {
              close('done');
              const n = addItemsToWeek(app, ids, { week, plan });
              if (typeof onDone === 'function') onDone(n);
            },
          }),
        ),
      ),
    { width: 300, ariaLabel: 'Adicionar à semana', class: 'v-backlog-week-popover' },
  );
  return pop;
}

// ---------------------------------------------------------------------------
// Prazo, prioridade, arquivar, cancelar
// ---------------------------------------------------------------------------

/** Define o prazo de vários itens (um seletor só). */
export async function pickBulkDue(app, type, ids, anchor) {
  const picked = await pickDate(anchor, { today: app.clock.today(), title: ids.length === 1 ? 'Prazo' : `Prazo de ${count(ids.length, type)}`, clearLabel: 'Sem prazo' });
  if (picked === null) return 0;
  const { done } = runBulk(app, type, ids, (entity) => ((entity.due_date || null) === (picked.value || null) ? entity : app.cmd.setDueDate(type, entity.id, picked.value)));
  if (done.length) {
    notify(app, picked.value ? `Prazo de ${subject(app, type, done)}: ${formatDate(picked.value, 'short', app.clock.today())}` : `Prazo removido de ${subject(app, type, done)}`, {
      tone: 'success',
      action: {
        label: 'Desfazer',
        onclick: () => runBulk(app, type, done.map((d) => d.id), (e) => app.cmd.setDueDate(type, e.id, done.find((d) => d.id === e.id).before.due_date || null)),
      },
    });
  }
  return done.length;
}

/** Define a prioridade de vários itens. */
export async function pickBulkPriority(app, type, ids, anchor) {
  const first = entityOf(app, type, ids[0]);
  const same = ids.every((id) => {
    const e = entityOf(app, type, id);
    return e && first && e.priority === first.priority;
  });
  const chosen = await pickPriority(anchor, { current: same && first ? first.priority : undefined, title: ids.length === 1 ? 'Prioridade' : `Prioridade de ${count(ids.length, type)}` });
  if (chosen === null) return 0;
  const { done } = runBulk(app, type, ids, (entity) => (entity.priority === chosen ? entity : app.cmd.setPriority(type, entity.id, chosen)));
  if (done.length > 1) {
    notify(app, `${count(done.length, type)} com prioridade ${chosen}`, {
      tone: 'success',
      action: {
        label: 'Desfazer',
        onclick: () => runBulk(app, type, done.map((d) => d.id), (e) => app.cmd.setPriority(type, e.id, done.find((d) => d.id === e.id).before.priority || 'P3')),
      },
    });
  }
  return done.length;
}

/** Arquiva os itens (com Desfazer). */
export function archiveItems(app, type, ids) {
  const run = (id, value) => (type === 'task' ? app.cmd.archiveTask(id, value) : app.cmd.archiveDemand(id, value));
  const { done } = runBulk(app, type, ids, (entity) => run(entity.id, true));
  if (done.length) {
    notify(app, `${subject(app, type, done)} ${done.length === 1 ? 'arquivada' : 'arquivadas'}`, {
      duration: 7000,
      action: {
        label: 'Desfazer',
        onclick: () => {
          for (const d of done) {
            try {
              run(d.id, false);
            } catch (err) {
              handleError(app, err);
              break;
            }
          }
        },
      },
    });
  }
  return done.length;
}

/** Marca os itens como cancelados (com Desfazer). */
export function cancelItems(app, type, ids) {
  const target = statusIdOf(app, 'cancelled');
  if (!target) return 0;
  const { done } = runBulk(app, type, ids, (entity) => app.cmd.setStatus(type, entity.id, target));
  if (done.length) {
    notify(app, `${subject(app, type, done)} ${done.length === 1 ? 'cancelada' : 'canceladas'}`, {
      duration: 7000,
      action: { label: 'Desfazer', onclick: () => restoreStatuses(app, type, done) },
    });
  }
  return done.length;
}

// ---------------------------------------------------------------------------
// Mover de demanda e reordenar
// ---------------------------------------------------------------------------

/** Escolhe outra demanda para a tarefa (alternativa ao arrastar). */
export async function moveToDemand(app, task, anchor) {
  const current = app.sel.demandOf(task);
  const projects = app.sel.projectsById();
  const chosen = await pickFromList(anchor, {
    items: app.sel.demands().map((d) => {
      const p = d.project_id ? projects.get(d.project_id) : null;
      return { id: d.id, label: d.name, hint: app.sel.code('demand', d), group: p ? p.name : 'Sem projeto', icon: projectDot(p) };
    }),
    current: current ? current.id : null,
    allowEmpty: true,
    emptyLabel: 'Sem demanda (tarefa avulsa)',
    placeholder: 'Buscar demanda…',
    title: 'Mover para a demanda',
    width: 320,
  });
  if (chosen === null) return null;
  const target = chosen === EMPTY_CHOICE ? null : chosen;
  if ((current ? current.id : null) === target) return null;
  try {
    return app.cmd.moveTask(task.id, { demand_id: target });
  } catch (err) {
    handleError(app, err);
    return null;
  }
}

/**
 * Move um item dentro da lista visível de um grupo (Alt+↑/↓ e "Mover para o topo/fim").
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {string} id
 * @param {string[]} ids ordem visível do grupo
 * @param {'up'|'down'|'top'|'bottom'} where
 * @returns {boolean}
 */
export function reorderWithin(app, type, id, ids, where) {
  const index = ids.indexOf(id);
  if (index < 0) return false;
  let place = null;
  if (where === 'up' && index > 0) place = { beforeId: ids[index - 1] };
  else if (where === 'down' && index < ids.length - 1) place = { afterId: ids[index + 1] };
  else if (where === 'top' && index > 0) place = { beforeId: ids[0] };
  else if (where === 'bottom' && index < ids.length - 1) place = { afterId: ids[ids.length - 1] };
  if (!place) return false;
  try {
    if (type === 'task') app.cmd.moveTask(id, place);
    else app.cmd.reorderDemand(id, place);
    return true;
  } catch (err) {
    handleError(app, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Menu da linha
// ---------------------------------------------------------------------------

/**
 * Menu de ações de backlog de um item (botão "…" e clique com o botão direito).
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @param {Element|{x: number, y: number}} anchor
 * @param {{ selected: boolean, onToggleSelect: () => void, reorder?: { up: boolean, down: boolean, run: (where: string) => void } | null,
 *           afterRemove?: () => void }} options
 */
export function openRowMenu(app, type, entity, anchor, { selected, onToggleSelect, reorder, afterRemove } = {}) {
  const id = entity.id;
  // Os seletores abertos a partir do menu ficam ancorados no mesmo lugar (botão "…" ou ponto do clique).
  const later = (fn) => () => fn(anchor);
  const planned = statusIdOf(app, 'planned');
  const plannedLabel = planned ? app.sel.status(planned).label : 'Não iniciada';
  const items = [
    { label: `Planejar (${plannedLabel})`, icon: 'arrow-right', onclick: () => { if (planItems(app, type, [id]) && afterRemove) afterRemove(); } },
  ];
  if (type === 'task') {
    items.push(
      { label: 'Adicionar a esta semana', icon: 'calendar-week', hint: formatWeekRange(weekStartOf(app, 'this')), onclick: () => { if (addItemsToWeek(app, [id], { week: 'this' }) && afterRemove) afterRemove(); } },
      { label: 'Adicionar à próxima semana', icon: 'calendar-week', hint: formatWeekRange(weekStartOf(app, 'next')), onclick: () => { if (addItemsToWeek(app, [id], { week: 'next' }) && afterRemove) afterRemove(); } },
    );
  }
  items.push(
    { separator: true },
    { label: 'Definir prioridade', icon: 'signal-3', hint: entity.priority || 'P3', onclick: later((a) => entityActions.pickPriority(app, type, id, a)) },
    { label: 'Definir prazo', icon: 'calendar', hint: entity.due_date ? formatDate(entity.due_date, 'short', app.clock.today()) : 'Sem prazo', onclick: later((a) => entityActions.pickDueDate(app, type, id, a)) },
  );
  if (type === 'task') items.push({ label: 'Mover para a demanda…', icon: 'layers', onclick: later((a) => moveToDemand(app, entity, a)) });
  if (reorder) {
    items.push(
      { label: 'Mover para o topo', icon: 'arrow-up', disabled: !reorder.up, onclick: () => reorder.run('top') },
      { label: 'Mover para o fim', icon: 'arrow-down', disabled: !reorder.down, onclick: () => reorder.run('bottom') },
    );
  }
  items.push(
    { separator: true },
    { label: selected ? 'Desmarcar' : 'Selecionar', icon: selected ? 'minus' : 'check', kbd: 'X', onclick: () => onToggleSelect && onToggleSelect() },
    { label: 'Abrir', icon: 'panel-right', kbd: 'Enter', onclick: () => entityActions.open(app, type, id) },
    { label: 'Mais ações…', icon: 'more-horizontal', onclick: later((a) => openEntityMenu(app, type, id, a || { x: 200, y: 200 })) },
    { separator: true },
    { label: 'Arquivar', icon: 'archive', onclick: () => { if (archiveItems(app, type, [id]) && afterRemove) afterRemove(); } },
    { label: 'Cancelar', icon: 'x-circle', description: 'Marca como cancelada (fora do progresso)', onclick: () => { if (cancelItems(app, type, [id]) && afterRemove) afterRemove(); } },
  );
  const code = app.sel.code(type, entity);
  return openMenu(anchor, items, { title: `${code ? code + ' · ' : ''}${truncate(nameOf(entity), 40)}`, minWidth: 250, class: 'v-backlog-menu' });
}

export { count as countLabel };
