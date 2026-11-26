// "Minha Semana" — peças das linhas: marcadores (planejada, adicionada, transferida, desfecho), linha de tarefa
// da semana (taskRow + ações do plano), botões de planejamento e a seção recolhível.

import { cx, h } from '../../../core/dom.js';
import { addDays, formatDate, isoToDateStr } from '../../../core/dates.js';
import { WEEK_KIND, WEEK_OUTCOME, WEEK_OUTCOME_LABELS } from '../../../domain/weekplan.js';
import { button, iconButton } from '../../kit/controls.js';
import { badge, sectionHeader } from '../../kit/display.js';
import { taskRow } from '../../shared/entity.js';
import { addTaskToWeek, dayText, openPlanMenu } from './dialogs.js';
import { weekLabel } from './model.js';

/** Tom do selo de cada desfecho (semanas passadas). */
const OUTCOME_TONES = Object.freeze({
  [WEEK_OUTCOME.DONE]: 'success',
  [WEEK_OUTCOME.OPEN]: 'warning',
  [WEEK_OUTCOME.CARRIED]: 'info',
  [WEEK_OUTCOME.REMOVED]: 'gray',
  [WEEK_OUTCOME.CANCELLED]: 'gray',
  [WEEK_OUTCOME.MISSING]: 'gray',
});

const OUTCOME_ICONS = Object.freeze({
  [WEEK_OUTCOME.DONE]: 'check',
  [WEEK_OUTCOME.OPEN]: 'circle-dashed',
  [WEEK_OUTCOME.CARRIED]: 'arrow-right',
  [WEEK_OUTCOME.REMOVED]: 'minus',
  [WEEK_OUTCOME.CANCELLED]: 'x',
  [WEEK_OUTCOME.MISSING]: 'trash',
});

// ---------------------------------------------------------------------------
// Peças pequenas
// ---------------------------------------------------------------------------

/** Selo pequeno (marcador) das linhas. */
export function mark(text, { tone = 'neutral', glyph, title } = {}) {
  return badge(text, { tone, icon: glyph, title: title || text, class: 'v-semana-mark' });
}

/** Rótulo da semana de origem de um item transferido. */
function carriedFromText(app, item, week) {
  const source = item.carried_from_id ? app.store.get('week_items', item.carried_from_id) : null;
  if (!source || !source.week_start) return 'Veio da semana anterior';
  return source.week_start >= addDays(week, -7) ? 'Veio da semana anterior' : `Veio da semana de ${formatDate(source.week_start, 'short', app.clock.today())}`;
}

/**
 * Para onde foi um item retirado do plano quando a retirada fez parte de um "mover para outra semana"
 * (mesmo instante da inclusão na outra semana). null quando foi só retirado.
 */
function movedTo(app, item) {
  if (!item.removed_at) return null;
  for (const other of app.store.byIndex('week_items', 'task_id', item.task_id)) {
    if (other.id === item.id || other.deleted_at || other.week_start === item.week_start) continue;
    if (other.added_at === item.removed_at) return other.week_start;
  }
  return null;
}

/** Marcadores de um item do plano: tipo, origem e destino. */
export function planMarks(app, row, week, { history = false } = {}) {
  if (!row) return [];
  const { item } = row;
  const today = app.clock.today();
  const out = [];
  if (history) {
    let text = WEEK_OUTCOME_LABELS[row.outcome] || row.outcome;
    let title = text;
    if (row.outcome === WEEK_OUTCOME.CARRIED && item.carried_to_week) {
      text = `Transferida para ${formatDate(item.carried_to_week, 'short', today)}`;
      title = `Não concluída — transferida para a semana de ${weekLabel(item.carried_to_week)}`;
    } else if (row.outcome === WEEK_OUTCOME.REMOVED) {
      const target = movedTo(app, item);
      if (target) {
        text = `Movida para ${formatDate(target, 'short', today)}`;
        title = `Retirada deste plano e replanejada para a semana de ${weekLabel(target)}`;
      }
    } else if (row.outcome === WEEK_OUTCOME.DONE && row.completedAt) {
      title = `Concluída em ${dayText(app, isoToDateStr(row.completedAt))}`;
    }
    out.push(mark(text, { tone: OUTCOME_TONES[row.outcome] || 'neutral', glyph: OUTCOME_ICONS[row.outcome], title }));
  } else if (item.carried_to_week && item.carried_to_week !== week) {
    out.push(mark(`Transferida para ${formatDate(item.carried_to_week, 'short', today)}`, { tone: 'info', glyph: 'arrow-right', title: `Transferida para a semana de ${weekLabel(item.carried_to_week)}` }));
  }
  if (row.kind === WEEK_KIND.ADDED) out.push(mark('Adicionada na semana', { tone: 'violet', glyph: 'plus', title: 'Adicionada durante a semana' }));
  else out.push(h('span', { class: 'v-semana-kind', title: 'Planejada no início da semana' }, 'Planejada'));
  if (item.carried_from_id) out.push(mark(carriedFromText(app, item, week), { tone: 'neutral', glyph: 'rotate-ccw' }));
  return out;
}

