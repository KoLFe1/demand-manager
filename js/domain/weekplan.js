// "Minha Semana" — planejamento semanal (seção 9 do pedido).
// Regras PURAS: sem DOM, sem banco e sem relógio implícito ("agora" chega em nowIso; "hoje" em today).
//
// Um item de week_items liga uma TAREFA a uma SEMANA (week_start = segunda-feira, 'YYYY-MM-DD' local):
//
//   kind             'planned' (entrou no planejamento, até o fim da segunda-feira) | 'added' (durante a semana)
//   added_at         quando entrou no plano
//   removed_at       retirado do plano — a linha fica, para o histórico
//   carried_to_week  semana para onde o trabalho não concluído foi transferido
//   carried_from_id  item (da semana de origem) que deu origem a este
//
// Princípios:
//   • O plano de uma semana nunca é apagado: retirar marca removed_at; transferir marca carried_to_week no
//     item original e cria um item NOVO na semana de destino.
//   • "Concluída na semana" vem do HISTÓRICO de status (timeline.js), não do status atual: concluída e
//     reaberta dentro da semana não conta; concluída na semana e reaberta depois continua contando.
//   • Uma tarefa aparece uma vez só por semana: itens duplicados (o mesmo par criado em dois dispositivos)
//     são fundidos na leitura — vale o de added_at mais antigo.
//   • As listas devolvidas são novas a cada chamada; as linhas recebidas nunca são alteradas.

import { addDays, compareDates, dateStrToIso, isValidDateStr, isoToDateStr, ms, startOfWeek, weekDays } from '../core/dates.js';
import { comparePriority, priorityRank } from './priorities.js';
import { categoryOf, isOpen } from './statuses.js';
import { ACTIONS, completedWithin, eventsOf, statusAt, statusIntervals } from './timeline.js';

/** Tipo do item no plano (campo `kind`). */
export const WEEK_KIND = Object.freeze({ PLANNED: 'planned', ADDED: 'added' });

/** Desfecho de um item no resumo da semana (ver weekSummary). */
export const WEEK_OUTCOME = Object.freeze({
  DONE: 'done',
  OPEN: 'open',
  CARRIED: 'carried',
  REMOVED: 'removed',
  CANCELLED: 'cancelled',
  MISSING: 'missing',
});

/** Fase da semana em relação a hoje. */
export const WEEK_PHASE = Object.freeze({ PAST: 'past', CURRENT: 'current', FUTURE: 'future' });

/** Rótulos (pt-BR) do tipo do item. */
export const WEEK_KIND_LABELS = Object.freeze({
  planned: 'Planejada',
  added: 'Adicionada durante a semana',
});

/** Rótulos (pt-BR) dos desfechos. */
export const WEEK_OUTCOME_LABELS = Object.freeze({
  done: 'Concluída',
  open: 'Não concluída',
  carried: 'Transferida',
  removed: 'Retirada do plano',
  cancelled: 'Cancelada',
  missing: 'Tarefa excluída',
});

/** Capacidade semanal padrão, em horas (planLoad). */
export const DEFAULT_HOURS_PER_WEEK = 40;

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

/** Menor instante possível na comparação de textos ISO (toda data real vem depois). */
const BEGINNING_OF_TIME = '0000-01-01T00:00:00.000Z';

const nameCollator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

const compareKeys = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Busca em Map ou em objeto simples (as duas formas são aceitas em tasksById). */
function lookup(index, id) {
  if (!index || id === null || id === undefined) return undefined;
  return typeof index.get === 'function' ? index.get(id) : index[id];
}

/** Instante obrigatório -> ISO canônico (lança RangeError com mensagem clara se for inválido). */
function requireIso(value, name = 'nowIso') {
  const t = ms(value);
  if (!Number.isFinite(t)) throw new RangeError(`${name} inválido: ${String(value)}`);
  return new Date(t).toISOString();
}

