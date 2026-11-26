// Utilidades de data — puras, sem dependências.
//
// Convenções do app:
//   • "data" (prazo, início planejado, dia do apontamento, semana) = string 'YYYY-MM-DD' no fuso LOCAL.
//   • "instante" (criação, conclusão, início real, apontamentos)  = string ISO 8601 em UTC (Date#toISOString).
//   • A semana começa na SEGUNDA-FEIRA.
// Toda função que depende de "hoje"/"agora" aceita o valor por parâmetro (facilita os testes).

const pad = (n) => String(n).padStart(2, '0');

export const MONTHS = Object.freeze(['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']);
export const MONTHS_SHORT = Object.freeze(['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']);
/** Dias da semana começando na segunda (índice 0 = segunda). */
export const WEEKDAYS_SHORT = Object.freeze(['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']);
export const WEEKDAYS_LONG = Object.freeze(['segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo']);
export const WEEKDAYS_MIN = Object.freeze(['S', 'T', 'Q', 'Q', 'S', 'S', 'D']);

/** Date -> 'YYYY-MM-DD' (fuso local). */
export function toDateStr(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Data de hoje (local) como 'YYYY-MM-DD'. */
export function todayStr(now = new Date()) {
  return toDateStr(now);
}

/** Instante atual em ISO UTC. */
export function nowIso(now = new Date()) {
  return now.toISOString();
}

export function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** 'YYYY-MM-DD' -> Date à meia-noite local (null se inválida). */
export function parseDate(s) {
  if (!isValidDateStr(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Soma n dias (n pode ser negativo). */
export function addDays(s, n) {
  const d = parseDate(s);
  if (!d) return null;
  d.setDate(d.getDate() + n);
  return toDateStr(d);
}

/** Soma n meses, limitando o dia ao último dia do mês de destino (31/jan + 1 mês = 28 ou 29/fev). */
export function addMonths(s, n) {
  const d = parseDate(s);
  if (!d) return null;
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, last));
  return toDateStr(target);
}

function utcDayNumber(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/** Diferença em dias inteiros: diffDays('2026-11-20', '2026-11-21') === 1 (b − a). Imune a horário de verão. */
export function diffDays(a, b) {
  if (!isValidDateStr(a) || !isValidDateStr(b)) return null;
  return utcDayNumber(b) - utcDayNumber(a);
}

/** Comparador de datas; valores vazios vão para o fim. */
export function compareDates(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function minDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

export function maxDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

/** Instante ISO -> data local 'YYYY-MM-DD' (null se inválido). */
export function isoToDateStr(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : toDateStr(d);
}

/** Data local -> instante ISO do início (00:00:00.000) ou do fim (23:59:59.999) daquele dia. */
export function dateStrToIso(s, edge = 'start') {
  const d = parseDate(s);
  if (!d) return null;
  if (edge === 'end') d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/** Junta data local + hora 'HH:MM' -> instante ISO. */
export function combineDateTime(dateStr, time) {
  const d = parseDate(dateStr);
  if (!d || typeof time !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

/** Instante ISO -> 'HH:MM' no fuso local. */
export function timeOfIso(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Índice do dia da semana com segunda = 0 … domingo = 6. */
export function weekdayIndex(s) {
  const d = parseDate(s);
  return d ? (d.getDay() + 6) % 7 : null;
}

export function isWeekend(s) {
  const i = weekdayIndex(s);
  return i === 5 || i === 6;
}

/** Segunda-feira da semana que contém a data. */
export function startOfWeek(s) {
  const i = weekdayIndex(s);
  return i === null ? null : addDays(s, -i);
}

/** Domingo da semana que contém a data. */
export function endOfWeek(s) {
  const st = startOfWeek(s);
  return st ? addDays(st, 6) : null;
}

/** Os 7 dias (seg…dom) da semana que começa em weekStart. */
export function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function startOfMonth(s) {
  return isValidDateStr(s) ? `${s.slice(0, 8)}01` : null;
}

export function endOfMonth(s) {
  const d = parseDate(s);
  if (!d) return null;
  return toDateStr(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/** 'YYYY-MM' da data. */
export function monthKey(s) {
  return isValidDateStr(s) ? s.slice(0, 7) : null;
}

/**
 * Matriz do calendário mensal: semanas (seg…dom) cobrindo o mês inteiro,
 * incluindo os dias de transbordo dos meses vizinhos. month0: 0 = janeiro.
 */
export function monthMatrix(year, month0) {
  const first = toDateStr(new Date(year, month0, 1));
  const last = toDateStr(new Date(year, month0 + 1, 0));
  const weeks = [];
  let cursor = startOfWeek(first);
  while (cursor <= last) {
    weeks.push(weekDays(cursor));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

/** Lista de datas de from até to (inclusive). */
export function rangeDays(from, to) {
  const out = [];
  if (!isValidDateStr(from) || !isValidDateStr(to)) return out;
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Semana ISO (ano, número) da data. */
export function isoWeek(s) {
  const d = parseDate(s);
  if (!d) return null;
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}

/** Quantidade de dias úteis (seg–sex) entre from e to, inclusive nas duas pontas. 0 se to < from. */
export function countWorkdays(from, to) {
  if (!isValidDateStr(from) || !isValidDateStr(to) || to < from) return 0;
  const total = diffDays(from, to) + 1;
  const fullWeeks = Math.floor(total / 7);
  let count = fullWeeks * 5;
  let d = addDays(from, fullWeeks * 7);
  for (let i = 0; i < total % 7; i++) {
    if (!isWeekend(d)) count++;
    d = addDays(d, 1);
  }
  return count;
}

/** Avança n dias úteis a partir da data (n >= 0). Com n = 0 devolve o próximo dia útil (ou a própria data, se útil). */
export function addWorkdays(s, n) {
  let d = s;
  if (!isValidDateStr(d)) return null;
  while (isWeekend(d)) d = addDays(d, 1);
  let left = Math.max(0, Math.floor(n));
  while (left > 0) {
    d = addDays(d, 1);
    if (!isWeekend(d)) left--;
  }
  return d;
}

/**
 * Formata uma data local.
 *   'short'    21 nov            (acrescenta o ano se não for o ano corrente)
 *   'long'     21 de novembro de 2026
 *   'numeric'  21/11/2026
 *   'daymonth' 21/11
 *   'weekday'  sáb, 21 nov
 *   'month'    novembro de 2026
 */
export function formatDate(s, style = 'short', today = todayStr()) {
  const d = parseDate(s);
  if (!d) return '';
  const day = d.getDate();
  const m = d.getMonth();
  const y = d.getFullYear();
  const sameYear = String(y) === String(today).slice(0, 4);
  switch (style) {
    case 'long':
      return `${day} de ${MONTHS[m]} de ${y}`;
    case 'numeric':
      return `${pad(day)}/${pad(m + 1)}/${y}`;
    case 'daymonth':
      return `${pad(day)}/${pad(m + 1)}`;
    case 'weekday':
      return `${WEEKDAYS_SHORT[(d.getDay() + 6) % 7]}, ${day} ${MONTHS_SHORT[m]}${sameYear ? '' : ' ' + y}`;
    case 'month':
      return `${MONTHS[m]} de ${y}`;
    default:
      return `${day} ${MONTHS_SHORT[m]}${sameYear ? '' : ' ' + y}`;
  }
}

/** Instante ISO -> '21/11/2026 14:35' (local). */
export function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Instante ISO -> '14:35' (local). */
export function formatTime(iso) {
  return timeOfIso(iso);
}

/** Texto relativo de uma data: 'hoje', 'amanhã', 'ontem', 'em 3 dias', 'há 2 dias'. */
export function relativeDay(s, today = todayStr()) {
  const n = diffDays(today, s);
  if (n === null) return '';
  if (n === 0) return 'hoje';
  if (n === 1) return 'amanhã';
  if (n === -1) return 'ontem';
  return n > 0 ? `em ${n} dias` : `há ${-n} dias`;
}

/** Texto relativo de um instante: 'agora', 'há 5 min', 'há 2 h', 'ontem', 'há 3 dias', '21 nov'. */
export function formatRelativeTime(iso, now = new Date()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sec = Math.round((now.getTime() - d.getTime()) / 1000);
  if (sec < 45) return 'agora';
  if (sec < 3600) return `há ${Math.max(1, Math.round(sec / 60))} min`;
  const days = diffDays(toDateStr(d), toDateStr(now));
  if (days === 0) return `há ${Math.max(1, Math.round(sec / 3600))} h`;
  if (days === 1) return 'ontem';
  if (days < 7) return `há ${days} dias`;
  return formatDate(toDateStr(d), 'short', toDateStr(now));
}

/** Rótulo da semana: '16–22 nov 2026' ou '30 nov – 6 dez 2026'. */
export function formatWeekRange(weekStart) {
  const a = parseDate(weekStart);
  const b = parseDate(addDays(weekStart, 6));
  if (!a || !b) return '';
  if (a.getMonth() === b.getMonth()) {
    return `${a.getDate()}–${b.getDate()} ${MONTHS_SHORT[b.getMonth()]} ${b.getFullYear()}`;
  }
  return `${a.getDate()} ${MONTHS_SHORT[a.getMonth()]} – ${b.getDate()} ${MONTHS_SHORT[b.getMonth()]} ${b.getFullYear()}`;
}

/** Milissegundos de um instante ISO (NaN se inválido). */
export function ms(iso) {
  return iso ? new Date(iso).getTime() : NaN;
}
