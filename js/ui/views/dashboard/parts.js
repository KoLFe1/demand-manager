// Peças da tela "Início": cartão de seção recolhível, linhas sob medida (próxima ação, item travado, demanda
// com progresso e próxima ação editável, item compacto de prazo) e cartões de sugestão de prioridade.
//
// Toda interação com tarefas e demandas vem de js/ui/shared/entity.js (concluir, status, prioridade, prazo,
// cronômetro, menu); aqui só montamos o desenho. Toda escrita passa por app.cmd.* e erros vão para handleError.

import { cx, h } from '../../../core/dom.js';
import { plural, truncate } from '../../../core/format.js';
import { button, iconButton, inlineEdit } from '../../kit/controls.js';
import { badge, priorityBadge, sectionHeader } from '../../kit/display.js';
import { icon } from '../../kit/icons.js';
import {
  askImpediment,
  checkControl,
  dueControl,
  entityActions,
  entityAttrs,
  entityTitle,
  handleError,
  notify,
  openEntityMenu,
  priorityControl,
  progressControl,
  projectDot,
  statusControl,
  timerControl,
} from '../../shared/entity.js';

/** Elementos que tratam o próprio clique dentro de uma linha (o clique não abre o painel). */
const INTERACTIVE = 'button, a, input, textarea, select, label, [data-stop], .inline-edit, [role="checkbox"]';

const quoted = (text) => `“${text}”`;
const nameOf = (entity) => (entity && typeof entity.name === 'string' && entity.name.trim() ? entity.name.trim() : 'Sem nome');

/** Aparência de cada motivo de "Próximas ações" (tom do selo + ícone). */
const REASON_STYLE = Object.freeze({
  overdue: { tone: 'danger', icon: 'alert-circle' },
  due_today: { tone: 'warning', icon: 'calendar' },
  due_soon: { tone: 'warning', icon: 'calendar' },
  due_week: { tone: 'neutral', icon: 'calendar' },
  p1: { tone: 'neutral', icon: 'signal-4' },
  p2: { tone: 'neutral', icon: 'signal-3' },
  in_progress: { tone: 'blue', icon: 'circle-half' },
  in_review: { tone: 'violet', icon: 'eye' },
  unblocks: { tone: 'info', icon: 'git-branch' },
  unblocks_urgent: { tone: 'info', icon: 'zap' },
  waiting: { tone: 'amber', icon: 'hourglass' },
  blocked: { tone: 'red', icon: 'ban' },
  blocked_by_dependency: { tone: 'red', icon: 'lock' },
  demand_priority: { tone: 'neutral', icon: 'layers' },
});

// ---------------------------------------------------------------------------
// Estado da tela (recolhidas / "ver todas")
// ---------------------------------------------------------------------------

/** A seção está recolhida? */
export function isCollapsed(ctx, id) {
  const map = ctx.state.collapsed;
  return !!(map && typeof map === 'object' && map[id]);
}

/** A lista da seção está expandida ("ver todas")? */
export function isExpanded(ctx, id) {
  const map = ctx.state.expanded;
  return !!(map && typeof map === 'object' && map[id]);
}

function toggleFlag(ctx, field, id, value) {
  ctx.setState((prev) => {
    const current = prev[field] && typeof prev[field] === 'object' ? prev[field] : {};
    const next = { ...current };
    const on = value === undefined ? !next[id] : !!value;
    if (on) next[id] = true;
    else delete next[id];
    return { [field]: next };
  });
}

export const setCollapsed = (ctx, id, value) => toggleFlag(ctx, 'collapsed', id, value);
export const setExpanded = (ctx, id, value) => toggleFlag(ctx, 'expanded', id, value);

// ---------------------------------------------------------------------------
// Cartão de seção
// ---------------------------------------------------------------------------

/**
 * Cartão de seção recolhível (estado salvo em ctx.state.collapsed).
 * @param {object} ctx
 * @param {{ id: string, title: string, icon?: string, count?: number|null, actions?: Node|Node[], body: Node|Node[],
 *           tone?: string, class?: string }} options
 */
