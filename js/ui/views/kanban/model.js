// Modelo do quadro Kanban (js/ui/views/kanban.js): normaliza o estado salvo da tela e monta colunas, raias
// e contagens a partir dos seletores do app. Nada aqui desenha nem grava — só lê `app.sel` e devolve dados.
//
//   const st = normalizeState(ctx.state);
//   const board = buildBoard(app, st);   // { kind, columns, lanes, shown, total }
//
// Custo: uma passada de filtro + UMA ordenação global (os cartões são distribuídos nas colunas já em ordem),
// então o quadro continua leve com centenas de tarefas.

import { PRIORITIES, priorityById } from '../../../domain/priorities.js';
import { applyViewFilters, normalizeFilters, normalizeSort, sortViewItems } from '../../shared/filterbar.js';
import { defaultFilters } from '../../../domain/filters.js';

/** Ordenações oferecidas dentro das colunas. */
export const SORT_KEYS = Object.freeze(['manual', 'priority', 'due_date']);

/** Raias possíveis em cada modo. */
export const LANE_MODES = Object.freeze({
  task: Object.freeze(['none', 'demand', 'project', 'priority']),
  demand: Object.freeze(['none', 'project', 'priority']),
});

/** Rótulos das raias. */
export const LANE_LABELS = Object.freeze({ none: 'Sem raias', demand: 'Demanda', project: 'Projeto', priority: 'Prioridade' });

/** Limite padrão de cartões em "Em andamento" antes do aviso de WIP. */
export const DEFAULT_WIP = 5;

/** Quantos cartões uma coluna (ou célula de raia) mostra antes do "Mostrar mais". */
export const PAGE_SIZE = 50;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Mapa { chave: true } a partir do que estava salvo (descarta o resto). */
function flagMap(value) {
  const out = {};
  if (!isObject(value)) return out;
  for (const [key, on] of Object.entries(value)) if (on === true && key.length <= 200) out[key] = true;
  return out;
}

/** Mapa { chave: número > 0 } a partir do que estava salvo. */
function limitMap(value) {
  const out = {};
  if (!isObject(value)) return out;
  for (const [key, n] of Object.entries(value)) if (Number.isInteger(n) && n > 0 && n <= 100000) out[key] = n;
  return out;
}

/**
 * Estado completo da tela a partir do que estava salvo (tolerante a lixo e a versões antigas).
 * @param {*} raw ctx.state
 * @returns {{ mode: 'task'|'demand', filters: object, sort: { key: string, dir: 'asc'|'desc' },
 *             lanes: string, subtasks: boolean, showCancelled: boolean, collapsed: object, collapsedLanes: object,
 *             wipLimit: number, addTo: string|null, phoneCol: string|null, limits: object }}
 */
export function normalizeState(raw) {
  const s = isObject(raw) ? raw : {};
  const mode = s.mode === 'demand' ? 'demand' : 'task';
  const sort = normalizeSort(s.sort);
  const lanes = LANE_MODES[mode].includes(s.lanes) ? s.lanes : 'none';
  const wip = Number(s.wipLimit);
  return {
    mode,
    filters: normalizeFilters(s.filters),
    sort: SORT_KEYS.includes(sort.key) ? sort : { key: 'manual', dir: sort.dir },
    lanes,
    subtasks: s.subtasks === true,
    showCancelled: s.showCancelled === true,
    collapsed: flagMap(s.collapsed),
    collapsedLanes: flagMap(s.collapsedLanes),
    wipLimit: Number.isInteger(wip) && wip >= 1 && wip <= 999 ? wip : DEFAULT_WIP,
    addTo: typeof s.addTo === 'string' && s.addTo ? s.addTo : null,
    phoneCol: typeof s.phoneCol === 'string' && s.phoneCol ? s.phoneCol : null,
    limits: limitMap(s.limits),
  };
}

/**
 * Status que viram colunas: os da lista efetiva, na ordem, sem os ocultos (`hidden`) e sem os marcados
 * `hiddenInBoard` (Cancelada) — a menos que `showCancelled`.
 * @param {ReadonlyArray<object>} statuses
 * @param {boolean} showCancelled
 * @returns {object[]}
 */
export function boardColumns(statuses, showCancelled) {
  return (Array.isArray(statuses) ? statuses : []).filter((s) => s && s.id && s.hidden !== true && (showCancelled || s.hiddenInBoard !== true));
}

/** Filtros efetivos do quadro: os do usuário, sem filtro de status (as colunas são os status). */
export function boardFilters(st) {
  return { ...st.filters, statusIds: [], showDone: true, showCancelled: st.showCancelled, showArchived: false };
}

/** Itens candidatos (antes dos filtros do usuário): tarefas (com ou sem subtarefas) ou demandas. */
function baseItems(app, st) {
  if (st.mode === 'demand') return app.sel.demands();
  const all = app.sel.tasks();
  return st.subtasks ? all : all.filter((task) => !app.sel.parentOf(task));
}

/** Chave da raia de um item (texto; '' = "sem demanda/projeto"). */
export function laneKeyOf(app, st, item) {
  if (st.lanes === 'priority') return priorityById(item.priority).id;
  if (st.lanes === 'project') return app.sel.projectIdOf(st.mode, item) || '';
  if (st.lanes === 'demand') {
    const demand = app.sel.demandOf(item);
    return demand ? demand.id : '';
  }
  return null;
}

