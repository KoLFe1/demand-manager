// Tela "Dependências" — modelo de dados (sem DOM). Junta o grafo do app (app.sel.graph), os filtros da tela
// e o escopo global de projeto num modelo pronto para desenhar: nós com posição (layoutGraph), arestas
// classificadas (pendente, satisfeita, conflito de prazo, ciclo), conflitos e ciclos visíveis.
//
// O modelo é memorizado pela versão do banco + filtros + "hoje": re-renderizar a tela (passar o mouse num nó,
// trocar o zoom) não refaz o layout.

import { dependencyChain, layoutGraph } from '../../../domain/dependencies.js';

/** Medidas das caixas do diagrama (px no sistema de coordenadas do SVG). */
export const NODE_W = 224;
export const NODE_H = 58;
export const LAYOUT_OPTIONS = Object.freeze({ nodeWidth: NODE_W, nodeHeight: NODE_H, gapX: 56, gapY: 16, padding: 28 });

/** Valores especiais do filtro de demanda. */
export const DEMAND_ALL = null;
export const DEMAND_NONE = '__none';

const COLLATOR = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/** Chave de uma aresta (pré-requisito → dependente). */
export const edgeKey = (from, to) => `${from}>${to}`;

/** Nome legível de uma tarefa. */
export function taskName(task) {
  const name = task && typeof task.name === 'string' ? task.name.trim() : '';
  return name || 'Tarefa sem nome';
}

/** Filtro de demanda válido (demanda apagada/arquivada volta para "Todas"). */
export function normalizeDemandFilter(app, value) {
  if (value === DEMAND_NONE) return DEMAND_NONE;
  if (typeof value === 'string' && value && app.sel.demand(value) && !app.sel.isHidden('demand', value)) return value;
  return DEMAND_ALL;
}

let cache = { key: null, value: null };

/**
 * Monta (ou devolve do cache) o modelo da tela.
 * @param {object} app
 * @param {{ demandId: string|null, hideDone: boolean, showIsolated: boolean, projectId: string|null, forceId?: string|null }} filters
 * @returns {object}
 */
export function buildModel(app, filters) {
  const { demandId, hideDone, showIsolated, projectId, forceId = null } = filters;
  const key = [app.store.version(), app.clock.today(), demandId || '', hideDone ? 1 : 0, showIsolated ? 1 : 0, projectId || '', forceId || ''].join('|');
  if (cache.key === key) return cache.value;
  const value = computeModel(app, { demandId, hideDone, showIsolated, projectId, forceId });
  cache = { key, value };
  return value;
}

function computeModel(app, { demandId, hideDone, showIsolated, projectId, forceId }) {
  const sel = app.sel;
  const graph = sel.graph();
  const visible = sel.tasks();
  const byId = new Map();
  for (const task of visible) byId.set(task.id, task);

  // Escopo: projeto global + demanda escolhida.
  const projectOk = (task) => !projectId || sel.projectIdOf('task', task) === projectId;
  const demandOk = (task) => {
    if (demandId === DEMAND_ALL) return true;
    const demand = sel.demandOf(task);
    return demandId === DEMAND_NONE ? !demand : !!demand && demand.id === demandId;
  };
  const shown = (task) => !hideDone || sel.isOpen(task);

  const inScope = new Set();
  for (const task of visible) if (projectOk(task) && demandOk(task)) inScope.add(task.id);

  // Arestas entre tarefas visíveis com pelo menos uma ponta no escopo.
  const edges = [];
  const nodeIds = new Set();
  let scopeEdgeCount = 0;
  for (const edge of graph.edges) {
    const from = edge.depends_on_id;
    const to = edge.task_id;
    const prereq = byId.get(from);
    const dependent = byId.get(to);
    if (!prereq || !dependent) continue;
    if (!inScope.has(from) && !inScope.has(to)) continue;
    // Vizinho fora do escopo de projeto só aparece se a outra ponta estiver no escopo (contexto entre projetos).
    scopeEdgeCount += 1;
    if (!shown(prereq) || !shown(dependent)) continue;
    edges.push({ id: edge.id, from, to });
    nodeIds.add(from);
    nodeIds.add(to);
  }
  if (showIsolated) {
    for (const id of inScope) if (shown(byId.get(id))) nodeIds.add(id);
  }
  if (forceId && byId.has(forceId) && projectOk(byId.get(forceId))) nodeIds.add(forceId);

  // Ordem de entrada do layout: a ordem de criação das tarefas (determinística).
  const ordered = visible.filter((task) => nodeIds.has(task.id));
  const layout = layoutGraph(
    ordered.map((task) => task.id),
    edges,
    LAYOUT_OPTIONS,
  );

  // Ciclos (dados danificados por edições simultâneas): arestas dos laços e ciclos com nomes.
  const cycles = sel.cycles();
  const cycleEdges = new Set();
  for (const path of cycles) {
    // path = [A, B, C, A]: A depende de B → aresta B → A.
    for (let i = 0; i + 1 < path.length; i += 1) cycleEdges.add(edgeKey(path[i + 1], path[i]));
  }

  // Conflitos de prazo: das tarefas no escopo (e da aresta envolvida).
  const allConflicts = sel.conflicts();
  const conflictEdges = new Map();
  const conflicts = [];
  for (const [taskId, list] of allConflicts) {
    const task = byId.get(taskId);
    if (!task) continue;
    for (const conflict of list) {
      if (!conflict.prereqId) continue;
      const k = edgeKey(conflict.prereqId, taskId);
      const prev = conflictEdges.get(k);
      if (!prev || conflict.severity === 'danger') conflictEdges.set(k, conflict.severity);
    }
    if (inScope.has(taskId)) conflicts.push({ task, list });
  }
  conflicts.sort((a, b) => {
    const sa = a.list.some((c) => c.severity === 'danger') ? 0 : 1;
    const sb = b.list.some((c) => c.severity === 'danger') ? 0 : 1;
    return sa - sb || String(a.task.due_date || '9999').localeCompare(String(b.task.due_date || '9999')) || COLLATOR.compare(taskName(a.task), taskName(b.task));
  });

  // Classificação das arestas.
  const position = new Map(layout.nodes.map((node) => [node.id, node]));
  const layoutEdges = new Map(layout.edges.map((edge) => [edgeKey(edge.from, edge.to), edge]));
  const outEdges = edges.map((edge) => {
    const k = edgeKey(edge.from, edge.to);
    const drawn = layoutEdges.get(k);
    const prereqOpen = sel.isOpen(byId.get(edge.from));
    const dependentOpen = sel.isOpen(byId.get(edge.to));
    let kind = 'pending';
    if (cycleEdges.has(k) || (drawn && drawn.back)) kind = 'cycle';
    else if (conflictEdges.has(k) && prereqOpen && dependentOpen) kind = 'conflict';
    else if (!prereqOpen || !dependentOpen) kind = 'satisfied';
    return { ...edge, key: k, kind, points: drawn ? drawn.points : null, back: !!(drawn && drawn.back) };
  });

  // Adjacência só do que está desenhado (realce da cadeia).
  const prereqs = new Map();
  const dependents = new Map();
  for (const id of nodeIds) {
    prereqs.set(id, new Set());
    dependents.set(id, new Set());
  }
  for (const edge of outEdges) {
    prereqs.get(edge.to).add(edge.from);
    dependents.get(edge.from).add(edge.to);
  }

  // Nós na ordem de tabulação: coluna a coluna, de cima para baixo.
  const nodes = layout.nodes
    .map((node) => ({ ...node, task: byId.get(node.id), external: !inScope.has(node.id) }))
    .sort((a, b) => a.layer - b.layer || a.order - b.order);

  return Object.freeze({
    nodes,
    edges: outEdges,
    position,
    width: layout.width,
    height: layout.height,
    localGraph: { prereqs, dependents },
    inScope,
    byId,
    conflicts,
    cycles,
    scopeEdgeCount,
    scopeTaskCount: inScope.size,
  });
}

