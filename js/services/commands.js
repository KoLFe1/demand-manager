// Comandos do app (app.cmd): o ÚNICO caminho de escrita usado pela interface.
//
// Cada comando:
//   • é SÍNCRONO (o banco local é memória primeiro) e roda dentro de UM `store.transact`: ou grava tudo,
//     ou não grava nada (entrada inválida lança CommandError e a transação é desfeita);
//   • valida e normaliza a entrada (nomes aparados, texto vazio → null, datas 'YYYY-MM-DD', etc.);
//   • registra no histórico (activity_log) o que mudou, com `device_id = app.deviceId` e
//     `at = app.clock.nowIso()` — um único instante por comando;
//   • devolve a(s) linha(s) afetada(s). Avisos que não impedem a operação e a automação "iniciar a demanda"
//     ficam em `cmd.lastOutcome()` e no evento 'command' de `app.events`.
//
// Regras gerais:
//   • as métricas e os resumos semanais leem o HISTÓRICO: nenhuma demanda/tarefa é gravada sem o evento
//     'created' e nenhuma troca de status sem o evento de status;
//   • status + completed_at sempre são gravados juntos (transitionPatch);
//   • prioridades NUNCA mudam sozinhas. A única automação é iniciar a demanda quando uma tarefa dela entra em
//     execução (configuração 'workflow.autoStartDemand'), registrada com meta.auto = true;
//   • os comandos leem direto do banco (não dos seletores memorizados): dentro de uma transação a versão do
//     banco ainda não mudou e os seletores devolveriam dados antigos.

import { addDays, addWorkdays, countWorkdays, diffDays, isValidDateStr, isoToDateStr, startOfWeek, timeOfIso } from '../core/dates.js';
import { ENTITY_TABLE } from '../data/schema.js';
import { blockingPrereqs, buildGraph, dependencyRows, findCycles, validateNewDependency, wouldCreateCycle } from '../domain/dependencies.js';
import { createdEvent, diffToEvents, statusEvent } from '../domain/history.js';
import { DEFAULT_PRIORITY, PRIORITIES } from '../domain/priorities.js';
import { demandProgress, isCountable } from '../domain/progress.js';
import { categoryOf, firstOfCategory, isDone, isInFlightCategory, isOpen, isOpenCategory, resolveStatuses, transitionPatch } from '../domain/statuses.js';
import { ACTIONS, makeEvent, sortEvents } from '../domain/timeline.js';
import { DEFAULT_FOLLOWUP_DAYS, isOtherOwner, nextFollowUpDate, personName, resumeStatusId } from '../domain/followup.js';
import { compareManualOrder } from '../domain/filters.js';
import { ENTRY_SOURCE, TIMER, ValidationError, findOverlaps, formatDuration, manualEntryValues, pausePatch, resumePatch, startValues, stopPatch, timerState } from '../domain/timetracking.js';
import { WEEK_KIND, allWeekItems, carryOverPlan, kindForNewItem } from '../domain/weekplan.js';
import { MAX_TEMPLATES, TemplateError, availableTemplates, isBuiltinTemplate, isTemplateSettingKey, normalizeTemplate, normalizeTemplateSetting, planTemplate, templateSettingKey, templatesFromSettings } from '../domain/templates.js';
import { classifyTarget, compareLinks } from '../domain/links.js';
import { derivedUuid, uuid } from '../core/ids.js';
import { RecurrenceError, carriedRecurrence, nextOccurrenceFrom, normalizeRecurrence, occurrenceBase } from '../domain/recurrence.js';

/**
 * Erro de regra de negócio de um comando. `message` está em pt-BR e pode ser mostrada ao usuário.
 *
 * Códigos: not_found, invalid_type, invalid_field, invalid_name, invalid_priority, invalid_status, invalid_date,
 * invalid_estimate, invalid_weight, invalid_tags, invalid_body, project_not_found, demand_not_found,
 * invalid_parent, invalid_position, demand_deleted, parent_deleted, missing | self | duplicate | hierarchy |
 * cycle (dependências), timer_running, timer_active, overlap, invalid_option, invalid_week, invalid_kind,
 * invalid_setting, invalid_suggestion, invalid_target (links: data.reason = 'empty' | 'unsafe' | 'too_long') — e os códigos de ValidationError de timetracking.js.
 */
export class CommandError extends Error {
  /**
   * @param {string} code código estável (interface e testes)
   * @param {string} message texto em pt-BR
   * @param {object|null} [data] dados extras (ex.: { path } num ciclo de dependências)
   */
  constructor(code, message, data = null) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
    this.data = data;
  }
}

const EMPTY = Object.freeze([]);
const ORDER_STEP = 1000;
const MAX_ESTIMATE_MINUTES = 10 * 365 * 24 * 60;
const MAX_DISMISSED = 500;
const EXCERPT_LENGTH = 140;
const COPY_SUFFIX = ' (cópia)';
const PRIORITY_IDS = new Set(PRIORITIES.map((p) => p.id));
const NOTE_TYPES = new Set(['demand', 'task', 'project']);
const TIMER_OTHERS = new Set(['ask', 'pause', 'keep']);

const NOT_FOUND = Object.freeze({
  project: 'Projeto não encontrado: ele pode ter sido excluído.',
  demand: 'Demanda não encontrada: ela pode ter sido excluída.',
  task: 'Tarefa não encontrada: ela pode ter sido excluída.',
});

/** Campos que cada comando de criação/alteração aceita. */
const EDITABLE = Object.freeze({
  project: new Set(['name', 'code', 'color', 'description', 'sort_order']),
  demand: new Set([
    'name', 'description', 'project_id', 'status', 'priority', 'planned_start', 'due_date', 'estimate_minutes', 'owner', 'tags',
    'blocked_reason', 'waiting_on', 'objective', 'deliverables', 'next_action', 'category', 'sort_order', 'actual_start',
    'follow_up_date',
  ]),
  task: new Set([
    'name', 'description', 'demand_id', 'parent_id', 'status', 'priority', 'planned_start', 'due_date', 'estimate_minutes', 'owner', 'tags',
    'blocked_reason', 'waiting_on', 'weight', 'required', 'sort_order', 'actual_start',
    'follow_up_date', 'recurrence',
  ]),
});

const TEXT_FIELDS = new Set(['description', 'owner', 'blocked_reason', 'waiting_on', 'objective', 'deliverables', 'next_action', 'category', 'code']);

/** Campos copiados ao duplicar (o restante — status, datas reais, bloqueios — volta ao estado inicial). */
const DEMAND_COPY_FIELDS = Object.freeze(['project_id', 'description', 'priority', 'planned_start', 'due_date', 'estimate_minutes', 'owner', 'tags', 'objective', 'deliverables', 'next_action', 'category']);
const TASK_COPY_FIELDS = Object.freeze(['description', 'priority', 'planned_start', 'due_date', 'estimate_minutes', 'owner', 'tags', 'weight', 'required']);

const SETTING_RULES = Object.freeze({
  'owner.default': (v) => (v === null ? '' : typeof v === 'string' ? v.trim() : undefined),
  'capacity.hoursPerDay': (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 24 ? v : undefined),
  'capacity.hoursPerWeek': (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 168 ? v : undefined),
  'deadline.soonDays': (v) => (Number.isInteger(v) && v >= 0 && v <= 60 ? v : undefined),
  'workflow.autoStartDemand': (v) => (typeof v === 'boolean' ? v : undefined),
  'followup.defaultDays': (v) => (Number.isInteger(v) && v >= 1 && v <= 30 ? v : undefined),
  statuses: (v) => (v === null || (Array.isArray(v) && v.every((s) => s && typeof s === 'object' && typeof s.id === 'string' && s.id)) ? v : undefined),
  'suggestions.dismissed': (v) => (Array.isArray(v) && v.every((s) => typeof s === 'string') ? v : undefined),
});

const SETTING_MESSAGES = Object.freeze({
  'owner.default': 'O responsável padrão precisa ser um texto.',
  'capacity.hoursPerDay': 'Informe as horas por dia: um número maior que 0 e até 24.',
  'capacity.hoursPerWeek': 'Informe as horas por semana: um número maior que 0 e até 168.',
  'deadline.soonDays': 'Informe um número inteiro de dias, de 0 a 60.',
  'workflow.autoStartDemand': 'Esta opção aceita apenas ligado ou desligado.',
  'followup.defaultDays': 'O prazo para cobrar de novo deve ser um número inteiro de dias úteis, de 1 a 30.',
  statuses: 'A personalização de status precisa ser uma lista de status com identificador.',
  'suggestions.dismissed': 'A lista de sugestões dispensadas é inválida.',
});

// ---------------------------------------------------------------------------
// Utilidades puras
// ---------------------------------------------------------------------------

const hasId = (id) => id !== null && id !== undefined && id !== '';
const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);
const cmpText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const quoted = (row) => `“${row && typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'sem nome'}”`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function bySortOrder(a, b) {
  return finite(a.sort_order) - finite(b.sort_order) || cmpText(String(a.created_at || ''), String(b.created_at || '')) || cmpText(String(a.id), String(b.id));
}

/** Igualdade de valores de campo: vazios (null/undefined) equivalem; listas são comparadas item a item. */
function sameValue(a, b) {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  if (x === y) return true;
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((item, i) => item === y[i]);
  // Objetos JSON (ex.: recurrence): mesma estrutura = mesmo valor.
  if (x && y && typeof x === 'object' && typeof y === 'object') return JSON.stringify(x) === JSON.stringify(y);
  return false;
}

