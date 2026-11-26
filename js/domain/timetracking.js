// Cronômetro e apontamentos de tempo (seção 8 do pedido).
// Regras PURAS: sem DOM, sem banco e sem relógio implícito — "agora" sempre chega por parâmetro
// (nowIso = instante ISO UTC; nowMs = milissegundos desde 1970).
//
// Uma linha de time_entries é um cronômetro (source 'timer') ou um lançamento manual (source 'manual'):
//
//   state                'running' | 'paused' | 'done'
//   entry_date           dia LOCAL do início — é a data usada nos totais e nos filtros de período
//   started_at           instante em que o trabalho começou (null em lançamento manual sem horário)
//   ended_at             instante em que o trabalho parou pela última vez (null enquanto está rodando)
//   segment_started_at   início do trecho em curso (só quando 'running')
//   accumulated_seconds  soma dos trechos já fechados
//   duration_seconds     duração líquida (sem as pausas); acompanha accumulated_seconds até o cronômetro terminar
//
// Máquina de estados:   running ⇄ paused → done      (running → done também vale; 'done' é final)
//
// Sincronização campo a campo: todo patch de transição devolvido aqui traz o GRUPO INTEIRO do cronômetro
// (TIMER_FIELDS). Os cinco campos são carimbados juntos, então outro dispositivo nunca recebe um
// cronômetro "pela metade" (ex.: state 'paused' com o trecho ainda aberto).
//
// O intervalo de relógio de um apontamento (started_at → ended_at) inclui as pausas; por isso a detecção
// de sobreposição (findOverlaps) trabalha com o intervalo bruto, e os totais com a duração líquida.

import { combineDateTime, isValidDateStr, isoToDateStr, ms } from '../core/dates.js';

/** Estados do cronômetro (campo `state` de time_entries). */
export const TIMER = Object.freeze({ RUNNING: 'running', PAUSED: 'paused', DONE: 'done' });

/** Origem do apontamento (campo `source`). */
export const ENTRY_SOURCE = Object.freeze({ TIMER: 'timer', MANUAL: 'manual' });

/** Campos do "grupo do cronômetro": todo patch de transição traz os cinco juntos. */
export const TIMER_FIELDS = Object.freeze(['state', 'segment_started_at', 'accumulated_seconds', 'ended_at', 'duration_seconds']);

/** Duração máxima de um lançamento manual: 24 h, em segundos. */
export const MAX_MANUAL_SECONDS = 24 * 60 * 60;

/** Horas seguidas a partir das quais um cronômetro rodando é tratado como "provavelmente esquecido". */
export const LONG_RUNNING_HOURS = 10;

/** Maior valor aceito por parseDuration (10 anos, em minutos) — protege as colunas inteiras do servidor. */
export const MAX_PARSED_MINUTES = 10 * 365 * 24 * 60;

/**
 * Erro de validação de regra de negócio do apontamento.
 * `message` está em pt-BR e pode ser mostrada ao usuário; `code` é estável (interface e testes);
 * `field` indica o campo de entrada relacionado ('task' | 'date' | 'start' | 'end' | 'duration') ou null.
 *
 * Códigos usados neste módulo:
 *   cronômetro  entry_not_found, invalid_instant, timer_already_paused, timer_already_running, timer_already_done
 *   manual      missing_task, invalid_date, invalid_time, end_before_start, invalid_duration, duration_too_long,
 *               duration_exceeds_interval, missing_time, missing_start, missing_end
 */
