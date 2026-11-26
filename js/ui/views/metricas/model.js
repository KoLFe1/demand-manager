// Tela "Métricas" — peças PURAS (sem DOM): períodos, formatação dos indicadores, comparação com o período
// anterior, exportação em CSV e a lista de impedimentos mais antigos.
//
// Tudo aqui recebe "hoje"/"agora" por parâmetro (nunca consulta o relógio do sistema) e não altera nada.

import { MONTHS_SHORT, addDays, addMonths, diffDays, endOfMonth, isValidDateStr, parseDate, startOfMonth } from '../../../core/dates.js';
import { formatNumber, formatPercent } from '../../../core/format.js';
import { METRIC_LABELS } from '../../../domain/metrics.js';
import { eventsOf, spansOfCategories, statusIntervals } from '../../../domain/timeline.js';
import { formatDuration } from '../../../domain/timetracking.js';
import { csvField } from '../tempo/model.js';

// ---------------------------------------------------------------------------
// Períodos
// ---------------------------------------------------------------------------

/** Atalhos de período, na ordem do menu. */
export const PERIOD_PRESETS = Object.freeze([
  Object.freeze({ id: '7d', label: 'Últimos 7 dias', short: '7 dias' }),
  Object.freeze({ id: '30d', label: 'Últimos 30 dias', short: '30 dias' }),
  Object.freeze({ id: '90d', label: 'Últimos 90 dias', short: '90 dias' }),
  Object.freeze({ id: 'month', label: 'Este mês', short: 'Este mês' }),
  Object.freeze({ id: 'lastMonth', label: 'Mês passado', short: 'Mês passado' }),
  Object.freeze({ id: 'year', label: 'Este ano', short: 'Este ano' }),
  Object.freeze({ id: 'custom', label: 'Personalizado', short: 'Personalizado' }),
]);

/** Período padrão da tela. */
export const DEFAULT_PRESET = '30d';

/** Acima deste número de dias o gráfico de vazão mensal aparece (≈ 6 semanas). */
export const MONTHLY_MIN_DAYS = 43;

const PRESET_IDS = new Set(PERIOD_PRESETS.map((p) => p.id));

/** Atalho válido (ou o padrão). */
export function normalizePreset(id) {
  return PRESET_IDS.has(id) ? id : DEFAULT_PRESET;
}

/** Rótulo de um atalho de período. */
export function presetLabel(id) {
  const found = PERIOD_PRESETS.find((p) => p.id === id);
  return found ? found.label : PERIOD_PRESETS[1].label;
}

/**
 * Período atual e período anterior (para a comparação) a partir do estado da tela.
 *
 *   resolvePeriod({ preset: '30d' }, '2026-11-26')
 *     → { preset: '30d', from: '2026-10-28', to: '2026-11-26', days: 30,
 *         previous: { from: '2026-09-28', to: '2026-10-27', days: 30 } }
 *
 * Regras do período anterior: "Este mês" compara com os mesmos dias do mês anterior; "Mês passado", com o mês
 * inteiro anterior a ele; "Este ano", com o mesmo trecho do ano anterior; os demais, com os N dias imediatamente
 * anteriores (mesma duração).
 *
 * @param {{ preset?: string, from?: string, to?: string }} state estado salvo da tela
 * @param {string} today data de hoje ('YYYY-MM-DD')
 * @returns {{ preset: string, from: string, to: string, days: number, previous: { from: string, to: string, days: number } }}
 */
