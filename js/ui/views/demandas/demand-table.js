// Tela "Demandas" — modo Demandas: tabela (seção 10.1 do pedido) com Nome, Projeto, Prioridade, Status, Prazo,
// Progresso, Próxima ação e Responsável; cada linha pode expandir para mostrar as tarefas da demanda.
//
// A mesma árvore serve ao computador e ao celular: em contêiner largo as células formam uma grade alinhada ao
// cabeçalho; em contêiner estreito (CSS, consulta de contêiner) cada linha vira um cartão de duas linhas.

import { cx, h } from '../../../core/dom.js';
import { plural } from '../../../core/format.js';
import { iconButton, inlineEdit } from '../../kit/controls.js';
import { sortableItem, sortableList } from '../../kit/dnd.js';
import { icon } from '../../kit/icons.js';
import {
  dueControl,
  entityAttrs,
  entityTitle,
  openEntityMenu,
  ownerControl,
  priorityControl,
  progressControl,
  projectControl,
  quickAddRow,
  statusControl,
  taskRow,
} from '../../shared/entity.js';
import { bodyClick, groupHeader, groupRows, headerCell, nameEditor, rowKeydown, run, toggled } from './common.js';

/** Colunas das tarefas mostradas dentro de uma demanda expandida. */
const SUB_COLUMNS = Object.freeze(['grip', 'check', 'title', 'flags', 'status', 'priority', 'due', 'owner', 'menu']);

/**
 * Cabeçalho da tabela de demandas (botões de ordenação).
 * @param {{ sort: object, onsort: Function }} options
 */
function tableHead({ sort, onsort }) {
  const cell = (label, key, cls) => headerCell({ label, key, sort, onsort, mode: 'demands', class: cls });
  return h(
    'div',
    { key: 'head', class: 'v-dm-head v-dm-dgrid', role: 'group', 'aria-label': 'Colunas (clique para ordenar)' },
    h('span', { class: 'v-dm-th v-dm-c-expand', 'aria-hidden': 'true' }),
    cell('Nome', 'name', 'v-dm-c-name'),
    h(
      'div',
      { class: 'v-dm-meta' },
      cell('Projeto', 'project', 'v-dm-c-project'),
      cell('Prioridade', 'priority', 'v-dm-c-priority'),
      cell('Status', 'status', 'v-dm-c-status'),
      cell('Prazo', 'due_date', 'v-dm-c-due'),
      cell('Progresso', 'progress', 'v-dm-c-progress'),
      cell('Próxima ação', null, 'v-dm-c-next'),
      cell('Responsável', null, 'v-dm-c-owner'),
    ),
    h('span', { class: 'v-dm-th v-dm-c-menu', 'aria-hidden': 'true' }),
  );
}

/** Tarefas (e subtarefas) de uma demanda expandida + criação rápida de tarefa. */
function demandTasks(app, demand) {
  const { sel } = app;
  // Demanda arquivada (com "Exibir → Arquivadas"): as tarefas dela são arquivadas por herança — mostra assim mesmo.
  const opts = { includeArchived: sel.isHidden('demand', demand) };
  const tasks = sel.topTasks(demand.id, opts);
  const move = ({ id, place }) => run(app, () => app.cmd.moveTask(id, place));
  // Reordenar só entre irmãos (mesma demanda / mesma tarefa-pai): mudar de lista é trabalho do painel.
  const sortable = (task, list) =>
    sortableItem({ type: 'task', id: task.id, data: { list }, handle: '.en-grip', onmove: move, canDrop: (drop) => !!drop.data && drop.data.list === list });
  const topList = `demand:${demand.id}`;
  const rows = [];
  for (const task of tasks) {
    rows.push(taskRow(app, task, { columns: SUB_COLUMNS, class: 'v-dm-subrow', attrs: sortable(task, topList) }));
    const subs = sel.subtasks(task.id, opts);
    if (subs.length) {
      const subList = `task:${task.id}`;
      rows.push(
        h(
          'div',
          { key: `subs-${task.id}`, class: 'v-dm-subtasks', ...sortableList({ type: 'task' }) },
          subs.map((sub) => taskRow(app, sub, { columns: SUB_COLUMNS, indent: 1, class: 'v-dm-subrow', attrs: sortable(sub, subList) })),
        ),
      );
    }
  }
  return h(
    'div',
    { key: `tasks-${demand.id}`, class: 'v-dm-expansion', 'data-expansion': demand.id },
    h('div', { class: 'v-dm-expansion-list', ...sortableList({ type: 'task' }) }, rows),
    quickAddRow(app, {
      type: 'task',
      defaults: { demand_id: demand.id },
      placeholder: tasks.length ? 'Adicionar tarefa' : 'Adicionar a primeira tarefa',
      class: 'v-dm-quickadd-task',
    }),
  );
}

/**
 * Linha de uma demanda (grade no computador, cartão no celular).
 * @param {object} app
 * @param {object} ctx
 * @param {object} demand
 * @param {{ expanded: boolean, editing: boolean, canDrag: boolean, ontoggle: () => void }} options
 */
