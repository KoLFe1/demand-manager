// Tela "Dependências" — blocos ao redor do diagrama: detalhes da tarefa em foco ("Depende de" / "Bloqueia"),
// lista "Conflitos de prazo", aviso de ciclos, legenda e o modo Lista.

import { cx, h, s } from '../../../core/dom.js';
import { plural } from '../../../core/format.js';
import { dependencyChain } from '../../../domain/dependencies.js';
import { button, iconButton } from '../../kit/controls.js';
import { alertBox, deadlineChip, statusBadge } from '../../kit/display.js';
import { icon } from '../../kit/icons.js';
import { entityAttrs, entityFlags, taskRow } from '../../shared/entity.js';
import { removeDependency } from './actions.js';
import { taskName } from './model.js';

const quoted = (task) => `“${taskName(task)}”`;

function card(title, { count, icon: glyph, class: className, key, actions } = {}, ...children) {
  return h(
    'section',
    { class: cx('v-dependencias-card-box', className), key },
    h(
      'header',
      { class: 'v-dependencias-box-head' },
      glyph ? icon(glyph, { size: 14, class: 'v-dependencias-box-icon' }) : null,
      h('h2', { class: 'v-dependencias-box-title' }, title),
      count ? h('span', { class: 'v-dependencias-box-count tabular' }, String(count)) : null,
      actions ? h('span', { class: 'v-dependencias-box-actions' }, actions) : null,
    ),
    ...children,
  );
}

/** Linha de uma tarefa relacionada (Depende de / Bloqueia) com o botão de remover a ligação. */
function relationRow(app, other, { onSelect, onRemove, removeTitle, known }) {
  const code = app.sel.code('task', other);
  const attrs = entityAttrs(app, 'task', other);
  return h(
    'div',
    { ...attrs, class: cx('v-dependencias-rel', attrs.class) },
    statusBadge(app.sel.status(other.status), { compact: true }),
    h(
      'button',
      {
        type: 'button',
        class: 'v-dependencias-rel-name',
        title: known ? `Mostrar ${quoted(other)} no diagrama` : `Abrir ${quoted(other)}`,
        onclick: () => onSelect(other.id),
      },
      code ? h('span', { class: 'v-dependencias-rel-code tabular' }, code) : null,
      h('span', { class: 'truncate' }, taskName(other)),
    ),
    other.due_date ? deadlineChip(app.sel.deadline(other), { class: 'v-dependencias-rel-due' }) : null,
    iconButton({ icon: 'x', title: removeTitle, size: 'sm', class: 'v-dependencias-rel-remove', onclick: onRemove, attrs: { 'data-action': 'remove-relation' } }),
  );
}

/**
 * Detalhes da tarefa sob o mouse / selecionada: cadeia, pré-requisitos, dependentes e conflitos.
 */