export class ValidationError extends Error {
  /**
   * @param {string} message texto em pt-BR pronto para a interface
   * @param {string} [code]  código estável do erro
   * @param {string|null} [field] campo de entrada relacionado, quando houver
   */
  constructor(message, code = 'invalid', field = null) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------
const SECOND = 1000;
const HOUR = 3600 * SECOND;
const pad2 = (n) => String(n).padStart(2, '0');

/** Inteiro não negativo; ausente, negativo ou não numérico vira 0 (dados incoerentes nunca geram tempo negativo). */
function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Milissegundos -> instante ISO canônico. */
const isoFromMs = (t) => new Date(t).toISOString();

/** Instante ISO canônico, ou null se o valor não for um instante válido. */
function canonicalIso(v) {
  const t = ms(v);
  return Number.isFinite(t) ? isoFromMs(t) : null;
}

/** Texto livre: apara espaços; vazio vira null. */
function cleanText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Valor de formulário: null/undefined/só espaços -> null; senão o texto aparado. */
function blankToNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Busca em Map ou em objeto simples (as duas formas são aceitas nos índices por id). */
function lookup(index, id) {
  if (!index || id === null || id === undefined) return undefined;
  return typeof index.get === 'function' ? index.get(id) : index[id];
}

function addTo(map, key, seconds) {
  map.set(key, (map.get(key) || 0) + seconds);
}

const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** "Agora" obrigatório das transições: { ms, iso } ou ValidationError. */
function requireInstant(value) {
  const t = ms(value);
  if (!Number.isFinite(t)) throw new ValidationError('Instante inválido para o cronômetro.', 'invalid_instant');
  return { ms: t, iso: isoFromMs(t) };
}

/** Apontamento obrigatório (existente e não excluído) das transições; devolve o estado dele. */
function requireEntry(entry) {
  if (!entry || typeof entry !== 'object' || entry.deleted_at) {
    throw new ValidationError('Apontamento não encontrado.', 'entry_not_found');
  }
  return timerState(entry);
}

/**
 * Início (ms) do trecho em curso de um cronômetro rodando.
 * Dado incoerente (rodando sem segment_started_at): se nenhum trecho foi fechado ainda, o trecho começou em started_at.
 */
function segmentStartMs(entry) {
  const t = ms(entry.segment_started_at);
  if (Number.isFinite(t)) return t;
  return nonNegInt(entry.accumulated_seconds) === 0 ? ms(entry.started_at) : NaN;
}

/** Segundos inteiros do trecho em curso até `nowMs` (0 se o relógio estiver antes do início do trecho). */
function openSegmentSeconds(entry, nowMs) {
  const start = segmentStartMs(entry);
  const now = Number(nowMs);
  if (!Number.isFinite(start) || !Number.isFinite(now) || now <= start) return 0;
  return Math.floor((now - start) / SECOND);
}

/**
 * Instante em que o trabalho parou: `now`, mas nunca antes do início do trecho/apontamento
 * (relógios de dois dispositivos fora de sincronia não podem inverter o intervalo).
 */
function closeInstant(entry, now) {
  let t = now.ms;
  for (const v of [entry.segment_started_at, entry.started_at]) {
    const x = ms(v);
    if (Number.isFinite(x) && x > t) t = x;
  }
  return t === now.ms ? now.iso : isoFromMs(t);
}

// ---------------------------------------------------------------------------
// Cronômetro
// ---------------------------------------------------------------------------

/**
 * Estado efetivo do cronômetro de um apontamento.
 * @param {object} entry linha de time_entries
 * @returns {'running'|'paused'|'done'} valor desconhecido/ausente é tratado como 'done' (padrão do schema)
 */
export function timerState(entry) {
  if (entry && entry.state === TIMER.RUNNING) return TIMER.RUNNING;
  if (entry && entry.state === TIMER.PAUSED) return TIMER.PAUSED;
  return TIMER.DONE;
}

/**
 * Tempo líquido (sem pausas) de um apontamento no instante `nowMs`.
 *   • rodando: accumulated_seconds + (agora − segment_started_at)
 *   • pausado: accumulated_seconds
 *   • encerrado: duration_seconds
 * @param {object} entry  linha de time_entries
 * @param {number} nowMs  "agora" em milissegundos (só importa para cronômetro rodando)
 * @returns {number} segundos inteiros, nunca negativos (0 para entrada nula ou valores incoerentes)
 */
export function elapsedSeconds(entry, nowMs) {
  if (!entry) return 0;
  const state = timerState(entry);
  if (state === TIMER.DONE) return nonNegInt(entry.duration_seconds);
  const accumulated = nonNegInt(entry.accumulated_seconds);
  if (state === TIMER.PAUSED) return accumulated;
  return accumulated + openSegmentSeconds(entry, nowMs);
}

/**
 * Valores de um apontamento novo criado ao LIGAR o cronômetro numa tarefa.
 * @param {{ taskId: string, nowIso: string }} params
 * @returns {{ task_id, entry_date, started_at, ended_at, duration_seconds, description, state,
 *             segment_started_at, accumulated_seconds, source }}
 *          entry_date é a data LOCAL de nowIso; state 'running'; source 'timer'.
 * @throws {ValidationError} missing_task | invalid_instant
 */
export function startValues({ taskId, nowIso } = {}) {
  if (taskId === null || taskId === undefined || taskId === '') {
    throw new ValidationError('Informe a tarefa do apontamento.', 'missing_task', 'task');
  }
  const now = requireInstant(nowIso);
  return {
    task_id: taskId,
    entry_date: isoToDateStr(now.iso),
    started_at: now.iso,
    ended_at: null,
    duration_seconds: 0,
    description: null,
    state: TIMER.RUNNING,
    segment_started_at: now.iso,
    accumulated_seconds: 0,
    source: ENTRY_SOURCE.TIMER,
  };
}

/**
 * Patch para PAUSAR um cronômetro rodando: fecha o trecho em curso.
 * accumulated_seconds += segundos do trecho; state 'paused'; segment_started_at null;
 * ended_at = nowIso (momento em que o trabalho parou); duration_seconds = accumulated_seconds.
 * @param {object} entry  linha de time_entries (não é alterada)
 * @param {string} nowIso instante da pausa
 * @returns {{ state, segment_started_at, accumulated_seconds, ended_at, duration_seconds }} grupo completo do cronômetro
 * @throws {ValidationError} timer_already_paused | timer_already_done | entry_not_found | invalid_instant
 */
export function pausePatch(entry, nowIso) {
  const state = requireEntry(entry);
  if (state === TIMER.PAUSED) throw new ValidationError('O cronômetro já está pausado.', 'timer_already_paused');
  if (state === TIMER.DONE) throw new ValidationError('Este apontamento já foi encerrado e não pode ser pausado.', 'timer_already_done');
  const now = requireInstant(nowIso);
  const total = nonNegInt(entry.accumulated_seconds) + openSegmentSeconds(entry, now.ms);
  return {
    state: TIMER.PAUSED,
    segment_started_at: null,
    accumulated_seconds: total,
    ended_at: closeInstant(entry, now),
    duration_seconds: total,
  };
}

/**
 * Patch para RETOMAR um cronômetro pausado: abre um trecho novo em nowIso.
 * state 'running'; segment_started_at = nowIso; ended_at null; o tempo acumulado não muda
 * (duration_seconds acompanha accumulated_seconds).
 * @param {object} entry  linha de time_entries (não é alterada)
 * @param {string} nowIso instante da retomada
 * @returns {{ state, segment_started_at, accumulated_seconds, ended_at, duration_seconds }} grupo completo do cronômetro
 * @throws {ValidationError} timer_already_running | timer_already_done | entry_not_found | invalid_instant
 */
export function resumePatch(entry, nowIso) {
  const state = requireEntry(entry);
  if (state === TIMER.RUNNING) throw new ValidationError('O cronômetro já está em andamento.', 'timer_already_running');
  if (state === TIMER.DONE) {
    throw new ValidationError('Este apontamento já foi encerrado. Inicie um novo cronômetro para continuar.', 'timer_already_done');
  }
  const now = requireInstant(nowIso);
  const accumulated = nonNegInt(entry.accumulated_seconds);
  return {
    state: TIMER.RUNNING,
    segment_started_at: now.iso,
    accumulated_seconds: accumulated,
    ended_at: null,
    duration_seconds: accumulated,
  };
}

/**
 * Patch para ENCERRAR um cronômetro (rodando ou pausado).
 *   • rodando: fecha o trecho em curso e ended_at = nowIso;
 *   • pausado: mantém ended_at (o instante da pausa — foi quando o trabalho parou);
 *   • duration_seconds = accumulated_seconds = total; state 'done'; segment_started_at null;
 *   • `description`, quando informada (≠ undefined), entra no patch (texto aparado; vazio vira null).
 * @param {object} entry  linha de time_entries (não é alterada)
 * @param {string} nowIso instante do encerramento
 * @param {{ description?: string|null }} [options]
 * @returns {{ state, segment_started_at, accumulated_seconds, ended_at, duration_seconds, description? }}
 * @throws {ValidationError} timer_already_done | entry_not_found | invalid_instant
 */
export function stopPatch(entry, nowIso, options) {
  const state = requireEntry(entry);
  if (state === TIMER.DONE) throw new ValidationError('O cronômetro deste apontamento já foi encerrado.', 'timer_already_done');
  const now = requireInstant(nowIso);
  let total = nonNegInt(entry.accumulated_seconds);
  let endedAt;
  if (state === TIMER.RUNNING) {
    total += openSegmentSeconds(entry, now.ms);
    endedAt = closeInstant(entry, now);
  } else {
    endedAt = canonicalIso(entry.ended_at) || closeInstant(entry, now);
  }
  const patch = {
    state: TIMER.DONE,
    segment_started_at: null,
    accumulated_seconds: total,
    ended_at: endedAt,
    duration_seconds: total,
  };
  const description = options ? options.description : undefined;
  if (description !== undefined) patch.description = cleanText(description);
  return patch;
}

// ---------------------------------------------------------------------------
// Lançamento manual
// ---------------------------------------------------------------------------

/** Duração informada em minutos -> segundos inteiros (null se não informada). */
function manualDurationSeconds(durationMinutes) {
  if (durationMinutes === null || durationMinutes === undefined) return null;
  let minutes = durationMinutes;
  if (typeof minutes === 'string') {
    if (!minutes.trim()) return null;
    minutes = Number(minutes.trim());
  }
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
    throw new ValidationError('Duração inválida.', 'invalid_duration', 'duration');
  }
  const seconds = Math.round(minutes * 60);
  if (minutes <= 0 || seconds <= 0) {
    throw new ValidationError('A duração precisa ser maior que zero.', 'invalid_duration', 'duration');
  }
  if (seconds > MAX_MANUAL_SECONDS) {
    throw new ValidationError('A duração de um apontamento não pode passar de 24 horas.', 'duration_too_long', 'duration');
  }
  return seconds;
}

