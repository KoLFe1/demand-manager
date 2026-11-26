// Tarefas recorrentes — regras puras (sem DOM, sem relógio implícito).
//
// Regra (campo tasks.recurrence, JSON; null = não se repete):
//   { freq: 'daily'|'weekdays'|'weekly'|'biweekly'|'monthly'|'yearly',
//     basis: 'due' (a partir do prazo, padrão) | 'completion' (a partir da conclusão),
//     dayOfMonth?: 1..31  (mensal: dia original do mês, ex.: 31 → 28/29 fev → 31 mar),
//     weekday?: 0..6      (semanal/quinzenal: dia da semana, segunda = 0) }
//
// Ao concluir uma tarefa recorrente, o comando cria a próxima ocorrência com prazo = nextOccurrence(...).

import { addDays, addMonths, isValidDateStr, parseDate, toDateStr, weekdayIndex, isWeekend, WEEKDAYS_LONG } from '../core/dates.js';

export const RECURRENCE_FREQS = Object.freeze(['daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly']);
export const RECURRENCE_BASES = Object.freeze(['due', 'completion']);

/** Opções do seletor "Repetir" (id '' = não repete). */
export const RECURRENCE_OPTIONS = Object.freeze([
  Object.freeze({ id: '', label: 'Não repete' }),
  Object.freeze({ id: 'daily', label: 'Diariamente' }),
  Object.freeze({ id: 'weekdays', label: 'Dias úteis' }),
  Object.freeze({ id: 'weekly', label: 'Semanalmente' }),
  Object.freeze({ id: 'biweekly', label: 'Quinzenalmente' }),
  Object.freeze({ id: 'monthly', label: 'Mensalmente' }),
  Object.freeze({ id: 'yearly', label: 'Anualmente' }),
]);

const FREQ_SET = new Set(RECURRENCE_FREQS);

export class RecurrenceError extends Error {
  constructor(message, data = null) {
    super(message);
    this.name = 'RecurrenceError';
    this.code = 'invalid_recurrence';
    this.data = data;
  }
}

/**
 * Valida e normaliza uma regra. null/undefined/'' → null (não se repete).
 * @throws {RecurrenceError} regra inválida
 */
export function normalizeRecurrence(rule) {
  if (rule === null || rule === undefined || rule === '') return null;
  if (typeof rule !== 'object' || Array.isArray(rule)) throw new RecurrenceError('Regra de repetição inválida.');
  if (!FREQ_SET.has(rule.freq)) throw new RecurrenceError(`Frequência de repetição desconhecida: ${String(rule.freq)}.`, { freq: rule.freq });
  const basis = rule.basis === undefined || rule.basis === null ? 'due' : rule.basis;
  if (!RECURRENCE_BASES.includes(basis)) throw new RecurrenceError('A repetição conta a partir do prazo ou da conclusão.', { basis });
  const out = { freq: rule.freq, basis };
  if (rule.freq === 'monthly' && rule.dayOfMonth !== undefined && rule.dayOfMonth !== null) {
    if (!Number.isInteger(rule.dayOfMonth) || rule.dayOfMonth < 1 || rule.dayOfMonth > 31) {
      throw new RecurrenceError('O dia do mês da repetição precisa ser de 1 a 31.', { dayOfMonth: rule.dayOfMonth });
    }
    out.dayOfMonth = rule.dayOfMonth;
  }
  if ((rule.freq === 'weekly' || rule.freq === 'biweekly') && rule.weekday !== undefined && rule.weekday !== null) {
    if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) {
      throw new RecurrenceError('O dia da semana da repetição precisa ser de 0 (segunda) a 6 (domingo).', { weekday: rule.weekday });
    }
    out.weekday = rule.weekday;
  }
  return out;
}

/** Versão tolerante (dados vindos de outro aparelho/versão): regra normalizada ou null, nunca lança. */
export function parseRecurrence(rule) {
  try {
    return normalizeRecurrence(rule);
  } catch {
    return null;
  }
}

/** Data a partir da qual a próxima ocorrência é contada (ou null quando não há nenhuma). */
export function occurrenceBase(rule, { dueDate = null, completedDate = null } = {}) {
  const r = parseRecurrence(rule);
  if (!r) return null;
  const due = isValidDateStr(dueDate) ? dueDate : null;
  const done = isValidDateStr(completedDate) ? completedDate : null;
  return r.basis === 'completion' ? done || due : due || done;
}

/** Mesmo dia do mês `months` meses depois, limitado ao fim do mês (31 → 28/29 fev → 31 mar com dayOfMonth=31). */
function monthsLater(base, months, day) {
  const d = parseDate(base);
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, last));
  return toDateStr(target);
}