export function detailsCard(app, model, taskId, { selected, onSelect, onOpen, onAddPrereq, onAddDependent }) {
  const task = taskId ? model.byId.get(taskId) : null;
  if (!task) {
    return card(
      'Detalhes',
      { icon: 'info', class: 'v-dependencias-details is-idle', key: 'details' },
      h(
        'ul',
        { class: 'v-dependencias-tips' },
        h('li', null, 'Passe o mouse ou clique numa tarefa para realçar a cadeia inteira: o que vem antes e o que depende dela.'),
        h('li', null, 'Duplo clique (ou Enter) abre a tarefa no painel.'),
        h('li', null, 'Clique numa seta para remover a dependência.'),
        h('li', null, 'Use “Ligar” para criar ligações clicando no pré-requisito e depois na tarefa dependente.'),
      ),
    );
  }
  const visible = (row) => model.byId.has(row.id);
  const prereqs = app.sel.prereqs(task.id).filter(visible);
  const dependents = app.sel.dependents(task.id).filter(visible);
  const graph = app.sel.graph();
  const up = dependencyChain(task.id, { graph, direction: 'up' }).filter((item) => model.byId.has(item.id)).length;
  const down = dependencyChain(task.id, { graph, direction: 'down' }).filter((item) => model.byId.has(item.id)).length;
  const conflicts = app.sel.conflictsOf(task.id);
  const code = app.sel.code('task', task);
  const attrs = entityAttrs(app, 'task', task);
  const select = (id) => (model.position.has(id) ? onSelect(id) : onOpen(id));
  const flags = entityFlags(app, 'task', task, { hideNoDemand: true });
  const demand = app.sel.demandOf(task);
  return card(
    selected ? 'Tarefa selecionada' : 'Tarefa em foco',
    { icon: 'git-branch', class: 'v-dependencias-details', key: 'details' },
    h(
      'div',
      { ...attrs, class: cx('v-dependencias-details-head', attrs.class), 'data-details': task.id },
      statusBadge(app.sel.status(task.status), { soft: true }),
      h(
        'button',
        { type: 'button', class: 'v-dependencias-details-name', title: 'Abrir a tarefa', onclick: () => onOpen(task.id), 'data-action': 'open-task' },
        code ? h('span', { class: 'v-dependencias-rel-code tabular' }, code) : null,
        h('span', null, taskName(task)),
      ),
      demand ? h('span', { class: 'v-dependencias-details-demand' }, icon('layers', { size: 12 }), h('span', { class: 'truncate' }, demand.name)) : null,
      flags,
      h(
        'p',
        { class: 'v-dependencias-details-chain' },
        up || down ? `Cadeia: ${plural(up, 'tarefa antes', 'tarefas antes')} · ${plural(down, 'tarefa depois', 'tarefas depois')}` : 'Sem ligações visíveis.',
      ),
    ),
    h(
      'div',
      { class: 'v-dependencias-rel-group', 'data-group': 'prereqs' },
      h('div', { class: 'v-dependencias-rel-title' }, 'Depende de', prereqs.length ? h('span', { class: 'tabular' }, String(prereqs.length)) : null),
      prereqs.length
        ? prereqs.map((p) => relationRow(app, p, { known: model.position.has(p.id), onSelect: select, removeTitle: `Remover: ${quoted(task)} deixa de depender de ${quoted(p)}`, onRemove: () => removeDependency(app, task.id, p.id) }))
        : h('p', { class: 'v-dependencias-rel-empty' }, 'Nenhum pré-requisito.'),
      button({ label: 'Adicionar pré-requisito', icon: 'plus', size: 'sm', variant: 'ghost', class: 'v-dependencias-rel-add', onclick: () => onAddPrereq(task.id), attrs: { 'data-action': 'add-prereq' } }),
    ),
    h(
      'div',
      { class: 'v-dependencias-rel-group', 'data-group': 'dependents' },
      h('div', { class: 'v-dependencias-rel-title' }, 'Bloqueia', dependents.length ? h('span', { class: 'tabular' }, String(dependents.length)) : null),
      dependents.length
        ? dependents.map((d) => relationRow(app, d, { known: model.position.has(d.id), onSelect: select, removeTitle: `Remover: ${quoted(d)} deixa de depender de ${quoted(task)}`, onRemove: () => removeDependency(app, d.id, task.id) }))
        : h('p', { class: 'v-dependencias-rel-empty' }, 'Nenhuma tarefa depende desta.'),
      button({ label: 'Adicionar dependente', icon: 'plus', size: 'sm', variant: 'ghost', class: 'v-dependencias-rel-add', onclick: () => onAddDependent(task.id), attrs: { 'data-action': 'add-dependent' } }),
    ),
    conflicts.length
      ? h(
          'ul',
          { class: 'v-dependencias-msgs' },
          conflicts.map((c, i) => h('li', { key: String(i), class: cx('v-dependencias-msg', `is-${c.severity}`) }, icon('alert-triangle', { size: 12 }), h('span', null, c.message))),
        )
      : null,
  );
}