/**
 * Valida um lançamento manual e devolve os valores da linha (state 'done', source 'manual').
 *
 * Combinações aceitas:
 *   • início + término            → duração = término − início (término depois do início, no mesmo dia)
 *   • início + duração            → término = início + duração (pode passar da meia-noite)
 *   • só duração                  → started_at e ended_at ficam null (apontamento sem horário)
 *   • início + término + duração  → a duração é o tempo LÍQUIDO (descontadas as pausas) e não pode
 *                                   ser maior que o intervalo entre início e término
 *
 * @param {object} params
 * @param {string} params.taskId            tarefa do apontamento (obrigatória)
 * @param {string} params.date              dia do apontamento, 'YYYY-MM-DD' local (obrigatório)
 * @param {string} [params.start]           'HH:MM'
 * @param {string} [params.end]             'HH:MM'
 * @param {number} [params.durationMinutes] minutos (> 0, no máximo 24 h)
 * @param {string} [params.description]     texto livre (aparado; vazio vira null)
 * @returns {{ task_id, entry_date, started_at, ended_at, duration_seconds, description, state,
 *             segment_started_at, accumulated_seconds, source }}  accumulated_seconds = duration_seconds
 * @throws {ValidationError} missing_task | invalid_date | invalid_time | end_before_start | invalid_duration |
 *         duration_too_long | duration_exceeds_interval | missing_time (só a data) | missing_start (término
 *         sem início) | missing_end (início sem término nem duração)
 */
