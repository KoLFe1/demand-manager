// Relatório de status (#/relatorio) — regras puras (sem DOM, sem relógio implícito).
//
//   buildStatusReport({ range, projectId, demands, tasks, projects, events|eventsIndex, statuses, weekItems,
//                       today, nowIso })  → objeto estruturado, agrupado por projeto
//   reportToText(report)                  → texto simples (títulos + "• T-12 Nome — detalhe") para e-mail/Teams
//
// Seções (cada projeto mostra só as que têm itens):
//   done        Concluídas no período — pelo HISTÓRICO de status (completedWithin): reabrir no período tira da lista;
//   inProgress  Em andamento — categorias active/review (demandas com % de progresso);
//   blocked     Bloqueios e aguardando — blocked/waiting com motivo/pessoa e dias na espera (waitingSince);
//   next        Próximos passos — next_action das demandas abertas, tarefas planejadas para esta semana ou a
//               próxima (início planejado ou plano semanal) e prazos nos próximos 14 dias;
//   risks       Destaques/riscos — itens abertos atrasados.
// Demandas e tarefas de nível superior entram em todas as seções; subtarefas só em bloqueios e riscos.
// `demands`/`tasks` devem ser as linhas VISÍVEIS (o seletor já tira excluídas e arquivadas).

import { addDays, dateStrToIso, diffDays, endOfMonth, isValidDateStr, isoToDateStr, parseDate, startOfMonth, startOfWeek } from '../core/dates.js';
import { entityCode } from '../data/schema.js';
import { daysSince, waitingSince } from './followup.js';
import { demandProgress } from './progress.js';
import { categoryOf, isOpen, statusById } from './statuses.js';
import { completedWithin, indexEvents, statusIntervals } from './timeline.js';
import { activeWeekItems } from './weekplan.js';

/** Presets de período do seletor. */
export const REPORT_PRESETS = Object.freeze([
  Object.freeze({ id: 'week', label: 'Semana atual' }),
  Object.freeze({ id: 'lastweek', label: 'Semana passada' }),
  Object.freeze({ id: 'last7', label: 'Últimos 7 dias' }),
  Object.freeze({ id: 'month', label: 'Mês atual' }),
]);

export const DEFAULT_REPORT_PRESET = 'week';

/** Seções, na ordem do relatório. */
export const REPORT_SECTIONS = Object.freeze([
  Object.freeze({ id: 'done', title: 'Concluídas no período' }),
  Object.freeze({ id: 'inProgress', title: 'Em andamento' }),
  Object.freeze({ id: 'blocked', title: 'Bloqueios e aguardando' }),
  Object.freeze({ id: 'next', title: 'Próximos passos' }),
  Object.freeze({ id: 'risks', title: 'Destaques e riscos' }),
]);

/** Janela (dias) dos prazos em "Próximos passos". */
export const NEXT_DEADLINE_DAYS = 14;

const NO_PROJECT = '';
const NO_PROJECT_NAME = 'Sem projeto';
const EMPTY = Object.freeze([]);

