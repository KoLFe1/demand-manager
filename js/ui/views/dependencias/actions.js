// Tela "Dependências" — ações de escrita (sempre por app.cmd), o seletor em dois passos "Nova dependência" e
// o popover de uma aresta. Nada aqui guarda estado da tela: o que muda a tela volta pelos callbacks.

import { cx, h } from '../../../core/dom.js';
import { normalizeText } from '../../../core/format.js';
import { validateNewDependency } from '../../../domain/dependencies.js';
import { button, searchInput } from '../../kit/controls.js';
import { alertBox, statusBadge } from '../../kit/display.js';
import { icon } from '../../kit/icons.js';
import { openModal, openPopover } from '../../kit/overlays.js';
import { handleError, notify } from '../../shared/entity.js';
import { pickableTasks, taskName } from './model.js';

/** Quantos itens a lista do seletor mostra de uma vez (o resto aparece ao refinar a busca). */
const LIST_LIMIT = 60;

const REASON_HINTS = Object.freeze({
  cycle: 'Criaria um ciclo',
  duplicate: 'Já é pré-requisito',
  hierarchy: 'Subtarefa / principal',
  self: 'A própria tarefa',
  missing: 'Indisponível',
});

const quoted = (task) => `“${taskName(task)}”`;

/** Erro de regra de negócio vindo de app.cmd (CommandError). */
function isCommandError(err) {
  return !!err && typeof err === 'object' && err.name === 'CommandError' && typeof err.code === 'string';
}

/**
 * Cria "taskId depende de prereqId" pelo comando. Sucesso: aviso com "Desfazer". Recusa: devolve a mensagem
 * do comando (no ciclo ela soletra o laço) e nada é criado.
 * @returns {{ ok: true }|{ ok: false, message: string, code?: string }}
 */
export function createDependency(app, taskId, prereqId) {
  try {
    app.cmd.addDependency(taskId, prereqId);
  } catch (err) {
    if (isCommandError(err)) return { ok: false, message: err.message, code: err.code };
    handleError(app, err);
    return { ok: false, message: 'Não foi possível criar a dependência.' };
  }
  const task = app.sel.task(taskId);
  const prereq = app.sel.task(prereqId);
  notify(app, `Dependência criada: ${quoted(task)} depende de ${quoted(prereq)}`, {
    tone: 'success',
    action: {
      label: 'Desfazer',
      onclick: () => {
        try {
          app.cmd.removeDependency(taskId, prereqId);
        } catch (err) {
          handleError(app, err);
        }
      },
    },
  });
  return { ok: true };
}

/**
 * Remove "taskId depende de prereqId" pelo comando, com "Desfazer".
 * @returns {boolean}
 */
export function removeDependency(app, taskId, prereqId) {
  let removed;
  try {
    removed = app.cmd.removeDependency(taskId, prereqId);
  } catch (err) {
    handleError(app, err);
    return false;
  }
  if (!removed || !removed.length) return false;
  const task = app.sel.task(taskId);
  const prereq = app.sel.task(prereqId);
  notify(app, `Dependência removida: ${quoted(task)} não depende mais de ${quoted(prereq)}`, {
    action: {
      label: 'Desfazer',
      onclick: () => {
        try {
          app.cmd.addDependency(taskId, prereqId);
        } catch (err) {
          handleError(app, err);
        }
      },
    },
  });
  return true;
}

/**
 * Popover de uma aresta: explica a ligação e oferece "Remover dependência".
 * @param {object} app
 * @param {{ from: string, to: string, kind: string }} edge
 * @param {{ x: number, y: number }|Element} anchor
 * @param {{ onRemoved?: () => void, onOpen?: (id: string) => void }} [callbacks]
 */
