// Alertas de prazo (especificação, seção 7): sino na barra superior com a contagem (vencidas + vencem hoje)
// e um popover com quatro grupos — Vencidas, Vencem hoje, Próximos 3 dias, Próximos 7 dias.
//
//   alertsButton(app)          → botão do sino (pura renderização; pode ser chamado a cada render)
//   openAlerts(app, anchor)    → abre o popover (cada linha abre o item no painel lateral)
//   alertCounts(app)           → { overdue, today, next3, next7, urgent }

import { cx, h } from '../core/dom.js';
import { formatDate, relativeDay } from '../core/dates.js';
import { countBadge, emptyState } from './kit/display.js';
import { icon } from './kit/icons.js';
import { openPopover } from './kit/overlays.js';
import { projectDot } from './projects.js';

/** Grupos do popover, na ordem em que aparecem. */
export const ALERT_GROUPS = Object.freeze([
  Object.freeze({ key: 'overdue', label: 'Vencidas', tone: 'danger', icon: 'alert-circle' }),
  Object.freeze({ key: 'today', label: 'Vencem hoje', tone: 'warning', icon: 'clock' }),
  Object.freeze({ key: 'next3', label: 'Próximos 3 dias', tone: 'info', icon: 'calendar' }),
  Object.freeze({ key: 'next7', label: 'Próximos 7 dias', tone: 'neutral', icon: 'calendar-week' }),
]);

const GROUP_LIMIT = 30;

/** Faixas de vencimento respeitando o filtro global de projeto (app.ui.scope). */
function scopedBuckets(app) {
  let buckets;
  try {
    buckets = app.sel.dueBuckets();
  } catch (err) {
    console.error('[alertas] falha ao calcular os vencimentos', err);
    return { overdue: [], today: [], next3: [], next7: [] };
  }
  const projectId = app.ui && app.ui.scope ? app.ui.scope.projectId : null;
  const out = {};
  for (const group of ALERT_GROUPS) {
    const list = Array.isArray(buckets[group.key]) ? buckets[group.key] : [];
    out[group.key] = projectId ? list.filter((item) => item && item.entity && app.sel.projectIdOf(item.type, item.entity) === projectId) : list;
  }
  return out;
}

/**
 * Contagens dos alertas de prazo (com o filtro de projeto aplicado).
 * @param {object} app
 * @returns {{ overdue: number, today: number, next3: number, next7: number, urgent: number }} urgent = vencidas + hoje
 */
export function alertCounts(app) {
  const b = scopedBuckets(app);
  const counts = { overdue: b.overdue.length, today: b.today.length, next3: b.next3.length, next7: b.next7.length };
  return { ...counts, urgent: counts.overdue + counts.today };
}

/**
 * Botão do sino com a contagem de vencidas + vencem hoje.
 * @param {object} app
 * @returns {HTMLButtonElement}
 */
export function alertsButton(app) {
  const counts = alertCounts(app);
  const label =
    counts.urgent > 0
      ? `Alertas de prazo: ${counts.overdue} ${counts.overdue === 1 ? 'vencida' : 'vencidas'}, ${counts.today} ${counts.today === 1 ? 'vence' : 'vencem'} hoje`
      : 'Alertas de prazo';
  return h(
    'button',
    {
      type: 'button',
      class: cx('btn', 'btn-icon', 'btn-ghost', 'shell-bell', counts.overdue > 0 && 'has-overdue'),
      title: label,
      'aria-label': label,
      'data-alerts': 'true',
      onclick: (ev) => openAlerts(app, ev.currentTarget),
    },
    icon('bell', { size: 16 }),
    countBadge(counts.urgent, { tone: counts.overdue > 0 ? 'danger' : 'warning', max: 99, class: 'shell-bell-count' }),
  );
}

function entityName(entity) {
  return entity && typeof entity.name === 'string' && entity.name.trim() ? entity.name.trim() : 'Sem nome';
}

