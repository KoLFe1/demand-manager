// "Resumo do dia" (lembretes) — regras puras: sem DOM, sem banco, sem relógio implícito.
//
//   buildDailyDigest({ today, demands, tasks, statuses, soonDays, demandsById, previousWeek, currentWeekPlanned })
//     → { today, isMonday, overdue, dueToday, dueSoon, followUps, weekPlan, counts, isEmpty, horizon }
//   digestHeadline(digest) → '2 atrasadas · 1 vence hoje · 1 cobrança'
//   digestToText(digest)   → texto simples pt-BR para copiar / mandar por e-mail
//
// Seções (itens abertos; `demands`/`tasks` devem ser as linhas VISÍVEIS — o seletor já tira excluídas/arquivadas):
//   overdue    prazo antes de hoje;
//   dueToday   prazo hoje;
//   dueSoon    prazo depois de hoje até `soonDays` DIAS ÚTEIS à frente (configuração 'deadline.soonDays', padrão 3);
//   followUps  "Cobrar em" vencido ou hoje (followup.js);
//   weekPlan   só às segundas: resumo da semana anterior (weekSummary: planejado × realizado) e quantas tarefas
//              estão no plano desta semana. Passe `previousWeek` (resultado de weekSummary) e `currentWeekPlanned`.
// isEmpty: nenhuma das listas tem itens e não há nada a contar da semana.

import { addDays, addWorkdays, diffDays, formatDate, isValidDateStr, weekdayIndex, WEEKDAYS_LONG } from '../core/dates.js';
import { entityCode } from '../data/schema.js';
import { compareByDue, DEFAULT_SOON_DAYS } from './deadlines.js';
import { followUpInfo, isFollowUpDue, personName } from './followup.js';
import { isOpen } from './statuses.js';

/** Seções de itens, na ordem do resumo. */
export const DIGEST_SECTIONS = Object.freeze([
  Object.freeze({ id: 'overdue', title: 'Atrasadas', icon: 'alert-circle', tone: 'danger' }),
  Object.freeze({ id: 'dueToday', title: 'Vencem hoje', icon: 'target', tone: 'warn' }),
  Object.freeze({ id: 'dueSoon', title: 'Próximos vencimentos', icon: 'calendar', tone: 'neutral' }),
  Object.freeze({ id: 'followUps', title: 'Cobranças para hoje', icon: 'bell', tone: 'warn' }),
]);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const dm = (day) => formatDate(day, 'daymonth');

function toList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [...value];
}

function lookup(map, id) {
  if (!map || id == null) return undefined;
  return typeof map.get === 'function' ? map.get(id) : map[id];
}

function itemOf(type, entity, demandsById, detail, date) {
  const demand = type === 'task' ? lookup(demandsById, entity.demand_id) : null;
  return Object.freeze({
    key: `${type}:${entity.id}`,
    type,
    id: entity.id,
    code: entityCode(type, entity),
    name: entity.name || 'Sem nome',
    demandName: demand ? demand.name || '' : '',
    date: date || null,
    detail: detail || '',
  });
}

function lateText(days) {
  return days === 1 ? '1 dia de atraso' : `${days} dias de atraso`;
}

/**
 * Monta o resumo do dia.
 * @param {object} params
 * @param {string} params.today 'YYYY-MM-DD' (data LOCAL)
 * @param {Array<object>} params.demands demandas visíveis
 * @param {Array<object>} params.tasks tarefas visíveis (subtarefas inclusive)
 * @param {Array} [params.statuses]
 * @param {number} [params.soonDays=3] dias úteis do horizonte de "Próximos vencimentos"
 * @param {Map|object} [params.demandsById] para o nome da demanda das tarefas
 * @param {object|null} [params.previousWeek] weekSummary da semana anterior (usado só às segundas)
 * @param {number|null} [params.currentWeekPlanned] tarefas no plano desta semana (usado só às segundas)
 * @returns {object}
 */