export function openEdgePopover(app, edge, anchor, { onRemoved, onOpen } = {}) {
  const prereq = app.sel.task(edge.from);
  const task = app.sel.task(edge.to);
  if (!prereq || !task) return null;
  const state = {
    pending: 'O pré-requisito ainda está aberto: a tarefa fica bloqueada até ele ser concluído.',
    satisfied: 'Ligação já satisfeita: o pré-requisito foi concluído (ou a tarefa já foi encerrada).',
    conflict: 'Há conflito de prazo nesta ligação.',
    cycle: 'Esta ligação faz parte de uma dependência circular.',
  }[edge.kind];
  const conflicts = app.sel.conflictsOf(task.id).filter((c) => c.prereqId === prereq.id);
  return openPopover(
    anchor,
    (close) =>
      h(
        'div',
        { class: 'v-dependencias-edgepop', 'data-edge-popover': `${edge.from}>${edge.to}` },
        h(
          'div',
          { class: 'v-dependencias-edgepop-title' },
          h('button', { type: 'button', class: 'v-dependencias-edgepop-link', onclick: () => { close('open'); if (onOpen) onOpen(task.id); } }, quoted(task)),
          h('span', { class: 'v-dependencias-edgepop-verb' }, ' depende de '),
          h('button', { type: 'button', class: 'v-dependencias-edgepop-link', onclick: () => { close('open'); if (onOpen) onOpen(prereq.id); } }, quoted(prereq)),
        ),
        state ? h('p', { class: cx('v-dependencias-edgepop-text', `is-${edge.kind}`) }, state) : null,
        conflicts.length ? h('ul', { class: 'v-dependencias-edgepop-conflicts' }, conflicts.map((c, i) => h('li', { key: String(i) }, c.message))) : null,
        h(
          'div',
          { class: 'v-dependencias-edgepop-actions' },
          button({ label: 'Cancelar', size: 'sm', variant: 'ghost', onclick: () => close('cancel') }),
          button({
            label: 'Remover dependência',
            icon: 'unlink',
            size: 'sm',
            variant: 'danger',
            attrs: { 'data-action': 'remove-dependency' },
            onclick: () => {
              close('remove');
              if (removeDependency(app, task.id, prereq.id) && onRemoved) onRemoved();
            },
          }),
        ),
      ),
    { placement: 'bottom-start', width: 320, ariaLabel: 'Dependência' },
  );
}

/** Item da lista de tarefas do seletor. */
function pickItem(app, task, { selected, hint, invalid, onpick }) {
  const status = app.sel.status(task.status);
  const demand = app.sel.demandOf(task);
  const code = app.sel.code('task', task);
  return h(
    'button',
    {
      type: 'button',
      key: task.id,
      class: cx('v-dependencias-pick', selected && 'is-selected', invalid && 'is-invalid', !app.sel.isOpen(task) && 'is-closed'),
      role: 'option',
      'aria-selected': !!selected,
      'data-pick': task.id,
      title: `${code ? `${code} ` : ''}${taskName(task)}${demand ? ` — ${demand.name}` : ''}`,
      onclick: () => onpick(task.id),
    },
    statusBadge(status, { compact: true }),
    h('span', { class: 'v-dependencias-pick-main' }, h('span', { class: 'v-dependencias-pick-name' }, code ? h('span', { class: 'v-dependencias-pick-code tabular' }, code) : null, taskName(task)), h('span', { class: 'v-dependencias-pick-demand' }, demand ? demand.name : 'Sem demanda')),
    hint ? h('span', { class: cx('v-dependencias-pick-hint', invalid && 'is-invalid') }, hint) : null,
    selected ? icon('check', { size: 14, class: 'v-dependencias-pick-check' }) : null,
  );
}

/**
 * Seletor em dois passos: "Tarefa" depende de "Pré-requisito". Com a tarefa já escolhida, começa no passo 2.
 * @param {object} app
 * @param {{ taskId?: string|null, prereqId?: string|null, onCreated?: (taskId: string, prereqId: string) => void }} [options]
 */
