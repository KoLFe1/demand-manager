// Tela "Demandas" — modo Tarefas: tabela plana de tarefas (e subtarefas, opcionalmente) com Nome, Demanda /
// Projeto, Prioridade, Status, Prazo, Estimativa × tempo gasto e Responsável. Prioridade e status mudam direto
// na lista (seção 3 do pedido: "alterar prioridade diretamente na listagem").

import { cx, h } from '../../../core/dom.js';
import { truncate } from '../../../core/format.js';
import { estimateVsActual, formatDuration } from '../../../domain/timetracking.js';
import { button, formatDurationText, iconButton } from '../../kit/controls.js';
import { icon } from '../../kit/icons.js';
import {
  checkControl,
  demandControl,
  dueControl,
  entityAttrs,
  entityFlags,
  entityTitle,
  openEntityMenu,
  ownerControl,
  priorityControl,
  projectDot,
  statusControl,
} from '../../shared/entity.js';
import { bodyClick, groupHeader, groupRows, headerCell, nameEditor, rowKeydown, toggled } from './common.js';

/** Cabeçalho da tabela de tarefas. */
function tableHead({ sort, onsort }) {
  const cell = (label, key, cls) => headerCell({ label, key, sort, onsort, mode: 'tasks', class: cls });
  return h(
    'div',
    { key: 'head', class: 'v-dm-head v-dm-tgrid', role: 'group', 'aria-label': 'Colunas (clique para ordenar)' },
    h('span', { class: 'v-dm-th v-dm-c-check', 'aria-hidden': 'true' }),
    cell('Nome', 'name', 'v-dm-c-name'),
    h(
      'div',
      { class: 'v-dm-meta' },
      cell('Demanda / Projeto', 'project', 'v-dm-c-context'),
      cell('Prioridade', 'priority', 'v-dm-c-priority'),
      cell('Status', 'status', 'v-dm-c-status'),
      cell('Prazo', 'due_date', 'v-dm-c-due'),
      cell('Estimativa × gasto', null, 'v-dm-c-time'),
      cell('Responsável', null, 'v-dm-c-owner'),
    ),
    h('span', { class: 'v-dm-th v-dm-c-menu', 'aria-hidden': 'true' }),
  );
}

/** "45min / 2h" — tempo apontado × estimativa, com tom de alerta quando passou da estimativa. */
function timeCell(app, task) {
  const tracked = app.sel.trackedSeconds(task.id);
  const estimate = task.estimate_minutes;
  if (!tracked && !estimate) return h('span', { class: 'v-dm-time is-empty', 'aria-label': 'Sem estimativa nem tempo apontado' }, '—');
  const cmp = estimateVsActual(estimate, tracked);
  const spent = tracked ? formatDuration(tracked) : '0min';
  const planned = estimate ? formatDurationText(estimate) : null;
  const title = planned ? `Tempo gasto: ${spent} · estimativa: ${planned}` : `Tempo gasto: ${spent} (sem estimativa)`;
  const ratio = cmp.ratio === null ? null : Math.min(1, cmp.ratio);
  return h(
    'span',
    { class: cx('v-dm-time', `is-${cmp.state}`), title },
    h('span', { class: 'v-dm-time-text tabular' }, h('span', { class: 'v-dm-time-spent' }, spent), planned ? h('span', { class: 'v-dm-time-est' }, ` / ${planned}`) : null),
    ratio === null ? null : h('span', { class: 'v-dm-time-bar', 'aria-hidden': 'true' }, h('span', { class: 'v-dm-time-fill', style: { width: `${Math.round(ratio * 100)}%` } })),
  );
}

/** Demanda (troca pelo seletor) + projeto, em duas linhas discretas. */
function contextCell(app, task) {
  const project = app.sel.projectOf('task', task);
  return h(
    'span',
    { class: 'v-dm-context' },
    demandControl(app, task),
    h('span', { class: cx('v-dm-context-project', !project && 'is-empty') }, projectDot(project), h('span', { class: 'truncate' }, project ? project.name : 'Sem projeto')),
  );
}

/**
 * Indicadores da tarefa sem o de tempo apontado (que já tem a coluna "Estimativa × gasto"). Os nós acabaram
 * de ser criados por entityFlags — nada aqui guarda referência de um desenho para o outro.
 */
function flagsWithoutTime(app, task) {
  const flags = entityFlags(app, 'task', task, { hideNoDemand: true });
  if (!flags) return null;
  for (const chip of [...flags.children]) {
    if (chip.querySelector(':scope > [data-icon="clock"]')) chip.remove();
  }
  return flags.children.length ? flags : null;
}