/** Descrição de uma raia (rótulo e o que o cabeçalho precisa). */
function laneInfo(app, st, key) {
  if (st.lanes === 'priority') {
    const def = priorityById(key);
    return { key, kind: 'priority', label: `${def.id} · ${def.label}`, priority: def.id };
  }
  if (st.lanes === 'project') {
    const project = key ? app.sel.project(key) : null;
    return { key, kind: 'project', label: project ? project.name || 'Sem nome' : 'Sem projeto', project, empty: !project };
  }
  const demand = key ? app.sel.demand(key) : null;
  return {
    key,
    kind: 'demand',
    label: demand ? demand.name || 'Sem nome' : 'Sem demanda',
    code: demand ? app.sel.code('demand', demand) : '',
    demand,
    project: demand ? app.sel.project(demand.project_id) : null,
    empty: !demand,
  };
}

/** Posição de cada raia (ordem do resto do app); "sem …" sempre por último. */
function laneOrder(app, st) {
  const order = new Map();
  if (st.lanes === 'priority') PRIORITIES.forEach((p, i) => order.set(p.id, i));
  else if (st.lanes === 'project') app.sel.projects({ includeArchived: true }).forEach((p, i) => order.set(p.id, i));
  else if (st.lanes === 'demand') app.sel.demands({ includeArchived: true }).forEach((d, i) => order.set(d.id, i));
  return order;
}

/**
 * Monta o quadro.
 * @param {object} app
 * @param {ReturnType<typeof normalizeState>} st
 * @returns {{ kind: 'task'|'demand', columns: Array<{ status: object, items: object[], count: number,
 *             estimate: number }>, lanes: Array<{ key: string, label: string, count: number, cells: object[][] }>|null,
 *             shown: number, total: number }}
 */
export function buildBoard(app, st) {
  const kind = st.mode;
  const statuses = app.sel.statuses();
  const defs = boardColumns(statuses, st.showCancelled);
  const index = new Map(defs.map((s, i) => [s.id, i]));
  const byCategory = new Map();
  defs.forEach((s, i) => {
    if (!byCategory.has(s.category)) byCategory.set(s.category, i);
  });
  const columnOf = (item) => {
    if (index.has(item.status)) return index.get(item.status);
    const category = app.sel.status(item.status).category; // status desconhecido/oculto: 1ª coluna da categoria
    return byCategory.has(category) ? byCategory.get(category) : -1;
  };

  const base = baseItems(app, st);
  const total = applyViewFilters(app, base, { ...defaultFilters(), showCancelled: st.showCancelled }, kind).length;
  const visible = sortViewItems(app, applyViewFilters(app, base, boardFilters(st), kind), st.sort, kind);

  const columns = defs.map((status) => ({ status, items: [], count: 0, estimate: 0 }));
  const laneMap = st.lanes === 'none' ? null : new Map();
  let shown = 0;
  for (const item of visible) {
    const col = columnOf(item);
    if (col < 0) continue;
    const column = columns[col];
    column.items.push(item);
    column.count += 1;
    if (Number.isFinite(item.estimate_minutes) && item.estimate_minutes > 0) column.estimate += item.estimate_minutes;
    shown += 1;
    if (laneMap) {
      const key = laneKeyOf(app, st, item);
      let lane = laneMap.get(key);
      if (!lane) {
        lane = { ...laneInfo(app, st, key), count: 0, cells: defs.map(() => []) };
        laneMap.set(key, lane);
      }
      lane.cells[col].push(item);
      lane.count += 1;
    }
  }

  let lanes = null;
  if (laneMap) {
    const order = laneOrder(app, st);
    const rank = (lane) => (lane.key === '' ? Number.MAX_SAFE_INTEGER : order.has(lane.key) ? order.get(lane.key) : Number.MAX_SAFE_INTEGER - 1);
    lanes = [...laneMap.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label, 'pt-BR'));
  }
  return { kind, columns, lanes, shown, total };
}

/**
 * Pode soltar o item (arrastado de `from`) na célula (coluna `statusId`, raia `laneKey`)?
 * Regras: mudar de raia só quando a raia é um campo que o cartão pode receber (prioridade sempre; demanda só
 * para tarefa de nível superior; projeto só para demanda). Sem ordem manual, soltar na própria célula não faz nada.
 * @param {object} app
 * @param {ReturnType<typeof normalizeState>} st
 * @param {{ id: string, data?: { col?: string, lane?: string|null } }} drop
 * @param {string} statusId coluna de destino
 * @param {string|null} laneKey raia de destino (null sem raias)
 * @returns {boolean}
 */
export function canDropInto(app, st, drop, statusId, laneKey) {
  const from = drop && drop.data && typeof drop.data === 'object' ? drop.data : {};
  const sameLane = st.lanes === 'none' || laneKey === null || from.lane === laneKey;
  if (!sameLane) {
    if (st.lanes === 'project' && st.mode === 'task') return false;
    if (st.lanes === 'demand') {
      if (st.mode !== 'task') return false;
      const task = app.sel.task(drop.id);
      if (!task || app.sel.parentOf(task)) return false;
    }
  }
  if (sameLane && from.col === statusId && st.sort.key !== 'manual') return false;
  return true;
}
