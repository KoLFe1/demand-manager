// Auditoria legível (seção 13 do pedido). Puro: sem DOM, sem banco e sem relógio implícito.
//
// Duas responsabilidades:
//   1. FABRICAR os eventos do histórico — valores prontos para store.insert('activity_log', ...):
//        createdEvent, statusEvent, diffToEvents;
//   2. TRADUZIR um evento em uma frase em português para a linha do tempo da interface:
//        describeEvent, groupByDay (e os utilitários fieldLabel / formatFieldValue).
//
// O formato de cada ação (o que vai em old_value / new_value / meta) está documentado no topo de
// timeline.js. Ele é o contrato entre quem grava e quem lê: as métricas dependem dele.

import { addDays, formatDate, formatDateTime, formatWeekRange, isValidDateStr, isoToDateStr } from '../core/dates.js';
import { META_FIELDS } from '../data/schema.js';
import { DEFAULT_PRIORITY, PRIORITIES } from './priorities.js';
import { DEFAULT_STATUS_ID, categoryOf, isOpenCategory, statusById } from './statuses.js';
import { ACTIONS, makeEvent, sortEvents } from './timeline.js';

/** Rótulos (pt-BR) de todos os campos de projeto, demanda e tarefa. */
export const FIELD_LABELS = Object.freeze({
  name: 'Nome',
  description: 'Descrição',
  objective: 'Objetivo',
  deliverables: 'Entregáveis',
  owner: 'Responsável',
  priority: 'Prioridade',
  status: 'Status',
  planned_start: 'Início planejado',
  actual_start: 'Início real',
  due_date: 'Prazo',
  completed_at: 'Conclusão',
  estimate_minutes: 'Estimativa',
  next_action: 'Próxima ação',
  category: 'Categoria',
  tags: 'Tags',
  weight: 'Peso',
  required: 'Obrigatória',
  blocked_reason: 'Motivo do bloqueio',
  waiting_on: 'Aguardando',
  follow_up_date: 'Cobrar em',
  recurrence: 'Repetição',
  project_id: 'Projeto',
  demand_id: 'Demanda',
  parent_id: 'Tarefa pai',
  code: 'Código',
  color: 'Cor',
  seq: 'Número',
  sort_order: 'Ordem',
  archived_at: 'Arquivamento',
  deleted_at: 'Exclusão',
  created_at: 'Criação',
  updated_at: 'Última alteração',
});

/**
 * Campos que diffToEvents NÃO audita:
 *   • status, completed_at, actual_start — já cobertos pelo evento de status (statusEvent);
 *   • sort_order — reordenar não é uma alteração de conteúdo;
 *   • id, seq, created_at, updated_at e os campos de controle da sincronização.
 */
export const DIFF_IGNORED_FIELDS = Object.freeze(['id', 'seq', 'status', 'completed_at', 'actual_start', 'sort_order', 'created_at', 'updated_at', ...META_FIELDS]);

const IGNORED = new Set(DIFF_IGNORED_FIELDS);
const PARENT_FIELDS = Object.freeze(['project_id', 'demand_id', 'parent_id']);
const WORKFLOW_TYPES = new Set(['demand', 'task']);
const PRIORITY_BY_ID = new Map(PRIORITIES.map((p) => [p.id, p]));

const DASH = '—';
const ARROW = '→';
/** Acima deste tamanho o valor não cabe na frase "Campo: antes → depois". */
const LONG_VALUE = 60;
const EXCERPT_LENGTH = 140;

const COLOR_LABELS = Object.freeze({
  gray: 'cinza', slate: 'ardósia', neutral: 'neutro', blue: 'azul', sky: 'azul-claro', cyan: 'ciano', teal: 'verde-azulado',
  green: 'verde', lime: 'lima', yellow: 'amarelo', amber: 'âmbar', orange: 'laranja', red: 'vermelho', pink: 'rosa',
  rose: 'rosa', purple: 'roxo', violet: 'violeta', indigo: 'índigo', brown: 'marrom',
});

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

