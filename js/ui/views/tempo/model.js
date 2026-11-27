// Modelo da tela "Tempo" (seção 8 do pedido): período escolhido, agregações do tempo apontado,
// sobreposições e o CSV de exportação. Sem DOM: tudo aqui é cálculo sobre o app (seletores + store).
//
//   const range = periodRange(ctx.state, app.clock.today());
//   const data = computePeriod(app, { from: range.from, to: range.to, projectId, demandId });
//   const csv = buildCsv(csvRows(app, data.entries));

import { addDays, addMonths, diffDays, endOfMonth, formatDate, formatWeekRange, isValidDateStr, isoToDateStr, rangeDays, relativeDay, startOfMonth, startOfWeek, timeOfIso } from '../../../core/dates.js';
import { formatNumber } from '../../../core/format.js';
import { TIMER, elapsedSeconds, entryDate, estimateVsActual, findOverlaps, summarize, timerState } from '../../../domain/timetracking.js';

/** Períodos oferecidos, na ordem do seletor. `unit` define o passo das setas. */
export const PERIODS = Object.freeze([
  Object.freeze({ id: 'today', label: 'Hoje', unit: 'day' }),
  Object.freeze({ id: 'week', label: 'Esta semana', unit: 'week' }),
  Object.freeze({ id: 'lastweek', label: 'Semana passada', unit: 'week' }),
  Object.freeze({ id: 'month', label: 'Este mês', unit: 'month' }),
  Object.freeze({ id: 'lastmonth', label: 'Mês passado', unit: 'month' }),
  Object.freeze({ id: 'custom', label: 'Personalizado', unit: null }),
]);

/** Período padrão da tela. */
export const DEFAULT_PERIOD = 'week';

/** Valor do filtro de demanda que seleciona as tarefas sem demanda (avulsas). */
export const NO_DEMAND = '__none__';

/** Maior intervalo aceito no período personalizado (dias). */
export const MAX_CUSTOM_DAYS = 731;

/** A partir de quantos dias o gráfico "Horas por dia" passa a somar por semana. */
export const DAILY_CHART_MAX_DAYS = 62;

const PERIOD_BY_ID = new Map(PERIODS.map((p) => [p.id, p]));
const UNIT_NAMES = Object.freeze({ day: 'dia', week: 'semana', month: 'mês' });

const capitalize = (text) => (text ? text.charAt(0).toUpperCase() + text.slice(1) : '');
const hasId = (id) => id !== null && id !== undefined && id !== '';

/**
 * Período efetivo a partir do estado da tela.
 * @param {{ period?: string, offset?: number, from?: string, to?: string }} state
 * @param {string} today 'YYYY-MM-DD'
 * @returns {{ period: string, unit: string|null, unitName: string, offset: number, from: string, to: string,
 *             label: string, days: number, containsToday: boolean, isFuture: boolean }}
 */
export function periodRange(state, today) {
  const s = state && typeof state === 'object' ? state : {};
  const period = PERIOD_BY_ID.has(s.period) ? s.period : DEFAULT_PERIOD;
  const unit = PERIOD_BY_ID.get(period).unit;
  const rawOffset = Number(s.offset);
  const offset = unit && Number.isInteger(rawOffset) ? Math.max(-600, Math.min(600, rawOffset)) : 0;
  let from;
  let to;
  let label;
  if (period === 'today') {
    from = to = addDays(today, offset);
    const rel = relativeDay(from, today);
    label = `${formatDate(from, 'weekday', today)}${rel === 'hoje' || rel === 'ontem' || rel === 'amanhã' ? ` · ${rel}` : ''}`;
  } else if (period === 'week' || period === 'lastweek') {
    from = addDays(startOfWeek(today), 7 * ((period === 'week' ? 0 : -1) + offset));
    to = addDays(from, 6);
    label = formatWeekRange(from);
  } else if (period === 'month' || period === 'lastmonth') {
    from = addMonths(startOfMonth(today), (period === 'month' ? 0 : -1) + offset);
    to = endOfMonth(from);
    label = capitalize(formatDate(from, 'month', today));
  } else {
    from = isValidDateStr(s.from) ? s.from : startOfMonth(today);
    to = isValidDateStr(s.to) ? s.to : today;
    if (from > to) [from, to] = [to, from];
    if (diffDays(from, to) >= MAX_CUSTOM_DAYS) from = addDays(to, -(MAX_CUSTOM_DAYS - 1));
    label = `${formatDate(from, 'short', today)} – ${formatDate(to, 'short', today)}`;
  }
  return {
    period,
    unit,
    unitName: unit ? UNIT_NAMES[unit] : '',
    offset,
    from,
    to,
    label,
    days: diffDays(from, to) + 1,
    containsToday: from <= today && today <= to,
    isFuture: from > today,
  };
}