/** Instante ISO canônico ou null. */
function canonicalIso(value) {
  const t = ms(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const minIso = (a, b) => (a < b ? a : b);

/** Tipo efetivo do item (valor desconhecido cai no padrão do schema: 'planned'). */
const kindOf = (item) => (item.kind === WEEK_KIND.ADDED ? WEEK_KIND.ADDED : WEEK_KIND.PLANNED);

/** Ordem cronológica de entrada no plano: added_at, depois created_at, depois id (vazios por último). */
function compareByAddedAt(a, b) {
  const ka = a.added_at || a.created_at || '';
  const kb = b.added_at || b.created_at || '';
  if (ka !== kb) {
    if (!ka) return 1;
    if (!kb) return -1;
    return ka < kb ? -1 : 1;
  }
  return compareKeys(String(a.created_at || ''), String(b.created_at || '')) || compareKeys(String(a.id || ''), String(b.id || ''));
}

/** Entre duplicados da mesma tarefa: o item ativo vence o retirado; depois, o mais antigo. */
function preferItem(a, b) {
  const ra = a.removed_at ? 1 : 0;
  const rb = b.removed_at ? 1 : 0;
  return ra - rb || compareByAddedAt(a, b);
}

/** O item pertence à semana [start, end]? (aceita week_start que não caia na segunda-feira) */
function inWeek(item, range) {
  const ws = item.week_start;
  return typeof ws === 'string' && ws >= range.start && ws <= range.end;
}

/** Itens (não excluídos, com tarefa) da semana, um por tarefa, em ordem de entrada no plano. */
function weekItems(items, range, includeRemoved) {
  const best = new Map();
  for (const item of items || []) {
    if (!item || item.deleted_at || item.task_id === null || item.task_id === undefined) continue;
    if (!includeRemoved && item.removed_at) continue;
    if (!inWeek(item, range)) continue;
    const current = best.get(item.task_id);
    if (!current || preferItem(item, current) < 0) best.set(item.task_id, item);
  }
  return [...best.values()].sort(compareByAddedAt);
}

/** Ordem padrão das listas de tarefas: prioridade, prazo (vazios por último), nome, id. */
function compareTasks(a, b) {
  return (
    comparePriority(a, b) ||
    compareDates(a.due_date, b.due_date) ||
    nameCollator.compare(String(a.name || ''), String(b.name || '')) ||
    compareKeys(String(a.id || ''), String(b.id || ''))
  );
}

const isStatusEvent = (e) => e.action === ACTIONS.STATUS || (e.action === ACTIONS.CREATED && !!e.meta && !!e.meta.status);

/**
 * Linha do tempo de status da tarefa, com um reparo para históricos incompletos.
 *
 * Normalmente é só statusIntervals(). Quando a tarefa está concluída mas o histórico NÃO explica essa conclusão
 * (nenhum evento de status — dados importados/semeados — ou evento ainda não sincronizado, caso em que
 * statusIntervals completa com um trecho sintético datado de updated_at), o melhor dado disponível para
 * "quando foi concluída" é o campo completed_at da própria tarefa, gravado junto com o status.
 */
function taskTimeline(task, events, { statuses, nowIso }) {
  const intervals = statusIntervals(task, events, { statuses, nowIso });
  const lastIndex = intervals.length - 1;
  const last = intervals[lastIndex];
  if (!last || last.category !== 'done') return intervals;
  if (!last.synthetic && events.some(isStatusEvent)) return intervals; // conclusão explicada pelo histórico
  const prev = intervals[lastIndex - 1] || null;
  if (prev && prev.category === 'done') return intervals; // já estava concluída antes (outro status de conclusão)
  let at = canonicalIso(task.completed_at);
  if (!at) return intervals;
  const floor = prev ? prev.from : last.from;
  if (at < floor) at = floor;
  if (at > nowIso) at = nowIso;
  if (prev) {
    return [...intervals.slice(0, lastIndex - 1), { ...prev, to: at }, { ...last, from: at }];
  }
  if (at <= last.from) return intervals;
  // Sem histórico nenhum: antes de completed_at a tarefa existia e estava aberta (status exato desconhecido).
  return [
    { status: null, category: 'planned', from: last.from, to: at, open: false, synthetic: true },
    { ...last, from: at },
  ];
}

/**
 * Situação da tarefa no instante de referência da semana, segundo o histórico.
 * @returns {{ completedAt: string|null, doneSince: string|null, cancelled: boolean }}
 *   completedAt  instante da conclusão quando ela ocorreu DENTRO de [fromIso, refIso] e valia em refIso
 *   doneSince    instante em que começou a conclusão vigente em refIso (pode ser anterior a fromIso)
 *   cancelled    estava cancelada em refIso
 */
function completionAt(task, events, { statuses, nowIso, fromIso, refIso }) {
  const intervals = taskTimeline(task, events, { statuses, nowIso });
  const current = statusAt(intervals, refIso);
  return {
    completedAt: completedWithin(intervals, fromIso, refIso),
    doneSince: completedWithin(intervals, BEGINNING_OF_TIME, refIso),
    cancelled: !!current && current.category === 'cancelled',
  };
}

const taskEvents = (eventsIndex, taskId) => (eventsIndex ? eventsOf(eventsIndex, 'task', taskId) : []);

// ---------------------------------------------------------------------------
// Semana e itens
// ---------------------------------------------------------------------------

/**
 * Limites de uma semana (segunda a domingo).
 * @param {string} weekStart 'YYYY-MM-DD' — qualquer dia da semana serve; é normalizado para a segunda-feira
 * @returns {{ start: string, end: string, days: string[], startIso: string, endIso: string }}
 *          start = segunda; end = domingo; days = os 7 dias; startIso = segunda 00:00:00.000 local em ISO UTC;
 *          endIso = domingo 23:59:59.999 local em ISO UTC.
 * @throws {RangeError} se weekStart não for uma data válida
 */
export function weekRange(weekStart) {
  const start = startOfWeek(weekStart);
  if (!start) throw new RangeError(`Semana inválida: ${String(weekStart)}`);
  const end = addDays(start, 6);
  return {
    start,
    end,
    days: weekDays(start),
    startIso: dateStrToIso(start, 'start'),
    endIso: dateStrToIso(end, 'end'),
  };
}

/**
 * Tipo de um item que está sendo acrescentado AGORA ao plano de uma semana.
 * @param {string} weekStart semana do item ('YYYY-MM-DD')
 * @param {string} nowIso    instante da inclusão
 * @returns {'planned'|'added'} 'planned' quando a data LOCAL de nowIso é a segunda-feira daquela semana ou
 *          antes dela (planejamento feito com antecedência ou na própria segunda); senão 'added'
 *          ("adicionado durante a semana").
 * @throws {RangeError} semana ou instante inválidos
 */
export function kindForNewItem(weekStart, nowIso) {
  const { start } = weekRange(weekStart);
  const today = isoToDateStr(requireIso(nowIso));
  return today <= start ? WEEK_KIND.PLANNED : WEEK_KIND.ADDED;
}

/**
 * Plano vigente da semana: itens não excluídos e não retirados (removed_at null), um por tarefa.
 * Duplicados da mesma tarefa (criados em dois dispositivos) viram um só: fica o de added_at mais antigo.
 * @param {Array<object>} items     linhas de week_items (de qualquer semana)
 * @param {string}        weekStart semana desejada
 * @returns {Array<object>} itens em ordem de entrada no plano (added_at)
 * @throws {RangeError} semana inválida
 */
export function activeWeekItems(items, weekStart) {
  return weekItems(items, weekRange(weekStart), false);
}

/**
 * Histórico do plano da semana: como activeWeekItems, mas incluindo os itens retirados (removed_at).
 * Continua sem os excluídos e com um item por tarefa — se a tarefa foi retirada e depois voltou ao plano,
 * vale o item ativo; entre itens na mesma situação, o de added_at mais antigo.
 * @param {Array<object>} items     linhas de week_items
 * @param {string}        weekStart semana desejada
 * @returns {Array<object>} itens em ordem de entrada no plano (added_at)
 * @throws {RangeError} semana inválida
 */
export function allWeekItems(items, weekStart) {
  return weekItems(items, weekRange(weekStart), true);
}

/**
 * Índice do plano vigente por tarefa — útil para saber se a tarefa está na semana e mostrar os selos
 * "adicionada durante a semana" / "transferida".
 * @param {Array<object>} items
 * @param {string}        weekStart
 * @returns {Map<string, object>} id da tarefa → item ativo
 */
export function weekItemsByTask(items, weekStart) {
  return new Map(activeWeekItems(items, weekStart).map((item) => [item.task_id, item]));
}

// ---------------------------------------------------------------------------
// Resumo da semana
// ---------------------------------------------------------------------------

/**
 * Resumo "planejado × realizado" de uma semana.
 *
 * Cada item da semana (um por tarefa, retirados incluídos) vira uma linha `{ item, task, kind, completedAt,
 * outcome, completedBefore }`. O desfecho é avaliado no instante de referência da semana — o fim do domingo
 * numa semana passada, `nowIso` na semana corrente — lendo o histórico de status:
 *
 *   'missing'    a tarefa foi excluída (deleted_at) ou não está em tasksById   (task pode ser null)
 *   'removed'    o item foi retirado do plano
 *   'done'       a tarefa estava concluída na referência. completedAt traz o instante quando a conclusão
 *                aconteceu DENTRO da semana = completedWithin(statusIntervals(...), início da semana, referência);
 *                se ela já estava concluída ANTES de a semana começar, completedBefore = true e completedAt = null
 *   'cancelled'  a tarefa estava cancelada na referência
 *   'carried'    não concluída e transferida para outra semana (carried_to_week)
 *   'open'       não concluída
 *
 * Listas (todas de linhas com tarefa existente): "ativa" = item não retirado cuja tarefa existe e não estava
 * concluída antes de a semana começar (trabalho adiantado não entra no plano nem a favor nem contra).
 *   planned / added       ativas por tipo                      completed          ativas com desfecho 'done'
 *   completedPlanned / completedAdded                          notCompleted       ativas não concluídas
 *   carriedOut            ativas com desfecho 'carried'        carriedIn          ativas vindas de outra semana
 *   removed               retiradas do plano                   doneBefore         concluídas antes da semana
 *   missing               itens de tarefa excluída/desconhecida
 * Vale sempre: planned + added = completed + notCompleted.
 *
 * @param {object} params
 * @param {string}        params.weekStart   semana ('YYYY-MM-DD')
 * @param {Array<object>} params.items       linhas de week_items (de qualquer semana)
 * @param {Map|object}    params.tasksById   id → tarefa. Passe TODAS as tarefas (arquivadas inclusive), senão
 *                                           o resumo de semanas antigas muda quando algo é arquivado
 * @param {Map}           [params.eventsIndex] índice de indexEvents(activity_log); sem ele usa-se só a tarefa
 * @param {Array}         [params.statuses]  lista de status (resolveStatuses)
 * @param {string}        params.nowIso      instante atual
 * @returns {{ weekStart: string, weekEnd: string, phase: 'past'|'current'|'future', rows: object[],
 *             planned: object[], added: object[], completed: object[], completedPlanned: object[],
 *             completedAdded: object[], notCompleted: object[], carriedOut: object[], carriedIn: object[],
 *             removed: object[], doneBefore: object[], missing: object[], counts: object,
 *             adherence: number|null, estimateMinutes: number }}
 *          counts traz o tamanho de cada lista; adherence = completedPlanned ÷ planned (null se nada foi
 *          planejado); estimateMinutes = soma das estimativas das tarefas das linhas ativas.
 * @throws {RangeError} semana ou instante inválidos
 */
export function weekSummary({ weekStart, items, tasksById, eventsIndex, statuses, nowIso } = {}) {
  const range = weekRange(weekStart);
  const now = requireIso(nowIso);
  const today = isoToDateStr(now);
  let phase = WEEK_PHASE.CURRENT;
  if (today < range.start) phase = WEEK_PHASE.FUTURE;
  else if (today > range.end) phase = WEEK_PHASE.PAST;
  const refIso = minIso(range.endIso, now);

  const rows = weekItems(items, range, true).map((item) => {
    const task = lookup(tasksById, item.task_id) || null;
    const row = { item, task, kind: kindOf(item), completedAt: null, outcome: WEEK_OUTCOME.OPEN, completedBefore: false };
    if (!task || task.deleted_at) {
      row.outcome = WEEK_OUTCOME.MISSING;
      return row;
    }
    const state = completionAt(task, taskEvents(eventsIndex, task.id), { statuses, nowIso: now, fromIso: range.startIso, refIso });
    row.completedAt = state.completedAt;
    if (item.removed_at) row.outcome = WEEK_OUTCOME.REMOVED;
    else if (state.doneSince) {
      row.outcome = WEEK_OUTCOME.DONE;
      row.completedBefore = !state.completedAt;
    } else if (state.cancelled) row.outcome = WEEK_OUTCOME.CANCELLED;
    else if (item.carried_to_week && item.carried_to_week !== range.start) row.outcome = WEEK_OUTCOME.CARRIED;
    return row;
  });

  const missing = rows.filter((r) => r.outcome === WEEK_OUTCOME.MISSING);
  const removed = rows.filter((r) => r.outcome === WEEK_OUTCOME.REMOVED);
  const doneBefore = rows.filter((r) => r.outcome === WEEK_OUTCOME.DONE && r.completedBefore);
  const active = rows.filter((r) => r.outcome !== WEEK_OUTCOME.MISSING && r.outcome !== WEEK_OUTCOME.REMOVED && !r.completedBefore);
  const planned = active.filter((r) => r.kind === WEEK_KIND.PLANNED);
  const added = active.filter((r) => r.kind === WEEK_KIND.ADDED);
  const completed = active.filter((r) => r.outcome === WEEK_OUTCOME.DONE);
  const completedPlanned = completed.filter((r) => r.kind === WEEK_KIND.PLANNED);
  const completedAdded = completed.filter((r) => r.kind === WEEK_KIND.ADDED);
  const notCompleted = active.filter((r) => r.outcome !== WEEK_OUTCOME.DONE);
  const carriedOut = active.filter((r) => r.outcome === WEEK_OUTCOME.CARRIED);
  const carriedIn = active.filter((r) => !!r.item.carried_from_id);

  let estimateMinutes = 0;
  for (const row of active) {
    const estimate = Number(row.task.estimate_minutes);
    if (Number.isFinite(estimate) && estimate > 0) estimateMinutes += estimate;
  }

  return {
    weekStart: range.start,
    weekEnd: range.end,
    phase,
    rows,
    planned,
    added,
    completed,
    completedPlanned,
    completedAdded,
    notCompleted,
    carriedOut,
    carriedIn,
    removed,
    doneBefore,
    missing,
    counts: {
      planned: planned.length,
      added: added.length,
      completed: completed.length,
      completedPlanned: completedPlanned.length,
      completedAdded: completedAdded.length,
      notCompleted: notCompleted.length,
      carriedOut: carriedOut.length,
      carriedIn: carriedIn.length,
      removed: removed.length,
      doneBefore: doneBefore.length,
      missing: missing.length,
    },
    adherence: planned.length ? completedPlanned.length / planned.length : null,
    estimateMinutes,
  };
}

// ---------------------------------------------------------------------------
// Transferência para outra semana
// ---------------------------------------------------------------------------

/**
 * Plano de transferência do trabalho não concluído de uma semana para outra, SEM apagar o plano anterior.
 * Função pura: devolve o que gravar; quem chama (o comando) grava tudo numa transação.
 *
 * Para cada item ativo de `fromWeek` (ou só os de `itemIds`) cuja tarefa continua aberta:
 *   • se a tarefa ainda não está no plano vigente de `toWeek`: cria um item novo
 *     `{ week_start: toWeek, task_id, kind: kindForNewItem(toWeek, nowIso), added_at: nowIso,
 *        carried_from_id: <id do item original>, removed_at: null, carried_to_week: null }`;
 *   • o item original (e duplicados dele vindos de outro dispositivo) recebe `{ carried_to_week: toWeek }` —
 *     também quando a tarefa já estava no plano de destino, caso em que nada é inserido (não duplica).
 *
 * Ficam de fora (ver `skipped`): tarefa excluída/desconhecida ('missing'), arquivada ('archived'), concluída
 * ou cancelada ('closed'). Na transferência em lote (sem `itemIds`), itens que já foram transferidos antes
 * ('already_carried') não são transferidos de novo — rodar duas vezes não duplica nem desfaz uma retirada
 * feita na semana de destino; com `itemIds` o pedido é explícito e o item é transferido de novo.
 *
 * @param {object} params
 * @param {Array<object>} params.items     linhas de week_items (todas as semanas)
 * @param {Map|object}    params.tasksById id → tarefa
 * @param {Array}         [params.statuses]
 * @param {string}        params.fromWeek  semana de origem
 * @param {string}        params.toWeek    semana de destino (igual à origem → plano vazio)
 * @param {string}        params.nowIso    instante da transferência
 * @param {Iterable<string>} [params.itemIds] restringe aos itens informados
 * @returns {{ inserts: object[], updates: Array<{ id: string, patch: { carried_to_week: string } }>,
 *             skipped: Array<{ item: object, reason: 'missing'|'archived'|'closed'|'already_carried'|'already_planned' }> }}
 *          'already_planned' = a tarefa já estava na semana de destino (o original só foi marcado).
 * @throws {RangeError} semana ou instante inválidos
 */
export function carryOverPlan({ items, tasksById, statuses, fromWeek, toWeek, nowIso, itemIds } = {}) {
  const from = weekRange(fromWeek);
  const to = weekRange(toWeek);
  const now = requireIso(nowIso);
  const plan = { inserts: [], updates: [], skipped: [] };
  if (from.start === to.start) return plan;

  const explicit = itemIds !== null && itemIds !== undefined;
  const wanted = explicit ? new Set(itemIds) : null;

  // Todos os itens vigentes da origem por tarefa (inclusive duplicados), para marcar todos de uma vez.
  const groups = new Map();
  for (const item of items || []) {
    if (!item || item.deleted_at || item.removed_at || item.task_id === null || item.task_id === undefined) continue;
    if (!inWeek(item, from)) continue;
    const group = groups.get(item.task_id);
    if (group) group.push(item);
    else groups.set(item.task_id, [item]);
  }
  const alreadyThere = new Set(weekItems(items, to, false).map((item) => item.task_id));
  const kind = kindForNewItem(to.start, now);

  for (const item of weekItems(items, from, false)) {
    const group = groups.get(item.task_id) || [item];
    if (explicit && !group.some((g) => wanted.has(g.id))) continue;
    const task = lookup(tasksById, item.task_id);
    if (!task || task.deleted_at) {
      plan.skipped.push({ item, reason: 'missing' });
      continue;
    }
    if (task.archived_at) {
      plan.skipped.push({ item, reason: 'archived' });
      continue;
    }
    if (!isOpen(task, statuses)) {
      plan.skipped.push({ item, reason: 'closed' });
      continue;
    }
    if (!explicit && group.some((g) => !!g.carried_to_week)) {
      plan.skipped.push({ item, reason: 'already_carried' });
      continue;
    }
    if (alreadyThere.has(item.task_id)) {
      plan.skipped.push({ item, reason: 'already_planned' });
    } else {
      plan.inserts.push({
        week_start: to.start,
        task_id: item.task_id,
        kind,
        added_at: now,
        carried_from_id: item.id,
        removed_at: null,
        carried_to_week: null,
      });
    }
    for (const g of [...group].sort(compareByAddedAt)) {
      if (g.carried_to_week !== to.start) plan.updates.push({ id: g.id, patch: { carried_to_week: to.start } });
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Seções da tela "Minha Semana"
// ---------------------------------------------------------------------------

/** Bloqueada, aguardando terceiros ou com pré-requisito ainda aberto (cancelado/concluído não bloqueia). */
function isBlockedTask(task, { statuses, graph, byId }) {
  const category = categoryOf(statuses, task.status);
  if (category === 'blocked' || category === 'waiting') return true;
  const prereqs = graph && graph.prereqs && typeof graph.prereqs.get === 'function' ? graph.prereqs.get(task.id) : null;
  if (!prereqs) return false;
  for (const id of prereqs) {
    if (id === task.id) continue;
    const prereq = byId.get(id);
    if (prereq && isOpen(prereq, statuses)) return true;
  }
  return false;
}

/**
 * Listas da tela "Minha Semana". Uma tarefa pode aparecer em mais de uma lista.
 *
 *   scheduled  programadas: tarefas abertas que estão no plano vigente da semana
 *   priority   prioritárias: abertas, P1/P2, que estão no plano ou vencem dentro da semana
 *   overdue    atrasadas: abertas com prazo anterior a `today` (estejam ou não no plano)
 *   upcoming   próximos vencimentos: abertas com prazo de hoje (ou do início da semana, se ela ainda não
 *              começou) até o domingo e que NÃO estão no plano — candidatas a entrar
 *   blocked    abertas, no plano ou vencendo na semana, com status bloqueada/aguardando terceiros ou com
 *              pré-requisito ainda aberto em graph.prereqs
 *   completed  concluídas dentro da semana segundo o HISTÓRICO de status (estejam ou não no plano)
 *
 * @param {object} params
 * @param {string}        params.weekStart semana ('YYYY-MM-DD')
 * @param {Array<object>} params.tasks     tarefas VISÍVEIS (quem chama já tirou excluídas/arquivadas)
 * @param {Array<object>} params.items     linhas de week_items
 * @param {{ prereqs: Map<string, Iterable<string>> }|null} [params.graph] grafo de buildGraph (pode ser null)
 * @param {Array}         [params.statuses]
 * @param {string}        [params.today]   'YYYY-MM-DD' (padrão: data local de nowIso)
 * @param {Map}           [params.eventsIndex] índice de indexEvents(activity_log)
 * @param {string}        params.nowIso    instante atual
 * @returns {{ scheduled: object[], priority: object[], overdue: object[], upcoming: object[],
 *             blocked: object[], completed: object[] }} listas de tarefas, cada uma ordenada por prioridade,
 *          depois prazo (sem prazo por último), depois nome
 * @throws {RangeError} semana ou instante inválidos
 */
export function weekSections({ weekStart, tasks, items, graph, statuses, today, eventsIndex, nowIso } = {}) {
  const range = weekRange(weekStart);
  const now = requireIso(nowIso);
  const day = isValidDateStr(today) ? today : isoToDateStr(now);
  const refIso = minIso(range.endIso, now);
  const refIsNow = refIso === now;
  const upcomingFrom = day > range.start ? day : range.start;
  const inPlan = new Set(weekItems(items, range, false).map((item) => item.task_id));

  const visible = [];
  const byId = new Map();
  for (const task of tasks || []) {
    if (!task || task.deleted_at) continue;
    visible.push(task);
    byId.set(task.id, task);
  }

  const sections = { scheduled: [], priority: [], overdue: [], upcoming: [], blocked: [], completed: [] };
  for (const task of visible) {
    const open = isOpen(task, statuses);
    if (open) {
      const planned = inPlan.has(task.id);
      const due = task.due_date || null;
      const dueInWeek = !!due && due >= range.start && due <= range.end;
      if (planned) sections.scheduled.push(task);
      if ((planned || dueInWeek) && priorityRank(task.priority) <= 2) sections.priority.push(task);
      if (due && due < day) sections.overdue.push(task);
      if (!planned && due && due >= upcomingFrom && due <= range.end) sections.upcoming.push(task);
      if ((planned || dueInWeek) && isBlockedTask(task, { statuses, graph, byId })) sections.blocked.push(task);
    }
    // Na referência "agora" só pode estar concluída quem está concluída hoje; e ninguém é concluído antes de existir.
    if (refIsNow && open) continue;
    if (task.created_at && task.created_at > refIso) continue;
    const state = completionAt(task, taskEvents(eventsIndex, task.id), { statuses, nowIso: now, fromIso: range.startIso, refIso });
    if (state.completedAt) sections.completed.push(task);
  }
  for (const list of Object.values(sections)) list.sort(compareTasks);
  return sections;
}

/**
 * Carga do plano da semana frente à capacidade: soma as estimativas das tarefas ABERTAS do plano vigente.
 * @param {object} params
 * @param {Array<object>} params.items       linhas de week_items
 * @param {Map|object}    params.tasksById   id → tarefa
 * @param {Array}         [params.statuses]
 * @param {string}        params.weekStart   semana ('YYYY-MM-DD')
 * @param {number}        [params.hoursPerWeek=40] capacidade semanal em horas
 * @returns {{ plannedMinutes: number, capacityMinutes: number, ratio: number|null, unestimated: number, count: number }}
 *          ratio = plannedMinutes ÷ capacityMinutes (null sem capacidade); unestimated = quantas tarefas abertas
 *          do plano não têm estimativa; count = quantas tarefas abertas há no plano.
 * @throws {RangeError} semana inválida
 */
export function planLoad({ items, tasksById, statuses, weekStart, hoursPerWeek } = {}) {
  const range = weekRange(weekStart);
  let plannedMinutes = 0;
  let unestimated = 0;
  let count = 0;
  for (const item of weekItems(items, range, false)) {
    const task = lookup(tasksById, item.task_id);
    if (!task || task.deleted_at || !isOpen(task, statuses)) continue;
    count += 1;
    const estimate = Number(task.estimate_minutes);
    if (Number.isFinite(estimate) && estimate > 0) plannedMinutes += estimate;
    else unestimated += 1;
  }
  const hours = hoursPerWeek === null || hoursPerWeek === undefined ? DEFAULT_HOURS_PER_WEEK : Number(hoursPerWeek);
  const capacityMinutes = Number.isFinite(hours) && hours > 0 ? Math.round(hours * 60) : 0;
  return {
    plannedMinutes,
    capacityMinutes,
    ratio: capacityMinutes > 0 ? plannedMinutes / capacityMinutes : null,
    unestimated,
    count,
  };
}
