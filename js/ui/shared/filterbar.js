// Barra de filtros e ordenação compartilhada pelas telas de lista (Demandas, Kanban, Calendário,
// Hierarquia, Backlog…). A REGRA de filtro/ordenação mora em js/domain/filters.js; aqui ficam só a
// interface (busca, seletores, chips, folha do celular) e a ponte com o app (contexto dos seletores).
//
//   const filters = normalizeFilters(ctx.state.filters);
//   const sort = normalizeSort(ctx.state.sort);              // ou DEFAULT_SORT
//   const all = app.sel.tasks({ includeArchived: true });    // arquivadas só aparecem com "Exibir → Arquivadas"
//   const shown = sortViewItems(app, applyViewFilters(app, all, filters, 'task'), sort, 'task');
//
//   filterBar(app, {
//     filters, onchange: (next) => ctx.setState({ filters: next }),
//     sort, onsort: (next) => ctx.setState({ sort: next }),
//     count: { shown: shown.length, total: totalVisivel },
//   });
//
// A barra é uma FUNÇÃO PURA DE RENDERIZAÇÃO: chame a cada render e deixe o morph (core/dom.js) aplicar a
// diferença — a busca mantém foco e cursor enquanto a tela é refeita. Ela nunca grava nada no banco: só
// devolve os novos filtros/ordenação pelos callbacks (o estado é da tela).
//
// Largura: abaixo de 768 px (do espaço ocupado pela barra — consulta de contêiner) ou com `compact: true`,
// ela se recolhe na busca + botão "Filtros (n)", que abre os mesmos controles numa folha.

import { cx, h } from '../../core/dom.js';
import { formatNumber } from '../../core/format.js';
import { isValidDateStr } from '../../core/dates.js';
import {
  DEADLINE_FILTER_KEYS,
  DEFAULT_SORT as DOMAIN_DEFAULT_SORT,
  SORT_KEYS,
  SORT_OPTIONS,
  applyFilters,
  defaultFilters,
  normalizeFilters as normalizeDomainFilters,
  normalizeSort,
  sortItems,
} from '../../domain/filters.js';
import { PRIORITIES, priorityById } from '../../domain/priorities.js';
import { statusById } from '../../domain/statuses.js';
import { searchInput, switchInput } from '../kit/controls.js';
import { countBadge, priorityBadge, statusBadge } from '../kit/display.js';
import { icon as makeIcon } from '../kit/icons.js';
import { openMenu, openModal } from '../kit/overlays.js';
import { pickFromList } from '../kit/pickers.js';

export { normalizeSort };

// ---------------------------------------------------------------------------
// Constantes públicas
// ---------------------------------------------------------------------------

/** Controles que a barra sabe desenhar, na ordem em que aparecem. */
export const FILTER_FIELDS = Object.freeze(['q', 'project', 'status', 'priority', 'deadline', 'tags', 'owner', 'show']);

/** Rótulo (pt-BR) de cada chave de ordenação. */
export const SORT_LABELS = Object.freeze(Object.fromEntries(SORT_OPTIONS.map((option) => [option.key, option.label])));

/** Ordenação padrão das listas: ordem manual, crescente. */
export const DEFAULT_SORT = DOMAIN_DEFAULT_SORT;

/**
 * Opções do filtro de prazo, na ordem do menu. As faixas são EXCLUSIVAS e valem só para itens abertos
 * (mesmas definições de domain/deadlines.js): 'next3' = de amanhã até 3 dias; 'next7' = de 4 a 7 dias.
 */
export const DEADLINE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'overdue', label: 'Atrasadas', description: 'Prazo já passou' }),
  Object.freeze({ id: 'today', label: 'Vencem hoje', description: 'Prazo é hoje' }),
  Object.freeze({ id: 'next3', label: 'Próximos 3 dias', description: 'De amanhã até daqui a 3 dias' }),
  Object.freeze({ id: 'next7', label: 'De 4 a 7 dias', description: 'Vencem entre o 4º e o 7º dia' }),
  Object.freeze({ id: 'no_due', label: 'Sem prazo', description: 'Itens abertos sem prazo definido' }),
]);

/** Rótulos das extensões aceitas pelo domínio (estado salvo por outra tela). */
const EXTRA_DEADLINE_LABELS = Object.freeze({ due_soon: 'Próximas do vencimento', on_time: 'No prazo' });

/** Espera da busca enquanto o usuário digita (ms). */
const SEARCH_DEBOUNCE_MS = 150;
/** Tamanho máximo do texto de busca guardado no estado. */
const MAX_QUERY_LENGTH = 500;

const NOUNS = Object.freeze({
  task: Object.freeze({ singular: 'tarefa', plural: 'tarefas', search: 'Buscar tarefas…' }),
  demand: Object.freeze({ singular: 'demanda', plural: 'demandas', search: 'Buscar demandas…' }),
});

const FIELD_LABELS = Object.freeze({
  project: 'Projeto',
  status: 'Status',
  priority: 'Prioridade',
  deadline: 'Prazo',
  tags: 'Etiquetas',
  owner: 'Responsável',
  show: 'Exibir',
});

const FIELD_ICONS = Object.freeze({
  project: 'folder',
  status: 'circle-half',
  priority: 'signal-3',
  deadline: 'calendar',
  tags: 'tag',
  owner: 'user',
  show: 'eye',
});