/** Coluna sob medida de taskRow (só entra quando há conteúdo). */
const column = (nodes, className) => (nodes && (!Array.isArray(nodes) || nodes.length) ? () => h('span', { class: cx('v-semana-col', className) }, nodes) : null);

/**
 * Linha de tarefa da semana: a linha padrão (taskRow) com marcadores e as ações da semana.
 * @param {object} app
 * @param {object} task
 * @param {{ marks?: Node[], action?: Node|null, timer?: boolean, compactStatus?: boolean, class?: string }} options
 */
export function weekRow(app, task, { marks = [], action = null, timer = false, compactStatus = false, class: className } = {}) {
  const columns = ['check', 'title', column(marks, 'v-semana-marks'), 'flags', compactStatus ? 'status-compact' : 'status', 'priority', 'due', timer ? 'timer' : null, column(action, 'v-semana-act'), 'menu'].filter(Boolean);
  return taskRow(app, task, { columns, showDemand: true, class: cx('v-semana-row', className) });
}

/** Botão de planejamento (mover / escolher semana / retirar) de um item do plano. */
export function planButton(app, item, week) {
  return iconButton({
    icon: 'calendar-week',
    title: 'Planejamento: mover ou remover do plano',
    size: 'sm',
    class: 'v-semana-plan-btn',
    onclick: (ev) => {
      ev.stopPropagation();
      openPlanMenu(app, ev.currentTarget, item, week);
    },
  });
}

/** Botão "Adicionar à semana" (tarefa fora do plano). */
export function addButton(app, task, week, { labelled = false } = {}) {
  const onclick = (ev) => {
    ev.stopPropagation();
    addTaskToWeek(app, task.id, week);
  };
  return labelled
    ? button({ label: 'Adicionar à semana', icon: 'plus', size: 'sm', variant: 'ghost', class: 'v-semana-add-btn', onclick })
    : iconButton({ icon: 'plus', title: 'Adicionar à semana', size: 'sm', class: 'v-semana-add-btn', onclick });
}

/**
 * Seção recolhível com contagem.
 * @param {object} ctx
 * @param {{ id: string, title: string, icon: string, count: number, body: Node|Node[], empty?: string, desc?: string,
 *           actions?: Node|Node[], tone?: string, footer?: Node|Node[]|null }} options
 *        footer: abaixo da lista (ex.: "Ver todas as N"), só com a seção aberta e com itens
 */
export function weekSection(ctx, { id, title, icon: glyph, count, body, empty, desc, actions, tone, footer = null }) {
  const collapsedMap = ctx.state.collapsed && typeof ctx.state.collapsed === 'object' ? ctx.state.collapsed : {};
  const collapsed = !!collapsedMap[id];
  return h(
    'section',
    { class: cx('v-semana-section', tone && `is-${tone}`, collapsed && 'is-collapsed', !count && 'is-empty'), key: `section-${id}`, 'data-section': id, 'aria-label': title },
    sectionHeader({
      title,
      count,
      icon: glyph,
      collapsed,
      actions,
      class: 'v-semana-section-head',
      ontoggle: () =>
        ctx.setState((prev) => {
          const map = prev.collapsed && typeof prev.collapsed === 'object' ? prev.collapsed : {};
          return { collapsed: { ...map, [id]: !map[id] } };
        }),
    }),
    collapsed
      ? null
      : h(
          'div',
          { class: 'v-semana-section-body' },
          desc ? h('p', { class: 'v-semana-desc' }, desc) : null,
          count ? h('div', { class: 'v-semana-list' }, body) : h('p', { class: 'v-semana-none' }, empty || 'Nada por aqui.'),
          count && footer ? h('div', { class: 'v-semana-more' }, footer) : null,
        ),
  );
}
