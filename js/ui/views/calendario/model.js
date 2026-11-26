// Calendário — dados da tela: estado normalizado, períodos (mês / semana / dia) e os itens de cada dia
// (prazos de demandas e tarefas e, opcionalmente, inícios planejados).
//
// Tudo aqui é puro em relação ao DOM: recebe o app e o estado da tela e devolve estruturas congeladas.
// O agrupamento por dia é refeito só quando o banco, o "hoje", o escopo, os filtros ou as chaves mudam
// (cache de uma entrada) — a tela pode chamar collectItems() a cada render sem custo.

import {
  MONTHS_SHORT,
  WEEKDAYS_LONG,
  addDays,
  addMonths,
  formatDate,
  formatWeekRange,
  isValidDateStr,
  monthMatrix,
  parseDate,
  startOfWeek,
  weekDays,
  weekdayIndex,
} from '../../../core/dates.js';
import { uuid } from '../../../core/ids.js';
import { priorityRank } from '../../../domain/priorities.js';
import { defaultFilters } from '../../../domain/filters.js';
import { applyViewFilters, normalizeFilters } from '../../shared/filterbar.js';

/** Modos da tela, na ordem do seletor. */
export const MODES = Object.freeze(['month', 'week', 'day']);

/** Rótulos dos modos. */
export const MODE_LABELS = Object.freeze({ month: 'Mês', week: 'Semana', day: 'Dia' });

/** Atrasadas mostradas antes do "Mostrar todas" (listas longas pesam e escondem o resto da tela). */
export const OVERDUE_LIMIT = 20;

/** Campos da barra de filtros (versão reduzida). */
export const FILTER_FIELDS = Object.freeze(['q', 'project', 'status', 'priority', 'show']);

const EMPTY = Object.freeze([]);

/**
 * Identificador desta sessão da página. O dia focado só vale dentro da mesma sessão: ao abrir o app de novo,
 * o calendário volta para hoje (como a Minha Semana); modo, opções e filtros continuam guardados.
 */
export const DATE_SESSION = uuid();

/** Patch de ctx.state com o carimbo da sessão sempre que ele muda o dia focado. */
export function withDateSession(patch) {
  return patch && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, 'date') ? { ...patch, dateSession: DATE_SESSION } : patch;
}

/**
 * Estado da tela com valores padrão e tipos garantidos.
 * @param {object} state ctx.state (pode estar vazio, ser de outra versão ou ter lixo)
 * @param {string} today 'YYYY-MM-DD'
 * @returns {{ mode: 'month'|'week'|'day', date: string, showDemands: boolean, showTasks: boolean,
 *             showStarts: boolean, overdueCollapsed: boolean, overdueAll: boolean, filters: object }}
 *          date: o dia guardado só se foi escolhido nesta sessão (ver DATE_SESSION); senão hoje
 */
export function normalizeState(state, today) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    mode: MODES.includes(s.mode) ? s.mode : 'month',
    date: isValidDateStr(s.date) && s.dateSession === DATE_SESSION ? s.date : today,
    showDemands: s.showDemands !== false,
    showTasks: s.showTasks !== false,
    showStarts: s.showStarts === true,
    overdueCollapsed: s.overdueCollapsed === true,
    overdueAll: s.overdueAll === true,
    filters: normalizeFilters(s.filters),
  };
}

/**
 * Dias que o modo mostra para a data focada.
 * @param {'month'|'week'|'day'} mode
 * @param {string} date
 * @returns {{ from: string, to: string, days: string[], weeks?: string[][] }}
 */
export function viewRange(mode, date) {
  if (mode === 'month') {
    const d = parseDate(date);
    const weeks = monthMatrix(d.getFullYear(), d.getMonth());
    return { from: weeks[0][0], to: weeks[weeks.length - 1][6], days: weeks.flat(), weeks };
  }
  if (mode === 'week') {
    const from = startOfWeek(date);
    return { from, to: addDays(from, 6), days: weekDays(from) };
  }
  return { from: date, to: date, days: [date] };
}

/**
 * Data focada depois de "anterior" (-1) / "próximo" (+1).
 * @param {'month'|'week'|'day'} mode
 * @param {string} date
 * @param {number} dir
 * @returns {string}
 */
export function shiftDate(mode, date, dir) {
  if (mode === 'month') return addMonths(date, dir);
  if (mode === 'week') return addDays(date, 7 * dir);
  return addDays(date, dir);
}

/** Nome longo do dia: 'sábado, 21 de novembro de 2026'. */
export function longDay(date) {
  const i = weekdayIndex(date);
  return i === null ? '' : `${WEEKDAYS_LONG[i]}, ${formatDate(date, 'long')}`;
}

/** Dia + mês curto: '21 nov'. */
export function shortDay(date) {
  const d = parseDate(date);
  return d ? `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}` : '';
}

/**
 * Título do período: 'novembro de 2026' · '16–22 nov 2026' · 'sábado, 21 de novembro de 2026'.
 * @param {'month'|'week'|'day'} mode
 * @param {string} date
 * @returns {string}
 */
export function periodTitle(mode, date) {
  if (mode === 'month') return formatDate(date, 'month');
  if (mode === 'week') return formatWeekRange(startOfWeek(date));
  return longDay(date);
}

// ---------------------------------------------------------------------------
// Itens por dia
// ---------------------------------------------------------------------------

/**
 * Item do calendário: uma demanda/tarefa num dia, pelo prazo ('due') ou pelo início planejado ('start').
 * @typedef {{ key: string, type: 'task'|'demand', id: string, entity: object, kind: 'due'|'start', date: string,
 *             open: boolean, overdue: boolean, rank: number, name: string }} CalItem
 */

