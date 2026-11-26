// Calendário externo (.ics, RFC 5545): prazos de demandas e tarefas abertas como eventos de dia inteiro,
// para importar no Outlook ou no Google Agenda. Puro: recebe os dados e o instante (nowIso) por parâmetro.
//
//   const items = collectCalendarItems({ demands, tasks, projectsById, demandsById, statuses, projectId });
//   const text = buildCalendar(items, { appUrl: 'https://…/index.html', nowIso });
//
// Regras do formato: linhas terminam em CRLF; texto escapa \ ; , e quebra de linha (→ \n); linhas com mais de
// 75 octetos (bytes UTF-8) são dobradas com CRLF + um espaço, sem partir um caractere multibyte.
// UID estável (task-<id>@demand-manager) faz a reimportação atualizar o mesmo evento em vez de duplicar.

import { addDays, isValidDateStr } from '../core/dates.js';
import { entityCode } from '../data/schema.js';
import { priorityById } from './priorities.js';
import { isOpen, isDone, statusById } from './statuses.js';

export const ICS_FILENAME = 'demand-manager-prazos.ics';
export const ICS_MIME = 'text/calendar';
export const ICS_CAL_NAME = 'Demand Manager';
const CRLF = '\r\n';
const MAX_OCTETS = 75;
const DESCRIPTION_LIMIT = 1000;

/** Escapa um valor TEXT (RFC 5545 §3.3.11). */
export function escapeText(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function utf8Length(codePoint) {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/** Dobra uma linha de conteúdo em pedaços de no máximo 75 octetos (a continuação começa com um espaço). */
export function foldLine(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  let limit = MAX_OCTETS;
  for (const ch of String(line)) {
    const size = utf8Length(ch.codePointAt(0));
    if (bytes + size > limit) {
      out.push(current);
      current = ' ';
      bytes = 1;
      limit = MAX_OCTETS;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join(CRLF);
}

/** 'YYYY-MM-DD' → 'YYYYMMDD'. */
const icsDate = (s) => s.replace(/-/g, '');

/** ISO UTC → 'YYYYMMDDTHHMMSSZ'. */
export function icsTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Instante inválido: ${iso}`);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Link que abre o painel da entidade no app (mesmo formato da URL do app: #/demandas?panel=task:<id>). */
export function entityLink(appUrl, type, id) {
  const base = String(appUrl || '').split('#')[0];
  return `${base}#/demandas?panel=${type}:${id}`;
}

/**
 * Seleciona as demandas/tarefas que viram eventos (com prazo; abertas, salvo includeDone).
 * As listas recebidas já devem estar sem excluídas/arquivadas.
 * @param {object} p
 * @param {object[]} p.demands
 * @param {object[]} p.tasks
 * @param {Map<string, object>} p.projectsById
 * @param {Map<string, object>} p.demandsById
 * @param {object[]} p.statuses
 * @param {boolean} [p.includeDemands=true]
 * @param {boolean} [p.includeTasks=true]
 * @param {boolean} [p.includeDone=false] inclui as concluídas (canceladas nunca entram)
 * @param {string|null} [p.projectId=null] null = todos; '' = sem projeto; id = só aquele projeto
 * @returns {object[]} itens normalizados para buildCalendar, ordenados por prazo
 */
export function collectCalendarItems({ demands = [], tasks = [], projectsById = new Map(), demandsById = new Map(), statuses, includeDemands = true, includeTasks = true, includeDone = false, projectId = null } = {}) {
  const items = [];
  const keep = (entity) => entity && isValidDateStr(entity.due_date) && (isOpen(entity, statuses) || (includeDone && isDone(entity, statuses)));
  const inScope = (pid) => projectId === null || (projectId === '' ? !pid : pid === projectId);
  const projectName = (pid) => (pid && projectsById.get(pid) ? projectsById.get(pid).name : null);
  const base = (type, entity, pid) => {
    const status = statusById(statuses, entity.status);
    const priority = priorityById(entity.priority);
    return {
      type,
      id: entity.id,
      code: entityCode(type, entity),
      name: entity.name || '',
      due_date: entity.due_date,
      statusLabel: status ? status.label : entity.status || '',
      priority: priority.id,
      priorityLabel: priority.label,
      projectName: projectName(pid),
      description: entity.description || '',
    };
  };
  if (includeDemands) {
    for (const d of demands) {
      if (!keep(d) || !inScope(d.project_id || null)) continue;
      items.push({ ...base('demand', d, d.project_id || null), demandLabel: null, nextAction: d.next_action || '' });
    }
  }
  if (includeTasks) {
    for (const t of tasks) {
      const demand = t && t.demand_id ? demandsById.get(t.demand_id) || null : null;
      const pid = demand ? demand.project_id || null : null;
      if (!keep(t) || !inScope(pid)) continue;
      const demandLabel = demand ? [entityCode('demand', demand), demand.name].filter(Boolean).join(' ') : null;
      items.push({ ...base('task', t, pid), demandLabel, nextAction: demand ? demand.next_action || '' : '' });
    }
  }
  items.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.type === b.type ? String(a.code).localeCompare(String(b.code), 'pt-BR', { numeric: true }) : a.type === 'demand' ? -1 : 1));
  return items;
}

function summaryOf(item) {
  const prefix = item.projectName ? `[${item.projectName}] ` : '';
  return prefix + [item.code, item.name].filter(Boolean).join(' ');
}

function descriptionOf(item, link) {
  const lines = [`${item.type === 'task' ? 'Tarefa' : 'Demanda'} ${[item.code, item.name].filter(Boolean).join(' ')}`];
  lines.push(`Status: ${item.statusLabel}`);
  lines.push(`Prioridade: ${item.priority} (${item.priorityLabel})`);
  if (item.projectName) lines.push(`Projeto: ${item.projectName}`);
  if (item.demandLabel) lines.push(`Demanda: ${item.demandLabel}`);
  if (item.nextAction) lines.push(`Próxima ação${item.type === 'task' ? ' (demanda)' : ''}: ${item.nextAction}`);
  if (item.description) {
    const text = item.description.length > DESCRIPTION_LIMIT ? `${item.description.slice(0, DESCRIPTION_LIMIT)}…` : item.description;
    lines.push('', text);
  }
  lines.push('', `Abrir no Demand Manager: ${link}`);
  return lines.join('\n');
}

/**
 * Monta o arquivo .ics.
 * @param {object[]} items itens de collectCalendarItems
 * @param {{ appUrl: string, nowIso: string, calName?: string }} opts
 * @returns {string} texto com CRLF
 */
export function buildCalendar(items, { appUrl, nowIso, calName = ICS_CAL_NAME } = {}) {
  const stamp = icsTimestamp(nowIso);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Demand Manager//PT-BR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(calName)}`];
  for (const item of items || []) {
    if (!item || !isValidDateStr(item.due_date)) continue;
    const link = entityLink(appUrl, item.type, item.id);
    const summary = summaryOf(item);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${item.type}-${item.id}@demand-manager`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(item.due_date)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(item.due_date, 1))}`,
      `SUMMARY:${escapeText(summary)}`,
      `DESCRIPTION:${escapeText(descriptionOf(item, link))}`,
      `URL:${link}`,
    );
    if (item.projectName) lines.push(`CATEGORIES:${escapeText(item.projectName)}`);
    lines.push('TRANSP:TRANSPARENT', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15H', `DESCRIPTION:${escapeText(`Prazo amanhã: ${summary}`)}`, 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}
