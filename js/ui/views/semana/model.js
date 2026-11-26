// "Minha Semana" — dados da tela (sem DOM): semana escolhida, resumo e seções respeitando o escopo global de
// projeto, candidatas para o plano, carga × capacidade e a série das últimas semanas.
//
// Tudo aqui é leitura: lê os seletores memorizados (app.sel) e devolve objetos novos. Nada é gravado.

import { addDays, formatWeekRange, isValidDateStr, startOfWeek, weekdayIndex } from '../../../core/dates.js';
import { uuid } from '../../../core/ids.js';
import { comparePriority } from '../../../domain/priorities.js';
import { categoryOf, isOpen } from '../../../domain/statuses.js';
import { DEFAULT_HOURS_PER_WEEK, WEEK_KIND, WEEK_OUTCOME, WEEK_PHASE, planLoad } from '../../../domain/weekplan.js';

/** Quantas semanas entram no gráfico "planejado × concluído". */
export const HISTORY_WEEKS = 6;

/**
 * Quantas linhas cada lista de acompanhamento (prioritárias, atrasadas, vencimentos, bloqueadas, concluídas)
 * mostra antes de "Ver todas as N". A contagem do cabeçalho é sempre a completa; a tela fica leve mesmo com
 * centenas de atrasadas antigas no banco.
 */
export const WATCH_CAP = 15;

/**
 * Identificador desta sessão da página. A semana escolhida só vale dentro da mesma sessão: ao abrir o app de
 * novo, a tela volta para a semana corrente (uma semana antiga guardada não "prende" o usuário no passado).
 */
const SESSION = uuid();

const NAME_COLLATOR = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

/** Segunda-feira da semana corrente (relógio do app). */
export function currentWeekOf(app) {
  return startOfWeek(app.clock.today());
}

/**
 * Semana mostrada pela tela: a guardada em ctx.state, se foi escolhida nesta sessão; senão a corrente.
 * @param {object} app
 * @param {object} state ctx.state
 * @returns {string} segunda-feira 'YYYY-MM-DD'
 */
export function selectedWeek(app, state) {
  if (state && state.weekSession === SESSION && isValidDateStr(state.week)) return startOfWeek(state.week);
  return currentWeekOf(app);
}

/** Patch de ctx.state que seleciona uma semana (qualquer dia dela). */
export function weekPatch(week) {
  return { week: startOfWeek(week), weekSession: SESSION };
}

/** Projeto do escopo global (app.ui.scope) ou null. */
export function scopeId(app) {
  return app.ui && app.ui.scope && app.ui.scope.projectId ? app.ui.scope.projectId : null;
}

/** Filtro de tarefas do escopo global de projeto; null quando não há escopo. */
export function scopeFilter(app) {
  const id = scopeId(app);
  if (!id) return null;
  return (task) => !!task && !task.deleted_at && app.sel.projectIdOf('task', task) === id;
}

/** Rótulo e tom da fase da semana. */
export const PHASE_INFO = Object.freeze({
  [WEEK_PHASE.CURRENT]: { label: 'Semana atual', tone: 'accent' },
  [WEEK_PHASE.PAST]: { label: 'Semana passada', tone: 'neutral' },
  [WEEK_PHASE.FUTURE]: { label: 'Semana futura', tone: 'info' },
});

/** Fase da semana em relação a hoje. */
export function phaseOf(app, week) {
  const current = currentWeekOf(app);
  if (week < current) return WEEK_PHASE.PAST;
  if (week > current) return WEEK_PHASE.FUTURE;
  return WEEK_PHASE.CURRENT;
}

/**
 * Refaz as listas e contagens do resumo (weekSummary do domínio) a partir de um subconjunto das linhas —
 * mesmas regras do domínio (ver js/domain/weekplan.js).
 * @param {ReadonlyArray<object>} rows linhas de weekSummary().rows
 * @returns {object}
 */
/** Ordem das linhas do histórico: planejadas antes das adicionadas, depois prioridade, prazo e nome. */
export function compareRows(a, b) {
  if (a.kind !== b.kind) return a.kind === WEEK_KIND.PLANNED ? -1 : 1;
  if (!a.task || !b.task) return a.task ? -1 : b.task ? 1 : 0;
  return compareCandidates(a.task, b.task);
}