/** Lista "Conflitos de prazo" (das tarefas no escopo). */
export function conflictsCard(app, model, { selectedId, onSelect }) {
  const list = model.conflicts;
  return card(
    'Conflitos de prazo',
    { icon: 'alert-triangle', count: list.length, class: 'v-dependencias-conflicts', key: 'conflicts' },
    list.length
      ? h(
          'div',
          { class: 'v-dependencias-conflict-list' },
          list.map(({ task, list: messages }) => {
            const attrs = entityAttrs(app, 'task', task);
            const severe = messages.some((c) => c.severity === 'danger');
            const code = app.sel.code('task', task);
            return h(
              'button',
              {
                ...attrs,
                type: 'button',
                class: cx('v-dependencias-conflict', attrs.class, severe ? 'is-danger' : 'is-warn', task.id === selectedId && 'is-selected'),
                onclick: () => onSelect(task.id),
              },
              h(
                'span',
                { class: 'v-dependencias-conflict-head' },
                statusBadge(app.sel.status(task.status), { compact: true }),
                code ? h('span', { class: 'v-dependencias-rel-code tabular' }, code) : null,
                h('span', { class: 'v-dependencias-conflict-name' }, taskName(task)),
                task.due_date ? deadlineChip(app.sel.deadline(task), { class: 'v-dependencias-conflict-due' }) : null,
              ),
              h(
                'span',
                { class: 'v-dependencias-conflict-msgs' },
                messages.map((c, i) => h('span', { key: String(i), class: cx('v-dependencias-msg', `is-${c.severity}`) }, icon('alert-triangle', { size: 12 }), h('span', null, c.message))),
              ),
            );
          }),
        )
      : h('p', { class: 'v-dependencias-box-empty' }, icon('check-circle', { size: 14 }), h('span', null, 'Nenhum conflito de prazo entre as dependências.')),
  );
}

/** Aviso de ciclos existentes (só acontecem com edições simultâneas em dois aparelhos). */
export function cyclesBanner(app, cycles, { onSelect }) {
  if (!cycles || !cycles.length) return null;
  const name = (id) => {
    const task = app.sel.task(id);
    return task ? taskName(task) : 'tarefa removida';
  };
  return alertBox({
    tone: 'danger',
    title: cycles.length === 1 ? 'Dependência circular encontrada' : `${cycles.length} dependências circulares encontradas`,
    class: 'v-dependencias-cycles',
    text: h(
      'div',
      { class: 'v-dependencias-cycles-body' },
      h('p', null, 'Edições feitas ao mesmo tempo em dois aparelhos criaram um laço: nenhuma destas tarefas consegue ser a primeira. Remova uma das ligações de cada laço.'),
      cycles.map((path, index) =>
        h(
          'div',
          { class: 'v-dependencias-cycle', key: path.join('>') || String(index), 'data-cycle': String(index) },
          h('div', { class: 'v-dependencias-cycle-path' }, path.map((id, i) => [i ? h('span', { class: 'v-dependencias-cycle-arrow' }, ' → ') : null, h('button', { type: 'button', class: 'v-dependencias-cycle-task', onclick: () => onSelect(id) }, `“${name(id)}”`)])),
          h(
            'ul',
            { class: 'v-dependencias-cycle-edges' },
            path.slice(0, -1).map((taskId, i) => {
              const prereqId = path[i + 1];
              return h(
                'li',
                { key: `${taskId}>${prereqId}` },
                h('span', null, `“${name(taskId)}” depende de “${name(prereqId)}”`),
                button({ label: 'Remover esta dependência', icon: 'unlink', size: 'sm', variant: 'ghost', attrs: { 'data-action': 'remove-cycle-edge', 'data-task': taskId, 'data-prereq': prereqId }, onclick: () => removeDependency(app, taskId, prereqId) }),
              );
            }),
          ),
        ),
      ),
    ),
  });
}