const SHOW_TOGGLES = Object.freeze([
  Object.freeze({ key: 'showDone', label: 'Concluídas', description: 'Itens com status de conclusão' }),
  Object.freeze({ key: 'showCancelled', label: 'Canceladas', description: 'Itens cancelados' }),
  Object.freeze({ key: 'showArchived', label: 'Arquivadas', description: 'Itens arquivados (próprios ou herdados)' }),
]);

const NO_PROJECT_LABEL = 'Sem projeto';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object';
const hasId = (id) => id !== null && id !== undefined && id !== '';
const kindOf = (type) => (type === 'demand' ? 'demand' : 'task');

/** Aceita array, Set ou qualquer iterável; o resto vira lista vazia. */
function toList(value) {
  if (Array.isArray(value)) return value;
  if (value instanceof Set) return [...value];
  if (isObject(value) && typeof value[Symbol.iterator] === 'function' && typeof value !== 'string') {
    try {
      return [...value];
    } catch {
      return [];
    }
  }
  return [];
}

/** Lista de ids (texto) sem repetição; valores que não são texto/número são descartados. */
function cleanIds(value, { allowEmpty = false } = {}) {
  const raw = typeof value === 'string' || typeof value === 'number' ? [value] : toList(value);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let id;
    if (typeof item === 'string') id = item.trim();
    else if (typeof item === 'number' && Number.isFinite(item)) id = String(item);
    else if (item === null && allowEmpty) id = '';
    else continue;
    if (id === '' && !allowEmpty) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Etiquetas sem repetição (sem diferenciar maiúsculas), aparadas e não vazias. */
function cleanTags(value) {
  const out = [];
  const seen = new Set();
  for (const item of typeof value === 'string' ? [value] : toList(value)) {
    if (typeof item !== 'string') continue;
    const text = item.trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function safeCall(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** Projeto do escopo global (app.ui.scope.projectId) ou null. Tolera app/ui/scope ausentes. */
function scopeProjectId(app) {
  const id = safeCall(() => app.ui.scope.projectId, null);
  return typeof id === 'string' && id !== '' ? id : null;
}

/** Filtros que realmente valem: sob escopo de projeto, o filtro de projeto salvo é ignorado. */
function effectiveFilters(app, filters) {
  const f = normalizeFilters(filters);
  return scopeProjectId(app) ? { ...f, projectIds: [] } : f;
}

function todayOf(app) {
  const day = safeCall(() => app.clock.today(), null);
  return isValidDateStr(day) ? day : null;
}

function soonDaysOf(app) {
  const n = Number(safeCall(() => app.settings.get('deadline.soonDays'), 3));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3;
}

function statusesOf(app) {
  const list = safeCall(() => app.sel.statuses(), []);
  return Array.isArray(list) ? list : [];
}

/** Ids das tarefas visíveis (arquivadas inclusive), memorizados pela identidade da lista do seletor. */
const liveTaskIds = new WeakMap();
function isLiveTask(app, task) {
  const list = safeCall(() => app.sel.tasks({ includeArchived: true }), null);
  if (!Array.isArray(list)) return !task.deleted_at;
  let ids = liveTaskIds.get(list);
  if (!ids) {
    ids = new Set(list.map((row) => row.id));
    liveTaskIds.set(list, ids);
  }
  return ids.has(task.id);
}

function isLiveDemand(app, demand) {
  const row = safeCall(() => app.sel.demand(demand.id), undefined);
  return row === undefined ? !demand.deleted_at : row !== null;
}

// ---------------------------------------------------------------------------
// API de dados
// ---------------------------------------------------------------------------

/**
 * Filtros completos a partir do que estava salvo no estado da tela (ou de qualquer coisa): começa de
 * defaultFilters(), aproveita só as chaves conhecidas com tipo válido e descarta o resto.
 *   • listas aceitam array/Set/valor solto; itens que não são texto somem; sem repetição;
 *   • `projectIds` aceita '' (ou null) = "Sem projeto"; `priorities` só P1–P4; `tags` sem repetição
 *     (sem diferenciar maiúsculas);
 *   • `q`/`owner` só texto; `deadline` só as chaves do domínio; texto JSON também é aceito.
 *
 * @param {*} saved filtros salvos (podem ser parciais, de outra versão do app, ou lixo)
 * @returns {{ q: string, projectIds: string[], statusIds: string[], priorities: string[], tags: string[],
 *             owner: string, deadline: null|string, showDone: boolean, showCancelled: boolean, showArchived: boolean }}
 *          objeto NOVO (pode ser alterado por quem chamou)
 */
export function normalizeFilters(saved) {
  let raw = saved;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (!isObject(raw) || Array.isArray(raw)) return defaultFilters();
  try {
    const base = normalizeDomainFilters(raw);
    const q = typeof raw.q === 'string' ? raw.q : typeof raw.q === 'number' && Number.isFinite(raw.q) ? String(raw.q) : '';
    return {
      q: q.length > MAX_QUERY_LENGTH ? q.slice(0, MAX_QUERY_LENGTH) : q,
      projectIds: cleanIds(raw.projectIds, { allowEmpty: true }),
      statusIds: cleanIds(raw.statusIds),
      priorities: cleanIds(raw.priorities).filter((id) => PRIORITIES.some((p) => p.id === id)),
      tags: cleanTags(raw.tags),
      owner: typeof raw.owner === 'string' ? raw.owner.trim() : '',
      deadline: DEADLINE_FILTER_KEYS.includes(base.deadline) ? base.deadline : null,
      showDone: base.showDone,
      showCancelled: base.showCancelled,
      showArchived: base.showArchived,
    };
  } catch {
    return defaultFilters(); // getters que lançam, proxies estranhos…
  }
}

/**
 * Texto do contador: '12 de 40 tarefas' (filtrado) ou '40 tarefas' (tudo à mostra).
 *
 * @param {number|null} shown quantos aparecem (null/igual ao total = sem filtro)
 * @param {number} total quantos existem
 * @param {string} [singular='item']
 * @param {string} [pluralForm] padrão: singular + 's' ('item' → 'itens')
 * @returns {string} '' quando `total` não é um número válido
 */
export function countLabel(shown, total, singular = 'item', pluralForm) {
  const all = Number(total);
  if (total === null || total === undefined || total === '' || !Number.isFinite(all) || all < 0) return '';
  const one = typeof singular === 'string' && singular ? singular : 'item';
  const many = typeof pluralForm === 'string' && pluralForm ? pluralForm : one === 'item' ? 'itens' : `${one}s`;
  const word = Math.round(all) === 1 ? one : many;
  const visible = Number(shown);
  if (shown === null || shown === undefined || shown === '' || !Number.isFinite(visible) || visible === all) {
    return `${formatNumber(all)} ${word}`;
  }
  return `${formatNumber(Math.max(0, visible))} de ${formatNumber(all)} ${word}`;
}

/**
 * Filtra demandas/tarefas como as telas de lista mostram:
 *   • descarta nulos, excluídos (`deleted_at`) e excluídos por herança (pai/demanda excluídos);
 *   • aplica `applyFilters` do domínio com o contexto do app: status efetivos, hoje (app.clock),
 *     configuração 'deadline.soonDays', projeto efetivo (o da demanda, para tarefas), código legível
 *     ('T-12') na busca e arquivamento efetivo (próprio, do pai, da demanda ou do projeto);
 *   • com o escopo global de projeto (app.ui.scope.projectId), mantém só os itens daquele projeto e
 *     ignora o filtro de projeto salvo.
 * Para "Exibir → Arquivadas" funcionar, passe a lista com as arquivadas (sel.tasks({ includeArchived: true })).
 *
 * @param {object} app objeto do app (usa sel, clock, settings e, se existir, ui.scope)
 * @param {Iterable<object>} items demandas ou tarefas (não é alterado)
 * @param {object|null} filters filtros (qualquer formato; passam por normalizeFilters)
 * @param {'task'|'demand'} [type='task']
 * @returns {object[]} array NOVO, na ordem recebida
 */
export function applyViewFilters(app, items, filters, type = 'task') {
  if (!app || !app.sel) throw new TypeError('applyViewFilters: informe o app.');
  const kind = kindOf(type);
  const { sel } = app;
  const f = effectiveFilters(app, filters);
  const today = todayOf(app);
  if (!today) f.deadline = null; // sem relógio válido não há como avaliar prazo
  const scope = scopeProjectId(app);
  const projectIdOf = (item) => safeCall(() => sel.projectIdOf(kind, item), null);
  const ctx = {
    statuses: statusesOf(app),
    today,
    soonDays: soonDaysOf(app),
    projectIdOf,
    codeOf: (item) => safeCall(() => sel.code(kind, item), ''),
    isArchived: (item) => (item.archived_at ? true : safeCall(() => sel.isHidden(kind, item), false)),
  };
  const isLive = kind === 'task' ? (item) => isLiveTask(app, item) : (item) => isLiveDemand(app, item);
  const candidates = toList(items).filter((item) => isObject(item) && !item.deleted_at && isLive(item) && (!scope || projectIdOf(item) === scope));
  return applyFilters(candidates, f, ctx);
}

/**
 * Ordena demandas/tarefas com `sortItems` do domínio e o contexto do app: progresso (demandProgress para
 * demandas, fração pelas subtarefas para tarefas) e nome do projeto efetivo. Vazios sempre por último.
 *
 * @param {object} app
 * @param {Iterable<object>} items (não é alterado)
 * @param {{ key?: string, dir?: 'asc'|'desc' }|string|null} sort inválida = DEFAULT_SORT
 * @param {'task'|'demand'} [type='task']
 * @returns {object[]} array NOVO ordenado
 */
export function sortViewItems(app, items, sort, type = 'task') {
  if (!app || !app.sel) throw new TypeError('sortViewItems: informe o app.');
  const kind = kindOf(type);
  const { sel } = app;
  const ctx = {
    statuses: statusesOf(app),
    progressOf: kind === 'demand' ? (item) => safeCall(() => sel.demandProgress(item.id), null) : (item) => safeCall(() => sel.taskFraction(item.id), null),
    projectNameOf: (item) => safeCall(() => {
      const project = sel.projectOf(kind, item);
      return project ? project.name : null;
    }, null),
  };
  return sortItems(toList(items).filter(isObject), sort, ctx);
}

// ---------------------------------------------------------------------------
// Rótulos e opções vindos do app
// ---------------------------------------------------------------------------

function projectLabel(app, id) {
  if (!hasId(id)) return NO_PROJECT_LABEL;
  const project = safeCall(() => app.sel.project(id), null) || safeCall(() => app.store.get('projects', id), null);
  return project && project.name ? String(project.name) : 'Projeto removido';
}

function statusLabel(app, id) {
  const def = statusById(statusesOf(app), id);
  return def && def.label ? String(def.label) : String(id);
}

function deadlineLabel(key) {
  const option = DEADLINE_OPTIONS.find((o) => o.id === key);
  return option ? option.label : EXTRA_DEADLINE_LABELS[key] || String(key);
}

function priorityLabel(id) {
  const def = priorityById(id);
  return `${def.id} · ${def.label}`;
}

function projectItems(app, filters) {
  const projects = safeCall(() => app.sel.projects({ includeArchived: filters.showArchived }), []);
  return [
    { id: '', label: NO_PROJECT_LABEL, icon: 'circle-dashed' },
    ...toList(projects)
      .filter((p) => isObject(p) && hasId(p.id))
      .map((p) => ({ id: p.id, label: p.name ? String(p.name) : 'Sem nome', hint: p.code || (p.archived_at ? 'arquivado' : undefined), icon: 'folder' })),
  ];
}

function statusItems(app) {
  return statusesOf(app)
    .filter((s) => isObject(s) && s.id)
    .map((s) => ({ id: s.id, label: s.label || s.id, icon: statusBadge(s, { compact: true }) }));
}

function priorityItems() {
  return PRIORITIES.map((p) => ({ id: p.id, label: priorityLabel(p.id), icon: priorityBadge(p.id, { compact: true }) }));
}

function tagItems(app) {
  return toList(safeCall(() => app.sel.tags(), []))
    .filter((t) => typeof t === 'string' && t.trim() !== '')
    .map((t) => ({ id: t, label: t, icon: 'tag' }));
}

function ownerItems(app) {
  return toList(safeCall(() => app.sel.owners(), []))
    .filter((o) => typeof o === 'string' && o.trim() !== '')
    .map((o) => ({ id: o, label: o, icon: 'user' }));
}

/** Chips dos filtros ativos: { key, label, patch(filters) → filtros sem aquele valor }. */
function activeChips(app, f) {
  const chips = [];
  const without = (list, value) => list.filter((item) => item !== value);
  if (f.q.trim() !== '') chips.push({ key: 'q', field: 'q', label: `Busca: “${f.q.trim()}”`, patch: () => ({ q: '' }) });
  for (const id of f.projectIds) chips.push({ key: `project:${id}`, field: 'project', label: `Projeto: ${projectLabel(app, id)}`, patch: (cur) => ({ projectIds: without(cur.projectIds, id) }) });
  for (const id of f.statusIds) chips.push({ key: `status:${id}`, field: 'status', label: `Status: ${statusLabel(app, id)}`, patch: (cur) => ({ statusIds: without(cur.statusIds, id) }) });
  for (const id of f.priorities) chips.push({ key: `priority:${id}`, field: 'priority', label: `Prioridade: ${priorityLabel(id)}`, patch: (cur) => ({ priorities: without(cur.priorities, id) }) });
  if (f.deadline !== null) chips.push({ key: 'deadline', field: 'deadline', label: `Prazo: ${deadlineLabel(f.deadline)}`, patch: () => ({ deadline: null }) });
  for (const tag of f.tags) chips.push({ key: `tag:${tag.toLowerCase()}`, field: 'tags', label: `Etiqueta: ${tag}`, patch: (cur) => ({ tags: without(cur.tags, tag) }) });
  if (f.owner.trim() !== '') chips.push({ key: 'owner', field: 'owner', label: `Responsável: ${f.owner.trim()}`, patch: () => ({ owner: '' }) });
  if (!f.showDone) chips.push({ key: 'showDone', field: 'show', label: 'Sem concluídas', patch: () => ({ showDone: true }) });
  if (f.showCancelled) chips.push({ key: 'showCancelled', field: 'show', label: 'Com canceladas', patch: () => ({ showCancelled: false }) });
  if (f.showArchived) chips.push({ key: 'showArchived', field: 'show', label: 'Com arquivadas', patch: () => ({ showArchived: false }) });
  return chips;
}

// ---------------------------------------------------------------------------
// Controlador: o estado vivo da barra entre renderizações
// ---------------------------------------------------------------------------
//
// A barra é refeita a cada render, mas pickers/menus/folha abertos e a busca com espera precisam enxergar
// a configuração MAIS RECENTE (outro filtro pode ter mudado no meio-tempo, ou a sincronização refez a tela).
// O controlador fica pendurado no elemento raiz vivo (`.fb`) e é atualizado pelo `ref` a cada morph.

function createController(cfg) {
  const ctl = {
    cfg,
    sheet: null,
    searchTimer: 0,
    pendingQuery: null,
    /** Aplica uma mudança parcial nos filtros e avisa a tela. */
    commit(patch) {
      const next = normalizeFilters({ ...ctl.cfg.filters, ...patch });
      ctl.cfg = { ...ctl.cfg, filters: next };
      if (typeof ctl.cfg.onchange === 'function') ctl.cfg.onchange(next);
      ctl.refreshSheet();
      return next;
    },
    /** Troca os filtros inteiros (Limpar filtros). */
    replace(next) {
      ctl.cancelSearch();
      const clean = normalizeFilters(next);
      ctl.cfg = { ...ctl.cfg, filters: clean };
      if (typeof ctl.cfg.onchange === 'function') ctl.cfg.onchange(clean);
      ctl.refreshSheet();
    },
    commitSort(patch) {
      const next = normalizeSort({ ...normalizeSort(ctl.cfg.sort), ...patch });
      ctl.cfg = { ...ctl.cfg, sort: next };
      if (typeof ctl.cfg.onsort === 'function') ctl.cfg.onsort(next);
      ctl.refreshSheet();
    },
    /** Busca com espera: só avisa a tela depois de SEARCH_DEBOUNCE_MS sem digitar. */
    queueSearch(text) {
      clearTimeout(ctl.searchTimer);
      ctl.pendingQuery = text;
      if (text === '') {
        ctl.flushSearch(); // limpar é imediato
        return;
      }
      ctl.searchTimer = setTimeout(() => ctl.flushSearch(), SEARCH_DEBOUNCE_MS);
    },
    flushSearch() {
      clearTimeout(ctl.searchTimer);
      ctl.searchTimer = 0;
      const text = ctl.pendingQuery;
      ctl.pendingQuery = null;
      if (text === null || text === ctl.cfg.filters.q) return;
      ctl.commit({ q: text });
    },
    cancelSearch() {
      clearTimeout(ctl.searchTimer);
      ctl.searchTimer = 0;
      ctl.pendingQuery = null;
    },
    refreshSheet() {
      if (ctl.sheet) queueMicrotask(() => ctl.sheet && ctl.sheet.update());
    },
  };
  return ctl;
}

/** Controlador da barra a que `node` pertence (ou um avulso com `cfg`, se a barra não está no documento). */
function controllerOf(node, cfg) {
  const root = node && typeof node.closest === 'function' ? node.closest('.fb') : null;
  if (root) {
    if (!root.__fbCtl) root.__fbCtl = createController(cfg);
    return root.__fbCtl;
  }
  return createController(cfg);
}

// ---------------------------------------------------------------------------
// Abertura dos seletores (compartilhada pela barra e pela folha do celular)
// ---------------------------------------------------------------------------

/** Marca o botão que abriu a camada (aria-expanded) e devolve a função que desmarca. */
function markExpanded(anchor) {
  if (!(anchor instanceof Element)) return () => {};
  anchor.setAttribute('aria-expanded', 'true');
  return () => anchor.removeAttribute('aria-expanded');
}

async function openListPicker(ctl, anchor, field) {
  const unmark = markExpanded(anchor);
  try {
    await pickListValue(ctl, anchor, field);
  } finally {
    unmark();
  }
}

async function pickListValue(ctl, anchor, field) {
  const { app } = ctl.cfg;
  const f = ctl.cfg.filters;
  let result;
  if (field === 'project') {
    result = await pickFromList(anchor, { items: projectItems(app, f), current: f.projectIds, multiple: true, title: 'Projeto', placeholder: 'Buscar projeto…' });
    if (result !== null) ctl.commit({ projectIds: result });
  } else if (field === 'status') {
    result = await pickFromList(anchor, { items: statusItems(app), current: f.statusIds, multiple: true, title: 'Status', placeholder: 'Buscar status…' });
    if (result !== null) ctl.commit({ statusIds: result });
  } else if (field === 'priority') {
    result = await pickFromList(anchor, { items: priorityItems(), current: f.priorities, multiple: true, title: 'Prioridade', placeholder: 'Buscar prioridade…', width: 240 });
    if (result !== null) ctl.commit({ priorities: result });
  } else if (field === 'tags') {
    result = await pickFromList(anchor, { items: tagItems(app), current: f.tags, multiple: true, title: 'Etiquetas', placeholder: 'Buscar etiqueta…' });
    if (result !== null) ctl.commit({ tags: result });
  } else if (field === 'owner') {
    result = await pickFromList(anchor, {
      items: ownerItems(app),
      current: f.owner || null,
      allowEmpty: true,
      emptyLabel: 'Qualquer responsável',
      title: 'Responsável',
      placeholder: 'Buscar responsável…',
    });
    if (result !== null) ctl.commit({ owner: result });
  }
}

function openDeadlineMenu(ctl, anchor) {
  const f = ctl.cfg.filters;
  openMenu(
    anchor,
    [
      { label: 'Qualquer prazo', checked: f.deadline === null, onclick: () => ctl.commit({ deadline: null }) },
      { separator: true },
      ...DEADLINE_OPTIONS.map((option) => ({
        label: option.label,
        description: option.description,
        checked: f.deadline === option.id,
        onclick: () => ctl.commit({ deadline: option.id }),
      })),
    ],
    { title: 'Prazo', minWidth: 220, class: 'fb-menu', onclose: markExpanded(anchor) },
  );
}

function openShowMenu(ctl, anchor) {
  const f = ctl.cfg.filters;
  openMenu(
    anchor,
    [
      ...SHOW_TOGGLES.map((toggle) => ({
        label: toggle.label,
        description: toggle.description,
        checked: f[toggle.key] === true,
        onclick: () => ctl.commit({ [toggle.key]: !ctl.cfg.filters[toggle.key] }),
      })),
    ],
    { title: 'Exibir', minWidth: 220, class: 'fb-menu', onclose: markExpanded(anchor) },
  );
}

function openSortMenu(ctl, anchor) {
  const sort = normalizeSort(ctl.cfg.sort);
  const keys = sortKeysOf(ctl.cfg.sortKeys);
  openMenu(
    anchor,
    [
      ...keys.map((key) => ({ label: SORT_LABELS[key], checked: sort.key === key, onclick: () => ctl.commitSort({ key }) })),
      { separator: true },
      { heading: 'Direção' },
      { label: 'Crescente', icon: 'arrow-up', checked: sort.dir === 'asc', onclick: () => ctl.commitSort({ dir: 'asc' }) },
      { label: 'Decrescente', icon: 'arrow-down', checked: sort.dir === 'desc', onclick: () => ctl.commitSort({ dir: 'desc' }) },
    ],
    { title: 'Ordenar por', minWidth: 220, align: 'end', class: 'fb-menu', onclose: markExpanded(anchor) },
  );
}

/** Abre o controle de um campo ancorado em `anchor`. */
function openField(ctl, anchor, field) {
  if (field === 'deadline') openDeadlineMenu(ctl, anchor);
  else if (field === 'show') openShowMenu(ctl, anchor);
  else if (field === 'sort') openSortMenu(ctl, anchor);
  else openListPicker(ctl, anchor, field).catch((err) => console.error('[filterbar] falha no seletor', err));
}

function sortKeysOf(sortKeys) {
  const list = cleanIds(sortKeys).filter((key) => SORT_KEYS.includes(key));
  return list.length ? list : [...SORT_KEYS];
}

// ---------------------------------------------------------------------------
// Resumo de cada campo (botão da barra e linha da folha)
// ---------------------------------------------------------------------------

/** { count, value } do campo: quantos selecionados (listas) e um texto curto do valor (seleção única). */
function fieldSummary(app, f, field) {
  switch (field) {
    case 'project':
      return { count: f.projectIds.length, value: f.projectIds.length === 1 ? projectLabel(app, f.projectIds[0]) : null };
    case 'status':
      return { count: f.statusIds.length, value: f.statusIds.length === 1 ? statusLabel(app, f.statusIds[0]) : null };
    case 'priority':
      return { count: f.priorities.length, value: f.priorities.length === 1 ? f.priorities[0] : null };
    case 'tags':
      return { count: f.tags.length, value: f.tags.length === 1 ? f.tags[0] : null };
    case 'owner':
      return { count: f.owner ? 1 : 0, value: f.owner || null };
    case 'deadline':
      return { count: f.deadline ? 1 : 0, value: f.deadline ? deadlineLabel(f.deadline) : null };
    case 'show': {
      const changed = (f.showDone ? 0 : 1) + (f.showCancelled ? 1 : 0) + (f.showArchived ? 1 : 0);
      return { count: changed, value: null };
    }
    default:
      return { count: 0, value: null };
  }
}

/** Texto do valor na folha do celular ("Todos", "2 selecionados", nome…). */
function sheetValueText(summary, field) {
  if (summary.count === 0) {
    if (field === 'deadline') return 'Qualquer prazo';
    if (field === 'owner') return 'Qualquer responsável';
    return 'Todos';
  }
  if (summary.value) return summary.value;
  return summary.count === 1 ? '1 selecionado' : `${summary.count} selecionados`;
}

// ---------------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------------

function filterButton(cfg, field) {
  const summary = fieldSummary(cfg.app, cfg.filters, field);
  const active = summary.count > 0;
  const single = field === 'owner' || field === 'deadline';
  const label = FIELD_LABELS[field];
  const title = active ? `${label}: ${sheetValueText(summary, field)}` : `Filtrar por ${label.toLowerCase()}`;
  return h(
    'button',
    {
      type: 'button',
      key: `btn-${field}`,
      class: cx('btn', 'btn-sm', 'fb-btn', active && 'is-active'),
      'data-fb': field,
      'aria-haspopup': field === 'deadline' || field === 'show' ? 'menu' : 'dialog',
      title,
      onclick: (ev) => openField(controllerOf(ev.currentTarget, cfg), ev.currentTarget, field),
    },
    makeIcon(FIELD_ICONS[field], { size: 14, class: 'fb-btn-icon' }),
    h('span', { class: 'btn-label' }, single && summary.value ? h('span', null, `${label}: `, h('strong', { class: 'fb-btn-value' }, summary.value)) : label),
    !single && active ? countBadge(summary.count, { tone: 'accent', class: 'fb-btn-count' }) : null,
    makeIcon('chevron-down', { size: 12, class: 'fb-btn-caret' }),
  );
}

function sortButton(cfg) {
  const sort = normalizeSort(cfg.sort);
  const keyLabel = SORT_LABELS[sort.key];
  const dirLabel = sort.dir === 'desc' ? 'decrescente' : 'crescente';
  return h(
    'button',
    {
      type: 'button',
      key: 'btn-sort',
      class: cx('btn', 'btn-sm', 'fb-btn', 'fb-sort', 'fb-desktop'),
      'data-fb': 'sort',
      'aria-haspopup': 'menu',
      title: `Ordenar por: ${keyLabel} (${dirLabel})`,
      'aria-label': `Ordenação: ${keyLabel}, ${dirLabel}`,
      onclick: (ev) => openSortMenu(controllerOf(ev.currentTarget, cfg), ev.currentTarget),
    },
    makeIcon('sort', { size: 14, class: 'fb-btn-icon' }),
    h('span', { class: 'btn-label' }, keyLabel),
    makeIcon(sort.dir === 'desc' ? 'arrow-down' : 'arrow-up', { size: 12, class: 'fb-sort-dir' }),
  );
}

function chipsRow(cfg, chips) {
  return h(
    'div',
    { key: 'chips', class: 'fb-chips', role: 'group', 'aria-label': 'Filtros ativos' },
    chips.map((chip) =>
      h(
        'span',
        { key: `chip-${chip.key}`, class: 'fb-chip', 'data-chip': chip.key },
        h('span', { class: 'fb-chip-text', title: chip.label }, chip.label),
        h(
          'button',
          {
            type: 'button',
            class: 'fb-chip-remove',
            title: 'Remover filtro',
            'aria-label': `Remover filtro ${chip.label}`,
            onclick: (ev) => {
              const ctl = controllerOf(ev.currentTarget, cfg);
              if (chip.key === 'q') ctl.cancelSearch();
              ctl.commit(chip.patch(ctl.cfg.filters));
            },
          },
          makeIcon('x', { size: 12 }),
        ),
      ),
    ),
    h(
      'button',
      {
        type: 'button',
        key: 'clear',
        class: 'btn btn-sm btn-ghost fb-clear',
        'data-fb': 'clear',
        onclick: (ev) => controllerOf(ev.currentTarget, cfg).replace(defaultFilters()),
      },
      'Limpar filtros',
    ),
  );
}

/** Corpo da folha "Filtros" do celular — lê sempre a configuração mais recente do controlador. */
function sheetBody(ctl) {
  const cfg = ctl.cfg;
  const f = cfg.filters;
  const rows = cfg.visibleFields.filter((field) => field !== 'q' && field !== 'show');
  const row = (field, valueText, active, onclick) =>
    h(
      'button',
      { type: 'button', key: `row-${field}`, class: cx('fb-sheet-row', active && 'is-active'), 'data-fb': field, onclick },
      makeIcon(field === 'sort' ? 'sort' : FIELD_ICONS[field], { size: 16, class: 'fb-sheet-icon' }),
      h('span', { class: 'fb-sheet-label' }, field === 'sort' ? 'Ordenar por' : FIELD_LABELS[field]),
      h('span', { class: 'fb-sheet-value' }, valueText),
      makeIcon('chevron-right', { size: 14, class: 'fb-sheet-caret' }),
    );
  const sort = normalizeSort(cfg.sort);
  return h(
    'div',
    { class: 'fb-sheet-body' },
    rows.length
      ? h(
          'div',
          { key: 'filters', class: 'fb-sheet-group' },
          rows.map((field) => {
            const summary = fieldSummary(cfg.app, f, field);
            return row(field, sheetValueText(summary, field), summary.count > 0, (ev) => openField(ctl, ev.currentTarget, field));
          }),
        )
      : null,
    cfg.visibleFields.includes('show')
      ? h(
          'div',
          { key: 'show', class: 'fb-sheet-group' },
          h('div', { class: 'fb-sheet-heading' }, 'Exibir'),
          SHOW_TOGGLES.map((toggle) =>
            h(
              'div',
              { key: `show-${toggle.key}`, class: 'fb-sheet-switch', 'data-fb': toggle.key },
              switchInput({ checked: f[toggle.key] === true, label: toggle.label, onchange: (checked) => ctl.commit({ [toggle.key]: !!checked }) }),
            ),
          ),
        )
      : null,
    cfg.sort !== undefined && cfg.sort !== null
      ? h(
          'div',
          { key: 'sort', class: 'fb-sheet-group' },
          row('sort', `${SORT_LABELS[sort.key]} · ${sort.dir === 'desc' ? 'decrescente' : 'crescente'}`, false, (ev) => openSortMenu(ctl, ev.currentTarget)),
        )
      : null,
  );
}

function openSheet(ctl) {
  if (ctl.sheet) return;
  ctl.flushSearch();
  const nouns = NOUNS[ctl.cfg.type];
  ctl.sheet = openModal({
    title: 'Filtros',
    size: 'md',
    class: 'fb-sheet',
    render: () => sheetBody(ctl),
    actions: () => {
      const count = ctl.cfg.count;
      const shown = count && Number.isFinite(Number(count.shown)) ? Number(count.shown) : null;
      const singular = (count && count.singular) || nouns.singular;
      const pluralForm = (count && count.plural) || nouns.plural;
      const active = activeChips(ctl.cfg.app, effectiveFilters(ctl.cfg.app, ctl.cfg.filters)).length > 0;
      return [
        active ? { label: 'Limpar filtros', variant: 'ghost', onclick: () => ctl.replace(defaultFilters()) } : null,
        { label: shown === null ? 'Concluir' : `Mostrar ${countLabel(shown, shown, singular, pluralForm)}`, variant: 'primary', autofocus: true, onclick: (close) => close('done') },
      ];
    },
    onclose: () => {
      ctl.sheet = null;
    },
  });
}

/**
 * Barra de filtros e ordenação das telas de lista.
 *
 * Linha 1: busca (espera de ~150 ms; foco e cursor preservados) · um botão por filtro (Projeto, Status,
 * Prioridade, Etiquetas e Responsável abrem listas pesquisáveis com contador de selecionados — Responsável
 * é escolha única, como no domínio; Prazo abre um menu de escolha única) · "Exibir" (Concluídas /
 * Canceladas / Arquivadas) · contador "12 de 40 tarefas" · ordenação (se `sort` foi informado) · `extra`.
 * Linha 2 (só com algum filtro ativo): um chip removível por valor filtrado + "Limpar filtros".
 * Sob escopo global de projeto (app.ui.scope.projectId) o filtro de projeto some (e é ignorado).
 * Estreita (< 768 px de espaço ou `compact`): busca + "Filtros (n)", que abre os controles numa folha.
 *
 * @param {object} app objeto do app (sel, settings, clock; `ui` é opcional)
 * @param {object} options
 * @param {object} options.filters filtros atuais (qualquer formato: passam por normalizeFilters)
 * @param {(next: object) => void} options.onchange recebe os filtros COMPLETOS novos (guarde no estado da tela)
 * @param {'task'|'demand'} [options.type='task'] muda textos (placeholder, contador)
 * @param {string[]} [options.fields=FILTER_FIELDS] controles a mostrar ('q','project','status','priority',
 *        'deadline','tags','owner','show')
 * @param {{ key: string, dir: 'asc'|'desc' }} [options.sort] ordenação atual; sem ela não há botão de ordenar
 * @param {(next: { key: string, dir: 'asc'|'desc' }) => void} [options.onsort]
 * @param {string[]} [options.sortKeys] chaves oferecidas no menu (padrão: todas de SORT_LABELS)
 * @param {{ shown: number, total: number, singular?: string, plural?: string }} [options.count]
 * @param {Node[]|Node} [options.extra] nós acrescentados no fim da linha 1 (ex.: botão "Nova tarefa")
 * @param {boolean} [options.compact=false] força o modo recolhido (colunas estreitas)
 * @returns {HTMLElement} `<div class="fb">`
 */
export function filterBar(app, { filters, onchange, type = 'task', fields = FILTER_FIELDS, sort, onsort, sortKeys, count, extra = [], compact = false } = {}) {
  const kind = kindOf(type);
  const nouns = NOUNS[kind];
  const scoped = scopeProjectId(app) !== null;
  const wanted = new Set(cleanIds(fields).filter((field) => FILTER_FIELDS.includes(field)));
  if (!Array.isArray(fields) && !(fields instanceof Set)) FILTER_FIELDS.forEach((field) => wanted.add(field));
  const visibleFields = FILTER_FIELDS.filter((field) => wanted.has(field) && !(field === 'project' && scoped));
  const f = normalizeFilters(filters);
  const shownFilters = scoped ? { ...f, projectIds: [] } : f;
  const cfg = { app, filters: f, onchange, type: kind, sort, onsort, sortKeys, count, visibleFields };

  const chips = activeChips(app, shownFilters);
  const sheetCount = chips.filter((chip) => chip.key !== 'q' || !visibleFields.includes('q')).length;

  let countText = '';
  if (isObject(count)) countText = countLabel(count.shown, count.total, count.singular || nouns.singular, count.plural || nouns.plural);

  const controls = visibleFields.filter((field) => field !== 'q');
  const hasSort = sort !== undefined && sort !== null;
  const extras = toList(Array.isArray(extra) ? extra : [extra]).filter((node) => node instanceof Node);

  const search = visibleFields.includes('q')
    ? h(
        'div',
        { key: 'search', class: 'fb-search' },
        searchInput({
          value: f.q,
          placeholder: nouns.search,
          size: 'sm',
          oninput: (text, ev) => controllerOf(ev && ev.currentTarget ? ev.currentTarget : null, cfg).queueSearch(text),
          onenter: (text, ev) => {
            const ctl = controllerOf(ev.currentTarget, cfg);
            ctl.pendingQuery = text;
            ctl.flushSearch();
          },
          attrs: {
            'data-fb': 'q',
            onblur: (ev) => controllerOf(ev.currentTarget, cfg).flushSearch(),
          },
        }),
      )
    : null;

  return h(
    'div',
    {
      class: cx('fb', compact && 'fb-compact', chips.length > 0 && 'has-chips'),
      'data-type': kind,
      ref: (el) => {
        if (!el.__fbCtl) el.__fbCtl = createController(cfg);
        else {
          el.__fbCtl.cfg = cfg;
          el.__fbCtl.refreshSheet();
        }
      },
    },
    h(
      'div',
      { key: 'main', class: 'fb-main', role: 'group', 'aria-label': 'Filtros e ordenação' },
      search,
      controls.length
        ? h(
            'div',
            { key: 'controls', class: 'fb-controls fb-desktop' },
            controls.map((field) => filterButton(cfg, field)),
          )
        : null,
      controls.length || hasSort
        ? h(
            'button',
            {
              type: 'button',
              key: 'sheet',
              class: cx('btn', 'btn-sm', 'fb-btn', 'fb-sheet-btn', 'fb-phone', sheetCount > 0 && 'is-active'),
              'data-fb': 'sheet',
              'aria-haspopup': 'dialog',
              'aria-label': sheetCount > 0 ? `Filtros (${sheetCount} ativos)` : 'Filtros',
              onclick: (ev) => openSheet(controllerOf(ev.currentTarget, cfg)),
            },
            makeIcon('filter', { size: 14, class: 'fb-btn-icon' }),
            h('span', { class: 'btn-label' }, 'Filtros'),
            sheetCount > 0 ? countBadge(sheetCount, { tone: 'accent', class: 'fb-btn-count' }) : null,
          )
        : null,
      countText || hasSort || extras.length
        ? h(
            'div',
            { key: 'end', class: 'fb-end' },
            countText ? h('span', { key: 'count', class: 'fb-count tabular', 'aria-live': 'polite' }, countText) : null,
            hasSort ? sortButton(cfg) : null,
            extras.length ? h('div', { key: 'extra', class: 'fb-extra' }, extras) : null,
          )
        : null,
    ),
    chips.length > 0 ? chipsRow(cfg, chips) : null,
  );
}