export function sectionCard(ctx, { id, title, icon: glyph, count, actions, body, tone, class: className }) {
  const collapsed = isCollapsed(ctx, id);
  return h(
    'section',
    { class: cx('v-dashboard-card', `v-dashboard-card-${id}`, tone && `is-${tone}`, collapsed && 'is-collapsed', className), key: id, 'data-section': id, 'aria-label': title },
    sectionHeader({
      title,
      icon: glyph,
      count: count === undefined ? null : count,
      collapsed,
      ontoggle: () => setCollapsed(ctx, id, !collapsed),
      actions: collapsed ? null : actions,
      class: 'v-dashboard-card-head',
    }),
    collapsed ? null : h('div', { class: 'v-dashboard-card-body' }, body),
  );
}

/** Rodapé "Ver todas (N)" / "Mostrar menos" de uma lista com limite. */
export function moreToggle(ctx, id, total, cap) {
  if (total <= cap) return null;
  const expanded = isExpanded(ctx, id);
  return h(
    'div',
    { class: 'v-dashboard-more' },
    button({
      label: expanded ? 'Mostrar menos' : `Ver todas (${total})`,
      iconRight: expanded ? 'chevron-up' : 'chevron-down',
      size: 'sm',
      variant: 'ghost',
      attrs: { 'data-action': 'toggle-more', 'aria-expanded': expanded },
      onclick: () => setExpanded(ctx, id, !expanded),
    }),
  );
}

/** Parte visível de uma lista conforme o estado "ver todas". */
export function capped(ctx, id, list, cap, expandedCap = Infinity) {
  return list.slice(0, isExpanded(ctx, id) ? expandedCap : cap);
}

/** Linha calma de "lista vazia": ícone + texto (+ ação opcional). */
export function quiet({ icon: glyph = 'check-circle', text, hint, action, tone = 'muted' }) {
  return h(
    'div',
    { class: cx('v-dashboard-quiet', `is-${tone}`), 'data-empty': 'true' },
    h('span', { class: 'v-dashboard-quiet-icon' }, icon(glyph, { size: 16 })),
    h('span', { class: 'v-dashboard-quiet-text' }, h('span', { class: 'v-dashboard-quiet-title' }, text), hint ? h('span', { class: 'v-dashboard-quiet-hint' }, hint) : null),
    action ? h('span', { class: 'v-dashboard-quiet-action' }, action) : null,
  );
}

// ---------------------------------------------------------------------------
// Linhas
// ---------------------------------------------------------------------------

/**
 * O clique começou num controle dentro da linha? Usa o caminho do evento (calculado no disparo), e não
 * `closest`, porque alguns controles trocam o próprio conteúdo durante o clique (a edição no lugar troca o
 * texto pelo campo) e o alvo original já está fora do documento quando o evento chega à linha.
 */
function hitsControl(ev) {
  const row = ev.currentTarget;
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
  for (const node of path) {
    if (node === row) return false;
    if (node && node.nodeType === 1 && node.matches(INTERACTIVE)) return true;
  }
  const hit = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest(INTERACTIVE) : null;
  return !!hit && hit !== row && row.contains(hit);
}

/** Props comuns de uma linha de entidade: data-entity, foco, clique/Enter abrem o painel. */
function rowProps(app, type, entity, className) {
  const base = entityAttrs(app, type, entity);
  const open = () => entityActions.open(app, type, entity.id);
  return {
    ...base,
    class: cx(className, base.class),
    tabindex: 0,
    onclick: (ev) => {
      if (hitsControl(ev)) return;
      open();
    },
    onkeydown: (ev) => {
      if (ev.target !== ev.currentTarget || (ev.key !== 'Enter' && ev.key !== ' ')) return;
      ev.preventDefault();
      open();
    },
  };
}

function openButton(app, type, id) {
  return iconButton({
    icon: 'panel-right',
    title: 'Abrir',
    size: 'sm',
    class: 'v-dashboard-open',
    attrs: { 'data-action': 'open' },
    onclick: (ev) => {
      ev.stopPropagation();
      entityActions.open(app, type, id);
    },
  });
}

function menuButton(app, type, id) {
  return iconButton({
    icon: 'more-horizontal',
    title: 'Mais ações',
    size: 'sm',
    class: 'v-dashboard-menu',
    onclick: (ev) => {
      ev.stopPropagation();
      openEntityMenu(app, type, id, ev.currentTarget);
    },
  });
}