export function tallyRows(rows) {
  const missing = [];
  const removed = [];
  const doneBefore = [];
  const active = [];
  for (const row of rows) {
    if (row.outcome === WEEK_OUTCOME.MISSING) missing.push(row);
    else if (row.outcome === WEEK_OUTCOME.REMOVED) removed.push(row);
    else if (row.completedBefore) doneBefore.push(row);
    else active.push(row);
  }
  const planned = active.filter((r) => r.kind === WEEK_KIND.PLANNED);
  const added = active.filter((r) => r.kind === WEEK_KIND.ADDED);
  const completed = active.filter((r) => r.outcome === WEEK_OUTCOME.DONE);
  const completedPlanned = completed.filter((r) => r.kind === WEEK_KIND.PLANNED);
  const completedAdded = completed.filter((r) => r.kind === WEEK_KIND.ADDED);
  const notCompleted = active.filter((r) => r.outcome !== WEEK_OUTCOME.DONE);
  const carriedOut = active.filter((r) => r.outcome === WEEK_OUTCOME.CARRIED);
  const carriedIn = active.filter((r) => !!r.item.carried_from_id);
  const lists = { planned, added, completed, completedPlanned, completedAdded, notCompleted, carriedOut, carriedIn, removed, doneBefore, missing };
  const counts = {};
  for (const [key, list] of Object.entries(lists)) counts[key] = list.length;
  return { rows: [...rows], active, ...lists, counts, adherence: planned.length ? completedPlanned.length / planned.length : null };
}

/**
 * Resumo da semana (planejado × realizado) limitado ao escopo de projeto.
 * @param {object} app
 * @param {string} week
 * @param {((task: object) => boolean)|null} keep filtro do escopo
 */
export function scopedSummary(app, week, keep) {
  const base = app.sel.weekSummary(week);
  const rows = keep ? base.rows.filter((row) => row.task && keep(row.task)) : base.rows;
  return { weekStart: base.weekStart, weekEnd: base.weekEnd, phase: base.phase, ...tallyRows(rows) };
}

/** Seções da tela limitadas ao escopo de projeto. */
export function scopedSections(app, week, keep) {
  const base = app.sel.weekSections(week);
  if (!keep) return base;
  const out = {};
  for (const [key, list] of Object.entries(base)) out[key] = list.filter(keep);
  return out;
}

/** Capacidade semanal configurada (horas). */
export function hoursPerWeek(app) {
  const n = Number(app.settings.get('capacity.hoursPerWeek'));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HOURS_PER_WEEK;
}

/** Carga do plano (estimativas das tarefas abertas) × capacidade, no escopo de projeto. */
export function scopedLoad(app, week, keep) {
  if (!keep) return app.sel.weekLoad(week);
  const items = app.sel.weekItems(week).filter((item) => keep(app.sel.task(item.task_id)));
  return planLoad({ items, tasksById: app.sel.tasksById(), statuses: app.sel.statuses(), weekStart: week, hoursPerWeek: hoursPerWeek(app) });
}

/**
 * Série das últimas semanas (terminando na semana escolhida): tarefas no plano × concluídas.
 * @returns {{ categories: string[], weeks: string[], inPlan: number[], completed: number[] }}
 */
export function historySeries(app, week, keep) {
  const categories = [];
  const weeks = [];
  const inPlan = [];
  const completed = [];
  for (let i = HISTORY_WEEKS - 1; i >= 0; i--) {
    const w = addDays(week, -7 * i);
    const summary = scopedSummary(app, w, keep);
    const [, month, day] = w.split('-');
    categories.push(`${day}/${month}`);
    weeks.push(w);
    inPlan.push(summary.counts.planned + summary.counts.added);
    completed.push(summary.counts.completed);
  }
  return { categories, weeks, inPlan, completed };
}

/**
 * Itens do plano que ficaram sem conclusão e ainda podem ser transferidos: desfecho "não concluída" (nem
 * concluída, nem cancelada, nem transferida, nem retirada) e tarefa ainda aberta e visível.
 * @param {object} app
 * @param {object} summary resultado de scopedSummary
 * @returns {object[]} linhas do resumo
 */
export function unfinishedRows(app, summary) {
  const statuses = app.sel.statuses();
  return summary.active
    .filter((row) => row.outcome === WEEK_OUTCOME.OPEN && row.task && !row.task.deleted_at && isOpen(row.task, statuses) && !app.sel.isHidden('task', row.task))
    .sort((a, b) => compareCandidates(a.task, b.task));
}

