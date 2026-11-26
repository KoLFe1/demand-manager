// Indicadores do Demand Manager (seção 11 do pedido). Puro: sem DOM, sem banco e sem relógio implícito.
//
// Princípio: tudo que é HISTÓRICO sai do registro de atividades (activity_log) por meio de timeline.js — nunca só
// do status atual. Um período passado mostra o que era verdade naquele momento: uma tarefa concluída depois do fim
// do período aparece, dentro dele, como pendente (e atrasada, se o prazo vigente na época já tinha passado).
//
// Vocabulário usado neste arquivo:
//   • período     = [range.from 00:00, range.to 23:59:59.999], datas locais inclusivas;
//   • asOf        = o mais cedo entre o fim do período e "agora" (nowIso). Os números "de situação" (pendentes,
//                   WIP, atrasadas, bloqueadas...) são medidos nesse instante, reconstruindo o passado;
//   • existir     = já ter sido criada e ainda não ter sido excluída — a exclusão vale a partir do seu instante e é
//                   herdada (tarefa de demanda excluída, demanda de projeto excluído, subtarefa de tarefa excluída);
//   • arquivada   = idem, com archived_at. Arquivadas ficam fora das contagens de itens em aberto, mas uma tarefa
//                   concluída continua contando como concluída depois de arquivada;
//   • em aberto   = existe, não está arquivada e o status do momento não é de categoria concluída nem cancelada.
//
// Limites conhecidos (documentados para quem for evoluir): exclusão e arquivamento usam os campos atuais da linha
// (um item excluído e depois restaurado é tratado como se nunca tivesse sido excluído) e os filtros de projeto e
// demanda usam o vínculo atual (uma tarefa movida entra no projeto/demanda em que está hoje).

import { addDays, addMonths, dateStrToIso, diffDays, isValidDateStr, isoToDateStr, monthKey, ms, startOfMonth, startOfWeek } from '../core/dates.js';
import { IN_FLIGHT_CATEGORIES, isOpenCategory } from './statuses.js';
import {
  ACTIONS,
  completedWithin,
  completionInfo,
  dueDateAt,
  eventsOf,
  existedAt,
  fieldChanges,
  firstEntered,
  indexEvents,
  spansOfCategories,
  statusAt,
  statusIntervals,
  timeInCategories,
  valueAt,
} from './timeline.js';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

/** Até este número de dias a série de WIP tem um ponto por dia; acima disso, um por semana. */
export const DAILY_SERIES_MAX_DAYS = 62;

/** Nome mostrado para o tempo apontado em tarefas sem projeto. */
export const NO_PROJECT_LABEL = 'Sem projeto';

const UNKNOWN_PROJECT_LABEL = 'Projeto desconhecido';

const label = (group, unit, text, help) => Object.freeze({ label: text, help, group, unit });

/**
 * Rótulo e explicação (pt-BR) de cada indicador devolvido por computeMetrics — usados como legenda e dica na tela.
 * Cada entrada: { label, help, group, unit }.
 *   group: 'productivity' | 'deadlines' | 'capacity' | 'blocking' (em que parte do resultado a chave está)
 *   unit:  'count' | 'days' | 'hours' | 'minutes' | 'seconds' | 'ratio' (0..1, mostrar como %) | 'series' (lista)
 */
