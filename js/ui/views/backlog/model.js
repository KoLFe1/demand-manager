// Backlog — derivação dos dados da tela (sem DOM): quais itens estão no backlog, estado normalizado da tela,
// agrupamento, ordenação, "lentes" de refinamento e o resumo para o grooming.
//
// Tudo aqui é função pura do app (seletores memorizados) + estado da tela. Os resultados caros (lista do
// backlog, ordem das demandas) ficam em WeakMap presos à identidade das listas devolvidas pelos seletores,
// que só mudam quando o banco muda — assim um novo desenho sem mudança de dados não refaz o trabalho.

import { diffDays, isoToDateStr } from '../../../core/dates.js';
import { PRIORITIES } from '../../../domain/priorities.js';
import { firstOfCategory } from '../../../domain/statuses.js';
import { normalizeFilters, sortViewItems } from '../../shared/filterbar.js';

/** Itens registrados há mais que isto (dias) ganham destaque. */
export const OLD_DAYS = 30;

/** Agrupamentos possíveis por modo. */
export const TASK_GROUPS = Object.freeze(['demand', 'project', 'priority', 'none']);
export const DEMAND_GROUPS = Object.freeze(['project', 'priority', 'none']);

/** Rótulos dos agrupamentos. */
export const GROUP_LABELS = Object.freeze({ demand: 'Demanda', project: 'Projeto', priority: 'Prioridade', none: 'Sem agrupamento' });

/** Ordenações oferecidas (dentro de cada grupo). */
export const SORTS = Object.freeze([
  Object.freeze({ key: 'manual', label: 'Ordem manual', short: 'Manual' }),
  Object.freeze({ key: 'priority', label: 'Prioridade', short: 'Prioridade' }),
  Object.freeze({ key: 'due', label: 'Prazo', short: 'Prazo' }),
  Object.freeze({ key: 'age', label: 'Idade (mais antigas primeiro)', short: 'Idade' }),
]);
const SORT_KEYS = new Set(SORTS.map((s) => s.key));

/** Lentes de refinamento (atalhos do resumo). */
export const LENSES = Object.freeze(['no_estimate', 'unreviewed', 'orphan', 'old']);

const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

// ---------------------------------------------------------------------------
// Estado da tela
// ---------------------------------------------------------------------------

/**
 * Estado da tela a partir do que foi salvo (qualquer formato): só chaves conhecidas, com tipo válido.
 * @param {object|null} raw ctx.state
 * @returns {{ mode: 'tasks'|'demands', group: string, demandGroup: string, sort: string, filters: object,
 *             lens: string|null, collapsed: Record<string, boolean>, selected: string[], anchorId: string|null,
 *             quickDemandId: string|null, addingIn: string|null }}
 */