/**
 * Para onde a transferência leva o trabalho pendente da semana escolhida: da semana corrente (ou futura)
 * para a seguinte; de uma semana passada, para a semana corrente (transferir para outra semana já encerrada
 * não ajudaria ninguém).
 */
export function carryTarget(app, week) {
  const current = currentWeekOf(app);
  const next = addDays(week, 7);
  return next < current ? current : next;
}

/**
 * O aviso de transferência aparece? Semana passada com pendências, ou a semana corrente de sexta a domingo.
 */
export function showCarryBanner(app, week, phase, pending) {
  if (!pending) return false;
  if (phase === WEEK_PHASE.PAST) return true;
  if (phase === WEEK_PHASE.CURRENT) return weekdayIndex(app.clock.today()) >= 4;
  return false;
}

/** Rótulo curto de uma semana: '23–29 nov 2026'. */
export function weekLabel(week) {
  return formatWeekRange(week);
}

/** Dia da semana em que a tarefa cai (prazo, senão início planejado, dentro da semana) ou null. */
export function dayOfTask(task, week) {
  const end = addDays(week, 6);
  if (task.due_date && task.due_date >= week && task.due_date <= end) return task.due_date;
  if (task.planned_start && task.planned_start >= week && task.planned_start <= end) return task.planned_start;
  return null;
}

// ---------------------------------------------------------------------------
// Candidatas para o plano ("Adicionar tarefas")
// ---------------------------------------------------------------------------

/** Filtros do diálogo "Adicionar tarefas". */
export const CANDIDATE_FILTERS = Object.freeze([
  { id: 'backlog', label: 'Backlog' },
  { id: 'planned', label: 'Não iniciadas' },
  { id: 'overdue', label: 'Atrasadas' },
  { id: 'open', label: 'Todas abertas' },
]);

/** Ordem das listas: prioridade, prazo (vazios por último), nome. */
export function compareCandidates(a, b) {
  const da = a.due_date || '9999-99-99';
  const db = b.due_date || '9999-99-99';
  return comparePriority(a, b) || (da < db ? -1 : da > db ? 1 : 0) || NAME_COLLATOR.compare(String(a.name || ''), String(b.name || '')) || (a.id < b.id ? -1 : 1);
}

/**
 * Tarefas abertas e visíveis que ainda não estão no plano da semana (no escopo de projeto), com a contagem
 * por filtro.
 * @param {object} app
 * @param {string} week
 * @returns {{ all: object[], counts: Record<string, number>, matches: (task: object, filter: string) => boolean }}
 */
export function candidateTasks(app, week) {
  const keep = scopeFilter(app);
  const statuses = app.sel.statuses();
  const today = app.clock.today();
  const inPlan = new Set(app.sel.weekItems(week).map((item) => item.task_id));
  const all = app.sel
    .tasks()
    .filter((task) => isOpen(task, statuses) && !inPlan.has(task.id) && (!keep || keep(task)))
    .sort(compareCandidates);
  const matches = (task, filter) => {
    if (filter === 'backlog') return categoryOf(statuses, task.status) === 'backlog';
    if (filter === 'planned') return categoryOf(statuses, task.status) === 'planned';
    if (filter === 'overdue') return !!task.due_date && task.due_date < today;
    return true;
  };
  const counts = {};
  for (const f of CANDIDATE_FILTERS) counts[f.id] = all.filter((task) => matches(task, f.id)).length;
  return { all, counts, matches };
}

/**
 * Agrupa tarefas por demanda (tarefas avulsas por último), na ordem das demandas por projeto e nome.
 * @returns {Array<{ key: string, demand: object|null, project: object|null, tasks: object[] }>}
 */
export function groupByDemand(app, tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const demand = app.sel.demandOf(task);
    const key = demand ? demand.id : '';
    let group = groups.get(key);
    if (!group) {
      group = { key: key || 'avulsas', demand, project: demand ? app.sel.project(demand.project_id) : null, tasks: [] };
      groups.set(key, group);
    }
    group.tasks.push(task);
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.demand !== !b.demand) return a.demand ? -1 : 1;
    const pa = a.project ? a.project.name : '￿';
    const pb = b.project ? b.project.name : '￿';
    return NAME_COLLATOR.compare(pa, pb) || NAME_COLLATOR.compare(a.demand ? a.demand.name : '', b.demand ? b.demand.name : '');
  });
}
