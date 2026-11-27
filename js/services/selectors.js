// Consultas memorizadas sobre o banco local (app.sel).
//
// As telas chamam estes seletores a cada renderização; por isso:
//   • todo resultado fica em cache até `store.version()` mudar (mais os argumentos da chamada);
//   • o que depende de "hoje"/"agora" (prazos, seções da semana, cronômetros rodando) lê o relógio em
//     `app.clock` e inclui o dia na chave do cache — à meia-noite o resultado é refeito sozinho;
//   • tudo que é devolvido é IMUTÁVEL: listas e objetos congelados, Map/Set travados (set/add/delete/clear
//     lançam erro). Para alterar dados use `app.cmd.*`.
//
// Regras de visibilidade ("efetivo", ver docs/ARQUITETURA.md seção 4):
//   • excluída   = `deleted_at` da própria linha, da tarefa-pai ou da demanda;
//   • arquivada  = `archived_at` da própria linha, da tarefa-pai, da demanda ou do projeto da demanda;
//   • subtarefa  = tarefa cujo `parent_id` aponta para uma tarefa existente de nível superior. Pai inexistente,
//     autorreferência, ciclo ou "subtarefa de subtarefa" (dados inconsistentes vindos da sincronização) fazem a
//     tarefa ser tratada como de nível superior; a demanda de uma subtarefa é sempre a do pai;
//   • tarefa cuja demanda não existe neste aparelho (ainda não sincronizada) aparece entre as tarefas avulsas.
//
// Dentro de `store.transact` a versão do banco ainda não mudou: não chame seletores no meio de uma
// transação esperando ver as escritas dela (os comandos leem direto do banco por esse motivo).

import { addDays, isValidDateStr, startOfWeek, weekdayIndex } from '../core/dates.js';
import { ENTITY_TABLE, entityCode } from '../data/schema.js';
import { deadlineInfo, dueBuckets as bucketsOf } from '../domain/deadlines.js';
import { blockingPrereqs, buildGraph, downstreamCount, findCycles, isBlockedByDependency, scheduleConflicts } from '../domain/dependencies.js';
import { compareManualOrder, normalizeText } from '../domain/filters.js';
import { computeMetrics } from '../domain/metrics.js';
import { buildStatusReport } from '../domain/report.js';
import { buildDailyDigest } from '../domain/digest.js';
import { nextActions, prioritySuggestions } from '../domain/nextactions.js';
import { demandProgress, projectProgress, taskFraction } from '../domain/progress.js';
import { isCancelled, isClosed, isOpen, resolveStatuses, statusById } from '../domain/statuses.js';
import { indexEvents } from '../domain/timeline.js';
import { compareLinks } from '../domain/links.js';
import { collectPeople, daysSince, followUpInfo, isFollowUpDue, isOtherOwner, lastFollowUp, personKey, personName, waitingSince } from '../domain/followup.js';
import { TIMER, activeTimers, elapsedSeconds, summarize, timerState, totalsByTask } from '../domain/timetracking.js';
import { activeWeekItems, planLoad, weekSections, weekSummary } from '../domain/weekplan.js';

const EMPTY = Object.freeze([]);
const NAME_COLLATOR = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const METRICS_CACHE_SIZE = 8;
const DEFAULT_METRICS_DAYS = 30;

// ---------------------------------------------------------------------------
// Imutabilidade
// ---------------------------------------------------------------------------

function readOnly() {
  throw new TypeError('Resultado de seletor é somente leitura: use app.cmd.* para alterar dados.');
}

/** Trava um Map/Set: os métodos de escrita passam a lançar erro. */
function lock(collection) {
  if (Object.isFrozen(collection)) return collection;
  if (collection instanceof Map) collection.set = readOnly;
  else collection.add = readOnly;
  collection.delete = readOnly;
  collection.clear = readOnly;
  return Object.freeze(collection);
}

/** Congela em profundidade (objetos, listas, valores de Map); para na primeira coisa já congelada. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (value instanceof Map) {
    for (const item of value.values()) deepFreeze(item);
    return lock(value);
  }
  if (value instanceof Set) return lock(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const hasId = (id) => id !== null && id !== undefined && id !== '';
const cmpText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const finite = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/**
 * Ordem manual: a mesma de sortItems(…, 'manual') e dos comandos que reposicionam (compareManualOrder):
 * sort_order; empatado, prioridade → prazo → nome → criação → id (estável entre dispositivos).
 */
const bySortOrder = compareManualOrder;

function byProjectOrder(a, b) {
  return finite(a.sort_order) - finite(b.sort_order) || NAME_COLLATOR.compare(String(a.name || ''), String(b.name || '')) || cmpText(String(a.id), String(b.id));
}

/** Desempate de eventos do mesmo instante: o de criação é sempre o primeiro. */
const createdFirst = (event) => (event.action === 'created' ? 0 : 1);

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Tipo de uma entidade a partir das colunas da linha (quando o chamador não informa o tipo). */
function inferType(entity) {
  if ('parent_id' in entity || 'demand_id' in entity) return 'task';
  if ('project_id' in entity) return 'demand';
  return 'project';
}

/**
 * Cria os seletores do app.
 *
 * @param {{ store: object, clock: object, settings: { get(key: string, fallback?: any): any } }} app
 *        objeto do app (createApp): usa `store`, `clock` (relógio de parede) e `settings`
 * @returns {object} `sel` — ver a documentação de cada função abaixo
 */
