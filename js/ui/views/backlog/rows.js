// Backlog — grupos e linhas. As linhas são as linhas PADRÃO de js/ui/shared/entity.js (taskRow / demandRow)
// com colunas próprias desta tela: caixa de seleção, contexto (demanda · projeto), estimativa, idade, botões de
// planejamento e o menu de backlog. Arrastar (pela alça) reordena pela ordem manual e, agrupado por demanda,
// também move a tarefa para outra demanda.

import { cx, h } from '../../../core/dom.js';
import { formatDate, isoToDateStr } from '../../../core/dates.js';
import { plural, truncate } from '../../../core/format.js';
import { checkbox, button, formatDurationText, iconButton } from '../../kit/controls.js';
import { priorityBadge } from '../../kit/display.js';
import { sortableItem, sortableList } from '../../kit/dnd.js';
import { icon } from '../../kit/icons.js';
import { demandRow, entityActions, estimateControl, handleError, priorityControl, projectDot, quickAddRow, taskRow } from '../../shared/entity.js';
import { PRIORITIES } from '../../../domain/priorities.js';
import { openAddToWeek, openRowMenu, planItems, reorderWithin } from './actions.js';
import { OLD_DAYS, ageDays, ageText, statusIdOf, sumEstimate } from './model.js';

const PRIORITY_LABEL = Object.freeze(Object.fromEntries(PRIORITIES.map((p) => [p.id, p.label])));

/** Texto do grupo (para rótulos acessíveis). */
export function groupLabel(app, group) {
  if (group.kind === 'demand') return group.demand ? group.demand.name : 'Sem demanda';
  if (group.kind === 'project') return group.project ? group.project.name : 'Sem projeto';
  if (group.kind === 'priority') return `${group.id} · ${PRIORITY_LABEL[group.id] || ''}`;
  return 'Todos';
}

function groupTitle(app, group) {
  if (group.kind === 'demand') {
    if (!group.demand) return [icon('inbox', { size: 14, class: 'v-backlog-group-icon' }), h('span', { class: 'v-backlog-group-name' }, 'Sem demanda')];
    const project = app.sel.project(group.demand.project_id);
    return [
      icon('layers', { size: 14, class: 'v-backlog-group-icon' }),
      h('span', { class: 'v-backlog-group-code tabular' }, app.sel.code('demand', group.demand)),
      h('span', { class: 'v-backlog-group-name' }, group.demand.name),
      project ? h('span', { class: 'v-backlog-group-sub' }, projectDot(project), h('span', { class: 'truncate' }, project.name)) : null,
    ];
  }
  if (group.kind === 'project') {
    return [projectDot(group.project), h('span', { class: 'v-backlog-group-name' }, group.project ? group.project.name : 'Sem projeto')];
  }
  if (group.kind === 'priority') {
    return [priorityBadge(group.id, { compact: true }), h('span', { class: 'v-backlog-group-name' }, groupLabel(app, group))];
  }
  return [h('span', { class: 'v-backlog-group-name' }, 'Todos')];
}

// ---------------------------------------------------------------------------
// Células próprias
// ---------------------------------------------------------------------------

function selectCell(entity, view) {
  const selected = view.selectedSet.has(entity.id);
  return checkbox({
    checked: selected,
    ariaLabel: `Selecionar “${truncate(entity.name || 'Sem nome', 60)}”`,
    class: 'v-backlog-select',
    attrs: {
      'data-select': entity.id,
      onclick: (ev) => {
        ev.stopPropagation();
        view.toggle(entity.id, { range: ev.shiftKey });
      },
    },
  });
}

function gripCell(enabled) {
  return h(
    'span',
    { class: cx('v-backlog-grip', !enabled && 'is-disabled'), title: enabled ? 'Arraste para reordenar' : 'Subtarefa: reordene dentro da tarefa principal', 'aria-hidden': 'true' },
    icon('grip', { size: 14 }),
  );
}

