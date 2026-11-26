// Grafo de dependências entre tarefas (seção 6 do pedido). Puro: sem DOM, sem banco e sem relógio implícito.
//
// Uma linha de `task_dependencies` { id, task_id, depends_on_id } significa
// "task_id DEPENDE DE depends_on_id" — ou seja, depends_on_id é o PRÉ-REQUISITO.
//
// Vocabulário deste módulo:
//   • tarefa ABERTA  = status de categoria nem "concluída" nem "cancelada" (ver statuses.js);
//   • tarefa VIVA    = aberta e visível: não excluída e não arquivada — nem ela, nem a tarefa-pai (subtarefa
//                      herda), nem a demanda (quando `demandsById` é informado);
//   • pré-requisito que BLOQUEIA = pré-requisito DIRETO que ainda está vivo. Concluído, cancelado, arquivado
//     ou excluído não bloqueia ninguém;
//   • "bloqueada por dependência" não é status: é um estado derivado (tarefa aberta com pré-requisito vivo).
//
// Ciclos são impedidos na criação (validateNewDependency), mas podem chegar pela sincronização (dois
// dispositivos criando A→B e B→A ao mesmo tempo). Por isso TODA travessia daqui termina em grafos cíclicos.
// Datas são 'YYYY-MM-DD' locais; "hoje" sempre chega por parâmetro.

import { addWorkdays, compareDates, diffDays, formatDate, isValidDateStr, maxDate } from '../core/dates.js';
import { comparePriority } from './priorities.js';
import { isOpen } from './statuses.js';

const NONE = Object.freeze([]);
const DEFAULT_HOURS_PER_DAY = 8;
const UNNAMED = 'Tarefa sem nome';
const NAME_COLLATOR = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

/** Aceita array ou qualquer iterável (ex.: map.values()); qualquer outra coisa vira lista vazia. */
function toList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') return [...value];
  return NONE;
}

/** Consulta por id num Map ou num objeto simples (os dois formatos aceitos para `tasksById`/`demandsById`). */
function lookup(byId, id) {
  if (!byId || id === null || id === undefined) return undefined;
  if (typeof byId.get === 'function') return byId.get(id);
  return Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : undefined;
}

/** Vizinhos de um nó num mapa de adjacência; nó desconhecido (ou mapa ausente) devolve vazio. */
function neighbours(adjacency, id) {
  return (adjacency && adjacency.get(id)) || NONE;
}

/** Existe a aresta direta "taskId depende de dependsOnId"? (não exige o método graph.has) */
function hasEdge(graph, taskId, dependsOnId) {
  const set = graph && graph.prereqs ? graph.prereqs.get(taskId) : null;
  return !!set && set.has(dependsOnId);
}

/** Tarefas válidas (com id), sem repetição de id (vale a primeira ocorrência), na ordem recebida. */
function uniqueTasks(tasks) {
  const seen = new Set();
  const out = [];
  for (const task of toList(tasks)) {
    if (!task || task.id === null || task.id === undefined || seen.has(task.id)) continue;
    seen.add(task.id);
    out.push(task);
  }
  return out;
}

function taskName(task) {
  const name = task && typeof task.name === 'string' ? task.name.trim() : '';
  return name || UNNAMED;
}

/** Nome da tarefa entre aspas tipográficas, como aparece nas mensagens. */
const quoted = (task) => `“${taskName(task)}”`;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const validDate = (value) => (isValidDateStr(value) ? value : null);