function legendEdge(kind, label) {
  return h(
    'li',
    { class: 'v-dependencias-legend-item' },
    s(
      'svg',
      { class: cx('v-dependencias-legend-edge', 'v-dependencias-edge', `is-${kind}`), width: 36, height: 10, viewBox: '0 0 36 10', 'aria-hidden': 'true' },
      s('path', { class: 'v-dependencias-edge-line', d: 'M1 5 L28 5' }),
      s('path', { class: 'v-dependencias-legend-head', d: 'M27 1.5 L34 5 L27 8.5 Z' }),
    ),
    h('span', null, label),
  );
}

/** Legenda dos estilos de nós e setas. */
export function legendCard({ mode }) {
  return card(
    'Legenda',
    { icon: 'info', class: 'v-dependencias-legend', key: 'legend' },
    mode === 'diagram'
      ? h(
          'ul',
          { class: 'v-dependencias-legend-list' },
          h('li', { class: 'v-dependencias-legend-item' }, h('span', { class: 'v-dependencias-legend-arrowtext' }, 'A', icon('arrow-right', { size: 12 }), 'B'), h('span', null, 'B depende de A (A é o pré-requisito)')),
          legendEdge('pending', 'Pendente: pré-requisito em aberto'),
          legendEdge('satisfied', 'Satisfeita: pré-requisito concluído'),
          legendEdge('conflict', 'Conflito de prazo'),
          legendEdge('cycle', 'Dependência circular'),
        )
      : null,
    h(
      'ul',
      { class: 'v-dependencias-legend-list' },
      h('li', { class: 'v-dependencias-legend-item' }, h('span', { class: 'v-dependencias-legend-glyph is-danger' }, icon('lock', { size: 12 })), h('span', null, 'Bloqueada: há pré-requisito em aberto')),
      h('li', { class: 'v-dependencias-legend-item' }, h('span', { class: 'v-dependencias-legend-glyph is-warning' }, icon('alert-triangle', { size: 12 })), h('span', null, 'Conflito de prazo')),
      mode === 'diagram' ? h('li', { class: 'v-dependencias-legend-item' }, h('span', { class: 'v-dependencias-legend-node is-closed' }), h('span', null, 'Concluída (esmaecida)')) : null,
      mode === 'diagram' ? h('li', { class: 'v-dependencias-legend-item' }, h('span', { class: 'v-dependencias-legend-node is-external' }), h('span', null, 'Fora do filtro de demanda/projeto')) : null,
    ),
  );
}

/** Modo Lista: cada tarefa com pré-requisitos e a cadeia "acima" dela, recuada pela distância. */
export function renderList(app, entries, { selectedId }) {
  return h(
    'div',
    { class: 'v-dependencias-list', role: 'list' },
    entries.map(({ task, chain, blocked }) =>
      h(
        'section',
        { key: `chain:${task.id}`, class: cx('v-dependencias-chain', blocked && 'is-blocked', task.id === selectedId && 'is-selected'), role: 'listitem', 'data-chain': task.id },
        taskRow(app, task, { columns: ['check', 'title', 'flags', 'status', 'priority', 'due', 'menu'], showDemand: true, class: 'v-dependencias-chain-root' }),
        h(
          'div',
          { class: 'v-dependencias-chain-items' },
          h('div', { class: 'v-dependencias-chain-label' }, icon('arrow-left', { size: 12 }), `Depende de ${plural(chain.length, 'tarefa', 'tarefas')}`),
          chain.map(({ task: item, depth }) =>
            taskRow(app, item, {
              columns: ['check', 'title', 'flags', 'status-compact', 'due'],
              indent: depth,
              class: cx('v-dependencias-chain-item', `depth-${Math.min(depth, 6)}`),
            }),
          ),
        ),
      ),
    ),
  );
}