/** Linha de contexto de uma tarefa: projeto · demanda (ou "Subtarefa de …" / "Sem demanda"). */
export function taskContext(app, task) {
  const parts = [];
  const project = app.sel.projectOf('task', task);
  const demand = app.sel.demandOf(task);
  const parent = app.sel.parentOf(task);
  if (project) parts.push(h('span', { class: 'v-dashboard-ctx-item', key: 'p' }, projectDot(project), h('span', { class: 'truncate' }, project.name)));
  if (demand) {
    parts.push(
      h('span', { class: 'v-dashboard-ctx-item', key: 'd', title: `Demanda: ${demand.name}` }, h('span', { class: 'en-code tabular' }, app.sel.code('demand', demand)), h('span', { class: 'truncate' }, demand.name)),
    );
  }
  if (parent) parts.push(h('span', { class: 'v-dashboard-ctx-item', key: 's', title: `Subtarefa de ${parent.name}` }, icon('tree', { size: 12 }), h('span', { class: 'truncate' }, truncate(nameOf(parent), 40))));
  if (!demand && !parent) parts.push(h('span', { class: 'v-dashboard-ctx-item is-faint', key: 'n' }, icon('inbox', { size: 12 }), h('span', null, 'Sem demanda')));
  return h('span', { class: 'v-dashboard-ctx' }, parts);
}

/** Selo de um motivo de "Próximas ações". */
export function reasonChip(reason) {
  const style = REASON_STYLE[reason.code] || { tone: 'neutral', icon: 'info' };
  return h('span', { class: 'v-dashboard-reason', key: reason.code, 'data-reason': reason.code }, badge(reason.label, { tone: style.tone, icon: style.icon, title: reason.label }));
}

/**
 * Linha de "Próximas ações" (grupo "fazer"): concluir, título, contexto, motivos e ações de um clique
 * (cronômetro, abrir, menu).
 * @param {object} app
 * @param {{ task: object, reasons: Array, score: number }} item
 * @param {number} rank posição (1…)
 */
export function actionRow(app, item, rank) {
  const task = item.task;
  return h(
    'div',
    { ...rowProps(app, 'task', task, 'v-dashboard-action'), 'data-rank': rank, 'data-score': item.score },
    h('span', { class: 'v-dashboard-action-lead' }, checkControl(app, task)),
    h(
      'div',
      { class: 'v-dashboard-action-main' },
      h('div', { class: 'v-dashboard-action-title' }, entityTitle(app, 'task', task)),
      taskContext(app, task),
      item.reasons.length ? h('div', { class: 'v-dashboard-reasons' }, item.reasons.map(reasonChip)) : null,
    ),
    h(
      'div',
      { class: 'v-dashboard-action-side' },
      priorityControl(app, 'task', task, { compact: true }),
      timerControl(app, task, { compact: true }),
      openButton(app, 'task', task.id),
      menuButton(app, 'task', task.id),
    ),
  );
}

/** Botões com os nomes dos pré-requisitos em aberto (abrem o painel de cada um). */
function blockerLinks(app, blockers, max = 3) {
  const shown = blockers.slice(0, max);
  const rest = blockers.length - shown.length;
  return [
    ...shown.map((b) =>
      h(
        'button',
        {
          type: 'button',
          key: b.id,
          class: 'v-dashboard-blocker',
          title: `Abrir ${quoted(nameOf(b))}`,
          'data-blocker': b.id,
          onclick: (ev) => {
            ev.stopPropagation();
            entityActions.open(app, 'task', b.id);
          },
        },
        h('span', { class: 'en-code tabular' }, app.sel.code('task', b)),
        h('span', { class: 'truncate' }, nameOf(b)),
      ),
    ),
    rest > 0 ? h('span', { class: 'v-dashboard-blocker-more tabular', key: 'more' }, `+${rest}`) : null,
  ];
}

/**
 * Linha de item travado (bloqueada, aguardando terceiros ou bloqueada por dependência), dizendo o que está
 * no caminho e oferecendo o atalho certo: informar o motivo, abrir o pré-requisito, trocar o status.
 * @param {object} app
 * @param {object} task
 */