/** Linha de uma tarefa. */
function taskRowNode(app, ctx, task, { editing, selected }) {
  const { sel } = app;
  const attrs = entityAttrs(app, 'task', task);
  const parent = sel.parentOf(task);
  const open = () => app.ui.openPanel('task', task.id);
  const rename = () => ctx.setState({ editing: task.id });
  const flags = editing ? null : flagsWithoutTime(app, task);
  return h(
    'div',
    {
      ...attrs,
      class: cx('v-dm-row', 'v-dm-trow', 'v-dm-tgrid', attrs.class, parent && 'is-subtask', editing && 'is-editing', selected && 'is-selected'),
      'aria-current': selected ? 'true' : null,
      tabindex: 0,
      onclick: bodyClick(open),
      onkeydown: rowKeydown({ onopen: open, onrename: rename }),
    },
    h('span', { class: 'v-dm-c v-dm-c-check' }, checkControl(app, task)),
    h(
      'span',
      { class: 'v-dm-c v-dm-c-name' },
      parent
        ? h('span', { class: 'v-dm-parent', title: `Subtarefa de ${parent.name}` }, h('span', { class: 'v-dm-parent-name' }, truncate(parent.name || 'Sem nome', 32)), icon('chevron-right', { size: 12 }))
        : null,
      editing
        ? nameEditor(app, ctx, 'task', task)
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
            entityTitle(app, 'task', task),
          ),
      flags ? h('span', { class: 'v-dm-flags' }, flags) : null,
    ),
    h(
      'div',
      { class: 'v-dm-meta' },
      h('span', { class: 'v-dm-c v-dm-c-context' }, contextCell(app, task)),
      h('span', { class: 'v-dm-c v-dm-c-priority' }, priorityControl(app, 'task', task)),
      h('span', { class: 'v-dm-c v-dm-c-status' }, statusControl(app, 'task', task)),
      h('span', { class: 'v-dm-c v-dm-c-due' }, dueControl(app, 'task', task, { compact: true })),
      h('span', { class: 'v-dm-c v-dm-c-time' }, timeCell(app, task)),
      h('span', { class: 'v-dm-c v-dm-c-owner' }, ownerControl(app, 'task', task)),
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
          openEntityMenu(app, 'task', task.id, ev.currentTarget);
        },
      }),
    ),
  );
}

/** Botão "Mostrar mais" no fim da tabela paginada. */
function moreButton(left, page, onmore) {
  const next = Math.min(left, page);
  return h(
    'div',
    { key: 'more', class: 'v-dm-more' },
    button({
      label: `Mostrar mais ${next} (${left} restantes)`,
      icon: 'chevron-down',
      size: 'sm',
      variant: 'ghost',
      class: 'v-dm-more-btn',
      attrs: { 'data-action': 'show-more' },
      onclick: onmore,
    }),
  );
}

/**
 * Corpo do modo Tarefas. Só as primeiras `limit` linhas (somando os grupos abertos) vão para o DOM — com milhares
 * de tarefas a lista continua rápida; o restante vem com "Mostrar mais" (`onmore`).
 * @param {object} app
 * @param {object} ctx
 * @param {{ rows: object[], view: object, editing: string|null, onsort: Function, limit?: number, page?: number,
 *           onmore?: Function }} model
 * @returns {HTMLElement}
 */
export function taskTable(app, ctx, { rows, view, editing, selected, onsort, limit = Infinity, page = limit, onmore }) {
  const rowFor = (task) => taskRowNode(app, ctx, task, { editing: editing === task.id, selected: selected === `task:${task.id}` });
  let body;
  let hidden = 0;
  if (view.group === 'none') {
    body = rows.slice(0, limit).map(rowFor);
    hidden = Math.max(0, rows.length - limit);
  } else {
    let budget = limit;
    body = groupRows(app, rows, view.group, 'task').map((group) => {
      const collapsed = view.collapsed.has(group.key);
      let items = null;
      if (!collapsed) {
        items = group.items.slice(0, Math.max(0, budget));
        budget -= items.length;
        hidden += group.items.length - items.length;
      }
      return h(
        'div',
        { key: `g-${group.key}`, class: 'v-dm-group' },
        groupHeader({
          group,
          collapsed,
          noun: ['tarefa', 'tarefas'],
          ontoggle: () => ctx.setState((prev) => ({ tCollapsed: toggled(Array.isArray(prev.tCollapsed) ? prev.tCollapsed : [], group.key) })),
        }),
        items ? items.map(rowFor) : null,
      );
    });
  }
  return h(
    'div',
    { key: 'table-tasks', class: 'v-dm-table is-tasks' },
    tableHead({ sort: view.sort, onsort }),
    h('div', { key: 'body', class: 'v-dm-body' }, body),
    hidden > 0 && onmore ? moreButton(hidden, page, onmore) : null,
  );
}
