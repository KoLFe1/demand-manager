// Reconstrução do histórico a partir do registro de atividades (activity_log).
// Puro, sem dependências além de statuses.js.
//
// As métricas NÃO podem olhar só o status atual: elas usam estas funções para saber
// em que status um item estava em cada momento, quando foi concluído, reaberto, bloqueado etc.
//
// Formato de um evento (linha de activity_log):
//   { id, entity_type: 'project'|'demand'|'task', entity_id, action, field, old_value, new_value, meta, at, device_id }
//
// Convenções de cada ação:
//   created            meta: { status, category, priority, due_date, demand_id?, parent_id?, project_id?, duplicated_from? }
//   status_changed     old_value/new_value: id do status; meta: { from_category, to_category, reason?, auto? }
//   priority_changed   old_value/new_value: 'P1'..'P4';   meta: { justification? }
//   due_changed        old_value/new_value: 'YYYY-MM-DD' | null; meta: { reason? }
//   description_changed old_value/new_value: texto
//   updated            field: nome do campo; old_value/new_value: valores
//   dependency_added / dependency_removed   new_value/old_value: id da tarefa pré-requisito; meta: { name }
//   archived / unarchived / deleted / restored
//   moved              field: 'demand_id' | 'parent_id' | 'project_id'; old_value/new_value: ids
//   note_added         new_value: id da observação; meta: { excerpt }
//   time_logged        new_value: segundos; meta: { entry_id, source }
//   week_added / week_removed / week_carried   new_value: week_start; meta: { kind?, from_week?, to_week? }
//   week_move_undone   "Desfazer" de mover/transferir: new_value = semana de volta; meta: { from_week, to_week }
//   followed_up        cobrança feita: new_value = pessoa cobrada (texto) | null; old_value = "Cobrar em" anterior;
//                      meta: { person, note?, next_date, role: 'waiting'|'owner' }
//   link_added         new_value: id do link; meta: { label, kind, restored? } (restored = "Desfazer" da remoção)
//   link_removed       old_value: id do link; meta: { label, kind }
//   link_updated       new_value: id do link; meta: { label, kind, old_label?, target_changed? }
//   deleted (projeto)  meta: { demand_ids } — demandas que a exclusão deixou sem projeto (restoreProject)

import { categoryOf } from './statuses.js';

export const ACTIONS = Object.freeze({
  CREATED: 'created',
  STATUS: 'status_changed',
  PRIORITY: 'priority_changed',
  DUE: 'due_changed',
  DESCRIPTION: 'description_changed',
  UPDATED: 'updated',
  DEP_ADDED: 'dependency_added',
  DEP_REMOVED: 'dependency_removed',
  ARCHIVED: 'archived',
  UNARCHIVED: 'unarchived',
  DELETED: 'deleted',
  RESTORED: 'restored',
  MOVED: 'moved',
  NOTE_ADDED: 'note_added',
  TIME_LOGGED: 'time_logged',
  WEEK_ADDED: 'week_added',
  WEEK_REMOVED: 'week_removed',
  WEEK_CARRIED: 'week_carried',
  WEEK_UNDONE: 'week_move_undone',
  FOLLOW_UP: 'followed_up',
  LINK_ADDED: 'link_added',
  LINK_REMOVED: 'link_removed',
  LINK_UPDATED: 'link_updated',
});

/** Monta os valores de um evento (o id é gerado pelo banco local ao inserir). */
export function makeEvent({ entityType, entityId, action, field = null, oldValue = null, newValue = null, meta = null, at, deviceId = null }) {
  return {
    entity_type: entityType,
    entity_id: entityId,
    action,
    field,
    old_value: oldValue === undefined ? null : oldValue,
    new_value: newValue === undefined ? null : newValue,
    meta: meta || null,
    at,
    device_id: deviceId,
  };
}