function contextCell(app, type, entity, groupKind) {
  if (type === 'demand') return null;
  const parent = app.sel.parentOf(entity);
  const demand = app.sel.demandOf(entity);
  const project = demand ? app.sel.project(demand.project_id) : null;
  const parts = [];
  if (parent) parts.push(h('span', { class: 'v-backlog-ctx-part' }, icon('list', { size: 12 }), `Subtarefa de ${truncate(parent.name, 28)}`));
  if (groupKind !== 'demand') {
    // demanda com o ponto do projeto na frente (o nome do projeto fica na dica); agrupado por projeto, só a demanda
    parts.push(
      demand
        ? h('span', { class: 'v-backlog-ctx-part' }, project && groupKind !== 'project' ? projectDot(project) : icon('layers', { size: 12 }), h('span', { class: 'truncate' }, demand.name))
        : h('span', { class: 'v-backlog-ctx-part is-empty' }, 'Sem demanda'),
    );
  }
  if (!parts.length) return null;
  const title = [parent ? `Subtarefa de ${parent.name}` : null, demand ? `Demanda: ${demand.name}` : 'Sem demanda', project ? `Projeto: ${project.name}` : null].filter(Boolean).join(' · ');
  return demand
    ? h('button', { type: 'button', class: 'v-backlog-ctx', title: `${title} — abrir a demanda`, onclick: (ev) => { ev.stopPropagation(); entityActions.open(app, 'demand', demand.id); } }, parts)
    : h('span', { class: 'v-backlog-ctx', title }, parts);
}

function taskCountCell(app, demand) {
  const n = app.sel.topTasks(demand.id).length;
  return h('span', { class: cx('v-backlog-count', 'tabular', !n && 'is-empty'), title: n ? `${plural(n, 'tarefa', 'tarefas')} na demanda` : 'Ainda sem tarefas' }, n ? plural(n, 'tarefa', 'tarefas') : 'sem tarefas');
}

function ageCell(app, entity) {
  const days = ageDays(app, entity);
  const createdDay = isoToDateStr(entity.created_at);
  const created = createdDay ? formatDate(createdDay, 'numeric') : '';
  return h(
    'span',
    {
      class: cx('v-backlog-age', 'tabular', days > OLD_DAYS && 'is-old'),
      title: `Registrada ${days ? `há ${ageText(days)}` : 'hoje'}${created ? ` (${created})` : ''}${days > OLD_DAYS ? ` — mais de ${OLD_DAYS} dias no backlog` : ''}`,
      'data-age': days,
    },
    days > OLD_DAYS ? icon('hourglass', { size: 12 }) : null,
    ageText(days),
  );
}

function actionsCell(app, type, entity, view) {
  return h(
    'span',
    { class: 'v-backlog-row-actions' },
    iconButton({
      icon: 'arrow-right',
      title: `Planejar — mover para ${view.plannedLabel}`,
      size: 'sm',
      attrs: { 'data-action': 'plan-row' },
      onclick: (ev) => {
        ev.stopPropagation();
        if (planItems(app, type, [entity.id])) view.unselect(entity.id);
      },
    }),
    type === 'task'
      ? iconButton({
          icon: 'calendar-week',
          title: 'Adicionar à semana',
          size: 'sm',
          attrs: { 'data-action': 'week-row' },
          onclick: (ev) => {
            ev.stopPropagation();
            openAddToWeek(app, [entity.id], ev.currentTarget, (n) => n && view.unselect(entity.id));
          },
        })
      : null,
  );
}

function menuCell(app, type, entity, view, group) {
  return iconButton({
    icon: 'more-horizontal',
    title: 'Ações do backlog',
    size: 'sm',
    class: 'v-backlog-menu-btn',
    attrs: { 'data-action': 'row-menu', 'aria-haspopup': 'menu' },
    onclick: (ev) => {
      ev.stopPropagation();
      openRowMenu(app, type, entity, ev.currentTarget, menuOptions(app, type, entity, view, group));
    },
  });
}

function menuOptions(app, type, entity, view, group) {
  const ids = group.ids;
  const index = ids.indexOf(entity.id);
  const reorderable = view.canReorder && !(type === 'task' && app.sel.parentOf(entity));
  return {
    selected: view.selectedSet.has(entity.id),
    onToggleSelect: () => view.toggle(entity.id),
    afterRemove: () => view.unselect(entity.id),
    reorder: reorderable ? { up: index > 0, down: index < ids.length - 1, run: (where) => reorderWithin(app, type, entity.id, ids, where) } : null,
  };
}