function whenText(app, entity) {
  const today = app.clock.today();
  const due = entity && entity.due_date;
  if (!due) return '';
  const rel = relativeDay(due, today);
  return rel === 'hoje' || rel === 'amanhã' || rel === 'ontem' ? `${rel} · ${formatDate(due, 'short', today)}` : `${formatDate(due, 'short', today)} · ${rel}`;
}

function alertRow(app, item, close) {
  const { type, entity } = item;
  const projectId = app.sel.projectIdOf(type, entity);
  const project = projectId ? app.sel.project(projectId) : null;
  const code = app.sel.code(type, entity);
  return h(
    'button',
    {
      type: 'button',
      key: `${type}:${entity.id}`,
      class: 'alerts-row',
      'data-entity': `${type}:${entity.id}`,
      onclick: () => {
        close('select');
        if (app.ui) app.ui.openPanel(type, entity.id);
      },
    },
    h('span', { class: 'alerts-type', title: type === 'demand' ? 'Demanda' : 'Tarefa' }, icon(type === 'demand' ? 'layers' : 'circle', { size: 14 })),
    h(
      'span',
      { class: 'alerts-main' },
      h('span', { class: 'alerts-name truncate' }, code ? h('span', { class: 'alerts-code tabular' }, code) : null, entityName(entity)),
      h(
        'span',
        { class: 'alerts-meta truncate' },
        project ? h('span', { class: 'alerts-project' }, projectDot(project, { size: 6 }), project.name) : null,
        h('span', { class: 'alerts-when tabular' }, whenText(app, entity)),
      ),
    ),
  );
}

function renderAlerts(app, close, state) {
  const buckets = scopedBuckets(app);
  const total = ALERT_GROUPS.reduce((n, g) => n + buckets[g.key].length, 0);
  return h(
    'div',
    { class: 'alerts', 'data-alerts-popover': 'true' },
    h('div', { class: 'alerts-head' }, h('span', { class: 'alerts-title' }, 'Alertas de prazo'), app.ui && app.ui.scope && app.ui.scope.projectId ? h('span', { class: 'alerts-scope' }, 'projeto filtrado') : null),
    total === 0
      ? emptyState({ icon: 'check-circle', title: 'Nenhum prazo pedindo atenção', text: 'Nada vencido nem vencendo nos próximos 7 dias.', compact: true })
      : h(
          'div',
          { class: 'alerts-groups' },
          ALERT_GROUPS.map((group) => {
            const list = buckets[group.key];
            if (list.length === 0) return null;
            const expanded = !!state.expanded[group.key];
            const shown = expanded ? list : list.slice(0, GROUP_LIMIT);
            return h(
              'section',
              { key: group.key, class: cx('alerts-group', `alerts-${group.tone}`), 'data-group': group.key },
              h('div', { class: 'alerts-group-head' }, icon(group.icon, { size: 14 }), h('span', null, group.label), h('span', { class: 'alerts-count tabular' }, String(list.length))),
              shown.map((item) => alertRow(app, item, close)),
              list.length > shown.length
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'alerts-more',
                      onclick: () => {
                        state.expanded[group.key] = true;
                        state.refresh();
                      },
                    },
                    `Mostrar mais ${list.length - shown.length}`,
                  )
                : null,
            );
          }),
        ),
  );
}

/**
 * Abre o popover dos alertas de prazo ancorado em `anchor`.
 * @param {object} app
 * @param {Element|{ x: number, y: number }} anchor
 * @returns {{ close: Function, update: Function }} controle do popover
 */
export function openAlerts(app, anchor) {
  const state = { expanded: {}, refresh: () => {} };
  const pop = openPopover(anchor, (close) => renderAlerts(app, close, state), {
    placement: 'bottom-end',
    width: 380,
    class: 'alerts-popover',
    ariaLabel: 'Alertas de prazo',
  });
  state.refresh = () => pop.update();
  return pop;
}