const pad = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' → 'dd/mm' (mesmo ano de `today`) ou 'dd/mm/aaaa'. */
function shortDate(s, today) {
  const d = parseDate(s);
  if (!d) return '';
  const base = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  return String(d.getFullYear()) === String(today || '').slice(0, 4) ? base : `${base}/${d.getFullYear()}`;
}
const fullDate = (s) => {
  const d = parseDate(s);
  return d ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}` : '';
};
const daysWord = (n) => (n === 1 ? '1 dia' : `${n} dias`);

/**
 * Período de um preset (datas locais, semana começa na segunda).
 * @param {string} id 'week' | 'lastweek' | 'last7' | 'month'
 * @param {string} today 'YYYY-MM-DD'
 * @returns {{ from: string, to: string }}
 */
export function presetRange(id, today) {
  switch (id) {
    case 'lastweek': {
      const from = addDays(startOfWeek(today), -7);
      return { from, to: addDays(from, 6) };
    }
    case 'last7':
      return { from: addDays(today, -6), to: today };
    case 'month':
      return { from: startOfMonth(today), to: endOfMonth(today) };
    default: {
      const from = startOfWeek(today);
      return { from, to: addDays(from, 6) };
    }
  }
}

/** Período válido (from <= to) ou o da semana atual. */
export function normalizeRange(range, today) {
  if (range && isValidDateStr(range.from) && isValidDateStr(range.to)) {
    return range.from <= range.to ? { from: range.from, to: range.to } : { from: range.to, to: range.from };
  }
  return presetRange(DEFAULT_REPORT_PRESET, today);
}

/** Rótulo do período: "23/11 a 29/11/2026" (ou "23/11/2026" quando é um dia só). */
export function rangeLabel(range) {
  if (!range) return '';
  if (range.from === range.to) return fullDate(range.from);
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  const from = sameYear ? `${range.from.slice(8, 10)}/${range.from.slice(5, 7)}` : fullDate(range.from);
  return `${from} a ${fullDate(range.to)}`;
}

/**
 * Monta o relatório.
 * @param {object} input
 * @param {{from: string, to: string}} [input.range] período (padrão: semana atual)
 * @param {string|null} [input.projectId] só um projeto ('' = só "Sem projeto"; null/undefined = todos)
 * @param {object[]} input.demands demandas visíveis
 * @param {object[]} input.tasks tarefas visíveis (subtarefas inclusive)
 * @param {object[]} [input.projects]
 * @param {object[]} [input.events] activity_log (ou `eventsIndex`: Map 'tipo:id' → eventos ordenados)
 * @param {Map} [input.eventsIndex]
 * @param {object[]} input.statuses lista efetiva de status
 * @param {object[]} [input.weekItems] linhas de week_items
 * @param {string} input.today 'YYYY-MM-DD' local
 * @param {string} input.nowIso
 * @returns {object} { range, label, today, projectId, projectName, counts, projects: [{ id, name, sections, count }] }
 */
export function buildStatusReport(input = {}) {
  const { demands = EMPTY, tasks = EMPTY, projects = EMPTY, statuses, weekItems = EMPTY, today, nowIso } = input;
  const range = normalizeRange(input.range, today);
  const index = input.eventsIndex instanceof Map ? input.eventsIndex : indexEvents(input.events || EMPTY);
  const eventsFor = (type, id) => index.get(`${type}:${id}`) || EMPTY;
  const fromIso = dateStrToIso(range.from, 'start');
  const toIso = dateStrToIso(range.to, 'end');
  const filter = input.projectId === undefined || input.projectId === null ? null : String(input.projectId);

  const projectsById = new Map(projects.filter((p) => p && !p.deleted_at).map((p) => [p.id, p]));
  const projectOrder = new Map([...projectsById.keys()].map((id, i) => [id, i])); // ordem recebida (manual)
  const demandsById = new Map(demands.map((d) => [d.id, d]));
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const projectIdOfDemand = (d) => (d && d.project_id && projectsById.has(d.project_id) ? d.project_id : NO_PROJECT);
  const isSub = (t) => !!(t.parent_id && tasksById.has(t.parent_id));
  const demandOfTask = (t) => {
    const parent = isSub(t) ? tasksById.get(t.parent_id) : null;
    return demandsById.get((parent && parent.demand_id) || t.demand_id) || null;
  };
  const projectIdOf = (type, row) => projectIdOfDemand(type === 'demand' ? row : demandOfTask(row));

  // Agrupamento por projeto
  const groups = new Map();
  const groupOf = (pid) => {
    let g = groups.get(pid);
    if (!g) {
      const p = projectsById.get(pid);
      g = { id: pid || null, name: p ? p.name || 'Projeto' : NO_PROJECT_NAME, sort: p ? projectOrder.get(pid) : Infinity, sections: {} };
      for (const s of REPORT_SECTIONS) g.sections[s.id] = [];
      groups.set(pid, g);
    }
    return g;
  };

  const tasksOfDemand = new Map();
  for (const t of tasks) {
    const d = demandOfTask(t);
    if (!d) continue;
    if (!tasksOfDemand.has(d.id)) tasksOfDemand.set(d.id, []);
    tasksOfDemand.get(d.id).push(t);
  }

  const makeItem = (type, row, detail, extra = {}) => {
    const demand = type === 'task' ? demandOfTask(row) : null;
    return {
      key: `${type}:${row.id}`,
      type,
      id: row.id,
      code: entityCode(type, row),
      name: String(row.name || '(sem nome)'),
      demandName: demand ? demand.name || '' : '',
      detail,
      ...extra,
    };
  };
  const push = (section, type, row, item) => {
    const pid = projectIdOf(type, row);
    if (filter !== null && pid !== filter) return;
    groupOf(pid).sections[section].push(item);
  };

  const nextWeekEnd = addDays(startOfWeek(today), 13);
  const plannedIds = new Set();
  for (const week of [startOfWeek(today), addDays(startOfWeek(today), 7)]) {
    for (const item of activeWeekItems(weekItems || EMPTY, week)) plannedIds.add(item.task_id);
  }
  const deadlineEnd = addDays(today, NEXT_DEADLINE_DAYS);

  const visit = (type, row) => {
    const sub = type === 'task' && isSub(row);
    const category = categoryOf(statuses, row.status);
    const events = eventsFor(type, row.id);
    const open = isOpen(row, statuses);
    const label = statusById(statuses, row.status).label;

    // Concluídas no período (histórico)
    if (!sub && category === 'done') {
      const intervals = statusIntervals(row, events, { statuses, nowIso });
      const at = completedWithin(intervals, fromIso, toIso);
      if (at) {
        const day = isoToDateStr(at);
        const late = row.due_date && day > row.due_date ? ` (prazo ${shortDate(row.due_date, today)}, com atraso)` : '';
        push('done', type, row, makeItem(type, row, `concluída em ${shortDate(day, today)}${late}`, { date: day }));
      }
    }
    if (!open) return;

    // Em andamento
    if (!sub && (category === 'active' || category === 'review')) {
      const parts = [label];
      let percent = null;
      if (type === 'demand') {
        const prog = demandProgress(row, tasksOfDemand.get(row.id) || EMPTY, { statuses });
        if (prog && Number.isFinite(prog.percent)) {
          percent = prog.percent;
          parts.push(`${prog.percent}% (${prog.completed}/${prog.counted} tarefas)`);
        }
      }
      if (row.due_date) parts.push(`prazo ${shortDate(row.due_date, today)}`);
      push('inProgress', type, row, makeItem(type, row, parts.join(' · '), { percent, category, date: row.due_date || null }));
    }

    // Bloqueios e aguardando
    if (category === 'blocked' || category === 'waiting') {
      const since = waitingSince(row, events, { statuses, nowIso, mode: 'waiting' });
      const days = daysSince(since, today);
      const reason = String((category === 'blocked' ? row.blocked_reason : row.waiting_on) || '').trim();
      const head = `${category === 'blocked' ? 'Bloqueada' : 'Aguardando'} há ${daysWord(days)}`;
      const detail = reason ? `${head} — ${reason}` : head;
      push('blocked', type, row, makeItem(type, row, detail, { category, days, reason, since }));
    }

    // Próximos passos
    if (!sub) {
      const parts = [];
      let date = null;
      const action = type === 'demand' ? String(row.next_action || '').trim() : '';
      if (action) parts.push(`próxima ação: ${action}`);
      const start = row.planned_start;
      const plannedSoon = (type === 'task' && plannedIds.has(row.id)) || (isValidDateStr(start) && start >= startOfWeek(today) && start <= nextWeekEnd);
      if (plannedSoon) {
        parts.push(isValidDateStr(start) && start >= today ? `planejada para ${shortDate(start, today)}` : 'planejada para esta semana');
        date = isValidDateStr(start) ? start : today;
      }
      if (isValidDateStr(row.due_date) && row.due_date >= today && row.due_date <= deadlineEnd) {
        const n = diffDays(today, row.due_date);
        parts.push(`prazo ${shortDate(row.due_date, today)} (${n === 0 ? 'hoje' : `em ${daysWord(n)}`})`);
        date = date && date < row.due_date ? date : row.due_date;
      }
      if (parts.length) push('next', type, row, makeItem(type, row, parts.join(' · '), { date, nextAction: action || null }));
    }

    // Riscos: atrasadas
    if (isValidDateStr(row.due_date) && row.due_date < today) {
      const late = diffDays(row.due_date, today);
      push('risks', type, row, makeItem(type, row, `atrasada ${daysWord(late)} (prazo ${shortDate(row.due_date, today)})`, { daysLate: late, date: row.due_date }));
    }
  };

  for (const d of demands) visit('demand', d);
  for (const t of tasks) visit('task', t);

  // Ordenação
  const byCodeName = (a, b) => (a.type === b.type ? 0 : a.type === 'demand' ? -1 : 1) || a.name.localeCompare(b.name, 'pt-BR');
  const sorters = {
    done: (a, b) => String(a.date).localeCompare(String(b.date)) || byCodeName(a, b),
    inProgress: (a, b) => byCodeName(a, b),
    blocked: (a, b) => b.days - a.days || byCodeName(a, b),
    next: (a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')) || byCodeName(a, b),
    risks: (a, b) => b.daysLate - a.daysLate || byCodeName(a, b),
  };
  const counts = {};
  for (const s of REPORT_SECTIONS) counts[s.id] = 0;
  const list = [...groups.values()]
    .map((g) => {
      let count = 0;
      for (const s of REPORT_SECTIONS) {
        g.sections[s.id].sort(sorters[s.id]);
        counts[s.id] += g.sections[s.id].length;
        count += g.sections[s.id].length;
      }
      return { id: g.id, name: g.name, sort: g.sort, sections: g.sections, count };
    })
    .filter((g) => g.count > 0)
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'pt-BR'))
    .map(({ sort, ...g }) => g);

  const project = filter ? projectsById.get(filter) : null;
  return {
    range,
    label: rangeLabel(range),
    today,
    projectId: filter,
    projectName: filter === null ? null : project ? project.name : NO_PROJECT_NAME,
    counts,
    total: Object.values(counts).reduce((n, c) => n + c, 0),
    projects: list,
  };
}

/** Linha de item: "• T-12 Nome — detalhe" (com a demanda entre parênteses nas tarefas). */
export function itemLine(item) {
  const code = item.code ? `${item.code} ` : '';
  const demand = item.type === 'task' && item.demandName ? ` (${item.demandName})` : '';
  return `• ${code}${item.name}${demand}${item.detail ? ` — ${item.detail}` : ''}`;
}

/**
 * Texto simples do relatório (títulos com "#"/"##", marcadores "•"), estável para os mesmos dados.
 * @param {object} report resultado de buildStatusReport
 * @returns {string}
 */
export function reportToText(report) {
  if (!report) return '';
  const lines = [];
  lines.push(`# Relatório de status — ${report.label}`);
  if (report.projectName) lines.push(`Projeto: ${report.projectName}`);
  const c = report.counts || {};
  lines.push(
    `Resumo: ${c.done || 0} concluídas · ${c.inProgress || 0} em andamento · ${c.blocked || 0} bloqueios/aguardando · ${c.risks || 0} atrasadas`,
  );
  if (!report.projects.length) {
    lines.push('', 'Nada a relatar no período.');
    return lines.join('\n');
  }
  for (const project of report.projects) {
    lines.push('', `## ${project.name}`);
    for (const section of REPORT_SECTIONS) {
      const items = project.sections[section.id];
      if (!items.length) continue;
      lines.push('', `${section.title}:`);
      for (const item of items) lines.push(itemLine(item));
    }
  }
  return lines.join('\n');
}