export const METRIC_LABELS = Object.freeze({
  // Produtividade
  tasksCompleted: label('productivity', 'count', 'Tarefas concluídas', 'Tarefas e subtarefas concluídas dentro do período e que continuavam concluídas no fim dele.'),
  demandsCompleted: label('productivity', 'count', 'Demandas concluídas', 'Demandas concluídas dentro do período e que continuavam concluídas no fim dele.'),
  throughputWeekly: label('productivity', 'series', 'Vazão semanal', 'Quantidade de tarefas e de demandas concluídas em cada semana do período.'),
  throughputMonthly: label('productivity', 'series', 'Vazão mensal', 'Quantidade de tarefas e de demandas concluídas em cada mês do período.'),
  leadTimeAvgDays: label('productivity', 'days', 'Lead time médio', 'Tempo médio, em dias, entre a criação da tarefa e a sua conclusão.'),
  leadTimeMedianDays: label('productivity', 'days', 'Lead time mediano', 'Metade das tarefas concluídas levou até este número de dias entre a criação e a conclusão.'),
  cycleTimeAvgDays: label('productivity', 'days', 'Tempo de ciclo médio', 'Tempo médio, em dias, entre o início do trabalho (primeira vez em andamento) e a conclusão.'),
  cycleTimeMedianDays: label('productivity', 'days', 'Tempo de ciclo mediano', 'Metade das tarefas concluídas levou até este número de dias entre o início do trabalho e a conclusão.'),
  reworkRate: label('productivity', 'ratio', 'Taxa de retrabalho', 'Parcela das tarefas concluídas no período que foram reabertas ou devolvidas da revisão ao menos uma vez.'),
  reworkCount: label('productivity', 'count', 'Tarefas com retrabalho', 'Tarefas concluídas no período que foram reabertas ou devolvidas da revisão ao menos uma vez.'),
  avgTimePerTaskSeconds: label('productivity', 'seconds', 'Tempo médio por tarefa', 'Média do tempo apontado nas tarefas concluídas no período que têm apontamentos.'),
  // Prazos
  completedWithDue: label('deadlines', 'count', 'Concluídas com prazo', 'Tarefas concluídas no período que tinham prazo definido no momento da conclusão.'),
  completedOnTime: label('deadlines', 'count', 'Concluídas no prazo', 'Tarefas concluídas até a data do prazo que valia no momento da conclusão.'),
  completedLate: label('deadlines', 'count', 'Concluídas com atraso', 'Tarefas concluídas depois da data do prazo que valia no momento da conclusão.'),
  onTimeRate: label('deadlines', 'ratio', 'Pontualidade', 'Parcela das tarefas com prazo que foram concluídas em dia (vale o prazo vigente no momento da conclusão).'),
  overdueOpen: label('deadlines', 'count', 'Atrasadas em aberto', 'Tarefas em aberto cujo prazo já tinha passado na data de referência.'),
  avgDelayDays: label('deadlines', 'days', 'Atraso médio na entrega', 'Média de dias de atraso das tarefas concluídas depois do prazo.'),
  avgOverdueDays: label('deadlines', 'days', 'Atraso médio das pendentes', 'Média de dias de atraso das tarefas em aberto com o prazo vencido.'),
  plannedVsDone: label('deadlines', 'series', 'Planejado × realizado', 'Por semana: tarefas planejadas, adicionadas durante a semana e concluídas dentro dela.'),
  weeklyAdherence: label('deadlines', 'ratio', 'Cumprimento do plano semanal', 'Média, entre as semanas com planejamento, da parcela das tarefas planejadas que foi concluída na própria semana.'),
  // Capacidade
  wip: label('capacity', 'count', 'Em andamento (WIP)', 'Tarefas com status em andamento na data de referência.'),
  inFlight: label('capacity', 'count', 'Trabalho iniciado', 'Tarefas iniciadas e ainda não encerradas: em andamento, aguardando terceiros, bloqueadas ou em revisão.'),
  pending: label('capacity', 'count', 'Pendentes', 'Tarefas em aberto (nem concluídas nem canceladas) na data de referência; arquivadas e excluídas ficam de fora.'),
  estimatedMinutesOpen: label('capacity', 'minutes', 'Estimativa em aberto', 'Soma das estimativas das tarefas em aberto na data de referência (a estimativa da tarefa principal cobre as subtarefas).'),
  estimatedMinutesCompleted: label('capacity', 'minutes', 'Estimativa das concluídas', 'Soma das estimativas das tarefas concluídas no período.'),
  actualSecondsCompleted: label('capacity', 'seconds', 'Tempo real das concluídas', 'Tempo apontado, em qualquer data, nas tarefas concluídas no período.'),
  actualSecondsInRange: label('capacity', 'seconds', 'Tempo apontado no período', 'Soma de todos os apontamentos de tempo feitos em dias do período.'),
  hoursByProject: label('capacity', 'series', 'Tempo por projeto', 'Tempo apontado no período, agrupado por projeto (do maior para o menor).'),
  avgOpenAgeDays: label('capacity', 'days', 'Idade média das pendentes', 'Média de dias desde a criação das tarefas em aberto na data de referência.'),
  wipSeries: label('capacity', 'series', 'Evolução do trabalho em aberto', 'Tarefas em andamento e tarefas em aberto ao fim de cada dia (ou de cada semana, em períodos longos).'),
  // Bloqueios
  blockedNow: label('blocking', 'count', 'Bloqueadas', 'Tarefas com status bloqueada na data de referência.'),
  waitingNow: label('blocking', 'count', 'Aguardando terceiros', 'Tarefas aguardando informação ou ação externa na data de referência.'),
  avgBlockedHours: label('blocking', 'hours', 'Tempo médio de bloqueio', 'Duração média, em horas, dos bloqueios que tocam o período (os ainda abertos contam até a data de referência).'),
  avgWaitingHours: label('blocking', 'hours', 'Tempo médio de espera', 'Duração média, em horas, das esperas por terceiros que tocam o período (as ainda abertas contam até a data de referência).'),
  blockedHoursInRange: label('blocking', 'hours', 'Horas bloqueadas no período', 'Total de horas em que tarefas ficaram bloqueadas dentro do período.'),
  waitingHoursInRange: label('blocking', 'hours', 'Horas de espera no período', 'Total de horas em que tarefas ficaram aguardando terceiros dentro do período.'),
  pendingDependencies: label('blocking', 'count', 'Dependências pendentes', 'Ligações de dependência em que a tarefa e o seu pré-requisito ainda estão em aberto.'),
  blockedByDependency: label('blocking', 'count', 'Travadas por dependência', 'Tarefas em aberto com pelo menos um pré-requisito ainda em aberto.'),
});

// ---------------------------------------------------------------------------
// Estatística básica (reutilizável pelas telas)
// ---------------------------------------------------------------------------

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Média aritmética.
 * @param {Iterable<number>} values valores; os que não são números finitos são ignorados
 * @returns {number|null} a média, ou null quando não há nenhum número
 */