export function manualEntryValues({ taskId, date, start, end, durationMinutes, description } = {}) {
  if (taskId === null || taskId === undefined || taskId === '') {
    throw new ValidationError('Informe a tarefa do apontamento.', 'missing_task', 'task');
  }
  if (!isValidDateStr(date)) {
    throw new ValidationError('Informe uma data válida para o apontamento.', 'invalid_date', 'date');
  }
  const startText = blankToNull(start);
  const endText = blankToNull(end);
  const startIso = startText === null ? null : combineDateTime(date, startText);
  if (startText !== null && !startIso) {
    throw new ValidationError('Horário de início inválido. Use o formato HH:MM.', 'invalid_time', 'start');
  }
  const endIso = endText === null ? null : combineDateTime(date, endText);
  if (endText !== null && !endIso) {
    throw new ValidationError('Horário de término inválido. Use o formato HH:MM.', 'invalid_time', 'end');
  }
  const informed = manualDurationSeconds(durationMinutes);

  let startedAt = null;
  let endedAt = null;
  let seconds;
  if (startIso && endIso) {
    const span = Math.round((ms(endIso) - ms(startIso)) / SECOND);
    if (span <= 0) {
      throw new ValidationError('O término precisa ser depois do início, no mesmo dia.', 'end_before_start', 'end');
    }
    if (informed !== null && informed > span) {
      throw new ValidationError('A duração não pode ser maior que o intervalo entre o início e o término.', 'duration_exceeds_interval', 'duration');
    }
    seconds = informed === null ? span : informed;
    startedAt = startIso;
    endedAt = endIso;
  } else if (startIso) {
    if (informed === null) {
      throw new ValidationError('Informe o horário de término ou a duração.', 'missing_end', 'end');
    }
    seconds = informed;
    startedAt = startIso;
    endedAt = isoFromMs(ms(startIso) + seconds * SECOND);
  } else if (endIso) {
    throw new ValidationError('Informe o horário de início.', 'missing_start', 'start');
  } else {
    if (informed === null) {
      throw new ValidationError('Informe a duração ou os horários de início e término.', 'missing_time', 'duration');
    }
    seconds = informed;
  }

  return {
    task_id: taskId,
    entry_date: date,
    started_at: startedAt,
    ended_at: endedAt,
    duration_seconds: seconds,
    description: cleanText(description),
    state: TIMER.DONE,
    segment_started_at: null,
    accumulated_seconds: seconds,
    source: ENTRY_SOURCE.MANUAL,
  };
}