function demandRowNode(app, ctx, demand, { expanded, editing, selected, canDrag, ontoggle }) {
  const { sel } = app;
  const attrs = entityAttrs(app, 'demand', demand);
  const open = () => app.ui.openPanel('demand', demand.id);
  const rename = () => ctx.setState({ editing: demand.id });
  const count = sel.topTasks(demand.id).length;
  const dnd = canDrag
    ? sortableItem({ type: 'demand', id: demand.id, handle: '.v-dm-grip', onmove: ({ id, place }) => run(app, () => app.cmd.reorderDemand(id, place)) })
    : {};
  const name = editing
    ? nameEditor(app, ctx, 'demand', demand)
    : h(
        'span',
        {
          class: 'v-dm-name',
          title: 'Clique para abrir · duplo clique ou F2 para renomear',
          ondblclick: (ev) => {
            ev.preventDefault();
            rename();
          },
        },
        entityTitle(app, 'demand', demand),
      );
  return h(
    'div',
    {
      ...dnd,
      ...attrs,
      class: cx('v-dm-row', 'v-dm-drow', 'v-dm-dgrid', attrs.class, expanded && 'is-expanded', editing && 'is-editing', selected && 'is-selected', canDrag && 'is-draggable'),
      'aria-current': selected ? 'true' : null,
      tabindex: 0,
      onclick: bodyClick(open),
      onkeydown: rowKeydown({ onopen: open, onrename: rename, ontoggle, expanded }),
    },
    canDrag ? h('span', { class: 'v-dm-grip', title: 'Arraste para reordenar', 'aria-hidden': 'true' }, icon('grip', { size: 14 })) : null,
    h(
      'span',
      { class: 'v-dm-c v-dm-c-expand' },
      iconButton({
        icon: 'chevron-right',
        size: 'sm',
        title: expanded ? 'Ocultar as tarefas' : count ? `Mostrar ${plural(count, 'tarefa', 'tarefas')}` : 'Mostrar tarefas (nenhuma ainda)',
        class: cx('v-dm-expand', expanded && 'is-open', !count && 'is-empty'),
        attrs: { 'aria-expanded': expanded, 'data-action': 'expand' },
        onclick: (ev) => {
          ev.stopPropagation();
          ontoggle();
        },
      }),
    ),
    h('span', { class: 'v-dm-c v-dm-c-name' }, name, count ? h('span', { class: 'v-dm-count tabular', title: plural(count, 'tarefa', 'tarefas') }, String(count)) : null),
    h(
      'div',
      { class: 'v-dm-meta' },
      h('span', { class: 'v-dm-c v-dm-c-project' }, projectControl(app, demand, { compact: true })),
      h('span', { class: 'v-dm-c v-dm-c-priority' }, priorityControl(app, 'demand', demand)),
      h('span', { class: 'v-dm-c v-dm-c-status' }, statusControl(app, 'demand', demand)),
      h('span', { class: 'v-dm-c v-dm-c-due' }, dueControl(app, 'demand', demand, { compact: true })),
      h('span', { class: 'v-dm-c v-dm-c-progress' }, progressControl(app, demand, { compact: true })),
      h(
        'span',
        { class: 'v-dm-c v-dm-c-next' },
        icon('arrow-right', { size: 12, class: 'v-dm-next-icon' }),
        inlineEdit({
          value: demand.next_action || '',
          placeholder: 'Definir próxima ação',
          allowEmpty: true,
          maxlength: 500,
          ariaLabel: 'Próxima ação',
          class: 'v-dm-next',
          onsave: (text) => run(app, () => app.cmd.updateDemand(demand.id, { next_action: text || null })),
        }),
      ),
      h('span', { class: 'v-dm-c v-dm-c-owner' }, ownerControl(app, 'demand', demand)),
    ),
    h(
      'span',
      { class: 'v-dm-c v-dm-c-menu' },
      iconButton({
        icon: 'more-horizontal',
        title: 'Mais ações',
        size: 'sm',
        class: 'v-dm-menu-btn',
        onclick: (ev) => {
          ev.stopPropagation();
          openEntityMenu(app, 'demand', demand.id, ev.currentTarget);
        },
      }),
    ),
  );
}

/**
 * Corpo do modo Demandas: cabeçalho, linhas (com grupos opcionais), expansões e a criação rápida.
 * @param {object} app
 * @param {object} ctx
 * @param {{ rows: object[], view: object, expanded: Set<string>, editing: string|null, onsort: Function }} model
 * @returns {HTMLElement}
 */
export function demandTable(app, ctx, { rows, view, expanded, editing, selected, onsort }) {
  const canDrag = view.sort.key === 'manual' && view.group === 'none';
  const toggleExpand = (id) => ctx.setState((prev) => ({ expanded: toggled(Array.isArray(prev.expanded) ? prev.expanded : [], id) }));
  const rowFor = (demand) => {
    const isOpen = expanded.has(demand.id);
    return h(
      'div',
      { key: demand.id, class: cx('v-dm-item', isOpen && 'is-expanded') },
      demandRowNode(app, ctx, demand, { expanded: isOpen, editing: editing === demand.id, selected: selected === `demand:${demand.id}`, canDrag, ontoggle: () => toggleExpand(demand.id) }),
      isOpen ? demandTasks(app, demand) : null,
    );
  };
  let body;
  if (view.group === 'none') {
    body = rows.map(rowFor);
  } else {
    body = groupRows(app, rows, view.group, 'demand').map((group) => {
      const collapsed = view.collapsed.has(group.key);
      return h(
        'div',
        { key: `g-${group.key}`, class: 'v-dm-group' },
        groupHeader({
          group,
          collapsed,
          noun: ['demanda', 'demandas'],
          ontoggle: () => ctx.setState((prev) => ({ dCollapsed: toggled(Array.isArray(prev.dCollapsed) ? prev.dCollapsed : [], group.key) })),
        }),
        collapsed ? null : group.items.map(rowFor),
      );
    });
  }
  return h(
    'div',
    { key: 'table-demands', class: 'v-dm-table is-demands' },
    tableHead({ sort: view.sort, onsort }),
    h('div', { key: 'body', class: 'v-dm-body', ...sortableList({ type: 'demand' }) }, body),
  );
}