export function mean(values) {
  let total = 0;
  let count = 0;
  for (const v of values || []) {
    if (!isNumber(v)) continue;
    total += v;
    count++;
  }
  return count ? total / count : null;
}

/**
 * Mediana (com quantidade par, a média dos dois valores centrais).
 * @param {Iterable<number>} values valores em qualquer ordem (a lista não é alterada); não numéricos são ignorados
 * @returns {number|null} a mediana, ou null quando não há nenhum número
 */
export function median(values) {
  const list = [...(values || [])].filter(isNumber).sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

// ---------------------------------------------------------------------------
// Preparação: período, relógio, índices e trilhas
// ---------------------------------------------------------------------------

const asList = (v) => (Array.isArray(v) ? v : []);

/** O instante mais antigo entre os informados (ignora vazios); null se não houver nenhum. */
function earliest(...values) {
  let min = null;
  for (const v of values) if (typeof v === 'string' && v && (min === null || v < min)) min = v;
  return min;
}

function normalizeRange(range) {
  let from = range ? range.from : null;
  let to = range ? range.to : null;
  if (!isValidDateStr(from) || !isValidDateStr(to)) {
    throw new RangeError('Período inválido: informe range.from e range.to como datas no formato AAAA-MM-DD.');
  }
  if (from > to) [from, to] = [to, from];
  return { from, to, days: diffDays(from, to) + 1 };
}

/**
 * Instantes de referência. "Agora" vem de nowIso; sem ele, usa-se o fim do dia `today`; sem os dois, o fim do
 * período (o relógio do sistema nunca é consultado).
 */
function resolveClock(period, today, nowIso) {
  const fromIso = dateStrToIso(period.from, 'start');
  const toIso = dateStrToIso(period.to, 'end');
  const given = typeof nowIso === 'string' || nowIso instanceof Date ? new Date(nowIso).getTime() : NaN;
  let now;
  if (Number.isFinite(given)) now = new Date(given).toISOString();
  else if (isValidDateStr(today)) now = dateStrToIso(today, 'end');
  else now = toIso;
  const asOfIso = now < toIso ? now : toIso;
  return { fromIso, toIso, nowIso: now, nowMs: ms(now), asOfIso, asOfMs: ms(asOfIso), asOfDate: isoToDateStr(asOfIso) };
}

function indexById(rows) {
  const map = new Map();
  for (const row of asList(rows)) if (row && row.id !== undefined && row.id !== null) map.set(row.id, row);
  return map;
}

function normalizeFilters(filters) {
  const f = filters && typeof filters === 'object' ? filters : {};
  const ids = f.statusIds instanceof Set ? [...f.statusIds] : asList(f.statusIds);
  return {
    // undefined = sem filtro; '' = "sem projeto"
    projectId: f.projectId === undefined || f.projectId === null ? undefined : f.projectId,
    demandId: f.demandId === undefined || f.demandId === null || f.demandId === '' ? undefined : f.demandId,
    statusIds: ids.length ? new Set(ids) : null,
  };
}

function inScope(scope, projectId, demandId) {
  if (scope.projectId !== undefined && (projectId || '') !== scope.projectId) return false;
  if (scope.demandId !== undefined && demandId !== scope.demandId) return false;
  return true;
}

/**
 * Pais de uma tarefa, do mais próximo ao mais distante. Dados inconsistentes vindos da sincronização são
 * tolerados: pai inexistente encerra a subida e um ciclo faz a tarefa ser tratada como de nível superior.
 */
function ancestorsOf(task, tasksById) {
  const chain = [];
  const seen = new Set([task.id]);
  let current = task;
  while (current.parent_id) {
    const parent = tasksById.get(current.parent_id);
    if (!parent) break;
    if (seen.has(parent.id)) return [];
    seen.add(parent.id);
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/**
 * Trilha = uma linha (tarefa ou demanda) + tudo que as métricas precisam saber dela. Os eventos e os intervalos de
 * status são calculados só quando usados (e uma vez só).
 */
function makeTrack(type, row, eventIndex, intervalOptions, extra) {
  let events = null;
  let intervals = null;
  return {
    row,
    ...extra,
    get events() {
      if (!events) events = eventsOf(eventIndex, type, row.id);
      return events;
    },
    get intervals() {
      if (!intervals) intervals = statusIntervals(row, this.events, intervalOptions);
      return intervals;
    },
    /** Instante de criação segundo a linha do tempo (created_at, ou o primeiro evento). */
    get createdIso() {
      return this.intervals[0].from;
    },
  };
}

function buildModel({ tasks, demands, projects, activity, statuses, filters }, clock) {
  const projectsById = indexById(projects);
  const demandsById = indexById(demands);
  const tasksById = indexById(tasks);
  const eventIndex = indexEvents(asList(activity).filter((ev) => ev && typeof ev === 'object'));
  const scope = normalizeFilters(filters);
  const intervalOptions = { statuses, nowIso: clock.nowIso };

  const demandTracks = new Map();
  for (const demand of demandsById.values()) {
    const projectId = demand.project_id || null;
    const project = projectId ? projectsById.get(projectId) : null;
    demandTracks.set(
      demand.id,
      makeTrack('demand', demand, eventIndex, intervalOptions, {
        goneSince: earliest(demand.deleted_at, project && project.deleted_at),
        shelvedSince: earliest(demand.archived_at, project && project.archived_at),
        demandId: demand.id,
        projectId,
        inScope: inScope(scope, projectId, demand.id),
      }),
    );
  }

  const taskTracks = new Map();
  for (const task of tasksById.values()) {
    const ancestors = ancestorsOf(task, tasksById);
    const holder = task.demand_id ? task : ancestors.find((a) => a.demand_id);
    const demandId = holder ? holder.demand_id : null;
    const demandTrack = demandId ? demandTracks.get(demandId) : null;
    const projectId = demandTrack ? demandTrack.projectId : null;
    taskTracks.set(
      task.id,
      makeTrack('task', task, eventIndex, intervalOptions, {
        goneSince: earliest(task.deleted_at, ...ancestors.map((a) => a.deleted_at), demandTrack && demandTrack.goneSince),
        shelvedSince: earliest(task.archived_at, ...ancestors.map((a) => a.archived_at), demandTrack && demandTrack.shelvedSince),
        demandId,
        projectId,
        parentId: ancestors.length ? ancestors[0].id : null,
        inScope: inScope(scope, projectId, demandId),
      }),
    );
  }

  return { scope, projectsById, taskTracks, tasks: [...taskTracks.values()], demands: [...demandTracks.values()] };
}

// ---------------------------------------------------------------------------
// Estado de uma trilha num instante
// ---------------------------------------------------------------------------

/** Já tinha sido excluída (ela própria, o pai, a demanda ou o projeto) no instante dado? */
const goneAt = (track, atIso) => track.goneSince !== null && track.goneSince <= atIso;

/** Existia no instante dado: já criada e ainda não excluída. */
const aliveAt = (track, atIso) => existedAt(track.row, atIso) && !goneAt(track, atIso);

/** Estava arquivada (ela própria, o pai, a demanda ou o projeto) no instante dado? */
const shelvedAt = (track, atIso) => track.shelvedSince !== null && track.shelvedSince <= atIso;

/** Intervalo de status vigente se a trilha estava EM ABERTO no instante dado; senão null. */
function openStateAt(track, atIso) {
  if (!aliveAt(track, atIso) || shelvedAt(track, atIso)) return null;
  const state = statusAt(track.intervals, atIso);
  return state && isOpenCategory(state.category) ? state : null;
}

/** Tarefas do escopo em aberto no instante dado (respeitando o filtro de status): [{ track, state }]. */
function openTasksAt(model, atIso) {
  const out = [];
  const { statusIds } = model.scope;
  for (const track of model.tasks) {
    if (!track.inScope) continue;
    const state = openStateAt(track, atIso);
    if (!state || (statusIds && !statusIds.has(state.status))) continue;
    out.push({ track, state });
  }
  return out;
}

/** Estimativa (minutos) vigente no instante dado, desfazendo as alterações posteriores registradas no histórico. */
function estimateAt(track, atIso) {
  const changes = fieldChanges(track.events, { action: ACTIONS.UPDATED, field: 'estimate_minutes' });
  const value = Number(valueAt(track.row.estimate_minutes ?? null, changes, atIso));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Períodos (semanas, meses, amostras da série)
// ---------------------------------------------------------------------------

/** Segundas-feiras de todas as semanas que tocam o período, em ordem. */
function weeksOf(period) {
  const out = [];
  for (let week = startOfWeek(period.from); week <= period.to; week = addDays(week, 7)) out.push(week);
  return out;
}

/** 'YYYY-MM' de todos os meses que tocam o período, em ordem. */
function monthsOf(period) {
  const out = [];
  for (let month = startOfMonth(period.from); month <= period.to; month = addMonths(month, 1)) out.push(monthKey(month));
  return out;
}

/**
 * Pontos da série temporal: um por dia (períodos de até DAILY_SERIES_MAX_DAYS dias) ou um por semana, sempre no fim
 * de cada período. Datas depois de asOf não entram (ainda não aconteceram); o ponto do dia de asOf é medido em asOf.
 */
function seriesSamples(period, clock) {
  const out = [];
  const add = (date) => out.push({ date, iso: date === clock.asOfDate ? clock.asOfIso : dateStrToIso(date, 'end') });
  if (period.days <= DAILY_SERIES_MAX_DAYS) {
    for (let day = period.from; day <= period.to && day <= clock.asOfDate; day = addDays(day, 1)) add(day);
    return out;
  }
  for (const weekStart of weeksOf(period)) {
    const first = weekStart < period.from ? period.from : weekStart;
    if (first > clock.asOfDate) break;
    const weekEnd = addDays(weekStart, 6);
    const last = weekEnd > period.to ? period.to : weekEnd;
    add(last > clock.asOfDate ? clock.asOfDate : last);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Apontamentos de tempo
// ---------------------------------------------------------------------------

const seconds = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Segundos de um apontamento. Cronômetro rodando conta os trechos fechados mais o trecho em curso até `nowMs`;
 * pausado conta o acumulado; encerrado (ou lançamento manual) conta a duração gravada.
 */
function entrySeconds(entry, nowMs) {
  if (entry.state === 'running') {
    const started = ms(entry.segment_started_at);
    const live = Number.isFinite(started) && Number.isFinite(nowMs) ? Math.max(0, Math.floor((nowMs - started) / 1000)) : 0;
    return seconds(entry.accumulated_seconds) + live;
  }
  if (entry.state === 'paused') return Math.max(seconds(entry.accumulated_seconds), seconds(entry.duration_seconds));
  return seconds(entry.duration_seconds);
}

/** Dia (local) de um apontamento: entry_date ou, na falta, o dia de started_at. */
function entryDate(entry) {
  return isValidDateStr(entry.entry_date) ? entry.entry_date : isoToDateStr(entry.started_at);
}

/** Tempo apontado por tarefa (qualquer data), ignorando apontamentos excluídos: Map<taskId, segundos>. */
function trackedByTask(timeEntries, nowMs) {
  const totals = new Map();
  for (const entry of timeEntries) {
    if (!entry || entry.deleted_at || entry.task_id == null) continue;
    const s = entrySeconds(entry, nowMs);
    if (s > 0) totals.set(entry.task_id, (totals.get(entry.task_id) || 0) + s);
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Blocos do resultado
// ---------------------------------------------------------------------------

/**
 * Itens do escopo concluídos no período: a conclusão começou dentro de [início do período, asOf] e continuava em
 * vigor em asOf (concluído e reaberto dentro do período não conta). Devolve [{ track, at, date }].
 */
function completedInRange(tracks, clock) {
  const out = [];
  if (clock.fromIso > clock.asOfIso) return out; // período inteiro no futuro
  for (const track of tracks) {
    if (!track.inScope || !aliveAt(track, clock.asOfIso)) continue;
    const at = completedWithin(track.intervals, clock.fromIso, clock.asOfIso);
    if (at) out.push({ track, at, date: isoToDateStr(at) });
  }
  return out;
}

function buildThroughput(weeks, months, doneTasks, doneDemands) {
  const weekly = new Map(weeks.map((weekStart) => [weekStart, { weekStart, tasks: 0, demands: 0 }]));
  const monthly = new Map(months.map((month) => [month, { month, tasks: 0, demands: 0 }]));
  const tally = (list, key) => {
    for (const done of list) {
      const week = weekly.get(startOfWeek(done.date));
      if (week) week[key]++;
      const month = monthly.get(monthKey(done.date));
      if (month) month[key]++;
    }
  };
  tally(doneTasks, 'tasks');
  tally(doneDemands, 'demands');
  return { throughputWeekly: [...weekly.values()], throughputMonthly: [...monthly.values()] };
}

function buildProductivity(doneTasks, doneDemands, throughput, tracked, clock) {
  const lead = [];
  const cycle = [];
  const spent = [];
  let reworkCount = 0;
  for (const done of doneTasks) {
    const { track, at } = done;
    const doneMs = ms(at);
    lead.push((doneMs - ms(track.createdIso)) / DAY_MS);
    // Tempo de ciclo: só para quem passou por um status "em voo" antes de concluir.
    const started = firstEntered(track.intervals, IN_FLIGHT_CATEGORIES);
    if (started !== null && started <= at) cycle.push((doneMs - ms(started)) / DAY_MS);
    // Retrabalho: o que aconteceu até asOf (reaberturas posteriores ao período não contam).
    const info = completionInfo(track.intervals.filter((it) => it.from <= clock.asOfIso));
    if (info.reopenCount > 0 || info.reviewReturns > 0) reworkCount++;
    const s = tracked.get(track.row.id) || 0;
    if (s > 0) spent.push(s);
  }
  return {
    tasksCompleted: doneTasks.length,
    demandsCompleted: doneDemands.length,
    throughputWeekly: throughput.throughputWeekly,
    throughputMonthly: throughput.throughputMonthly,
    leadTimeAvgDays: mean(lead),
    leadTimeMedianDays: median(lead),
    cycleTimeAvgDays: mean(cycle),
    cycleTimeMedianDays: median(cycle),
    reworkRate: doneTasks.length ? reworkCount / doneTasks.length : null,
    reworkCount,
    avgTimePerTaskSeconds: mean(spent),
  };
}

/**
 * Planejado × realizado por semana, a partir de week_items (mesma lógica de "Minha Semana"):
 *   • valem os itens não excluídos e não retirados do plano, cuja tarefa esteja no escopo e exista em asOf;
 *   • uma tarefa conta uma vez por semana (itens duplicados por dois dispositivos); 'planned' vence 'added';
 *   • "concluída na semana" vem do histórico: conclusão iniciada dentro da semana e ainda em vigor no fim dela
 *     (ou em asOf, se a semana ainda não terminou);
 *   • adherence = planejadas concluídas ÷ planejadas; null sem planejadas ou em semana que ainda não começou.
 */
function buildPlannedVsDone(weeks, weekItems, model, clock) {
  const plans = new Map(weeks.map((weekStart) => [weekStart, new Map()]));
  for (const item of weekItems) {
    if (!item || item.deleted_at || item.removed_at) continue;
    const plan = plans.get(startOfWeek(item.week_start));
    if (!plan) continue;
    const track = model.taskTracks.get(item.task_id);
    if (!track || !track.inScope || !aliveAt(track, clock.asOfIso)) continue;
    const kind = item.kind === 'added' ? 'added' : 'planned';
    const known = plan.get(item.task_id);
    if (!known) plan.set(item.task_id, { track, kind });
    else if (kind === 'planned') known.kind = 'planned';
  }

  return weeks.map((weekStart) => {
    const startIso = dateStrToIso(weekStart, 'start');
    const endOfWeekIso = dateStrToIso(addDays(weekStart, 6), 'end');
    const endIso = endOfWeekIso < clock.asOfIso ? endOfWeekIso : clock.asOfIso;
    const started = startIso <= clock.asOfIso;
    let planned = 0;
    let added = 0;
    let completed = 0;
    let completedPlanned = 0;
    for (const { track, kind } of plans.get(weekStart).values()) {
      if (kind === 'planned') planned++;
      else added++;
      if (!started || !completedWithin(track.intervals, startIso, endIso)) continue;
      completed++;
      if (kind === 'planned') completedPlanned++;
    }
    return { weekStart, planned, added, completed, completedPlanned, adherence: started && planned ? completedPlanned / planned : null };
  });
}

function buildDeadlines(doneTasks, openNow, plannedVsDone, clock) {
  let completedWithDue = 0;
  let completedOnTime = 0;
  const delays = [];
  for (const { track, at, date } of doneTasks) {
    const due = dueDateAt(track.row, track.events, at); // prazo vigente no momento da conclusão
    if (!isValidDateStr(due)) continue;
    completedWithDue++;
    const late = diffDays(due, date);
    if (late > 0) delays.push(late);
    else completedOnTime++;
  }
  const overdue = [];
  for (const { track } of openNow) {
    const due = dueDateAt(track.row, track.events, clock.asOfIso);
    if (isValidDateStr(due) && due < clock.asOfDate) overdue.push(diffDays(due, clock.asOfDate));
  }
  return {
    completedWithDue,
    completedOnTime,
    completedLate: delays.length,
    onTimeRate: completedWithDue ? completedOnTime / completedWithDue : null,
    overdueOpen: overdue.length,
    avgDelayDays: mean(delays),
    avgOverdueDays: mean(overdue),
    plannedVsDone,
    weeklyAdherence: mean(plannedVsDone.map((week) => week.adherence)),
  };
}

function buildHours(timeEntries, model, period, clock) {
  let total = 0;
  const byProject = new Map();
  for (const entry of timeEntries) {
    if (!entry || entry.deleted_at) continue;
    const track = model.taskTracks.get(entry.task_id);
    // Tempo lançado depois (dia anterior à criação da tarefa) vale; tempo de tarefa excluída, não.
    if (!track || !track.inScope || goneAt(track, clock.asOfIso)) continue;
    const date = entryDate(entry);
    if (!date || date < period.from || date > period.to) continue;
    const s = entrySeconds(entry, clock.nowMs);
    if (s <= 0) continue;
    total += s;
    byProject.set(track.projectId, (byProject.get(track.projectId) || 0) + s);
  }
  const nameOf = (projectId) => {
    if (projectId === null) return NO_PROJECT_LABEL;
    const project = model.projectsById.get(projectId);
    const name = project && typeof project.name === 'string' ? project.name.trim() : '';
    return name || UNKNOWN_PROJECT_LABEL;
  };
  const hoursByProject = [...byProject]
    .map(([projectId, s]) => ({ projectId, name: nameOf(projectId), seconds: s }))
    .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name, 'pt-BR'));
  return { actualSecondsInRange: total, hoursByProject };
}

/**
 * Soma das estimativas (minutos, valor vigente em asOf) de um conjunto de tarefas, sem contar o mesmo trabalho
 * duas vezes. Mesma regra do resto do app (tempo por demanda, painel da demanda): a estimativa da tarefa
 * principal cobre as subtarefas — a de uma subtarefa fica de fora quando a principal, com estimativa própria,
 * está no MESMO conjunto. Principal fora do conjunto (já concluída, filtrada por status…) não esconde a subtarefa.
 */
function estimateSum(tracks, atIso) {
  const estimates = new Map(tracks.map((track) => [track.row.id, estimateAt(track, atIso)]));
  let total = 0;
  for (const track of tracks) {
    const parentId = track.parentId;
    if (parentId !== null && parentId !== undefined && estimates.get(parentId) > 0) continue;
    total += estimates.get(track.row.id);
  }
  return total;
}

function buildCapacity(doneTasks, openNow, tracked, hours, wipSeries, clock) {
  let wip = 0;
  let inFlight = 0;
  const ages = [];
  for (const { track, state } of openNow) {
    if (state.category === 'active') wip++;
    if (IN_FLIGHT_CATEGORIES.includes(state.category)) inFlight++;
    ages.push(Math.max(0, clock.asOfMs - ms(track.createdIso)) / DAY_MS);
  }
  const estimatedMinutesOpen = estimateSum(openNow.map(({ track }) => track), clock.asOfIso);
  const estimatedMinutesCompleted = estimateSum(doneTasks.map(({ track }) => track), clock.asOfIso);
  let actualSecondsCompleted = 0;
  for (const { track } of doneTasks) {
    actualSecondsCompleted += tracked.get(track.row.id) || 0;
  }
  return {
    wip,
    inFlight,
    pending: openNow.length,
    estimatedMinutesOpen,
    estimatedMinutesCompleted,
    actualSecondsCompleted,
    actualSecondsInRange: hours.actualSecondsInRange,
    hoursByProject: hours.hoursByProject,
    avgOpenAgeDays: mean(ages),
    wipSeries,
  };
}

function buildWipSeries(model, period, clock) {
  return seriesSamples(period, clock).map(({ date, iso }) => {
    const open = openTasksAt(model, iso);
    return { date, wip: open.filter(({ state }) => state.category === 'active').length, open: open.length };
  });
}

/**
 * Trechos em que as tarefas do escopo ficaram numa categoria (bloqueada ou aguardando).
 *   • `spans`: duração (horas) de cada trecho que toca o período — inteira, do início do trecho até o seu fim;
 *     trecho ainda aberto é cortado em asOf (ou no arquivamento, se a tarefa foi arquivada antes);
 *   • `inRange`: total de horas dentro do período (recortado nas duas pontas).
 */
function categoryTime(model, clock, category) {
  const spans = [];
  let inRangeMs = 0;
  for (const track of model.tasks) {
    if (!track.inScope || !aliveAt(track, clock.asOfIso)) continue;
    const limit = track.shelvedSince !== null && track.shelvedSince < clock.asOfIso ? track.shelvedSince : clock.asOfIso;
    for (const span of spansOfCategories(track.intervals, [category])) {
      if (span.from >= limit) continue; // ainda não tinha começado
      const end = span.to < limit ? span.to : limit;
      if (end <= clock.fromIso) continue; // terminou antes do período
      spans.push((ms(end) - ms(span.from)) / HOUR_MS);
    }
    inRangeMs += timeInCategories(track.intervals, [category], { from: clock.fromIso, to: limit });
  }
  return { spans, inRange: inRangeMs / HOUR_MS };
}

/**
 * Dependências pendentes em asOf. Arestas duplicadas (mesmo par) contam uma vez; a dependente precisa estar no
 * escopo (e no filtro de status); o pré-requisito pode ser de qualquer projeto, basta estar em aberto.
 */
function buildDependencies(dependencies, model, clock) {
  const { statusIds } = model.scope;
  const seen = new Set();
  const blocked = new Set();
  let pending = 0;
  for (const dep of dependencies) {
    if (!dep || dep.task_id == null || dep.depends_on_id == null || dep.task_id === dep.depends_on_id) continue;
    if (!existedAt(dep, clock.asOfIso)) continue;
    const key = `${dep.task_id}\u0000${dep.depends_on_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const dependent = model.taskTracks.get(dep.task_id);
    const prerequisite = model.taskTracks.get(dep.depends_on_id);
    if (!dependent || !prerequisite || !dependent.inScope) continue;
    const state = openStateAt(dependent, clock.asOfIso);
    if (!state || (statusIds && !statusIds.has(state.status))) continue;
    if (!openStateAt(prerequisite, clock.asOfIso)) continue;
    pending++;
    blocked.add(dep.task_id);
  }
  return { pendingDependencies: pending, blockedByDependency: blocked.size };
}

function buildBlocking(openNow, dependencies, model, clock) {
  let blockedNow = 0;
  let waitingNow = 0;
  for (const { state } of openNow) {
    if (state.category === 'blocked') blockedNow++;
    else if (state.category === 'waiting') waitingNow++;
  }
  const blocked = categoryTime(model, clock, 'blocked');
  const waiting = categoryTime(model, clock, 'waiting');
  return {
    blockedNow,
    waitingNow,
    avgBlockedHours: mean(blocked.spans),
    avgWaitingHours: mean(waiting.spans),
    blockedHoursInRange: blocked.inRange,
    waitingHoursInRange: waiting.inRange,
    ...buildDependencies(dependencies, model, clock),
  };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * Calcula todos os indicadores de um período.
 *
 * @param {object} input
 * @param {object[]} input.tasks         tarefas e subtarefas — TODAS as linhas, inclusive excluídas e arquivadas
 * @param {object[]} input.demands       demandas (idem)
 * @param {object[]} input.projects      projetos (idem)
 * @param {object[]} input.dependencies  linhas de task_dependencies (task_id depende de depends_on_id)
 * @param {object[]} input.timeEntries   apontamentos de tempo
 * @param {object[]} input.weekItems     itens do planejamento semanal
 * @param {object[]} input.activity      registro de atividades (activity_log) completo
 * @param {Array}    input.statuses      lista efetiva de status (resolveStatuses)
 * @param {{from: string, to: string}} input.range  período em datas locais 'YYYY-MM-DD', inclusivo nas duas pontas
 *        (se vier invertido, é corrigido; datas inválidas lançam RangeError)
 * @param {{projectId?: string, demandId?: string, statusIds?: string[]}} [input.filters]
 *        projectId: id do projeto, '' para "sem projeto", null/undefined para todos — restringe tarefas (o projeto da
 *        tarefa é o da sua demanda) e demandas; demandId: id da demanda — restringe tarefas e demandas;
 *        statusIds: restringe apenas os números "de situação" (pendentes, WIP, atrasadas, bloqueadas, série de WIP,
 *        dependências) às tarefas que tinham um desses status no instante medido.
 * @param {string} [input.today]   data de hoje ('YYYY-MM-DD'); usada só quando nowIso não é informado
 * @param {string} input.nowIso    instante atual (ISO UTC)
 *
 * @returns {object} resultado — médias são números puros (sem arredondar) e null quando não há dados:
 *   range        { from, to, days }
 *   asOf         instante de referência (ISO): o mais cedo entre o fim do período e nowIso
 *   asOfDate     data local de asOf
 *   productivity { tasksCompleted, demandsCompleted, throughputWeekly: [{ weekStart, tasks, demands }],
 *                  throughputMonthly: [{ month, tasks, demands }], leadTimeAvgDays, leadTimeMedianDays,
 *                  cycleTimeAvgDays, cycleTimeMedianDays, reworkRate, reworkCount, avgTimePerTaskSeconds }
 *   deadlines    { completedWithDue, completedOnTime, completedLate, onTimeRate, overdueOpen, avgDelayDays,
 *                  avgOverdueDays, plannedVsDone: [{ weekStart, planned, added, completed, completedPlanned, adherence }],
 *                  weeklyAdherence }
 *   capacity     { wip, inFlight, pending, estimatedMinutesOpen, estimatedMinutesCompleted, actualSecondsCompleted,
 *                  actualSecondsInRange, hoursByProject: [{ projectId, name, seconds }], avgOpenAgeDays,
 *                  wipSeries: [{ date, wip, open }] }
 *   blocking     { blockedNow, waitingNow, avgBlockedHours, avgWaitingHours, blockedHoursInRange,
 *                  waitingHoursInRange, pendingDependencies, blockedByDependency }
 *   series       atalho para as listas: { throughputWeekly, throughputMonthly, plannedVsDone, wipSeries, hoursByProject }
 *
 * Regras (o significado de cada chave está em METRIC_LABELS):
 *   • subtarefas contam como tarefas; canceladas nunca são "concluídas" nem "pendentes";
 *   • "concluída no período" = a conclusão começou no período e continuava valendo em asOf;
 *   • as vazões semanal e mensal somam exatamente tasksCompleted / demandsCompleted, e trazem todas as semanas e
 *     meses que tocam o período (com zeros);
 *   • tempo de ciclo começa na primeira entrada em andamento / aguardando / bloqueada / em revisão; quem foi direto
 *     para concluída fica fora da média;
 *   • pontualidade compara a data local da conclusão com o prazo vigente naquele momento;
 *   • cronômetros rodando contam o tempo decorrido até nowIso;
 *   • wipSeries tem um ponto por dia em períodos de até 62 dias e um por semana nos maiores, sempre no fim de cada
 *     dia/semana; dias depois de asOf não entram.
 */
export function computeMetrics(input) {
  const { tasks, demands, projects, dependencies, timeEntries, weekItems, activity, statuses, range, filters, today, nowIso } = input || {};
  const period = normalizeRange(range);
  const clock = resolveClock(period, today, nowIso);
  const model = buildModel({ tasks, demands, projects, activity, statuses, filters }, clock);
  const entries = asList(timeEntries);
  const weeks = weeksOf(period);

  const doneTasks = completedInRange(model.tasks, clock);
  const doneDemands = completedInRange(model.demands, clock);
  const openNow = openTasksAt(model, clock.asOfIso);
  const tracked = trackedByTask(entries, clock.nowMs);

  const throughput = buildThroughput(weeks, monthsOf(period), doneTasks, doneDemands);
  const plannedVsDone = buildPlannedVsDone(weeks, asList(weekItems), model, clock);
  const hours = buildHours(entries, model, period, clock);
  const wipSeries = buildWipSeries(model, period, clock);

  const productivity = buildProductivity(doneTasks, doneDemands, throughput, tracked, clock);
  const deadlines = buildDeadlines(doneTasks, openNow, plannedVsDone, clock);
  const capacity = buildCapacity(doneTasks, openNow, tracked, hours, wipSeries, clock);
  const blocking = buildBlocking(openNow, asList(dependencies), model, clock);

  return {
    range: period,
    asOf: clock.asOfIso,
    asOfDate: clock.asOfDate,
    productivity,
    deadlines,
    capacity,
    blocking,
    series: {
      throughputWeekly: productivity.throughputWeekly,
      throughputMonthly: productivity.throughputMonthly,
      plannedVsDone,
      wipSeries,
      hoursByProject: capacity.hoursByProject,
    },
  };
}