function cmpEvents(a, b) {
  if (a.at < b.at) return -1;
  if (a.at > b.at) return 1;
  const ia = String(a.id || '');
  const ib = String(b.id || '');
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Cópia ordenada por instante (e por id, para desempate estável). */
export function sortEvents(events) {
  return [...events].sort(cmpEvents);
}

/** Agrupa todos os eventos por entidade: Map<'tipo:id', Evento[]> já ordenados. */
export function indexEvents(activity) {
  const map = new Map();
  for (const ev of activity) {
    const key = `${ev.entity_type}:${ev.entity_id}`;
    let list = map.get(key);
    if (!list) map.set(key, (list = []));
    list.push(ev);
  }
  for (const list of map.values()) list.sort(cmpEvents);
  return map;
}

/** Eventos (ordenados) de uma entidade a partir do índice de indexEvents. */
export function eventsOf(index, entityType, entityId) {
  return index.get(`${entityType}:${entityId}`) || [];
}

/**
 * Linha do tempo de status de uma entidade.
 * @param {object} entity   demanda ou tarefa (usa created_at, updated_at, status)
 * @param {Array}  events   eventos DESSA entidade, ordenados
 * @returns {Array<{status, category, from, to, open, synthetic?}>} intervalos contíguos;
 *          o último tem open=true e to = nowIso.
 */
export function statusIntervals(entity, events, { statuses, nowIso }) {
  const created = events.find((e) => e.action === ACTIONS.CREATED) || null;
  const changes = events.filter((e) => e.action === ACTIONS.STATUS);
  const start = entity.created_at || (created && created.at) || (events[0] && events[0].at) || nowIso;

  let status;
  let category;
  if (created && created.meta && created.meta.status) {
    status = created.meta.status;
    category = created.meta.category || categoryOf(statuses, status);
  } else if (changes.length) {
    status = changes[0].old_value;
    category = (changes[0].meta && changes[0].meta.from_category) || categoryOf(statuses, status);
  } else {
    status = entity.status;
    category = categoryOf(statuses, status);
  }

  const out = [];
  let cur = { status, category, from: start };
  for (const ev of changes) {
    const at = ev.at < cur.from ? cur.from : ev.at; // relógios fora de ordem: nunca voltar no tempo
    if (ev.new_value === cur.status) continue; // evento repetido (ex.: dois dispositivos)
    out.push({ ...cur, to: at, open: false });
    cur = {
      status: ev.new_value,
      category: (ev.meta && ev.meta.to_category) || categoryOf(statuses, ev.new_value),
      from: at,
    };
  }
  if (entity.status && cur.status !== entity.status) {
    // O histórico ainda não explica o status atual (ex.: evento ainda não sincronizado): completa com um trecho sintético.
    // Para um item concluído, o melhor palpite do instante é completed_at (updated_at muda a cada edição).
    const currentCategory = categoryOf(statuses, entity.status);
    const guess = currentCategory === 'done' && entity.completed_at ? entity.completed_at : entity.updated_at;
    const at = guess && guess > cur.from ? guess : cur.from;
    out.push({ ...cur, to: at, open: false });
    cur = { status: entity.status, category: currentCategory, from: at, synthetic: true };
  }
  const end = nowIso < cur.from ? cur.from : nowIso;
  out.push({ ...cur, to: end, open: true });
  return out;
}

/** Intervalo vigente no instante dado (null se a entidade ainda não existia). */
export function statusAt(intervals, atIso) {
  if (!intervals.length || atIso < intervals[0].from) return null;
  for (let i = intervals.length - 1; i >= 0; i--) {
    if (atIso >= intervals[i].from) return intervals[i];
  }
  return null;
}

/** Primeiro instante em que a entidade entrou em alguma das categorias (null se nunca). */
export function firstEntered(intervals, categories) {
  for (const it of intervals) if (categories.includes(it.category)) return it.from;
  return null;
}

/** Trechos contíguos (fundidos) em que a entidade esteve em alguma das categorias. */
export function spansOfCategories(intervals, categories) {
  const spans = [];
  let cur = null;
  for (const it of intervals) {
    if (categories.includes(it.category)) {
      if (cur && cur.to === it.from) {
        cur.to = it.to;
        cur.open = it.open;
      } else {
        cur = { from: it.from, to: it.to, open: it.open };
        spans.push(cur);
      }
    } else {
      cur = null;
    }
  }
  return spans;
}

/** Milissegundos passados nas categorias, opcionalmente recortando ao período [from, to]. */
export function timeInCategories(intervals, categories, { from = null, to = null } = {}) {
  let total = 0;
  for (const it of intervals) {
    if (!categories.includes(it.category)) continue;
    const a = from && it.from < from ? from : it.from;
    const b = to && it.to > to ? to : it.to;
    const d = new Date(b).getTime() - new Date(a).getTime();
    if (d > 0) total += d;
  }
  return total;
}

/**
 * Resumo de conclusão/retrabalho.
 *   done             está concluída agora
 *   completedAt      início do trecho final "concluída" (null se não está concluída)
 *   firstCompletedAt primeira vez que foi concluída (null se nunca)
 *   reopenCount      quantas vezes saiu de "concluída" para um status aberto
 *   reviewReturns    quantas vezes voltou de "em revisão" para um status anterior (reprovada na revisão)
 */
export function completionInfo(intervals) {
  let reopenCount = 0;
  let reviewReturns = 0;
  let firstCompletedAt = null;
  for (let i = 0; i < intervals.length; i++) {
    const it = intervals[i];
    const prev = intervals[i - 1];
    if (it.category === 'done' && (!prev || prev.category !== 'done') && !firstCompletedAt) firstCompletedAt = it.from;
    if (prev && prev.category === 'done' && it.category !== 'done' && it.category !== 'cancelled') reopenCount++;
    if (prev && prev.category === 'review' && ['backlog', 'planned', 'active', 'blocked', 'waiting'].includes(it.category)) reviewReturns++;
  }
  const last = intervals[intervals.length - 1];
  const done = !!last && last.category === 'done';
  let completedAt = null;
  if (done) {
    let i = intervals.length - 1;
    while (i > 0 && intervals[i - 1].category === 'done') i--;
    completedAt = intervals[i].from;
  }
  return { done, completedAt, firstCompletedAt, reopenCount, reviewReturns };
}

/**
 * Se a entidade estava concluída em `toIso` e essa conclusão começou dentro de [fromIso, toIso],
 * devolve o instante da conclusão; senão null. (Uma tarefa concluída e reaberta no período não conta.)
 */
export function completedWithin(intervals, fromIso, toIso) {
  const at = statusAt(intervals, toIso);
  if (!at || at.category !== 'done') return null;
  let i = intervals.indexOf(at);
  while (i > 0 && intervals[i - 1].category === 'done') i--;
  const began = intervals[i].from;
  return began >= fromIso && began <= toIso ? began : null;
}

/** Mudanças de um tipo: [{ at, old, new, meta }] em ordem cronológica. Filtra por ação e, se informado, por campo. */
export function fieldChanges(events, { action, field = null }) {
  return events
    .filter((e) => e.action === action && (field === null || e.field === field))
    .map((e) => ({ at: e.at, old: e.old_value, new: e.new_value, meta: e.meta || null }));
}

/** Valor que um campo tinha no instante dado, desfazendo as mudanças posteriores a ele. */
export function valueAt(currentValue, changes, atIso) {
  let v = currentValue;
  for (let i = changes.length - 1; i >= 0; i--) {
    if (changes[i].at > atIso) v = changes[i].old;
    else break;
  }
  return v === undefined ? null : v;
}

/** Prazo vigente no instante dado. */
export function dueDateAt(entity, events, atIso) {
  return valueAt(entity.due_date || null, fieldChanges(events, { action: ACTIONS.DUE }), atIso);
}

/** Prioridade vigente no instante dado. */
export function priorityAt(entity, events, atIso) {
  return valueAt(entity.priority || null, fieldChanges(events, { action: ACTIONS.PRIORITY }), atIso);
}

/** Primeiro prazo que o item teve (linha de base), mesmo que tenha sido alterado depois. */
export function originalDueDate(entity, events) {
  const changes = fieldChanges(events, { action: ACTIONS.DUE });
  for (const c of changes) {
    if (c.old) return c.old;
    if (c.new) return c.new;
  }
  const created = events.find((e) => e.action === ACTIONS.CREATED);
  if (created && created.meta && created.meta.due_date) return created.meta.due_date;
  return entity.due_date || null;
}

/** A entidade existia (criada e não excluída) no instante dado? */
export function existedAt(entity, atIso) {
  if (entity.created_at && entity.created_at > atIso) return false;
  if (entity.deleted_at && entity.deleted_at <= atIso) return false;
  return true;
}