function listNames(rows) {
  const names = rows.map(quoted);
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

function excerptOf(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : flat;
}

/** Desloca um instante ISO em `days` dias de calendário, preservando a hora LOCAL. */
function shiftDays(iso, days) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/**
 * Cria os comandos do app.
 *
 * @param {{ store: object, clock: object, deviceId: string, events: object, settings: object }} app objeto do app (createApp)
 * @returns {object} `cmd` — ver a documentação de cada comando abaixo
 */
export function createCommands(app) {
  const { store } = app;

  /** Consultas por id no formato aceito pelas funções de domínio (objeto com `get`). */
  const TASKS = Object.freeze({ get: (id) => store.get('tasks', id) });
  const DEMANDS = Object.freeze({ get: (id) => store.get('demands', id) });

  // --- estado do comando em curso ------------------------------------------------------------------
  let depth = 0;
  /** Instante (ISO) do comando em curso: todos os eventos e carimbos de um comando usam o mesmo. */
  let now = null;
  let outcome = null;
  let last = Object.freeze({ command: null, warnings: EMPTY, autoStartedDemand: null, autoStartedFrom: null, nextOccurrences: EMPTY });

  const fail = (code, message, data = null) => {
    throw new CommandError(code, message, data);
  };

  function translate(error) {
    if (error instanceof TemplateError) return new CommandError(error.code, error.message, error.data);
    if (error instanceof ValidationError) return new CommandError(error.code, error.message, { field: error.field });
    return error;
  }

  /** Embrulha um comando: transação única, instante único, conversão de erros e evento 'command'. */
  function define(name, fn) {
    return (...args) => {
      const outer = depth === 0;
      if (outer) {
        now = app.clock.nowIso();
        outcome = { command: name, warnings: [], autoStartedDemand: null, autoStartedFrom: null, nextOccurrences: [] };
      }
      depth += 1;
      let result;
      try {
        result = store.transact(() => fn(...args));
      } catch (error) {
        if (outer) {
          now = null;
          outcome = null;
        }
        throw translate(error);
      } finally {
        depth -= 1;
      }
      if (outer) {
        last = Object.freeze({ ...outcome, warnings: Object.freeze(outcome.warnings.map((w) => Object.freeze(w))), nextOccurrences: Object.freeze(outcome.nextOccurrences.map((o) => Object.freeze(o))) });
        now = null;
        outcome = null;
        if (app.events) app.events.emit('command', { name, result, warnings: last.warnings, autoStartedDemand: last.autoStartedDemand, nextOccurrences: last.nextOccurrences });
      }
      return result;
    };
  }

  function warn(list, code, message, data) {
    list.push({ code, message, data });
  }

  /** Leva os avisos e a automação de um resultado de troca de status para o desfecho do comando. */
  function absorb(result) {
    if (!outcome || !result) return result;
    for (const w of result.warnings) outcome.warnings.push(w);
    for (const o of result.nextOccurrences || EMPTY) if (!outcome.nextOccurrences.some((x) => x.id === o.id)) outcome.nextOccurrences.push(o);
    if (result.autoStartedDemand) {
      outcome.autoStartedDemand = result.autoStartedDemand;
      outcome.autoStartedFrom = result.autoStartedFrom;
    }
    return result;
  }

  // --- leitura direta do banco -------------------------------------------------------------------
  const statuses = () => {
    const row = store.get('settings', 'statuses');
    return resolveStatuses(row ? row.value : null);
  };

  function liveGet(table, id) {
    if (!hasId(id)) return null;
    const row = store.get(table, id);
    return row && !row.deleted_at ? row : null;
  }

  function requireRow(type, id) {
    const table = ENTITY_TABLE[type];
    if (!table) fail('invalid_type', `Tipo de registro desconhecido: ${String(type)}.`, { type });
    const row = liveGet(table, id);
    if (!row) fail('not_found', NOT_FOUND[type], { type, id });
    return row;
  }

  function requireStatus(list, id) {
    const status = typeof id === 'string' ? list.find((s) => s.id === id) : null;
    if (!status) fail('invalid_status', `Status desconhecido: ${String(id)}.`, { status: id });
    return status;
  }

  /** Subtarefa = tem parent_id apontando para outra tarefa existente. */
  const isSubtask = (task) => hasId(task.parent_id) && task.parent_id !== task.id && !!store.get('tasks', task.parent_id);
  const subtasksOf = (taskId) => store.byIndex('tasks', 'parent_id', taskId).filter((t) => t.id !== taskId);
  const topTasksOf = (demandId) => store.byIndex('tasks', 'demand_id', hasId(demandId) ? demandId : null).filter((t) => !isSubtask(t));

  /** Demanda (não excluída) de uma tarefa; a de uma subtarefa é a do pai. */
  function demandOfTask(task) {
    const parent = isSubtask(task) ? store.get('tasks', task.parent_id) : null;
    return liveGet('demands', parent ? parent.demand_id : task.demand_id);
  }

  /** Todas as tarefas não excluídas de uma demanda, com as subtarefas (mesmo as de demand_id divergente). */
  function tasksOfDemand(demandId) {
    const byId = new Map();
    for (const task of store.byIndex('tasks', 'demand_id', demandId)) byId.set(task.id, task);
    for (const task of [...byId.values()]) for (const sub of subtasksOf(task.id)) byId.set(sub.id, sub);
    return [...byId.values()];
  }

  function nextSeq(table) {
    let max = 0;
    for (const row of store.all(table, { includeDeleted: true })) if (Number.isInteger(row.seq) && row.seq > max) max = row.seq;
    return max + 1;
  }

  function nextSortOrder(siblings) {
    let max = 0;
    for (const row of siblings) if (finite(row.sort_order) > max) max = finite(row.sort_order);
    return max + ORDER_STEP;
  }

  const log = (event) => store.insert('activity_log', event);
  const logAll = (events) => {
    for (const event of events) log(event);
  };
  const auditDiff = (type, before, patch, meta) => logAll(diffToEvents(type, before, patch, { nowIso: now, deviceId: app.deviceId, meta }));
  const event = (entityType, entityId, action, fields = {}) => log(makeEvent({ entityType, entityId, action, at: now, deviceId: app.deviceId, ...fields }));

  // --- validação de campos -----------------------------------------------------------------------
  /** Alvo de link validado (domain/links.js) ou CommandError 'invalid_target'. */
  function checkedTarget(target) {
    const res = classifyTarget(target);
    if (!res.ok) fail('invalid_target', res.error.message, { field: 'target', reason: res.error.code });
    return res;
  }

  /** Rótulo de link: texto aparado (até 200) ou, vazio, o sugerido pelo alvo. */
  function linkLabel(label, res) {
    if (label !== null && label !== undefined && typeof label !== 'string') fail('invalid_field', 'O rótulo do link precisa ser um texto.', { field: 'label' });
    const text = typeof label === 'string' ? label.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    return text || res.label || null;
  }

  function textOrNull(field, value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') fail('invalid_field', `O campo "${field}" precisa ser um texto.`, { field });
    const text = value.trim();
    return text ? text : null;
  }

  function dateOrNull(field, value) {
    if (value === null || value === undefined || value === '') return null;
    if (!isValidDateStr(value)) fail('invalid_date', 'Data inválida: use o formato AAAA-MM-DD.', { field, value });
    return value;
  }

  function cleanTags(value) {
    if (value === null || value === undefined) return [];
    if (!Array.isArray(value)) fail('invalid_tags', 'As tags precisam ser uma lista de textos.', { field: 'tags' });
    const out = [];
    const seen = new Set();
    for (const item of value) {
      if (typeof item !== 'string') fail('invalid_tags', 'As tags precisam ser uma lista de textos.', { field: 'tags' });
      const tag = item.trim();
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
    return out;
  }

  function cleanField(field, value, list) {
    if (TEXT_FIELDS.has(field)) return textOrNull(field, value);
    switch (field) {
      case 'name': {
        const name = typeof value === 'string' ? value.trim() : '';
        if (!name) fail('invalid_name', 'Informe um nome.', { field });
        return name;
      }
      case 'color': {
        const color = textOrNull(field, value);
        if (!color) fail('invalid_field', 'Informe a cor do projeto.', { field });
        return color;
      }
      case 'priority':
        if (!PRIORITY_IDS.has(value)) fail('invalid_priority', `Prioridade desconhecida: ${String(value)}. Use P1, P2, P3 ou P4.`, { priority: value });
        return value;
      case 'status':
        return requireStatus(list, value).id;
      case 'planned_start':
      case 'due_date':
      case 'follow_up_date':
        return dateOrNull(field, value);
      case 'estimate_minutes':
        if (value === null || value === undefined || value === '') return null;
        if (!Number.isInteger(value) || value < 0 || value > MAX_ESTIMATE_MINUTES) {
          fail('invalid_estimate', 'A estimativa precisa ser um número inteiro de minutos, maior ou igual a zero.', { field, value });
        }
        return value;
      case 'weight':
        if (value === null || value === undefined || value === '') return null;
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
          fail('invalid_weight', 'O peso precisa ser um número maior que 0 e no máximo 100.', { field, value });
        }
        return value;
      case 'required':
        if (typeof value !== 'boolean') fail('invalid_field', 'O campo "obrigatória" aceita apenas sim ou não.', { field });
        return value;
      case 'tags':
        return cleanTags(value);
      case 'sort_order':
        if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid_field', 'A ordem precisa ser um número.', { field });
        return value;
      case 'actual_start': {
        if (value === null || value === undefined || value === '') return null;
        const d = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(d.getTime())) fail('invalid_date', 'Instante de início inválido.', { field, value });
        return d.toISOString();
      }
      case 'project_id':
        if (!hasId(value)) return null;
        if (!liveGet('projects', value)) fail('project_not_found', NOT_FOUND.project, { id: value });
        return value;
      case 'demand_id':
        if (!hasId(value)) return null;
        if (!liveGet('demands', value)) fail('demand_not_found', NOT_FOUND.demand, { id: value });
        return value;
      case 'parent_id':
        if (!hasId(value)) return null;
        if (typeof value !== 'string') fail('invalid_parent', 'Tarefa principal inválida.', { id: value });
        return value;
      case 'recurrence':
        try {
          return normalizeRecurrence(value);
        } catch (error) {
          if (error instanceof RecurrenceError) return fail(error.code, error.message, { field, ...(error.data || {}) });
          throw error;
        }
      default:
        return fail('invalid_field', `O campo "${field}" não pode ser alterado por este comando.`, { field });
    }
  }

  /** Valida um objeto de valores/patch: só chaves editáveis, valores normalizados; `undefined` é ignorado. */
  function cleanInput(type, input, what) {
    if (input === null || input === undefined) return {};
    if (typeof input !== 'object' || Array.isArray(input)) fail('invalid_field', `${what}: informe um objeto com os campos.`);
    const allowed = EDITABLE[type];
    const list = statuses();
    const out = {};
    for (const key of Object.keys(input)) {
      if (input[key] === undefined) continue;
      if (!allowed.has(key)) fail('invalid_field', `O campo "${key}" não pode ser alterado por este comando.`, { field: key });
      out[key] = cleanField(key, input[key], list);
    }
    return out;
  }

  // --- ordem manual ------------------------------------------------------------------------------
  /**
   * Valor de sort_order para colocar `row` antes/depois de um item de referência.
   * Devolve null quando nenhuma referência foi informada. Sem espaço entre os vizinhos, renumera a lista de
   * destino (gravando só as linhas cuja ordem muda) e devolve a nova ordem de `row`.
   * A referência pode estar fora da lista de destino (ex.: coluna do Kanban com tarefas de várias demandas):
   * nesse caso a posição é calculada pelo sort_order dela.
   */
  function orderValue(table, siblings, row, { beforeId, afterId } = {}) {
    const before = hasId(beforeId);
    const refId = before ? beforeId : hasId(afterId) ? afterId : null;
    if (refId === null) return null;
    const rowId = row ? row.id : null;
    if (refId === rowId) fail('invalid_position', 'Um item não pode ser posicionado em relação a ele mesmo.', { id: refId });
    // Mesma ordem que a tela mostra (sortItems 'manual'): com sort_order empatado, os vizinhos e a renumeração
    // seguem prioridade → prazo → nome, não a ordem de criação.
    const list = siblings.filter((s) => s.id !== rowId).sort(compareManualOrder);
    let index = list.findIndex((s) => s.id === refId);
    let foreign = null;
    if (index < 0) {
      foreign = liveGet(table, refId);
      if (!foreign) fail('invalid_position', 'O item de referência não foi encontrado.', { id: refId });
      index = list.findIndex((s) => compareManualOrder(foreign, s) < 0);
      if (index < 0) index = list.length;
      list.splice(index, 0, foreign);
    }
    const ref = finite(list[index].sort_order);
    const neighbour = before ? list[index - 1] : list[index + 1];
    const lo = before ? (neighbour ? finite(neighbour.sort_order) : ref - 2 * ORDER_STEP) : ref;
    const hi = before ? ref : neighbour ? finite(neighbour.sort_order) : ref + 2 * ORDER_STEP;
    const value = (lo + hi) / 2;
    if (value > lo && value < hi) return value;

    // Vizinhos com a mesma ordem (ou precisão esgotada): renumera a lista de destino.
    const MOVED = Symbol('movido');
    const order = [...list];
    order.splice(before ? index : index + 1, 0, MOVED);
    let result = ORDER_STEP;
    let position = 0;
    for (const item of order) {
      if (item === foreign) continue;
      position += ORDER_STEP;
      if (item === MOVED) result = position;
      else if (finite(item.sort_order) !== position) store.update(table, item.id, { sort_order: position });
    }
    return result;
  }

  // --- cronômetros (uso interno) -----------------------------------------------------------------
  const openTimers = () => store.all('time_entries').filter((entry) => timerState(entry) !== TIMER.DONE);
  const runningTimers = () => store.all('time_entries').filter((entry) => timerState(entry) === TIMER.RUNNING);

  function logTime(entry, source) {
    if (!hasId(entry.task_id)) return;
    event('task', entry.task_id, ACTIONS.TIME_LOGGED, { newValue: entry.duration_seconds, meta: { entry_id: entry.id, source } });
  }

  function stopEntry(entry, options) {
    const stopped = store.update('time_entries', entry.id, stopPatch(entry, now, options));
    logTime(stopped, ENTRY_SOURCE.TIMER);
    return stopped;
  }

  /**
   * Retoma um cronômetro pausado. O registro guarda só início e término (não os trechos): se, durante a pausa,
   * houve outro apontamento, continuar no mesmo registro faria o intervalo [início, término] cobrir esse
   * trabalho (falsa sobreposição e horários que não descrevem o trabalho). Nesse caso o registro pausado é
   * encerrado no instante da pausa e um registro novo começa agora. Sem nada na pausa, segue no mesmo registro.
   */
  function resumeEntry(paused) {
    const patch = resumePatch(paused, now); // valida o estado
    const pausedAt = paused.ended_at;
    const gap = pausedAt ? { started_at: pausedAt, ended_at: now, state: TIMER.DONE } : null;
    const busy = gap && findOverlaps(store.all('time_entries').filter((entry) => entry.id !== paused.id), { candidate: gap, nowMs: Date.parse(now) }).length > 0;
    if (!busy) return store.update('time_entries', paused.id, patch);
    stopEntry(paused);
    const values = startValues({ taskId: paused.task_id, nowIso: now });
    return store.insert('time_entries', { ...values, description: paused.description || null, created_at: now, updated_at: now });
  }

  /** Encerra os cronômetros em aberto das tarefas informadas (ao excluir/arquivar). */
  function stopTimersOf(taskIds) {
    if (!taskIds.size) return;
    for (const entry of openTimers()) if (taskIds.has(entry.task_id)) stopEntry(entry);
  }

  function requireEntry(id) {
    const entry = liveGet('time_entries', id);
    if (!entry) fail('not_found', 'Apontamento não encontrado: ele pode ter sido excluído.', { type: 'time_entry', id });
    return entry;
  }

  /** Trata os OUTROS cronômetros rodando antes de ligar/retomar um: perguntar, pausar ou manter. */
  function handleOthers(others, exceptId) {
    if (!TIMER_OTHERS.has(others)) fail('invalid_option', `Opção desconhecida para os outros cronômetros: ${String(others)}.`, { others });
    const running = runningTimers().filter((entry) => entry.id !== exceptId);
    if (!running.length || others === 'keep') return;
    if (others === 'ask') {
      const names = running.map((entry) => quoted(store.get('tasks', entry.task_id)));
      fail('timer_running', `Já há um cronômetro em andamento em ${names.join(', ')}. Pause-o ou mantenha os dois rodando.`, { running });
    }
    for (const entry of running) store.update('time_entries', entry.id, pausePatch(entry, now));
  }

  // --- troca de status ---------------------------------------------------------------------------
  /** A troca desfaz um início automático da demanda? (volta ao status anterior logo depois da automação) */
  function undoesAutoStart(demand, statusId) {
    if (!demand.actual_start) return false;
    let latest = null;
    for (const ev of store.byIndex('activity_log', 'entity_id', demand.id)) {
      if (ev.entity_type !== 'demand' || ev.action !== ACTIONS.STATUS) continue;
      if (!latest || ev.at > latest.at || (ev.at === latest.at && String(ev.id) > String(latest.id))) latest = ev;
    }
    return !!latest && !!latest.meta && latest.meta.auto === true && latest.new_value === demand.status && latest.old_value === statusId && latest.at === demand.actual_start;
  }

  /** Automação: tarefa entrou em execução → demanda sai de backlog/planejada para o primeiro status "em andamento". */
  function autoStartDemand(task, result, list) {
    if (app.settings.get('workflow.autoStartDemand') !== true) return;
    const demand = demandOfTask(task);
    if (!demand || demand.archived_at) return;
    const category = categoryOf(list, demand.status);
    if (category !== 'backlog' && category !== 'planned') return;
    const target = list.find((s) => s.category === 'active' && s.hidden !== true) || firstOfCategory(list, 'active');
    if (!target) return;
    changeStatus('demand', demand, target.id, { auto: true });
    result.autoStartedDemand = demand.id;
    result.autoStartedFrom = demand.status;
  }

  function taskStatusEffects(task, tr, result, list, opts) {
    const inFlight = isInFlightCategory(tr.to.category);
    if (!isOpenCategory(tr.to.category)) {
      // Tarefa encerrada (concluída/cancelada): o cronômetro dela é finalizado — tempo não corre em tarefa fechada.
      const stopped = openTimers().filter((entry) => entry.task_id === task.id).map((entry) => stopEntry(entry));
      result.stoppedTimers.push(...stopped);
      if (stopped.length && !opts.silent) warnTimersStopped(result.warnings, stopped);
    }
    if (!opts.silent) {
      if (inFlight || tr.to.category === 'done') {
        const graph = buildGraph(store.all('tasks'), store.all('task_dependencies'));
        const open = blockingPrereqs(task.id, { graph, tasksById: TASKS, statuses: list, demandsById: DEMANDS });
        if (open.length) {
          const text = open.length === 1 ? `O pré-requisito ${listNames(open)} ainda está aberto.` : `Os pré-requisitos ${listNames(open)} ainda estão abertos.`;
          warn(result.warnings, 'open_prereqs', text, { taskId: task.id, ids: open.map((t) => t.id) });
        }
      }
      if (tr.completed) {
        const openSubs = subtasksOf(task.id).filter((sub) => isCountable(sub, list) && !isDone(sub, list));
        if (openSubs.length) {
          const text = `A tarefa foi concluída com ${plural(openSubs.length, 'subtarefa ainda aberta', 'subtarefas ainda abertas')}.`;
          warn(result.warnings, 'open_subtasks', text, { count: openSubs.length, ids: openSubs.map((t) => t.id) });
        }
        const parent = isSubtask(task) ? liveGet('tasks', task.parent_id) : null;
        if (parent && isOpen(parent, list)) {
          const siblings = subtasksOf(parent.id).filter((sub) => isCountable(sub, list));
          if (siblings.length && siblings.every((sub) => isDone(sub, list))) {
            warn(result.warnings, 'all_subtasks_done', `Todas as subtarefas de ${quoted(parent)} estão concluídas: a tarefa já pode ser concluída.`, { parentId: parent.id });
          }
        }
        const demand = demandOfTask(task);
        if (demand && isOpen(demand, list)) {
          const progress = demandProgress(demand, tasksOfDemand(demand.id), { statuses: list });
          if (progress.counted > 0 && progress.completed === progress.counted) {
            warn(result.warnings, 'demand_can_complete', `Todas as tarefas de ${quoted(demand)} estão concluídas: a demanda já pode ser concluída.`, { demandId: demand.id });
          }
        }
      }
      if (tr.reopened) {
        const demand = demandOfTask(task);
        if (demand && isDone(demand, list)) {
          warn(result.warnings, 'demand_is_done', `A demanda ${quoted(demand)} está concluída, mas esta tarefa foi reaberta.`, { demandId: demand.id });
        }
      }
    }
    if (inFlight && !isInFlightCategory(tr.from.category)) autoStartDemand(task, result, list);
    if (tr.completed && task.recurrence) {
      const next = createNextOccurrence(task);
      if (next) result.nextOccurrences.push(next);
    }
  }

  // --- tarefas recorrentes -------------------------------------------------------------------------
  /** Campos que a próxima ocorrência copia (dependências, apontamentos, links e "Cobrar em" NÃO vão junto). */
  const RECURRING_COPY_FIELDS = Object.freeze(['description', 'priority', 'estimate_minutes', 'owner', 'tags', 'weight', 'required']);

  /**
   * Tarefa recorrente concluída → cria a próxima ocorrência (com as subtarefas). O id é DERIVADO do id da
   * tarefa + novo prazo: dois aparelhos criam a mesma linha (o merge junta) e reabrir + concluir de novo não
   * duplica (linha viva já existente → nada é criado). Se a linha existe mas foi EXCLUÍDA (ex.: "Desfazer"),
   * ela é restaurada (deleted_at = null) com campos e datas recalculados — mesmo id, auditado como 'restored'
   * com meta.recurrence.
   * @returns {{ id: string, from: string, due_date: string, restored?: boolean }|null}
   */
  function createNextOccurrence(task) {
    const rule = carriedRecurrence(task.recurrence, { dueDate: task.due_date, completedDate: isoToDateStr(now) });
    if (!rule) return null;
    const ctx = { dueDate: task.due_date, completedDate: isoToDateStr(now) };
    // basis 'due': avança até a 1ª ocorrência >= hoje (tarefa atrasada não gera próxima já vencida).
    const dueDate = nextOccurrenceFrom(rule, { ...ctx, today: isoToDateStr(now) });
    if (!dueDate) return null;
    const id = derivedUuid(task.id, dueDate);
    const existing = store.get('tasks', id);
    if (existing && !existing.deleted_at) return null;
    const delta = diffDays(occurrenceBase(rule, ctx), dueDate);
    const shift = (date) => (isValidDateStr(date) ? addDays(date, delta) : null);
    const parent = isSubtask(task) ? liveGet('tasks', task.parent_id) : null;
    const demand = demandOfTask(task);
    const demandId = demand ? demand.id : null;
    const siblings = parent ? subtasksOf(parent.id) : topTasksOf(demandId);
    const values = {
        ...pick(task, RECURRING_COPY_FIELDS),
        id,
        name: task.name,
        demand_id: demandId,
        parent_id: parent ? parent.id : null,
        status: parent ? 'todo' : 'backlog',
        priority: task.priority || DEFAULT_PRIORITY,
        required: task.required === false ? false : true,
        tags: Array.isArray(task.tags) ? [...task.tags] : [],
        due_date: dueDate,
        planned_start: shift(task.planned_start),
        recurrence: rule,
        sort_order: orderValue('tasks', siblings, null, { afterId: task.id }),
    };
    const meta = { recurrence: { from: task.id } };
    const copy = existing ? restoreOccurrence(existing, values, { recurrence: { from: task.id, restored: true } }) : insertTask(values, meta);
    if (!parent) {
      for (const sub of subtasksOf(task.id).filter((s) => !s.archived_at).sort(bySortOrder)) {
        const subId = derivedUuid(copy.id, sub.id);
        const subRow = store.get('tasks', subId);
        if (subRow && !subRow.deleted_at) continue;
        (subRow ? (v) => restoreOccurrence(subRow, v, { recurrence: { from: sub.id, restored: true } }) : insertTask)({
          ...pick(sub, RECURRING_COPY_FIELDS),
          id: subId,
          name: sub.name,
          demand_id: demandId,
          parent_id: copy.id,
          status: 'todo',
          priority: sub.priority || DEFAULT_PRIORITY,
          required: sub.required === false ? false : true,
          tags: Array.isArray(sub.tags) ? [...sub.tags] : [],
          due_date: shift(sub.due_date),
          planned_start: shift(sub.planned_start),
          sort_order: finite(sub.sort_order),
        });
      }
    }
    return existing ? { id: copy.id, from: task.id, due_date: dueDate, restored: true } : { id: copy.id, from: task.id, due_date: dueDate };
  }

  /**
   * Restaura uma ocorrência derivada que estava excluída: grava os valores recalculados (só os que mudaram),
   * zera conclusão/arquivamento/"Cobrar em" e audita ('restored' + campos alterados) com `meta`.
   */
  function restoreOccurrence(row, values, meta) {
    const list = statuses();
    const category = categoryOf(list, values.status);
    const target = {
      ...values,
      archived_at: null,
      follow_up_date: null,
      completed_at: category === 'done' ? now : null,
      actual_start: isInFlightCategory(category) || category === 'done' ? row.actual_start || now : null,
      deleted_at: null,
    };
    delete target.id;
    const patch = {};
    for (const [key, value] of Object.entries(target)) {
      if (!sameValue(row[key], value)) patch[key] = value;
    }
    patch.deleted_at = null;
    const updated = store.update('tasks', row.id, patch);
    // A troca de status (ex.: a ocorrência fora concluída antes do "Desfazer") vira UM evento de status, como
    // em qualquer outra troca — o histórico e as métricas leem o status por esses eventos.
    const { status: _status, ...fields } = patch;
    auditDiff('task', row, fields, meta);
    if (patch.status !== undefined) {
      const tr = transitionPatch(row, patch.status, { statuses: list, nowIso: now });
      log(statusEvent('task', row, tr, { nowIso: now, deviceId: app.deviceId, auto: true }));
    }
    return updated;
  }

  function demandStatusEffects(demand, tr, result, list) {
    if (tr.completed) {
      const open = topTasksOf(demand.id).filter((task) => isCountable(task, list) && !isDone(task, list));
      if (open.length) {
        const text = `A demanda foi concluída com ${plural(open.length, 'tarefa ainda aberta', 'tarefas ainda abertas')}.`;
        warn(result.warnings, 'open_tasks', text, { count: open.length, ids: open.map((t) => t.id) });
      }
    }
    if (!isOpenCategory(tr.to.category)) {
      // As tarefas continuam abertas (o usuário decide), mas o cronômetro rodando nelas merece aviso.
      const taskIds = new Set(tasksOfDemand(demand.id).map((t) => t.id));
      const timers = openTimers().filter((entry) => taskIds.has(entry.task_id));
      if (timers.length) {
        const names = listNames([...new Set(timers.map((entry) => entry.task_id))].map((id) => store.get('tasks', id)));
        const text = timers.length === 1
          ? `O cronômetro de ${names} continua em aberto: encerre-o se o trabalho terminou.`
          : `Os cronômetros de ${names} continuam em aberto: encerre-os se o trabalho terminou.`;
        warn(result.warnings, 'running_timer', text, { entryIds: timers.map((e) => e.id), taskIds: [...new Set(timers.map((e) => e.task_id))] });
      }
    }
  }

  /** Aviso de cronômetros encerrados junto com a tarefa (concluída/cancelada). */
  function warnTimersStopped(list, stopped) {
    const taskIds = [...new Set(stopped.map((entry) => entry.task_id))];
    const names = listNames(taskIds.map((id) => store.get('tasks', id)));
    const seconds = stopped.reduce((sum, entry) => sum + finite(entry.duration_seconds), 0);
    const text = stopped.length === 1
      ? `O cronômetro de ${names} foi encerrado com a tarefa: ${formatDuration(seconds)} registrados.`
      : `Os cronômetros de ${names} foram encerrados com a tarefa: ${formatDuration(seconds)} registrados.`;
    warn(list, 'timer_stopped', text, { entryIds: stopped.map((e) => e.id), taskIds, seconds });
  }

  /**
   * Núcleo da troca de status (demanda ou tarefa). Grava status + completed_at juntos, registra UM evento
   * de status e devolve { entity, transition, warnings, autoStartedDemand, autoStartedFrom }.
   * opts: { reason, blocked_reason, waiting_on, auto (troca feita pelo sistema), silent (sem avisos) }.
   */
  function changeStatus(type, row, statusId, opts = {}) {
    const list = statuses();
    requireStatus(list, statusId);
    const table = ENTITY_TABLE[type];
    const tr = transitionPatch(row, statusId, { statuses: list, nowIso: now });
    const result = { entity: row, transition: tr, warnings: [], autoStartedDemand: null, autoStartedFrom: null, stoppedTimers: [], nextOccurrences: [] };
    const blockedReason = opts.blocked_reason === undefined ? undefined : textOrNull('blocked_reason', opts.blocked_reason);
    const waitingOn = opts.waiting_on === undefined ? undefined : textOrNull('waiting_on', opts.waiting_on);

    if (!tr.changed) {
      // Mesmo status: só o motivo do bloqueio / de quem se espera pode ser atualizado.
      const patch = {};
      if (tr.to.category === 'blocked' && blockedReason !== undefined && !sameValue(row.blocked_reason, blockedReason)) patch.blocked_reason = blockedReason;
      if (tr.to.category === 'waiting' && waitingOn !== undefined && !sameValue(row.waiting_on, waitingOn)) patch.waiting_on = waitingOn;
      if (Object.keys(patch).length) {
        result.entity = store.update(table, row.id, patch);
        auditDiff(type, row, patch);
      }
      return result;
    }

    const patch = { ...tr.patch };
    if (tr.to.category === 'blocked') {
      if (blockedReason !== undefined) patch.blocked_reason = blockedReason;
    } else if (tr.from.category === 'blocked' && row.blocked_reason) {
      patch.blocked_reason = null; // saiu do bloqueio: o motivo fica só no histórico
    }
    if (tr.to.category === 'waiting') {
      if (waitingOn !== undefined) patch.waiting_on = waitingOn;
    } else if (tr.from.category === 'waiting' && row.waiting_on) {
      patch.waiting_on = null;
    }
    // Concluída ou cancelada: não há mais o que cobrar — "Cobrar em" é limpo (auditado logo abaixo).
    const clearsFollowUp = (tr.to.category === 'done' || tr.to.category === 'cancelled') && !!row.follow_up_date;
    if (clearsFollowUp) patch.follow_up_date = null;
    if (type === 'demand' && opts.auto !== true && !isInFlightCategory(tr.to.category) && tr.to.category !== 'done' && undoesAutoStart(row, tr.to.id)) {
      patch.actual_start = null; // "Desfazer" do início automático: a demanda volta a não ter início real
    }

    let reason = typeof opts.reason === 'string' ? opts.reason : undefined;
    if (!reason || !reason.trim()) {
      if (tr.to.category === 'blocked') reason = patch.blocked_reason !== undefined ? patch.blocked_reason : row.blocked_reason;
      else if (tr.to.category === 'waiting') reason = patch.waiting_on !== undefined ? patch.waiting_on : row.waiting_on;
    }

    result.entity = store.update(table, row.id, patch);
    log(statusEvent(type, row, tr, { nowIso: now, deviceId: app.deviceId, reason: reason || undefined, auto: opts.auto === true }));
    if (clearsFollowUp) auditDiff(type, row, { follow_up_date: null }, { auto: true, cause: tr.to.category });
    if (type === 'task') taskStatusEffects(result.entity, tr, result, list, opts);
    else demandStatusEffects(result.entity, tr, result, list);
    return result;
  }

  // --- alteração de campos (demanda e tarefa) ------------------------------------------------------
  /** Aplica um patch já validado: campos comuns (com auditoria) e, por último, a troca de status. */
  function applyFields(type, row, clean, opts = {}) {
    const table = ENTITY_TABLE[type];
    const list = statuses();
    const fields = {};
    for (const key of Object.keys(clean)) {
      if (key === 'status' || key === 'demand_id' || key === 'parent_id') continue;
      if (!sameValue(row[key], clean[key])) fields[key] = clean[key];
    }
    const statusChanging = clean.status !== undefined && clean.status !== row.status;
    // Item concluído/cancelado não tem o que cobrar: "Cobrar em" só é aceito junto com uma reabertura
    // (concluir junto limpa a data na própria troca de status).
    if (fields.follow_up_date && !statusChanging) {
      const category = categoryOf(list, row.status);
      if (category === 'done' || category === 'cancelled') fail('invalid_status', 'Este item já foi concluído ou cancelado: não há o que cobrar.', { type, id: row.id, field: 'follow_up_date' });
    }
    const statusOpts = {};
    if (statusChanging) {
      // Motivo do bloqueio / de quem se espera informados junto com o status entram na própria transição.
      const category = categoryOf(list, clean.status);
      if (category === 'blocked' && 'blocked_reason' in fields) {
        statusOpts.blocked_reason = fields.blocked_reason;
        delete fields.blocked_reason;
      }
      if (category === 'waiting' && 'waiting_on' in fields) {
        statusOpts.waiting_on = fields.waiting_on;
        delete fields.waiting_on;
      }
    }
    let current = row;
    if (Object.keys(fields).length) {
      current = store.update(table, row.id, fields);
      auditDiff(type, row, fields, { reason: opts.reason, justification: opts.justification });
    }
    if (statusChanging) current = absorb(changeStatus(type, current, clean.status, statusOpts)).entity;
    return current;
  }

  // --- mover tarefa ------------------------------------------------------------------------------
  /** Reposiciona uma tarefa: troca de demanda e/ou de tarefa-pai e/ou de posição. Devolve a linha atual. */
  function relocate(task, target = {}) {
    const currentParent = isSubtask(task) ? store.get('tasks', task.parent_id) : null;
    const currentParentId = currentParent ? currentParent.id : null;
    const currentDemandId = hasId(currentParent ? currentParent.demand_id : task.demand_id) ? (currentParent ? currentParent.demand_id : task.demand_id) : null;
    let parentId = currentParentId;
    let demandId = currentDemandId;

    const wantsDemand = target.demand_id !== undefined;
    const targetDemandId = wantsDemand ? (hasId(target.demand_id) ? target.demand_id : null) : undefined;
    if (wantsDemand && targetDemandId && !liveGet('demands', targetDemandId)) fail('demand_not_found', NOT_FOUND.demand, { id: targetDemandId });

    if (target.parent_id !== undefined && hasId(target.parent_id)) {
      const parent = liveGet('tasks', target.parent_id);
      if (!parent) fail('invalid_parent', 'Tarefa principal não encontrada: ela pode ter sido excluída.', { id: target.parent_id });
      if (parent.id === task.id) fail('invalid_parent', 'Uma tarefa não pode ser subtarefa dela mesma.', { id: parent.id });
      if (isSubtask(parent)) fail('invalid_parent', 'Uma subtarefa não pode ter subtarefas: escolha uma tarefa principal.', { id: parent.id });
      if (parent.id !== currentParentId) {
        if (subtasksOf(task.id).length) fail('invalid_parent', 'Uma tarefa que tem subtarefas não pode virar subtarefa.', { id: task.id });
        const deps = store.all('task_dependencies');
        if (dependencyRows(deps, task.id, parent.id).length || dependencyRows(deps, parent.id, task.id).length) {
          fail('invalid_parent', `${quoted(task)} e ${quoted(parent)} têm uma dependência entre si: remova-a antes de transformar uma em subtarefa da outra.`, { id: parent.id });
        }
        // Virar subtarefa cria a dependência implícita "principal depende da subtarefa": recusa se fechar um laço.
        const loop = wouldCreateCycle(buildGraph(store.all('tasks'), deps), parent.id, task.id);
        if (loop.cycle) {
          const names = loop.path.map((id) => quoted(store.get('tasks', id)));
          fail('cycle', `Dependência circular: ${names.join(' → ')}. Remova uma das dependências antes de transformar ${quoted(task)} em subtarefa de ${quoted(parent)}.`, { id: parent.id, path: loop.path });
        }
      }
      parentId = parent.id;
      demandId = hasId(parent.demand_id) ? parent.demand_id : null;
    } else if (target.parent_id !== undefined) {
      parentId = null;
      if (wantsDemand) demandId = targetDemandId;
    } else if (wantsDemand && targetDemandId !== currentDemandId) {
      // Trocar a demanda de uma subtarefa a solta do pai: ela vira tarefa de nível superior na demanda nova.
      parentId = null;
      demandId = targetDemandId;
    }

    const patch = {};
    if (parentId !== (hasId(task.parent_id) ? task.parent_id : null)) patch.parent_id = parentId;
    if (demandId !== (hasId(task.demand_id) ? task.demand_id : null)) patch.demand_id = demandId;
    const containerChanged = parentId !== currentParentId || demandId !== currentDemandId;

    const siblings = parentId ? subtasksOf(parentId) : topTasksOf(demandId);
    let order = orderValue('tasks', siblings, task, target);
    if (order === null && containerChanged) order = nextSortOrder(siblings.filter((s) => s.id !== task.id));
    if (order !== null && order !== task.sort_order) patch.sort_order = order;

    if (!Object.keys(patch).length) return task;
    const moved = store.update('tasks', task.id, patch);
    auditDiff('task', task, patch);
    if ('demand_id' in patch) {
      // As subtarefas acompanham a tarefa na troca de demanda.
      for (const sub of subtasksOf(task.id)) {
        if (sameValue(sub.demand_id, demandId)) continue;
        store.update('tasks', sub.id, { demand_id: demandId });
        auditDiff('task', sub, { demand_id: demandId }, { with_parent: true });
      }
    }
    return moved;
  }

  // --- criação -----------------------------------------------------------------------------------
  function insertDemand(values, extra) {
    const list = statuses();
    const category = categoryOf(list, values.status);
    const started = isInFlightCategory(category) || category === 'done';
    const row = store.insert('demands', {
      ...values,
      follow_up_date: category === 'done' || category === 'cancelled' ? null : values.follow_up_date || null,
      seq: nextSeq('demands'),
      actual_start: values.actual_start || (started ? now : null),
      completed_at: category === 'done' ? now : null,
      created_at: now,
      updated_at: now,
    });
    log(createdEvent('demand', row, { nowIso: now, deviceId: app.deviceId, statuses: list, extra }));
    return row;
  }

  function insertTask(values, extra) {
    const list = statuses();
    const category = categoryOf(list, values.status);
    const started = isInFlightCategory(category) || category === 'done';
    const row = store.insert('tasks', {
      ...values,
      follow_up_date: category === 'done' || category === 'cancelled' ? null : values.follow_up_date || null,
      seq: nextSeq('tasks'),
      actual_start: values.actual_start || (started ? now : null),
      completed_at: category === 'done' ? now : null,
      created_at: now,
      updated_at: now,
    });
    log(createdEvent('task', row, { nowIso: now, deviceId: app.deviceId, statuses: list, extra }));
    return row;
  }

  function pick(row, fields) {
    const out = {};
    for (const field of fields) out[field] = Array.isArray(row[field]) ? [...row[field]] : row[field] === undefined ? null : row[field];
    return out;
  }

  /** Copia tarefas (e as dependências ENTRE elas) para outra demanda/pai. `map`: id original → id da cópia. */
  function copyDependencies(map) {
    const seen = new Set();
    for (const dep of store.all('task_dependencies')) {
      const taskId = map.get(dep.task_id);
      const prereqId = map.get(dep.depends_on_id);
      if (!taskId || !prereqId || taskId === prereqId) continue;
      const key = `${taskId}|${prereqId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      store.insert('task_dependencies', { task_id: taskId, depends_on_id: prereqId, created_at: now, updated_at: now });
      const prereq = store.get('tasks', prereqId);
      event('task', taskId, ACTIONS.DEP_ADDED, { newValue: prereqId, meta: { name: prereq ? prereq.name : null } });
    }
  }

  // --- modelos ----------------------------------------------------------------------------------
  /** Modelos salvos ativos (configurações `template:<id>` com valor ≠ null). */
  function savedTemplates() {
    return templatesFromSettings(store.all('settings'));
  }

  function templateById(id) {
    const template = availableTemplates(savedTemplates()).find((t) => t.id === id);
    if (!template) fail('template_not_found', 'Modelo não encontrado: ele pode ter sido excluído.', { id });
    return template;
  }

  function editableTemplate(id) {
    if (isBuiltinTemplate(id)) fail('template_builtin', 'O modelo embutido não pode ser alterado.', { id });
    const template = savedTemplates().find((t) => t.id === id);
    if (!template) fail('template_not_found', 'Modelo não encontrado: ele pode ter sido excluído.', { id });
    return template;
  }

  // --- exclusão / restauração --------------------------------------------------------------------
  function markDeleted(type, row) {
    const updated = store.update(ENTITY_TABLE[type], row.id, { deleted_at: now });
    auditDiff(type, row, { deleted_at: now });
    return updated;
  }

  function markRestored(type, row) {
    const updated = store.update(ENTITY_TABLE[type], row.id, { deleted_at: null });
    auditDiff(type, row, { deleted_at: null });
    return updated;
  }

  /**
   * Restaurar tarefas traz de volta as dependências delas. Se, enquanto estavam excluídas, alguém criou
   * dependências que agora fechariam um ciclo, desfaz o ciclo removendo (e auditando) a aresta do ciclo que
   * envolve uma tarefa restaurada — a dependência mais antiga criada por quem não estava excluído prevalece.
   * @param {Set<string>} restoredIds ids das tarefas restauradas nesta operação
   */
  function breakCyclesAfterRestore(restoredIds) {
    for (let guard = 0; guard < 50; guard++) {
      const cycles = findCycles(buildGraph(store.all('tasks'), store.all('task_dependencies')));
      if (!cycles.length) return;
      const path = cycles[0];
      const allDeps = store.all('task_dependencies');
      // Só arestas explícitas podem ser removidas: o passo "principal → subtarefa" do laço é a hierarquia.
      const pairs = [];
      for (let i = 0; i < path.length - 1; i++) {
        if (dependencyRows(allDeps, path[i], path[i + 1]).length) pairs.push([path[i], path[i + 1]]);
      }
      if (!pairs.length) return;
      // A aresta que envolve uma tarefa restaurada; senão (ciclo pré-existente, dados danificados) a primeira.
      const pair = pairs.find(([a, b]) => restoredIds.has(a) || restoredIds.has(b)) || pairs[0];
      const [taskId, dependsOnId] = pair;
      const rows = dependencyRows(allDeps, taskId, dependsOnId);
      for (const dep of rows) store.update('task_dependencies', dep.id, { deleted_at: now });
      const prereq = store.get('tasks', dependsOnId);
      event('task', taskId, ACTIONS.DEP_REMOVED, {
        oldValue: dependsOnId,
        meta: { name: prereq ? prereq.name : null, reason: 'Removida ao restaurar: fecharia uma dependência circular', auto: true },
      });
    }
  }

  // --- semana ------------------------------------------------------------------------------------
  function weekOf(value) {
    if (value === undefined || value === null || value === '') return startOfWeek(app.clock.today());
    if (!isValidDateStr(value)) fail('invalid_week', 'Semana inválida: informe uma data no formato AAAA-MM-DD.', { week: value });
    return startOfWeek(value);
  }

  function addToWeekCore(task, week, kind) {
    const existing = allWeekItems(store.all('week_items'), week).find((item) => item.task_id === task.id) || null;
    if (existing && !existing.removed_at) return existing;
    const effectiveKind = kind || kindForNewItem(week, now);
    let item;
    if (existing) item = store.update('week_items', existing.id, { removed_at: null, kind: effectiveKind, added_at: now, carried_to_week: null });
    else item = store.insert('week_items', { week_start: week, task_id: task.id, kind: effectiveKind, added_at: now, created_at: now, updated_at: now });
    event('task', task.id, ACTIONS.WEEK_ADDED, { newValue: week, meta: { kind: effectiveKind } });
    return item;
  }

  /** Retira do plano TODOS os itens vigentes da tarefa naquela semana (duplicados de outro aparelho inclusive). */
  function removeFromWeekCore(taskId, week, toWeek = null) {
    const end = addDays(week, 6);
    let removed = null;
    for (const item of store.byIndex('week_items', 'task_id', taskId)) {
      if (item.removed_at || typeof item.week_start !== 'string' || item.week_start < week || item.week_start > end) continue;
      removed = store.update('week_items', item.id, { removed_at: now });
    }
    // Replanejamento (moveWeekItem): a saída registra a semana de destino ("Movida para a semana de …").
    if (removed) event('task', taskId, ACTIONS.WEEK_REMOVED, toWeek ? { newValue: week, meta: { to_week: toWeek } } : { newValue: week });
    return removed;
  }

  // ---------------------------------------------------------------------------
  // Comandos
  // ---------------------------------------------------------------------------
  const cmd = {
    /**
     * Desfecho do último comando concluído: avisos (que nunca impedem a operação) e a automação aplicada.
     * Útil para os comandos que devolvem só a linha (createTask, updateTask, moveTask…).
     * @returns {{ command: string|null, warnings: ReadonlyArray<{code: string, message: string, data: object}>,
     *             autoStartedDemand: string|null, autoStartedFrom: string|null }}
     */
    lastOutcome: () => last,

    // ----- projetos -------------------------------------------------------------------------------
    /**
     * Cria um projeto.
     * @param {{ name: string, code?: string, color?: string, description?: string }} values
     * @returns {object} projeto criado
     * @throws {CommandError} invalid_name | invalid_field
     */
    createProject: define('createProject', (values = {}) => {
      const clean = cleanInput('project', values, 'createProject');
      if (clean.name === undefined) fail('invalid_name', 'Informe o nome do projeto.', { field: 'name' });
      const row = store.insert('projects', {
        name: clean.name,
        code: clean.code === undefined ? null : clean.code,
        color: clean.color || 'blue',
        description: clean.description === undefined ? null : clean.description,
        sort_order: clean.sort_order === undefined ? nextSortOrder(store.all('projects')) : clean.sort_order,
        created_at: now,
        updated_at: now,
      });
      log(createdEvent('project', row, { nowIso: now, deviceId: app.deviceId }));
      return row;
    }),

    /**
     * Altera um projeto. Chaves cujo valor não mudou são descartadas (nada é carimbado nem auditado à toa).
     * @param {string} id
     * @param {{ name?: string, code?: string|null, color?: string, description?: string|null, sort_order?: number }} patch
     * @returns {object} projeto atualizado
     */
    updateProject: define('updateProject', (id, patch) => {
      const row = requireRow('project', id);
      const clean = cleanInput('project', patch, 'updateProject');
      const fields = {};
      for (const key of Object.keys(clean)) if (!sameValue(row[key], clean[key])) fields[key] = clean[key];
      if (!Object.keys(fields).length) return row;
      const updated = store.update('projects', id, fields);
      auditDiff('project', row, fields);
      return updated;
    }),

    /**
     * Arquiva (ou desarquiva) um projeto. As demandas e tarefas dele passam a contar como arquivadas.
     * @param {string} id
     * @param {boolean} [archived=true]
     * @returns {object} projeto
     */
    archiveProject: define('archiveProject', (id, archived = true) => {
      const row = requireRow('project', id);
      if (!!row.archived_at === !!archived) return row;
      const patch = { archived_at: archived ? now : null };
      const updated = store.update('projects', id, patch);
      auditDiff('project', row, patch);
      return updated;
    }),

    /**
     * Exclui (exclusão lógica) um projeto. As demandas dele CONTINUAM existindo, agora sem projeto
     * (cada uma com um evento 'moved' no histórico).
     * @param {string} id
     * @returns {object} projeto excluído
     */
    deleteProject: define('deleteProject', (id) => {
      const row = requireRow('project', id);
      const moved = [];
      for (const demand of [...store.byIndex('demands', 'project_id', id)]) {
        store.update('demands', demand.id, { project_id: null });
        auditDiff('demand', demand, { project_id: null });
        moved.push(demand.id);
      }
      // O evento 'deleted' guarda quais demandas saíram: é o que restoreProject devolve ao projeto.
      const updated = store.update('projects', id, { deleted_at: now });
      auditDiff('project', row, { deleted_at: now }, moved.length ? { demand_ids: moved } : undefined);
      return updated;
    }),

    /**
     * Restaura um projeto excluído e devolve a ele as demandas que a exclusão deixou sem projeto (as ids ficam
     * em meta.demand_ids do evento 'deleted'; exclusões antigas, sem essa meta, usam os eventos 'moved' do mesmo
     * instante). Demanda que nesse meio-tempo foi para outro projeto, ou foi excluída, fica como está.
     * @param {string} id
     * @returns {object} projeto restaurado
     */
    restoreProject: define('restoreProject', (id) => {
      const row = hasId(id) ? store.get('projects', id) : null;
      if (!row) fail('not_found', NOT_FOUND.project, { type: 'project', id });
      if (!row.deleted_at) return row;
      const instant = row.deleted_at;
      const deletions = store.byIndex('activity_log', 'entity_id', id).filter((e) => e.entity_type === 'project' && e.action === ACTIONS.DELETED && e.at === instant);
      const recorded = deletions.map((e) => (e.meta && Array.isArray(e.meta.demand_ids) ? e.meta.demand_ids : null)).find(Boolean);
      let demandIds = recorded;
      if (!demandIds) {
        demandIds = store
          .all('activity_log')
          .filter((e) => e.entity_type === 'demand' && e.action === ACTIONS.MOVED && e.field === 'project_id' && e.old_value === id && !hasId(e.new_value) && e.at === instant)
          .map((e) => e.entity_id);
      }
      const restored = markRestored('project', row);
      for (const demandId of new Set(demandIds)) {
        const demand = liveGet('demands', demandId);
        if (!demand || hasId(demand.project_id)) continue;
        store.update('demands', demandId, { project_id: id });
        auditDiff('demand', demand, { project_id: id });
      }
      return restored;
    }),

    // ----- demandas -------------------------------------------------------------------------------
    /**
     * Cria uma demanda. Padrões: status 'backlog', prioridade 'P3', responsável = configuração 'owner.default'.
     * @param {object} values { name, description, project_id, status, priority, planned_start, due_date,
     *        estimate_minutes, owner, tags, blocked_reason, waiting_on, objective, deliverables, next_action, category }
     * @returns {object} demanda criada (com `seq` provisório)
     */
    createDemand: define('createDemand', (values = {}) => {
      const clean = cleanInput('demand', values, 'createDemand');
      if (clean.name === undefined) fail('invalid_name', 'Informe o nome da demanda.', { field: 'name' });
      const defaultOwner = app.settings.get('owner.default');
      return insertDemand({
        tags: [],
        ...clean,
        status: clean.status || 'backlog',
        priority: clean.priority || DEFAULT_PRIORITY,
        owner: clean.owner !== undefined ? clean.owner : typeof defaultOwner === 'string' && defaultOwner.trim() ? defaultOwner.trim() : null,
        sort_order: clean.sort_order === undefined ? nextSortOrder(store.all('demands')) : clean.sort_order,
      });
    }),

    /**
     * Altera uma demanda. O patch aceita qualquer campo editável; `status` passa pela lógica de transição.
     * @param {string} id
     * @param {object} patch
     * @param {{ reason?: string, justification?: string }} [options] reason → evento de prazo; justification → evento de prioridade
     * @returns {object} demanda atualizada (avisos da troca de status em `cmd.lastOutcome()`)
     */
    updateDemand: define('updateDemand', (id, patch, options = {}) => {
      const row = requireRow('demand', id);
      return applyFields('demand', row, cleanInput('demand', patch, 'updateDemand'), options || {});
    }),

    /**
     * Duplica uma demanda: nome + ' (cópia)', status 'backlog', sem datas reais/arquivamento/bloqueio.
     * Com `withTasks`, copia as tarefas e subtarefas não arquivadas (status 'todo', mesma ordem, estimativas,
     * pesos, tags, obrigatoriedade) e as dependências ENTRE as tarefas copiadas. Apontamentos, observações e
     * histórico não são copiados; os eventos 'created' levam meta.duplicated_from.
     * @param {string} id
     * @param {{ withTasks?: boolean }} [options]
     * @returns {object} a nova demanda
     */
    duplicateDemand: define('duplicateDemand', (id, options) => {
      const { withTasks = true } = options || {};
      const original = requireRow('demand', id);
      const project = liveGet('projects', original.project_id);
      const copy = insertDemand(
        {
          ...pick(original, DEMAND_COPY_FIELDS),
          project_id: project ? project.id : null,
          name: `${original.name}${COPY_SUFFIX}`,
          status: 'backlog',
          sort_order: orderValue('demands', store.all('demands'), null, { afterId: original.id }),
        },
        { duplicated_from: original.id },
      );
      if (!withTasks) return copy;

      const map = new Map();
      const tops = topTasksOf(original.id).filter((task) => !task.archived_at).sort(bySortOrder);
      for (const task of tops) {
        const top = insertTask({ ...pick(task, TASK_COPY_FIELDS), name: task.name, demand_id: copy.id, parent_id: null, status: 'todo', sort_order: finite(task.sort_order) }, { duplicated_from: task.id });
        map.set(task.id, top.id);
        for (const sub of subtasksOf(task.id).filter((s) => !s.archived_at).sort(bySortOrder)) {
          const child = insertTask({ ...pick(sub, TASK_COPY_FIELDS), name: sub.name, demand_id: copy.id, parent_id: top.id, status: 'todo', sort_order: finite(sub.sort_order) }, { duplicated_from: sub.id });
          map.set(sub.id, child.id);
        }
      }
      copyDependencies(map);
      return copy;
    }),

    // ----- modelos de demanda ---------------------------------------------------------------------
    /**
     * Cria uma demanda a partir de um modelo (embutido ou salvo em `template:<id>`), com tarefas, subtarefas e
     * dependências. Responsável = 'owner.default'. Com `startDate`, as tarefas recebem início/prazo em dias úteis
     * (planTemplate) e a demanda começa em startDate e vence no fim da última tarefa. O evento 'created' da
     * demanda leva meta.template = { id, name }.
     * @param {string} templateId
     * @param {{ name?: string, project_id?: string|null, startDate?: string|null, priority?: string }} [options]
     * @returns {object} a nova demanda
     * @throws {CommandError} template_not_found | invalid_name | invalid_date | project_not_found | invalid_priority
     */
    createDemandFromTemplate: define('createDemandFromTemplate', (templateId, options) => {
      const opts = options || {};
      const template = templateById(templateId);
      const startDate = dateOrNull('planned_start', opts.startDate);
      const plan = planTemplate(template, { startDate });
      const blank = opts.name === undefined || opts.name === null || (typeof opts.name === 'string' && !opts.name.trim());
      const clean = cleanInput(
        'demand',
        { name: blank ? template.name : opts.name, project_id: opts.project_id, priority: opts.priority, planned_start: startDate ? plan.start : null, due_date: plan.end },
        'createDemandFromTemplate',
      );
      const defaultOwner = app.settings.get('owner.default');
      const meta = { template: { id: template.id, name: template.name } };
      const demand = insertDemand(
        {
          tags: [],
          ...clean,
          status: 'backlog',
          priority: clean.priority || DEFAULT_PRIORITY,
          owner: typeof defaultOwner === 'string' && defaultOwner.trim() ? defaultOwner.trim() : null,
          sort_order: nextSortOrder(store.all('demands')),
        },
        meta,
      );
      const ids = new Map();
      const base = { tags: [], demand_id: demand.id, status: 'todo', priority: demand.priority, required: true };
      plan.tasks.forEach((task, i) => {
        const top = insertTask(
          {
            ...base,
            name: task.name,
            parent_id: null,
            planned_start: task.planned_start,
            due_date: task.due_date,
            estimate_minutes: task.estimate_minutes === undefined ? null : task.estimate_minutes,
            sort_order: (i + 1) * ORDER_STEP,
          },
          meta,
        );
        ids.set(task.key, top.id);
        task.subtasks.forEach((sub, j) => insertTask({ ...base, name: sub.name, parent_id: top.id, sort_order: (j + 1) * ORDER_STEP }, meta));
      });
      for (const task of plan.tasks) {
        for (const dep of task.dependsOn) {
          store.insert('task_dependencies', { task_id: ids.get(task.key), depends_on_id: ids.get(dep), created_at: now, updated_at: now });
          const prereq = plan.tasks.find((t) => t.key === dep);
          event('task', ids.get(task.key), ACTIONS.DEP_ADDED, { newValue: ids.get(dep), meta: { name: prereq.name } });
        }
      }
      return demand;
    }),

    /**
     * Salva uma demanda como modelo (configuração própria `template:<id>`): tarefas de nível superior não
     * arquivadas (com os nomes das subtarefas), deslocamentos em dias úteis a partir do menor início planejado
     * (sem início = 0), durações, estimativas e só as dependências entre as tarefas copiadas.
     * @param {string} demandId
     * @param {{ name?: string, description?: string }} [options]
     * @returns {object} o modelo salvo
     * @throws {CommandError} not_found | too_many_templates | too_many_tasks | invalid_template
     */
    saveDemandAsTemplate: define('saveDemandAsTemplate', (demandId, options) => {
      const opts = options || {};
      const demand = requireRow('demand', demandId);
      const tops = topTasksOf(demand.id).filter((t) => !t.archived_at).sort(bySortOrder);
      const starts = tops.map((t) => t.planned_start).filter((d) => isValidDateStr(d)).sort();
      const origin = starts.length ? addWorkdays(starts[0], 0) : null;
      const keys = new Map();
      const tasks = tops.map((task, i) => {
        const key = `t${i + 1}`;
        keys.set(task.id, key);
        const start = isValidDateStr(task.planned_start) ? addWorkdays(task.planned_start, 0) : null;
        const out = {
          key,
          name: task.name,
          offsetDays: origin && start ? Math.max(0, countWorkdays(origin, start) - 1) : 0,
          durationDays: start && isValidDateStr(task.due_date) && task.due_date >= start ? Math.max(1, countWorkdays(start, task.due_date)) : 1,
          subtasks: subtasksOf(task.id)
            .filter((s) => !s.archived_at)
            .sort(bySortOrder)
            .map((s) => ({ name: s.name })),
          dependsOn: [],
        };
        if (Number.isInteger(task.estimate_minutes)) out.estimate_minutes = task.estimate_minutes;
        return out;
      });
      const byKey = new Map(tasks.map((t) => [t.key, t]));
      for (const dep of store.all('task_dependencies')) {
        const from = keys.get(dep.task_id);
        const to = keys.get(dep.depends_on_id);
        if (!from || !to || from === to) continue;
        const list = byKey.get(from).dependsOn;
        if (!list.includes(to)) list.push(to);
      }
      const count = savedTemplates().length;
      if (count >= MAX_TEMPLATES) fail('too_many_templates', `É possível guardar no máximo ${MAX_TEMPLATES} modelos. Exclua algum em Configurações.`, { count });
      const name = typeof opts.name === 'string' && opts.name.trim() ? opts.name : demand.name;
      const description = typeof opts.description === 'string' ? opts.description : demand.description ? excerptOf(demand.description) : null;
      const template = normalizeTemplate({ id: uuid(), name, description, tasks });
      cmd.setSetting(templateSettingKey(template.id), template);
      return template;
    }),

    /**
     * Renomeia um modelo salvo (o embutido é somente leitura).
     * @param {string} templateId
     * @param {string} name
     * @returns {object} modelo atualizado
     * @throws {CommandError} template_builtin | template_not_found | invalid_template
     */
    renameTemplate: define('renameTemplate', (templateId, name) => {
      const updated = normalizeTemplate({ ...editableTemplate(templateId), name });
      cmd.setSetting(templateSettingKey(updated.id), updated);
      return updated;
    }),

    /**
     * Exclui um modelo salvo (o embutido é somente leitura).
     * @param {string} templateId
     * @returns {object} o modelo excluído
     * @throws {CommandError} template_builtin | template_not_found
     */
    deleteTemplate: define('deleteTemplate', (templateId) => {
      const template = editableTemplate(templateId);
      cmd.setSetting(templateSettingKey(template.id), null);
      return template;
    }),

    /**
     * Arquiva (ou desarquiva) uma demanda. As tarefas dela passam a contar como arquivadas; ao arquivar, os
     * cronômetros em aberto dessas tarefas são encerrados.
     * @param {string} id
     * @param {boolean} [archived=true]
     * @returns {object} demanda
     */
    archiveDemand: define('archiveDemand', (id, archived = true) => {
      const row = requireRow('demand', id);
      if (!!row.archived_at === !!archived) return row;
      const patch = { archived_at: archived ? now : null };
      const updated = store.update('demands', id, patch);
      auditDiff('demand', row, patch);
      if (archived) stopTimersOf(new Set(tasksOfDemand(id).map((t) => t.id)));
      return updated;
    }),

    /**
     * Exclui (exclusão lógica) uma demanda E as suas tarefas/subtarefas, todas com o MESMO instante em
     * deleted_at (é assim que restoreDemand sabe o que trazer de volta). Cronômetros em aberto são encerrados.
     * @param {string} id
     * @returns {object} demanda excluída
     */
    deleteDemand: define('deleteDemand', (id) => {
      const row = requireRow('demand', id);
      const tasks = tasksOfDemand(id);
      stopTimersOf(new Set(tasks.map((t) => t.id)));
      for (const task of tasks) markDeleted('task', task);
      return markDeleted('demand', row);
    }),

    /**
     * Restaura uma demanda excluída e as tarefas excluídas no mesmo instante que ela. Se o projeto dela foi
     * excluído nesse meio-tempo, a demanda volta sem projeto.
     * @param {string} id
     * @returns {object} demanda restaurada
     */
    restoreDemand: define('restoreDemand', (id) => {
      const row = store.get('demands', id);
      if (!row) fail('not_found', NOT_FOUND.demand, { type: 'demand', id });
      if (!row.deleted_at) return row;
      const instant = row.deleted_at;
      let restored = markRestored('demand', row);
      if (hasId(row.project_id) && !liveGet('projects', row.project_id)) {
        const before = restored;
        restored = store.update('demands', id, { project_id: null });
        auditDiff('demand', before, { project_id: null });
      }
      const back = new Set();
      for (const task of store.all('tasks', { includeDeleted: true })) {
        if (task.deleted_at !== instant) continue;
        const parent = hasId(task.parent_id) ? store.get('tasks', task.parent_id) : null;
        if (task.demand_id === id || (parent && parent.demand_id === id)) {
          markRestored('task', task);
          back.add(task.id);
        }
      }
      if (back.size) breakCyclesAfterRestore(back);
      return restored;
    }),

    /**
     * Reordena uma demanda na ordem manual (não é auditado).
     * @param {string} id
     * @param {{ beforeId?: string, afterId?: string }} [position] sem referência: vai para o fim
     * @returns {object} demanda
     */
    reorderDemand: define('reorderDemand', (id, position = {}) => {
      const row = requireRow('demand', id);
      const siblings = store.all('demands');
      let order = orderValue('demands', siblings, row, position || {});
      if (order === null) order = nextSortOrder(siblings.filter((d) => d.id !== id));
      return order === row.sort_order ? row : store.update('demands', id, { sort_order: order });
    }),

    // ----- tarefas --------------------------------------------------------------------------------
    /**
     * Cria uma tarefa ou subtarefa.
     *   • `demand_id` (precisa existir) e/ou `parent_id` (precisa existir, não estar excluída e ser de nível
     *     superior — senão 'invalid_parent'); a subtarefa herda a demanda do pai;
     *   • status padrão: 'backlog' (tarefa) / 'todo' (subtarefa); prioridade padrão 'P3';
     *   • criada já "em execução", aplica a automação de iniciar a demanda; criada aberta numa demanda
     *     concluída, gera o aviso 'demand_is_done' (ver `cmd.lastOutcome()`).
     * @param {object} values { name, demand_id, parent_id, description, status, priority, planned_start, due_date,
     *        estimate_minutes, owner, tags, blocked_reason, waiting_on, weight, required }
     * @param {{ beforeId?: string, afterId?: string }} [position] posição entre os irmãos (padrão: no fim)
     * @returns {object} tarefa criada (com `seq` provisório)
     */
    createTask: define('createTask', (values = {}, position = {}) => {
      const clean = cleanInput('task', values, 'createTask');
      if (clean.name === undefined) fail('invalid_name', 'Informe o nome da tarefa.', { field: 'name' });
      let parent = null;
      let demandId = hasId(clean.demand_id) ? clean.demand_id : null;
      if (hasId(clean.parent_id)) {
        parent = liveGet('tasks', clean.parent_id);
        if (!parent) fail('invalid_parent', 'Tarefa principal não encontrada: ela pode ter sido excluída.', { id: clean.parent_id });
        if (isSubtask(parent)) fail('invalid_parent', 'Uma subtarefa não pode ter subtarefas: escolha uma tarefa principal.', { id: parent.id });
        demandId = hasId(parent.demand_id) ? parent.demand_id : null;
      }
      const list = statuses();
      const siblings = parent ? subtasksOf(parent.id) : topTasksOf(demandId);
      let order = clean.sort_order === undefined ? orderValue('tasks', siblings, null, position || {}) : clean.sort_order;
      if (order === null) order = nextSortOrder(siblings);
      const task = insertTask({
        tags: [],
        ...clean,
        demand_id: demandId,
        parent_id: parent ? parent.id : null,
        status: clean.status || (parent ? 'todo' : 'backlog'),
        priority: clean.priority || DEFAULT_PRIORITY,
        required: clean.required === undefined ? true : clean.required,
        sort_order: order,
      });
      const category = categoryOf(list, task.status);
      const demand = liveGet('demands', demandId);
      if (demand && isDone(demand, list) && isOpenCategory(category)) {
        warn(outcome.warnings, 'demand_is_done', `A demanda ${quoted(demand)} está concluída, mas recebeu uma tarefa nova.`, { demandId: demand.id });
      }
      if (isInFlightCategory(category)) autoStartDemand(task, outcome, list);
      return task;
    }),

    /**
     * Altera uma tarefa. O patch aceita qualquer campo editável; `status` passa pela lógica de transição e
     * `demand_id` / `parent_id` pelas regras de moveTask.
     * @param {string} id
     * @param {object} patch
     * @param {{ reason?: string, justification?: string }} [options] reason → evento de prazo; justification → evento de prioridade
     * @returns {object} tarefa atualizada (avisos da troca de status em `cmd.lastOutcome()`)
     */
    updateTask: define('updateTask', (id, patch, options = {}) => {
      let task = requireRow('task', id);
      const clean = cleanInput('task', patch, 'updateTask');
      if (clean.demand_id !== undefined || clean.parent_id !== undefined) {
        const target = {};
        if ('demand_id' in clean) target.demand_id = clean.demand_id;
        if ('parent_id' in clean) target.parent_id = clean.parent_id;
        task = relocate(task, target);
      }
      return applyFields('task', task, clean, options || {});
    }),

    /**
     * Duplica uma tarefa (com as subtarefas não arquivadas): a cópia fica logo depois da original, com
     * nome + ' (cópia)' e status 'todo'. Dependências entre as tarefas copiadas são mantidas.
     * @param {string} id
     * @returns {object} a nova tarefa
     */
    duplicateTask: define('duplicateTask', (id) => {
      const original = requireRow('task', id);
      const parent = isSubtask(original) ? liveGet('tasks', original.parent_id) : null;
      const demand = demandOfTask(original);
      const demandId = demand ? demand.id : null;
      const siblings = parent ? subtasksOf(parent.id) : topTasksOf(demandId);
      const map = new Map();
      const copy = insertTask(
        {
          ...pick(original, TASK_COPY_FIELDS),
          name: `${original.name}${COPY_SUFFIX}`,
          demand_id: demandId,
          parent_id: parent ? parent.id : null,
          status: 'todo',
          sort_order: orderValue('tasks', siblings, null, { afterId: original.id }),
        },
        { duplicated_from: original.id },
      );
      map.set(original.id, copy.id);
      for (const sub of subtasksOf(original.id).filter((s) => !s.archived_at).sort(bySortOrder)) {
        const child = insertTask({ ...pick(sub, TASK_COPY_FIELDS), name: sub.name, demand_id: demandId, parent_id: copy.id, status: 'todo', sort_order: finite(sub.sort_order) }, { duplicated_from: sub.id });
        map.set(sub.id, child.id);
      }
      copyDependencies(map);
      return copy;
    }),

    /**
     * Arquiva (ou desarquiva) uma tarefa; as subtarefas herdam. Ao arquivar, os cronômetros em aberto são encerrados.
     * @param {string} id
     * @param {boolean} [archived=true]
     * @returns {object} tarefa
     */
    archiveTask: define('archiveTask', (id, archived = true) => {
      const row = requireRow('task', id);
      if (!!row.archived_at === !!archived) return row;
      const patch = { archived_at: archived ? now : null };
      const updated = store.update('tasks', id, patch);
      auditDiff('task', row, patch);
      if (archived) stopTimersOf(new Set([id, ...subtasksOf(id).map((t) => t.id)]));
      return updated;
    }),

    /**
     * Exclui (exclusão lógica) uma tarefa e as suas subtarefas, com o mesmo instante. Cronômetros em aberto
     * são encerrados.
     * @param {string} id
     * @returns {object} tarefa excluída
     */
    deleteTask: define('deleteTask', (id) => {
      const row = requireRow('task', id);
      const subs = subtasksOf(id);
      stopTimersOf(new Set([id, ...subs.map((t) => t.id)]));
      for (const sub of subs) markDeleted('task', sub);
      return markDeleted('task', row);
    }),

    /**
     * Restaura uma tarefa excluída e as subtarefas excluídas no mesmo instante.
     * Uma subtarefa volta para onde a tarefa principal está AGORA: se a principal mudou de demanda enquanto a
     * subtarefa estava excluída, ela acompanha; se a principal virou subtarefa de outra, a restaurada volta
     * como tarefa de nível superior (subtarefa não tem subtarefas). Essas correções são auditadas como 'moved'.
     * @param {string} id
     * @returns {object} tarefa restaurada
     * @throws {CommandError} demand_deleted | parent_deleted quando a demanda/tarefa principal continua excluída
     */
    restoreTask: define('restoreTask', (id) => {
      const row = store.get('tasks', id);
      if (!row) fail('not_found', NOT_FOUND.task, { type: 'task', id });
      if (!row.deleted_at) return row;
      const parent = hasId(row.parent_id) && row.parent_id !== row.id ? store.get('tasks', row.parent_id) : null;
      if (parent && parent.deleted_at) fail('parent_deleted', `A tarefa principal ${quoted(parent)} está excluída: restaure-a primeiro.`, { parentId: parent.id });
      // A demanda de uma subtarefa é a da tarefa principal (a coluna da subtarefa pode ter ficado para trás).
      const demandId = hasId(parent ? parent.demand_id : row.demand_id) ? (parent ? parent.demand_id : row.demand_id) : null;
      const demand = demandId ? store.get('demands', demandId) : null;
      if (demand && demand.deleted_at) fail('demand_deleted', `A demanda ${quoted(demand)} está excluída: restaure a demanda primeiro.`, { demandId: demand.id });
      const instant = row.deleted_at;
      let restored = markRestored('task', row);
      if (parent) {
        const fix = {};
        if (isSubtask(parent)) {
          fix.parent_id = null;
          fix.sort_order = nextSortOrder(topTasksOf(demandId).filter((t) => t.id !== id));
        }
        if (!sameValue(row.demand_id, demandId)) fix.demand_id = demandId;
        if (Object.keys(fix).length) {
          const before = restored;
          restored = store.update('tasks', id, fix);
          auditDiff('task', before, fix);
        }
      }
      const backIds = new Set([id]);
      for (const sub of store.byIndex('tasks', 'parent_id', id, { includeDeleted: true })) {
        if (sub.id === id || sub.deleted_at !== instant) continue;
        const back = markRestored('task', sub);
        backIds.add(sub.id);
        if (!sameValue(back.demand_id, restored.demand_id)) {
          store.update('tasks', sub.id, { demand_id: restored.demand_id });
          auditDiff('task', back, { demand_id: restored.demand_id }, { with_parent: true });
        }
      }
      breakCyclesAfterRestore(backIds);
      return store.get('tasks', id);
    }),

    /**
     * Move e/ou reordena uma tarefa.
     *   • `demand_id`: outra demanda (null = tarefa avulsa) — as subtarefas vão junto; numa subtarefa, trocar a
     *     demanda a transforma em tarefa de nível superior;
     *   • `parent_id`: vira subtarefa daquela tarefa (herda a demanda dela) ou, com null, volta ao nível superior.
     *     Tarefa com subtarefas não pode virar subtarefa; o pai não pode ser subtarefa nem a própria tarefa;
     *   • `beforeId` / `afterId`: posição na lista de destino (sem eles, mudando de lista, vai para o fim).
     * Troca de demanda/pai é auditada como 'moved'; reordenar não é auditado.
     * @param {string} id
     * @param {{ demand_id?: string|null, parent_id?: string|null, beforeId?: string, afterId?: string }} target
     * @returns {object} tarefa
     * @throws {CommandError} invalid_parent | demand_not_found | invalid_position
     */
    moveTask: define('moveTask', (id, target = {}) => relocate(requireRow('task', id), target || {})),

    // ----- atalhos --------------------------------------------------------------------------------
    /**
     * Troca o status de uma demanda ou tarefa.
     * @param {'demand'|'task'} type
     * @param {string} id
     * @param {string} statusId precisa existir em sel.statuses()
     * @param {{ reason?: string, blocked_reason?: string, waiting_on?: string }} [options]
     *        reason: motivo no histórico; blocked_reason: gravado ao entrar em "bloqueada"; waiting_on: ao entrar em
     *        "aguardando terceiros".
     * @returns {{ entity: object, transition: object, warnings: Array<{code: string, message: string, data: object}>,
     *             autoStartedDemand: string|null, autoStartedFrom: string|null }}
     *          Avisos (nunca impedem): open_prereqs, open_subtasks, all_subtasks_done, demand_can_complete,
     *          demand_is_done e, para demandas, open_tasks.
     */
    setStatus: define('setStatus', (type, id, statusId, options = {}) => {
      if (type !== 'demand' && type !== 'task') fail('invalid_type', 'Só demandas e tarefas têm status.', { type });
      const opts = options || {};
      return absorb(changeStatus(type, requireRow(type, id), statusId, { reason: opts.reason, blocked_reason: opts.blocked_reason, waiting_on: opts.waiting_on }));
    }),

    /**
     * Altera a prioridade de uma demanda ou tarefa.
     * @param {'demand'|'task'} type
     * @param {string} id
     * @param {'P1'|'P2'|'P3'|'P4'} priority
     * @param {{ justification?: string }} [options] vai para o evento 'priority_changed'
     * @returns {object} entidade atualizada
     */
    setPriority: define('setPriority', (type, id, priority, options) => {
      const { justification } = options || {};
      if (type !== 'demand' && type !== 'task') fail('invalid_type', 'Só demandas e tarefas têm prioridade.', { type });
      const row = requireRow(type, id);
      return applyFields(type, row, cleanInput(type, { priority }, 'setPriority'), { justification });
    }),

    /**
     * Altera o prazo de uma demanda ou tarefa.
     * @param {'demand'|'task'} type
     * @param {string} id
     * @param {string|null} date 'YYYY-MM-DD' ou null (sem prazo)
     * @param {{ reason?: string }} [options] vai para o evento 'due_changed'
     * @returns {object} entidade atualizada
     */
    setDueDate: define('setDueDate', (type, id, date, options) => {
      const { reason } = options || {};
      if (type !== 'demand' && type !== 'task') fail('invalid_type', 'Só demandas e tarefas têm prazo.', { type });
      const row = requireRow(type, id);
      return applyFields(type, row, cleanInput(type, { due_date: date === undefined ? null : date }, 'setDueDate'), { reason });
    }),

    /**
     * Registra uma cobrança feita ("Cobrei agora"): evento 'followed_up' no histórico e nova data "Cobrar em"
     * (`nextDate` ou hoje + configuração 'followup.defaultDays' dias úteis, padrão 3).
     * A pessoa cobrada é `waiting_on` (item aguardando terceiros) ou o responsável (item com outra pessoa).
     * @param {'demand'|'task'} type
     * @param {string} id
     * @param {{ note?: string, nextDate?: string|null }} [options]
     * @returns {object} entidade atualizada
     */
    logFollowUp: define('logFollowUp', (type, id, options) => {
      if (type !== 'demand' && type !== 'task') fail('invalid_type', 'Só demandas e tarefas podem ser cobradas.', { type });
      const opts = options || {};
      const row = requireRow(type, id);
      const list = statuses();
      if (!isOpen(row, list)) fail('invalid_status', 'Este item já foi concluído ou cancelado: não há o que cobrar.', { type, id });
      const note = opts.note === undefined ? null : textOrNull('note', opts.note);
      const today = isoToDateStr(now) || app.clock.today();
      let nextDate = opts.nextDate === undefined || opts.nextDate === null || opts.nextDate === '' ? null : dateOrNull('follow_up_date', opts.nextDate);
      if (!nextDate) {
        const setting = store.get('settings', 'followup.defaultDays');
        const days = setting && Number.isInteger(setting.value) && setting.value >= 1 && setting.value <= 30 ? setting.value : DEFAULT_FOLLOWUP_DAYS; // valor antigo fora da faixa → padrão
        nextDate = nextFollowUpDate(today, days);
      }
      const waiting = categoryOf(list, row.status) === 'waiting';
      const defaultOwner = store.get('settings', 'owner.default');
      const role = waiting ? 'waiting' : isOtherOwner(row.owner, defaultOwner ? defaultOwner.value : '') ? 'owner' : null;
      const person = personName(role === 'waiting' ? row.waiting_on : role === 'owner' ? row.owner : row.waiting_on || row.owner) || null;
      event(type, id, ACTIONS.FOLLOW_UP, {
        oldValue: row.follow_up_date || null,
        newValue: person,
        meta: { person, note: note || undefined, next_date: nextDate, role: role || undefined },
      });
      if (sameValue(row.follow_up_date, nextDate)) return row;
      const patch = { follow_up_date: nextDate };
      const updated = store.update(ENTITY_TABLE[type], id, patch);
      auditDiff(type, row, patch, { cause: 'followed_up' });
      return updated;
    }),

    /**
     * Define (ou limpa, com null) o "Cobrar em".
     * @param {'demand'|'task'} type
     * @param {string} id
     * @param {string|null} date 'YYYY-MM-DD'
     * @returns {object} entidade atualizada
     */
    setFollowUpDate: define('setFollowUpDate', (type, id, date) => {
      if (type !== 'demand' && type !== 'task') fail('invalid_type', 'Só demandas e tarefas têm data de cobrança.', { type });
      const row = requireRow(type, id);
      return applyFields(type, row, cleanInput(type, { follow_up_date: date === undefined ? null : date }, 'setFollowUpDate'));
    }),

    /**
     * "Retomar" um item que aguardava terceiros: volta ao status anterior à espera (pelo histórico) ou ao primeiro
     * status em andamento; `waiting_on` é limpo pela própria troca de status.
     * @param {'demand'|'task'} type
     * @param {string} id
     * @returns {object} mesmo formato de setStatus
     */
    resumeWaiting: define('resumeWaiting', (type, id) => {
      if (type !== 'demand' && type !== 'task') fail('invalid_type', 'Só demandas e tarefas têm status.', { type });
      const row = requireRow(type, id);
      const list = statuses();
      if (categoryOf(list, row.status) !== 'waiting') fail('invalid_status', 'Este item não está aguardando terceiros.', { type, id });
      const events = sortEvents(store.byIndex('activity_log', 'entity_id', id).filter((e) => e.entity_type === type));
      const target = resumeStatusId(row, events, { statuses: list, nowIso: now });
      return absorb(changeStatus(type, row, target, { reason: 'Retomada' }));
    }),

    /**
     * Conclui uma tarefa (primeiro status de categoria "concluída").
     * @param {string} id
     * @param {{ withSubtasks?: boolean }} [options] conclui também as subtarefas ainda abertas
     * @returns {object} mesmo formato de setStatus
     */
    completeTask: define('completeTask', (id, options) => {
      const { withSubtasks = false } = options || {};
      const task = requireRow('task', id);
      const list = statuses();
      const done = firstOfCategory(list, 'done');
      const subStopped = [];
      if (withSubtasks) {
        for (const sub of subtasksOf(id).sort(bySortOrder)) {
          if (!isOpen(sub, list)) continue;
          const subResult = changeStatus('task', sub, done.id, { silent: true });
          subStopped.push(...subResult.stoppedTimers);
          absorb({ ...subResult, warnings: [] });
        }
      }
      const result = changeStatus('task', task, done.id, {});
      if (subStopped.length) {
        // Um aviso só para os cronômetros encerrados (da tarefa e das subtarefas).
        result.stoppedTimers = [...subStopped, ...result.stoppedTimers];
        result.warnings = result.warnings.filter((w) => w.code !== 'timer_stopped');
        warnTimersStopped(result.warnings, result.stoppedTimers);
      }
      return absorb(result);
    }),

    /**
     * Reabre uma tarefa encerrada.
     * @param {string} id
     * @param {string} [statusId] status ABERTO de destino; padrão: o status que ela tinha antes de ser encerrada
     *        (se ainda existir e for aberto) ou o primeiro de categoria "em andamento"
     * @returns {object} mesmo formato de setStatus (aviso 'demand_is_done' quando a demanda está concluída)
     */
    reopenTask: define('reopenTask', (id, statusId) => {
      const task = requireRow('task', id);
      const list = statuses();
      let target = statusId;
      if (target === undefined || target === null || target === '') {
        // Tarefa que já está aberta e nenhum destino informado: não há o que reabrir.
        if (isOpen(task, list)) return absorb(changeStatus('task', task, task.status, {}));
        let latest = null;
        for (const ev of store.byIndex('activity_log', 'entity_id', id)) {
          if (ev.entity_type !== 'task' || ev.action !== ACTIONS.STATUS || ev.new_value !== task.status) continue;
          if (!latest || ev.at > latest.at) latest = ev;
        }
        const previous = latest ? list.find((s) => s.id === latest.old_value) : null;
        const fallback = firstOfCategory(list, 'active') || firstOfCategory(list, 'planned');
        target = previous && isOpenCategory(previous.category) ? previous.id : fallback.id;
      }
      const status = requireStatus(list, target);
      if (!isOpenCategory(status.category)) fail('invalid_status', 'Para reabrir, escolha um status aberto (nem concluído nem cancelado).', { status: target });
      return absorb(changeStatus('task', task, status.id, {}));
    }),

    // ----- dependências ---------------------------------------------------------------------------
    /**
     * Cria a dependência "taskId depende de dependsOnId". Sempre grava uma linha NOVA: uma aresta excluída do
     * mesmo par não é revivida, porque created_at/deleted_at de cada linha são o intervalo em que a dependência
     * existiu — as métricas de períodos passados leem esses intervalos (seção 11: histórico real).
     * @param {string} taskId tarefa que passa a depender
     * @param {string} dependsOnId pré-requisito
     * @returns {object} linha de task_dependencies
     * @throws {CommandError} code = missing | self | duplicate | hierarchy | cycle (data.path traz o ciclo)
     */
    addDependency: define('addDependency', (taskId, dependsOnId) => {
      const graph = buildGraph(store.all('tasks'), store.all('task_dependencies'));
      const check = validateNewDependency(taskId, dependsOnId, { graph, tasksById: TASKS });
      if (!check.ok) fail(check.reason, check.message, { path: check.path });
      const row = store.insert('task_dependencies', { task_id: taskId, depends_on_id: dependsOnId, created_at: now, updated_at: now });
      event('task', taskId, ACTIONS.DEP_ADDED, { newValue: dependsOnId, meta: { name: store.get('tasks', dependsOnId).name } });
      return row;
    }),

    /**
     * Remove a dependência "taskId depende de dependsOnId" — TODAS as arestas do par (duplicadas inclusive).
     * @param {string} taskId
     * @param {string} dependsOnId
     * @returns {object[]} arestas removidas ([] se a dependência não existia: nada é gravado)
     */
    removeDependency: define('removeDependency', (taskId, dependsOnId) => {
      const rows = dependencyRows(store.all('task_dependencies'), taskId, dependsOnId);
      if (!rows.length) return [];
      const removed = rows.map((dep) => store.update('task_dependencies', dep.id, { deleted_at: now }));
      const prereq = store.get('tasks', dependsOnId);
      event('task', taskId, ACTIONS.DEP_REMOVED, { oldValue: dependsOnId, meta: { name: prereq ? prereq.name : null } });
      return removed;
    }),

    // ----- observações ----------------------------------------------------------------------------
    /**
     * Acrescenta uma observação datada a uma demanda, tarefa ou projeto.
     * @param {'demand'|'task'|'project'} type
     * @param {string} id
     * @param {string} body texto (aparado; não pode ficar vazio)
     * @returns {object} observação criada
     */
    addNote: define('addNote', (type, id, body) => {
      if (!NOTE_TYPES.has(type)) fail('invalid_type', `Tipo de registro desconhecido: ${String(type)}.`, { type });
      requireRow(type, id);
      const text = typeof body === 'string' ? body.trim() : '';
      if (!text) fail('invalid_body', 'Escreva a observação antes de salvar.', { field: 'body' });
      const note = store.insert('notes', { entity_type: type, entity_id: id, body: text, created_at: now, updated_at: now });
      event(type, id, ACTIONS.NOTE_ADDED, { newValue: note.id, meta: { excerpt: excerptOf(text) } });
      return note;
    }),

    /**
     * Altera o texto de uma observação.
     * @param {string} noteId
     * @param {string} body
     * @returns {object} observação
     */
    updateNote: define('updateNote', (noteId, body) => {
      const note = liveGet('notes', noteId);
      if (!note) fail('not_found', 'Observação não encontrada: ela pode ter sido excluída.', { type: 'note', id: noteId });
      const text = typeof body === 'string' ? body.trim() : '';
      if (!text) fail('invalid_body', 'Escreva a observação antes de salvar.', { field: 'body' });
      return text === note.body ? note : store.update('notes', noteId, { body: text });
    }),

    /**
     * Exclui (exclusão lógica) uma observação.
     * @param {string} noteId
     * @returns {object} observação excluída
     */
    deleteNote: define('deleteNote', (noteId) => {
      const note = liveGet('notes', noteId);
      if (!note) fail('not_found', 'Observação não encontrada: ela pode ter sido excluída.', { type: 'note', id: noteId });
      return store.update('notes', noteId, { deleted_at: now });
    }),

    // ----- links e arquivos -------------------------------------------------------------------------
    /**
     * Acrescenta um link (URL, caminho de rede/local, arquivo, e-mail…) a uma demanda, tarefa ou projeto.
     * O tipo vem de domain/links.js; sem rótulo, usa o sugerido (nome do arquivo / host).
     * @param {'demand'|'task'|'project'} type
     * @param {string} id
     * @param {{ target: string, label?: string|null }} values
     * @returns {object} link criado
     */
    addLink: define('addLink', (type, id, values) => {
      if (!NOTE_TYPES.has(type)) fail('invalid_type', `Tipo de registro desconhecido: ${String(type)}.`, { type });
      requireRow(type, id);
      const { target, label } = values || {};
      const res = checkedTarget(target);
      const name = linkLabel(label, res);
      const siblings = store.byIndex('links', 'entity_id', id).filter((l) => l.entity_type === type);
      const link = store.insert('links', {
        entity_type: type,
        entity_id: id,
        target: res.target,
        label: name,
        kind: res.kind,
        sort_order: nextSortOrder(siblings),
        created_at: now,
        updated_at: now,
      });
      event(type, id, ACTIONS.LINK_ADDED, { newValue: link.id, meta: { label: name, kind: res.kind } });
      return link;
    }),

    /**
     * Altera rótulo e/ou alvo de um link (rótulo vazio volta ao sugerido pelo alvo).
     * @param {string} linkId
     * @param {{ target?: string, label?: string|null }} patch
     * @returns {object} link (o mesmo objeto quando nada mudou)
     */
    updateLink: define('updateLink', (linkId, patch) => {
      const link = liveGet('links', linkId);
      if (!link) fail('not_found', 'Link não encontrado: ele pode ter sido removido.', { type: 'link', id: linkId });
      const p = patch || {};
      const res = checkedTarget(p.target === undefined ? link.target : p.target);
      const name = p.label === undefined && p.target === undefined ? link.label : linkLabel(p.label === undefined ? link.label : p.label, res);
      const out = {};
      if (res.target !== link.target) out.target = res.target;
      if (res.kind !== link.kind) out.kind = res.kind;
      if (name !== link.label) out.label = name;
      if (!Object.keys(out).length) return link;
      const row = store.update('links', linkId, out);
      event(link.entity_type, link.entity_id, ACTIONS.LINK_UPDATED, {
        newValue: link.id,
        meta: { label: row.label, kind: row.kind, old_label: out.label !== undefined ? link.label : undefined, target_changed: out.target !== undefined ? true : undefined },
      });
      return row;
    }),

    /**
     * Remove (exclusão lógica) um link; o "Desfazer" é restoreLink.
     * @param {string} linkId
     * @returns {object} link removido
     */
    deleteLink: define('deleteLink', (linkId) => {
      const link = liveGet('links', linkId);
      if (!link) fail('not_found', 'Link não encontrado: ele pode ter sido removido.', { type: 'link', id: linkId });
      const row = store.update('links', linkId, { deleted_at: now });
      event(link.entity_type, link.entity_id, ACTIONS.LINK_REMOVED, { oldValue: link.id, meta: { label: link.label, kind: link.kind } });
      return row;
    }),

    /**
     * Desfaz a remoção de um link (o registro dono precisa existir).
     * @param {string} linkId
     * @returns {object} link
     */
    restoreLink: define('restoreLink', (linkId) => {
      const link = hasId(linkId) ? store.get('links', linkId) : null;
      if (!link) fail('not_found', 'Link não encontrado.', { type: 'link', id: linkId });
      if (!link.deleted_at) return link;
      requireRow(link.entity_type, link.entity_id);
      const row = store.update('links', linkId, { deleted_at: null });
      event(link.entity_type, link.entity_id, ACTIONS.LINK_ADDED, { newValue: link.id, meta: { label: link.label, kind: link.kind, restored: true } });
      return row;
    }),

    /**
     * Move um link para a posição `index` (0 = primeiro) entre os links do mesmo registro.
     * @param {string} linkId
     * @param {number} index
     * @returns {object} link
     */
    reorderLink: define('reorderLink', (linkId, index) => {
      const link = liveGet('links', linkId);
      if (!link) fail('not_found', 'Link não encontrado: ele pode ter sido removido.', { type: 'link', id: linkId });
      if (!Number.isInteger(index) || index < 0) fail('invalid_position', 'Posição inválida.', { index });
      const others = store
        .byIndex('links', 'entity_id', link.entity_id)
        .filter((l) => l.entity_type === link.entity_type && l.id !== link.id)
        .sort(compareLinks);
      const list = [...others];
      list.splice(Math.min(index, others.length), 0, link);
      // Renumera em passos fixos só o que mudou (poucos links por registro).
      let result = link;
      list.forEach((row, i) => {
        const order = (i + 1) * ORDER_STEP;
        const updated = finite(row.sort_order) === order ? row : store.update('links', row.id, { sort_order: order });
        if (row.id === link.id) result = updated;
      });
      return result;
    }),

    // ----- tempo ----------------------------------------------------------------------------------
    /**
     * Liga o cronômetro numa tarefa. Um cronômetro PAUSADO da mesma tarefa é retomado (não cria outro).
     * Se há outro cronômetro RODANDO: others 'ask' lança CommandError('timer_running', …, { running }) para a
     * interface perguntar; 'pause' pausa os outros e liga; 'keep' liga mesmo assim (paralelo por escolha).
     * @param {string} taskId
     * @param {{ others?: 'ask'|'pause'|'keep' }} [options]
     * @returns {{ entry: object, suggestStart: boolean }} suggestStart = a tarefa ainda está em backlog/planejada
     *          (o status NÃO é alterado automaticamente; a interface pode sugerir "Iniciar")
     */
    startTimer: define('startTimer', (taskId, options) => {
      const { others = 'ask' } = options || {};
      const task = requireRow('task', taskId);
      const category = categoryOf(statuses(), task.status);
      const suggestStart = category === 'backlog' || category === 'planned';
      const own = store.byIndex('time_entries', 'task_id', taskId).filter((entry) => timerState(entry) !== TIMER.DONE);
      const running = own.find((entry) => timerState(entry) === TIMER.RUNNING);
      if (running) return { entry: running, suggestStart };
      const paused = own.sort((a, b) => cmpText(String(b.started_at || ''), String(a.started_at || '')))[0] || null;
      handleOthers(others, paused ? paused.id : null);
      const entry = paused
        ? resumeEntry(paused)
        : store.insert('time_entries', { ...startValues({ taskId, nowIso: now }), created_at: now, updated_at: now });
      return { entry, suggestStart };
    }),

    /**
     * Pausa um cronômetro rodando.
     * @param {string} entryId
     * @returns {object} apontamento
     */
    pauseTimer: define('pauseTimer', (entryId) => {
      const entry = requireEntry(entryId);
      return store.update('time_entries', entryId, pausePatch(entry, now));
    }),

    /**
     * Retoma um cronômetro pausado (mesma regra de `others` de startTimer).
     * @param {string} entryId
     * @param {{ others?: 'ask'|'pause'|'keep' }} [options]
     * @returns {object} apontamento
     */
    resumeTimer: define('resumeTimer', (entryId, options) => {
      const { others = 'ask' } = options || {};
      const entry = requireEntry(entryId);
      resumePatch(entry, now); // valida o estado antes de mexer nos outros cronômetros
      handleOthers(others, entryId);
      return resumeEntry(entry);
    }),

    /**
     * Encerra um cronômetro (rodando ou pausado) e registra 'time_logged' no histórico da tarefa.
     * @param {string} entryId
     * @param {{ description?: string|null }} [options]
     * @returns {object} apontamento encerrado
     */
    stopTimer: define('stopTimer', (entryId, options) => stopEntry(requireEntry(entryId), { description: options ? options.description : undefined })),

    /**
     * Lança um apontamento manual. Combinações aceitas: início + término; início + duração; só duração;
     * início + término + duração líquida (ver manualEntryValues).
     * @param {{ task_id: string, date?: string, start?: string, end?: string, durationMinutes?: number, description?: string }} input
     *        date padrão: hoje
     * @param {{ allowOverlap?: boolean }} [options] grava mesmo sobrepondo outros apontamentos
     * @returns {object} apontamento criado
     * @throws {CommandError} overlap (data.overlaps) e os códigos de validação de timetracking.js
     */
    addManualTime: define('addManualTime', (input = {}, options) => {
      const { allowOverlap = false } = options || {};
      const data = input || {};
      const taskId = data.task_id !== undefined ? data.task_id : data.taskId;
      if (hasId(taskId)) requireRow('task', taskId);
      const values = manualEntryValues({
        taskId,
        date: data.date === undefined || data.date === null || data.date === '' ? app.clock.today() : data.date,
        start: data.start,
        end: data.end,
        durationMinutes: data.durationMinutes,
        description: data.description,
      });
      if (!allowOverlap) {
        const overlaps = findOverlaps(store.all('time_entries'), { candidate: values, nowMs: Date.parse(now) });
        if (overlaps.length) fail('overlap', 'Este horário se sobrepõe a outro apontamento. Ajuste o horário ou confirme para gravar mesmo assim.', { overlaps });
      }
      const entry = store.insert('time_entries', { ...values, created_at: now, updated_at: now });
      logTime(entry, ENTRY_SOURCE.MANUAL);
      return entry;
    }),

    /**
     * Altera um apontamento encerrado: tarefa, dia, horários, duração e descrição (cronômetro em aberto só
     * aceita descrição e tarefa). Os horários são validados de novo; mudando início/término, a duração é
     * recalculada; mudando só o dia, os horários são preservados.
     * @param {string} id
     * @param {{ task_id?: string, date?: string, start?: string|null, end?: string|null, durationMinutes?: number, description?: string|null }} patch
     * @param {{ allowOverlap?: boolean }} [options]
     * @returns {object} apontamento
     */
    updateTimeEntry: define('updateTimeEntry', (id, patch = {}, options) => {
      const { allowOverlap = false } = options || {};
      const entry = requireEntry(id);
      const input = patch || {};
      const KEYS = ['task_id', 'date', 'start', 'end', 'durationMinutes', 'description'];
      for (const key of Object.keys(input)) {
        if (input[key] !== undefined && !KEYS.includes(key)) fail('invalid_field', `O campo "${key}" não pode ser alterado por este comando.`, { field: key });
      }
      const out = {};
      if (input.description !== undefined) {
        const description = textOrNull('description', input.description);
        if (!sameValue(entry.description, description)) out.description = description;
      }
      if (input.task_id !== undefined && input.task_id !== entry.task_id) {
        requireRow('task', input.task_id);
        out.task_id = input.task_id;
      }
      const clockChanged = input.start !== undefined || input.end !== undefined;
      if (input.date !== undefined || clockChanged || input.durationMinutes !== undefined) {
        if (timerState(entry) !== TIMER.DONE) fail('timer_active', 'Encerre o cronômetro antes de editar os horários deste apontamento.', { id });
        const currentDate = isValidDateStr(entry.entry_date) ? entry.entry_date : isoToDateStr(entry.started_at) || app.clock.today();
        const date = input.date !== undefined ? input.date : currentDate;
        let values;
        if (!clockChanged && input.durationMinutes === undefined) {
          // Só o dia mudou: desloca os instantes preservando a hora local e a duração líquida.
          if (!isValidDateStr(date)) fail('invalid_date', 'Informe uma data válida para o apontamento.', { field: 'date' });
          const delta = diffDays(currentDate, date);
          values = { entry_date: date, started_at: shiftDays(entry.started_at, delta), ended_at: shiftDays(entry.ended_at, delta) };
        } else {
          const currentStart = entry.started_at ? timeOfIso(entry.started_at) : null;
          const sameDayEnd = entry.started_at && entry.ended_at && isoToDateStr(entry.started_at) === isoToDateStr(entry.ended_at);
          const start = input.start !== undefined ? input.start : currentStart;
          const end = input.end !== undefined ? input.end : clockChanged && sameDayEnd ? timeOfIso(entry.ended_at) : null;
          const hasEnd = end !== null && end !== undefined && String(end).trim() !== '';
          const durationMinutes = input.durationMinutes !== undefined ? input.durationMinutes : hasEnd ? undefined : finite(entry.duration_seconds) / 60;
          const computed = manualEntryValues({ taskId: out.task_id || entry.task_id, date, start, end, durationMinutes });
          values = { entry_date: computed.entry_date, started_at: computed.started_at, ended_at: computed.ended_at, duration_seconds: computed.duration_seconds, accumulated_seconds: computed.accumulated_seconds };
        }
        for (const key of Object.keys(values)) if (!sameValue(entry[key], values[key])) out[key] = values[key];
        if (!allowOverlap && ('started_at' in out || 'ended_at' in out)) {
          const overlaps = findOverlaps(store.all('time_entries'), { candidate: { ...entry, ...out }, nowMs: Date.parse(now) });
          if (overlaps.length) fail('overlap', 'Este horário se sobrepõe a outro apontamento. Ajuste o horário ou confirme para gravar mesmo assim.', { overlaps });
        }
      }
      return Object.keys(out).length ? store.update('time_entries', id, out) : entry;
    }),

    /**
     * Exclui (exclusão lógica) um apontamento.
     * @param {string} id
     * @returns {object} apontamento excluído
     */
    deleteTimeEntry: define('deleteTimeEntry', (id) => {
      requireEntry(id);
      return store.update('time_entries', id, { deleted_at: now });
    }),

    /**
     * Desfaz a exclusão de um apontamento ("Desfazer" depois de excluir): a MESMA linha volta, com id, origem
     * e horários originais, sem novo evento (a exclusão também não gera). Já ativo → devolvido como está.
     * @param {string} id
     * @returns {object} apontamento restaurado
     * @throws {CommandError} not_found — apontamento inexistente, ou a tarefa dele foi excluída
     */
    restoreTimeEntry: define('restoreTimeEntry', (id) => {
      const entry = hasId(id) ? store.get('time_entries', id) : null;
      if (!entry) fail('not_found', 'Apontamento não encontrado.', { type: 'time_entry', id });
      if (!entry.deleted_at) return entry;
      if (!liveGet('tasks', entry.task_id)) fail('not_found', 'A tarefa deste apontamento foi excluída: restaure a tarefa primeiro.', { type: 'task', id: entry.task_id });
      return store.update('time_entries', id, { deleted_at: null });
    }),

    // ----- semana ---------------------------------------------------------------------------------
    /**
     * Põe uma tarefa no plano de uma semana. Se ela já está no plano, o item existente é devolvido como está;
     * um item retirado antes é revivido.
     * @param {string} taskId
     * @param {string} [weekStart] qualquer dia da semana (padrão: semana corrente)
     * @param {{ kind?: 'planned'|'added' }} [options] padrão: 'planned' até o fim da segunda-feira, depois 'added'
     * @returns {object} linha de week_items
     */
    addToWeek: define('addToWeek', (taskId, weekStart, options) => {
      const { kind } = options || {};
      const task = requireRow('task', taskId);
      const week = weekOf(weekStart);
      if (kind !== undefined && kind !== null && kind !== WEEK_KIND.PLANNED && kind !== WEEK_KIND.ADDED) {
        fail('invalid_kind', `Tipo de item desconhecido: ${String(kind)}. Use "planned" ou "added".`, { kind });
      }
      return addToWeekCore(task, week, kind || null);
    }),

    /**
     * Retira um item do plano da semana (marca removed_at: a linha fica para o histórico).
     * @param {string} itemId
     * @returns {object} item
     */
    removeFromWeek: define('removeFromWeek', (itemId) => {
      const item = liveGet('week_items', itemId);
      if (!item) fail('not_found', 'Item do planejamento não encontrado.', { type: 'week_item', id: itemId });
      if (item.removed_at) return item;
      removeFromWeekCore(item.task_id, startOfWeek(item.week_start));
      return store.get('week_items', itemId);
    }),

    /**
     * Transfere o trabalho NÃO concluído de uma semana para outra, sem apagar o plano anterior: o item original
     * recebe carried_to_week e um item novo (carried_from_id) nasce na semana de destino.
     * @param {string} fromWeek
     * @param {string} toWeek
     * @param {{ itemIds?: string[] }} [options] restringe aos itens informados
     * @returns {{ inserted: object[], updated: object[], skipped: Array<{ item: object, reason: string }> }}
     */
    carryOverWeek: define('carryOverWeek', (fromWeek, toWeek, options) => {
      const { itemIds } = options || {};
      if (fromWeek === undefined || fromWeek === null || toWeek === undefined || toWeek === null) {
        fail('invalid_week', 'Informe a semana de origem e a de destino.', { fromWeek, toWeek });
      }
      const from = weekOf(fromWeek);
      const to = weekOf(toWeek);
      const plan = carryOverPlan({ items: store.all('week_items'), tasksById: TASKS, statuses: statuses(), fromWeek: from, toWeek: to, nowIso: now, itemIds });
      const carried = new Set();
      const inserted = plan.inserts.map((values) => {
        carried.add(values.task_id);
        return store.insert('week_items', { ...values, created_at: now, updated_at: now });
      });
      const updated = plan.updates.map(({ id, patch }) => {
        const row = store.update('week_items', id, patch);
        carried.add(row.task_id);
        return row;
      });
      for (const taskId of carried) event('task', taskId, ACTIONS.WEEK_CARRIED, { newValue: to, meta: { from_week: from, to_week: to } });
      return { inserted, updated, skipped: plan.skipped };
    }),

    /**
     * Replaneja um item para outra semana: sai do plano da semana atual (removed_at) e entra no da semana de
     * destino. Diferente de carryOverWeek, não conta como "não concluído e transferido".
     * @param {string} itemId
     * @param {string} toWeek
     * @returns {object} item na semana de destino
     */
    moveWeekItem: define('moveWeekItem', (itemId, toWeek) => {
      const item = liveGet('week_items', itemId);
      if (!item) fail('not_found', 'Item do planejamento não encontrado.', { type: 'week_item', id: itemId });
      if (toWeek === undefined || toWeek === null || toWeek === '') fail('invalid_week', 'Informe a semana de destino.', { week: toWeek });
      const target = weekOf(toWeek);
      const source = startOfWeek(item.week_start);
      if (source === target) return item;
      const task = requireRow('task', item.task_id);
      if (!item.removed_at) removeFromWeekCore(item.task_id, source, target);
      return addToWeekCore(task, target, null);
    }),

    /**
     * "Desfazer" de moveWeekItem / carryOverWeek sem deixar rastro no plano: o item que a mudança criou na
     * semana de destino é descartado (deleted_at — não vira "retirado do plano") e os itens da semana de origem
     * voltam exatamente como eram (removed_at, kind, added_at, carried_to_week). Se a mudança tinha revivido um
     * item retirado da semana de destino, ele volta ao estado anterior em vez de ser excluído. Grava um único
     * evento 'week_move_undone' (os eventos da mudança continuam no histórico: o log é só de acréscimo).
     * @param {string} targetItemId item na semana de destino (o retorno de moveWeekItem / um `inserted` de carryOverWeek)
     * @param {{ source: object[], target?: object[] }|object[]} snapshot linhas de sel.weekItemRows(tarefa, semana)
     *        tiradas ANTES da mudança — da semana de origem (`source`) e da de destino (`target`). Um array é `source`.
     * @returns {object} item da semana de origem, restaurado
     * @throws {CommandError} not_found — item de destino inexistente ou já descartado; stale_undo — o item de destino
     *         já saiu do plano depois da mudança; invalid_snapshot — retrato da origem ausente/incoerente
     */
    undoWeekMove: define('undoWeekMove', (targetItemId, snapshot) => {
      const target = liveGet('week_items', targetItemId);
      if (!target) fail('not_found', 'Item do planejamento não encontrado.', { type: 'week_item', id: targetItemId });
      // O item de destino já saiu do plano depois da mudança (retirado ou movido de novo): o Desfazer ficou velho.
      if (target.removed_at) fail('stale_undo', 'Este item já mudou de novo no plano; não há mais o que desfazer.', { id: targetItemId });
      const shot =Array.isArray(snapshot) ? { source: snapshot, target: [] } : snapshot || {};
      const isRow = (row) => !!row && typeof row === 'object' && hasId(row.id);
      const sources = (Array.isArray(shot.source) ? shot.source : []).filter((row) => isRow(row) && row.task_id === target.task_id && row.id !== target.id);
      const targets = (Array.isArray(shot.target) ? shot.target : []).filter(isRow);
      if (!sources.length) fail('invalid_snapshot', 'Não há como desfazer: falta o retrato da semana de origem.', { id: targetItemId });
      const fromWeek = startOfWeek(sources[0].week_start);
      const toWeek = startOfWeek(target.week_start);
      if (fromWeek === toWeek) fail('invalid_snapshot', 'A semana de origem e a de destino são a mesma.', { id: targetItemId });

      const RESTORED_FIELDS = ['removed_at', 'kind', 'added_at', 'carried_to_week'];
      const restoreTo = (row, before) => {
        const patch = {};
        for (const key of RESTORED_FIELDS) {
          const value = before[key] === undefined ? null : before[key];
          if (!sameValue(row[key], value)) patch[key] = value;
        }
        return Object.keys(patch).length ? store.update('week_items', row.id, patch) : row;
      };

      const previous = targets.find((row) => row.id === target.id);
      if (previous) restoreTo(target, previous);
      else store.update('week_items', target.id, { deleted_at: now });

      let back = null;
      for (const before of sources) {
        const row = store.get('week_items', before.id);
        if (!row || row.deleted_at) continue;
        const restored = restoreTo(row, before);
        if (!back || (!restored.removed_at && back.removed_at)) back = restored;
      }
      if (!back) fail('not_found', 'O item da semana de origem não existe mais.', { type: 'week_item', id: sources[0].id });
      event('task', target.task_id, ACTIONS.WEEK_UNDONE, { newValue: fromWeek, meta: { from_week: toWeek, to_week: fromWeek } });
      return back;
    }),

    // ----- configurações e sugestões --------------------------------------------------------------
    /**
     * Grava uma configuração sincronizada (tabela `settings`). Chaves conhecidas são validadas; null volta ao
     * padrão. Valor igual ao gravado não gera escrita.
     * @param {string} key
     * @param {*} value qualquer valor JSON
     * @returns {object} linha de settings
     * @throws {CommandError} invalid_setting | too_many_templates (chave `template:<id>` nova com 50 modelos ativos)
     */
    setSetting: define('setSetting', (key, value) => {
      if (typeof key !== 'string' || !key.trim()) fail('invalid_setting', 'Informe a chave da configuração.', { key });
      let clean = value === undefined ? null : value;
      const rule = SETTING_RULES[key];
      if (rule && clean !== null) {
        clean = rule(clean);
        if (clean === undefined) fail('invalid_setting', SETTING_MESSAGES[key], { key, value });
      } else if (isTemplateSettingKey(key) && clean !== null) {
        try {
          clean = normalizeTemplateSetting(key, clean);
        } catch (e) {
          fail('invalid_setting', e instanceof TemplateError ? `Modelo inválido: ${e.message}` : 'Modelo inválido.', { key, value });
        }
        const current = store.get('settings', key);
        const isNew = !current || current.value === null || current.value === undefined;
        if (isNew) {
          const count = savedTemplates().length;
          if (count >= MAX_TEMPLATES) fail('too_many_templates', `É possível guardar no máximo ${MAX_TEMPLATES} modelos. Exclua algum em Configurações.`, { count });
        }
      }
      let text;
      try {
        text = JSON.stringify(clean);
      } catch {
        text = undefined;
      }
      if (text === undefined) fail('invalid_setting', 'O valor da configuração precisa ser serializável em JSON.', { key });
      const current = store.get('settings', key);
      if (current && JSON.stringify(current.value === undefined ? null : current.value) === text) return current;
      return store.put('settings', key, { value: clean });
    }),

    /**
     * Dispensa uma sugestão de prioridade: a assinatura entra em 'suggestions.dismissed' e a sugestão só volta
     * se a situação mudar.
     * @param {string} signature `signature` da sugestão (sel.prioritySuggestions())
     * @returns {object} linha de settings
     */
    dismissSuggestion: define('dismissSuggestion', (signature) => {
      if (typeof signature !== 'string' || !signature.trim()) fail('invalid_suggestion', 'Sugestão inválida.', { signature });
      const current = app.settings.get('suggestions.dismissed');
      const list = Array.isArray(current) ? current.filter((s) => typeof s === 'string') : [];
      if (!list.includes(signature)) list.push(signature);
      return cmd.setSetting('suggestions.dismissed', list.slice(-MAX_DISMISSED));
    }),

    /**
     * Aplica uma sugestão de prioridade: setPriority com a justificativa da sugestão (decisão do usuário).
     * @param {{ taskId: string, suggested: string, justification?: string }} suggestion
     * @returns {object} tarefa atualizada
     */
    applySuggestion: define('applySuggestion', (suggestion) => {
      if (!suggestion || typeof suggestion !== 'object' || !hasId(suggestion.taskId)) fail('invalid_suggestion', 'Sugestão inválida.', { suggestion });
      return cmd.setPriority('task', suggestion.taskId, suggestion.suggested, { justification: suggestion.justification });
    }),
  };

  return Object.freeze(cmd);
}