function suggestionHint(app, suggestion) {
  return h(
    'div',
    { class: 'v-backlog-hint', 'data-suggestion': suggestion.taskId, role: 'note' },
    icon('sparkles', { size: 14, class: 'v-backlog-hint-icon' }),
    h('span', { class: 'v-backlog-hint-label' }, 'Sugestão:'),
    h('span', { class: 'v-backlog-hint-change' }, priorityBadge(suggestion.current), icon('arrow-right', { size: 12 }), priorityBadge(suggestion.suggested)),
    suggestion.justification ? h('span', { class: 'v-backlog-hint-why', title: suggestion.justification }, suggestion.justification) : null,
    h(
      'span',
      { class: 'v-backlog-hint-actions' },
      button({
        label: 'Aplicar',
        size: 'sm',
        variant: 'subtle',
        attrs: { 'data-action': 'apply-suggestion' },
        onclick: (ev) => {
          ev.stopPropagation();
          try {
            app.cmd.applySuggestion(suggestion);
          } catch (err) {
            handleError(app, err);
          }
        },
      }),
      button({
        label: 'Dispensar',
        size: 'sm',
        variant: 'ghost',
        attrs: { 'data-action': 'dismiss-suggestion' },
        onclick: (ev) => {
          ev.stopPropagation();
          try {
            app.cmd.dismissSuggestion(suggestion.signature);
          } catch (err) {
            handleError(app, err);
          }
        },
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Item (linha + dica)
// ---------------------------------------------------------------------------

/** Teclado na linha: X seleciona, ↑/↓ andam entre as linhas, Alt+↑/↓ reordenam. */
function rowKeydown(app, type, entity, view, group) {
  return (ev) => {
    const target = ev.target;
    if (!target || typeof target.matches !== 'function' || !target.matches('[data-entity]')) return;
    const plain = !ev.ctrlKey && !ev.metaKey && !ev.altKey;
    if (plain && !ev.shiftKey && (ev.key === 'x' || ev.key === 'X')) {
      ev.preventDefault();
      ev.stopPropagation();
      view.toggle(entity.id);
      return;
    }
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    const down = ev.key === 'ArrowDown';
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      if (!view.canReorder || (type === 'task' && app.sel.parentOf(entity))) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (reorderWithin(app, type, entity.id, group.ids, down ? 'down' : 'up')) refocus(target.ownerDocument, entity.id);
      return;
    }
    if (!plain || ev.shiftKey) return;
    const root = target.closest('.v-backlog');
    if (!root) return;
    const rows = [...root.querySelectorAll('.v-backlog-item > .en-row')];
    const next = rows[rows.indexOf(target) + (down ? 1 : -1)];
    if (next) {
      ev.preventDefault();
      next.focus();
    }
  };
}

/** Devolve o foco à linha depois que a tela for redesenhada. */
function refocus(doc, id) {
  const win = doc.defaultView || window;
  win.requestAnimationFrame(() =>
    win.requestAnimationFrame(() => {
      const row = doc.querySelector(`.v-backlog-item[data-item="${id}"] > .en-row`);
      if (row && doc.activeElement !== row) row.focus({ preventScroll: false });
    }),
  );
}

function openContextMenu(app, type, entity, view, group) {
  return (ev) => {
    ev.preventDefault();
    ev.stopPropagation(); // o menu de backlog substitui o menu de contexto geral (que continua em "Mais ações…")
    openRowMenu(app, type, entity, { x: ev.clientX, y: ev.clientY }, menuOptions(app, type, entity, view, group));
  };
}

function moveTaskInto(app, id, demandId, place) {
  const task = app.sel.task(id);
  if (!task) return;
  const current = app.sel.demandOf(task);
  const target = demandId || null;
  try {
    app.cmd.moveTask(id, (current ? current.id : null) !== target ? { demand_id: target, ...place } : place);
  } catch (err) {
    handleError(app, err);
  }
}

function taskItem(app, task, view, group) {
  const sub = !!app.sel.parentOf(task);
  const selected = view.selectedSet.has(task.id);
  const cols = [];
  if (view.dnd) cols.push(() => gripCell(!sub));
  cols.push(() => selectCell(task, view));
  cols.push('title');
  const ctxNode = contextCell(app, 'task', task, view.groupKind);
  if (ctxNode) cols.push(() => ctxNode);
  cols.push('flags', () => priorityControl(app, 'task', task), 'due', () => estimateControl(app, 'task', task), () => ageCell(app, task), () => actionsCell(app, 'task', task, view), () => menuCell(app, 'task', task, view, group));
  const row = taskRow(app, task, {
    columns: cols,
    class: cx('v-backlog-row', selected && 'is-selected'),
    attrs: { oncontextmenu: openContextMenu(app, 'task', task, view, group) },
  });
  const sortable = view.dnd
    ? sortableItem({
        type: sub ? 'subtask' : 'task',
        id: task.id,
        data: { group: group.key },
        disabled: sub,
        handle: '.v-backlog-grip',
        onmove: ({ id, place }) => moveTaskInto(app, id, group.id, place),
      })
    : {};
  const suggestion = view.suggestions.get(task.id) || null;
  return h(
    'div',
    {
      ...sortable,
      key: task.id,
      class: cx('v-backlog-item', selected && 'is-selected', suggestion && 'has-hint'),
      'data-item': task.id,
      onkeydown: rowKeydown(app, 'task', task, view, group),
    },
    row,
    suggestion ? suggestionHint(app, suggestion) : null,
  );
}

function demandItem(app, demand, view, group) {
  const selected = view.selectedSet.has(demand.id);
  const cols = [];
  if (view.dnd) cols.push(() => gripCell(true));
  cols.push(() => selectCell(demand, view), 'title');
  if (view.groupKind !== 'project') cols.push('project');
  cols.push(() => taskCountCell(app, demand), () => priorityControl(app, 'demand', demand), 'due', () => estimateControl(app, 'demand', demand), () => ageCell(app, demand), () => actionsCell(app, 'demand', demand, view), () => menuCell(app, 'demand', demand, view, group));
  const row = demandRow(app, demand, {
    columns: cols,
    class: cx('v-backlog-row', selected && 'is-selected'),
    attrs: { oncontextmenu: openContextMenu(app, 'demand', demand, view, group) },
  });
  const sortable = view.dnd
    ? sortableItem({
        type: 'demand',
        id: demand.id,
        data: { group: group.key },
        handle: '.v-backlog-grip',
        canDrop: (drop) => !!drop.data && drop.data.group === group.key,
        onmove: ({ id, place }) => {
          try {
            app.cmd.reorderDemand(id, place);
          } catch (err) {
            handleError(app, err);
          }
        },
      })
    : {};
  return h(
    'div',
    { ...sortable, key: demand.id, class: cx('v-backlog-item', selected && 'is-selected'), 'data-item': demand.id, onkeydown: rowKeydown(app, 'demand', demand, view, group) },
    row,
  );
}

// ---------------------------------------------------------------------------
// Grupo
// ---------------------------------------------------------------------------

/** Valores de criação de um item num grupo (null = o grupo não aceita criação direta). */
function createDefaults(app, type, group) {
  const status = statusIdOf(app, 'backlog');
  const base = status ? { status } : {};
  if (group.kind === 'priority') return { ...base, priority: group.id };
  if (type === 'task') {
    if (group.kind === 'demand') return { ...base, demand_id: group.id || null };
    return null;
  }
  if (group.kind === 'project') return { ...base, project_id: group.id || null };
  return null;
}

/**
 * Um grupo: cabeçalho (seleção do grupo, recolher, contagem, estimativa, "+") e as linhas.
 * @param {object} app
 * @param {object} group de buildGroups (com `ids` = ids na ordem)
 * @param {object} view contexto da tela (ver backlog.js)
 */
export function groupSection(app, group, view) {
  const type = view.type;
  const collapsed = view.isCollapsed(group.key);
  const ids = group.ids;
  const chosen = ids.filter((id) => view.selectedSet.has(id)).length;
  const all = chosen > 0 && chosen === ids.length;
  const label = groupLabel(app, group);
  const defaults = createDefaults(app, type, group);
  const addKey = `${type}:${group.key}`;
  const adding = !!defaults && view.addingIn === addKey && !collapsed;
  const estimate = sumEstimate(group.items);
  const flat = group.kind === 'none';
  const list = sortableListProps(app, group, view);

  const head = flat
    ? null
    : h(
        'div',
        { class: 'v-backlog-group-head' },
        checkbox({
          checked: all,
          indeterminate: chosen > 0 && !all,
          ariaLabel: `Selecionar todos os itens de ${label}`,
          title: all ? 'Desmarcar o grupo' : 'Selecionar o grupo',
          class: 'v-backlog-group-check',
          attrs: { 'data-select-group': group.key },
          onchange: (checked) => view.selectMany(ids, checked),
        }),
        h(
          'button',
          {
            type: 'button',
            class: 'v-backlog-group-toggle',
            'aria-expanded': !collapsed,
            'data-toggle-group': group.key,
            title: collapsed ? `Expandir ${label}` : `Recolher ${label}`,
            onclick: () => view.toggleCollapsed(group.key),
          },
          icon('chevron-down', { size: 14, class: 'v-backlog-chevron' }),
          groupTitle(app, group),
          h('span', { class: 'v-backlog-group-count tabular' }, String(group.items.length)),
        ),
        h('span', { class: 'v-backlog-group-spacer' }),
        estimate ? h('span', { class: 'v-backlog-group-est tabular', title: 'Soma das estimativas do grupo' }, icon('clock', { size: 12 }), formatDurationText(estimate)) : null,
        group.kind === 'demand' && group.demand
          ? iconButton({ icon: 'panel-right', title: `Abrir a demanda ${group.demand.name}`, size: 'sm', class: 'v-backlog-group-open', onclick: () => entityActions.open(app, 'demand', group.demand.id) })
          : null,
        defaults
          ? iconButton({
              icon: 'plus',
              title: `Registrar em ${label}`,
              size: 'sm',
              active: adding,
              attrs: { 'data-action': 'group-add', 'data-group-add': group.key },
              onclick: () => view.toggleAdding(addKey, group.key),
            })
          : null,
      );

  return h(
    'section',
    {
      key: `group:${group.key}`,
      class: cx('v-backlog-group', collapsed && 'is-collapsed', flat && 'is-flat'),
      'data-group': group.key,
      'aria-label': flat ? null : label,
      ...list,
    },
    head,
    collapsed
      ? null
      : h(
          'div',
          { class: 'v-backlog-rows' },
          // `visible`: a fatia desenhada nesta página (backlog.js limita as linhas); seleção e ordem usam group.ids
          (group.visible || group.items).map((item) => (type === 'task' ? taskItem(app, item, view, group) : demandItem(app, item, view, group))),
          adding
            ? h(
                'div',
                {
                  key: `add:${group.key}`,
                  class: 'v-backlog-group-add',
                  ref: (el) => {
                    if (el.__focused) return;
                    el.__focused = true;
                    const input = el.querySelector('input');
                    if (input) queueMicrotask(() => input.focus({ preventScroll: true }));
                  },
                },
                quickAddRow(app, { type, defaults, placeholder: type === 'task' ? `Nova tarefa em ${truncate(label, 40)} — Enter para registrar` : `Nova demanda em ${truncate(label, 40)} — Enter para registrar` }),
                iconButton({ icon: 'x', title: 'Fechar', size: 'sm', onclick: () => view.toggleAdding(addKey, group.key) }),
              )
            : null,
        ),
  );
}

/** Contêiner do grupo como destino de arrasto (soltar na área do grupo = ir para o fim dele). */
function sortableListProps(app, group, view) {
  if (!view.dnd) return {};
  if (view.type === 'task') {
    return sortableList({ type: 'task', onmove: ({ id, place }) => moveTaskInto(app, id, group.id, place) });
  }
  return sortableList({
    type: 'demand',
    canDrop: (drop) => !!drop.data && drop.data.group === group.key,
    onmove: ({ id, place }) => {
      try {
        app.cmd.reorderDemand(id, place);
      } catch (err) {
        handleError(app, err);
      }
    },
  });
}
