// Filtro, busca, ordenação e agrupamento comuns a todas as telas de lista. Puro e determinístico.
//
// Os itens são linhas de `demands` ou `tasks` (ver js/data/schema.js). Tudo que depende de outras tabelas
// (projeto de uma tarefa, código legível, progresso, nome do projeto…) chega por funções no contexto (`ctx`).
// Nenhuma função altera os itens nem as listas recebidas: o resultado é sempre um array novo.

import { compareDates, isValidDateStr, ms } from '../core/dates.js';
import { DEADLINE_STATES, DUE_BUCKETS, deadlineInfo, dueBucketOf } from './deadlines.js';
import { priorityById, priorityRank } from './priorities.js';
import { categoryOf, isCancelledCategory, isDoneCategory, statusById } from './statuses.js';

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

/**
 * Normaliza um texto para comparação/busca: minúsculas e sem acentos ("Revisão do Piauí" → "revisao do piaui").
 *
 * @param {*} text qualquer valor (null/undefined viram '')
 * @returns {string}
 */
export function normalizeText(text) {
  if (text == null) return '';
  // U+0300–U+036F = marcas de acento combinantes (escritas com escape para não depender do editor).
  return String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Chave de comparação "exata, sem diferenciar maiúsculas" (responsável e tags). */
const exactKey = (value) => (value == null ? '' : String(value).trim().toLowerCase());

const TEXT_COLLATOR = new Intl.Collator('pt-BR', { numeric: true });

/** Aceita array ou qualquer iterável de objetos; qualquer outra coisa vira lista vazia. */
function toList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') return [...value];
  return [];
}

// ---------------------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------------------

/**
 * Opções padrão do filtro de prazo, na ordem em que aparecem na interface. As definições são as mesmas dos
 * alertas de deadlines.js (faixas exclusivas) e valem só para itens ABERTOS.
 */
export const DEADLINE_FILTER_OPTIONS = Object.freeze([
  Object.freeze({ id: DUE_BUCKETS.OVERDUE, label: 'Atrasadas' }),
  Object.freeze({ id: DUE_BUCKETS.TODAY, label: 'Vencem hoje' }),
  Object.freeze({ id: DUE_BUCKETS.NEXT3, label: 'Vencem em 1 a 3 dias' }),
  Object.freeze({ id: DUE_BUCKETS.NEXT7, label: 'Vencem em 4 a 7 dias' }),
  Object.freeze({ id: DUE_BUCKETS.NO_DUE, label: 'Sem prazo' }),
]);

/**
 * Valores aceitos em `filters.deadline`: as cinco opções padrão e, como extensão, dois estados do indicador de
 * prazo — `due_soon` (vence de hoje até `ctx.soonDays` dias) e `on_time` (vence depois disso).
 */
export const DEADLINE_FILTER_KEYS = Object.freeze([
  ...DEADLINE_FILTER_OPTIONS.map((option) => option.id),
  DEADLINE_STATES.DUE_SOON,
  DEADLINE_STATES.ON_TIME,
]);

/**
 * Filtros no estado inicial (objeto e arrays novos a cada chamada).
 *
 * @returns {{ q: string, projectIds: Array, statusIds: string[], priorities: string[], tags: string[], owner: string,
 *             deadline: null|string, showDone: boolean, showCancelled: boolean, showArchived: boolean }}
 *   `q` texto de busca; `projectIds` projetos ('' ou null dentro da lista = "sem projeto"); `statusIds` ids de status;
 *   `priorities` 'P1'…'P4'; `tags` o item precisa ter TODAS; `owner` responsável; `deadline` ver DEADLINE_FILTER_KEYS;
 *   `showDone` mostra concluídas (padrão true); `showCancelled` mostra canceladas (padrão false);
 *   `showArchived` mostra arquivadas (padrão false).
 */
export function defaultFilters() {
  return {
    q: '',
    projectIds: [],
    statusIds: [],
    priorities: [],
    tags: [],
    owner: '',
    deadline: null,
    showDone: true,
    showCancelled: false,
    showArchived: false,
  };
}

