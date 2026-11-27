// "Agendar datas vazias" de uma demanda — planejador puro (sem DOM, sem banco, sem relógio implícito).
//
//   const plan = planEmptyDates({ demand, tasks, tasksById, graph, statuses, startDate, hoursPerDay });
//
// Regras:
//   • só tarefas ABERTAS da demanda (não arquivadas/excluídas) com início planejado E prazo vazios recebem datas;
//     tarefa com qualquer data é "mantida" e serve de âncora (nunca é sobrescrita);
//   • início = o mais tarde entre `startDate` (ajustado para dia útil) e o dia útil seguinte ao fim de cada
//     pré-requisito aberto (datado: o prazo; só com início: início + duração; agendado aqui: o fim calculado);
//     pré-requisito aberto sem data e fora da agenda é ignorado;
//   • duração = ceil(estimate_minutes ÷ (hoursPerDay × 60)) dias úteis (sem estimativa: 1 dia); a tarefa
//     principal dura pelo menos a soma das subtarefas vazias com estimativa;
//   • subtarefas vazias com estimativa são encadeadas dentro do período da tarefa principal; sem estimativa (ou
//     que não cabem no período) ficam vazias;
//   • demanda: início/prazo preenchidos só se vazios (início = o mais cedo, prazo = o mais tarde). Se a demanda
//     já tem prazo e a agenda termina depois dele, o prazo NÃO muda: `warning` explica e as linhas que passam
//     ficam com `overDue`;
//   • seguro contra ciclos (a aresta que fecha o laço é ignorada).

import { addWorkdays, formatDate, isValidDateStr } from '../core/dates.js';
import { workdaysFor } from './dependencies.js';
import { isOpen } from './statuses.js';

const valid = (d) => (isValidDateStr(d) ? d : null);
const hasId = (id) => id !== null && id !== undefined && id !== '';
const getFrom = (map, id) => (map instanceof Map ? map.get(id) : map ? map[id] : undefined);
const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
const earlier = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
const order = (x, y) => (Number(x.sort_order) || 0) - (Number(y.sort_order) || 0) || String(x.name || '').localeCompare(String(y.name || ''));

/** Motivos de uma subtarefa que fica sem datas. */
export const SCHEDULE_SKIP = Object.freeze({
  no_estimate: 'Subtarefa sem estimativa: fica sem datas',
  no_fit: 'Não cabe no período da tarefa principal: fica sem datas',
});

/**
 * @param {object} p
 * @param {object} p.demand                 a demanda
 * @param {Array<object>} p.tasks           tarefas da demanda (com subtarefas)
 * @param {Map|object} [p.tasksById]        todas as tarefas (para pré-requisitos de outras demandas)
 * @param {{ prereqs: Map<string, Set<string>> }} p.graph
 * @param {Array} [p.statuses]
 * @param {string} p.startDate              'YYYY-MM-DD'
 * @param {number} [p.hoursPerDay=8]
 * @returns {{ start: string, end: string|null, rows: Array<object>, changes: Array<{type, id, patch}>,
 *             demandPatch: object, demandDue: string|null, overDemandDue: boolean, warning: string|null, count: number }}
 */