export function buildDailyDigest({ today, demands = [], tasks = [], statuses, soonDays = DEFAULT_SOON_DAYS, demandsById = null, previousWeek = null, currentWeekPlanned = null } = {}) {
  if (!isValidDateStr(today)) throw new RangeError(`buildDailyDigest: data inválida: ${today}`);
  const soon = Number.isFinite(Number(soonDays)) && Number(soonDays) > 0 ? Math.floor(Number(soonDays)) : 0;
  const horizon = soon > 0 ? addWorkdays(addDays(today, 1), soon - 1) : today;

  const rows = [];
  for (const d of toList(demands)) if (d && isOpen(d, statuses)) rows.push({ type: 'demand', entity: d });
  for (const t of toList(tasks)) if (t && isOpen(t, statuses)) rows.push({ type: 'task', entity: t });

  const overdue = [];
  const dueToday = [];
  const dueSoon = [];
  const follow = [];
  for (const row of rows) {
    const due = isValidDateStr(row.entity.due_date) ? row.entity.due_date : null;
    if (due && due < today) overdue.push(row);
    else if (due === today) dueToday.push(row);
    else if (due && soon > 0 && due <= horizon) dueSoon.push(row);
    if (isFollowUpDue(row.entity.follow_up_date, today)) follow.push(row);
  }
  const byDue = (a, b) => compareByDue(a.entity, b.entity);
  overdue.sort(byDue);
  dueToday.sort(byDue);
  dueSoon.sort(byDue);
  follow.sort((a, b) => (a.entity.follow_up_date < b.entity.follow_up_date ? -1 : a.entity.follow_up_date > b.entity.follow_up_date ? 1 : byDue(a, b)));

  const overdueItems = overdue.map(({ type, entity }) => {
    const days = diffDays(entity.due_date, today);
    return itemOf(type, entity, demandsById, `prazo ${dm(entity.due_date)} (${lateText(days)})`, entity.due_date);
  });
  const todayItems = dueToday.map(({ type, entity }) => itemOf(type, entity, demandsById, 'vence hoje', entity.due_date));
  const soonItems = dueSoon.map(({ type, entity }) => {
    const wd = WEEKDAYS_LONG[weekdayIndex(entity.due_date)] || '';
    return itemOf(type, entity, demandsById, `prazo ${wd ? `${wd.split('-')[0]}, ` : ''}${dm(entity.due_date)}`, entity.due_date);
  });
  const followItems = follow.map(({ type, entity }) => {
    const info = followUpInfo(entity.follow_up_date, today);
    const who = personName(entity.waiting_on) || personName(entity.owner);
    return itemOf(type, entity, demandsById, who ? `${info.label} — ${who}` : info.label, entity.follow_up_date);
  });

  const isMonday = weekdayIndex(today) === 0;
  let weekPlan = null;
  if (isMonday && (previousWeek || Number.isFinite(currentWeekPlanned))) {
    const c = (previousWeek && previousWeek.counts) || {};
    weekPlan = Object.freeze({
      previousWeekStart: previousWeek ? previousWeek.weekStart : addDays(today, -7),
      previousWeekEnd: previousWeek ? previousWeek.weekEnd : addDays(today, -1),
      planned: c.planned || 0,
      completedPlanned: c.completedPlanned || 0,
      added: c.added || 0,
      completed: c.completed || 0,
      notCompleted: c.notCompleted || 0,
      adherence: previousWeek && Number.isFinite(previousWeek.adherence) ? previousWeek.adherence : null,
      currentPlanned: Number.isFinite(currentWeekPlanned) ? currentWeekPlanned : 0,
    });
  }
  const weekHasContent = !!weekPlan && weekPlan.planned + weekPlan.added + weekPlan.currentPlanned > 0;

  const counts = Object.freeze({ overdue: overdueItems.length, dueToday: todayItems.length, dueSoon: soonItems.length, followUps: followItems.length });
  return Object.freeze({
    today,
    isMonday,
    horizon,
    overdue: Object.freeze(overdueItems),
    dueToday: Object.freeze(todayItems),
    dueSoon: Object.freeze(soonItems),
    followUps: Object.freeze(followItems),
    weekPlan,
    counts,
    isEmpty: counts.overdue + counts.dueToday + counts.dueSoon + counts.followUps === 0 && !weekHasContent,
  });
}