function toText(value) {
  if (typeof value === 'string') return value;
  return value == null ? '' : String(value);
}

/** Lista sem repetições; um valor solto (texto/número não vazio) vira lista de um item. */
function toUniqueArray(value) {
  if (Array.isArray(value) || value instanceof Set) return [...new Set(value)];
  if ((typeof value === 'string' && value !== '') || typeof value === 'number') return [value];
  return [];
}

/**
 * Cópia completa e saneada de um objeto de filtros — útil para estado salvo por outra versão do app ou
 * preenchido só em parte. Chaves ausentes ou de tipo inesperado assumem o padrão, listas perdem repetições e um
 * valor desconhecido em `deadline` vira null. Só as chaves de defaultFilters() são devolvidas.
 *
 * @param {object|null} [filters] filtros parciais (não é alterado)
 * @returns {ReturnType<typeof defaultFilters>}
 */
export function normalizeFilters(filters) {
  const f = filters && typeof filters === 'object' ? filters : {};
  return {
    q: toText(f.q),
    projectIds: toUniqueArray(f.projectIds),
    statusIds: toUniqueArray(f.statusIds),
    priorities: toUniqueArray(f.priorities),
    tags: toUniqueArray(f.tags),
    owner: toText(f.owner),
    deadline: DEADLINE_FILTER_KEYS.includes(f.deadline) ? f.deadline : null,
    showDone: f.showDone !== false,
    showCancelled: f.showCancelled === true,
    showArchived: f.showArchived === true,
  };
}

/**
 * Quais filtros estão diferentes do padrão.
 *
 * @param {object|null} [filters] filtros (podem ser parciais)
 * @returns {string[]} nomes das chaves ativas, na ordem de defaultFilters(). Busca só com espaços, lista vazia e
 *          `deadline` desconhecido contam como "não filtrado"; cada lista conta uma vez, não importa o tamanho.
 */
export function activeFilterKeys(filters) {
  const f = normalizeFilters(filters);
  const active = [];
  if (f.q.trim() !== '') active.push('q');
  for (const key of ['projectIds', 'statusIds', 'priorities', 'tags']) if (f[key].length > 0) active.push(key);
  if (f.owner.trim() !== '') active.push('owner');
  if (f.deadline !== null) active.push('deadline');
  if (!f.showDone) active.push('showDone');
  if (f.showCancelled) active.push('showCancelled');
  if (f.showArchived) active.push('showArchived');
  return active;
}

/**
 * Há algum filtro diferente do padrão? (para mostrar "Limpar filtros")
 *
 * @param {object|null} [filters]
 * @returns {boolean}
 */
export function isFilterActive(filters) {
  return activeFilterKeys(filters).length > 0;
}

/**
 * Quantos filtros estão diferentes do padrão (para o contador do botão "Filtros").
 *
 * @param {object|null} [filters]
 * @returns {number}
 */
export function countActiveFilters(filters) {
  return activeFilterKeys(filters).length;
}

// ---------------------------------------------------------------------------
// Busca por texto
// ---------------------------------------------------------------------------

/** Texto pesquisável do item, já normalizado; os campos ficam em linhas separadas (um termo não atravessa campos). */
function searchableText(entity, extraTexts) {
  const parts = [];
  const push = (value) => {
    if (value != null && value !== '') parts.push(String(value));
  };
  if (entity) {
    push(entity.name);
    push(entity.description);
    if (Array.isArray(entity.tags)) entity.tags.forEach(push);
    push(entity.owner);
    push(entity.next_action);
  }
  if (Array.isArray(extraTexts)) extraTexts.forEach(push);
  else push(extraTexts);
  return normalizeText(parts.join('\n'));
}

/** Prepara a busca uma única vez (os termos) e devolve o teste por item. */
function makeTextMatcher(q) {
  const terms = normalizeText(q).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return () => true;
  return (entity, extraTexts) => {
    const haystack = searchableText(entity, extraTexts);
    return terms.every((term) => haystack.includes(term));
  };
}