// ---------------------------------------------------------------------------
// Agregação
// ---------------------------------------------------------------------------

/** Cache pequeno (poucas chaves) dos cálculos por período: a tela pede o período e, às vezes, a semana dele. */
const CACHE_SIZE = 6;
const cache = new Map();
let cacheApp = null; // por app: a versão do banco recomeça em outro app/banco

function remember(key, compute) {
  if (cache.has(key)) {
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  }
  const value = compute();
  cache.set(key, value);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return value;
}

/** Cronômetros em aberto (rodando ou pausados), opcionalmente só os do projeto do escopo. */
export function activeTimersInScope(app, projectId) {
  const list = app.sel.activeTimers();
  if (!projectId) return list.filter((entry) => app.sel.task(entry.task_id));
  return list.filter((entry) => {
    const task = app.sel.task(entry.task_id);
    return task && app.sel.projectIdOf('task', task) === projectId;
  });
}

/**
 * Estimativa de uma demanda: a própria (estimate_minutes) ou, sem ela, a soma das tarefas de nível superior
 * não canceladas (cada uma com a sua estimativa ou, sem ela, a soma das subtarefas).
 * @returns {{ minutes: number, source: 'demand'|'tasks'|null }}
 */
export function demandEstimate(app, demand) {
  if (!demand) return { minutes: 0, source: null };
  const own = Number(demand.estimate_minutes);
  if (Number.isFinite(own) && own > 0) return { minutes: own, source: 'demand' };
  let minutes = 0;
  const positive = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  for (const task of app.sel.topTasks(demand.id)) {
    if (app.sel.status(task.status).category === 'cancelled') continue;
    const value = positive(task.estimate_minutes);
    if (value) {
      minutes += value;
      continue;
    }
    for (const sub of app.sel.subtasks(task.id)) {
      if (app.sel.status(sub.status).category !== 'cancelled') minutes += positive(sub.estimate_minutes);
    }
  }
  return { minutes, source: minutes > 0 ? 'tasks' : null };
}

/** Ordem dos apontamentos dentro de um dia: mais novo primeiro; sem horário no fim. */
function newestFirst(a, b) {
  const sa = a.started_at ? Date.parse(a.started_at) : NaN;
  const sb = b.started_at ? Date.parse(b.started_at) : NaN;
  const ha = Number.isFinite(sa);
  const hb = Number.isFinite(sb);
  if (ha && hb && sa !== sb) return sb - sa;
  if (ha !== hb) return ha ? -1 : 1;
  return String(b.created_at || '').localeCompare(String(a.created_at || '')) || String(b.id).localeCompare(String(a.id));
}

/**
 * Tudo o que a tela mostra para um período (memorizado pela versão do banco, pelo período e pelos filtros).
 * Considera apenas apontamentos que contam nos totais (não excluídos, de tarefa não excluída).
 * @param {object} app
 * @param {{ from: string, to: string, projectId?: string|null, demandId?: string|null }} options
 * @returns {object}
 */
export function computePeriod(app, { from, to, projectId = null, demandId = null }) {
  const nowMs = app.clock.now().getTime();
  const running = app.sel.activeTimers().some((entry) => timerState(entry) === TIMER.RUNNING);
  // Com cronômetro rodando, os totais mudam com o tempo: o cálculo é refeito a cada minuto.
  const key = [app.store.version(), from, to, projectId || '', demandId || '', running ? Math.floor(nowMs / 60000) : ''].join('|');
  if (cacheApp !== app) {
    cache.clear();
    cacheApp = app;
  }
  return remember(key, () => compute(app, { from, to, projectId, demandId, nowMs }));
}

