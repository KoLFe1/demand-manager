// Peças comuns da tela "Demandas" (js/ui/views/demandas.js): estado da tela, ordenação pelos cabeçalhos,
// agrupamento, cabeçalhos de grupo, edição do nome no lugar e utilidades de linha.
//
// Tudo aqui é puro em relação ao app: lê com app.sel.* e grava só por app.cmd.* (com handleError).

import { cx, h } from '../../../core/dom.js';
import { plural } from '../../../core/format.js';
import { PRIORITIES, priorityById } from '../../../domain/priorities.js';
import { DEFAULT_SORT, normalizeFilters, normalizeSort } from '../../shared/filterbar.js';
import { handleError, projectDot } from '../../shared/entity.js';
import { icon } from '../../kit/icons.js';
import { priorityBadge, statusBadge } from '../../kit/display.js';

/** Elementos que tratam o próprio clique dentro de uma linha (o clique não abre o painel). */
export const INTERACTIVE = 'button, a, input, textarea, select, label, [data-stop], .inline-edit, [role="checkbox"], [role="switch"]';

/** Modos da tela. */
export const MODES = Object.freeze(['demands', 'tasks']);

/** Opções de agrupamento por modo (ids gravados em ctx.state). */
export const GROUPS = Object.freeze({
  demands: Object.freeze([
    Object.freeze({ id: 'none', label: 'Nenhum' }),
    Object.freeze({ id: 'projeto', label: 'Projeto' }),
    Object.freeze({ id: 'status', label: 'Status' }),
    Object.freeze({ id: 'prioridade', label: 'Prioridade' }),
  ]),
  tasks: Object.freeze([
    Object.freeze({ id: 'none', label: 'Nenhum' }),
    Object.freeze({ id: 'demanda', label: 'Demanda' }),
    Object.freeze({ id: 'projeto', label: 'Projeto' }),
    Object.freeze({ id: 'status', label: 'Status' }),
    Object.freeze({ id: 'prioridade', label: 'Prioridade' }),
  ]),
});

/** Ordenação padrão de cada modo (tarefas: prioridade e, no desempate, prazo — seção 5 do pedido). */
export const DEFAULT_SORTS = Object.freeze({
  demands: DEFAULT_SORT,
  tasks: Object.freeze({ key: 'priority', dir: 'asc' }),
});

/** Chaves de ordenação oferecidas por modo (cabeçalhos e menu do celular). */
export const SORT_KEYS = Object.freeze({
  demands: Object.freeze(['manual', 'name', 'project', 'priority', 'status', 'due_date', 'progress']),
  tasks: Object.freeze(['priority', 'due_date', 'name', 'project', 'status', 'created_at']),
});

/** Rótulos das chaves de ordenação desta tela. */
export const SORT_TEXT = Object.freeze({
  manual: 'Ordem manual',
  name: 'Nome',
  project: 'Projeto',
  priority: 'Prioridade',
  status: 'Status',
  due_date: 'Prazo',
  progress: 'Progresso',
  created_at: 'Criação',
});

const hasId = (id) => id !== null && id !== undefined && id !== '';

/**
 * Linhas por página no modo Tarefas: só elas vão para o DOM; "Mostrar mais" acrescenta outra página
 * (ctx.state.tLimit, que volta ao início ao entrar na tela). Os números do resumo usam a lista inteira.
 */
export const TASK_PAGE = 100;

/**
 * Estado da tela já normalizado (ctx.state pode vir de outra versão do app, ou vazio).
 * @param {object} state ctx.state
 * @returns {object}
 */
export function readState(state) {
  const s = state && typeof state === 'object' ? state : {};
  const mode = s.mode === 'tasks' ? 'tasks' : 'demands';
  const groupOf = (value, kind) => (GROUPS[kind].some((g) => g.id === value) ? value : 'none');
  const sortOf = (value, kind) => {
    if (!value) return { ...DEFAULT_SORTS[kind] };
    const sort = normalizeSort(value);
    return SORT_KEYS[kind].includes(sort.key) ? sort : { ...DEFAULT_SORTS[kind] };
  };
  const list = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : []);
  return {
    mode,
    demands: {
      filters: normalizeFilters(s.dFilters),
      sort: sortOf(s.dSort, 'demands'),
      group: groupOf(s.dGroup, 'demands'),
      collapsed: new Set(list(s.dCollapsed)),
    },
    tasks: {
      // Primeira visita ao modo Tarefas: as concluídas começam ocultas (a lista é do que falta fazer);
      // o chip "Sem concluídas" da barra de filtros mostra e desfaz isso.
      filters: s.tFilters === undefined ? { ...normalizeFilters(null), showDone: false } : normalizeFilters(s.tFilters),
      sort: sortOf(s.tSort, 'tasks'),
      group: groupOf(s.tGroup, 'tasks'),
      collapsed: new Set(list(s.tCollapsed)),
      withSubtasks: s.withSubtasks !== false,
      limit: Number.isInteger(s.tLimit) && s.tLimit > TASK_PAGE ? s.tLimit : TASK_PAGE,
    },
    expanded: new Set(list(s.expanded)),
    editing: typeof s.editing === 'string' ? s.editing : null,
  };
}