// ---------------------------------------------------------------------------
// Intervalos de relógio e sobreposição
// ---------------------------------------------------------------------------

/**
 * Intervalo de relógio (bruto, pausas incluídas) de um apontamento, usado na checagem de sobreposição:
 * [started_at, ended_at] — para cronômetro rodando, o fim é `nowMs`.
 * @param {object} entry  linha de time_entries ou valores ainda não gravados
 * @param {number} [nowMs] "agora" em milissegundos (fim dos cronômetros rodando)
 * @returns {{ startMs: number, endMs: number } | null} null para apontamento excluído ou sem horário;
 *          endMs nunca é menor que startMs (encerrado sem ended_at usa started_at + duration_seconds)
 */
export function entryInterval(entry, nowMs) {
  if (!entry || entry.deleted_at) return null;
  const startMs = ms(entry.started_at);
  if (!Number.isFinite(startMs)) return null;
  let endMs;
  if (timerState(entry) === TIMER.RUNNING) {
    endMs = nowMs === null || nowMs === undefined ? NaN : Number(nowMs);
  } else {
    endMs = ms(entry.ended_at);
    if (!Number.isFinite(endMs)) endMs = startMs + nonNegInt(entry.duration_seconds) * SECOND;
  }
  if (!Number.isFinite(endMs) || endMs < startMs) endMs = startMs;
  return { startMs, endMs };
}

/**
 * Aceita as duas formas de chamada de findOverlaps: opções `{ candidate, nowMs }` ou, como no resumo do
 * contrato (`findOverlaps(entries, candidate?)`), o próprio apontamento candidato no segundo argumento.
 */
function overlapOptions(arg) {
  if (!arg || typeof arg !== 'object') return {};
  const isOptions = 'candidate' in arg || 'nowMs' in arg;
  if (!isOptions && ('started_at' in arg || 'task_id' in arg)) return { candidate: arg };
  return arg;
}

/**
 * Sobreposições de horário entre apontamentos (uma pessoa não trabalha em duas coisas ao mesmo tempo).
 *
 * Considera só apontamentos não excluídos e com horário (ver entryInterval); pontas que apenas se tocam
 * (10:00–11:00 e 11:00–12:00) NÃO se sobrepõem; sobreposição menor que 1 segundo é ignorada.
 *
 * @param {Array<object>} entries linhas de time_entries
 * @param {{ candidate?: object, nowMs?: number }} [options]
 *        candidate: devolve só as sobreposições que envolvem o candidato — uma linha existente ou valores
 *        ainda não gravados (startValues/manualEntryValues); a linha de `entries` com o mesmo id do candidato
 *        é ignorada (edição). nowMs: fim dos cronômetros rodando.
 * @returns {Array<{ a: object, b: object, seconds: number }>} pares em ordem cronológica; sem candidato,
 *          `a` é o que começa primeiro; com candidato, `a` é sempre o candidato. `seconds` ≥ 1.
 */
export function findOverlaps(entries, options) {
  const { candidate = null, nowMs } = overlapOptions(options);
  const spans = [];
  for (const entry of entries || []) {
    if (!entry) continue;
    if (candidate && (entry === candidate || (candidate.id != null && entry.id === candidate.id))) continue;
    const span = entryInterval(entry, nowMs);
    if (span && span.endMs > span.startMs) spans.push({ entry, startMs: span.startMs, endMs: span.endMs });
  }
  spans.sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs || compareKeys(String(x.entry.id || ''), String(y.entry.id || '')));

  const overlap = (x, y) => Math.floor((Math.min(x.endMs, y.endMs) - Math.max(x.startMs, y.startMs)) / SECOND);
  const out = [];
  if (candidate) {
    const own = entryInterval(candidate, nowMs);
    if (!own || own.endMs <= own.startMs) return out;
    for (const other of spans) {
      const seconds = overlap(own, other);
      if (seconds > 0) out.push({ a: candidate, b: other.entry, seconds });
    }
    return out;
  }
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length && spans[j].startMs < spans[i].endMs; j++) {
      const seconds = overlap(spans[i], spans[j]);
      if (seconds > 0) out.push({ a: spans[i].entry, b: spans[j].entry, seconds });
    }
  }
  return out;
}