function compute(app, { from, to, projectId, demandId, nowMs }) {
  const sel = app.sel;
  const tasksById = sel.tasksById();
  const visible = new Set();
  for (const task of sel.tasks({ includeArchived: true })) visible.add(task.id);

  const owners = new Map();
  const ownerOf = (taskId) => {
    let info = owners.get(taskId);
    if (!info) {
      const task = tasksById.get(taskId) || null;
      const demand = task ? sel.demandOf(task) : null;
      const project = demand ? sel.project(demand.project_id) : null;
      info = { task, demand, project, demandId: demand ? demand.id : '', projectId: project ? project.id : '' };
      owners.set(taskId, info);
    }
    return info;
  };
  const counts = (entry) => {
    if (!hasId(entry.task_id)) return false;
    const row = app.store.get('tasks', entry.task_id);
    return !row || visible.has(row.id); // tarefa ainda desconhecida neste aparelho: o tempo conta
  };
  const inScope = (entry) => {
    const info = ownerOf(entry.task_id);
    if (projectId && info.projectId !== projectId) return false;
    if (demandId) {
      if (demandId === NO_DEMAND ? info.demandId !== '' : info.demandId !== demandId) return false;
    }
    return true;
  };

  const lo = addDays(from, -1);
  const hi = addDays(to, 1);
  const entries = [];
  const neighbourhood = [];
  let anyInScope = false;
  for (const entry of app.store.all('time_entries')) {
    if (!counts(entry)) continue;
    const day = entryDate(entry);
    if (day && day >= lo && day <= hi) neighbourhood.push(entry);
    const scoped = inScope(entry);
    if (scoped) anyInScope = true;
    if (!day || day < from || day > to || !scoped) continue;
    entries.push(entry);
  }

  const summary = summarize({ entries, tasksById, demandsById: sel.demandsById(), nowMs, from, to });

  // Sobreposições: comparadas com TODOS os apontamentos (qualquer projeto), um dia antes e depois do período.
  const overlaps = new Map();
  for (const pair of findOverlaps(neighbourhood, { nowMs })) {
    if (!overlaps.has(pair.a.id)) overlaps.set(pair.a.id, []);
    if (!overlaps.has(pair.b.id)) overlaps.set(pair.b.id, []);
    overlaps.get(pair.a.id).push({ other: pair.b, seconds: pair.seconds });
    overlaps.get(pair.b.id).push({ other: pair.a, seconds: pair.seconds });
  }

  // Apontamentos por dia (mais recente primeiro).
  const byDay = new Map();
  for (const entry of entries) {
    const day = entryDate(entry);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(entry);
  }
  const days = [...byDay.keys()]
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((day) => {
      const list = byDay.get(day).sort(newestFirst);
      return { day, entries: list, seconds: summary.byDay.get(day) || 0, overlapping: list.filter((e) => overlaps.has(e.id)).length };
    });

  // Tarefas trabalhadas no período. A estimativa é da tarefa inteira; por isso a comparação do resumo usa o
  // total acumulado dessas mesmas tarefas (estimatedTrackedSeconds), como a tabela "Tarefas" — e não só as
  // horas do período, que seriam uma fatia comparada com o orçamento todo.
  let estimateSeconds = 0;
  let estimatedTrackedSeconds = 0;
  let withEstimate = 0;
  let secondsWithoutEstimate = 0;
  const tasks = [];
  for (const [taskId, seconds] of summary.byTask) {
    const info = ownerOf(taskId);
    const minutes = info.task && Number(info.task.estimate_minutes) > 0 ? Number(info.task.estimate_minutes) : 0;
    const total = info.task ? sel.trackedSeconds(taskId) : seconds;
    if (minutes > 0) {
      estimateSeconds += minutes * 60;
      estimatedTrackedSeconds += total;
      withEstimate += 1;
    } else {
      secondsWithoutEstimate += seconds;
    }
    tasks.push({ taskId, task: info.task, demand: info.demand, project: info.project, seconds, totalSeconds: total, estimateMinutes: minutes, cmp: estimateVsActual(minutes, total) });
  }

  // Demandas.
  const demands = [];
  for (const [id, seconds] of summary.byDemand) {
    if (!id) {
      demands.push({ demandId: '', demand: null, project: null, seconds, totalSeconds: null, estimateMinutes: 0, estimateSource: null, cmp: null });
      continue;
    }
    const demand = sel.demand(id);
    const project = demand ? sel.project(demand.project_id) : null;
    const estimate = demandEstimate(app, demand);
    const total = demand ? sel.trackedSecondsOfDemand(id) : seconds;
    demands.push({ demandId: id, demand, project, seconds, totalSeconds: total, estimateMinutes: estimate.minutes, estimateSource: estimate.source, cmp: estimateVsActual(estimate.minutes, total) });
  }

  // Projetos.
  const projects = [];
  for (const [id, seconds] of summary.byProject) projects.push({ projectId: id, project: id ? sel.project(id) : null, seconds });

  let daysWithRecord = 0;
  for (const seconds of summary.byDay.values()) if (seconds > 0) daysWithRecord += 1;

  return Object.freeze({
    from,
    to,
    nowMs,
    anyInScope,
    entries,
    count: entries.length,
    total: summary.total,
    byDay: summary.byDay,
    days,
    overlaps,
    overlapCount: entries.filter((e) => overlaps.has(e.id)).length,
    tasks,
    demands,
    projects,
    estimateSeconds,
    estimatedTrackedSeconds,
    withEstimate,
    secondsWithoutEstimate,
    daysWithRecord,
  });
}