/**
 * Busca por texto, sem diferenciar acentos nem maiúsculas. O item casa quando TODOS os termos de `q` (separados
 * por espaço) aparecem em algum destes textos: nome, descrição, tags, responsável, próxima ação e `extraTexts`
 * (ex.: o código legível 'T-12' / 'D-3', o nome do projeto). Cada termo pode estar num campo diferente.
 *
 * @param {object|null} entity demanda ou tarefa
 * @param {string} q texto digitado (vazio ou só espaços casa com tudo)
 * @param {string[]|string} [extraTexts] textos adicionais pesquisáveis
 * @returns {boolean}
 */
export function matchesText(entity, q, extraTexts = []) {
  return makeTextMatcher(q)(entity, extraTexts);
}

// ---------------------------------------------------------------------------
// Aplicação dos filtros
// ---------------------------------------------------------------------------

const isNoProject = (id) => id == null || id === '';

function makeDeadlineMatcher(key, ctx) {
  const deadlineCtx = { today: ctx.today, statuses: ctx.statuses, soonDays: ctx.soonDays };
  if (key === DEADLINE_STATES.DUE_SOON || key === DEADLINE_STATES.ON_TIME) {
    return (item) => deadlineInfo(item, deadlineCtx).state === key;
  }
  return (item) => dueBucketOf(item, deadlineCtx) === key;
}

/**
 * Monta o teste "este item passa nos filtros?" (os filtros são preparados uma única vez).
 * Todas as condições são combinadas com E:
 *
 *   • `q`           busca por texto (matchesText) em nome, descrição, tags, responsável, próxima ação,
 *                   código legível (`ctx.codeOf`) e textos extras (`ctx.extraTextOf`);
 *   • `projectIds`  o projeto do item (`ctx.projectIdOf(item)`; sem a função, `item.project_id`) está na lista —
 *                   '' ou null dentro da lista significa "sem projeto";
 *   • `statusIds`   o status do item está na lista;
 *   • `priorities`  a prioridade do item está na lista (prioridade ausente/desconhecida vale a padrão, P3);
 *   • `tags`        o item tem TODAS as tags selecionadas (sem diferenciar maiúsculas);
 *   • `owner`       responsável exatamente igual (sem diferenciar maiúsculas);
 *   • `deadline`    faixa de prazo, só itens ABERTOS, mesmas definições de deadlines.js:
 *                   'overdue' | 'today' | 'next3' (1–3 dias) | 'next7' (4–7 dias) | 'no_due'
 *                   (+ extensões 'due_soon' e 'on_time', que seguem deadlineInfo e `ctx.soonDays`);
 *   • `showDone: false`      esconde itens de categoria "concluída";
 *   • `showCancelled: false` esconde itens de categoria "cancelada";
 *   • `showArchived: false`  esconde itens arquivados (`archived_at`, ou `ctx.isArchived(item)` quando informado).
 *
 * Escolher um status explicitamente em `statusIds` vale mais que `showDone`/`showCancelled`: quem filtra por
 * "Cancelada" vê as canceladas mesmo com `showCancelled` desligado (que é o padrão).
 * Itens excluídos (`deleted_at`) NÃO são tratados aqui: quem chama decide o que entra na lista.
 *
 * @param {object|null} filters filtros (podem ser parciais; ver defaultFilters)
 * @param {object} [ctx]
 * @param {Array}    [ctx.statuses]     lista efetiva de status (padrão: os de fábrica)
 * @param {string}   [ctx.today]        hoje 'YYYY-MM-DD' — obrigatório quando `filters.deadline` está em uso
 * @param {Function} [ctx.projectIdOf]  (item) → id do projeto | null
 * @param {Function} [ctx.codeOf]       (item) → código legível ('T-12')
 * @param {Function} [ctx.extraTextOf]  (item) → texto(s) extra(s) pesquisável(is): string ou array de strings
 * @param {Function} [ctx.isArchived]   (item) → boolean (arquivamento "efetivo", próprio ou herdado)
 * @param {number}   [ctx.soonDays]     dias de antecedência de "próxima do vencimento" (filtro 'due_soon'/'on_time')
 * @returns {(item: object|null) => boolean} itens nulos nunca passam.
 * @throws {TypeError} quando `filters.deadline` está em uso e `ctx.today` não é uma data válida.
 */