export function planEmptyDates({ demand, tasks, tasksById, graph, statuses, startDate, hoursPerDay = 8 } = {}) {
  if (!isValidDateStr(startDate)) throw new TypeError('planEmptyDates: startDate inválido');
  const start0 = addWorkdays(startDate, 0);
  const hours = Number.isFinite(hoursPerDay) && hoursPerDay > 0 ? hoursPerDay : 8;
  const live = (t) => !!t && !t.deleted_at && !t.archived_at && isOpen(t, statuses);
  const own = (tasks || []).filter(live);
  const ownById = new Map(own.map((t) => [t.id, t]));
  const lookup = (id) => ownById.get(id) || getFrom(tasksById, id) || null;
  const parentInDemand = (t) => (hasId(t.parent_id) && ownById.has(t.parent_id) && t.parent_id !== t.id ? ownById.get(t.parent_id) : null);
  const tops = own.filter((t) => !parentInDemand(t)).sort(order);
  const subsOf = new Map();
  for (const t of own) {
    const parent = parentInDemand(t);
    if (!parent) continue;
    if (!subsOf.has(parent.id)) subsOf.set(parent.id, []);
    subsOf.get(parent.id).push(t);
  }
  for (const list of subsOf.values()) list.sort(order);
  const isEmpty = (t) => !valid(t.planned_start) && !valid(t.due_date);
  const duration = (t) => workdaysFor(t.estimate_minutes, hours);
  const hasEstimate = (t) => Number(t.estimate_minutes) > 0;
  const prereqsOf = (id) => {
    const set = graph && graph.prereqs ? graph.prereqs.get(id) : null;
    return set ? [...set] : [];
  };

  const planned = new Map(); // id → { planned_start, due_date, state, reason? }
  const ends = new Map(); // id → fim (ou null)
  const visiting = new Set();

  /** Dia de início mínimo depois dos pré-requisitos de `id`. */
  const afterPrereqs = (id, from) => {
    let s = from;
    for (const p of prereqsOf(id)) {
      const e = endOf(p);
      if (e) s = later(s, addWorkdays(e, 1));
    }
    return s;
  };

  /** Agenda as subtarefas vazias de `parent` dentro de [winStart, winEnd]. */
  const scheduleSubs = (parent, winStart, winEnd) => {
    let cursor = winStart;
    for (const sub of subsOf.get(parent.id) || []) {
      if (!isEmpty(sub) || planned.has(sub.id)) continue;
      if (!hasEstimate(sub)) {
        planned.set(sub.id, { planned_start: null, due_date: null, state: 'empty', reason: SCHEDULE_SKIP.no_estimate });
        continue;
      }
      visiting.add(sub.id);
      const s = addWorkdays(afterPrereqs(sub.id, cursor), 0);
      visiting.delete(sub.id);
      const d = addWorkdays(s, duration(sub) - 1);
      if (winEnd && d > winEnd) {
        planned.set(sub.id, { planned_start: null, due_date: null, state: 'empty', reason: SCHEDULE_SKIP.no_fit });
        continue;
      }
      planned.set(sub.id, { planned_start: s, due_date: d, state: 'new' });
      ends.set(sub.id, d);
      cursor = addWorkdays(d, 1);
    }
  };

  function endOf(id) {
    if (ends.has(id)) return ends.get(id);
    if (visiting.has(id)) return null; // ciclo: ignora a aresta
    const t = lookup(id);
    if (!live(t)) {
      ends.set(id, null);
      return null;
    }
    const mine = ownById.has(id);
    const parent = mine ? parentInDemand(t) : null;
    if (parent && isEmpty(t)) {
      // subtarefa vazia: a data sai do agendamento da principal
      endOf(parent.id);
      if (!ends.has(id)) ends.set(id, null);
      return ends.get(id);
    }
    visiting.add(id);
    let result;
    if (!mine || !isEmpty(t)) {
      const due = valid(t.due_date);
      const st = valid(t.planned_start);
      result = due || (st ? addWorkdays(st, duration(t) - 1) : null);
      if (mine) {
        planned.set(id, { planned_start: st, due_date: due, state: 'kept' });
        if (!parent) {
          const winStart = st ? later(start0, addWorkdays(st, 0)) : start0;
          ends.set(id, result);
          scheduleSubs(t, winStart, due);
        }
      }
    } else {
      const s = addWorkdays(afterPrereqs(id, start0), 0);
      let dur = duration(t);
      const subSum = (subsOf.get(id) || []).filter((x) => isEmpty(x) && hasEstimate(x)).reduce((acc, x) => acc + duration(x), 0);
      dur = Math.max(dur, subSum);
      result = addWorkdays(s, dur - 1);
      planned.set(id, { planned_start: s, due_date: result, state: 'new' });
      ends.set(id, result);
      scheduleSubs(t, s, result);
    }
    visiting.delete(id);
    ends.set(id, result);
    return result;
  }

  for (const t of tops) endOf(t.id);
  for (const t of own) if (!planned.has(t.id)) endOf(t.id);

  const demandDue = demand ? valid(demand.due_date) : null;
  const rows = [];
  let minStart = null;
  let maxEnd = null;
  let planEnd = null;
  const pushRow = (t, depth) => {
    const p = planned.get(t.id) || { planned_start: valid(t.planned_start), due_date: valid(t.due_date), state: 'kept' };
    minStart = earlier(minStart, p.planned_start || p.due_date);
    maxEnd = later(maxEnd, p.due_date || p.planned_start);
    if (p.state === 'new') planEnd = later(planEnd, p.due_date);
    const overDue = !!demandDue && !!p.due_date && p.due_date > demandDue;
    rows.push(Object.freeze({ id: t.id, task: t, depth, parentId: depth ? t.parent_id : null, ...p, overDue }));
  };
  for (const t of tops) {
    pushRow(t, 0);
    for (const sub of subsOf.get(t.id) || []) pushRow(sub, 1);
  }

  const changes = rows.filter((r) => r.state === 'new').map((r) => ({ type: 'task', id: r.id, patch: { planned_start: r.planned_start, due_date: r.due_date } }));
  const demandPatch = {};
  if (demand) {
    if (!valid(demand.planned_start) && minStart) demandPatch.planned_start = minStart;
    if (!demandDue && maxEnd) demandPatch.due_date = maxEnd;
    if (Object.keys(demandPatch).length) changes.push({ type: 'demand', id: demand.id, patch: demandPatch });
  }
  const overDemandDue = !!demandDue && !!maxEnd && maxEnd > demandDue;
  const warning = overDemandDue ? `A agenda termina em ${formatDate(maxEnd, 'daymonth')}, depois do prazo da demanda (${formatDate(demandDue, 'daymonth')}).` : null;
  return { start: start0, end: planEnd, rows, changes, demandPatch, demandDue, overDemandDue, warning, count: changes.filter((c) => c.type === 'task').length };
}