function makeItem(app, type, entity, kind, today) {
  const date = kind === 'due' ? entity.due_date : entity.planned_start;
  const open = app.sel.isOpen(entity);
  return Object.freeze({
    key: `${type}:${entity.id}:${kind}`,
    type,
    id: entity.id,
    entity,
    kind,
    date,
    open,
    overdue: kind === 'due' && open && date < today,
    rank: priorityRank(entity.priority),
    name: typeof entity.name === 'string' ? entity.name.trim().toLocaleLowerCase('pt-BR') : '',
  });
}

/** Ordem dentro de um dia: prazos antes de inícios, demandas antes de tarefas, abertas antes, prioridade, nome. */
export function compareItems(a, b) {
  return (
    (a.kind === b.kind ? 0 : a.kind === 'due' ? -1 : 1) ||
    (a.type === b.type ? 0 : a.type === 'demand' ? -1 : 1) ||
    (a.open === b.open ? 0 : a.open ? -1 : 1) ||
    a.rank - b.rank ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Atrasadas: prazo mais antigo primeiro, depois a ordem do dia. */
function compareOverdue(a, b) {
  return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || compareItems(a, b);
}

function push(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

let cache = { app: null, key: null, value: null };

/**
 * Itens do calendário agrupados por dia, já filtrados (filtros da tela, escopo global de projeto e as chaves
 * Demandas / Tarefas / Inícios planejados).
 *
 * @param {object} app
 * @param {ReturnType<typeof normalizeState>} st
 * @returns {{ byDay: ReadonlyMap<string, CalItem[]>, overdue: CalItem[], dates: string[],
 *             allDue: ReadonlyMap<string, number>, dueCount: ReadonlyMap<string, number>,
 *             estimateByDay: ReadonlyMap<string, number> }}
 *   byDay: prazos (e inícios, se ligados) de cada dia, na ordem de compareItems;
 *   overdue: abertas com prazo vencido (filtradas); dates: dias com algum item (ordenados);
 *   allDue: prazos por dia SEM os filtros da tela (para distinguir "nada" de "nada corresponde aos filtros");
 *   dueCount: prazos por dia COM os filtros;
 *   estimateByDay: soma das estimativas (minutos) das tarefas que vencem em cada dia.
 */
export function collectItems(app, st) {
  const today = app.clock.today();
  const scope = app.ui && app.ui.scope && app.ui.scope.projectId ? app.ui.scope.projectId : '';
  const key = [app.store.version(), today, scope, st.showDemands ? 1 : 0, st.showTasks ? 1 : 0, st.showStarts ? 1 : 0, JSON.stringify(st.filters)].join('|');
  if (cache.app === app && cache.key === key) return cache.value;

  const includeArchived = st.filters.showArchived === true;
  const sources = [];
  if (st.showDemands) sources.push(['demand', app.sel.demands({ includeArchived })]);
  if (st.showTasks) sources.push(['task', app.sel.tasks({ includeArchived })]);

  const byDay = new Map();
  const estimateByDay = new Map();
  const overdue = [];
  const allDue = new Map();
  const dueCount = new Map();
  const base = defaultFilters();
  for (const [type, list] of sources) {
    // Sem os filtros da tela (só escopo e o padrão "sem canceladas/arquivadas"): existe algo com prazo?
    for (const entity of applyViewFilters(app, list, base, type)) {
      if (isValidDateStr(entity.due_date)) allDue.set(entity.due_date, (allDue.get(entity.due_date) || 0) + 1);
    }
    for (const entity of applyViewFilters(app, list, st.filters, type)) {
      if (isValidDateStr(entity.due_date)) {
        const item = makeItem(app, type, entity, 'due', today);
        push(byDay, item.date, item);
        dueCount.set(item.date, (dueCount.get(item.date) || 0) + 1);
        if (item.overdue) overdue.push(item);
        if (type === 'task' && Number(entity.estimate_minutes) > 0) {
          estimateByDay.set(item.date, (estimateByDay.get(item.date) || 0) + Number(entity.estimate_minutes));
        }
      }
      if (st.showStarts && isValidDateStr(entity.planned_start)) {
        const item = makeItem(app, type, entity, 'start', today);
        push(byDay, item.date, item);
      }
    }
  }
  for (const list of byDay.values()) {
    list.sort(compareItems);
    Object.freeze(list);
  }
  overdue.sort(compareOverdue);
  const value = Object.freeze({
    byDay,
    overdue: Object.freeze(overdue),
    dates: Object.freeze([...byDay.keys()].sort()),
    allDue,
    dueCount,
    estimateByDay,
  });
  cache = { app, key, value };
  return value;
}

/** Itens de um dia (lista congelada; vazia quando não há). */
export function itemsOn(data, date) {
  return data.byDay.get(date) || EMPTY;
}

/** Soma dos valores de um mapa dia → número entre `from` e `to` (inclusive). */
export function sumIn(map, from, to) {
  let n = 0;
  for (const [date, count] of map) if (date >= from && date <= to) n += count;
  return n;
}

/**
 * Dia mais próximo com itens fora do período: o primeiro depois de `to`, senão o último antes de `from`.
 * @returns {string|null}
 */
export function nearestDateOutside(dates, from, to) {
  for (const d of dates) if (d > to) return d;
  for (let i = dates.length - 1; i >= 0; i--) if (dates[i] < from) return dates[i];
  return null;
}
