// Cronograma (Gantt) — regras PURAS: monta as linhas, barras, marcos, ligações e a régua de datas.
// Sem DOM, sem banco e sem relógio implícito (today/hoursPerDay chegam por parâmetro).
//
//   const model = buildGantt({ tasks, demands, graph, conflicts, statuses, today, hoursPerDay, projectId });
//   model.rows     linhas na ordem de desenho: demanda (barra-resumo) → tarefas (→ subtarefas, se pedidas)
//   model.undated  itens sem nenhuma data (lista "Sem datas")
//   model.links    ligações de dependência entre linhas desenhadas { from, to, conflict }
//
// Datas da barra de uma tarefa:
//   • início planejado + prazo → barra planned_start → due_date (ordem corrigida se invertidas);
//   • só prazo + estimativa    → a barra ocupa N dias úteis terminando no prazo,
//                                N = ceil(estimativa em horas ÷ horas por dia) (mínimo 1);
//   • só prazo                 → marco (losango) no prazo;
//   • só início + estimativa   → barra tracejada de N dias úteis COMEÇANDO no início (source 'estimate_end');
//   • só início planejado      → marcador de início (kind 'start', sem término definido: `openEnd`).
// Barras derivadas da estimativa são tracejadas; ESTIMATE_TITLES dá o texto da legenda/dica de cada caso.
// Demanda: barra-resumo do menor início ao maior término das suas tarefas desenhadas; sem tarefas com data,
// usa as datas da própria demanda (início planejado/prazo; só prazo → marco).

import { addDays, addWorkdays, diffDays, formatDate, isValidDateStr, isWeekend, MONTHS_SHORT, MONTHS, parseDate, startOfMonth, startOfWeek } from '../core/dates.js';
import { statusById } from './statuses.js';

/** Pixels por dia de cada escala de zoom. */
export const GANTT_SCALES = Object.freeze({ day: 28, week: 8, month: 2.5 });
/** Rótulos das escalas (pt-BR). */
export const GANTT_SCALE_LABELS = Object.freeze({ day: 'Dias', week: 'Semanas', month: 'Meses' });
/** Limite de linhas desenhadas (desempenho, como nas outras telas). */
export const GANTT_MAX_ROWS = 400;

/** Textos (legenda e dica da barra) das barras tracejadas derivadas da estimativa, por `source`. */
export const ESTIMATE_TITLES = Object.freeze({
  estimate: 'Duração estimada (sem início planejado)',
  estimate_end: 'Duração estimada (sem prazo)',
});
/** Texto do marcador de início (só início planejado, sem prazo nem estimativa). */
export const START_MARKER_TITLE = 'Início planejado (sem prazo nem estimativa)';

/** Valores especiais do escopo de projeto. */
export const GANTT_ALL = null;
export const GANTT_NO_PROJECT = '';