/** Chaves do ctx.state de cada modo. */
export const STATE_KEYS = Object.freeze({
  demands: Object.freeze({ filters: 'dFilters', sort: 'dSort', group: 'dGroup', collapsed: 'dCollapsed' }),
  tasks: Object.freeze({ filters: 'tFilters', sort: 'tSort', group: 'tGroup', collapsed: 'tCollapsed' }),
});

/** Lista sem / com o valor (alternância). */
export function toggled(list, value) {
  const set = new Set(list);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return [...set];
}

/**
 * Próxima ordenação ao clicar num cabeçalho: outra coluna → crescente; mesma coluna crescente → decrescente;
 * decrescente → volta ao padrão do modo.
 */
export function nextSort(current, key, mode) {
  const sort = normalizeSort(current);
  if (sort.key !== key) return { key, dir: 'asc' };
  if (sort.dir === 'asc') return { key, dir: 'desc' };
  return { ...DEFAULT_SORTS[mode] };
}

/** Projeto do escopo global (app.ui.scope.projectId) ou null. */
export function scopeProjectId(app) {
  try {
    const id = app.ui && app.ui.scope ? app.ui.scope.projectId : null;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** Executa um comando tratando erros (handleError); devolve o resultado ou null. */
export function run(app, fn) {
  try {
    return fn();
  } catch (err) {
    handleError(app, err);
    return null;
  }
}

/**
 * Clique no corpo de uma linha: abre o painel, a menos que o alvo seja um controle. Um alvo que já saiu da
 * linha (ex.: o texto do inlineEdit, trocado pelo campo no próprio clique) também não abre.
 */
export function bodyClick(handler) {
  return (ev) => {
    const row = ev.currentTarget;
    if (ev.target && ev.target !== row && !row.contains(ev.target)) return;
    const hit = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest(INTERACTIVE) : null;
    if (hit && hit !== row && row.contains(hit)) return;
    handler(ev);
  };
}

/**
 * Teclado na linha (só quando o foco está na própria linha): Enter/Espaço abre, F2 edita o nome,
 * → / ← expandem e recolhem (quando há `ontoggle`).
 */
export function rowKeydown({ onopen, onrename, ontoggle, expanded = false }) {
  return (ev) => {
    if (ev.target !== ev.currentTarget || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      ev.stopPropagation();
      onopen(ev);
    } else if (ev.key === 'F2' && onrename) {
      ev.preventDefault();
      ev.stopPropagation();
      onrename(ev);
    } else if (ontoggle && ((ev.key === 'ArrowRight' && !expanded) || (ev.key === 'ArrowLeft' && expanded))) {
      ev.preventDefault();
      ontoggle(ev);
    }
  };
}

/**
 * Campo de edição do nome no lugar (F2 / duplo clique). Enter ou sair do campo salva; Esc cancela.
 * @param {object} app
 * @param {object} ctx contexto da tela
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @returns {HTMLInputElement}
 */
export function nameEditor(app, ctx, type, entity) {
  const finish = (input, save) => {
    if (input.__vdDone) return;
    input.__vdDone = true;
    const text = input.value.replace(/\s+/g, ' ').trim();
    if (save && text && text !== entity.name) {
      run(app, () => (type === 'task' ? app.cmd.updateTask(entity.id, { name: text }) : app.cmd.updateDemand(entity.id, { name: text })));
    }
    ctx.setState({ editing: null });
  };
  return h('input', {
    key: `edit-${entity.id}`,
    class: 'v-dm-name-input',
    type: 'text',
    value: entity.name || '',
    maxlength: 500,
    autocomplete: 'off',
    'aria-label': type === 'task' ? 'Nome da tarefa' : 'Nome da demanda',
    'data-stop': true,
    ref: (el) => {
      if (el.__vdFocused || !el.isConnected) return;
      el.__vdFocused = true;
      el.focus({ preventScroll: true });
      el.select();
    },
    onkeydown: (ev) => {
      if (ev.isComposing) return;
      if (ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        const row = ev.currentTarget.closest('[data-entity]');
        finish(ev.currentTarget, true);
        if (row) row.focus({ preventScroll: true });
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        const row = ev.currentTarget.closest('[data-entity]');
        finish(ev.currentTarget, false);
        if (row) row.focus({ preventScroll: true });
      }
    },
    onblur: (ev) => finish(ev.currentTarget, true),
    onclick: (ev) => ev.stopPropagation(),
  });
}

/**
 * Cabeçalho de coluna ordenável: botão com o indicador de direção.
 * @param {{ label: string, key: string|null, sort: object, onsort: (next: object) => void, mode: string, class?: string }} options
 * @returns {HTMLElement}
 */
export function headerCell({ label, key, sort, onsort, mode, class: className }) {
  if (!key) return h('span', { class: cx('v-dm-th', className) }, h('span', { class: 'v-dm-th-label' }, label));
  const active = sort.key === key;
  const dir = active ? sort.dir : null;
  const dirText = dir === 'desc' ? 'decrescente' : 'crescente';
  return h(
    'span',
    { class: cx('v-dm-th', className), 'aria-sort': active ? (dir === 'desc' ? 'descending' : 'ascending') : null },
    h(
      'button',
      {
        type: 'button',
        class: cx('v-dm-sort', active && 'is-active'),
        'data-sort': key,
        title: active ? `Ordenado por ${label.toLowerCase()} (${dirText}) — clique para inverter` : `Ordenar por ${label.toLowerCase()}`,
        'aria-label': active ? `${label}: ordenado, ${dirText}` : `Ordenar por ${label.toLowerCase()}`,
        onclick: () => onsort(nextSort(sort, key, mode)),
      },
      h('span', { class: 'v-dm-th-label' }, label),
      icon(dir === 'desc' ? 'arrow-down' : 'arrow-up', { size: 12, class: 'v-dm-sort-dir' }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Agrupamento
// ---------------------------------------------------------------------------

/**
 * Agrupa uma lista já ordenada. A ordem dos grupos segue a ordem natural da chave (projetos e demandas pela
 * ordem manual, status pela ordem configurada, prioridade P1 → P4); "Sem projeto"/"Sem demanda" por último.
 * @param {object} app
 * @param {object[]} items
 * @param {string} group 'projeto' | 'demanda' | 'status' | 'prioridade'
 * @param {'task'|'demand'} type
 * @returns {Array<{ key: string, label: Node[], title: string, items: object[] }>}
 */
export function groupRows(app, items, group, type) {
  const { sel } = app;
  const buckets = new Map();
  const push = (key, item) => {
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(item);
  };
  let order;
  let describe;
  if (group === 'projeto') {
    for (const item of items) push(sel.projectIdOf(type, item) || '', item);
    const rank = new Map(sel.projects({ includeArchived: true }).map((p, i) => [p.id, i]));
    order = (key) => (key === '' ? Infinity : rank.has(key) ? rank.get(key) : 1e9);
    describe = (key) => {
      const project = key ? sel.project(key) : null;
      const name = project ? project.name : 'Sem projeto';
      return { label: [projectDot(project), h('span', { class: 'v-dm-group-name' }, name)], title: name };
    };
  } else if (group === 'demanda') {
    for (const item of items) {
      const demand = sel.demandOf(item);
      push(demand ? demand.id : '', item);
    }
    const rank = new Map(sel.demands({ includeArchived: true }).map((d, i) => [d.id, i]));
    order = (key) => (key === '' ? Infinity : rank.has(key) ? rank.get(key) : 1e9);
    describe = (key) => {
      const demand = key ? sel.demand(key) : null;
      if (!demand) return { label: [icon('inbox', { size: 14, class: 'v-dm-group-icon' }), h('span', { class: 'v-dm-group-name' }, 'Sem demanda')], title: 'Sem demanda' };
      const project = sel.projectOf('demand', demand);
      return {
        label: [
          projectDot(project),
          h('span', { class: 'v-dm-group-code tabular' }, sel.code('demand', demand)),
          h('span', { class: 'v-dm-group-name' }, demand.name),
          project ? h('span', { class: 'v-dm-group-hint' }, project.name) : null,
        ],
        title: demand.name,
      };
    };
  } else if (group === 'status') {
    for (const item of items) push(item.status || '', item);
    const statuses = sel.statuses();
    const rank = new Map(statuses.map((s, i) => [s.id, i]));
    order = (key) => (rank.has(key) ? rank.get(key) : 1e9);
    describe = (key) => {
      const status = sel.status(key);
      return { label: [statusBadge(status, { soft: true })], title: status.label };
    };
  } else {
    for (const item of items) push(priorityById(item.priority).id, item);
    order = (key) => PRIORITIES.findIndex((p) => p.id === key);
    describe = (key) => {
      const def = priorityById(key);
      return { label: [priorityBadge(def.id), h('span', { class: 'v-dm-group-name' }, def.label)], title: `${def.id} — ${def.label}` };
    };
  }
  return [...buckets.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]))
    .map(([key, list]) => ({ key: key || 'none', items: list, ...describe(key) }));
}

/**
 * Cabeçalho recolhível de um grupo (com a contagem).
 * @param {{ group: object, collapsed: boolean, ontoggle: () => void, noun: [string, string] }} options
 * @returns {HTMLElement}
 */
export function groupHeader({ group, collapsed, ontoggle, noun }) {
  return h(
    'div',
    { key: `gh-${group.key}`, class: cx('v-dm-group-head', collapsed && 'is-collapsed'), 'data-group': group.key },
    h(
      'button',
      {
        type: 'button',
        class: 'v-dm-group-toggle',
        'aria-expanded': !collapsed,
        title: collapsed ? `Mostrar ${group.title}` : `Recolher ${group.title}`,
        onclick: ontoggle,
      },
      icon('chevron-down', { size: 14, class: 'v-dm-group-chevron' }),
      group.label,
      h('span', { class: 'v-dm-group-count tabular', title: plural(group.items.length, noun[0], noun[1]) }, String(group.items.length)),
    ),
  );
}

/** Existe um id de verdade? */
export { hasId };
