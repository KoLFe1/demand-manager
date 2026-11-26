// Modelo da tela "Hierarquia" (Projeto → Demanda → Tarefa → Subtarefa): quais nós aparecem, em que ordem
// e quais ficam expandidos. Só leitura de dados (app.sel) — nada de DOM aqui.
//
//   const model = buildModel(app, filters);                  // memorizado pela versão do banco + filtros
//   const isExpanded = expansionOf(model, ctx.state);
//   const rows = flattenTree(model, { isExpanded, adding });  // lista plana, na ordem da tela
//
// Regras:
//   • um nó aparece se ele mesmo passa nos filtros OU se tem um descendente que passa (o ancestral que não
//     passa é marcado `matched: false` e a tela o mostra esmaecido);
//   • sem filtro ativo todos os projetos aparecem (mesmo vazios); "Sem projeto" e "Tarefas avulsas" só
//     aparecem quando têm conteúdo; com o escopo global de projeto, só aquele projeto (sempre expandido);
//   • expansão: mapa de exceções { chave: true|false } sobre o padrão de cada tipo — projetos e demandas
//     expandidos, tarefas com subtarefas recolhidas. Assim um nó NOVO segue o padrão. Com filtro ativo vale
//     um segundo mapa (zerado quando os filtros mudam) e o padrão é "tudo expandido" (ancestrais dos
//     resultados se abrem sozinhos).
//   • árvore grande (desempenho): quando a árvore aberta no padrão passaria de ROW_LIMIT linhas, o modelo
//     fica `compact` e demandas e tarefas passam a nascer recolhidas (inclusive com filtro); a tela desenha
//     no máximo ROW_LIMIT linhas por vez, com "Mostrar mais" no fim.

import { isFilterActive } from '../../../domain/filters.js';
import { applyViewFilters, normalizeFilters } from '../../shared/filterbar.js';

/** Padrão de expansão por tipo de nó (sem filtro ativo). */
export const DEFAULT_OPEN = Object.freeze({ project: true, group: true, demand: true, task: false });

/**
 * Linhas por "página" da árvore desenhada e limite do modo compacto: acima disso a árvore aberta no padrão
 * custaria centenas de milissegundos por desenho (cada linha tem dezenas de elementos).
 */
export const ROW_LIMIT = 150;

/** Atalhos de nível: até onde a árvore fica aberta. */
export const LEVELS = Object.freeze(['projects', 'demands', 'tasks', 'all']);

/** Profundidade de cada nível (um nó de profundidade d fica aberto quando d < profundidade do nível). */
const LEVEL_DEPTH = Object.freeze({ projects: 0, demands: 1, tasks: 2, all: 3 });

/** Chave do grupo "Sem projeto" (demandas sem projeto). */
export const GROUP_NONE = 'g:none';
/** Chave do grupo "Tarefas avulsas" (tarefas sem demanda). */
export const GROUP_LOOSE = 'g:loose';

const EMPTY = Object.freeze([]);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Chave estável de um nó (identidade nas linhas, no mapa de expansão e no foco). */
export const keyOf = Object.freeze({
  project: (id) => `p:${id}`,
  demand: (id) => `d:${id}`,
  task: (id) => `t:${id}`,
});