/**
 * Conjunto realçado a partir de um nó: ele, tudo de que depende (acima) e tudo que depende dele (abaixo),
 * considerando só o que está desenhado.
 * @returns {{ nodes: Set<string>, edges: Set<string>, up: Set<string>, down: Set<string> }|null}
 */
export function highlightOf(model, activeId) {
  if (!activeId || !model.position.has(activeId)) return null;
  const up = new Set(dependencyChain(activeId, { graph: model.localGraph, direction: 'up' }).map((item) => item.id));
  const down = new Set(dependencyChain(activeId, { graph: model.localGraph, direction: 'down' }).map((item) => item.id));
  const nodes = new Set([activeId, ...up, ...down]);
  const edges = new Set();
  for (const edge of model.edges) {
    const upward = up.has(edge.from) && (edge.to === activeId || up.has(edge.to));
    const downward = down.has(edge.to) && (edge.from === activeId || down.has(edge.from));
    if (upward || downward) edges.add(edge.key);
  }
  return { nodes, edges, up, down };
}

/**
 * Tarefas no escopo que têm pré-requisitos (modo Lista), com a cadeia "acima" de cada uma.
 * @returns {Array<{ task: object, chain: Array<{ task: object, depth: number }> }>}
 */
export function listEntries(app, model, { hideDone }) {
  const sel = app.sel;
  const graph = sel.graph();
  const out = [];
  for (const id of model.inScope) {
    const task = model.byId.get(id);
    if (!task || (hideDone && !sel.isOpen(task))) continue;
    const chain = [];
    for (const item of dependencyChain(id, { graph, direction: 'up' })) {
      const row = model.byId.get(item.id);
      if (!row || (hideDone && !sel.isOpen(row))) continue;
      chain.push({ task: row, depth: item.depth });
    }
    if (!chain.length) continue;
    out.push({ task, chain, blocked: sel.isBlockedByDependency(id), conflicts: sel.conflictsOf(id).length });
  }
  out.sort(
    (a, b) =>
      Number(sel.isOpen(b.task)) - Number(sel.isOpen(a.task)) ||
      Number(b.blocked) - Number(a.blocked) ||
      Number(b.conflicts > 0) - Number(a.conflicts > 0) ||
      String(a.task.due_date || '9999').localeCompare(String(b.task.due_date || '9999')) ||
      COLLATOR.compare(taskName(a.task), taskName(b.task)),
  );
  return out;
}

/** Tarefas visíveis (para os seletores), ordenadas: abertas primeiro, depois por nome. */
export function pickableTasks(app) {
  const list = app.sel.tasks().slice();
  list.sort((a, b) => Number(app.sel.isOpen(b)) - Number(app.sel.isOpen(a)) || COLLATOR.compare(taskName(a), taskName(b)));
  return list;
}