/**
 * Próximo prazo ('YYYY-MM-DD') de uma tarefa recorrente.
 *   basis 'due' → conta do prazo atual (sem prazo: da data de conclusão);
 *   basis 'completion' → conta da data de conclusão (sem ela: do prazo).
 * @param {object} rule regra de repetição
 * @param {{ dueDate?: string|null, completedDate?: string|null }} ctx datas LOCAIS 'YYYY-MM-DD'
 * @returns {string|null}
 */
export function nextOccurrence(rule, ctx = {}) {
  const r = parseRecurrence(rule);
  const base = occurrenceBase(r, ctx);
  if (!r || !base) return null;
  switch (r.freq) {
    case 'daily':
      return addDays(base, 1);
    case 'weekdays': {
      let next = addDays(base, 1);
      while (isWeekend(next)) next = addDays(next, 1);
      return next;
    }
    case 'weekly':
    case 'biweekly': {
      const weeks = r.freq === 'weekly' ? 1 : 2;
      if (r.weekday === undefined) return addDays(base, 7 * weeks);
      // Primeiro dia com aquele dia da semana DEPOIS da base; quinzenal pula mais uma semana.
      let ahead = (r.weekday - weekdayIndex(base) + 7) % 7;
      if (ahead === 0) ahead = 7;
      return addDays(base, ahead + 7 * (weeks - 1));
    }
    case 'monthly':
      return monthsLater(base, 1, r.dayOfMonth || parseDate(base).getDate());
    case 'yearly':
      return addMonths(base, 12);
    default:
      return null;
  }
}

/**
 * Próximo prazo que não fica no passado: com basis 'due', avança a regra repetidamente (mantendo a cadência e,
 * no mensal, o dia do mês) até a primeira ocorrência >= `today`. Ex.: semanal com prazo há 3 semanas concluída
 * hoje → próxima nesta semana ou na seguinte. basis 'completion' já conta de hoje (igual a nextOccurrence).
 * @param {object} rule regra (use carriedRecurrence para fixar o dia do mês)
 * @param {{ dueDate?: string|null, completedDate?: string|null, today?: string|null, maxSteps?: number }} ctx
 * @returns {string|null}
 */
export function nextOccurrenceFrom(rule, ctx = {}) {
  const r = parseRecurrence(rule);
  let next = nextOccurrence(r, ctx);
  if (!r || !next || r.basis !== 'due' || !isValidDateStr(ctx.today)) return next;
  const cap = Number.isInteger(ctx.maxSteps) && ctx.maxSteps > 0 ? ctx.maxSteps : 1000;
  for (let i = 0; i < cap && next < ctx.today; i++) {
    const after = nextOccurrence(r, { dueDate: next });
    if (!after || after <= next) break;
    next = after;
  }
  return next;
}

/**
 * Regra que a próxima ocorrência herda: no mensal a partir do prazo, fixa o dia original do mês (senão
 * 31/jan → 28/fev → 28/mar). Devolve a regra normalizada (ou null).
 */
export function carriedRecurrence(rule, ctx = {}) {
  const r = parseRecurrence(rule);
  if (!r) return null;
  if (r.freq === 'monthly' && r.basis === 'due' && !r.dayOfMonth) {
    const base = occurrenceBase(r, ctx);
    if (base) return { ...r, dayOfMonth: parseDate(base).getDate() };
  }
  return r;
}

/** Rótulo pt-BR da regra ("Toda semana", "Todo mês no dia 31", "Dias úteis"…). '' quando não se repete. */
export function describeRecurrence(rule) {
  const r = parseRecurrence(rule);
  if (!r) return '';
  let text;
  switch (r.freq) {
    case 'daily':
      text = 'Todo dia';
      break;
    case 'weekdays':
      text = 'Dias úteis';
      break;
    case 'weekly':
      text = r.weekday === undefined ? 'Toda semana' : `Toda semana (${WEEKDAYS_LONG[r.weekday]})`;
      break;
    case 'biweekly':
      text = r.weekday === undefined ? 'A cada 2 semanas' : `A cada 2 semanas (${WEEKDAYS_LONG[r.weekday]})`;
      break;
    case 'monthly':
      text = r.dayOfMonth ? `Todo mês no dia ${r.dayOfMonth}` : 'Todo mês';
      break;
    case 'yearly':
      text = 'Todo ano';
      break;
    default:
      text = '';
  }
  return r.basis === 'completion' ? `${text}, a partir da conclusão` : text;
}