export function resolvePeriod(state, today) {
  const s = state && typeof state === 'object' ? state : {};
  const preset = normalizePreset(s.preset);
  let from;
  let to = today;
  let previous = null;
  switch (preset) {
    case '7d':
    case '30d':
    case '90d': {
      const n = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
      from = addDays(today, -(n - 1));
      break;
    }
    case 'month': {
      from = startOfMonth(today);
      const prevStart = addMonths(from, -1);
      const prevEnd = addMonths(today, -1); // mesmo dia do mês anterior (limitado ao último dia)
      previous = { from: prevStart, to: prevEnd };
      break;
    }
    case 'lastMonth': {
      from = startOfMonth(addMonths(startOfMonth(today), -1));
      to = endOfMonth(from);
      const prevStart = addMonths(from, -1);
      previous = { from: prevStart, to: endOfMonth(prevStart) };
      break;
    }
    case 'year': {
      from = `${today.slice(0, 4)}-01-01`;
      previous = { from: addMonths(from, -12), to: addMonths(today, -12) };
      break;
    }
    default: {
      // personalizado: datas salvas; sem elas (ou inválidas), os últimos 30 dias
      const a = isValidDateStr(s.from) ? s.from : null;
      const b = isValidDateStr(s.to) ? s.to : null;
      if (a && b) {
        from = a <= b ? a : b;
        to = a <= b ? b : a;
      } else {
        from = addDays(today, -29);
      }
    }
  }
  const days = diffDays(from, to) + 1;
  if (!previous) previous = { from: addDays(from, -days), to: addDays(from, -1) };
  previous.days = diffDays(previous.from, previous.to) + 1;
  return { preset, from, to, days, previous };
}

/**
 * Texto de um período: '28 out – 26 nov 2026', '1–30 nov 2026', '15 dez 2025 – 13 jan 2026', '26 nov 2026'.
 * @param {string} from
 * @param {string} to
 * @returns {string}
 */
export function formatRange(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return '';
  const end = `${b.getDate()} ${MONTHS_SHORT[b.getMonth()]} ${b.getFullYear()}`;
  if (from === to) return end;
  if (a.getFullYear() !== b.getFullYear()) return `${a.getDate()} ${MONTHS_SHORT[a.getMonth()]} ${a.getFullYear()} – ${end}`;
  if (a.getMonth() === b.getMonth()) return `${a.getDate()}–${end}`;
  return `${a.getDate()} ${MONTHS_SHORT[a.getMonth()]} – ${end}`;
}

/** Rótulo curto de uma semana para o eixo: '16/11'. */
export function weekLabel(weekStart) {
  const d = parseDate(weekStart);
  return d ? `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}` : '';
}

/** Rótulo de um mês 'YYYY-MM' para o eixo: 'nov' (ou 'nov/25' quando o período cruza anos). */
export function monthLabel(month, withYear = false) {
  const [y, m] = String(month).split('-').map(Number);
  if (!y || !m) return '';
  return withYear ? `${MONTHS_SHORT[m - 1]}/${String(y).slice(2)}` : MONTHS_SHORT[m - 1];
}

// ---------------------------------------------------------------------------
// Formatação dos valores
// ---------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Casas decimais "sensatas" para dias: 1 casa abaixo de 10, inteiro acima. */
function dayDigits(v) {
  return Math.abs(v) < 10 ? 1 : 0;
}

/**
 * Valor de um indicador pronto para a tela, separado em número e unidade.
 *   formatValue(3, 'count', { one: 'tarefa', many: 'tarefas' }) → { text: '3', unit: 'tarefas' }
 *   formatValue(4.25, 'days') → { text: '4,3', unit: 'dias' }
 *   formatValue(0.833, 'ratio') → { text: '83%', unit: '' }
 *   formatValue(5400, 'seconds') → { text: '1h 30min', unit: '' }
 *   formatValue(30, 'hours') → { text: '30', unit: 'h' };  formatValue(80, 'hours') → { text: '3,3', unit: 'dias' }
 *   formatValue(null, …) → { text: '—', unit: '', empty: true }
 * @param {number|null} value
 * @param {'count'|'days'|'ratio'|'seconds'|'minutes'|'hours'} unit
 * @param {{ one?: string, many?: string }} [nouns] unidade das contagens (singular/plural)
 * @returns {{ text: string, unit: string, empty?: boolean }}
 */