export function makeFilterPredicate(filters, ctx = {}) {
  const f = normalizeFilters(filters);
  const context = ctx || {};
  const { statuses } = context;
  const projectIdOf = typeof context.projectIdOf === 'function' ? context.projectIdOf : (item) => item.project_id;
  const codeOf = typeof context.codeOf === 'function' ? context.codeOf : null;
  const extraTextOf = typeof context.extraTextOf === 'function' ? context.extraTextOf : null;
  const isArchived = typeof context.isArchived === 'function' ? context.isArchived : (item) => !!item.archived_at;

  const textMatcher = f.q.trim() !== '' ? makeTextMatcher(f.q) : null;
  const projectSet = f.projectIds.length > 0 ? new Set(f.projectIds.filter((id) => !isNoProject(id))) : null;
  const wantsNoProject = f.projectIds.some(isNoProject);
  const statusSet = f.statusIds.length > 0 ? new Set(f.statusIds) : null;
  const prioritySet = f.priorities.length > 0 ? new Set(f.priorities) : null;
  const tagKeys = [...new Set(f.tags.map(exactKey).filter(Boolean))];
  const ownerKey = exactKey(f.owner);

  let deadlineMatcher = null;
  if (f.deadline !== null) {
    if (!isValidDateStr(context.today)) {
      throw new TypeError(`applyFilters: o filtro de prazo precisa de "ctx.today" no formato 'YYYY-MM-DD' (recebido: ${JSON.stringify(context.today) ?? String(context.today)})`);
    }
    deadlineMatcher = makeDeadlineMatcher(f.deadline, context);
  }

  return (item) => {
    if (!item) return false;
    if (!f.showArchived && isArchived(item)) return false;

    if (statusSet) {
      if (!statusSet.has(item.status)) return false;
    } else {
      const category = categoryOf(statuses, item.status);
      if (!f.showDone && isDoneCategory(category)) return false;
      if (!f.showCancelled && isCancelledCategory(category)) return false;
    }

    if (projectSet) {
      const projectId = projectIdOf(item);
      if (isNoProject(projectId) ? !wantsNoProject : !projectSet.has(projectId)) return false;
    }
    if (prioritySet && !prioritySet.has(priorityById(item.priority).id)) return false;
    if (ownerKey && exactKey(item.owner) !== ownerKey) return false;
    if (tagKeys.length > 0) {
      const own = new Set((Array.isArray(item.tags) ? item.tags : []).map(exactKey));
      if (!tagKeys.every((key) => own.has(key))) return false;
    }
    if (deadlineMatcher && !deadlineMatcher(item)) return false;
    if (textMatcher) {
      const extras = [];
      if (codeOf) extras.push(codeOf(item));
      if (extraTextOf) extras.push(...[extraTextOf(item)].flat());
      if (!textMatcher(item, extras)) return false;
    }
    return true;
  };
}

/**
 * Filtra uma lista de demandas/tarefas (ver makeFilterPredicate para as regras de cada filtro).
 *
 * @param {Iterable<object>} items itens a filtrar (não é alterado)
 * @param {object|null} filters filtros (podem ser parciais; null = padrão)
 * @param {object} [ctx] `{ statuses, today, projectIdOf(item) → id|null, codeOf?(item) → string, soonDays?,
 *        extraTextOf?(item), isArchived?(item) }`
 * @returns {object[]} array NOVO com os itens que passam, na ordem original.
 * @throws {TypeError} quando `filters.deadline` está em uso e `ctx.today` não é uma data válida.
 */
export function applyFilters(items, filters, ctx = {}) {
  return toList(items).filter(makeFilterPredicate(filters, ctx));
}