export function stuckRow(app, task) {
  const status = app.sel.status(task.status);
  const category = status.category;
  const blockers = app.sel.blockers(task.id);
  const lines = [];
  if (category === 'blocked' || category === 'waiting') {
    const isBlocked = category === 'blocked';
    const text = isBlocked ? task.blocked_reason : task.waiting_on;
    lines.push(
      h(
        'div',
        { class: cx('v-dashboard-why', isBlocked ? 'is-blocked' : 'is-waiting'), key: 'why' },
        icon(isBlocked ? 'ban' : 'hourglass', { size: 13 }),
        h('span', { class: 'v-dashboard-why-label' }, isBlocked ? 'Impedimento:' : 'Aguardando:'),
        text
          ? h('span', { class: 'v-dashboard-why-text', title: text }, text)
          : h(
              'button',
              {
                type: 'button',
                class: 'v-dashboard-why-ask',
                'data-action': 'ask-reason',
                onclick: (ev) => {
                  ev.stopPropagation();
                  askImpediment(app, 'task', task.id, category, ev.currentTarget);
                },
              },
              isBlocked ? 'informar o motivo' : 'informar de quem',
            ),
      ),
    );
  }
  if (blockers.length) {
    lines.push(h('div', { class: 'v-dashboard-why is-dependency', key: 'dep' }, icon('lock', { size: 13 }), h('span', { class: 'v-dashboard-why-label' }, 'Depende de'), h('span', { class: 'v-dashboard-blockers' }, blockerLinks(app, blockers))));
  }
  return h(
    'div',
    rowProps(app, 'task', task, 'v-dashboard-stuck'),
    h('span', { class: 'v-dashboard-stuck-lead' }, statusControl(app, 'task', task, { compact: true })),
    h('div', { class: 'v-dashboard-stuck-main' }, h('div', { class: 'v-dashboard-action-title' }, entityTitle(app, 'task', task)), lines),
    h('div', { class: 'v-dashboard-stuck-side' }, dueControl(app, 'task', task, { compact: true }), menuButton(app, 'task', task.id)),
  );
}

/**
 * Linha de demanda com progresso, prazo, contagem de tarefas e a próxima ação editável no lugar.
 * @param {object} app
 * @param {{ demand: object, progress: object }} row
 */
export function demandProgressRow(app, { demand, progress }) {
  const counted = progress && Number.isFinite(progress.counted) ? progress.counted : 0;
  const completed = progress && Number.isFinite(progress.completed) ? progress.completed : 0;
  const project = app.sel.project(demand.project_id);
  return h(
    'div',
    rowProps(app, 'demand', demand, 'v-dashboard-demand'),
    h(
      'div',
      { class: 'v-dashboard-demand-top' },
      statusControl(app, 'demand', demand, { compact: true }),
      h('span', { class: 'v-dashboard-demand-title' }, entityTitle(app, 'demand', demand)),
      priorityControl(app, 'demand', demand, { compact: true }),
      dueControl(app, 'demand', demand, { compact: true }),
    ),
    h(
      'div',
      { class: 'v-dashboard-demand-meta' },
      progressControl(app, demand, { compact: false }),
      h('span', { class: 'v-dashboard-demand-count tabular', title: counted ? `${completed} de ${plural(counted, 'tarefa concluída', 'tarefas concluídas')}` : 'Sem tarefas contáveis' }, counted ? `${completed}/${counted} tarefas` : 'sem tarefas'),
      project ? h('span', { class: 'v-dashboard-demand-project', title: `Projeto: ${project.name}` }, projectDot(project), h('span', { class: 'truncate' }, project.name)) : null,
    ),
    h(
      'div',
      { class: 'v-dashboard-next', 'data-stop': true },
      icon('arrow-right', { size: 12, class: 'v-dashboard-next-icon' }),
      inlineEdit({
        value: demand.next_action || '',
        placeholder: 'Definir a próxima ação…',
        allowEmpty: true,
        maxlength: 300,
        ariaLabel: `Próxima ação de ${nameOf(demand)}`,
        class: 'v-dashboard-next-edit',
        onsave: (text) => {
          try {
            app.cmd.updateDemand(demand.id, { next_action: text ? text : null });
          } catch (err) {
            handleError(app, err);
          }
        },
      }),
    ),
  );
}