export function formatValue(value, unit, nouns = {}) {
  if (!isNum(value)) return { text: '—', unit: '', empty: true };
  switch (unit) {
    case 'count':
      return { text: formatNumber(value), unit: value === 1 ? nouns.one || '' : nouns.many || '' };
    case 'days': {
      const text = formatNumber(value, dayDigits(value));
      return { text, unit: text === '1' ? 'dia' : 'dias' };
    }
    case 'ratio':
      return { text: formatRatio(value), unit: '' };
    case 'seconds':
      return { text: formatDuration(value), unit: '' };
    case 'minutes':
      return { text: formatNumber(value / 60, value / 60 < 100 ? 1 : 0), unit: 'h' };
    case 'hours':
      return formatHoursValue(value);
    default:
      return { text: formatNumber(value, Number.isInteger(value) ? 0 : 1), unit: '' };
  }
}

/** Percentual "sensato": uma casa decimal só quando o valor é pequeno e não inteiro. */
export function formatRatio(value) {
  if (!isNum(value)) return '—';
  const pct = Math.round(value * 1000) / 10; // décimos de ponto percentual, sem ruído binário
  return formatPercent(value, pct > 0 && pct < 10 && !Number.isInteger(pct) ? 1 : 0);
}

/** Horas → '5,5 h' (até 48 h) ou '3,2 dias' (acima disso). */
export function formatHoursValue(hours) {
  if (!isNum(hours)) return { text: '—', unit: '', empty: true };
  if (Math.abs(hours) >= 48) {
    const d = hours / 24;
    return { text: formatNumber(d, dayDigits(d)), unit: 'dias' };
  }
  if (Math.abs(hours) < 1) return { text: formatDuration(hours * 3600), unit: '' };
  return { text: formatNumber(hours, Math.abs(hours) < 10 ? 1 : 0), unit: 'h' };
}

/** Valor + unidade num texto só ('4,3 dias', '83%', '1h 30min'). */
export function valueText(value, unit, nouns) {
  const v = formatValue(value, unit, nouns);
  return v.unit ? `${v.text} ${v.unit}` : v.text;
}

// ---------------------------------------------------------------------------
// Comparação com o período anterior
// ---------------------------------------------------------------------------

/**
 * Sentido "bom" de cada indicador: 'up' = subir é bom, 'down' = subir é ruim, null = neutro.
 * (Indicadores de volume de trabalho em aberto ficam neutros: mais trabalho não é bom nem ruim por si.)
 */
export const POLARITY = Object.freeze({
  tasksCompleted: 'up',
  demandsCompleted: 'up',
  leadTimeAvgDays: 'down',
  cycleTimeAvgDays: 'down',
  reworkRate: 'down',
  avgTimePerTaskSeconds: null,
  onTimeRate: 'up',
  overdueOpen: 'down',
  avgDelayDays: 'down',
  weeklyAdherence: 'up',
  wip: null,
  pending: null,
  avgOpenAgeDays: 'down',
  estimatedMinutesOpen: null,
  actualSecondsInRange: null,
  blockedNow: 'down',
  avgBlockedHours: 'down',
  pendingDependencies: 'down',
  waitingNow: 'down',
});

/** Diferenças menores que isto (na unidade do indicador) contam como "igual". */
const EPSILON = { count: 0, days: 0.05, ratio: 0.0005, seconds: 30, minutes: 0.5, hours: 0.05 };

/**
 * Variação de um indicador em relação ao período anterior.
 *
 *   computeDelta(12, 9, 'count', 'up') → { direction: 'up', good: true, text: '+3', sign: 1 }
 *   computeDelta(0.8, 0.85, 'ratio', 'up') → { direction: 'down', good: false, text: '−5 p.p.' }
 *
 * @param {number|null} current
 * @param {number|null} previous
 * @param {'count'|'days'|'ratio'|'seconds'|'minutes'|'hours'} unit
 * @param {'up'|'down'|null} polarity
 * @returns {{ direction: 'up'|'down'|'flat', good: boolean|null, text: string }|null} null quando não dá para comparar
 */