// ---------------------------------------------------------------------------
// Ordenação
// ---------------------------------------------------------------------------

const byNumber = (a, b) => a - b;
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byText = (a, b) => TEXT_COLLATOR.compare(a, b);

const finiteOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function instantOrNull(iso) {
  const time = ms(iso);
  return Number.isNaN(time) ? null : time;
}

/** Aceita o número devolvido por `ctx.progressOf` ou o próprio resultado de demandProgress ({ value }). */
function progressOrNull(value) {
  if (value && typeof value === 'object') return finiteOrNull(value.value);
  return finiteOrNull(value);
}

const dueOrNull = (item) => (isValidDateStr(item.due_date) ? item.due_date : null);

/** Cada chave de ordenação: como obter o valor (null = vazio) e como comparar dois valores não vazios. */
const SORTERS = Object.freeze({
  manual: { value: (item) => finiteOrNull(item.sort_order), compare: byNumber },
  priority: { value: (item) => priorityRank(item.priority), compare: byNumber },
  due_date: { value: dueOrNull, compare: byString },
  name: { value: (item) => textOrNull(item.name), compare: byText },
  status: { value: (item, ctx) => finiteOrNull(statusById(ctx.statuses, item.status).order) ?? 999, compare: byNumber },
  created_at: { value: (item) => instantOrNull(item.created_at), compare: byNumber },
  updated_at: { value: (item) => instantOrNull(item.updated_at), compare: byNumber },
  progress: {
    value: (item, ctx) => (typeof ctx.progressOf === 'function' ? progressOrNull(ctx.progressOf(item)) : null),
    compare: byNumber,
  },
  project: {
    value: (item, ctx) => (typeof ctx.projectNameOf === 'function' ? textOrNull(ctx.projectNameOf(item)) : null),
    compare: byText,
  },
});

/** Opções de ordenação com rótulo (pt-BR), na ordem sugerida para menus. */
export const SORT_OPTIONS = Object.freeze([
  Object.freeze({ key: 'manual', label: 'Ordem manual' }),
  Object.freeze({ key: 'priority', label: 'Prioridade' }),
  Object.freeze({ key: 'due_date', label: 'Prazo' }),
  Object.freeze({ key: 'name', label: 'Nome' }),
  Object.freeze({ key: 'status', label: 'Status' }),
  Object.freeze({ key: 'progress', label: 'Progresso' }),
  Object.freeze({ key: 'project', label: 'Projeto' }),
  Object.freeze({ key: 'created_at', label: 'Criação' }),
  Object.freeze({ key: 'updated_at', label: 'Última alteração' }),
]);

/** Chaves aceitas em `sort.key`. */
export const SORT_KEYS = Object.freeze(SORT_OPTIONS.map((option) => option.key));

/** Ordenação padrão das listas. */
export const DEFAULT_SORT = Object.freeze({ key: 'manual', dir: 'asc' });

/**
 * Ordenação válida a partir de um valor qualquer (estado salvo, parâmetro de URL…).
 *
 * @param {{ key?: string, dir?: string }|string|null} [sort] objeto `{ key, dir }` ou só a chave
 * @returns {{ key: string, dir: 'asc'|'desc' }} chave desconhecida vira 'manual'; direção diferente de 'desc' vira 'asc'.
 */
export function normalizeSort(sort) {
  const raw = typeof sort === 'string' ? { key: sort } : sort || {};
  return {
    key: typeof raw.key === 'string' && Object.hasOwn(SORTERS, raw.key) ? raw.key : DEFAULT_SORT.key,
    dir: raw.dir === 'desc' ? 'desc' : 'asc',
  };
}

/** Compara dois valores que podem ser vazios (null): vazios SEMPRE por último, qualquer que seja a direção. */
function compareNullable(a, b, compare, sign = 1) {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return sign * compare(a, b);
}