/** Comparador "mais antigo primeiro": started_at, depois created_at, depois id (sem horário vai para o fim). */
function compareByStart(a, b) {
  const sa = ms(a.started_at);
  const sb = ms(b.started_at);
  const va = Number.isFinite(sa) ? sa : Infinity;
  const vb = Number.isFinite(sb) ? sb : Infinity;
  if (va !== vb) return va < vb ? -1 : 1;
  return compareKeys(String(a.created_at || ''), String(b.created_at || '')) || compareKeys(String(a.id || ''), String(b.id || ''));
}

/**
 * Cronômetros em aberto: apontamentos não excluídos em estado 'running' ou 'paused'.
 * @param {Array<object>} entries linhas de time_entries
 * @returns {Array<object>} do mais antigo para o mais novo (started_at; desempate por created_at e id)
 */
export function activeTimers(entries) {
  const out = [];
  for (const entry of entries || []) {
    if (!entry || entry.deleted_at) continue;
    if (timerState(entry) !== TIMER.DONE) out.push(entry);
  }
  return out.sort(compareByStart);
}

/**
 * Cronômetro provavelmente esquecido ligado: está RODANDO e o trecho em curso já dura `hours` horas ou mais.
 * (Cronômetro pausado não acumula tempo, então nunca é "longo".)
 * @param {object} entry linha de time_entries
 * @param {number} nowMs "agora" em milissegundos
 * @param {number} [hours=10] limite em horas (valor inválido ou ≤ 0 usa o padrão)
 * @returns {boolean}
 */
export function isLongRunning(entry, nowMs, hours = LONG_RUNNING_HOURS) {
  if (!entry || entry.deleted_at || timerState(entry) !== TIMER.RUNNING) return false;
  const start = segmentStartMs(entry);
  const now = nowMs === null || nowMs === undefined ? NaN : Number(nowMs);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return false;
  const h = Number(hours);
  const limit = Number.isFinite(h) && h > 0 ? h : LONG_RUNNING_HOURS;
  return now - start >= limit * HOUR;
}

// ---------------------------------------------------------------------------
// Totais e resumos
// ---------------------------------------------------------------------------

/**
 * Dia (local) a que o apontamento pertence nos totais: entry_date; na falta dele, a data local de
 * started_at e, por último, de created_at.
 * @param {object} entry linha de time_entries
 * @returns {string|null} 'YYYY-MM-DD' ou null se não der para determinar
 */
export function entryDate(entry) {
  if (!entry) return null;
  if (isValidDateStr(entry.entry_date)) return entry.entry_date;
  return isoToDateStr(entry.started_at) || isoToDateStr(entry.created_at) || null;
}

/**
 * Percorre os apontamentos que contam nos totais: não excluídos, com tarefa e dentro do período
 * (from/to são limites INCLUSIVOS de entry_date; com período informado, apontamento sem data fica de fora).
 */
function forEachCounted(entries, { nowMs, from, to }, fn) {
  const lo = from || null;
  const hi = to || null;
  for (const entry of entries || []) {
    if (!entry || entry.deleted_at || entry.task_id === null || entry.task_id === undefined) continue;
    const day = entryDate(entry);
    if ((lo || hi) && (!day || (lo && day < lo) || (hi && day > hi))) continue;
    fn(entry, elapsedSeconds(entry, nowMs), day);
  }
}

/**
 * Tempo apontado por tarefa.
 * @param {Array<object>} entries linhas de time_entries (as excluídas são ignoradas)
 * @param {{ nowMs?: number, from?: string, to?: string }} [options]
 *        nowMs: para contar o tempo corrente dos cronômetros rodando; from/to: limites inclusivos de entry_date.
 * @returns {Map<string, number>} id da tarefa → segundos (tarefa com apontamento de 0 s aparece com 0)
 */
export function totalsByTask(entries, options) {
  const { nowMs, from, to } = options || {};
  const totals = new Map();
  forEachCounted(entries, { nowMs, from, to }, (entry, seconds) => addTo(totals, entry.task_id, seconds));
  return totals;
}