export function computeDelta(current, previous, unit, polarity) {
  if (!isNum(current) || !isNum(previous)) return null;
  const diff = current - previous;
  const eps = EPSILON[unit] ?? 0;
  if (Math.abs(diff) <= eps) return { direction: 'flat', good: null, text: 'igual' };
  const direction = diff > 0 ? 'up' : 'down';
  const good = polarity === 'up' ? diff > 0 : polarity === 'down' ? diff < 0 : null;
  const sign = diff > 0 ? '+' : '−';
  const abs = Math.abs(diff);
  let amount;
  switch (unit) {
    case 'count':
      amount = formatNumber(abs);
      break;
    case 'days':
      amount = `${formatNumber(abs, dayDigits(abs))} d`;
      break;
    case 'ratio': {
      const pp = Math.round(abs * 1000) / 10;
      amount = `${formatNumber(pp, pp < 10 && !Number.isInteger(pp) ? 1 : 0)} p.p.`;
      break;
    }
    case 'seconds':
      amount = formatDuration(abs);
      break;
    case 'minutes':
      amount = `${formatNumber(abs / 60, 1)} h`;
      break;
    case 'hours': {
      const v = formatHoursValue(abs);
      amount = v.unit ? `${v.text} ${v.unit === 'dias' ? 'd' : v.unit}` : v.text;
      break;
    }
    default:
      amount = formatNumber(abs, 1);
  }
  return { direction, good, text: `${sign}${amount}` };
}

// ---------------------------------------------------------------------------
// Dados "existem"?
// ---------------------------------------------------------------------------

/** O resultado de computeMetrics tem alguma coisa para mostrar? */
export function hasAnyData(m) {
  if (!m) return false;
  const p = m.productivity;
  const c = m.capacity;
  const b = m.blocking;
  if (p.tasksCompleted || p.demandsCompleted) return true;
  if (c.pending || c.actualSecondsInRange) return true;
  if (b.blockedNow || b.waitingNow || b.blockedHoursInRange || b.waitingHoursInRange) return true;
  if (m.deadlines.plannedVsDone.some((w) => w.planned || w.added)) return true;
  return c.wipSeries.some((point) => point.open > 0);
}

const firstActivityCache = new WeakMap();

/**
 * Data local do primeiro evento do histórico (para saber se o período anterior tem como ser comparado).
 * Memorizado pela identidade da lista (o store devolve a mesma lista enquanto a tabela não muda).
 * @param {ReadonlyArray<{ at?: string }>} activity
 * @param {(iso: string) => string|null} toDate conversor de instante para data local
 * @returns {string|null}
 */
export function firstActivityDate(activity, toDate) {
  if (!Array.isArray(activity) || activity.length === 0) return null;
  if (firstActivityCache.has(activity)) return firstActivityCache.get(activity);
  let min = null;
  for (const ev of activity) {
    const at = ev && typeof ev.at === 'string' ? ev.at : null;
    if (at && (min === null || at < min)) min = at;
  }
  const date = min ? toDate(min) : null;
  firstActivityCache.set(activity, date);
  return date;
}

// ---------------------------------------------------------------------------
// Impedimentos mais antigos (bloqueadas / aguardando agora)
// ---------------------------------------------------------------------------

/**
 * Tarefas bloqueadas ou aguardando terceiros AGORA, das que estão assim há mais tempo para as mais recentes.
 * O início do impedimento vem da linha do tempo de status (timeline.js), não de updated_at.
 *
 * @param {object} input
 * @param {ReadonlyArray<object>} input.tasks tarefas visíveis (sel.tasks())
 * @param {ReadonlyArray<object>} input.statuses lista efetiva de status
 * @param {ReadonlyMap<string, object[]>} input.eventsIndex índice 'tipo:id' → eventos (sel.eventsIndex())
 * @param {string} input.nowIso
 * @param {(task: object) => boolean} [input.accept] filtro de escopo (projeto/demanda/status)
 * @param {number} [input.limit=6]
 * @returns {{ items: Array<{ task: object, category: 'blocked'|'waiting', since: string, seconds: number }>, total: number }}
 */