/**
 * Série do gráfico "Horas por dia": um ponto por dia (ou por semana, em períodos longos).
 * @param {object} data resultado de computePeriod
 * @param {{ from: string, to: string }} range
 * @returns {{ bucket: 'day'|'week', points: Array<{ key: string, from: string, to: string, seconds: number }> }}
 */
export function dailySeries(data, range) {
  const days = rangeDays(range.from, range.to);
  if (days.length <= DAILY_CHART_MAX_DAYS) {
    return { bucket: 'day', points: days.map((day) => ({ key: day, from: day, to: day, seconds: data.byDay.get(day) || 0 })) };
  }
  const points = [];
  let current = null;
  for (const day of days) {
    const week = startOfWeek(day);
    if (!current || current.key !== week) {
      current = { key: week, from: day, to: day, seconds: 0 };
      points.push(current);
    }
    current.to = day;
    current.seconds += data.byDay.get(day) || 0;
  }
  return { bucket: 'week', points };
}

// ---------------------------------------------------------------------------
// Horários de um apontamento
// ---------------------------------------------------------------------------

/**
 * Início e término de um apontamento para exibição.
 * @returns {{ start: string, end: string, nextDay: boolean, timed: boolean, running: boolean }}
 */
export function entryTimes(entry) {
  const state = timerState(entry);
  if (!entry.started_at) return { start: '', end: '', nextDay: false, timed: false, running: state === TIMER.RUNNING };
  const start = timeOfIso(entry.started_at);
  if (state === TIMER.RUNNING) return { start, end: '', nextDay: false, timed: true, running: true };
  const endIso = entry.ended_at || null;
  const end = endIso ? timeOfIso(endIso) : '';
  const nextDay = !!endIso && isoToDateStr(endIso) !== isoToDateStr(entry.started_at);
  return { start, end, nextDay, timed: true, running: false };
}

/** Texto do intervalo: '08:10–09:40', '22:00–01:30 (+1)', '08:10–agora' ou 'sem horário'. */
export function entryRangeText(entry) {
  const t = entryTimes(entry);
  if (!t.timed) return 'sem horário';
  if (t.running) return `${t.start}–agora`;
  if (!t.end) return t.start;
  return `${t.start}–${t.end}${t.nextDay ? ' (+1)' : ''}`;
}

/** Valores do formulário de edição a partir de um apontamento. */
export function draftFromEntry(entry) {
  const t = entryTimes(entry);
  return {
    id: entry.id,
    date: entryDate(entry) || '',
    start: t.start,
    end: t.timed && !t.nextDay ? t.end : '',
    duration: Math.max(0, Math.round((Number(entry.duration_seconds) || 0) / 60)),
    durationTouched: false,
    description: entry.description || '',
    error: null,
    errorField: null,
  };
}

/**
 * Patch de updateTimeEntry a partir do rascunho (só o que mudou).
 * Horários alterados → envia data, início e término juntos (e a duração quando faz sentido); só a data →
 * desloca o apontamento mantendo os horários.
 * @returns {object} patch (vazio quando nada mudou)
 */