/** Objeto simples (estado salvo) ou {}. */
export function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Projeto do escopo global (app.ui.scope.projectId) ou null. */
export function scopeOf(app) {
  try {
    const id = app.ui && app.ui.scope ? app.ui.scope.projectId : null;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** Os filtros mudam o que aparece? (sob escopo, o filtro de projeto salvo não conta) */
export function filtersActive(app, filters) {
  const f = normalizeFilters(filters);
  return isFilterActive(scopeOf(app) ? { ...f, projectIds: [] } : f);
}

// ---------------------------------------------------------------------------
// Modelo (memorizado)
// ---------------------------------------------------------------------------

const cache = new WeakMap();

/**
 * Árvore visível com os filtros aplicados.
 * @param {object} app
 * @param {object} filters filtros da tela (qualquer formato; passam por normalizeFilters)
 * @returns {{ active: boolean, scope: string|null, projects: Array<{ project: object, demands: Array }>,
 *             none: Array, loose: Array, shown: number, total: number, hasAnything: boolean }}
 *          demanda: { demand, matched, tasks }; tarefa: { task, matched, subs }; subtarefa: { task, matched, subs: [] }
 */
export function buildModel(app, filters) {
  const f = normalizeFilters(filters);
  const scope = scopeOf(app);
  const key = `${app.store.version()}|${app.clock.today()}|${scope || ''}|${JSON.stringify(f)}`;
  const hit = cache.get(app);
  if (hit && hit.key === key) return hit.model;
  const model = computeModel(app, f, scope);
  cache.set(app, { key, model });
  return model;
}

function computeModel(app, f, scope) {
  const { sel } = app;
  const active = isFilterActive(scope ? { ...f, projectIds: [] } : f);
  const includeArchived = f.showArchived === true;
  const opts = { includeArchived };
  const allTasks = sel.tasks(opts);
  const allDemands = sel.demands(opts);
  // applyViewFilters já respeita o escopo global (itens de outros projetos não passam).
  const matchedTasks = new Set(applyViewFilters(app, allTasks, f, 'task').map((t) => t.id));
  const matchedDemands = new Set(applyViewFilters(app, allDemands, f, 'demand').map((d) => d.id));

  const taskNode = (task) => {
    const subs = [];
    for (const sub of sel.subtasks(task.id, opts)) {
      if (matchedTasks.has(sub.id)) subs.push(Object.freeze({ task: sub, matched: true, subs: EMPTY }));
    }
    const matched = matchedTasks.has(task.id);
    if (!matched && subs.length === 0) return null;
    return Object.freeze({ task, matched, subs: Object.freeze(subs) });
  };
  const tasksOf = (demandId) => {
    const out = [];
    for (const task of sel.topTasks(demandId, opts)) {
      const node = taskNode(task);
      if (node) out.push(node);
    }
    return Object.freeze(out);
  };
  const demandNode = (demand) => {
    const tasks = tasksOf(demand.id);
    const matched = matchedDemands.has(demand.id);
    if (!matched && tasks.length === 0) return null;
    return Object.freeze({ demand, matched, tasks });
  };
  const demandsOf = (projectId) => {
    const out = [];
    for (const demand of sel.demands({ includeArchived, projectId })) {
      const node = demandNode(demand);
      if (node) out.push(node);
    }
    return Object.freeze(out);
  };

  const projects = [];
  const projectList = scope ? [sel.project(scope)].filter(Boolean) : sel.projects(opts);
  for (const project of projectList) {
    const demands = demandsOf(project.id);
    if (active && demands.length === 0 && project.id !== scope) continue;
    projects.push(Object.freeze({ project, demands }));
  }
  const none = scope ? EMPTY : demandsOf('');
  const loose = scope ? EMPTY : tasksOf(null);

  let total = allTasks.length;
  if (scope) {
    total = 0;
    for (const task of allTasks) if (sel.projectIdOf('task', task) === scope) total += 1;
  }
  const hasAnything = sel.projects().length + sel.demands().length + sel.tasks().length > 0;

  // Linhas da árvore aberta no padrão (projetos, grupos, demandas e tarefas; com filtro, também as
  // subtarefas). Passando do limite, demandas e tarefas nascem recolhidas.
  let defaultRows = projects.length + (none.length ? 1 : 0) + (loose.length ? 1 : 0);
  const countTasks = (tasks) => {
    for (const node of tasks) defaultRows += 1 + (active ? node.subs.length : 0);
  };
  for (const node of projects) {
    defaultRows += node.demands.length;
    for (const d of node.demands) countTasks(d.tasks);
  }
  defaultRows += none.length;
  for (const d of none) countTasks(d.tasks);
  countTasks(loose);
  const compact = defaultRows > ROW_LIMIT;

  return Object.freeze({
    active,
    compact,
    scope,
    projects: Object.freeze(projects),
    none,
    loose,
    shown: matchedTasks.size,
    total,
    hasAnything,
  });
}

// ---------------------------------------------------------------------------
// Expansão
// ---------------------------------------------------------------------------

/**
 * Função (chave, tipo) → expandido? conforme o estado da tela.
 * @param {object} model
 * @param {object} state ctx.state ({ open, fopen })
 * @returns {(key: string, kind: 'project'|'group'|'demand'|'task') => boolean}
 */
export function expansionOf(model, state) {
  const filterMode = model.active;
  const compact = model.compact === true;
  const overrides = plainObject(filterMode ? plainObject(state).fopen : plainObject(state).open);
  return (key, kind) => {
    if (hasOwn(overrides, key) && typeof overrides[key] === 'boolean') return overrides[key];
    return defaultOpen(kind, filterMode, compact);
  };
}

/** Padrão de um tipo de nó no modo atual (compact: árvore grande — demandas e tarefas recolhidas). */
export function defaultOpen(kind, filterMode, compact = false) {
  if (compact && (kind === 'demand' || kind === 'task')) return false;
  return filterMode ? true : DEFAULT_OPEN[kind] === true;
}

/**
 * Mapa de exceções que deixa a árvore aberta até um nível (só guarda o que difere do padrão).
 * @param {object} model
 * @param {'projects'|'demands'|'tasks'|'all'} level
 * @returns {Record<string, boolean>}
 */
export function levelOverrides(model, level) {
  const depth = LEVEL_DEPTH[level] ?? LEVEL_DEPTH.tasks;
  const filterMode = model.active;
  const compact = model.compact === true;
  const out = {};
  const put = (key, kind, nodeDepth) => {
    const want = nodeDepth < depth;
    if (want !== defaultOpen(kind, filterMode, compact)) out[key] = want;
  };
  const walkTasks = (tasks) => {
    for (const node of tasks) if (node.subs.length) put(keyOf.task(node.task.id), 'task', 2);
  };
  const walkDemands = (demands) => {
    for (const node of demands) {
      put(keyOf.demand(node.demand.id), 'demand', 1);
      walkTasks(node.tasks);
    }
  };
  for (const node of model.projects) {
    if (node.project.id !== model.scope) put(keyOf.project(node.project.id), 'project', 0);
    walkDemands(node.demands);
  }
  if (model.none.length) {
    put(GROUP_NONE, 'group', 0);
    walkDemands(model.none);
  }
  if (model.loose.length) {
    put(GROUP_LOOSE, 'group', 0);
    // tarefas avulsas ficam um nível acima das tarefas de demandas: "Demandas" já as esconde só pelo grupo
    for (const node of model.loose) if (node.subs.length) put(keyOf.task(node.task.id), 'task', 2);
  }
  return out;
}

/**
 * Remove do mapa de exceções as chaves de itens que não existem mais e as que repetem o padrão.
 * @param {object} app
 * @param {Record<string, boolean>} overrides
 * @param {boolean} filterMode
 * @param {boolean} [compact] árvore grande (model.compact)
 * @returns {Record<string, boolean>}
 */
export function pruneOverrides(app, overrides, filterMode, compact = false) {
  const out = {};
  for (const [key, value] of Object.entries(plainObject(overrides))) {
    if (typeof value !== 'boolean') continue;
    const type = key.slice(0, 2);
    const id = key.slice(2);
    let kind = null;
    if (type === 'g:') kind = 'group';
    else if (type === 'p:' && app.sel.project(id)) kind = 'project';
    else if (type === 'd:' && app.sel.demand(id)) kind = 'demand';
    else if (type === 't:' && app.sel.task(id)) kind = 'task';
    if (kind === null || value === defaultOpen(kind, filterMode, compact)) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lista plana de linhas
// ---------------------------------------------------------------------------

/**
 * Linhas visíveis, na ordem da tela.
 * @param {object} model
 * @param {{ isExpanded: Function, adding?: string|null }} options adding: chave do nó com a criação em linha aberta
 * @returns {Array<object>} { kind: 'project'|'group'|'demand'|'task'|'subtask'|'add'|'hint', key, parent, level,
 *          entity, node, expandable, expanded, locked, matched, posinset, setsize, … }
 */
export function flattenTree(model, { isExpanded, adding = null } = {}) {
  const rows = [];
  const openState = (key, kind, hasChildren) => {
    const expandable = hasChildren || adding === key;
    return { expandable, expanded: expandable && (adding === key || isExpanded(key, kind)) };
  };
  const addRow = (parentKey, level, addType, defaults) => {
    if (adding !== parentKey) return;
    rows.push({ kind: 'add', key: `add:${parentKey}`, parent: parentKey, level, addType, defaults });
  };

  const pushSubtasks = (taskNode, parentKey, level) => {
    taskNode.subs.forEach((sub, index) => {
      rows.push({
        kind: 'subtask',
        key: keyOf.task(sub.task.id),
        parent: parentKey,
        level,
        entity: sub.task,
        node: sub,
        matched: sub.matched,
        expandable: false,
        expanded: false,
        posinset: index + 1,
        setsize: taskNode.subs.length,
      });
    });
  };

  const pushTasks = (tasks, parentKey, level, { allowSubtaskAdd = true } = {}) => {
    tasks.forEach((node, index) => {
      const key = keyOf.task(node.task.id);
      const { expandable, expanded } = openState(key, 'task', node.subs.length > 0);
      rows.push({ kind: 'task', key, parent: parentKey, level, entity: node.task, node, matched: node.matched, expandable, expanded, posinset: index + 1, setsize: tasks.length });
      if (!expanded) return;
      pushSubtasks(node, key, level + 1);
      if (allowSubtaskAdd) addRow(key, level + 1, 'task', { parent_id: node.task.id });
    });
  };

  const pushDemands = (demands, parentKey, level) => {
    demands.forEach((node, index) => {
      const key = keyOf.demand(node.demand.id);
      const { expandable, expanded } = openState(key, 'demand', node.tasks.length > 0);
      rows.push({ kind: 'demand', key, parent: parentKey, level, entity: node.demand, node, matched: node.matched, expandable, expanded, posinset: index + 1, setsize: demands.length });
      if (!expanded) return;
      pushTasks(node.tasks, key, level + 1);
      addRow(key, level + 1, 'task', { demand_id: node.demand.id });
    });
  };

  const topCount = model.projects.length + (model.none.length ? 1 : 0) + (model.loose.length ? 1 : 0);
  let position = 0;

  for (const node of model.projects) {
    position += 1;
    const project = node.project;
    const key = keyOf.project(project.id);
    const locked = project.id === model.scope;
    const hasChildren = node.demands.length > 0 || !model.active;
    let expandable;
    let expanded;
    if (locked) {
      expandable = false;
      expanded = true;
    } else {
      ({ expandable, expanded } = openState(key, 'project', hasChildren));
    }
    rows.push({ kind: 'project', key, parent: null, level: 1, entity: project, node, matched: true, expandable, expanded, locked, posinset: position, setsize: topCount });
    if (!expanded) continue;
    pushDemands(node.demands, key, 2);
    addRow(key, 2, 'demand', { project_id: project.id });
    if (node.demands.length === 0 && adding !== key) {
      rows.push({ kind: 'hint', key: `hint:${key}`, parent: key, level: 2, addKey: key, text: 'Nenhuma demanda neste projeto.', action: 'Adicionar demanda' });
    }
  }

  if (model.none.length) {
    position += 1;
    const { expandable, expanded } = openState(GROUP_NONE, 'group', true);
    rows.push({ kind: 'group', group: 'none', key: GROUP_NONE, parent: null, level: 1, entity: null, node: model.none, matched: true, expandable, expanded, posinset: position, setsize: topCount });
    if (expanded) {
      pushDemands(model.none, GROUP_NONE, 2);
      addRow(GROUP_NONE, 2, 'demand', {});
    }
  }

  if (model.loose.length) {
    position += 1;
    const { expandable, expanded } = openState(GROUP_LOOSE, 'group', true);
    rows.push({ kind: 'group', group: 'loose', key: GROUP_LOOSE, parent: null, level: 1, entity: null, node: model.loose, matched: true, expandable, expanded, posinset: position, setsize: topCount });
    if (expanded) {
      pushTasks(model.loose, GROUP_LOOSE, 2);
      addRow(GROUP_LOOSE, 2, 'task', {});
    }
  }
  return rows;
}