/** Demanda e projeto de uma tarefa ('' quando não há). Subtarefa sem demanda herda a do pai (um nível). */
function ownerOf(taskId, tasksById, demandsById) {
  const task = lookup(tasksById, taskId);
  let demandId = task && task.demand_id ? task.demand_id : '';
  if (!demandId && task && task.parent_id && task.parent_id !== task.id) {
    const parent = lookup(tasksById, task.parent_id);
    if (parent && parent.demand_id) demandId = parent.demand_id;
  }
  const demand = demandId ? lookup(demandsById, demandId) : null;
  return { demandId, projectId: demand && demand.project_id ? demand.project_id : '' };
}

const sortedBySecondsDesc = (map) => new Map([...map].sort((a, b) => b[1] - a[1] || compareKeys(String(a[0]), String(b[0]))));
const sortedByKey = (map) => new Map([...map].sort((a, b) => compareKeys(a[0], b[0])));

/**
 * Resumo do tempo apontado, com período opcional.
 * @param {object} params
 * @param {Array<object>} params.entries       linhas de time_entries (as excluídas são ignoradas)
 * @param {Map|object}    [params.tasksById]   id → tarefa (para achar a demanda)
 * @param {Map|object}    [params.demandsById] id → demanda (para achar o projeto: ele vem da demanda da tarefa)
 * @param {number}        [params.nowMs]       para contar o tempo corrente dos cronômetros rodando
 * @param {string}        [params.from]        limite inferior inclusivo de entry_date
 * @param {string}        [params.to]          limite superior inclusivo de entry_date
 * @param {string|null}   [params.projectId]   só apontamentos de tarefas desse projeto (null/'' = sem projeto);
 *                                             ausente (undefined) = todos
 * @param {string|null}   [params.demandId]    só apontamentos de tarefas dessa demanda (null/'' = sem demanda;
 *                                             subtarefa sem demanda própria conta pela do pai); ausente = todos
 * @returns {{ total: number, count: number, byTask: Map<string, number>, byDemand: Map<string, number>,
 *             byProject: Map<string, number>, byDay: Map<string, number> }}
 *          Segundos. byDemand usa '' para tarefa sem demanda (ou desconhecida); byProject usa '' para demanda
 *          sem projeto; byDay é indexado pelo dia do apontamento (ordem crescente); os demais mapas vêm do
 *          maior para o menor tempo. `count` = quantidade de apontamentos considerados.
 */
export function summarize({ entries, tasksById, demandsById, nowMs, from, to, projectId, demandId } = {}) {
  const byTask = new Map();
  const byDemand = new Map();
  const byProject = new Map();
  const byDay = new Map();
  const owners = new Map();
  const wantProject = projectId === undefined ? undefined : projectId || '';
  const wantDemand = demandId === undefined ? undefined : demandId || '';
  let total = 0;
  let count = 0;
  forEachCounted(entries, { nowMs, from, to }, (entry, seconds, day) => {
    let owner = owners.get(entry.task_id);
    if (!owner) owners.set(entry.task_id, (owner = ownerOf(entry.task_id, tasksById, demandsById)));
    if (wantProject !== undefined && owner.projectId !== wantProject) return;
    if (wantDemand !== undefined && owner.demandId !== wantDemand) return;
    total += seconds;
    count += 1;
    addTo(byTask, entry.task_id, seconds);
    addTo(byDemand, owner.demandId, seconds);
    addTo(byProject, owner.projectId, seconds);
    addTo(byDay, day || '', seconds);
  });
  return {
    total,
    count,
    byTask: sortedBySecondsDesc(byTask),
    byDemand: sortedBySecondsDesc(byDemand),
    byProject: sortedBySecondsDesc(byProject),
    byDay: sortedByKey(byDay),
  };
}

/**
 * Compara o tempo estimado com o realizado.
 * @param {number|null} estimateMinutes estimativa em minutos (null, 0 ou inválida = sem estimativa)
 * @param {number} actualSeconds        tempo apontado em segundos
 * @returns {{ estimateSeconds: number, actualSeconds: number, diffSeconds: number, ratio: number|null,
 *             state: 'none'|'under'|'on'|'over' }}
 *          diffSeconds = realizado − estimado; ratio = realizado ÷ estimado (null sem estimativa);
 *          state: 'none' sem estimativa; 'on' dentro de ±10% (limites inclusivos); 'under' abaixo; 'over' acima.
 */