/** Item compacto (prazos, prioridades da semana): concluir/status, título, contexto curto, prioridade. */
export function miniRow(app, { type, entity }, { showDue = false } = {}) {
  const demand = type === 'task' ? app.sel.demandOf(entity) : null;
  return h(
    'div',
    { ...rowProps(app, type, entity, cx('v-dashboard-mini', `is-${type}`)) },
    h('span', { class: 'v-dashboard-mini-lead' }, type === 'task' ? checkControl(app, entity, { size: 'sm' }) : statusControl(app, 'demand', entity, { compact: true })),
    h(
      'span',
      { class: 'v-dashboard-mini-main' },
      entityTitle(app, type, entity),
      type === 'demand'
        ? h('span', { class: 'v-dashboard-mini-sub' }, icon('layers', { size: 11 }), 'Demanda')
        : demand
          ? h('span', { class: 'v-dashboard-mini-sub', title: demand.name }, h('span', { class: 'truncate' }, demand.name))
          : null,
    ),
    showDue ? dueControl(app, type, entity, { compact: true }) : null,
    priorityControl(app, type, entity, { compact: true }),
  );
}

// ---------------------------------------------------------------------------
// Sugestões de prioridade
// ---------------------------------------------------------------------------

/**
 * Cartão de sugestão: "Sugestão: elevar “X” para P1" + justificativa, com Aplicar / Dispensar.
 * O sistema nunca muda a prioridade sozinho: só o clique em Aplicar grava (cmd.applySuggestion).
 */
export function suggestionCard(app, suggestion) {
  const task = app.sel.task(suggestion.taskId);
  if (!task) return null;
  const raise = suggestion.direction !== 'lower';
  const apply = () => {
    const previous = task.priority || 'P3';
    try {
      app.cmd.applySuggestion(suggestion);
    } catch (err) {
      handleError(app, err);
      return;
    }
    notify(app, `Prioridade de ${quoted(truncate(nameOf(task), 40))} alterada para ${suggestion.suggested}`, {
      tone: 'success',
      action: {
        label: 'Desfazer',
        onclick: () => {
          try {
            app.cmd.setPriority('task', task.id, previous);
          } catch (err) {
            handleError(app, err);
          }
        },
      },
    });
  };
  const dismiss = () => {
    try {
      app.cmd.dismissSuggestion(suggestion.signature);
    } catch (err) {
      handleError(app, err);
      return;
    }
    notify(app, 'Sugestão dispensada', {
      action: {
        label: 'Desfazer',
        onclick: () => {
          try {
            const list = app.settings.get('suggestions.dismissed');
            const next = Array.isArray(list) ? list.filter((s) => s !== suggestion.signature) : [];
            app.cmd.setSetting('suggestions.dismissed', next);
          } catch (err) {
            handleError(app, err);
          }
        },
      },
    });
  };
  return h(
    'div',
    { ...entityAttrs(app, 'task', task), class: cx('v-dashboard-suggestion', raise ? 'is-raise' : 'is-lower'), key: suggestion.signature, 'data-suggestion': suggestion.taskId },
    h('span', { class: 'v-dashboard-suggestion-icon' }, icon('sparkles', { size: 14 })),
    h(
      'div',
      { class: 'v-dashboard-suggestion-main' },
      h(
        'div',
        { class: 'v-dashboard-suggestion-title' },
        h('span', null, `Sugestão: ${raise ? 'elevar' : 'reduzir'} `),
        h(
          'button',
          {
            type: 'button',
            class: 'v-dashboard-suggestion-task',
            title: `Abrir ${quoted(nameOf(task))}`,
            onclick: () => entityActions.open(app, 'task', task.id),
          },
          quoted(nameOf(task)),
        ),
        h('span', null, ' para '),
        priorityBadge(suggestion.suggested, { class: 'v-dashboard-suggestion-prio' }),
      ),
      h('div', { class: 'v-dashboard-suggestion-why' }, suggestion.justification || ''),
      h(
        'div',
        { class: 'v-dashboard-suggestion-actions' },
        button({ label: 'Aplicar', size: 'sm', variant: 'primary', attrs: { 'data-action': 'apply-suggestion' }, onclick: apply }),
        button({ label: 'Dispensar', size: 'sm', variant: 'ghost', attrs: { 'data-action': 'dismiss-suggestion' }, onclick: dismiss }),
        h('span', { class: 'v-dashboard-suggestion-from tabular', title: 'Prioridade atual' }, `atual: ${suggestion.current}`),
      ),
    ),
  );
}