/**
 * Ordena demandas/tarefas.
 *
 * Chaves (`sort.key`):
 *   'manual'     `sort_order` crescente            'priority'   P1 primeiro (asc)
 *   'due_date'   prazo mais próximo primeiro (asc) 'name'       alfabética pt-BR, números em ordem numérica
 *   'status'     ordem (`order`) do status         'created_at' / 'updated_at'  mais antigos primeiro (asc)
 *   'progress'   `ctx.progressOf(item)` (número, ou o resultado de demandProgress)
 *   'project'    `ctx.projectNameOf(item)` (alfabética)
 * `sort.dir`: 'asc' (padrão) ou 'desc' — inverte só a chave principal.
 *
 * Valores VAZIOS (sem prazo, sem projeto, sem progresso, sem nome, data inválida…) ficam SEMPRE por último,
 * nas duas direções. Desempate, sempre na ordem natural: prioridade (P1 primeiro) → prazo (vazios por último)
 * → nome. A ordenação é estável: itens ainda empatados mantêm a ordem em que chegaram.
 *
 * @param {Iterable<object>} items itens a ordenar (não é alterado; entradas nulas são descartadas)
 * @param {{ key?: string, dir?: 'asc'|'desc' }|string|null} sort ordenação (inválida/ausente = 'manual' asc)
 * @param {object} [ctx] `{ statuses, progressOf?(item) → number|null, projectNameOf?(item) → string|null }`
 * @returns {object[]} array NOVO ordenado.
 */
export function sortItems(items, sort, ctx = {}) {
  const { key, dir } = normalizeSort(sort);
  const sorter = SORTERS[key];
  const sign = dir === 'desc' ? -1 : 1;
  const context = ctx || {};

  const rows = [];
  for (const item of toList(items)) {
    if (!item) continue;
    rows.push({
      item,
      index: rows.length,
      primary: sorter.value(item, context),
      rank: priorityRank(item.priority),
      due: dueOrNull(item),
      name: textOrNull(item.name),
    });
  }

  rows.sort((a, b) =>
    compareNullable(a.primary, b.primary, sorter.compare, sign)
    || a.rank - b.rank
    || compareDates(a.due, b.due)
    || compareNullable(a.name, b.name, byText)
    || a.index - b.index);

  return rows.map((row) => row.item);
}

/**
 * Comparador da "Ordem manual" — exatamente a ordem de sortItems(items, 'manual'): `sort_order` crescente
 * (sem ordem por último) → prioridade → prazo → nome; o empate final, que em sortItems é a ordem de chegada,
 * aqui é created_at e depois id (determinístico). Os comandos que reposicionam itens (antes/depois de X) usam
 * este comparador para enxergar os vizinhos na mesma ordem que a tela mostra.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareManualOrder(a, b) {
  const created = (item) => String(item.created_at || '');
  return (
    compareNullable(finiteOrNull(a.sort_order), finiteOrNull(b.sort_order), byNumber)
    || priorityRank(a.priority) - priorityRank(b.priority)
    || compareDates(dueOrNull(a), dueOrNull(b))
    || compareNullable(textOrNull(a.name), textOrNull(b.name), byText)
    || byString(created(a), created(b))
    || byString(String(a.id), String(b.id))
  );
}

// ---------------------------------------------------------------------------
// Agrupamento
// ---------------------------------------------------------------------------

/**
 * Agrupa itens pela chave devolvida por `keyFn`, preservando a ordem em que cada grupo aparece pela primeira
 * vez e a ordem dos itens dentro do grupo.
 *
 * @param {Iterable<object>} items itens (entradas nulas são ignoradas)
 * @param {(item: object) => *} keyFn chave do grupo (qualquer valor; undefined é tratado como null)
 * @returns {Array<{ key: *, items: object[] }>}
 * @throws {TypeError} quando `keyFn` não é uma função.
 */
export function groupItems(items, keyFn) {
  if (typeof keyFn !== 'function') throw new TypeError('groupItems: "keyFn" precisa ser uma função');
  const groups = new Map();
  for (const item of toList(items)) {
    if (item == null) continue;
    const raw = keyFn(item);
    const key = raw === undefined ? null : raw;
    let group = groups.get(key);
    if (!group) {
      group = { key, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}