export function createSelectors(app) {
  const { store } = app;

  // --- relógio e configurações ------------------------------------------------------------------
  const today = () => app.clock.today();
  // peek(): os seletores leem a hora para chaves de cache e cálculos memorizados — não é "mostrar a hora"
  // (a casca só redesenha no tique quem leu app.clock.now() direto no desenho).
  const peekNow = () => (typeof app.clock.peek === 'function' ? app.clock.peek() : app.clock.now());
  const nowIso = () => peekNow().toISOString();
  const nowMs = () => peekNow().getTime();
  const setting = (key) => app.settings.get(key);
  const soonDays = () => {
    const n = Number(setting('deadline.soonDays'));
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
  };
  const hoursPerDay = () => {
    const n = Number(setting('capacity.hoursPerDay'));
    return Number.isFinite(n) && n > 0 ? n : 8;
  };
  const hoursPerWeek = () => {
    const n = Number(setting('capacity.hoursPerWeek'));
    return Number.isFinite(n) && n > 0 ? n : 40;
  };

  // --- cache -------------------------------------------------------------------------------------
  let cacheVersion = -1;
  let cache = new Map();
  /** Resultado em cache até a versão do banco mudar. */
  function memo(key, compute) {
    const version = store.version();
    if (version !== cacheVersion) {
      cacheVersion = version;
      cache = new Map();
    }
    if (cache.has(key)) return cache.get(key);
    const value = compute();
    cache.set(key, value);
    return value;
  }

  let liveStamp = '';
  let liveCache = new Map();
  /** Cache de valores que mudam a cada segundo (cronômetro rodando): vale só dentro do mesmo segundo. */
  function memoLive(key, compute) {
    const stamp = `${store.version()}:${Math.floor(nowMs() / 1000)}`;
    if (stamp !== liveStamp) {
      liveStamp = stamp;
      liveCache = new Map();
    }
    if (liveCache.has(key)) return liveCache.get(key);
    const value = compute();
    liveCache.set(key, value);
    return value;
  }

  // --- status ------------------------------------------------------------------------------------
  // Memorizado pela LINHA da configuração (não pela versão): a identidade da lista só muda quando a
  // personalização muda, o que mantém válidos os caches por entidade (ex.: indicador de prazo).
  let statusesRow;
  let statusesList = null;
  function statuses() {
    const row = store.get('settings', 'statuses');
    if (statusesList === null || row !== statusesRow) {
      statusesRow = row;
      statusesList = deepFreeze(resolveStatuses(row ? row.value : null));
    }
    return statusesList;
  }

  // --- estrutura (hierarquia e visibilidade), calculada uma vez por versão ---------------------------
  /** Pai válido de uma tarefa (pode estar excluído) ou null — ver as regras no topo do arquivo. */
  function resolveParent(task) {
    const parentId = task.parent_id;
    if (!hasId(parentId) || parentId === task.id) return null;
    const parent = store.get('tasks', parentId);
    if (!parent) return null;
    const grand = parent.parent_id;
    if (hasId(grand) && grand !== parent.id && store.get('tasks', grand)) return null;
    return parent;
  }

  function struct() {
    return memo('struct', () => {
      const projectsById = new Map();
      for (const project of store.all('projects')) projectsById.set(project.id, project);

      const demandsById = new Map();
      const demandArchived = new Map();
      /** Demandas como o domínio deve vê-las: arquivamento herdado do projeto; inclui as excluídas. */
      const demandsForDomain = new Map();
      for (const demand of store.all('demands', { includeDeleted: true })) {
        if (demand.deleted_at) {
          demandsForDomain.set(demand.id, demand);
          continue;
        }
        demandsById.set(demand.id, demand);
        const project = hasId(demand.project_id) ? projectsById.get(demand.project_id) : undefined;
        const inherited = !demand.archived_at && project && project.archived_at ? project.archived_at : null;
        demandArchived.set(demand.id, !!demand.archived_at || !!inherited);
        demandsForDomain.set(demand.id, inherited ? Object.freeze({ ...demand, archived_at: inherited }) : demand);
      }

      const tasksById = new Map();
      const info = new Map();
      const visible = [];
      const visibleWithArchived = [];
      const topByDemand = new Map();
      const subsByParent = new Map();
      const allByDemand = new Map();
      const live = store.all('tasks');
      for (const task of live) tasksById.set(task.id, task);
      for (const task of live) {
        const parent = resolveParent(task);
        const demandId = hasId(parent ? parent.demand_id : task.demand_id) ? (parent ? parent.demand_id : task.demand_id) : null;
        const demandRow = demandId ? store.get('demands', demandId) : undefined;
        const demand = demandRow && !demandRow.deleted_at ? demandRow : null;
        const deleted = !!(parent && parent.deleted_at) || !!(demandRow && demandRow.deleted_at);
        const archived = !!task.archived_at || !!(parent && parent.archived_at) || (!!demand && demandArchived.get(demand.id) === true);
        info.set(task.id, Object.freeze({ parent: parent && !parent.deleted_at ? parent : null, demand, demandId: demand ? demandId : null, deleted, archived }));
        if (deleted) continue;
        visibleWithArchived.push(task);
        if (!archived) visible.push(task);
        if (parent) pushTo(subsByParent, parent.id, task);
        else pushTo(topByDemand, demand ? demandId : '', task);
        if (demand) {
          // Subtarefa com demand_id divergente do pai (edição simultânea em dois aparelhos): vale a do pai.
          pushTo(allByDemand, demandId, task.demand_id === demandId ? task : Object.freeze({ ...task, demand_id: demandId }));
        }
      }
      for (const list of topByDemand.values()) list.sort(bySortOrder);
      for (const list of subsByParent.values()) list.sort(bySortOrder);

      return deepFreeze({
        projectsById,
        demandsById,
        demandArchived,
        demandsForDomain,
        tasksById,
        info,
        visible,
        visibleWithArchived,
        topByDemand,
        subsByParent,
        allByDemand,
      });
    });
  }

  /** Aceita (tipo, entidade|id) ou só (entidade): devolve o tipo e a linha ATUAL do banco. */
  function resolveEntity(a, b) {
    let type = null;
    let ref = null;
    if (a === 'task' || a === 'demand' || a === 'project') {
      type = a;
      ref = b;
    } else if (a && typeof a === 'object') {
      type = inferType(a);
      ref = a;
    }
    if (!type || ref === null || ref === undefined) return { type, entity: null, given: null };
    const id = typeof ref === 'object' ? ref.id : ref;
    const row = hasId(id) ? store.get(ENTITY_TABLE[type], id) : undefined;
    return { type, entity: row || null, given: typeof ref === 'object' ? ref : row || null };
  }

  const liveRow = (table, id) => {
    if (!hasId(id)) return null;
    const row = store.get(table, id);
    return row && !row.deleted_at ? row : null;
  };

  const taskIdOf = (task) => (task !== null && typeof task === 'object' ? task.id : task);

  // --- grafo de dependências ----------------------------------------------------------------------
  function graph() {
    return memo('graph', () => deepFreeze(buildGraph(store.all('tasks'), store.all('task_dependencies'))));
  }

  function dependencyCtx() {
    const s = struct();
    return { graph: graph(), tasksById: s.tasksById, statuses: statuses(), demandsById: s.demandsForDomain };
  }

  function neighbourRows(adjacency, taskId, key) {
    return memo(`${key}|${taskId}`, () => {
      const ids = adjacency.get(taskId);
      if (!ids || !ids.size) return EMPTY;
      const byId = struct().tasksById;
      const rows = [];
      for (const id of ids) {
        const row = byId.get(id);
        if (row) rows.push(row);
      }
      return Object.freeze(rows);
    });
  }

  function conflicts() {
    const day = today();
    const hours = hoursPerDay();
    return memo(`conflicts|${day}|${hours}`, () =>
      deepFreeze(
        scheduleConflicts({
          tasks: store.all('tasks'),
          graph: graph(),
          statuses: statuses(),
          today: day,
          hoursPerDay: hours,
          demandsById: struct().demandsForDomain,
        }),
      ),
    );
  }

  // --- tempo ---------------------------------------------------------------------------------------
  function newestFirst(a, b) {
    const ka = String(a.started_at || a.created_at || '');
    const kb = String(b.started_at || b.created_at || '');
    return cmpText(kb, ka) || cmpText(String(b.created_at || ''), String(a.created_at || '')) || cmpText(String(b.id), String(a.id));
  }

  function timeIndex() {
    return memo('time', () => {
      const s = struct();
      const byTask = new Map();
      const counted = [];
      for (const entry of store.all('time_entries')) {
        if (!hasId(entry.task_id)) continue;
        pushTo(byTask, entry.task_id, entry);
        // Apontamento de tarefa excluída (ela ou a demanda) fica fora dos totais; de tarefa ainda
        // desconhecida neste aparelho, conta (o tempo foi trabalhado).
        const row = store.get('tasks', entry.task_id);
        if (row && (row.deleted_at || s.info.get(row.id).deleted)) continue;
        counted.push(entry);
      }
      for (const list of byTask.values()) list.sort(newestFirst);
      const open = activeTimers(counted).filter((entry) => s.tasksById.has(entry.task_id));
      const running = open.some((entry) => timerState(entry) === TIMER.RUNNING);
      return deepFreeze({ byTask, counted, open, running });
    });
  }

  function entriesOfTask(taskId) {
    return timeIndex().byTask.get(taskId) || EMPTY;
  }

  function secondsOf(taskId, ms) {
    let total = 0;
    for (const entry of entriesOfTask(taskId)) total += elapsedSeconds(entry, ms);
    return total;
  }

  // --- histórico -----------------------------------------------------------------------------------
  function eventsIndex() {
    return memo('events', () => deepFreeze(indexEvents(store.all('activity_log'))));
  }

  // --- semana --------------------------------------------------------------------------------------
  /** Segunda-feira da semana pedida; valor ausente ou inválido cai na semana corrente. */
  const weekKey = (weekStart) => startOfWeek(isValidDateStr(weekStart) ? weekStart : today());
  /**
   * Parte da chave de memorização dos resumos da semana. Na semana corrente a referência é "agora" (eventos
   * vindos de um aparelho com o relógio adiantado só passam a valer quando o relógio chega neles), então o
   * cache vale por minuto; nas outras semanas basta o dia (fase passada/futura e "hoje").
   */
  const weekStamp = (week) => {
    const day = today();
    return day >= week && day <= addDays(week, 6) ? `${day}|${nowIso().slice(0, 16)}` : day;
  };

  function allTasksMap() {
    return memo('allTasksMap', () => {
      const map = new Map();
      for (const task of store.all('tasks', { includeDeleted: true })) map.set(task.id, task);
      return lock(map);
    });
  }

  // --- prazo (cache por entidade) ------------------------------------------------------------------------
  let deadlineKey = null;
  let deadlineStatuses = null;
  let deadlineCache = new WeakMap();

  // --- busca -----------------------------------------------------------------------------------------
  function searchIndex() {
    return memo('searchIndex', () => {
      const s = struct();
      const list = statuses();
      const items = [];
      const add = (type, entity) => {
        const code = entityCode(type, entity).toLowerCase();
        items.push({
          type,
          entity,
          name: normalizeText(entity.name).trim(),
          code,
          seq: entity.seq == null ? '' : String(entity.seq),
          tags: Array.isArray(entity.tags) ? entity.tags.map((tag) => normalizeText(tag).trim()) : EMPTY,
          open: !isClosed(entity, list),
        });
      };
      for (const demand of s.demandsById.values()) if (!s.demandArchived.get(demand.id)) add('demand', demand);
      for (const task of s.visible) add('task', task);
      return items;
    });
  }

  /** Pontos de um termo num item (0 = o termo não aparece em nome, código ou tags). */
  function termScore(item, term) {
    let best = 0;
    if (item.code && (item.code === term || item.seq === term || `#${item.seq}` === term)) best = 100;
    else if (item.code && term.length > 1 && item.code.startsWith(term)) best = 70;
    if (item.name) {
      let points = 0;
      if (item.name === term) points = 90;
      else if (item.name.startsWith(term)) points = 60;
      else if (item.name.includes(` ${term}`)) points = 45;
      else if (item.name.includes(term)) points = 30;
      if (points > best) best = points;
    }
    for (const tag of item.tags) {
      const points = tag === term ? 40 : tag.includes(term) ? 20 : 0;
      if (points > best) best = points;
    }
    return best;
  }

  // --- métricas (cache próprio, pequeno) -------------------------------------------------------------------
  const metricsCache = new Map();

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------
  const sel = {
    // ----- status ---------------------------------------------------------------------------------
    /**
     * Lista efetiva de status (padrões + personalização da configuração 'statuses'), ordenada.
     * @returns {ReadonlyArray<object>}
     */
    statuses,

    /**
     * Definição de um status. Id desconhecido devolve um status sintético de categoria "planejada".
     * @param {string} id
     * @returns {object}
     */
    status(id) {
      return Object.freeze(statusById(statuses(), id));
    },

    // ----- entidades ------------------------------------------------------------------------------
    /**
     * Projetos não excluídos, por ordem manual e depois nome.
     * @param {{ includeArchived?: boolean }} [options]
     * @returns {ReadonlyArray<object>}
     */
    projects(options) {
      const { includeArchived = false } = options || {};
      return memo(`projects|${includeArchived ? 1 : 0}`, () => {
        const list = store.all('projects').filter((p) => includeArchived || !p.archived_at);
        return Object.freeze(list.sort(byProjectOrder));
      });
    },

    /** @param {string} id @returns {object|null} projeto, ou null se não existe ou foi excluído */
    project: (id) => liveRow('projects', id),
    /** @param {string} id @returns {object|null} demanda, ou null se não existe ou foi excluída */
    demand: (id) => liveRow('demands', id),
    /** @param {string} id @returns {object|null} tarefa, ou null se não existe ou foi excluída */
    task: (id) => liveRow('tasks', id),

    /**
     * Linha de qualquer tipo de entidade.
     * @param {'project'|'demand'|'task'} type
     * @param {string} id
     * @returns {object|null} null quando o tipo é desconhecido, a linha não existe ou foi excluída
     */
    entity(type, id) {
      const table = ENTITY_TABLE[type];
      return table ? liveRow(table, id) : null;
    },

    /**
     * Demandas não excluídas, em ordem manual.
     * @param {{ includeArchived?: boolean, projectId?: string|null }} [options]
     *        includeArchived: inclui as arquivadas (arquivamento próprio ou do projeto);
     *        projectId: id do projeto; '' = só as sem projeto; null/undefined = todas.
     * @returns {ReadonlyArray<object>}
     */
    demands(options) {
      const { includeArchived = false, projectId } = options || {};
      const scope = projectId === null || projectId === undefined ? '*' : String(projectId);
      return memo(`demands|${includeArchived ? 1 : 0}|${scope}`, () => {
        const s = struct();
        const out = [];
        for (const demand of s.demandsById.values()) {
          if (!includeArchived && s.demandArchived.get(demand.id)) continue;
          if (scope !== '*') {
            const own = hasId(demand.project_id) && s.projectsById.has(demand.project_id) ? demand.project_id : '';
            if (own !== scope) continue;
          }
          out.push(demand);
        }
        return Object.freeze(out.sort(bySortOrder));
      });
    },

    /**
     * Todas as tarefas VISÍVEIS, subtarefas inclusive: não excluídas (nem o pai, nem a demanda). As arquivadas
     * (arquivamento próprio, do pai, da demanda ou do projeto) só entram com `includeArchived`.
     * @param {{ includeArchived?: boolean }} [options]
     * @returns {ReadonlyArray<object>} na ordem de criação
     */
    tasks(options) {
      const { includeArchived = false } = options || {};
      const s = struct();
      return includeArchived ? s.visibleWithArchived : s.visible;
    },

    /**
     * Tarefas visíveis de NÍVEL SUPERIOR de uma demanda, em ordem manual.
     * @param {string|null} demandId id da demanda; null/'' = tarefas avulsas (sem demanda)
     * @param {{ includeArchived?: boolean }} [options]
     * @returns {ReadonlyArray<object>}
     */
    topTasks(demandId, options) {
      const { includeArchived = false } = options || {};
      const key = hasId(demandId) ? demandId : '';
      return memo(`top|${includeArchived ? 1 : 0}|${key}`, () => {
        const s = struct();
        const list = s.topByDemand.get(key);
        if (!list) return EMPTY;
        if (includeArchived) return list;
        return Object.freeze(list.filter((task) => !s.info.get(task.id).archived));
      });
    },

    /** Sinônimo de `topTasks` (nome usado em docs/ARQUITETURA.md). */
    tasksOfDemand(demandId, options) {
      return sel.topTasks(demandId, options);
    },

    /**
     * Subtarefas visíveis de uma tarefa, em ordem manual.
     * @param {string} taskId
     * @param {{ includeArchived?: boolean }} [options]
     * @returns {ReadonlyArray<object>}
     */
    subtasks(taskId, options) {
      const { includeArchived = false } = options || {};
      return memo(`subs|${includeArchived ? 1 : 0}|${taskId}`, () => {
        const s = struct();
        const list = s.subsByParent.get(taskId);
        if (!list) return EMPTY;
        if (includeArchived) return list;
        return Object.freeze(list.filter((task) => !s.info.get(task.id).archived));
      });
    },

    /**
     * Todas as tarefas não excluídas de uma demanda — subtarefas e arquivadas inclusive (entrada do cálculo
     * de progresso).
     * @param {string} demandId
     * @returns {ReadonlyArray<object>}
     */
    allTasksOfDemand(demandId) {
      return struct().allByDemand.get(demandId) || EMPTY;
    },

    /**
     * Tarefa-pai de uma subtarefa.
     * @param {object|string} task tarefa ou id
     * @returns {object|null} null quando a tarefa é de nível superior (ou o pai não existe/foi excluído)
     */
    parentOf(task) {
      const entry = struct().info.get(taskIdOf(task));
      return entry ? entry.parent : null;
    },

    /**
     * Demanda de uma tarefa (a de uma subtarefa é a do pai).
     * @param {object|string} task tarefa ou id
     * @returns {object|null} null para tarefa avulsa ou demanda inexistente/excluída
     */
    demandOf(task) {
      const entry = struct().info.get(taskIdOf(task));
      return entry ? entry.demand : null;
    },

    /**
     * Projeto de uma entidade: o da demanda (tarefas e demandas) ou o próprio projeto.
     * @param {'task'|'demand'|'project'|object} type tipo — ou a própria entidade, e o tipo é deduzido
     * @param {object|string} [entity] entidade ou id
     * @returns {object|null} null quando não há projeto (ou ele foi excluído)
     */
    projectOf(type, entity) {
      const { type: kind, entity: row } = resolveEntity(type, entity);
      if (!row || row.deleted_at) return null;
      if (kind === 'project') return row;
      const demand = kind === 'demand' ? row : sel.demandOf(row);
      return demand ? liveRow('projects', demand.project_id) : null;
    },

    /**
     * Id do projeto de uma entidade (ver projectOf).
     * @param {'task'|'demand'|'project'|object} type
     * @param {object|string} [entity]
     * @returns {string|null}
     */
    projectIdOf(type, entity) {
      const project = sel.projectOf(type, entity);
      return project ? project.id : null;
    },

    /**
     * A entidade está oculta? (excluída ou arquivada — por si mesma ou por herança do pai/demanda/projeto)
     * @param {'task'|'demand'|'project'|object} type tipo — ou a própria entidade
     * @param {object|string} [entity] entidade ou id
     * @returns {boolean} true também para entidade inexistente
     */
    isHidden(type, entity) {
      const { type: kind, entity: row } = resolveEntity(type, entity);
      if (!row || row.deleted_at) return true;
      if (kind === 'project') return !!row.archived_at;
      const s = struct();
      if (kind === 'demand') return s.demandArchived.get(row.id) === true;
      const entry = s.info.get(row.id);
      return !entry || entry.deleted || entry.archived;
    },

    /**
     * Código legível: 'T-12' (tarefa) / 'D-3' (demanda); '' sem número.
     * @param {'task'|'demand'|object} type tipo — ou a própria entidade
     * @param {object|string} [entity]
     * @returns {string}
     */
    code(type, entity) {
      const { type: kind, given } = resolveEntity(type, entity);
      return given ? entityCode(kind, given) : '';
    },

    /** @returns {ReadonlyMap<string, object>} id → tarefa (não excluídas) */
    tasksById: () => struct().tasksById,
    /** @returns {ReadonlyMap<string, object>} id → demanda (não excluídas) */
    demandsById: () => struct().demandsById,
    /** @returns {ReadonlyMap<string, object>} id → projeto (não excluídos) */
    projectsById: () => struct().projectsById,

    // ----- dependências ---------------------------------------------------------------------------
    /** @returns {object} grafo de dependências (buildGraph) das tarefas não excluídas */
    graph,

    /** @param {string} taskId @returns {ReadonlyArray<object>} pré-requisitos DIRETOS (tarefas) */
    prereqs: (taskId) => neighbourRows(graph().prereqs, taskId, 'prereqs'),

    /** @param {string} taskId @returns {ReadonlyArray<object>} tarefas que dependem DIRETAMENTE desta */
    dependents: (taskId) => neighbourRows(graph().dependents, taskId, 'dependents'),

    /**
     * Pré-requisitos diretos que ainda bloqueiam a tarefa (abertos e visíveis), por prazo e prioridade.
     * @param {string} taskId
     * @returns {ReadonlyArray<object>}
     */
    blockers(taskId) {
      return memo(`blockers|${taskId}`, () => Object.freeze(blockingPrereqs(taskId, dependencyCtx())));
    },

    /**
     * A tarefa está bloqueada por dependência? (aberta e com pré-requisito ainda aberto)
     * @param {string|object} taskId id ou tarefa
     * @returns {boolean}
     */
    isBlockedByDependency(taskId) {
      const id = taskIdOf(taskId);
      return memo(`blocked|${id}`, () => isBlockedByDependency(id, dependencyCtx()));
    },

    /** @returns {ReadonlyMap<string, ReadonlyArray<object>>} conflitos de prazo por tarefa (scheduleConflicts) */
    conflicts,

    /** @param {string} taskId @returns {ReadonlyArray<object>} conflitos de prazo da tarefa ([] se não há) */
    conflictsOf: (taskId) => conflicts().get(taskId) || EMPTY,

    /** @returns {ReadonlyArray<ReadonlyArray<string>>} ciclos de dependência existentes (dados danificados) */
    cycles: () => memo('cycles', () => deepFreeze(findCycles(graph()))),

    /** @param {string} taskId @returns {number} quantas tarefas dependem dela, direta ou transitivamente */
    downstreamCount: (taskId) => memo(`down|${taskId}`, () => downstreamCount(taskId, graph())),

    // ----- tempo ----------------------------------------------------------------------------------
    /** @param {string} taskId @returns {ReadonlyArray<object>} apontamentos não excluídos, do mais novo para o mais antigo */
    entriesOfTask,

    /**
     * Cronômetros em aberto (rodando ou pausados) de tarefas existentes, do mais antigo para o mais novo.
     * @returns {ReadonlyArray<object>}
     */
    activeTimers: () => timeIndex().open,

    /**
     * Cronômetro em aberto da tarefa (o que está rodando tem preferência sobre um pausado).
     * @param {string} taskId
     * @returns {object|null}
     */
    timerOf(taskId) {
      return memo(`timer|${taskId}`, () => {
        let paused = null;
        for (const entry of entriesOfTask(taskId)) {
          const state = timerState(entry);
          if (state === TIMER.RUNNING) return entry;
          if (state === TIMER.PAUSED && !paused) paused = entry;
        }
        return paused;
      });
    },

    /**
     * Segundos apontados numa tarefa, contando o trecho em curso de um cronômetro rodando.
     * @param {string} taskId
     * @param {{ withSubtasks?: boolean }} [options] soma também as subtarefas (não excluídas)
     * @returns {number}
     */
    trackedSeconds(taskId, options) {
      const { withSubtasks = false } = options || {};
      const ms = nowMs();
      let total = secondsOf(taskId, ms);
      if (withSubtasks) {
        for (const sub of struct().subsByParent.get(taskId) || EMPTY) total += secondsOf(sub.id, ms);
      }
      return total;
    },

    /**
     * Segundos apontados em todas as tarefas (e subtarefas) não excluídas de uma demanda.
     * @param {string} demandId
     * @returns {number}
     */
    trackedSecondsOfDemand(demandId) {
      const ms = nowMs();
      let total = 0;
      for (const task of sel.allTasksOfDemand(demandId)) total += secondsOf(task.id, ms);
      return total;
    },

    /**
     * Resumo do tempo apontado (por tarefa, demanda, projeto e dia), com período opcional.
     * @param {{ from?: string, to?: string, projectId?: string|null, demandId?: string|null }} [range] limites
     *        inclusivos ('YYYY-MM-DD') do dia do apontamento; projectId/demandId restringem às tarefas daquele
     *        projeto/demanda (null = sem projeto/sem demanda; ausente = todos)
     * @returns {{ total: number, count: number, byTask: ReadonlyMap, byDemand: ReadonlyMap, byProject: ReadonlyMap, byDay: ReadonlyMap }}
     */
    timeSummary(range) {
      const { from, to, projectId, demandId } = range || {};
      const index = timeIndex();
      const compute = () => {
        const s = struct();
        return deepFreeze(summarize({ entries: index.counted, tasksById: s.tasksById, demandsById: s.demandsById, nowMs: nowMs(), from, to, projectId, demandId }));
      };
      const scope = (value) => (value === undefined ? '*' : `=${value || ''}`);
      const key = `timeSummary|${from || ''}|${to || ''}|${scope(projectId)}|${scope(demandId)}`;
      return index.running ? memoLive(key, compute) : memo(key, compute);
    },

    // ----- progresso ------------------------------------------------------------------------------
    /**
     * Progresso de uma demanda (regra 14: pesos, subtarefas, canceladas/arquivadas/opcionais à parte).
     * @param {string} demandId
     * @returns {object} resultado de demandProgress (value null = sem tarefas contáveis)
     */
    demandProgress(demandId) {
      return memo(`progress|${demandId}`, () => deepFreeze(demandProgress(liveRow('demands', demandId), sel.allTasksOfDemand(demandId), { statuses: statuses() })));
    },

    /**
     * Fração concluída de uma tarefa (pelas subtarefas, quando ela ainda não está concluída).
     * @param {string} taskId
     * @returns {{ value: number, done: boolean, source: string, counted: number, completed: number }}
     */
    taskFraction(taskId) {
      return memo(`fraction|${taskId}`, () => deepFreeze(taskFraction(liveRow('tasks', taskId), struct().subsByParent.get(taskId) || EMPTY, { statuses: statuses() })));
    },

    /**
     * Progresso de um projeto: média das demandas não arquivadas e não canceladas.
     * @param {string} projectId
     * @returns {{ value: number|null, percent: number|null, counted: number }}
     */
    projectProgress(projectId) {
      return memo(`projectProgress|${projectId}`, () => {
        const list = statuses();
        const entries = [];
        for (const demand of sel.demands({ includeArchived: true, projectId })) {
          if (demand.archived_at || isCancelled(demand, list)) continue;
          entries.push(sel.demandProgress(demand.id));
        }
        return deepFreeze(projectProgress(entries));
      });
    },

    // ----- prazos ---------------------------------------------------------------------------------
    /**
     * Indicador de prazo de uma demanda ou tarefa, com "hoje" do relógio do app e a configuração
     * 'deadline.soonDays'.
     * @param {object|null} entity
     * @returns {object} resultado de deadlineInfo
     */
    deadline(entity) {
      const list = statuses();
      const key = `${today()}|${soonDays()}`;
      if (key !== deadlineKey || list !== deadlineStatuses) {
        deadlineKey = key;
        deadlineStatuses = list;
        deadlineCache = new WeakMap();
      }
      const isObject = entity !== null && typeof entity === 'object';
      if (isObject) {
        const cached = deadlineCache.get(entity);
        if (cached) return cached;
      }
      const info = Object.freeze(deadlineInfo(isObject ? entity : null, { today: today(), statuses: list, soonDays: soonDays() }));
      if (isObject) deadlineCache.set(entity, info);
      return info;
    },

    /**
     * Alertas de vencimento das tarefas E demandas abertas e visíveis, em faixas exclusivas.
     * @returns {{ overdue: ReadonlyArray<{type: string, entity: object}>, today: ReadonlyArray, next3: ReadonlyArray, next7: ReadonlyArray }}
     */
    dueBuckets() {
      const day = today();
      return memo(`dueBuckets|${day}`, () => {
        const s = struct();
        const types = new Map();
        for (const demand of s.demandsById.values()) if (!s.demandArchived.get(demand.id)) types.set(demand, 'demand');
        for (const task of s.visible) types.set(task, 'task');
        const buckets = bucketsOf(types.keys(), { today: day, statuses: statuses() });
        const out = {};
        for (const [name, list] of Object.entries(buckets)) out[name] = list.map((entity) => ({ type: types.get(entity), entity }));
        return deepFreeze(out);
      });
    },

    // ----- observações e histórico ----------------------------------------------------------------------
    /**
     * Observações não excluídas de uma entidade, da mais nova para a mais antiga.
     * @param {'demand'|'task'|'project'} type
     * @param {string} id
     * @returns {ReadonlyArray<object>}
     */
    notes(type, id) {
      return memo(`notes|${type}|${id}`, () => {
        const list = store.byIndex('notes', 'entity_id', id).filter((note) => note.entity_type === type);
        if (!list.length) return EMPTY;
        return Object.freeze(list.sort((a, b) => cmpText(String(b.created_at || ''), String(a.created_at || '')) || cmpText(String(b.id), String(a.id))));
      });
    },

    /**
     * Links não removidos de uma entidade, na ordem de exibição (sort_order, depois created_at).
     * @param {'demand'|'task'|'project'} type
     * @param {string} id
     * @returns {ReadonlyArray<object>}
     */
    links(type, id) {
      return memo(`links|${type}|${id}`, () => {
        const list = store.byIndex('links', 'entity_id', id).filter((link) => link.entity_type === type);
        if (!list.length) return EMPTY;
        return Object.freeze(list.sort(compareLinks));
      });
    },

    /**
     * Histórico (activity_log) de uma entidade, do evento mais novo para o mais antigo.
     * @param {'demand'|'task'|'project'} type
     * @param {string} id
     * @returns {ReadonlyArray<object>}
     */
    history(type, id) {
      return memo(`history|${type}|${id}`, () => {
        const events = eventsIndex().get(`${type}:${id}`);
        if (!events || !events.length) return EMPTY;
        // Eventos do mesmo instante (ex.: criação + dependência copiada ao duplicar): a criação vem antes.
        const ordered = [...events].sort((a, b) => cmpText(String(a.at || ''), String(b.at || '')) || createdFirst(a) - createdFirst(b));
        return Object.freeze(ordered.reverse());
      });
    },

    /** @returns {ReadonlyMap<string, ReadonlyArray<object>>} índice 'tipo:id' → eventos em ordem cronológica */
    eventsIndex,

    // ----- valores em uso ---------------------------------------------------------------------------
    /** @returns {ReadonlyArray<string>} tags em uso em demandas e tarefas não excluídas, em ordem alfabética */
    tags() {
      return memo('tags', () => {
        const byKey = new Map();
        const collect = (rows) => {
          for (const row of rows) {
            if (!Array.isArray(row.tags)) continue;
            for (const tag of row.tags) {
              const text = typeof tag === 'string' ? tag.trim() : '';
              const key = text.toLowerCase();
              if (text && !byKey.has(key)) byKey.set(key, text);
            }
          }
        };
        collect(store.all('demands'));
        collect(store.all('tasks'));
        return Object.freeze([...byKey.values()].sort(NAME_COLLATOR.compare));
      });
    },

    /** @returns {ReadonlyArray<string>} responsáveis em uso em demandas e tarefas não excluídas */
    owners() {
      return memo('owners', () => {
        const byKey = new Map();
        for (const table of ['demands', 'tasks']) {
          for (const row of store.all(table)) {
            const text = typeof row.owner === 'string' ? row.owner.trim() : '';
            const key = text.toLowerCase();
            if (text && !byKey.has(key)) byKey.set(key, text);
          }
        }
        return Object.freeze([...byKey.values()].sort(NAME_COLLATOR.compare));
      });
    },

    /**
     * Pessoas conhecidas (responsáveis e "aguardando" de demandas e tarefas não excluídas), agrupadas sem
     * diferenciar acentos/maiúsculas; a grafia exibida é a mais recente.
     * @returns {ReadonlyArray<{ key: string, name: string, count: number, owner: number, waiting: number }>}
     */
    people() {
      return memo('people', () => {
        const entries = [];
        for (const table of ['demands', 'tasks']) {
          for (const row of store.all(table)) {
            const at = String(row.updated_at || row.created_at || '');
            if (personName(row.owner)) entries.push({ name: row.owner, at, role: 'owner' });
            if (personName(row.waiting_on)) entries.push({ name: row.waiting_on, at, role: 'waiting' });
          }
        }
        return deepFreeze(collectPeople(entries));
      });
    },

    /**
     * Quadro "Aguardando": itens abertos e visíveis agrupados por pessoa.
     *   waiting — categoria 'waiting' (pessoa = waiting_on; vazio = "Sem pessoa definida");
     *   others  — demais itens abertos cujo responsável é outra pessoa (owner ≠ 'owner.default').
     * Cada item: { key, type, entity, code, person, since, waitingDays, followUp, lastFollowUpAt, lastFollowUpNote }.
     * Grupos ordenados por cobranças vencidas, depois quantidade e nome; itens por "Cobrar em" e espera.
     * @returns {{ waiting: Array, others: Array, waitingCount: number, othersCount: number, dueCount: number }}
     */
    waitingBoard() {
      const day = today();
      return memo(`waitingBoard|${day}`, () => {
        const list = statuses();
        const index = eventsIndex();
        const now = nowIso();
        const defaultOwner = setting('owner.default');
        const waiting = new Map();
        const others = new Map();
        let dueCount = 0;
        const add = (groups, name, item) => {
          const key = personKey(name) || '';
          let group = groups.get(key);
          if (!group) groups.set(key, (group = { key, name: personName(name) || 'Sem pessoa definida', items: [], dueCount: 0, latest: '' }));
          if (item.entity.updated_at && item.entity.updated_at >= group.latest && personName(name)) {
            group.latest = item.entity.updated_at;
            group.name = personName(name);
          }
          group.items.push(item);
          if (item.due) group.dueCount += 1;
        };
        const visit = (type, rows) => {
          for (const row of rows) {
            if (!isOpen(row, list)) continue;
            const category = statusById(list, row.status).category;
            const inWaiting = category === 'waiting';
            if (!inWaiting && !isOtherOwner(row.owner, defaultOwner)) continue;
            const events = index.get(`${type}:${row.id}`) || EMPTY;
            const since = waitingSince(row, events, { statuses: list, nowIso: now, mode: inWaiting ? 'waiting' : 'owner' });
            const last = lastFollowUp(events);
            const due = isFollowUpDue(row.follow_up_date, day);
            if (due) dueCount += 1;
            const person = personName(inWaiting ? row.waiting_on : row.owner);
            const item = {
              key: `${type}:${row.id}`,
              type,
              entity: row,
              code: entityCode(type, row),
              person,
              since,
              waitingDays: daysSince(since, day),
              followUp: followUpInfo(row.follow_up_date, day),
              due,
              lastFollowUpAt: last ? last.at : null,
              lastFollowUpNote: last && last.meta && typeof last.meta.note === 'string' ? last.meta.note : null,
            };
            add(inWaiting ? waiting : others, person, item);
          }
        };
        visit('demand', sel.demands());
        visit('task', sel.tasks());
        const order = (groups) => {
          const out = [...groups.values()].map(({ latest, ...g }) => {
            g.items.sort((a, b) => {
              const fa = a.entity.follow_up_date || '9999-99-99';
              const fb = b.entity.follow_up_date || '9999-99-99';
              return cmpText(fa, fb) || b.waitingDays - a.waitingDays || NAME_COLLATOR.compare(String(a.entity.name || ''), String(b.entity.name || ''));
            });
            return { ...g, count: g.items.length };
          });
          out.sort((a, b) => (a.key === '') - (b.key === '') || b.dueCount - a.dueCount || b.count - a.count || NAME_COLLATOR.compare(a.name, b.name));
          return out;
        };
        const w = order(waiting);
        const o = order(others);
        return deepFreeze({
          waiting: w,
          others: o,
          waitingCount: w.reduce((n, g) => n + g.count, 0),
          othersCount: o.reduce((n, g) => n + g.count, 0),
          dueCount,
        });
      });
    },

    /** @returns {number} cobranças vencidas ou para hoje (selo da tela "Aguardando") */
    followUpDueCount() {
      return sel.waitingBoard().dueCount;
    },

    /** @returns {ReadonlyArray<string>} categorias em uso nas demandas não excluídas */
    categories() {
      return memo('categories', () => {
        const byKey = new Map();
        for (const row of store.all('demands')) {
          const text = typeof row.category === 'string' ? row.category.trim() : '';
          const key = text.toLowerCase();
          if (text && !byKey.has(key)) byKey.set(key, text);
        }
        return Object.freeze([...byKey.values()].sort(NAME_COLLATOR.compare));
      });
    },

    // ----- semana ---------------------------------------------------------------------------------
    /**
     * Plano vigente da semana: itens não retirados, um por tarefa, só de tarefas visíveis.
     * @param {string} [weekStart] qualquer dia da semana (padrão: semana corrente)
     * @returns {ReadonlyArray<object>} linhas de week_items em ordem de entrada no plano
     */
    weekItems(weekStart) {
      const week = weekKey(weekStart);
      return memo(`weekItems|${week}`, () => {
        const s = struct();
        const items = activeWeekItems(store.all('week_items'), week).filter((item) => {
          const entry = s.info.get(item.task_id);
          return !!entry && !entry.deleted && !entry.archived;
        });
        return Object.freeze(items);
      });
    },

    /**
     * Resumo "planejado × realizado" da semana (weekSummary do domínio, lendo o histórico de status).
     * @param {string} [weekStart]
     * @returns {object}
     */
    weekSummary(weekStart) {
      const week = weekKey(weekStart);
      return memo(`weekSummary|${week}|${weekStamp(week)}`, () =>
        deepFreeze(
          weekSummary({
            weekStart: week,
            items: store.all('week_items'),
            tasksById: allTasksMap(),
            eventsIndex: eventsIndex(),
            statuses: statuses(),
            nowIso: nowIso(),
          }),
        ),
      );
    },

    /**
     * Listas da tela "Minha Semana": programadas, prioritárias, atrasadas, próximos vencimentos, bloqueadas e
     * concluídas na semana.
     * @param {string} [weekStart]
     * @returns {{ scheduled: ReadonlyArray, priority: ReadonlyArray, overdue: ReadonlyArray, upcoming: ReadonlyArray, blocked: ReadonlyArray, completed: ReadonlyArray }}
     */
    weekSections(weekStart) {
      const week = weekKey(weekStart);
      const day = today();
      return memo(`weekSections|${week}|${weekStamp(week)}`, () =>
        deepFreeze(
          weekSections({
            weekStart: week,
            tasks: struct().visible,
            items: store.all('week_items'),
            graph: graph(),
            statuses: statuses(),
            today: day,
            eventsIndex: eventsIndex(),
            nowIso: nowIso(),
          }),
        ),
      );
    },

    /**
     * Item do plano vigente de uma tarefa numa semana.
     * @param {string} taskId
     * @param {string} [weekStart] padrão: semana corrente
     * @returns {object|null}
     */
    weekOfTask(taskId, weekStart) {
      const week = weekKey(weekStart);
      const byTask = memo(`weekByTask|${week}`, () => {
        const map = new Map();
        for (const item of activeWeekItems(store.all('week_items'), week)) map.set(item.task_id, item);
        return lock(map);
      });
      return byTask.get(taskId) || null;
    },

    /**
     * Todas as linhas (não excluídas) de week_items de uma tarefa numa semana, inclusive as retiradas e os
     * duplicados vindos de outro aparelho. É o "retrato" que o Desfazer de mover/transferir entrega a
     * cmd.undoWeekMove para devolver a semana exatamente como estava.
     * @param {string} taskId
     * @param {string} [weekStart] padrão: semana corrente
     * @returns {ReadonlyArray<object>}
     */
    weekItemRows(taskId, weekStart) {
      const week = weekKey(weekStart);
      const end = addDays(week, 6);
      if (!hasId(taskId)) return Object.freeze([]);
      return Object.freeze(store.byIndex('week_items', 'task_id', taskId).filter((item) => typeof item.week_start === 'string' && item.week_start >= week && item.week_start <= end));
    },

    /**
     * Carga do plano da semana frente à capacidade semanal (configuração 'capacity.hoursPerWeek').
     * @param {string} [weekStart]
     * @returns {{ plannedMinutes: number, capacityMinutes: number, ratio: number|null, unestimated: number, count: number }}
     */
    weekLoad(weekStart) {
      const week = weekKey(weekStart);
      const hours = hoursPerWeek();
      return memo(`weekLoad|${week}|${hours}`, () =>
        Object.freeze(planLoad({ items: sel.weekItems(week), tasksById: struct().tasksById, statuses: statuses(), weekStart: week, hoursPerWeek: hours })),
      );
    },

    // ----- próximas ações e sugestões -----------------------------------------------------------------
    /**
     * "Próximas ações": tarefas abertas e visíveis que mais merecem atenção, pontuadas e explicadas.
     * @param {number} [limit=10] tamanho máximo da lista (Infinity = sem limite)
     * @returns {ReadonlyArray<{ task: object, score: number, group: 'do'|'unblock', reasons: ReadonlyArray }>}
     */
    nextActions(limit = 10) {
      const day = today();
      const soon = soonDays();
      return memo(`nextActions|${day}|${soon}|${limit}`, () => {
        const s = struct();
        return deepFreeze(nextActions({ tasks: s.visible, demandsById: s.demandsForDomain, graph: graph(), statuses: statuses(), today: day, limit, soonDays: soon }));
      });
    },

    /**
     * Recomendações de prioridade ainda não dispensadas (o sistema nunca altera prioridade sozinho).
     * @returns {ReadonlyArray<object>}
     */
    prioritySuggestions() {
      const day = today();
      const soon = soonDays();
      const hours = hoursPerDay();
      return memo(`suggestions|${day}|${soon}|${hours}`, () => {
        const s = struct();
        const dismissed = setting('suggestions.dismissed');
        return deepFreeze(
          prioritySuggestions({
            tasks: s.visible,
            demandsById: s.demandsForDomain,
            graph: graph(),
            statuses: statuses(),
            today: day,
            dismissed: Array.isArray(dismissed) ? dismissed : EMPTY,
            nowIso: nowIso(),
            soonDays: soon,
            hoursPerDay: hours,
            trackedSecondsByTask: totalsByTask(timeIndex().counted, { nowMs: nowMs() }),
          }),
        );
      });
    },

    /**
     * Sugestão de prioridade (não dispensada) de uma tarefa.
     * @param {string} taskId
     * @returns {object|null}
     */
    suggestionFor(taskId) {
      const byTask = memo(`suggestionByTask|${today()}`, () => {
        const map = new Map();
        for (const suggestion of sel.prioritySuggestions()) map.set(suggestion.taskId, suggestion);
        return lock(map);
      });
      return byTask.get(taskId) || null;
    },

    // ----- métricas -------------------------------------------------------------------------------
    /**
     * Indicadores de um período (computeMetrics), calculados a partir do histórico.
     * @param {{ range?: { from: string, to: string }, filters?: { projectId?: string|null, demandId?: string, statusIds?: string[] } }} [options]
     *        range padrão: os últimos 30 dias até hoje.
     * @returns {object} resultado de computeMetrics (o mesmo objeto enquanto nada mudar, por até um minuto)
     */
    metrics(options) {
      const { range, filters } = options || {};
      const day = today();
      const period = range && isValidDateStr(range.from) && isValidDateStr(range.to) ? { from: range.from, to: range.to } : { from: addDays(day, -(DEFAULT_METRICS_DAYS - 1)), to: day };
      const f = filters && typeof filters === 'object' ? filters : {};
      const clean = {
        projectId: f.projectId === undefined ? null : f.projectId,
        demandId: f.demandId || null,
        statusIds: Array.isArray(f.statusIds) && f.statusIds.length ? [...f.statusIds].sort() : null,
      };
      // Durações "em aberto" (bloqueios, cronômetros) crescem com o relógio: o cache vale por um minuto.
      const key = `${store.version()}|${Math.floor(nowMs() / 60000)}|${period.from}|${period.to}|${JSON.stringify(clean)}`;
      const cached = metricsCache.get(key);
      if (cached) return cached;
      const result = deepFreeze(
        computeMetrics({
          tasks: store.all('tasks', { includeDeleted: true }),
          demands: store.all('demands', { includeDeleted: true }),
          projects: store.all('projects', { includeDeleted: true }),
          dependencies: store.all('task_dependencies', { includeDeleted: true }),
          timeEntries: store.all('time_entries', { includeDeleted: true }),
          weekItems: store.all('week_items', { includeDeleted: true }),
          activity: store.all('activity_log'),
          statuses: statuses(),
          range: period,
          filters: { projectId: clean.projectId, demandId: clean.demandId || undefined, statusIds: clean.statusIds || undefined },
          today: day,
          nowIso: nowIso(),
        }),
      );
      if (metricsCache.size >= METRICS_CACHE_SIZE) metricsCache.delete(metricsCache.keys().next().value);
      metricsCache.set(key, result);
      return result;
    },

    // ----- resumo do dia (lembretes) ---------------------------------------------------------------
    /**
     * "Resumo do dia" (buildDailyDigest do domínio): atrasadas, vencem hoje, próximos vencimentos (dias úteis de
     * 'deadline.soonDays'), cobranças vencidas/hoje e — às segundas — o resumo da semana anterior.
     * @returns {object}
     */
    dailyDigest() {
      const day = today();
      const soon = soonDays();
      return memo(`dailyDigest|${day}|${soon}`, () => {
        const monday = weekdayIndex(day) === 0;
        return buildDailyDigest({
          today: day,
          demands: sel.demands(),
          tasks: sel.tasks(),
          statuses: statuses(),
          soonDays: soon,
          demandsById: struct().demandsById,
          previousWeek: monday ? sel.weekSummary(addDays(day, -7)) : null,
          currentWeekPlanned: monday ? sel.weekItems(day).length : null,
        });
      });
    },

    // ----- relatório de status --------------------------------------------------------------------
    /**
     * Relatório de status (buildStatusReport do domínio) — memorizado por versão do banco, dia, período e projeto.
     * @param {{ range?: {from: string, to: string}, projectId?: string|null }} [options]
     * @returns {object}
     */
    statusReport(options) {
      const { range, projectId } = options || {};
      const day = today();
      const r = range && isValidDateStr(range.from) && isValidDateStr(range.to) ? `${range.from}|${range.to}` : '';
      const pid = projectId === undefined || projectId === null ? '*' : String(projectId);
      return memo(`statusReport|${day}|${r}|${pid}`, () =>
        deepFreeze(
          buildStatusReport({
            range: r ? { from: range.from, to: range.to } : null,
            projectId: pid === '*' ? null : pid,
            demands: sel.demands(),
            tasks: sel.tasks(),
            projects: sel.projects(),
            eventsIndex: eventsIndex(),
            statuses: statuses(),
            weekItems: store.all('week_items'),
            today: day,
            nowIso: nowIso(),
          }),
        ),
      );
    },

    // ----- busca ----------------------------------------------------------------------------------
    /**
     * Busca em demandas e tarefas visíveis por nome, código ('T-12', 'D-3' ou só o número) e tags, sem
     * diferenciar acentos nem maiúsculas. Todos os termos precisam aparecer; as melhores correspondências vêm
     * primeiro (código exato → nome → início de palavra → trecho → tag), abertas antes de encerradas.
     * @param {string} query
     * @param {{ limit?: number }} [options]
     * @returns {ReadonlyArray<{ type: 'demand'|'task', entity: object }>}
     */
    search(query, options) {
      const { limit = 20 } = options || {};
      const terms = normalizeText(query).split(/\s+/).filter(Boolean);
      if (!terms.length) return EMPTY;
      const max = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : Infinity;
      return memo(`search|${max}|${terms.join(' ')}`, () => {
        const whole = terms.join(' ');
        const found = [];
        for (const item of searchIndex()) {
          let score = 0;
          let ok = true;
          for (const term of terms) {
            const points = termScore(item, term);
            if (!points) {
              ok = false;
              break;
            }
            score += points;
          }
          if (!ok) continue;
          if (terms.length > 1 && item.name.includes(whole)) score += 25;
          found.push({ item, score: score / terms.length + (item.open ? 5 : 0) });
        }
        found.sort(
          (a, b) =>
            b.score - a.score ||
            cmpText(String(b.item.entity.updated_at || ''), String(a.item.entity.updated_at || '')) ||
            NAME_COLLATOR.compare(a.item.name, b.item.name) ||
            cmpText(String(a.item.entity.id), String(b.item.entity.id)),
        );
        const top = max === Infinity ? found : found.slice(0, max);
        return deepFreeze(top.map(({ item }) => ({ type: item.type, entity: item.entity })));
      });
    },

    // ----- lixeira --------------------------------------------------------------------------------
    /**
     * Projetos, demandas e tarefas excluídos, da exclusão mais recente para a mais antiga (tela de restauração).
     * Tarefas excluídas JUNTO com a demanda ou com a tarefa-pai (mesmo instante) não aparecem em separado:
     * elas voltam quando a demanda/tarefa-pai é restaurada.
     * @returns {ReadonlyArray<{ type: 'project'|'demand'|'task', entity: object, deletedAt: string }>}
     */
    trash() {
      return memo('trash', () => {
        const out = [];
        for (const project of store.all('projects', { includeDeleted: true })) {
          if (project.deleted_at) out.push({ type: 'project', entity: project, deletedAt: project.deleted_at });
        }
        for (const demand of store.all('demands', { includeDeleted: true })) {
          if (demand.deleted_at) out.push({ type: 'demand', entity: demand, deletedAt: demand.deleted_at });
        }
        for (const task of store.all('tasks', { includeDeleted: true })) {
          if (!task.deleted_at) continue;
          const demand = hasId(task.demand_id) ? store.get('demands', task.demand_id) : null;
          if (demand && demand.deleted_at === task.deleted_at) continue;
          const parent = hasId(task.parent_id) && task.parent_id !== task.id ? store.get('tasks', task.parent_id) : null;
          if (parent && parent.deleted_at === task.deleted_at) continue;
          out.push({ type: 'task', entity: task, deletedAt: task.deleted_at });
        }
        out.sort((a, b) => cmpText(b.deletedAt, a.deletedAt) || cmpText(String(a.entity.id), String(b.entity.id)));
        return deepFreeze(out);
      });
    },
  };

  // `isOpen` é reexportado como utilidade de tela: aberta = nem concluída nem cancelada.
  /**
   * A entidade está aberta (nem concluída nem cancelada) segundo a lista efetiva de status?
   * @param {object|null} entity
   * @returns {boolean}
   */
  sel.isOpen = (entity) => isOpen(entity, statuses());

  return Object.freeze(sel);
}
