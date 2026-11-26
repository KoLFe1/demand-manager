// Dados da tela "Início" (painel operacional, seção 12 do pedido).
//
//   const data = dashboardData(app);   // tudo o que a tela mostra, já filtrado pelo escopo de projeto
//
// Só LEITURA: junta os seletores memorizados (app.sel) e recorta pelo escopo global de projeto
// (app.ui.scope.projectId). O resultado fica em cache enquanto o banco, o dia e o escopo não mudam — trocar
// o estado da tela (recolher uma seção, "ver todas") não refaz nenhuma conta. Tudo é O(n) nas tarefas.

import { addDays, diffDays, startOfWeek } from '../../../core/dates.js';
import { priorityRank } from '../../../domain/priorities.js';
import { isInFlightCategory } from '../../../domain/statuses.js';

/** Quantos dias à frente entram em "Próximos prazos" (hoje + 7). */
export const UPCOMING_DAYS = 7;

const NAME_COLLATOR = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const EMPTY = Object.freeze([]);

/** Projeto do escopo global ou null. Tolera app.ui ausente (testes de unidade). */
export function scopeOf(app) {
  try {
    const id = app.ui && app.ui.scope ? app.ui.scope.projectId : null;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** Ordem padrão das listas de tarefas: prioridade → prazo (vazios por último) → nome → id. */
export function compareTasks(a, b) {
  return (
    priorityRank(a.priority) - priorityRank(b.priority) ||
    compareDue(a.due_date, b.due_date) ||
    NAME_COLLATOR.compare(String(a.name || ''), String(b.name || '')) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function compareDue(a, b) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}

/** Itens {type, entity}: prazo → demandas antes de tarefas → prioridade → nome. */
function compareItems(a, b) {
  return (
    compareDue(a.entity.due_date, b.entity.due_date) ||
    (a.type === b.type ? 0 : a.type === 'demand' ? -1 : 1) ||
    compareTasks(a.entity, b.entity)
  );
}

const cache = new WeakMap();

/**
 * Tudo o que a tela "Início" mostra.
 * @param {object} app
 * @returns {object} ver o corpo de `compute` (objetos e listas novos, nunca alterados depois)
 */
export function dashboardData(app) {
  const scope = scopeOf(app);
  const today = app.clock.today();
  const key = `${app.store.version()}|${today}|${scope || ''}`;
  const hit = cache.get(app);
  if (hit && hit.key === key) return hit.data;
  const data = compute(app, today, scope);
  cache.set(app, { key, data });
  return data;
}

function compute(app, today, scope) {
  const { sel } = app;
  const inScope = (type, entity) => !scope || sel.projectIdOf(type, entity) === scope;
  const categoryOf = (entity) => sel.status(entity.status).category;
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 6);
  const horizon = addDays(today, UPCOMING_DAYS);

  // ----- universo (visíveis = não excluídas nem arquivadas) ----------------------------------------
  const allTasks = sel.tasks().filter((t) => inScope('task', t));
  const allDemands = sel.demands().filter((d) => inScope('demand', d));
  const taskIds = new Set(allTasks.map((t) => t.id));
  const openTasks = allTasks.filter((t) => sel.isOpen(t));
  const openDemands = allDemands.filter((d) => sel.isOpen(d));

  // ----- hoje ------------------------------------------------------------------------------------------
  const todayTasks = openTasks
    .filter((t) => t.due_date === today || t.planned_start === today || categoryOf(t) === 'active' || !!sel.timerOf(t.id))
    .sort(compareTasks);

  // ----- atrasadas (tarefas e demandas), da mais antiga para a mais nova -------------------------------
  const overdue = [];
  for (const t of openTasks) if (t.due_date && t.due_date < today) overdue.push({ type: 'task', entity: t, daysLate: diffDays(t.due_date, today) });
  for (const d of openDemands) if (d.due_date && d.due_date < today) overdue.push({ type: 'demand', entity: d, daysLate: diffDays(d.due_date, today) });
  overdue.sort(compareItems);

  // ----- próximos prazos: de hoje até hoje + 7, agrupados por dia -------------------------------------
  const upcomingItems = [];
  for (const t of openTasks) if (t.due_date && t.due_date >= today && t.due_date <= horizon) upcomingItems.push({ type: 'task', entity: t });
  for (const d of openDemands) if (d.due_date && d.due_date >= today && d.due_date <= horizon) upcomingItems.push({ type: 'demand', entity: d });
  upcomingItems.sort(compareItems);
  const upcoming = [];
  for (const item of upcomingItems) {
    const last = upcoming[upcoming.length - 1];
    if (last && last.date === item.entity.due_date) last.items.push(item);
    else upcoming.push({ date: item.entity.due_date, items: [item] });
  }

  // ----- semana --------------------------------------------------------------------------------------
  const sections = sel.weekSections(weekStart);
  const weekPriorities = sections.priority.filter((t) => taskIds.has(t.id));
  const completedWeek = sections.completed.filter((t) => taskIds.has(t.id));
  const summary = sel.weekSummary(weekStart);
  const rowInScope = (row) => !!row.task && (!scope || sel.projectIdOf('task', row.task) === scope);
  const planned = summary.planned.filter(rowInScope);
  const added = summary.added.filter(rowInScope);
  const completedPlanned = summary.completedPlanned.filter(rowInScope);
  const completedInPlan = summary.completed.filter(rowInScope);
  const week = {
    start: weekStart,
    end: weekEnd,
    planned: planned.length,
    added: added.length,
    total: planned.length + added.length,
    done: completedInPlan.length,
    donePlanned: completedPlanned.length,
    adherence: planned.length ? completedPlanned.length / planned.length : null,
    completedAll: completedWeek.length,
  };

  // ----- andamento e bloqueios --------------------------------------------------------------------------
  // "Em andamento"/"em revisão" contam só tarefas de primeiro nível — a mesma população das colunas do Kanban,
  // que o cartão abre (o Kanban oculta subtarefas por padrão); as subtarefas em andamento vão à parte.
  const active = [];
  const review = [];
  let activeSubtasks = 0;
  const blocked = [];
  const waiting = [];
  const byDependency = [];
  for (const t of openTasks) {
    const category = categoryOf(t);
    const sub = (category === 'active' || category === 'review') && !!sel.parentOf(t);
    if (category === 'active') {
      if (sub) activeSubtasks += 1;
      else active.push(t);
    } else if (category === 'review' && !sub) review.push(t);
    if (category === 'blocked') blocked.push(t);
    else if (category === 'waiting') waiting.push(t);
    else if (sel.isBlockedByDependency(t.id)) byDependency.push(t);
  }
  blocked.sort(compareTasks);
  waiting.sort(compareTasks);
  byDependency.sort(compareTasks);

  // ----- próximas ações ------------------------------------------------------------------------------
  const ranked = sel.nextActions(Infinity).filter((item) => taskIds.has(item.task.id));
  const actionsDo = ranked.filter((item) => item.group === 'do');
  const actionsUnblock = ranked.filter((item) => item.group !== 'do');

  // ----- sugestões de prioridade (só de tarefas no escopo) ------------------------------------------------
  const suggestions = sel.prioritySuggestions().filter((s) => taskIds.has(s.taskId));

  // ----- demandas ------------------------------------------------------------------------------------
  const demands = openDemands.map((d) => ({ demand: d, progress: sel.demandProgress(d.id), inFlight: isInFlightCategory(categoryOf(d)) }));

  return Object.freeze({
    today,
    scope,
    hasAny: allTasks.length > 0 || allDemands.length > 0 || sel.tasks({ includeArchived: true }).some((t) => inScope('task', t)),
    openTaskCount: openTasks.length,
    todayTasks,
    dueToday: todayTasks.filter((t) => t.due_date === today).length,
    overdue,
    upcoming,
    upcomingCount: upcomingItems.length,
    weekPriorities,
    completedWeek,
    week,
    active,
    review,
    activeSubtasks,
    blocked,
    waiting,
    byDependency,
    stuckCount: blocked.length + waiting.length,
    actionsDo,
    actionsUnblock,
    suggestions,
    demands,
    inFlightCount: demands.filter((d) => d.inFlight).length,
  });
}

/**
 * Ordena as linhas de demanda: por prazo (vazios por último, depois prioridade) ou por progresso (menor
 * primeiro — quem está mais longe de terminar aparece antes; sem tarefas contáveis por último).
 * @param {Array<{ demand: object, progress: object }>} rows
 * @param {'deadline'|'progress'} sort
 * @returns {Array} lista NOVA
 */
export function sortDemandRows(rows, sort) {
  const list = [...(rows || EMPTY)];
  if (sort === 'progress') {
    list.sort((a, b) => {
      const va = a.progress && a.progress.value !== null ? a.progress.value : Infinity;
      const vb = b.progress && b.progress.value !== null ? b.progress.value : Infinity;
      return va - vb || compareDue(a.demand.due_date, b.demand.due_date) || compareTasks(a.demand, b.demand);
    });
  } else {
    list.sort((a, b) => compareDue(a.demand.due_date, b.demand.due_date) || compareTasks(a.demand, b.demand));
  }
  return list;
}

/** Quantidade de atrasadas no escopo (selo da navegação; barato: usa as faixas memorizadas). */
export function overdueCount(app) {
  const scope = scopeOf(app);
  const list = app.sel.dueBuckets().overdue;
  if (!scope) return list.length;
  let n = 0;
  for (const item of list) if (app.sel.projectIdOf(item.type, item.entity) === scope) n += 1;
  return n;
}