export function openNewDependency(app, { taskId = null, prereqId = null, onCreated } = {}) {
  const local = {
    task: taskId && app.sel.task(taskId) ? taskId : null,
    prereq: prereqId && app.sel.task(prereqId) ? prereqId : null,
    step: 'task',
    q: { task: '', prereq: '' },
    error: null,
  };
  local.step = local.task && !local.prereq ? 'prereq' : 'task';
  let dlg = null;
  const refresh = () => dlg && dlg.update();

  const choose = (id) => {
    if (local.step === 'task') {
      local.task = id;
      local.error = null;
      if (local.prereq === id) local.prereq = null;
      if (!local.prereq) local.step = 'prereq';
    } else {
      local.prereq = id;
      local.error = null;
    }
    refresh();
  };

  const submit = (close) => {
    if (!local.task || !local.prereq) return;
    const result = createDependency(app, local.task, local.prereq);
    if (result.ok) {
      close('created');
      if (onCreated) onCreated(local.task, local.prereq);
    } else {
      local.error = result.message;
      refresh();
    }
  };

  const listFor = (step) => {
    const all = pickableTasks(app);
    const terms = normalizeText(local.q[step]).split(/\s+/).filter(Boolean);
    const graph = app.sel.graph();
    const tasksById = app.sel.tasksById();
    const out = [];
    let total = 0;
    for (const task of all) {
      if (terms.length) {
        const demand = app.sel.demandOf(task);
        const text = normalizeText(`${app.sel.code('task', task)} ${task.name || ''} ${demand ? demand.name : ''}`);
        if (!terms.every((term) => text.includes(term))) continue;
      }
      total += 1;
      if (out.length >= LIST_LIMIT) continue;
      let hint = null;
      let invalid = false;
      if (step === 'prereq' && local.task) {
        if (task.id === local.task) {
          hint = REASON_HINTS.self;
          invalid = true;
        } else {
          const check = validateNewDependency(local.task, task.id, { graph, tasksById });
          if (!check.ok) {
            hint = REASON_HINTS[check.reason] || 'Inválida';
            invalid = true;
          }
        }
      }
      if (!hint) hint = app.sel.status(task.status).label;
      out.push({ task, hint, invalid });
    }
    return { items: out, total };
  };

  const slot = (step, label, id, placeholder) => {
    const task = id ? app.sel.task(id) : null;
    return h(
      'button',
      {
        type: 'button',
        class: cx('v-dependencias-slot', local.step === step && 'is-active', task && 'has-value'),
        'data-slot': step,
        'aria-pressed': local.step === step,
        onclick: () => {
          local.step = step;
          refresh();
        },
      },
      h('span', { class: 'v-dependencias-slot-label' }, label),
      h('span', { class: 'v-dependencias-slot-value' }, task ? `${app.sel.code('task', task)} ${taskName(task)}`.trim() : placeholder),
    );
  };

  const render = () => {
    const step = local.step;
    const { items, total } = listFor(step);
    const task = local.task ? app.sel.task(local.task) : null;
    const prereq = local.prereq ? app.sel.task(local.prereq) : null;
    const help =
      step === 'task'
        ? 'Escolha a tarefa que só pode avançar depois de outra.'
        : task
          ? ['Escolha o que precisa ficar pronto antes de ', h('strong', null, quoted(task)), '.']
          : 'Escolha o pré-requisito: a tarefa que precisa ficar pronta antes.';
    return h(
      'div',
      { class: 'v-dependencias-new', 'data-step': step },
      h(
        'div',
        { class: 'v-dependencias-slots' },
        slot('task', '1 · Tarefa', local.task, 'Escolha a tarefa'),
        h('span', { class: 'v-dependencias-slots-verb' }, icon('arrow-left', { size: 14 }), 'depende de'),
        slot('prereq', '2 · Pré-requisito', local.prereq, 'Escolha o pré-requisito'),
      ),
      h('p', { class: 'v-dependencias-new-help' }, help),
      h(
        'div',
        { key: `search-${step}` },
        searchInput({
          value: local.q[step],
          placeholder: step === 'task' ? 'Buscar tarefa…' : 'Buscar pré-requisito…',
          autofocus: true,
          oninput: (text) => {
            local.q[step] = text;
            refresh();
          },
          onenter: () => {
            if (items.length) choose(items[0].task.id);
          },
          attrs: { 'data-search': step },
        }),
      ),
      h(
        'div',
        { class: 'v-dependencias-picklist', role: 'listbox', 'aria-label': step === 'task' ? 'Tarefas' : 'Pré-requisitos', key: `list-${step}` },
        items.length
          ? items.map(({ task: t, hint, invalid }) => pickItem(app, t, { selected: t.id === (step === 'task' ? local.task : local.prereq), hint, invalid, onpick: choose }))
          : h('p', { class: 'v-dependencias-picklist-empty' }, total ? '' : 'Nenhuma tarefa encontrada.'),
        total > items.length ? h('p', { class: 'v-dependencias-picklist-more' }, `Mostrando ${items.length} de ${total} — refine a busca para ver as demais.`) : null,
      ),
      local.error ? alertBox({ tone: 'danger', title: 'Dependência não criada', text: local.error, class: 'v-dependencias-new-error' }) : null,
      task && prereq && !local.error
        ? h('p', { class: 'v-dependencias-new-summary' }, icon('link', { size: 14 }), h('span', null, h('strong', null, quoted(task)), ' só poderá avançar depois de ', h('strong', null, quoted(prereq)), '.'))
        : null,
    );
  };

  dlg = openModal({
    title: 'Nova dependência',
    size: 'md',
    class: 'v-dependencias-modal',
    render,
    actions: () => [
      { label: 'Cancelar', onclick: (close) => close('cancel') },
      { label: 'Criar dependência', variant: 'primary', icon: 'link', disabled: !local.task || !local.prereq, onclick: (close) => submit(close) },
    ],
  });
  return dlg;
}