export function patchFromDraft(entry, draft) {
  const original = draftFromEntry(entry);
  const patch = {};
  const description = (draft.description || '').trim();
  if (description !== (entry.description || '').trim()) patch.description = description || null;
  const start = (draft.start || '').trim();
  const end = (draft.end || '').trim();
  const clockChanged = start !== original.start || end !== original.end || (draft.durationTouched && draft.duration !== original.duration);
  if (clockChanged) {
    patch.date = draft.date;
    patch.start = start || null;
    patch.end = start ? end || null : null;
    if (!(start && end) || draft.durationTouched) patch.durationMinutes = draft.duration === null || draft.duration === undefined ? null : draft.duration;
  } else if (draft.date && draft.date !== original.date) {
    patch.date = draft.date;
  }
  return patch;
}

/**
 * Valores de addManualTime que recriam um apontamento excluído (Desfazer). O tempo líquido é preservado.
 * @returns {object|null} null quando não há o que recriar (duração zero)
 */
export function recreateInput(entry) {
  const seconds = Math.max(0, Number(entry.duration_seconds) || 0);
  if (seconds <= 0) return null;
  const minutes = seconds / 60;
  const input = { task_id: entry.task_id, date: entryDate(entry), description: entry.description || null };
  const t = entryTimes(entry);
  if (t.timed && t.end && !t.nextDay) {
    const [sh, sm] = t.start.split(':').map(Number);
    const [eh, em] = t.end.split(':').map(Number);
    const span = eh * 60 + em - (sh * 60 + sm);
    if (span > 0) {
      input.start = t.start;
      input.end = t.end;
      input.durationMinutes = Math.min(minutes, span);
      return input;
    }
  }
  if (t.timed) input.start = t.start;
  input.durationMinutes = minutes;
  return input;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Cabeçalho do CSV exportado. */
export const CSV_HEADER = Object.freeze(['data', 'início', 'fim', 'duração (h)', 'tarefa', 'demanda', 'projeto', 'descrição']);

/**
 * Proteção contra injeção de fórmula em planilhas: texto que começa com =, +, -, @, TAB ou CR ganha um
 * apóstrofo na frente (o Excel avalia esses campos mesmo entre aspas). Números puros ('-1,50', '-3') ficam
 * como estão. Usado pelos dois CSVs exportados (Tempo e Métricas).
 */
export function csvSafeText(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+([.,]\d+)?$/.test(text)) return `'${text}`;
  return text;
}

/** Campo de CSV com separador ';': aspas quando necessário e proteção contra fórmulas no Excel. */
export function csvField(value) {
  const text = csvSafeText(value);
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Segundos → horas decimais com vírgula e duas casas ('1,50'). */
export function decimalHours(seconds) {
  return formatNumber((Number(seconds) || 0) / 3600, 2).replace(/\./g, '');
}

/**
 * Linhas do CSV (sem cabeçalho) dos apontamentos, em ordem cronológica.
 * @param {object} app
 * @param {Array<object>} entries
 * @param {number} nowMs
 * @returns {string[][]}
 */
export function csvRows(app, entries, nowMs) {
  const sorted = [...entries].sort((a, b) => {
    const da = entryDate(a) || '';
    const db = entryDate(b) || '';
    if (da !== db) return da < db ? -1 : 1;
    return -newestFirst(a, b);
  });
  return sorted.map((entry) => {
    const task = app.sel.tasksById().get(entry.task_id) || null;
    const demand = task ? app.sel.demandOf(task) : null;
    const project = demand ? app.sel.project(demand.project_id) : null;
    const t = entryTimes(entry);
    const day = entryDate(entry);
    return [
      day ? formatDate(day, 'numeric') : '',
      t.start,
      t.running ? '' : t.end,
      decimalHours(elapsedSeconds(entry, nowMs)),
      task ? task.name || '' : 'Tarefa indisponível',
      demand ? demand.name || '' : '',
      project ? project.name || '' : '',
      entry.description || '',
    ];
  });
}

/**
 * Texto do CSV: BOM UTF-8, separador ';' e quebras CRLF (o Excel em pt-BR abre direto).
 * @param {string[][]} rows
 * @returns {string}
 */
export function buildCsv(rows) {
  const lines = [CSV_HEADER, ...rows].map((row) => row.map(csvField).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Nome do arquivo exportado. */
export function csvFileName(range) {
  return range.from === range.to ? `tempo_${range.from}.csv` : `tempo_${range.from}_a_${range.to}.csv`;
}