export function normalizeState(raw) {
  const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const collapsed = {};
  if (s.collapsed && typeof s.collapsed === 'object' && !Array.isArray(s.collapsed)) {
    for (const [key, value] of Object.entries(s.collapsed)) if (value === true) collapsed[key] = true;
  }
  return {
    mode: s.mode === 'demands' ? 'demands' : 'tasks',
    group: TASK_GROUPS.includes(s.group) ? s.group : 'demand',
    demandGroup: DEMAND_GROUPS.includes(s.demandGroup) ? s.demandGroup : 'project',
    sort: SORT_KEYS.has(s.sort) ? s.sort : 'manual',
    filters: normalizeFilters(s.filters),
    lens: LENSES.includes(s.lens) ? s.lens : null,
    collapsed,
    selected: Array.isArray(s.selected) ? [...new Set(s.selected.filter((id) => typeof id === 'string' && id))] : [],
    anchorId: typeof s.anchorId === 'string' && s.anchorId ? s.anchorId : null,
    quickDemandId: typeof s.quickDemandId === 'string' && s.quickDemandId ? s.quickDemandId : null,
    addingIn: typeof s.addingIn === 'string' && s.addingIn ? s.addingIn : null,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Id do primeiro status de uma categoria ('backlog', 'planned', 'cancelled'…), ou null. */
export function statusIdOf(app, category) {
  const found = firstOfCategory(app.sel.statuses(), category);
  return found ? found.id : null;
}

/** A entidade está no backlog (categoria do status = 'backlog')? */
export function isBacklog(app, entity) {
  return !!entity && app.sel.status(entity.status).category === 'backlog';
}

// ---------------------------------------------------------------------------
// Itens do backlog
// ---------------------------------------------------------------------------

const taskCache = new WeakMap();
const demandCache = new WeakMap();

/**
 * Tarefas no backlog (visíveis, não arquivadas). Subtarefa cuja tarefa principal também está no backlog
 * não aparece em separado: ela vai junto com a principal.
 * @param {object} app
 * @returns {ReadonlyArray<object>}
 */
export function backlogTasks(app) {
  const list = app.sel.tasks();
  const statuses = app.sel.statuses();
  const cached = taskCache.get(list);
  if (cached && cached.statuses === statuses) return cached.items;
  const items = [];
  for (const task of list) {
    if (!isBacklog(app, task)) continue;
    const parent = app.sel.parentOf(task);
    if (parent && isBacklog(app, parent)) continue;
    items.push(task);
  }
  const frozen = Object.freeze(items);
  taskCache.set(list, { statuses, items: frozen });
  return frozen;
}

/**
 * Demandas no backlog (não arquivadas).
 * @param {object} app
 * @returns {ReadonlyArray<object>}
 */
export function backlogDemands(app) {
  const list = app.sel.demands();
  const statuses = app.sel.statuses();
  const cached = demandCache.get(list);
  if (cached && cached.statuses === statuses) return cached.items;
  const items = Object.freeze(list.filter((d) => isBacklog(app, d)));
  demandCache.set(list, { statuses, items });
  return items;
}

/** Projeto do escopo global (app.ui.scope.projectId) ou null. */
export function scopeProjectId(app) {
  try {
    const id = app.ui && app.ui.scope ? app.ui.scope.projectId : null;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** Itens do backlog respeitando o escopo global de projeto. */
export function scopedItems(app, type) {
  const list = type === 'demand' ? backlogDemands(app) : backlogTasks(app);
  const scope = scopeProjectId(app);
  if (!scope) return list;
  return list.filter((item) => app.sel.projectIdOf(type, item) === scope);
}

/** Número de tarefas no backlog (selo da navegação), respeitando o escopo de projeto. */
export function backlogBadge(app) {
  return scopedItems(app, 'task').length;
}

// ---------------------------------------------------------------------------
// Medidas de cada item
// ---------------------------------------------------------------------------

/** Dias desde a criação (0 = hoje). */
export function ageDays(app, entity) {
  const created = isoToDateStr(entity && entity.created_at);
  const days = created ? diffDays(created, app.clock.today()) : null;
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/** "hoje", "1 dia", "12 dias". */
export function ageText(days) {
  if (!days) return 'hoje';
  return days === 1 ? '1 dia' : `${days} dias`;
}

/** Prioridade ainda no padrão (P3) e nunca revisada (sem evento de troca de prioridade no histórico). */
export function isUnreviewed(app, type, entity) {
  if (!entity || (entity.priority || 'P3') !== 'P3') return false;
  return !app.sel.history(type, entity.id).some((ev) => ev.action === 'priority_changed');
}

/** Sem demanda (tarefa) / sem projeto (demanda). */
export function isOrphan(app, type, entity) {
  if (type === 'demand') return !app.sel.project(entity.project_id);
  return !app.sel.demandOf(entity);
}

const hasEstimate = (entity) => Number.isFinite(entity.estimate_minutes) && entity.estimate_minutes > 0;

/** Aplica uma lente de refinamento (null = todos). */
export function applyLens(app, items, lens, type) {
  switch (lens) {
    case 'no_estimate':
      return items.filter((item) => !hasEstimate(item));
    case 'unreviewed':
      return items.filter((item) => isUnreviewed(app, type, item));
    case 'orphan':
      return items.filter((item) => isOrphan(app, type, item));
    case 'old':
      return items.filter((item) => ageDays(app, item) > OLD_DAYS);
    default:
      return items;
  }
}

/**
 * Resumo para o grooming.
 * @returns {{ count: number, estimateMinutes: number, estimated: number, noEstimate: number, unreviewed: number,
 *             orphan: number, old: number, oldest: { entity: object, days: number }|null }}
 */
export function computeStats(app, items, type) {
  const stats = { count: items.length, estimateMinutes: 0, estimated: 0, noEstimate: 0, unreviewed: 0, orphan: 0, old: 0, oldest: null };
  for (const item of items) {
    if (hasEstimate(item)) {
      stats.estimateMinutes += item.estimate_minutes;
      stats.estimated += 1;
    } else stats.noEstimate += 1;
    if (isUnreviewed(app, type, item)) stats.unreviewed += 1;
    if (isOrphan(app, type, item)) stats.orphan += 1;
    const days = ageDays(app, item);
    if (days > OLD_DAYS) stats.old += 1;
    if (!stats.oldest || days > stats.oldest.days) stats.oldest = { entity: item, days };
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Ordenação e grupos
// ---------------------------------------------------------------------------

const demandOrderCache = new WeakMap();

/** Posição de cada demanda na ordem manual (as sem demanda vão para o fim). */
function demandOrder(app) {
  const list = app.sel.demands({ includeArchived: true });
  let map = demandOrderCache.get(list);
  if (!map) {
    map = new Map(list.map((d, index) => [d.id, index]));
    demandOrderCache.set(list, map);
  }
  return map;
}

/**
 * Ordena os itens de um grupo.
 *   manual   — ordem manual (tarefas: ordem da demanda, depois a ordem dentro dela; subtarefas no fim);
 *   priority — P1 primeiro; due — prazo mais próximo; age — mais antigas primeiro.
 */
export function sortGroupItems(app, items, sort, type) {
  if (sort === 'priority') return sortViewItems(app, items, { key: 'priority', dir: 'asc' }, type);
  if (sort === 'due') return sortViewItems(app, items, { key: 'due_date', dir: 'asc' }, type);
  if (sort === 'age') return sortViewItems(app, items, { key: 'created_at', dir: 'asc' }, type);
  if (type === 'demand') return sortViewItems(app, items, { key: 'manual', dir: 'asc' }, 'demand');
  const order = demandOrder(app);
  const keyed = items.map((task, index) => {
    const demand = app.sel.demandOf(task);
    const sub = app.sel.parentOf(task) ? 1 : 0;
    return { task, index, d: demand && order.has(demand.id) ? order.get(demand.id) : Number.MAX_SAFE_INTEGER, sub, o: finite(task.sort_order) };
  });
  keyed.sort((a, b) => a.d - b.d || a.sub - b.sub || a.o - b.o || String(a.task.created_at || '').localeCompare(String(b.task.created_at || '')) || a.index - b.index);
  return keyed.map((k) => k.task);
}

/**
 * Agrupa e ordena.
 * @param {object} app
 * @param {object[]} items
 * @param {'demand'|'project'|'priority'|'none'} group
 * @param {'task'|'demand'} type
 * @param {string} sort
 * @returns {Array<{ key: string, kind: string, id: string|null, demand?: object|null, project?: object|null,
 *                   priority?: string, items: object[] }>}
 */
export function buildGroups(app, items, group, type, sort) {
  if (group === 'none') return [{ key: 'all', kind: 'none', id: null, items: sortGroupItems(app, items, sort, type) }];
  const buckets = new Map();
  const push = (key, make, item) => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, ...make(), items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(item);
  };
  for (const item of items) {
    if (group === 'demand' && type === 'task') {
      const demand = app.sel.demandOf(item);
      push(`d:${demand ? demand.id : ''}`, () => ({ kind: 'demand', id: demand ? demand.id : null, demand }), item);
    } else if (group === 'priority') {
      const p = PRIORITIES.some((x) => x.id === item.priority) ? item.priority : 'P3';
      push(`pr:${p}`, () => ({ kind: 'priority', id: p, priority: p }), item);
    } else {
      const project = app.sel.projectOf(type, item);
      push(`p:${project ? project.id : ''}`, () => ({ kind: 'project', id: project ? project.id : null, project }), item);
    }
  }
  const list = [...buckets.values()];
  for (const bucket of list) bucket.items = sortGroupItems(app, bucket.items, sort, type);
  // ordem dos grupos
  if (group === 'priority') {
    list.sort((a, b) => a.id.localeCompare(b.id));
  } else if (group === 'demand' && type === 'task') {
    const order = demandOrder(app);
    const pos = (g) => (g.id && order.has(g.id) ? order.get(g.id) : Number.MAX_SAFE_INTEGER);
    list.sort((a, b) => pos(a) - pos(b));
  } else {
    const projects = app.sel.projects({ includeArchived: true });
    const index = new Map(projects.map((p, i) => [p.id, i]));
    const pos = (g) => (g.id && index.has(g.id) ? index.get(g.id) : Number.MAX_SAFE_INTEGER);
    list.sort((a, b) => pos(a) - pos(b));
  }
  return list;
}

/** Soma das estimativas (minutos) de uma lista. */
export function sumEstimate(items) {
  let total = 0;
  for (const item of items) if (hasEstimate(item)) total += item.estimate_minutes;
  return total;
}

/** Ids na ordem em que aparecem (para seleção por intervalo e reordenar pelo teclado). */
export function orderedIds(groups, collapsed) {
  const ids = [];
  for (const group of groups) {
    if (collapsed && collapsed[group.key]) continue;
    for (const item of group.items) ids.push(item.id);
  }
  return ids;
}