export function longestImpediments({ tasks, statuses, eventsIndex, nowIso, accept, limit = 6 }) {
  const byId = new Map((Array.isArray(statuses) ? statuses : []).map((s) => [s.id, s]));
  const nowMs = new Date(nowIso).getTime();
  const found = [];
  for (const task of tasks || []) {
    const def = byId.get(task.status);
    const category = def ? def.category : null;
    if (category !== 'blocked' && category !== 'waiting') continue;
    if (typeof accept === 'function' && !accept(task)) continue;
    const intervals = statusIntervals(task, eventsOf(eventsIndex, 'task', task.id), { statuses, nowIso });
    const spans = spansOfCategories(intervals, [category]);
    const last = spans[spans.length - 1];
    const since = last && last.open ? last.from : task.updated_at || task.created_at || nowIso;
    const seconds = Math.max(0, Math.floor((nowMs - new Date(since).getTime()) / 1000));
    found.push({ task, category, since, seconds });
  }
  found.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : String(a.task.id) < String(b.task.id) ? -1 : 1));
  return { items: found.slice(0, Math.max(0, limit)), total: found.length };
}

/** Há quanto tempo: '3 dias', '5 h', '20 min'. */
export function elapsedText(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const days = s / 86400;
  if (days >= 1) {
    const n = Math.floor(days);
    return n === 1 ? '1 dia' : `${n} dias`;
  }
  const hours = Math.floor(s / 3600);
  if (hours >= 1) return `${hours} h`;
  return `${Math.max(1, Math.floor(s / 60))} min`;
}

// ---------------------------------------------------------------------------
// Exportação em CSV
// ---------------------------------------------------------------------------

/** Número com vírgula decimal e sem separador de milhar (bom para planilhas em pt-BR). */
function csvNumber(value, digits = 2) {
  if (!isNum(value)) return '';
  const fixed = Number(value.toFixed(digits));
  return String(fixed).replace('.', ',');
}

/** Célula do CSV: mesma regra do CSV de Tempo (aspas quando necessário e proteção contra fórmulas). */
const csvCell = csvField;

/**
 * Linhas (indicador, valor, unidade) dos indicadores de um resultado de computeMetrics.
 * Médias saem com duas casas; percentuais em % (0–100); durações em horas decimais.
 *
 * @param {object} m resultado de computeMetrics
 * @param {{ from: string, to: string, project?: string, demand?: string, statuses?: string }} meta descrição da seleção
 * @returns {Array<[string, string, string]>}
 */