function compareIds(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Ordem usada nas listas de pré-requisitos: prazo (sem prazo por último) → prioridade (P1 primeiro) → nome → id. */
function compareByDueThenPriority(a, b) {
  return (
    compareDates(validDate(a.due_date), validDate(b.due_date)) ||
    comparePriority(a, b) ||
    NAME_COLLATOR.compare(taskName(a), taskName(b)) ||
    compareIds(a.id, b.id)
  );
}

/** Linhas de dependência da mais antiga para a mais nova (sem created_at por último; empate → menor id). */
function compareDependencyRows(a, b) {
  return compareDates(a.created_at, b.created_at) || compareIds(a.id, b.id);
}

/** Erro de programação (não de dados): sem "hoje" não há cálculo de prazo confiável — falha cedo e com clareza. */
function requireToday(today, where) {
  if (!isValidDateStr(today)) {
    throw new TypeError(`${where}: "today" precisa ser uma data 'YYYY-MM-DD' (recebido: ${JSON.stringify(today) ?? String(today)})`);
  }
  return today;
}

/** Excluída/arquivada — por si mesma, pela tarefa-pai ou pela demanda (esta só quando `demandsById` é informado). */
function isHiddenTask(task, ctx) {
  if (task.deleted_at || task.archived_at) return true;
  if (task.parent_id !== null && task.parent_id !== undefined && task.parent_id !== task.id) {
    const parent = lookup(ctx.tasksById, task.parent_id);
    if (parent && (parent.deleted_at || parent.archived_at)) return true;
  }
  if (ctx.demandsById && task.demand_id !== null && task.demand_id !== undefined) {
    const demand = lookup(ctx.demandsById, task.demand_id);
    if (demand && (demand.deleted_at || demand.archived_at)) return true;
  }
  return false;
}

/**
 * Todos os nós de um grafo, na ordem de `ids`. Também funciona com grafos montados à mão que só tenham
 * `prereqs`/`dependents` (o contrato mínimo): nesse caso os nós saem das chaves e dos membros dos mapas.
 */
function nodeList(graph) {
  if (!graph) return [];
  const out = new Set(graph.ids || NONE);
  for (const adjacency of [graph.prereqs, graph.dependents]) {
    if (!adjacency) continue;
    for (const [id, others] of adjacency) {
      out.add(id);
      for (const other of others) out.add(other);
    }
  }
  return [...out];
}

/**
 * Menor caminho (com pelo menos uma aresta) de `from` até `to` seguindo `adjacency`; busca em largura.
 * Com from === to devolve o menor laço que passa pelo nó. `inside`, se informado, restringe os nós visitados.
 * @returns {Array|null} [from, …, to] ou null se não há caminho
 */
function searchPath(adjacency, from, to, inside = null) {
  const cameFrom = new Map();
  const seen = new Set([from]);
  let frontier = [from];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const other of neighbours(adjacency, id)) {
        if (inside && !inside.has(other)) continue;
        if (other === to) {
          const path = [to];
          for (let cur = id; cur !== from; cur = cameFrom.get(cur)) path.push(cur);
          path.push(from);
          return path.reverse();
        }
        if (seen.has(other)) continue;
        seen.add(other);
        cameFrom.set(other, id);
        next.push(other);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Componentes fortemente conexos (Tarjan iterativo — não estoura a pilha em cadeias longas).
 * Percorre "tarefa → seus pré-requisitos", então os componentes saem com os PRÉ-REQUISITOS PRIMEIRO.
 * Componente com mais de um nó (ou com autoaresta) é um ciclo.
 * @returns {{ components: Array<Array>, position: Map }} cada componente ordenado pela posição em `ids`
 */
function stronglyConnected(graph) {
  const order = nodeList(graph);
  const position = new Map(order.map((id, i) => [id, i]));
  const byPosition = (a, b) => position.get(a) - position.get(b);
  const visitedAt = new Map();
  const lowest = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  const open = (id) => {
    visitedAt.set(id, counter);
    lowest.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    return { id, next: [...neighbours(graph.prereqs, id)].sort(byPosition), at: 0 };
  };

  for (const root of order) {
    if (visitedAt.has(root)) continue;
    const frames = [open(root)];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (frame.at < frame.next.length) {
        const other = frame.next[frame.at];
        frame.at += 1;
        if (!visitedAt.has(other)) frames.push(open(other));
        else if (onStack.has(other)) lowest.set(frame.id, Math.min(lowest.get(frame.id), visitedAt.get(other)));
        continue;
      }
      frames.pop();
      if (frames.length) {
        const parent = frames[frames.length - 1];
        lowest.set(parent.id, Math.min(lowest.get(parent.id), lowest.get(frame.id)));
      }
      if (lowest.get(frame.id) !== visitedAt.get(frame.id)) continue;
      const members = [];
      let id;
      do {
        id = stack.pop();
        onStack.delete(id);
        members.push(id);
      } while (id !== frame.id);
      components.push(members.sort(byPosition));
    }
  }
  return { components, position };
}

const isCyclicComponent = (graph, members) => members.length > 1 || hasEdge(graph, members[0], members[0]);

const cycleAdjacencyCache = new WeakMap();

/**
 * Adjacência "depende de" usada na detecção de ciclos: as arestas explícitas MAIS as implícitas da hierarquia
 * (tarefa principal → cada subtarefa), porque a tarefa principal só avança/conclui pelas subtarefas. Sem isso,
 * a1 → B → A (a1 subtarefa de A) passaria como válido e travaria as três tarefas.
 * Grafos montados à mão sem `subtasks` usam só `prereqs`.
 */
function cycleAdjacency(graph) {
  if (!graph || !graph.prereqs) return null;
  if (!graph.subtasks || !graph.subtasks.size) return graph.prereqs;
  const cached = cycleAdjacencyCache.get(graph);
  if (cached) return cached;
  const out = new Map();
  for (const [id, set] of graph.prereqs) out.set(id, new Set(set));
  for (const [parentId, children] of graph.subtasks) {
    let set = out.get(parentId);
    if (!set) out.set(parentId, (set = new Set()));
    for (const child of children) set.add(child);
  }
  cycleAdjacencyCache.set(graph, out);
  return out;
}

/** Vista do grafo com a adjacência estendida (para os componentes fortemente conexos de findCycles). */
function cycleView(graph) {
  const prereqs = cycleAdjacency(graph);
  return prereqs === graph.prereqs ? graph : { ids: graph.ids, prereqs, dependents: graph.dependents };
}

// ---------------------------------------------------------------------------
// Construção do grafo
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DependencyGraph
 * @property {Map<string, Set<string>>} prereqs    tarefa → pré-requisitos DIRETOS. Toda tarefa do grafo tem
 *                                                 entrada (conjunto vazio quando não depende de ninguém).
 * @property {Map<string, Set<string>>} dependents tarefa → tarefas que dependem DIRETAMENTE dela (idem).
 * @property {Map<string, Set<string>>} [subtasks] tarefa principal → subtarefas não excluídas (só quem tem
 *                                                 subtarefas tem entrada). Dependência implícita usada nos ciclos.
 * @property {Array<{id: string, task_id: string, depends_on_id: string}>} edges arestas válidas, sem repetição.
 * @property {Set<string>} ids                     todas as tarefas não excluídas, na ordem recebida.
 * @property {(taskId: string, dependsOnId: string) => boolean} has existe a aresta direta
 *                                                 "taskId depende de dependsOnId"?
 */

/**
 * Monta o grafo de dependências a partir das linhas de `tasks` e de `task_dependencies`.
 *
 * Regras:
 *   • tarefas excluídas (`deleted_at`) ficam fora. Arquivadas e encerradas CONTINUAM no grafo: elas só deixam
 *     de bloquear (ver blockingPrereqs);
 *   • são ignoradas as dependências excluídas, as autoarestas (tarefa dependendo dela mesma) e as arestas com
 *     alguma ponta inexistente ou excluída;
 *   • arestas duplicadas (o mesmo par criado em dois dispositivos) contam UMA vez: fica a linha mais antiga
 *     (`created_at`; empate → menor id), para que todos os dispositivos escolham a mesma;
 *   • `edges` sai em ordem cronológica (`created_at`, depois id), qualquer que seja a ordem de chegada das linhas.
 *
 * @param {Iterable<object>} tasks linhas de tarefas (pode incluir excluídas)
 * @param {Iterable<object>} deps  linhas de task_dependencies (pode incluir excluídas)
 * @returns {DependencyGraph}
 */
export function buildGraph(tasks, deps) {
  const ids = new Set();
  const prereqs = new Map();
  const dependents = new Map();
  for (const task of toList(tasks)) {
    if (!task || task.id === null || task.id === undefined || task.deleted_at || ids.has(task.id)) continue;
    ids.add(task.id);
    prereqs.set(task.id, new Set());
    dependents.set(task.id, new Set());
  }

  /** tarefa → (pré-requisito → linha mais antiga daquele par) */
  const oldest = new Map();
  for (const dep of toList(deps)) {
    if (!dep || dep.deleted_at) continue;
    const taskId = dep.task_id;
    const dependsOnId = dep.depends_on_id;
    if (taskId === dependsOnId || !ids.has(taskId) || !ids.has(dependsOnId)) continue;
    let byPrereq = oldest.get(taskId);
    if (!byPrereq) oldest.set(taskId, (byPrereq = new Map()));
    const kept = byPrereq.get(dependsOnId);
    if (!kept || compareDependencyRows(dep, kept) < 0) byPrereq.set(dependsOnId, dep);
  }

  const rows = [];
  for (const byPrereq of oldest.values()) rows.push(...byPrereq.values());
  rows.sort(compareDependencyRows);

  const edges = rows.map((dep) => ({ id: dep.id, task_id: dep.task_id, depends_on_id: dep.depends_on_id }));
  for (const edge of edges) {
    prereqs.get(edge.task_id).add(edge.depends_on_id);
    dependents.get(edge.depends_on_id).add(edge.task_id);
  }

  // Hierarquia: tarefa principal → subtarefas não excluídas. É a dependência IMPLÍCITA ("toda tarefa principal
  // depende das suas subtarefas") que a detecção de ciclos também percorre (ver cycleAdjacency).
  const subtasks = new Map();
  for (const task of toList(tasks)) {
    if (!task || !ids.has(task.id) || task.deleted_at) continue;
    const parentId = task.parent_id;
    if (parentId === null || parentId === undefined || parentId === task.id || !ids.has(parentId)) continue;
    let set = subtasks.get(parentId);
    if (!set) subtasks.set(parentId, (set = new Set()));
    set.add(task.id);
  }

  return {
    prereqs,
    dependents,
    subtasks,
    edges,
    ids,
    has(taskId, dependsOnId) {
      const set = prereqs.get(taskId);
      return !!set && set.has(dependsOnId);
    },
  };
}

/**
 * Todas as linhas NÃO excluídas de `task_dependencies` que representam o par "taskId depende de dependsOnId".
 * Normalmente é uma só; quando o mesmo par foi criado em dois dispositivos há mais de uma. Para remover uma
 * dependência é preciso excluir TODAS (senão a duplicata faz a dependência "reaparecer").
 *
 * @param {Iterable<object>} deps linhas de task_dependencies
 * @param {string} taskId         tarefa que depende
 * @param {string} dependsOnId    pré-requisito
 * @returns {Array<object>} as linhas do par, da mais antiga para a mais nova
 */
export function dependencyRows(deps, taskId, dependsOnId) {
  return toList(deps)
    .filter((dep) => dep && !dep.deleted_at && dep.task_id === taskId && dep.depends_on_id === dependsOnId)
    .sort(compareDependencyRows);
}

// ---------------------------------------------------------------------------
// Ciclos e validação
// ---------------------------------------------------------------------------

/**
 * Criar a dependência "taskId depende de dependsOnId" fecharia um ciclo?
 * Fecha quando dependsOnId já depende (direta ou transitivamente) de taskId — ou quando os dois são a mesma tarefa.
 * A travessia conta a dependência implícita da hierarquia (tarefa principal depende de cada subtarefa), então
 * o `path` pode trazer um passo "principal → subtarefa" que não é linha de task_dependencies.
 * Também serve para validar transformar `dependsOnId` em subtarefa de `taskId` (a principal passa a depender dela).
 *
 * @param {DependencyGraph} graph
 * @param {string} taskId      tarefa que passaria a depender
 * @param {string} dependsOnId pré-requisito proposto
 * @returns {{ cycle: boolean, path: string[] }} `path` = ids do laço, começando e terminando em taskId, no
 *          sentido "depende de": [A, B, C, A] quer dizer A depende de B, B de C e C de A (o menor laço).
 *          Sem ciclo: `path` vazio.
 */
export function wouldCreateCycle(graph, taskId, dependsOnId) {
  if (taskId === null || taskId === undefined || dependsOnId === null || dependsOnId === undefined) {
    return { cycle: false, path: [] };
  }
  if (taskId === dependsOnId) return { cycle: true, path: [taskId, taskId] };
  // Inclui as dependências implícitas da hierarquia (tarefa principal → subtarefas): ver cycleAdjacency.
  const way = searchPath(cycleAdjacency(graph), dependsOnId, taskId);
  return way ? { cycle: true, path: [taskId, ...way] } : { cycle: false, path: [] };
}

function invalid(reason, message, path = []) {
  return { ok: false, reason, path, message };
}

/**
 * Valida a criação da dependência "taskId depende de dependsOnId". Não altera nada.
 *
 * Motivos de recusa (`reason`), nesta ordem de verificação:
 *   • `missing`   alguma das tarefas não existe ou foi excluída;
 *   • `self`      a tarefa dependeria dela mesma;
 *   • `duplicate` a dependência já existe;
 *   • `hierarchy` uma é subtarefa da outra — a tarefa principal já depende das suas subtarefas implicitamente;
 *   • `cycle`     fecharia uma dependência circular (`path` traz o laço, como em wouldCreateCycle).
 *
 * @param {string} taskId      tarefa que passaria a depender
 * @param {string} dependsOnId pré-requisito proposto
 * @param {object} ctx
 * @param {DependencyGraph} ctx.graph   grafo atual (buildGraph)
 * @param {Map|object} ctx.tasksById    id → tarefa (usado para existência, hierarquia e nomes)
 * @returns {{ ok: boolean, reason: 'missing'|'self'|'duplicate'|'hierarchy'|'cycle'|null, path: string[], message: string }}
 *          `ok: true` vem com `reason: null`, `path: []` e `message: ''`. `message` é em pt-BR; no ciclo ela
 *          soletra o laço com os nomes: 'Dependência circular: “A” → “B” → “C” → “A”'.
 */
export function validateNewDependency(taskId, dependsOnId, { graph, tasksById } = {}) {
  const task = lookup(tasksById, taskId);
  const prereq = lookup(tasksById, dependsOnId);
  if (!task || task.deleted_at || !prereq || prereq.deleted_at) {
    return invalid('missing', 'Tarefa não encontrada: ela pode ter sido excluída.');
  }
  if (taskId === dependsOnId) return invalid('self', 'Uma tarefa não pode depender dela mesma.');
  if (hasEdge(graph, taskId, dependsOnId)) {
    return invalid('duplicate', `${quoted(task)} já depende de ${quoted(prereq)}.`);
  }
  if (task.parent_id !== null && task.parent_id !== undefined && task.parent_id === prereq.id) {
    return invalid('hierarchy', `${quoted(task)} é subtarefa de ${quoted(prereq)} e não pode depender da própria tarefa principal.`);
  }
  if (prereq.parent_id !== null && prereq.parent_id !== undefined && prereq.parent_id === task.id) {
    return invalid('hierarchy', `${quoted(task)} já depende da subtarefa ${quoted(prereq)}: toda tarefa principal depende das suas subtarefas.`);
  }
  const { cycle, path } = wouldCreateCycle(graph, taskId, dependsOnId);
  if (cycle) {
    const names = path.map((id) => quoted(lookup(tasksById, id)));
    return invalid('cycle', `Dependência circular: ${names.join(' → ')}`, path);
  }
  return { ok: true, reason: null, path: [], message: '' };
}

/**
 * Ciclos existentes no grafo — só acontecem com dados danificados por edições simultâneas em dois dispositivos.
 * Devolve UM laço representativo (o menor que passa pela primeira tarefa) por grupo de tarefas presas num
 * ciclo; depois que o usuário desfaz esse laço, uma nova chamada mostra o próximo, se houver.
 *
 * @param {DependencyGraph} graph
 * @returns {Array<string[]>} cada ciclo no mesmo formato do `path` de wouldCreateCycle: começa e termina no
 *          mesmo id, no sentido "depende de" ([A, B, A] = A depende de B e B depende de A). Ordenados pela
 *          posição da primeira tarefa em `graph.ids`. Grafo sem ciclos → [].
 */
export function findCycles(graph) {
  if (!graph) return [];
  // Laços que passam pela hierarquia (a1 → B → A, com a1 subtarefa de A) também são ciclos: o `path` pode
  // trazer um passo "principal → subtarefa", que não é uma linha de task_dependencies.
  const view = cycleView(graph);
  const { components, position } = stronglyConnected(view);
  const cycles = [];
  for (const members of components) {
    if (!isCyclicComponent(graph, members)) continue;
    const loop = searchPath(view.prereqs, members[0], members[0], new Set(members));
    if (loop) cycles.push(loop);
  }
  return cycles.sort((a, b) => position.get(a[0]) - position.get(b[0]));
}

/**
 * Ordem topológica: todo pré-requisito vem antes de quem depende dele.
 *
 * A ordem é estável em relação a `graph.ids`: cada tarefa aparece na sua vez, precedida apenas dos
 * pré-requisitos que ainda não tinham aparecido (se a entrada já está em ordem válida, sai igual).
 * Tarefas presas em ciclos — e as que dependem delas — não têm ordem válida: vão para o FIM, com os ciclos
 * antes de quem depende deles e, dentro de cada ciclo, na ordem de `graph.ids`.
 *
 * @param {DependencyGraph} graph
 * @returns {string[]} todos os ids do grafo, uma vez cada
 */
export function topoOrder(graph) {
  if (!graph) return [];
  const { components } = stronglyConnected(graph);
  const tainted = new Set();
  const clean = [];
  const entangled = [];
  for (const members of components) {
    let bad = isCyclicComponent(graph, members);
    if (!bad) {
      for (const prereq of neighbours(graph.prereqs, members[0])) {
        if (tainted.has(prereq)) {
          bad = true;
          break;
        }
      }
    }
    if (!bad) {
      clean.push(members[0]);
      continue;
    }
    for (const id of members) {
      tainted.add(id);
      entangled.push(id);
    }
  }
  return clean.concat(entangled);
}

// ---------------------------------------------------------------------------
// Cadeias
// ---------------------------------------------------------------------------

/**
 * Cadeia de dependências de uma tarefa, em largura (os mais próximos primeiro).
 *
 * @param {string} taskId
 * @param {object} options
 * @param {DependencyGraph} options.graph
 * @param {'up'|'down'} [options.direction='up'] `up` = tudo de que a tarefa depende (direta ou
 *        transitivamente); `down` = tudo que depende dela.
 * @returns {Array<{ id: string, depth: number }>} sem repetições e sem a própria tarefa; `depth` = distância
 *          mínima em arestas (1 = dependência direta). Segura contra ciclos. Tarefa desconhecida → [].
 */
export function dependencyChain(taskId, { graph, direction = 'up' } = {}) {
  const adjacency = graph ? (direction === 'down' ? graph.dependents : graph.prereqs) : null;
  const seen = new Set([taskId]);
  const out = [];
  let frontier = [taskId];
  for (let depth = 1; frontier.length; depth += 1) {
    const next = [];
    for (const id of frontier) {
      for (const other of neighbours(adjacency, id)) {
        if (seen.has(other)) continue;
        seen.add(other);
        out.push({ id: other, depth });
        next.push(other);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Quantas tarefas distintas dependem (direta ou transitivamente) desta — sem olhar o status delas.
 * Para contar só o que a tarefa realmente destrava, use openDownstream.
 *
 * @param {string} taskId
 * @param {DependencyGraph} graph
 * @returns {number}
 */
export function downstreamCount(taskId, graph) {
  return dependencyChain(taskId, { graph, direction: 'down' }).length;
}

// ---------------------------------------------------------------------------
// Bloqueio por dependência
// ---------------------------------------------------------------------------

/**
 * A tarefa está "viva"? Viva = aberta (nem concluída nem cancelada) e visível: não excluída e não arquivada,
 * nem ela, nem a tarefa-pai (subtarefa herda), nem a demanda (só quando `ctx.demandsById` é informado).
 * É a definição de "pré-requisito que bloqueia" e de "tarefa que espera por alguém" usada em todo o módulo.
 *
 * @param {object|null|undefined} task
 * @param {{ tasksById?: Map|object, statuses?: Array, demandsById?: Map|object }} [ctx]
 * @returns {boolean}
 */
export function isLiveTask(task, ctx = {}) {
  return !!task && !isHiddenTask(task, ctx) && isOpen(task, ctx.statuses);
}

/**
 * Pré-requisitos DIRETOS que ainda bloqueiam a tarefa: os que estão vivos (ver isLiveTask). Pré-requisito
 * concluído, cancelado, arquivado, excluído ou ausente de `tasksById` não bloqueia.
 *
 * @param {string} taskId
 * @param {object} ctx
 * @param {DependencyGraph} ctx.graph
 * @param {Map|object} ctx.tasksById     id → tarefa
 * @param {Array} [ctx.statuses]         lista efetiva de status (padrão: os de fábrica)
 * @param {Map|object} [ctx.demandsById] opcional: tarefa de demanda arquivada/excluída também não bloqueia
 * @returns {Array<object>} as tarefas (linhas) que bloqueiam, ordenadas por prazo (sem prazo por último),
 *          depois prioridade (P1 primeiro), depois nome
 */
export function blockingPrereqs(taskId, ctx = {}) {
  const out = [];
  for (const id of neighbours(ctx.graph && ctx.graph.prereqs, taskId)) {
    const prereq = lookup(ctx.tasksById, id);
    if (isLiveTask(prereq, ctx)) out.push(prereq);
  }
  return out.sort(compareByDueThenPriority);
}

/**
 * A tarefa está bloqueada por dependência? Só quando ELA está aberta e tem pelo menos um pré-requisito que
 * ainda bloqueia (ver blockingPrereqs). Tarefa concluída ou cancelada nunca está bloqueada.
 *
 * @param {object|string} task a tarefa (linha) ou o id dela
 * @param {object} ctx         mesmo contexto de blockingPrereqs: { graph, tasksById, statuses, demandsById? }
 * @returns {boolean}
 */
export function isBlockedByDependency(task, ctx = {}) {
  const row = task !== null && typeof task === 'object' ? task : lookup(ctx.tasksById, task);
  if (!row || !isOpen(row, ctx.statuses)) return false;
  for (const id of neighbours(ctx.graph && ctx.graph.prereqs, row.id)) {
    if (isLiveTask(lookup(ctx.tasksById, id), ctx)) return true;
  }
  return false;
}

/**
 * Tarefas vivas que esperam por esta: as que dependem dela, direta ou transitivamente, por uma cadeia de
 * tarefas vivas. Uma tarefa concluída, cancelada ou oculta no meio do caminho corta a cadeia (quem vem depois
 * dela já não espera por esta). É o "destrava N tarefas" das próximas ações.
 *
 * @param {string} taskId
 * @param {object} ctx mesmo contexto de blockingPrereqs: { graph, tasksById, statuses, demandsById? }
 * @returns {Array<object>} tarefas (linhas) em largura — as dependentes diretas primeiro; sem repetições,
 *          sem a própria tarefa. Segura contra ciclos.
 */
export function openDownstream(taskId, ctx = {}) {
  const adjacency = ctx.graph && ctx.graph.dependents;
  const seen = new Set([taskId]);
  const out = [];
  let frontier = [taskId];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const other of neighbours(adjacency, id)) {
        if (seen.has(other)) continue;
        seen.add(other);
        const task = lookup(ctx.tasksById, other);
        if (!isLiveTask(task, ctx)) continue;
        out.push(task);
        next.push(other);
      }
    }
    frontier = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cronograma: término mais cedo possível e conflitos de prazo
// ---------------------------------------------------------------------------

/** Dias úteis necessários para a estimativa (sem estimativa → 1 dia). */
function workdaysFor(estimateMinutes, hoursPerDay) {
  const minutes = Number(estimateMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return 1;
  return Math.max(1, Math.ceil(minutes / (60 * hoursPerDay) - 1e-9));
}

const normalizeHours = (hoursPerDay) => (Number.isFinite(hoursPerDay) && hoursPerDay > 0 ? hoursPerDay : DEFAULT_HOURS_PER_DAY);

/**
 * Término mais cedo possível de cada tarefa ABERTA, propagando as dependências para a frente.
 *
 * Para cada tarefa aberta (e não excluída):
 *   • início = o mais tarde entre `today`, o `planned_start` da tarefa (se houver) e o dia útil seguinte ao
 *     término mais cedo de cada pré-requisito que ainda bloqueia; o início sempre cai em dia útil
 *     (sábado/domingo → segunda-feira);
 *   • término = início + (ceil(estimate_minutes ÷ 60 ÷ hoursPerDay) − 1) dias úteis; sem estimativa a tarefa
 *     ocupa um dia (termina no próprio dia do início).
 * Dias úteis = segunda a sexta. Pré-requisitos concluídos, cancelados ou ocultos não entram na conta.
 * Cada tarefa é calculada uma única vez, na ordem topológica; em dados com ciclo, a aresta que fecha o laço é
 * ignorada (o cálculo termina e é determinístico).
 *
 * @param {object} params
 * @param {Iterable<object>} params.tasks  tarefas (as encerradas/excluídas são ignoradas)
 * @param {DependencyGraph} params.graph
 * @param {Array} [params.statuses]
 * @param {string} params.today            'YYYY-MM-DD' (obrigatório; TypeError se inválido)
 * @param {number} [params.hoursPerDay=8]  horas de trabalho por dia útil
 * @param {Map|object} [params.demandsById] opcional (ver isLiveTask)
 * @returns {Map<string, string>} id da tarefa → 'YYYY-MM-DD', na ordem de `tasks`
 */
export function earliestFinishMap({ tasks, graph, statuses, today, hoursPerDay = DEFAULT_HOURS_PER_DAY, demandsById } = {}) {
  requireToday(today, 'earliestFinishMap');
  const list = uniqueTasks(tasks);
  const tasksById = new Map(list.map((task) => [task.id, task]));
  const ctx = { graph, tasksById, statuses, demandsById };
  const hours = normalizeHours(hoursPerDay);

  const sequence = topoOrder(graph);
  const inGraph = new Set(sequence);
  for (const task of list) if (!inGraph.has(task.id)) sequence.push(task.id);

  const finish = new Map();
  for (const id of sequence) {
    const task = tasksById.get(id);
    if (!task || task.deleted_at || !isOpen(task, statuses)) continue;
    let start = maxDate(today, validDate(task.planned_start));
    for (const prereqId of neighbours(graph && graph.prereqs, id)) {
      if (!isLiveTask(tasksById.get(prereqId), ctx)) continue;
      const prereqFinish = finish.get(prereqId); // ausente = aresta que fecha um ciclo: ignorada
      if (prereqFinish) start = maxDate(start, addWorkdays(prereqFinish, 1));
    }
    finish.set(id, addWorkdays(start, workdaysFor(task.estimate_minutes, hours) - 1));
  }

  const out = new Map();
  for (const task of list) {
    const date = finish.get(task.id);
    if (date) out.set(task.id, date);
  }
  return out;
}

/** Tipos de conflito de prazo devolvidos por scheduleConflicts. */
export const CONFLICT_TYPES = Object.freeze({
  PREREQ_DUE_AFTER: 'prereq_due_after',
  CHAIN_LATE: 'chain_late',
  PREREQ_OVERDUE: 'prereq_overdue',
  START_BEFORE_PREREQ: 'start_before_prereq',
});

/** Ordem em que os conflitos de uma tarefa são devolvidos: primeiro os graves (`danger`). */
const CONFLICT_RANK = Object.freeze({
  [CONFLICT_TYPES.PREREQ_DUE_AFTER]: 0,
  [CONFLICT_TYPES.CHAIN_LATE]: 1,
  [CONFLICT_TYPES.PREREQ_OVERDUE]: 2,
  [CONFLICT_TYPES.START_BEFORE_PREREQ]: 3,
});

/**
 * @typedef {object} ScheduleConflict
 * @property {'prereq_due_after'|'chain_late'|'prereq_overdue'|'start_before_prereq'} type
 * @property {'warn'|'danger'} severity
 * @property {string|null} prereqId pré-requisito envolvido (em `chain_late`: o gargalo — o pré-requisito que
 *                                  termina por último)
 * @property {string} date          a data que conflita: o prazo do pré-requisito ou, em `chain_late`, o
 *                                  término mais cedo possível
 * @property {string} message       explicação em pt-BR
 */

/**
 * Conflitos de prazo causados por dependências. Só olha tarefas vivas (abertas, não excluídas e não
 * arquivadas) que tenham pelo menos um pré-requisito que ainda bloqueia.
 *
 * Tipos:
 *   • `prereq_due_after` (danger): um pré-requisito aberto vence DEPOIS do prazo desta tarefa.
 *       'Depende de “X”, que vence em 25 nov — depois deste prazo (20 nov)'
 *   • `chain_late` (danger): o término mais cedo possível pela cadeia (earliestFinishMap) passa do prazo.
 *       'Pela cadeia de dependências, o término mais cedo possível é 27 nov (prazo: 20 nov)'
 *   • `prereq_overdue` (warn): um pré-requisito aberto está atrasado.
 *       'Pré-requisito “X” está atrasado há 3 dias'
 *   • `start_before_prereq` (warn): o início planejado desta tarefa é anterior ao prazo de um pré-requisito aberto.
 *       'Início planejado (18 nov) é anterior ao prazo do pré-requisito “X” (20 nov)'
 * Datas iguais não são conflito. As datas das mensagens usam formatDate(d, 'short', today).
 *
 * @param {object} params
 * @param {Iterable<object>} params.tasks
 * @param {DependencyGraph} params.graph
 * @param {Array} [params.statuses]
 * @param {string} params.today            'YYYY-MM-DD' (obrigatório; TypeError se inválido)
 * @param {number} [params.hoursPerDay=8]
 * @param {Map|object} [params.demandsById] opcional (ver isLiveTask)
 * @returns {Map<string, ScheduleConflict[]>} SÓ as tarefas que têm conflito (lista nunca vazia), na ordem de
 *          `tasks`. Em cada lista vêm primeiro os conflitos graves (`prereq_due_after`, `chain_late`) e depois
 *          os avisos (`prereq_overdue`, `start_before_prereq`); dentro do mesmo tipo, na ordem de blockingPrereqs.
 */
export function scheduleConflicts({ tasks, graph, statuses, today, hoursPerDay = DEFAULT_HOURS_PER_DAY, demandsById } = {}) {
  requireToday(today, 'scheduleConflicts');
  const list = uniqueTasks(tasks);
  const tasksById = new Map(list.map((task) => [task.id, task]));
  const ctx = { graph, tasksById, statuses, demandsById };
  const finish = earliestFinishMap({ tasks: list, graph, statuses, today, hoursPerDay, demandsById });
  const fmt = (date) => formatDate(date, 'short', today);
  const T = CONFLICT_TYPES;

  const out = new Map();
  for (const task of list) {
    if (!isLiveTask(task, ctx)) continue;
    const blockers = blockingPrereqs(task.id, ctx);
    if (!blockers.length) continue;
    const due = validDate(task.due_date);
    const plannedStart = validDate(task.planned_start);
    const found = [];

    for (const prereq of blockers) {
      const prereqDue = validDate(prereq.due_date);
      if (!prereqDue) continue;
      if (due && prereqDue > due) {
        found.push({
          type: T.PREREQ_DUE_AFTER,
          severity: 'danger',
          prereqId: prereq.id,
          date: prereqDue,
          message: `Depende de ${quoted(prereq)}, que vence em ${fmt(prereqDue)} — depois deste prazo (${fmt(due)})`,
        });
      }
      if (prereqDue < today) {
        found.push({
          type: T.PREREQ_OVERDUE,
          severity: 'warn',
          prereqId: prereq.id,
          date: prereqDue,
          message: `Pré-requisito ${quoted(prereq)} está atrasado há ${plural(diffDays(prereqDue, today), 'dia', 'dias')}`,
        });
      }
      if (plannedStart && plannedStart < prereqDue) {
        found.push({
          type: T.START_BEFORE_PREREQ,
          severity: 'warn',
          prereqId: prereq.id,
          date: prereqDue,
          message: `Início planejado (${fmt(plannedStart)}) é anterior ao prazo do pré-requisito ${quoted(prereq)} (${fmt(prereqDue)})`,
        });
      }
    }

    const earliest = finish.get(task.id);
    if (due && earliest && earliest > due) {
      let bottleneck = null;
      let latest = null;
      for (const prereq of blockers) {
        const prereqFinish = finish.get(prereq.id);
        if (prereqFinish && (latest === null || prereqFinish > latest)) {
          latest = prereqFinish;
          bottleneck = prereq.id;
        }
      }
      found.push({
        type: T.CHAIN_LATE,
        severity: 'danger',
        prereqId: bottleneck,
        date: earliest,
        message: `Pela cadeia de dependências, o término mais cedo possível é ${fmt(earliest)} (prazo: ${fmt(due)})`,
      });
    }

    if (found.length) out.set(task.id, found.sort((a, b) => CONFLICT_RANK[a.type] - CONFLICT_RANK[b.type]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diagrama: layout em camadas (esquerda → direita)
// ---------------------------------------------------------------------------

const LAYOUT_DEFAULTS = Object.freeze({ nodeWidth: 208, nodeHeight: 60, gapX: 72, gapY: 20, padding: 24 });

/** Pesos do alinhamento vertical (Gansner et al.): caixa–caixa, caixa–raia e raia–raia. */
const WEIGHT_BOX = 1;
const WEIGHT_MIXED = 2;
const WEIGHT_LANE = 8;

/** Limites dos laços iterativos (o resultado é determinístico: mesma entrada, mesmas iterações). */
const ORDER_SWEEPS = 24;
const ORDER_PATIENCE = 4;
const ALIGN_ITERATIONS = 80;
const ALIGN_TOLERANCE = 0.01;

const layoutOption = (value, fallback, min) => (Number.isFinite(value) && value >= min ? value : fallback);

/**
 * Marca as arestas de retorno (as que fecham ciclos) com uma busca em profundidade determinística:
 * começa pelas fontes (nós sem entrada), na ordem de entrada, e segue os destinos em ordem.
 */
function markBackLinks(count, outgoing, indegree) {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const state = new Uint8Array(count);
  const roots = [];
  for (let i = 0; i < count; i += 1) if (indegree[i] === 0) roots.push(i);
  for (let i = 0; i < count; i += 1) if (indegree[i] !== 0) roots.push(i);
  for (const root of roots) {
    if (state[root] !== WHITE) continue;
    state[root] = GREY;
    const frames = [{ node: root, at: 0 }];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const list = outgoing[frame.node];
      if (frame.at < list.length) {
        const link = list[frame.at];
        frame.at += 1;
        if (state[link.v] === GREY) link.back = true;
        else if (state[link.v] === WHITE) {
          state[link.v] = GREY;
          frames.push({ node: link.v, at: 0 });
        }
      } else {
        state[frame.node] = BLACK;
        frames.pop();
      }
    }
  }
}

/** Cruzamentos entre camadas vizinhas para a ordem atual (árvore de Fenwick: O(E log V)). */
function countCrossings(rows, down, pos) {
  let total = 0;
  for (let level = 0; level + 1 < rows.length; level += 1) {
    const width = rows[level + 1].length;
    if (width < 2) continue;
    const tree = new Int32Array(width + 1);
    let added = 0;
    for (const vertex of rows[level]) {
      const targets = down[vertex];
      for (const target of targets) {
        let notAfter = 0;
        for (let i = pos[target.v] + 1; i > 0; i -= i & -i) notAfter += tree[i];
        total += added - notAfter;
      }
      for (const target of targets) {
        for (let i = pos[target.v] + 1; i <= width; i += i & -i) tree[i] += 1;
        added += 1;
      }
    }
  }
  return total;
}

/**
 * Uma varredura de baricentro: reordena cada camada pela posição média dos vizinhos na camada já fixada.
 * Vértices sem vizinhos naquele lado ficam onde estão; empates mantêm a ordem atual.
 */
function sweepOrder(rows, pos, adjacent, from, to, step) {
  for (let level = from; level !== to; level += step) {
    const row = rows[level];
    const movable = [];
    const slots = [];
    for (let i = 0; i < row.length; i += 1) {
      const list = adjacent[row[i]];
      if (!list.length) continue;
      let sum = 0;
      for (const item of list) sum += pos[item.v];
      movable.push({ vertex: row[i], key: sum / list.length, at: i });
      slots.push(i);
    }
    movable.sort((a, b) => a.key - b.key || a.at - b.at);
    for (let k = 0; k < slots.length; k += 1) row[slots[k]] = movable[k].vertex;
    for (let i = 0; i < row.length; i += 1) pos[row[i]] = i;
  }
}

/** Regressão isotônica ponderada (pool adjacent violators): a sequência não decrescente mais próxima de `targets`. */
function isotonicFit(targets, weights) {
  const n = targets.length;
  const blockWeight = new Float64Array(n);
  const blockSum = new Float64Array(n);
  const blockSize = new Int32Array(n);
  let blocks = 0;
  for (let i = 0; i < n; i += 1) {
    blockWeight[blocks] = weights[i];
    blockSum[blocks] = weights[i] * targets[i];
    blockSize[blocks] = 1;
    blocks += 1;
    while (blocks > 1 && blockSum[blocks - 2] / blockWeight[blocks - 2] > blockSum[blocks - 1] / blockWeight[blocks - 1]) {
      blockWeight[blocks - 2] += blockWeight[blocks - 1];
      blockSum[blocks - 2] += blockSum[blocks - 1];
      blockSize[blocks - 2] += blockSize[blocks - 1];
      blocks -= 1;
    }
  }
  const out = new Float64Array(n);
  let k = 0;
  for (let b = 0; b < blocks; b += 1) {
    const value = blockSum[b] / blockWeight[b];
    for (let j = 0; j < blockSize[b]; j += 1) out[k++] = value;
  }
  return out;
}

/**
 * Posiciona um componente conexo (dois ou mais nós, já com as camadas definidas e sem arestas de retorno).
 *
 *   1. Arestas que pulam camadas ganham "raias": vértices virtuais sem altura em cada camada intermediária,
 *      que reservam um corredor por onde a curva passa sem ficar escondida atrás de outra caixa.
 *   2. Ordem dentro das camadas: partida em profundidade a partir das fontes e varreduras de baricentro,
 *      guardando a ordem com menos cruzamentos.
 *   3. Posição vertical: aproxima cada vértice da média dos vizinhos (arestas curtas, cadeias retas),
 *      respeitando a ordem e o espaçamento mínimo — descida por camadas com regressão isotônica, que é a
 *      solução exata do problema de cada camada.
 *
 * @returns {{ tops: number[], height: number }} topo de cada nó (na ordem de `members`, a partir de 0) e a
 *          altura do componente. As arestas longas recebem `link.lane = { first, last }` (y das raias).
 */
function layoutComponent(members, links, layerOf, nodeHeight, gapY) {
  const vLayer = [];
  const vHeight = [];
  const up = [];
  const down = [];
  const addVertex = (level, height) => {
    vLayer.push(level);
    vHeight.push(height);
    up.push([]);
    down.push([]);
    return vLayer.length - 1;
  };
  const connect = (a, b, weight) => {
    down[a].push({ v: b, w: weight });
    up[b].push({ v: a, w: weight });
  };

  const local = new Map();
  let depth = 0;
  for (const member of members) {
    local.set(member, addVertex(layerOf[member], nodeHeight));
    if (layerOf[member] + 1 > depth) depth = layerOf[member] + 1;
  }
  const lanes = [];
  for (const link of links) {
    const a = local.get(link.u);
    const b = local.get(link.v);
    if (vLayer[b] - vLayer[a] === 1) {
      connect(a, b, WEIGHT_BOX);
      continue;
    }
    let previous = a;
    let first = -1;
    for (let level = vLayer[a] + 1; level < vLayer[b]; level += 1) {
      const lane = addVertex(level, 0);
      connect(previous, lane, previous === a ? WEIGHT_MIXED : WEIGHT_LANE);
      if (first < 0) first = lane;
      previous = lane;
    }
    connect(previous, b, WEIGHT_MIXED);
    lanes.push({ link, first, last: previous });
  }
  const total = vLayer.length;

  // Ordem inicial: pré-ordem em profundidade a partir das fontes (mantém juntos os ramos de um mesmo nó).
  let rows = Array.from({ length: depth }, () => []);
  const placed = new Uint8Array(total);
  for (let source = 0; source < members.length; source += 1) {
    if (up[source].length) continue;
    const pending = [source];
    while (pending.length) {
      const vertex = pending.pop();
      if (placed[vertex]) continue;
      placed[vertex] = 1;
      rows[vLayer[vertex]].push(vertex);
      for (let k = down[vertex].length - 1; k >= 0; k -= 1) pending.push(down[vertex][k].v);
    }
  }
  const pos = new Int32Array(total);
  const indexRows = () => {
    for (const row of rows) for (let i = 0; i < row.length; i += 1) pos[row[i]] = i;
  };
  indexRows();

  // Varreduras de baricentro, alternando o sentido; fica a ordem com menos cruzamentos.
  let best = rows.map((row) => row.slice());
  let bestCrossings = countCrossings(rows, down, pos);
  for (let sweep = 0, stale = 0; sweep < ORDER_SWEEPS && bestCrossings > 0 && stale < ORDER_PATIENCE; sweep += 1) {
    if (sweep % 2 === 0) sweepOrder(rows, pos, up, 1, depth, 1);
    else sweepOrder(rows, pos, down, depth - 2, -1, -1);
    const crossings = countCrossings(rows, down, pos);
    if (crossings < bestCrossings) {
      bestCrossings = crossings;
      best = rows.map((row) => row.slice());
      stale = 0;
    } else {
      stale += 1;
    }
  }
  rows = best;
  indexRows();

  // Posição vertical.
  const y = new Float64Array(total);
  const offsets = rows.map((row) => {
    const out = new Float64Array(row.length);
    let acc = 0;
    for (let i = 0; i < row.length; i += 1) {
      out[i] = acc;
      acc += vHeight[row[i]] + gapY;
    }
    return out;
  });
  for (let level = 0; level < depth; level += 1) {
    for (let i = 0; i < rows[level].length; i += 1) y[rows[level][i]] = offsets[level][i];
  }
  const centre = (vertex) => y[vertex] + vHeight[vertex] / 2;
  for (let iteration = 0; iteration < ALIGN_ITERATIONS; iteration += 1) {
    let moved = 0;
    for (let k = 0; k < depth; k += 1) {
      const level = iteration % 2 === 0 ? k : depth - 1 - k;
      const row = rows[level];
      const offset = offsets[level];
      const targets = new Float64Array(row.length);
      const weights = new Float64Array(row.length);
      for (let i = 0; i < row.length; i += 1) {
        const vertex = row[i];
        let weight = 0;
        let sum = 0;
        for (const item of up[vertex]) {
          weight += item.w;
          sum += item.w * centre(item.v);
        }
        for (const item of down[vertex]) {
          weight += item.w;
          sum += item.w * centre(item.v);
        }
        if (weight > 0) {
          targets[i] = sum / weight - vHeight[vertex] / 2 - offset[i];
          weights[i] = weight;
        } else {
          targets[i] = y[vertex] - offset[i];
          weights[i] = 1e-6;
        }
      }
      const fitted = isotonicFit(targets, weights);
      for (let i = 0; i < row.length; i += 1) {
        const value = fitted[i] + offset[i];
        const delta = Math.abs(value - y[row[i]]);
        if (delta > moved) moved = delta;
        y[row[i]] = value;
      }
    }
    if (moved < ALIGN_TOLERANCE) break;
  }

  // Normaliza (topo em 0), arredonda para pixels inteiros e garante o espaçamento exato depois do arredondamento.
  let top = Infinity;
  for (let vertex = 0; vertex < total; vertex += 1) if (y[vertex] < top) top = y[vertex];
  let height = 0;
  for (const row of rows) {
    let floor = -Infinity;
    for (const vertex of row) {
      let value = Math.round(y[vertex] - top);
      if (value < floor) value = floor;
      y[vertex] = value;
      floor = value + vHeight[vertex] + gapY;
      if (value + vHeight[vertex] > height) height = value + vHeight[vertex];
    }
  }

  for (const lane of lanes) lane.link.lane = { first: y[lane.first], last: y[lane.last] };
  return { tops: members.map((member) => y[local.get(member)]), height };
}

/**
 * Posições do diagrama de dependências: layout em camadas, da esquerda para a direita.
 *
 * As arestas vão do PRÉ-REQUISITO (`from`) para a DEPENDENTE (`to`). Regras:
 *   • camada (`layer`) = maior caminho a partir das fontes: quem não tem pré-requisito fica na camada 0 e toda
 *     aresta aponta para uma camada à direita;
 *   • dentro da camada os nós são ordenados pelo baricentro dos vizinhos (algumas varreduras) para reduzir
 *     cruzamentos, e alinhados verticalmente com os vizinhos (cadeias ficam retas; um nó com vários
 *     pré-requisitos fica centralizado entre eles);
 *   • cada grupo de nós ligados entre si ocupa uma faixa horizontal própria; nós isolados (sem arestas) vão
 *     empilhados na camada 0, depois dos grupos;
 *   • arestas que pulam camadas reservam um corredor nas camadas intermediárias, para a curva não se esconder
 *     atrás de outra caixa;
 *   • ciclos (dados danificados) não travam o cálculo: a aresta que fecha o laço é tratada como "de retorno" —
 *     não participa das camadas e sai marcada com `back: true` (ela aponta para a esquerda);
 *   • arestas repetidas, autoarestas e arestas com ponta desconhecida são descartadas;
 *   • determinístico: a mesma entrada produz sempre a mesma saída (e a ordem das ARESTAS não muda as posições).
 *
 * @param {Iterable<string|{id: string}>} nodes ids (ou objetos com `id`, ex.: as próprias tarefas)
 * @param {Iterable<{from: string, to: string}|{depends_on_id: string, task_id: string}>} edges arestas
 *        { from: pré-requisito, to: dependente }; aceita também as arestas de buildGraph (`graph.edges`)
 * @param {object} [options]
 * @param {number} [options.nodeWidth=208]  largura de cada caixa
 * @param {number} [options.nodeHeight=60]  altura de cada caixa
 * @param {number} [options.gapX=72]        espaço horizontal entre camadas
 * @param {number} [options.gapY=20]        espaço vertical mínimo entre caixas da mesma camada
 * @param {number} [options.padding=24]     margem em volta do desenho
 * @returns {{ nodes: Array<{ id: string, x: number, y: number, layer: number, order: number }>,
 *             edges: Array<{ from: string, to: string, points: Array<{ x: number, y: number }>, id?: string, back?: boolean }>,
 *             width: number, height: number }}
 *   `nodes`: na ordem de entrada; `x`/`y` = canto superior esquerdo da caixa; `order` = posição dentro da
 *            camada, de cima para baixo (0 = a mais alta).
 *   `edges`: na ordem de entrada; `points` tem sempre 4 pontos — uma curva de Bézier cúbica
 *            (`M p0 C p1, p2, p3`) que sai do meio da borda direita da caixa de origem e chega ao meio da
 *            borda esquerda da caixa de destino; `id` repete o id da aresta de entrada, quando ela tem.
 *   `width`/`height`: tamanho total do desenho, margens incluídas.
 */
export function layoutGraph(nodes, edges, options = {}) {
  const given = options || {};
  const nodeWidth = layoutOption(given.nodeWidth, LAYOUT_DEFAULTS.nodeWidth, 1);
  const nodeHeight = layoutOption(given.nodeHeight, LAYOUT_DEFAULTS.nodeHeight, 1);
  const gapX = layoutOption(given.gapX, LAYOUT_DEFAULTS.gapX, 0);
  const gapY = layoutOption(given.gapY, LAYOUT_DEFAULTS.gapY, 0);
  const padding = layoutOption(given.padding, LAYOUT_DEFAULTS.padding, 0);

  // 1. Nós: ids únicos, na ordem de entrada.
  const ids = [];
  const indexById = new Map();
  for (const node of toList(nodes)) {
    const id = node !== null && typeof node === 'object' ? node.id : node;
    if (id === null || id === undefined || indexById.has(id)) continue;
    indexById.set(id, ids.length);
    ids.push(id);
  }
  const count = ids.length;

  // 2. Arestas válidas, sem repetição, na ordem de entrada.
  const links = [];
  const pairs = new Set();
  for (const edge of toList(edges)) {
    if (!edge || typeof edge !== 'object') continue;
    const u = indexById.get(edge.from !== undefined ? edge.from : edge.depends_on_id);
    const v = indexById.get(edge.to !== undefined ? edge.to : edge.task_id);
    if (u === undefined || v === undefined || u === v) continue;
    const key = u * count + v;
    if (pairs.has(key)) continue;
    pairs.add(key);
    links.push({ u, v, id: edge.id, back: false, lane: null });
  }

  // 3. Arestas de retorno (ciclos) ficam fora das camadas.
  const outgoing = Array.from({ length: count }, () => []);
  const indegree = new Int32Array(count);
  for (const link of links) {
    outgoing[link.u].push(link);
    indegree[link.v] += 1;
  }
  for (const list of outgoing) list.sort((a, b) => a.v - b.v);
  markBackLinks(count, outgoing, indegree);

  // 4. Camada = maior caminho a partir das fontes (as arestas restantes formam um grafo sem ciclos).
  const layerOf = new Int32Array(count);
  const waiting = new Int32Array(count);
  for (const link of links) if (!link.back) waiting[link.v] += 1;
  const queue = [];
  for (let i = 0; i < count; i += 1) if (waiting[i] === 0) queue.push(i);
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head];
    for (const link of outgoing[u]) {
      if (link.back) continue;
      if (layerOf[u] + 1 > layerOf[link.v]) layerOf[link.v] = layerOf[u] + 1;
      waiting[link.v] -= 1;
      if (waiting[link.v] === 0) queue.push(link.v);
    }
  }
  let lastLayer = 0;
  for (let i = 0; i < count; i += 1) if (layerOf[i] > lastLayer) lastLayer = layerOf[i];

  // 5. Componentes conexos (a raiz de cada grupo é o seu nó de menor índice).
  const rootOf = Array.from({ length: count }, (_, i) => i);
  const find = (i) => {
    let node = i;
    while (rootOf[node] !== node) {
      rootOf[node] = rootOf[rootOf[node]];
      node = rootOf[node];
    }
    return node;
  };
  for (const link of links) {
    if (link.back) continue;
    const a = find(link.u);
    const b = find(link.v);
    if (a !== b) rootOf[Math.max(a, b)] = Math.min(a, b);
  }
  const membersOf = new Map();
  for (let i = 0; i < count; i += 1) {
    const root = find(i);
    const list = membersOf.get(root);
    if (list) list.push(i);
    else membersOf.set(root, [i]);
  }
  const linksOf = new Map();
  for (const link of links) {
    if (link.back) continue;
    const root = find(link.u);
    const list = linksOf.get(root);
    if (list) list.push(link);
    else linksOf.set(root, [link]);
  }

  // 6. Posição vertical: uma faixa por componente; depois os nós isolados, empilhados.
  const topOf = new Float64Array(count);
  const bandGap = gapY * 2;
  let cursor = padding;
  let placedAny = false;
  const isolated = [];
  for (const [root, members] of membersOf) {
    if (members.length === 1) {
      isolated.push(members[0]);
      continue;
    }
    const groupLinks = linksOf.get(root).sort((a, b) => a.u - b.u || a.v - b.v);
    const { tops, height } = layoutComponent(members, groupLinks, layerOf, nodeHeight, gapY);
    if (placedAny) cursor += bandGap;
    for (let i = 0; i < members.length; i += 1) topOf[members[i]] = cursor + tops[i];
    for (const link of groupLinks) {
      if (!link.lane) continue;
      link.lane.first += cursor;
      link.lane.last += cursor;
    }
    cursor += height;
    placedAny = true;
  }
  for (let i = 0; i < isolated.length; i += 1) {
    if (i > 0) cursor += gapY;
    else if (placedAny) cursor += bandGap;
    topOf[isolated[i]] = cursor;
    cursor += nodeHeight;
  }

  // 7. Saída.
  const columnX = (level) => padding + level * (nodeWidth + gapX);
  const orderOf = new Int32Array(count);
  const columns = Array.from({ length: lastLayer + 1 }, () => []);
  for (let i = 0; i < count; i += 1) columns[layerOf[i]].push(i);
  for (const column of columns) {
    column.sort((a, b) => topOf[a] - topOf[b] || a - b);
    for (let i = 0; i < column.length; i += 1) orderOf[column[i]] = i;
  }

  const outNodes = ids.map((id, i) => ({ id, x: columnX(layerOf[i]), y: topOf[i], layer: layerOf[i], order: orderOf[i] }));

  const outEdges = links.map((link) => {
    const start = { x: columnX(layerOf[link.u]) + nodeWidth, y: topOf[link.u] + nodeHeight / 2 };
    const end = { x: columnX(layerOf[link.v]), y: topOf[link.v] + nodeHeight / 2 };
    let first;
    let second;
    if (link.back) {
      // Laço de retorno: sai pela direita, mergulha abaixo das caixas e volta para entrar pela esquerda do destino.
      const reach = Math.max(gapX, nodeHeight / 2);
      const dip = Math.round(((nodeHeight + gapY) / 2) * (4 / 3));
      first = { x: start.x + reach, y: start.y + dip };
      second = { x: end.x - reach, y: end.y + dip };
    } else if (link.lane) {
      // Aresta longa: os pontos de controle ficam nas raias reservadas da primeira e da última camada intermediária.
      first = { x: columnX(layerOf[link.u] + 1) + nodeWidth / 2, y: link.lane.first };
      second = { x: columnX(layerOf[link.v] - 1) + nodeWidth / 2, y: link.lane.last };
    } else {
      const middle = (start.x + end.x) / 2;
      first = { x: middle, y: start.y };
      second = { x: middle, y: end.y };
    }
    const out = { from: ids[link.u], to: ids[link.v], points: [start, first, second, end] };
    if (link.id !== undefined && link.id !== null) out.id = link.id;
    if (link.back) out.back = true;
    return out;
  });

  return {
    nodes: outNodes,
    edges: outEdges,
    width: count ? padding * 2 + (lastLayer + 1) * nodeWidth + lastLayer * gapX : padding * 2,
    height: cursor + padding,
  };
}