/** Vazio para fins de auditoria: null, undefined, texto vazio ou lista vazia. */
function isEmptyValue(v) {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/** Dois valores equivalem? Vazios (null, '', []) são iguais entre si; listas e objetos são comparados em profundidade. */
function sameValue(a, b) {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  return deepEqual(a, b);
}

/** Cópia do valor para guardar no evento (as linhas do banco são congeladas e não devem ser compartilhadas). */
function snapshot(v) {
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(snapshot);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, snapshot(x)]));
  return v;
}

function cleanText(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function metaOf(event) {
  return event && event.meta && typeof event.meta === 'object' ? event.meta : {};
}

/** Trecho de um texto em uma linha só, com reticências quando cortado. */
function excerpt(text, max = EXCERPT_LENGTH) {
  if (text === null || text === undefined) return '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const quoted = (name) => `“${name}”`;

/** Nome da linha `id` num mapa (Map ou objeto simples) de entidades; '' se não achar. */
function nameIn(map, id) {
  if (!map || id === null || id === undefined || id === '') return '';
  const row = typeof map.get === 'function' ? map.get(id) : map[id];
  return row && typeof row.name === 'string' ? row.name.trim() : '';
}

function formatNumber(n) {
  return String(Math.round(n * 100) / 100).replace('.', ',');
}

/** Minutos -> '45min', '2h', '1h 30min'. */
function formatMinutes(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return String(minutes);
  const total = Math.max(0, Math.round(n));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}min`;
  return h ? `${h}h` : `${m}min`;
}

/** Segundos -> '40s', '25min', '1h 30min'. */
function formatSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return String(seconds);
  const total = Math.max(0, Math.round(n));
  if (total > 0 && total < 60) return `${total}s`;
  return formatMinutes(Math.round(total / 60));
}

/** Data local -> '20 nov' (o ano só aparece quando difere do ano de referência). Nunca consulta o relógio. */
function formatDay(value, today) {
  const day = String(value).slice(0, 10);
  if (!isValidDateStr(day)) return String(value);
  return formatDate(day, 'short', isValidDateStr(today) ? today : day);
}

/** Semana -> '16–22 nov' ou '30 nov – 6 dez' (com o ano quando difere do ano de referência); '' se inválida. */
function formatWeek(weekStart, today) {
  if (!isValidDateStr(weekStart)) return '';
  const full = formatWeekRange(weekStart);
  const endYear = addDays(weekStart, 6).slice(0, 4);
  const refYear = isValidDateStr(today) ? today.slice(0, 4) : endYear;
  return endYear === refYear ? full.slice(0, -5) : full;
}

function priorityText(id) {
  const p = PRIORITY_BY_ID.get(id);
  return p ? `${p.id} ${p.label}` : String(id);
}

function entry(icon, text, detail = null, tone = 'default') {
  return { icon, text, detail: detail || null, tone };
}

// ---------------------------------------------------------------------------
// Rótulos e valores
// ---------------------------------------------------------------------------

/**
 * Rótulo em português de um campo.
 * @param {string} field nome da coluna (ex.: 'due_date')
 * @returns {string} rótulo de FIELD_LABELS; campo desconhecido vira o próprio nome legível ('custom_field' -> 'Custom field')
 */
export function fieldLabel(field) {
  if (typeof field !== 'string' || !field.trim()) return 'Campo';
  if (Object.prototype.hasOwnProperty.call(FIELD_LABELS, field)) return FIELD_LABELS[field];
  const words = field.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Valor de um campo escrito para leitura humana (usado nas frases "Campo: antes → depois").
 * Regras: vazio (null, '', []) -> '—'; booleano -> 'sim' / 'não'; lista -> itens separados por vírgula;
 * estimativa -> duração ('1h 30min'); datas -> '20 nov'; instantes -> '21/11/2026 14:35'; prioridade -> 'P1 Crítica';
 * status -> rótulo do status; peso -> '25%'; projeto/demanda/tarefa pai -> nome entre aspas (quando o mapa foi informado).
 * @param {string} field nome da coluna
 * @param {*} value valor guardado no evento
 * @param {{statuses?: Array, tasksById?: Map|object, demandsById?: Map|object, projectsById?: Map|object, today?: string}} [ctx]
 * @returns {string}
 */
export function formatFieldValue(field, value, ctx = {}) {
  if (isEmptyValue(value)) return DASH;
  const c = ctx || {};
  switch (field) {
    case 'estimate_minutes':
      return formatMinutes(value);
    case 'due_date':
    case 'planned_start':
    case 'follow_up_date':
      return formatDay(value, c.today);
    case 'actual_start':
    case 'completed_at':
    case 'archived_at':
    case 'deleted_at':
    case 'created_at':
    case 'updated_at':
      return formatDateTime(value) || String(value);
    case 'priority':
      return priorityText(value);
    case 'status':
      return statusById(c.statuses, value).label;
    case 'weight':
      return typeof value === 'number' && Number.isFinite(value) ? `${formatNumber(value)}%` : String(value);
    case 'color':
      return COLOR_LABELS[value] || String(value);
    case 'project_id': {
      const name = nameIn(c.projectsById, value);
      return name ? quoted(name) : 'outro projeto';
    }
    case 'demand_id': {
      const name = nameIn(c.demandsById, value);
      return name ? quoted(name) : 'outra demanda';
    }
    case 'parent_id': {
      const name = nameIn(c.tasksById, value);
      return name ? quoted(name) : 'outra tarefa';
    }
    default:
      break;
  }
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (Array.isArray(value)) return value.map((v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
  if (typeof value === 'number') return Number.isFinite(value) ? formatNumber(value) : String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------
// Fábrica de eventos
// ---------------------------------------------------------------------------

/**
 * Evento de criação de um projeto, demanda ou tarefa.
 * @param {'project'|'demand'|'task'} entityType
 * @param {object} entity linha recém-criada (usa id, status, priority, due_date, project_id, demand_id, parent_id)
 * @param {{nowIso: string, deviceId?: string, statuses?: Array, extra?: object}} opts
 *        nowIso = instante do evento; statuses = lista efetiva de status (para gravar a categoria);
 *        extra = chaves adicionais do meta (ex.: { duplicated_from: id }).
 * @returns {object} valores do evento (sem id): action 'created' e
 *          meta { status, category, priority, due_date, project_id?, demand_id?, parent_id?, ...extra }.
 *          Em projetos (que não têm fluxo de status) o meta traz só `extra` — ou null, se não houver.
 */
export function createdEvent(entityType, entity, { nowIso, deviceId = null, statuses, extra } = {}) {
  const row = entity || {};
  const meta = {};
  if (WORKFLOW_TYPES.has(entityType) || row.status != null) {
    const status = row.status || DEFAULT_STATUS_ID;
    meta.status = status;
    meta.category = categoryOf(statuses, status);
    meta.priority = row.priority || DEFAULT_PRIORITY;
    meta.due_date = row.due_date || null;
  }
  for (const key of PARENT_FIELDS) if (row[key]) meta[key] = row[key];
  if (extra && typeof extra === 'object') Object.assign(meta, snapshot(extra));
  return makeEvent({
    entityType,
    entityId: row.id,
    action: ACTIONS.CREATED,
    meta: Object.keys(meta).length ? meta : null,
    at: nowIso || row.created_at || null,
    deviceId,
  });
}

/**
 * Evento de troca de status.
 * @param {'demand'|'task'} entityType
 * @param {object} entity linha da entidade (usa id; o status só é lido se `transition` vier incompleto)
 * @param {object} transition objeto devolvido por transitionPatch (statuses.js): { patch, from: {id, category}, to: {id, category}, ... }
 * @param {{nowIso: string, deviceId?: string, reason?: string, auto?: boolean}} opts
 *        reason = motivo informado pelo usuário (ex.: motivo do bloqueio); auto = troca feita pelo sistema.
 * @returns {object} valores do evento: action 'status_changed', field 'status', old_value / new_value = ids dos status,
 *          meta { from_category, to_category, reason?, auto? } (reason só quando não é vazio; auto só quando true).
 *          Não verifica `transition.changed`: quem chama decide se uma troca para o mesmo status merece registro.
 */
export function statusEvent(entityType, entity, transition, { nowIso, deviceId = null, reason, auto } = {}) {
  const row = entity || {};
  const tr = transition || {};
  const from = tr.from || {};
  const to = tr.to || {};
  const meta = {
    from_category: from.category || null,
    to_category: to.category || null,
  };
  const why = cleanText(reason);
  if (why) meta.reason = why;
  if (auto === true) meta.auto = true;
  return makeEvent({
    entityType,
    entityId: row.id,
    action: ACTIONS.STATUS,
    field: 'status',
    oldValue: from.id ?? row.status ?? null,
    newValue: to.id ?? (tr.patch ? tr.patch.status : null) ?? null,
    meta,
    at: nowIso,
    deviceId,
  });
}

/**
 * Compara duas versões de uma linha e devolve um evento para cada campo que mudou.
 *
 * Só são comparados os campos presentes em `after` — que pode ser a linha completa depois da gravação ou apenas o
 * patch aplicado. Valores vazios (null, undefined, '' e []) são equivalentes entre si; listas e objetos são
 * comparados em profundidade. Os campos de DIFF_IGNORED_FIELDS nunca geram evento.
 *
 * Ação gerada por campo:
 *   priority      -> 'priority_changed' (meta.justification, quando informada)
 *   due_date      -> 'due_changed' (meta.reason, quando informado)
 *   description   -> 'description_changed' (texto antigo e novo guardados por inteiro, para nada se perder)
 *   archived_at   -> 'archived' | 'unarchived'      deleted_at -> 'deleted' | 'restored'
 *   project_id, demand_id, parent_id -> 'moved' (field = a coluna; old_value / new_value = ids)
 *   qualquer outro -> 'updated' (field, old_value, new_value)
 *
 * @param {'project'|'demand'|'task'} entityType
 * @param {object} before linha antes da alteração
 * @param {object} after linha depois da alteração (ou o patch)
 * @param {{nowIso: string, deviceId?: string, meta?: object}} opts
 *        meta.justification vai só para o evento de prioridade; meta.reason, só para o de prazo; as demais chaves
 *        de meta (ex.: { source: 'bulk' }) são copiadas para todos os eventos gerados.
 * @returns {object[]} valores dos eventos, na ordem dos campos de `after` (lista vazia se nada mudou)
 */
export function diffToEvents(entityType, before, after, { nowIso, deviceId = null, meta } = {}) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [];
  const entityId = after.id ?? before.id;
  const { justification, reason, ...shared } = meta && typeof meta === 'object' ? meta : {};
  const metaWith = (extra) => {
    const merged = { ...snapshot(shared), ...extra };
    return Object.keys(merged).length ? merged : null;
  };
  const events = [];
  const push = (action, { field = null, oldValue = null, newValue = null, extra = {} } = {}) => {
    events.push(makeEvent({ entityType, entityId, action, field, oldValue, newValue, meta: metaWith(extra), at: nowIso, deviceId }));
  };

  for (const field of Object.keys(after)) {
    if (IGNORED.has(field)) continue;
    const oldRaw = before[field];
    const newRaw = after[field];
    if (sameValue(oldRaw, newRaw)) continue;
    const oldValue = snapshot(oldRaw);
    const newValue = snapshot(newRaw);

    if (field === 'archived_at' || field === 'deleted_at') {
      const was = !isEmptyValue(oldRaw);
      const is = !isEmptyValue(newRaw);
      if (was === is) continue; // só mudou o instante: continua arquivada/excluída
      if (field === 'archived_at') push(is ? ACTIONS.ARCHIVED : ACTIONS.UNARCHIVED);
      else push(is ? ACTIONS.DELETED : ACTIONS.RESTORED);
    } else if (field === 'priority') {
      const why = cleanText(justification);
      push(ACTIONS.PRIORITY, { field, oldValue, newValue, extra: why ? { justification: why } : {} });
    } else if (field === 'due_date') {
      const why = cleanText(reason);
      push(ACTIONS.DUE, { field, oldValue, newValue, extra: why ? { reason: why } : {} });
    } else if (field === 'description') {
      push(ACTIONS.DESCRIPTION, { field, oldValue, newValue });
    } else if (PARENT_FIELDS.includes(field)) {
      push(ACTIONS.MOVED, { field, oldValue, newValue });
    } else {
      push(ACTIONS.UPDATED, { field, oldValue, newValue });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Evento -> frase
// ---------------------------------------------------------------------------

function describeCreated(event, c) {
  const meta = metaOf(event);
  let detail = null;
  if (meta.duplicated_from) {
    const maps = { project: c.projectsById, demand: c.demandsById, task: c.tasksById };
    const source = nameIn(maps[event.entity_type], meta.duplicated_from);
    detail = source ? `Cópia de ${quoted(source)}` : c.word('Criada a partir de uma cópia', 'Criado a partir de uma cópia');
  } else if (meta.parent_id) {
    const parent = nameIn(c.tasksById, meta.parent_id);
    if (parent) detail = `Subtarefa de ${quoted(parent)}`;
  }
  return entry('plus', c.word('Criada', 'Criado'), detail);
}

function describeStatus(event, c) {
  const meta = metaOf(event);
  const from = statusById(c.statuses, event.old_value);
  const to = statusById(c.statuses, event.new_value);
  const fromCategory = meta.from_category || from.category;
  const toCategory = meta.to_category || to.category;
  const path = `${from.label} ${ARROW} ${to.label}`;
  const reason = cleanText(meta.reason);
  const auto = meta.auto === true ? 'Alteração automática' : '';
  const join = (...parts) => parts.filter(Boolean).join(' · ');

  if (toCategory === 'done' && fromCategory !== 'done') {
    return entry('check-circle', c.word('Concluída', 'Concluído'), join(path, reason, auto), 'success');
  }
  if (fromCategory === 'done' && isOpenCategory(toCategory)) {
    return entry('rotate-ccw', c.word('Reaberta', 'Reaberto'), join(path, reason, auto), 'warn');
  }
  if (toCategory === 'blocked' && fromCategory !== 'blocked') {
    return entry('arrow-right', c.word('Bloqueada', 'Bloqueado'), join(reason || path, auto), 'danger');
  }
  return entry('arrow-right', `Status: ${path}`, join(reason, auto), toCategory === 'cancelled' ? 'muted' : 'default');
}

function describePriority(event, c) {
  const before = formatFieldValue('priority', event.old_value, c);
  const after = formatFieldValue('priority', event.new_value, c);
  return entry('flag', `Prioridade: ${before} ${ARROW} ${after}`, cleanText(metaOf(event).justification));
}

function describeDue(event, c) {
  const before = isEmptyValue(event.old_value) ? '' : formatDay(event.old_value, c.today);
  const after = isEmptyValue(event.new_value) ? '' : formatDay(event.new_value, c.today);
  const reason = cleanText(metaOf(event).reason);
  if (before && after) {
    const postponed = String(event.new_value) > String(event.old_value);
    return entry('calendar', `Prazo alterado: ${before} ${ARROW} ${after}`, reason, postponed ? 'warn' : 'default');
  }
  if (after) return entry('calendar', `Prazo definido: ${after}`, reason);
  if (before) return entry('calendar', `Prazo removido (era ${before})`, reason);
  return entry('calendar', 'Prazo alterado', reason);
}

function describeDescription(event) {
  return entry('file-text', 'Descrição alterada', excerpt(event.old_value));
}

function describeUpdated(event, c) {
  const field = event.field;
  if (typeof field !== 'string' || !field.trim()) return entry('pencil', 'Alteração registrada', cleanText(metaOf(event).reason));
  const label = fieldLabel(field);
  const before = formatFieldValue(field, event.old_value, c);
  const after = formatFieldValue(field, event.new_value, c);
  if (before.length > LONG_VALUE || after.length > LONG_VALUE) {
    return entry('pencil', `${label}: texto alterado`, isEmptyValue(event.old_value) ? null : `Antes: ${excerpt(before)}`);
  }
  return entry('pencil', `${label}: ${before} ${ARROW} ${after}`, cleanText(metaOf(event).reason));
}

function describeDependency(event, c, added) {
  const id = added ? event.new_value ?? event.old_value : event.old_value ?? event.new_value;
  const name = nameIn(c.tasksById, id) || cleanText(metaOf(event).name);
  const base = added ? 'Dependência adicionada' : 'Dependência removida';
  return entry(added ? 'link' : 'unlink', name ? `${base}: ${quoted(name)}` : base);
}

function describeMoved(event, c) {
  const hasNew = !isEmptyValue(event.new_value);
  const hasOld = !isEmptyValue(event.old_value);
  const moved = c.word('Movida', 'Movido');
  const removed = c.word('Removida', 'Removido');
  const spec = {
    demand_id: { map: c.demandsById, to: 'para a demanda', other: 'para outra demanda', from: 'da demanda', left: 'de uma demanda' },
    project_id: { map: c.projectsById, to: 'para o projeto', other: 'para outro projeto', from: 'do projeto', left: 'de um projeto' },
  }[event.field];

  if (spec) {
    const newName = nameIn(spec.map, event.new_value);
    const oldName = nameIn(spec.map, event.old_value);
    if (hasNew) {
      return entry('move', newName ? `${moved} ${spec.to} ${quoted(newName)}` : `${moved} ${spec.other}`, oldName ? `Antes: ${quoted(oldName)}` : null);
    }
    return entry('move', oldName ? `${removed} ${spec.from} ${quoted(oldName)}` : `${removed} ${spec.left}`);
  }
  if (event.field === 'parent_id') {
    const newName = nameIn(c.tasksById, event.new_value);
    const oldName = nameIn(c.tasksById, event.old_value);
    if (hasNew) return entry('move', newName ? `Passou a ser subtarefa de ${quoted(newName)}` : 'Passou a ser subtarefa', oldName ? `Antes: ${quoted(oldName)}` : null);
    if (hasOld) return entry('move', oldName ? `Deixou de ser subtarefa de ${quoted(oldName)}` : 'Deixou de ser subtarefa');
  }
  return entry('move', moved);
}

function describeNote(event) {
  return entry('message', 'Observação adicionada', excerpt(metaOf(event).excerpt));
}

function describeLink(event, added) {
  const meta = metaOf(event);
  const label = excerpt(meta.label, 80) || null;
  if (!added) return entry('unlink', 'Link removido', label, 'muted');
  return entry('link', meta.restored ? 'Link restaurado' : 'Link adicionado', label);
}

function describeTime(event) {
  const source = metaOf(event).source;
  const detail = source === 'timer' ? 'Cronômetro' : source === 'manual' ? 'Lançamento manual' : null;
  if (isEmptyValue(event.new_value)) return entry('clock', 'Tempo registrado', detail);
  return entry('clock', `Tempo registrado: ${formatSeconds(event.new_value)}`, detail);
}

function describeWeek(event, c) {
  const meta = metaOf(event);
  const weekOf = (value) => formatWeek(value, c.today);
  if (event.action === ACTIONS.WEEK_ADDED) {
    const week = weekOf(event.new_value);
    const text = week ? `${c.word('Adicionada', 'Adicionado')} à semana de ${week}` : `${c.word('Adicionada', 'Adicionado')} ao planejamento semanal`;
    return entry('calendar-week', text, meta.kind === 'added' ? 'Incluída com a semana já em andamento' : null);
  }
  if (event.action === ACTIONS.WEEK_REMOVED) {
    const week = weekOf(event.new_value) || weekOf(event.old_value);
    const destination = weekOf(meta.to_week);
    if (destination) {
      // Replanejamento (moveWeekItem): saiu de uma semana para entrar noutra.
      return entry('calendar-week', `${c.word('Movida', 'Movido')} para a semana de ${destination}`, week ? `Saiu da semana de ${week}` : null);
    }
    const text = week ? `${c.word('Removida', 'Removido')} da semana de ${week}` : `${c.word('Removida', 'Removido')} do planejamento semanal`;
    return entry('calendar-week', text, null, 'muted');
  }
  if (event.action === ACTIONS.WEEK_UNDONE) {
    // "Desfazer" de mover/transferir: o item criado na outra semana foi descartado e a origem voltou como era.
    const back = weekOf(event.new_value) || weekOf(meta.to_week);
    const away = weekOf(meta.from_week);
    return entry('undo', back ? `Mudança de semana desfeita: de volta à semana de ${back}` : 'Mudança de semana desfeita', away ? `Não foi para a semana de ${away}` : null, 'muted');
  }
  const target = weekOf(meta.to_week) || weekOf(event.new_value);
  const origin = weekOf(meta.from_week);
  const text = target ? `${c.word('Transferida', 'Transferido')} para a semana de ${target}` : `${c.word('Transferida', 'Transferido')} para outra semana`;
  return entry('calendar-week', text, origin ? `Veio da semana de ${origin}` : null);
}

function describeFollowUp(event, c) {
  const meta = metaOf(event);
  const person = cleanText(meta.person) || cleanText(event.new_value);
  const text = person ? `Cobrança feita a ${person}` : 'Cobrança feita';
  const parts = [];
  const note = cleanText(meta.note);
  if (note) parts.push(excerpt(note));
  if (isValidDateStr(meta.next_date)) parts.push(`Próxima cobrança: ${formatDay(meta.next_date, c.today)}`);
  return entry('bell', text, parts.length ? parts.join(' · ') : null);
}

function describeUnknown(event, c) {
  // Ação desconhecida (versão mais nova do app em outro dispositivo): se houver campo e valores, mostra como alteração.
  const hasField = typeof event.field === 'string' && event.field.trim();
  if (hasField && (!isEmptyValue(event.old_value) || !isEmptyValue(event.new_value))) {
    return { ...describeUpdated(event, c), tone: 'muted' };
  }
  const action = typeof event.action === 'string' ? event.action.replace(/_/g, ' ').trim() : '';
  return entry('pencil', action ? `Atividade registrada: ${action}` : 'Atividade registrada', cleanText(metaOf(event).reason), 'muted');
}

/**
 * Traduz um evento do histórico numa frase em português para a linha do tempo.
 *
 * @param {object} event linha de activity_log
 * @param {{statuses?: Array, tasksById?: Map|object, demandsById?: Map|object, projectsById?: Map|object, today?: string}} [ctx]
 *        Os mapas (Map ou objeto id -> linha) servem para mostrar nomes; `today` ('YYYY-MM-DD') define quando o ano
 *        aparece nas datas (sem ele, usa-se o dia do próprio evento — o relógio nunca é consultado).
 * @returns {{icon: string, text: string, detail: string|null, tone: 'default'|'success'|'warn'|'danger'|'muted'}}
 *          icon é um dos nomes: plus, check-circle, rotate-ccw, arrow-right, flag, calendar, file-text, pencil, link,
 *          unlink, archive, trash, undo, move, message, clock, calendar-week, bell.
 *
 * Exemplos: 'Criada' · 'Concluída' (detail 'Em revisão → Concluída', tone success) · 'Reaberta' (warn) ·
 * 'Bloqueada' (detail = motivo) · 'Status: Em andamento → Em revisão' (detail = motivo) · 'Prazo definido: 20 nov' ·
 * 'Prazo alterado: 12 nov → 20 nov' · 'Prazo removido (era 12 nov)' · 'Prioridade: P3 Média → P1 Crítica' ·
 * 'Descrição alterada' (detail = trecho do texto anterior) · 'Dependência adicionada: “X”' · 'Arquivada' ·
 * 'Movida para a demanda “X”' · 'Observação adicionada' · 'Tempo registrado: 1h 30min' ·
 * 'Adicionada à semana de 16–22 nov' · 'Responsável: Ana → Pedro' · 'Estimativa: 2h → 4h'.
 * Eventos de projeto usam o masculino ('Criado', 'Arquivado'). Ações desconhecidas também viram uma frase.
 */
export function describeEvent(event, ctx = {}) {
  if (!event || typeof event !== 'object') return entry('pencil', 'Atividade registrada', null, 'muted');
  const base = ctx || {};
  const masculine = event.entity_type === 'project';
  const c = {
    statuses: base.statuses,
    tasksById: base.tasksById,
    demandsById: base.demandsById,
    projectsById: base.projectsById,
    today: isValidDateStr(base.today) ? base.today : isoToDateStr(event.at),
    word: (feminine, masc) => (masculine ? masc : feminine),
  };
  const reason = cleanText(metaOf(event).reason);
  switch (event.action) {
    case ACTIONS.CREATED:
      return describeCreated(event, c);
    case ACTIONS.STATUS:
      return describeStatus(event, c);
    case ACTIONS.PRIORITY:
      return describePriority(event, c);
    case ACTIONS.DUE:
      return describeDue(event, c);
    case ACTIONS.DESCRIPTION:
      return describeDescription(event);
    case ACTIONS.UPDATED:
      return describeUpdated(event, c);
    case ACTIONS.DEP_ADDED:
      return describeDependency(event, c, true);
    case ACTIONS.DEP_REMOVED:
      return describeDependency(event, c, false);
    case ACTIONS.ARCHIVED:
      return entry('archive', c.word('Arquivada', 'Arquivado'), reason, 'muted');
    case ACTIONS.UNARCHIVED:
      return entry('undo', c.word('Desarquivada', 'Desarquivado'), reason);
    case ACTIONS.DELETED:
      return entry('trash', c.word('Excluída', 'Excluído'), reason, 'danger');
    case ACTIONS.RESTORED:
      return entry('undo', c.word('Restaurada', 'Restaurado'), reason, 'success');
    case ACTIONS.MOVED:
      return describeMoved(event, c);
    case ACTIONS.NOTE_ADDED:
      return describeNote(event);
    case ACTIONS.TIME_LOGGED:
      return describeTime(event);
    case ACTIONS.WEEK_ADDED:
    case ACTIONS.WEEK_REMOVED:
    case ACTIONS.WEEK_CARRIED:
    case ACTIONS.WEEK_UNDONE:
      return describeWeek(event, c);
    case ACTIONS.FOLLOW_UP:
      return describeFollowUp(event, c);
    case ACTIONS.LINK_ADDED:
      return describeLink(event, true);
    case ACTIONS.LINK_REMOVED:
      return describeLink(event, false);
    default:
      return describeUnknown(event, c);
  }
}

/**
 * Agrupa eventos por dia (data LOCAL de cada evento) para a linha do tempo.
 * @param {object[]} events eventos em qualquer ordem (a lista não é alterada)
 * @returns {Array<{date: string|null, events: object[]}>} dias do mais novo para o mais antigo e, dentro de cada dia,
 *          eventos do mais novo para o mais antigo (empate de instante: id maior primeiro). Eventos sem instante válido
 *          ficam num último grupo com date = null.
 */
export function groupByDay(events) {
  const dated = [];
  const undated = [];
  for (const ev of events || []) {
    if (!ev || typeof ev !== 'object') continue;
    const date = typeof ev.at === 'string' ? isoToDateStr(ev.at) : null;
    if (date) dated.push({ ev, date });
    else undated.push(ev);
  }
  const dateOf = new Map(dated.map((d) => [d.ev, d.date]));
  const ordered = sortEvents(dated.map((d) => d.ev)).reverse();
  const groups = [];
  const byDate = new Map();
  for (const ev of ordered) {
    const date = dateOf.get(ev);
    let group = byDate.get(date);
    if (!group) {
      group = { date, events: [] };
      byDate.set(date, group);
      groups.push(group);
    }
    group.events.push(ev);
  }
  // Instantes ISO em ordem decrescente dão dias em ordem decrescente; a ordenação abaixo protege contra formatos mistos.
  groups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  if (undated.length) groups.push({ date: null, events: undated });
  return groups;
}