export function metricsCsvRows(m, meta) {
  const L = (key) => (METRIC_LABELS[key] ? METRIC_LABELS[key].label : key);
  const rows = [];
  const add = (label, value, unit) => rows.push([label, value, unit]);
  const count = (key, value, unit) => add(L(key), isNum(value) ? String(value) : '', unit);
  const pct = (key, value) => add(L(key), isNum(value) ? csvNumber(value * 100, 1) : '', '%');
  const days = (key, value) => add(L(key), csvNumber(value), 'dias');
  const hours = (label, seconds) => add(label, isNum(seconds) ? csvNumber(seconds / 3600) : '', 'horas');

  add('Período — início', meta.from, 'data');
  add('Período — fim', meta.to, 'data');
  add('Filtro de projeto', meta.project || 'Todos', 'filtro');
  add('Filtro de demanda', meta.demand || 'Todas', 'filtro');
  add('Filtro de status', meta.statuses || 'Todos', 'filtro');

  const p = m.productivity;
  count('tasksCompleted', p.tasksCompleted, 'tarefas');
  count('demandsCompleted', p.demandsCompleted, 'demandas');
  days('leadTimeAvgDays', p.leadTimeAvgDays);
  days('leadTimeMedianDays', p.leadTimeMedianDays);
  days('cycleTimeAvgDays', p.cycleTimeAvgDays);
  days('cycleTimeMedianDays', p.cycleTimeMedianDays);
  pct('reworkRate', p.reworkRate);
  count('reworkCount', p.reworkCount, 'tarefas');
  hours(L('avgTimePerTaskSeconds'), p.avgTimePerTaskSeconds);
  for (const w of p.throughputWeekly) {
    add(`${L('throughputWeekly')} — semana de ${w.weekStart} (tarefas)`, String(w.tasks), 'tarefas');
    add(`${L('throughputWeekly')} — semana de ${w.weekStart} (demandas)`, String(w.demands), 'demandas');
  }
  for (const mo of p.throughputMonthly) {
    add(`${L('throughputMonthly')} — ${mo.month} (tarefas)`, String(mo.tasks), 'tarefas');
    add(`${L('throughputMonthly')} — ${mo.month} (demandas)`, String(mo.demands), 'demandas');
  }

  const d = m.deadlines;
  pct('onTimeRate', d.onTimeRate);
  count('completedWithDue', d.completedWithDue, 'tarefas');
  count('completedOnTime', d.completedOnTime, 'tarefas');
  count('completedLate', d.completedLate, 'tarefas');
  count('overdueOpen', d.overdueOpen, 'tarefas');
  days('avgDelayDays', d.avgDelayDays);
  days('avgOverdueDays', d.avgOverdueDays);
  pct('weeklyAdherence', d.weeklyAdherence);
  for (const w of d.plannedVsDone) {
    add(`${L('plannedVsDone')} — semana de ${w.weekStart} (planejadas)`, String(w.planned), 'tarefas');
    add(`${L('plannedVsDone')} — semana de ${w.weekStart} (adicionadas)`, String(w.added), 'tarefas');
    add(`${L('plannedVsDone')} — semana de ${w.weekStart} (concluídas)`, String(w.completed), 'tarefas');
  }

  const c = m.capacity;
  count('wip', c.wip, 'tarefas');
  count('inFlight', c.inFlight, 'tarefas');
  count('pending', c.pending, 'tarefas');
  add(L('estimatedMinutesOpen'), csvNumber(c.estimatedMinutesOpen / 60), 'horas');
  add(L('estimatedMinutesCompleted'), csvNumber(c.estimatedMinutesCompleted / 60), 'horas');
  hours(L('actualSecondsCompleted'), c.actualSecondsCompleted);
  hours(L('actualSecondsInRange'), c.actualSecondsInRange);
  days('avgOpenAgeDays', c.avgOpenAgeDays);
  for (const item of c.hoursByProject) hours(`${L('hoursByProject')} — ${item.name}`, item.seconds);

  const b = m.blocking;
  count('blockedNow', b.blockedNow, 'tarefas');
  count('waitingNow', b.waitingNow, 'tarefas');
  add(L('avgBlockedHours'), csvNumber(b.avgBlockedHours), 'horas');
  add(L('avgWaitingHours'), csvNumber(b.avgWaitingHours), 'horas');
  add(L('blockedHoursInRange'), csvNumber(b.blockedHoursInRange), 'horas');
  add(L('waitingHoursInRange'), csvNumber(b.waitingHoursInRange), 'horas');
  count('pendingDependencies', b.pendingDependencies, 'dependências');
  count('blockedByDependency', b.blockedByDependency, 'tarefas');
  return rows;
}

/**
 * Texto CSV (separador ';', quebra de linha CRLF, SEM o BOM — quem grava o arquivo acrescenta '﻿').
 * @param {Array<Array<string>>} rows linhas de dados (o cabeçalho "indicador;valor;unidade" é acrescentado)
 * @returns {string}
 */
export function toCsv(rows) {
  const lines = [['indicador', 'valor', 'unidade'], ...rows].map((row) => row.map(csvCell).join(';'));
  return `${lines.join('\r\n')}\r\n`;
}