const valid = (d) => (isValidDateStr(d) ? d : null);
const bySort = (a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || (Number(a.seq) || 0) - (Number(b.seq) || 0) || String(a.id).localeCompare(String(b.id));

/** Recua n dias úteis (n >= 0) a partir da data; parte do dia útil anterior se a data cair no fim de semana. */
export function subtractWorkdays(date, n) {
  let d = valid(date);
  if (!d) return null;
  while (isWeekend(d)) d = addDays(d, -1);
  let left = Math.max(0, Math.floor(n));
  while (left > 0) {
    d = addDays(d, -1);
    if (!isWeekend(d)) left--;
  }
  return d;
}

/**
 * Início derivado da estimativa: N dias úteis terminando no prazo.
 * @param {string} dueDate
 * @param {number} estimateMinutes
 * @param {number} [hoursPerDay=8]
 * @returns {string|null}
 */
export function startFromEstimate(dueDate, estimateMinutes, hoursPerDay = 8) {
  const due = valid(dueDate);
  const minutes = Number(estimateMinutes);
  if (!due || !Number.isFinite(minutes) || minutes <= 0) return null;
  const hours = Number(hoursPerDay) > 0 ? Number(hoursPerDay) : 8;
  const days = Math.max(1, Math.ceil(minutes / 60 / hours));
  return subtractWorkdays(due, days - 1);
}

/**
 * Término derivado da estimativa: N dias úteis começando no início planejado.
 * @param {string} startDate
 * @param {number} estimateMinutes
 * @param {number} [hoursPerDay=8]
 * @returns {string|null}
 */
export function endFromEstimate(startDate, estimateMinutes, hoursPerDay = 8) {
  const start = valid(startDate);
  const minutes = Number(estimateMinutes);
  if (!start || !Number.isFinite(minutes) || minutes <= 0) return null;
  const hours = Number(hoursPerDay) > 0 ? Number(hoursPerDay) : 8;
  const days = Math.max(1, Math.ceil(minutes / 60 / hours));
  return addWorkdays(start, days - 1);
}

/**
 * Forma de uma entidade no cronograma (sem considerar filhos).
 * @returns {{ kind: 'bar'|'milestone'|'start', start: string, end: string, source: string, openEnd?: boolean }|null}
 */
export function entitySpan(entity, { hoursPerDay = 8, useEstimate = true } = {}) {
  if (!entity) return null;
  const start = valid(entity.planned_start);
  const due = valid(entity.due_date);
  if (start && due) {
    const [a, b] = start <= due ? [start, due] : [due, start];
    return { kind: 'bar', start: a, end: b, source: 'planned' };
  }
  if (due) {
    const derived = useEstimate ? startFromEstimate(due, entity.estimate_minutes, hoursPerDay) : null;
    if (derived) return { kind: 'bar', start: derived <= due ? derived : due, end: due, source: 'estimate' };
    return { kind: 'milestone', start: due, end: due, source: 'due' };
  }
  if (start) {
    const derived = useEstimate ? endFromEstimate(start, entity.estimate_minutes, hoursPerDay) : null;
    if (derived) return { kind: 'bar', start, end: derived >= start ? derived : start, source: 'estimate_end' };
    // Demanda (sem estimativa): barra de um dia; tarefa: marcador de início.
    if (!useEstimate) return { kind: 'bar', start, end: start, source: 'start', openEnd: true };
    return { kind: 'start', start, end: start, source: 'start', openEnd: true };
  }
  return null;
}

/**
 * Monta o modelo do cronograma.
 * @param {object} p
 * @param {Iterable<object>} p.tasks       tarefas VISÍVEIS (subtarefas inclusive)
 * @param {Iterable<object>} p.demands     demandas visíveis (na ordem desejada)
 * @param {object} [p.graph]               grafo de buildGraph (para as ligações)
 * @param {Map<string, object[]>} [p.conflicts] scheduleConflicts (para marcar ligações em conflito)
 * @param {Array} [p.statuses]
 * @param {string} p.today
 * @param {number} [p.hoursPerDay=8]
 * @param {string|null} [p.projectId=null] null = todos; '' = só demandas sem projeto (e tarefas avulsas); id = o projeto
 * @param {boolean} [p.showDone=false]     mostra concluídas e canceladas
 * @param {boolean} [p.showSubtasks=false] desenha as subtarefas sob as tarefas
 * @param {number} [p.maxRows=GANTT_MAX_ROWS]
 */
export function buildGantt({ tasks, demands, graph = null, conflicts = null, statuses, today, hoursPerDay = 8, projectId = GANTT_ALL, showDone = false, showSubtasks = false, maxRows = GANTT_MAX_ROWS } = {}) {
  if (!isValidDateStr(today)) throw new TypeError('buildGantt: today inválido');
  const category = (e) => statusById(statuses, e.status).category;
  const isClosed = (e) => {
    const c = category(e);
    return c === 'done' || c === 'cancelled';
  };
  const shown = (e) => showDone || !isClosed(e);

  const allTasks = [...(tasks || [])];
  const taskIds = new Set(allTasks.map((t) => t.id));
  const subsOf = new Map();
  const topByDemand = new Map();
  for (const t of allTasks) {
    if (t.parent_id && taskIds.has(t.parent_id) && t.parent_id !== t.id) {
      if (!subsOf.has(t.parent_id)) subsOf.set(t.parent_id, []);
      subsOf.get(t.parent_id).push(t);
    } else {
      const key = t.demand_id || '';
      if (!topByDemand.has(key)) topByDemand.set(key, []);
      topByDemand.get(key).push(t);
    }
  }

  const rows = [];
  const undated = [];
  const opts = { hoursPerDay };

  const taskRow = (task, depth, parentKey) => {
    const span = entitySpan(task, opts);
    if (!span) return null;
    const open = !isClosed(task);
    return {
      key: `task:${task.id}`,
      type: 'task',
      id: task.id,
      entity: task,
      depth,
      parentKey,
      kind: span.kind,
      start: span.start,
      end: span.end,
      source: span.source,
      openEnd: !!span.openEnd,
      status: task.status,
      category: category(task),
      overdue: open && !!valid(task.due_date) && task.due_date < today,
      conflict: false,
      subtaskCount: (subsOf.get(task.id) || []).filter(shown).length,
    };
  };

  /** Tarefas de um grupo → linhas (com subtarefas opcionais); devolve as linhas criadas. */
  const pushTasks = (list, depth, parentKey) => {
    const out = [];
    for (const task of [...list].sort(bySort)) {
      if (!shown(task)) continue;
      const row = taskRow(task, depth, parentKey);
      if (row) out.push(row);
      else undated.push({ key: `task:${task.id}`, type: 'task', id: task.id, entity: task });
      if (showSubtasks) {
        for (const sub of [...(subsOf.get(task.id) || [])].sort(bySort)) {
          if (!shown(sub)) continue;
          const subRow = taskRow(sub, depth + 1, row ? row.key : parentKey);
          if (subRow) out.push(subRow);
          else undated.push({ key: `task:${sub.id}`, type: 'task', id: sub.id, entity: sub });
        }
      }
    }
    return out;
  };

  const demandList = [...(demands || [])];
  const demandIds = new Set(demandList.map((d) => d.id));
  for (const demand of demandList) {
    if (projectId !== GANTT_ALL && (demand.project_id || '') !== projectId) continue;
    if (!shown(demand)) continue;
    const key = `demand:${demand.id}`;
    const children = pushTasks(topByDemand.get(demand.id) || [], 1, key);
    let span = null;
    for (const r of children) {
      if (!span) span = { start: r.start, end: r.end };
      else {
        if (r.start < span.start) span.start = r.start;
        if (r.end > span.end) span.end = r.end;
      }
    }
    let kind = 'summary';
    let source = 'children';
    if (!span) {
      const own = entitySpan(demand, { ...opts, useEstimate: false });
      if (own) {
        span = { start: own.start, end: own.end };
        kind = own.kind === 'milestone' ? 'milestone' : 'summary';
        source = own.source;
      }
    }
    if (!span) {
      undated.push({ key, type: 'demand', id: demand.id, entity: demand });
      continue;
    }
    const open = !isClosed(demand);
    rows.push({
      key,
      type: 'demand',
      id: demand.id,
      entity: demand,
      depth: 0,
      parentKey: null,
      kind,
      start: span.start,
      end: span.end,
      source,
      openEnd: false,
      status: demand.status,
      category: category(demand),
      overdue: open && !!valid(demand.due_date) && demand.due_date < today,
      conflict: false,
      childCount: children.length,
    });
    rows.push(...children);
  }
  // Tarefas sem demanda (ou com demanda fora da lista) só aparecem em "todos" e em "sem projeto".
  if (projectId === GANTT_ALL || projectId === GANTT_NO_PROJECT) {
    const loose = [];
    for (const [demandId, list] of topByDemand) {
      if (!demandId || !demandIds.has(demandId)) loose.push(...list);
    }
    rows.push(...pushTasks(loose, 0, null));
  }

  const total = rows.length;
  const truncated = total > maxRows;
  const drawn = truncated ? rows.slice(0, maxRows) : rows;

  // Ligações: pré-requisito → dependente, só entre tarefas desenhadas.
  const rowIndex = new Map(drawn.map((r, i) => [r.key, i]));
  const links = [];
  const seen = new Set();
  for (const edge of (graph && graph.edges) || []) {
    const from = edge.depends_on_id;
    const to = edge.task_id;
    const k = `${from}>${to}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!rowIndex.has(`task:${from}`) || !rowIndex.has(`task:${to}`)) continue;
    const list = conflicts && typeof conflicts.get === 'function' ? conflicts.get(to) || [] : [];
    const conflict = list.some((c) => c.prereqId === from);
    links.push({ key: k, from, to, conflict });
    if (conflict) drawn[rowIndex.get(`task:${to}`)].conflict = true;
  }

  return { rows: drawn, undated, links, total, truncated, range: ganttRange(drawn, today) };
}

/** Menor início e maior término das linhas (incluindo hoje). */
export function ganttRange(rows, today) {
  let from = valid(today);
  let to = valid(today);
  for (const r of rows || []) {
    if (!from || r.start < from) from = r.start;
    if (!to || r.end > to) to = r.end;
  }
  return { from, to };
}

/**
 * Janela desenhada para uma escala: margem antes/depois, alinhada ao início da semana/mês.
 * @param {{from: string, to: string}} range
 * @param {'day'|'week'|'month'} scale
 * @param {{ minDays?: number }} [options] minDays: largura mínima em dias (a régua preenche a área visível)
 */
export function ganttWindow(range, scale = 'week', { minDays = 0 } = {}) {
  const win = baseWindow(range, scale);
  const days = diffDays(win.from, win.to) + 1;
  if (minDays > days) win.to = addDays(win.to, Math.ceil(minDays - days));
  return win;
}

function baseWindow(range, scale) {
  const { from, to } = range;
  if (scale === 'day') return { from: addDays(from, -3), to: addDays(to, 7) };
  if (scale === 'month') {
    const start = startOfMonth(addDays(from, -10));
    const endBase = parseDate(addDays(to, 30));
    const end = addDays(`${endBase.getFullYear()}-${String(endBase.getMonth() + 1).padStart(2, '0')}-01`, -1);
    return { from: start, to: end };
  }
  return { from: startOfWeek(addDays(from, -7)), to: addDays(startOfWeek(addDays(to, 14)), -1) };
}

/** Posição x (px) do início de um dia na janela. */
export const ganttX = (windowFrom, date, pxPerDay) => diffDays(windowFrom, date) * pxPerDay;

/**
 * Marcas da régua.
 *   major: faixas de cima (mês na escala dia/semana; ano na escala mês)
 *   minor: marcas de baixo (dia; segunda-feira da semana; mês)
 * Cada marca: { date, x, width, label, weekend? }.
 */
export function ganttTicks(win, scale = 'week') {
  const px = GANTT_SCALES[scale] || GANTT_SCALES.week;
  const total = diffDays(win.from, win.to) + 1;
  const major = [];
  const minor = [];
  const end = addDays(win.to, 1);
  const push = (list, a, b, label, extra) => {
    const x = Math.max(0, diffDays(win.from, a)) * px;
    const x2 = Math.min(total, diffDays(win.from, b)) * px;
    if (x2 > x) list.push({ date: a, x, width: x2 - x, label, ...extra });
  };
  const nextMonth = (d) => {
    const p = parseDate(d);
    return `${p.getFullYear() + (p.getMonth() === 11 ? 1 : 0)}-${String(((p.getMonth() + 1) % 12) + 1).padStart(2, '0')}-01`;
  };
  if (scale === 'month') {
    for (let d = startOfMonth(win.from); d < end; d = nextMonth(d)) {
      const p = parseDate(d);
      push(minor, d, nextMonth(d), MONTHS_SHORT[p.getMonth()]);
    }
    for (let y = Number(win.from.slice(0, 4)); y <= Number(win.to.slice(0, 4)); y++) push(major, `${y}-01-01`, `${y + 1}-01-01`, String(y));
  } else {
    for (let d = startOfMonth(win.from); d < end; d = nextMonth(d)) {
      const p = parseDate(d);
      push(major, d, nextMonth(d), `${MONTHS[p.getMonth()]} ${p.getFullYear()}`);
    }
    if (scale === 'day') {
      for (let d = win.from; d < end; d = addDays(d, 1)) push(minor, d, addDays(d, 1), String(parseDate(d).getDate()), { weekend: isWeekend(d) });
    } else {
      for (let d = startOfWeek(win.from); d < end; d = addDays(d, 7)) push(minor, d, addDays(d, 7), formatDate(d, 'daymonth'));
    }
  }
  return { major, minor, width: total * px, pxPerDay: px };
}

/**
 * Patch de datas ao arrastar uma barra de tarefa no cronograma (puro; o comando grava e audita).
 *   mode 'move'   → planned_start e due_date andam juntos N dias (só os campos que existem);
 *   mode 'resize' → borda direita: só due_date = término desenhado + N (nunca antes do início planejado).
 * @param {{ entity: object, end: string }} row linha do modelo (buildGantt)
 * @param {'move'|'resize'} mode
 * @param {number} days deslocamento em dias corridos (inteiro; 0 = nada)
 * @returns {object|null} { planned_start?, due_date? } ou null quando nada muda
 */
export function ganttDragPatch(row, mode, days) {
  const n = Math.trunc(Number(days) || 0);
  const task = row && row.entity;
  if (!task || !n) return null;
  const start = valid(task.planned_start);
  const due = valid(task.due_date);
  if (mode === 'resize') {
    const end = valid(row.end) || due || start;
    if (!end) return null;
    let next = addDays(end, n);
    if (start && next < start) next = start;
    return next === due ? null : { due_date: next };
  }
  const patch = {};
  if (start) patch.planned_start = addDays(start, n);
  if (due) patch.due_date = addDays(due, n);
  return Object.keys(patch).length ? patch : null;
}