export function estimateVsActual(estimateMinutes, actualSeconds) {
  const actual = nonNegInt(actualSeconds);
  const minutes = estimateMinutes === null || estimateMinutes === undefined ? NaN : Number(estimateMinutes);
  const estimate = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : 0;
  if (estimate <= 0) {
    return { estimateSeconds: 0, actualSeconds: actual, diffSeconds: actual, ratio: null, state: 'none' };
  }
  // Comparação em inteiros para os limites de ±10% não sofrerem com ponto flutuante.
  let state = 'on';
  if (actual * 10 < estimate * 9) state = 'under';
  else if (actual * 10 > estimate * 11) state = 'over';
  return { estimateSeconds: estimate, actualSeconds: actual, diffSeconds: actual - estimate, ratio: actual / estimate, state };
}

// ---------------------------------------------------------------------------
// Formatação e leitura de durações
// ---------------------------------------------------------------------------

/**
 * Formata uma duração em segundos.
 *   'short'   (padrão) '1h 23min', '45min', '2h'; '<1min' para 1 a 59 s; '0min' para 0 (minutos truncados)
 *   'clock'   '01:23:45' (horas com pelo menos dois dígitos; pode passar de 24)
 *   'decimal' '1,4 h' (horas com uma casa decimal e vírgula)
 * Valor negativo (uma diferença) sai com '-' na frente; valor inválido é tratado como 0.
 * @param {number} seconds
 * @param {{ style?: 'short'|'clock'|'decimal' }} [options]
 * @returns {string}
 */
export function formatDuration(seconds, options) {
  const style = options && options.style ? options.style : 'short';
  const n = Number(seconds);
  const total = Number.isFinite(n) ? Math.trunc(n) : 0;
  const sign = total < 0 ? '-' : '';
  const abs = Math.abs(total);

  if (style === 'clock') {
    return `${sign}${pad2(Math.floor(abs / 3600))}:${pad2(Math.floor((abs % 3600) / 60))}:${pad2(abs % 60)}`;
  }
  if (style === 'decimal') {
    const tenths = Math.round(abs / 360); // décimos de hora, em aritmética inteira
    return `${tenths ? sign : ''}${Math.floor(tenths / 10)},${tenths % 10} h`;
  }
  if (abs === 0) return '0min';
  if (abs < 60) return `${sign}<1min`;
  const minutes = Math.floor(abs / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${sign}${m}min`;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}min`;
}

const DECIMAL = '(\\d+(?:[.,]\\d+)?)';
const HOUR_UNIT = '(?:horas|hora|hrs|hr|h)';
const MINUTE_UNIT = '(?:minutos|minuto|mins|min|m)';
/** '1:30' ou '01:23:45'. */
const CLOCK_RE = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/;
/** '1h', '1,5h', '1h30', '1h 30m', '1h30min', '1 hora e 30 minutos'. */
const HOURS_RE = new RegExp(`^${DECIMAL} ?${HOUR_UNIT}(?: ?(?:e )?(\\d+) ?${MINUTE_UNIT}?)?$`);
/** '90m', '90 min', '45 minutos'. */
const MINUTES_RE = new RegExp(`^${DECIMAL} ?${MINUTE_UNIT}$`);

const decimalNumber = (text) => Number(text.replace(',', '.'));

/** Minutos calculados -> inteiro válido (arredondado) ou null. */
function finishMinutes(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  const rounded = Math.round(value);
  return rounded > MAX_PARSED_MINUTES ? null : rounded;
}

/**
 * Lê uma duração digitada pelo usuário e devolve MINUTOS inteiros.
 *
 * Aceita: '90' (número puro = minutos), '90m', '90 min', '1h', '1h30', '1h 30m', '1h30min', '1 hora e 30 minutos',
 * '1:30' (h:mm), '01:23:45' (h:mm:ss), '1,5h', '1.5 h', '0,25h'. Maiúsculas e espaços extras são ignorados;
 * frações são arredondadas para o minuto mais próximo.
 * Não aceita: texto vazio, número negativo, decimal sem unidade ('1,5' é ambíguo) nem valores acima de
 * MAX_PARSED_MINUTES.
 * @param {string|number} text texto digitado (um número é entendido como minutos)
 * @returns {number|null} minutos inteiros (≥ 0) ou null quando o texto não é uma duração
 */
export function parseDuration(text) {
  if (typeof text === 'number') return finishMinutes(text);
  if (typeof text !== 'string') return null;
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;

  let m = CLOCK_RE.exec(s);
  if (m) return finishMinutes(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0));
  if (/^\d+$/.test(s)) return finishMinutes(Number(s));
  m = HOURS_RE.exec(s);
  if (m) return finishMinutes(decimalNumber(m[1]) * 60 + (m[2] ? Number(m[2]) : 0));
  m = MINUTES_RE.exec(s);
  if (m) return finishMinutes(decimalNumber(m[1]));
  return null;
}