/** Manchete curta (notificação, subtítulo do modal). */
export function digestHeadline(digest) {
  if (!digest) return '';
  const c = digest.counts || {};
  const bits = [];
  if (c.overdue) bits.push(plural(c.overdue, 'atrasada', 'atrasadas'));
  if (c.dueToday) bits.push(c.dueToday === 1 ? '1 vence hoje' : `${c.dueToday} vencem hoje`);
  if (c.dueSoon) bits.push(plural(c.dueSoon, 'próximo vencimento', 'próximos vencimentos'));
  if (c.followUps) bits.push(plural(c.followUps, 'cobrança', 'cobranças'));
  if (!bits.length) return digest.weekPlan ? 'Nada urgente hoje — veja o resumo da semana.' : 'Nada urgente hoje.';
  return bits.join(' · ');
}

/** Texto da semana (segunda-feira): linhas sem marcador. */
export function weekPlanLines(weekPlan) {
  if (!weekPlan) return [];
  const w = weekPlan;
  const lines = [];
  const range = `${dm(w.previousWeekStart)} a ${dm(w.previousWeekEnd)}`;
  if (w.planned || w.added) {
    const pct = w.adherence === null ? '' : ` (${Math.round(w.adherence * 100)}%)`;
    const extra = [w.added ? plural(w.added, 'adicionada', 'adicionadas') : null, w.notCompleted ? plural(w.notCompleted, 'não concluída', 'não concluídas') : null].filter(Boolean);
    lines.push(`Semana passada (${range}): ${w.completedPlanned} de ${plural(w.planned, 'planejada concluída', 'planejadas concluídas')}${pct}${extra.length ? ` · ${extra.join(' · ')}` : ''}`);
  } else {
    lines.push(`Semana passada (${range}): nada planejado.`);
  }
  lines.push(w.currentPlanned ? `Esta semana: ${plural(w.currentPlanned, 'tarefa', 'tarefas')} no plano.` : 'Esta semana: o plano ainda está vazio.');
  return lines;
}

/** Linha de um item: "• T-12 Nome (Demanda) — detalhe". */
export function digestItemLine(item) {
  const code = item.code ? `${item.code} ` : '';
  const demand = item.type === 'task' && item.demandName ? ` (${item.demandName})` : '';
  return `• ${code}${item.name}${demand}${item.detail ? ` — ${item.detail}` : ''}`;
}

/** Título com a data longa: "Resumo do dia — quinta-feira, 26/11/2026". */
export function digestTitle(today) {
  const wd = WEEKDAYS_LONG[weekdayIndex(today)] || '';
  return `Resumo do dia — ${wd ? `${wd}, ` : ''}${formatDate(today, 'numeric')}`;
}

/**
 * Texto simples do resumo (estável para os mesmos dados).
 * @param {object} digest resultado de buildDailyDigest
 * @returns {string}
 */
export function digestToText(digest) {
  if (!digest) return '';
  const lines = [digestTitle(digest.today), digestHeadline(digest)];
  for (const section of DIGEST_SECTIONS) {
    const items = digest[section.id] || [];
    if (!items.length) continue;
    lines.push('', `${section.title} (${items.length}):`);
    for (const item of items) lines.push(digestItemLine(item));
  }
  if (digest.weekPlan) lines.push('', 'Planejamento da semana:', ...weekPlanLines(digest.weekPlan));
  return lines.join('\n');
}
