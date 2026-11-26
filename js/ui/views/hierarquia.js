// Visualização "Hierarquia" (especificação 10.4): Projeto → Demanda → Tarefa → Subtarefa numa árvore com
// expandir/recolher em todos os níveis, criação em linha, arrastar e soltar e navegação pelo teclado.
//
//   • modelo, filtros e expansão: ./hierarquia/model.js   • arrastar e soltar: ./hierarquia/moves.js
//   • linhas de demanda/tarefa, controles e menus: ../shared/entity.js (nada reimplementado aqui)
//
// Estado da tela (ctx.state, salvo por dispositivo):
//   filters  filtros da barra (shared/filterbar.js)
//   open     exceções de expansão sobre o padrão { 'p:<id>' | 'd:<id>' | 't:<id>' | 'g:none' | 'g:loose': bool }
//   fopen    o mesmo, enquanto há filtro ativo (zerado quando os filtros mudam)
//   level    último atalho de nível escolhido ('projects' | 'demands' | 'tasks' | 'all'), ou null
//   adding   chave do nó com a criação em linha aberta, ou null
//   focus    chave da linha que recebe o Tab (tabindex móvel)
//   limit    linhas desenhadas (páginas de ROW_LIMIT, "Mostrar mais"); null = primeira página
//
// Teclado (na árvore): ↑/↓ mudam de linha; → expande ou vai ao primeiro filho; ← recolhe ou vai ao pai;
// Home/End; Enter abre o painel (projetos e grupos: expande/recolhe); os atalhos da casca (C, 1–4, S, D, O,
// T, Delete) agem sobre a linha focada.

import { cx, h } from '../../core/dom.js';
import { plural } from '../../core/format.js';
import { defaultFilters } from '../../domain/filters.js';
import { button, iconButton, segmented } from '../kit/controls.js';
import { emptyState, progressBar } from '../kit/display.js';
import { icon } from '../kit/icons.js';
import { openProjectMenu } from '../projects.js';
import { demandRow, projectDot, quickAddRow, taskRow } from '../shared/entity.js';
import { filterBar, normalizeFilters } from '../shared/filterbar.js';
import {
  LEVELS,
  ROW_LIMIT,
  buildModel,
  defaultOpen,
  expansionOf,
  flattenTree,
  levelOverrides,
  plainObject,
  pruneOverrides,
} from './hierarquia/model.js';
import { demandDnd, demandTaskDrop, looseDrop, noProjectDrop, projectDrop, taskDnd } from './hierarquia/moves.js';

/** Elementos que tratam o próprio clique dentro de uma linha de projeto/grupo. */
const INTERACTIVE = 'button, a, input, textarea, select, label, [data-stop]';

/** Espera (ms) para gravar no estado a linha focada. */
const FOCUS_SAVE_DELAY = 300;
let focusTimer = 0;

/** Linhas que são itens da árvore (navegáveis pelo teclado). */
const NODE_KINDS = new Set(['project', 'group', 'demand', 'task', 'subtask']);

const LEVEL_OPTIONS = Object.freeze([
  Object.freeze({ value: 'projects', label: 'Projetos', title: 'Mostrar só os projetos' }),
  Object.freeze({ value: 'demands', label: 'Demandas', title: 'Abrir até as demandas' }),
  Object.freeze({ value: 'tasks', label: 'Tarefas', title: 'Abrir até as tarefas (subtarefas recolhidas)' }),
  Object.freeze({ value: 'all', label: 'Tudo', title: 'Abrir tudo, inclusive as subtarefas' }),
]);

/** Tipo de nó (para o padrão de expansão) a partir da chave. */
function kindOfKey(key) {
  if (key.startsWith('p:')) return 'project';
  if (key.startsWith('d:')) return 'demand';
  if (key.startsWith('t:')) return 'task';
  return 'group';
}

const idOfKey = (key) => (typeof key === 'string' && key.length > 2 ? key.slice(2) : null);

function cssEscape(value) {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

/** Põe o tabindex móvel (0 na linha ativa, -1 nas demais) — roda também depois de cada morph. */
function rovingRef(active) {
  return (el) => {
    const value = active ? '0' : '-1';
    if (el.getAttribute('tabindex') !== value) el.setAttribute('tabindex', value);
  };
}

/** Foca uma linha da árvore e a traz para a área visível. */
function focusRow(el) {
  if (!el) return;
  el.setAttribute('tabindex', '0');
  el.focus({ preventScroll: true });
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Ações da tela (fecham sobre o estado do render atual)
// ---------------------------------------------------------------------------

function createApi(app, ctx, model, state) {
  const filterMode = model.active;
  const compact = model.compact === true;
  const field = filterMode ? 'fopen' : 'open';
  const adding = typeof state.adding === 'string' && state.adding ? state.adding : null;

  /** Grava a exceção de expansão de um nó (descartando chaves de itens que sumiram). */
  const expansionPatch = (key, value) => {
    const next = pruneOverrides(app, state[field], filterMode, compact);
    if (value === defaultOpen(kindOfKey(key), filterMode, compact)) delete next[key];
    else next[key] = value;
    return { [field]: next, level: null };
  };

  return {
    filterMode,
    toggle(row) {
      if (!row.expandable) return;
      const patch = expansionPatch(row.key, !row.expanded);
      if (row.expanded && adding === row.key) patch.adding = null;
      ctx.setState(patch);
    },
    /** Abre a criação em linha sob o nó (e o expande). */
    startAdding(key) {
      ctx.setState({ ...expansionPatch(key, true), adding: key });
    },
    /** Fecha a criação em linha; `focusFrom` = elemento dentro da árvore para devolver o foco ao nó pai. */
    stopAdding(key, focusFrom) {
      if (focusFrom && typeof focusFrom.closest === 'function') {
        const tree = focusFrom.closest('.hq-tree');
        const parent = tree ? tree.querySelector(`[data-node="${cssEscape(key)}"]`) : null;
        if (parent) focusRow(parent);
      }
      if (state.adding) ctx.setState({ adding: null });
    },
    applyLevel(level) {
      if (!LEVELS.includes(level)) return;
      ctx.setState({ [field]: levelOverrides(model, level), level, adding: null, limit: null });
    },
    setFilters(next) {
      ctx.setState({ filters: next, fopen: {}, adding: null, limit: null });
    },
    clearFilters() {
      ctx.setState({ filters: defaultFilters(), fopen: {}, adding: null, limit: null });
    },
    /** Desenha mais uma página de linhas (a árvore grande é desenhada aos poucos). */
    showMore(current) {
      ctx.setState({ limit: current + ROW_LIMIT });
    },
    /**
     * Linha que recebe o Tab. O tabindex é trocado na hora, no próprio DOM; o estado é gravado um instante
     * depois (uma renderização só, mesmo quando o usuário percorre muitas linhas com as setas).
     */
    setFocus(key, el) {
      if (!key) return;
      const tree = el && typeof el.closest === 'function' ? el.closest('.hq-tree') : null;
      if (tree) {
        for (const other of tree.querySelectorAll('[data-node][tabindex="0"]')) if (other !== el) other.setAttribute('tabindex', '-1');
        el.setAttribute('tabindex', '0');
      }
      clearTimeout(focusTimer);
      if (key === state.focus) return;
      focusTimer = setTimeout(() => ctx.setState({ focus: key }), FOCUS_SAVE_DELAY);
    },
  };
}

// ---------------------------------------------------------------------------
// Peças das linhas
// ---------------------------------------------------------------------------

/** Atributos de item de árvore (ARIA, chave, pai e tabindex móvel). */
function treeAttrs(row, { focusKey }) {
  return {
    role: 'treeitem',
    'aria-level': row.level,
    'aria-expanded': row.expandable || row.locked ? row.expanded : null,
    'aria-setsize': row.setsize || null,
    'aria-posinset': row.posinset || null,
    'data-node': row.key,
    'data-parent': row.parent || null,
    'data-kind': row.kind,
    ref: rovingRef(row.key === focusKey),
  };
}

/** Seta de expandir/recolher (fora da ordem de Tab: o teclado usa ← / →). */
function twisty(row, api, name) {
  if (!row.expandable) return h('span', { class: 'hq-twisty is-leaf', 'aria-hidden': 'true' });
  const label = `${row.expanded ? 'Recolher' : 'Expandir'}${name ? ` ${name}` : ''}`;
  return h(
    'button',
    {
      type: 'button',
      class: cx('hq-twisty', row.expanded && 'is-open'),
      tabindex: -1,
      'aria-label': label,
      title: row.expanded ? 'Recolher' : 'Expandir',
      'data-action': 'toggle',
      onclick: (ev) => {
        ev.stopPropagation();
        api.toggle(row);
      },
    },
    icon('chevron-right', { size: 14 }),
  );
}

/** Botão "+" do nó pai (aparece ao passar o ponteiro / no foco; sempre visível no toque). */
function addButton(row, api, title) {
  return iconButton({
    icon: 'plus',
    title,
    size: 'sm',
    class: 'hq-add',
    attrs: { 'data-action': 'add-child' },
    onclick: (ev) => {
      ev.stopPropagation();
      api.startAdding(row.key);
    },
  });
}

/** Espaço do tamanho do botão "+", para as colunas alinharem nas linhas sem ele. */
const addSpacer = () => h('span', { class: 'hq-add-spacer', 'aria-hidden': 'true' });

/** "4/6" tarefas concluídas de uma demanda (as mesmas contadas no progresso). */
function demandCount(app, demand) {
  const progress = app.sel.demandProgress(demand.id);
  const total = app.sel.topTasks(demand.id).length;
  if (!total) return h('span', { class: 'hq-count is-empty', title: 'Nenhuma tarefa' }, '');
  const text = progress.counted ? `${progress.completed}/${progress.counted}` : String(total);
  const title = progress.counted ? `${progress.completed} de ${plural(progress.counted, 'tarefa concluída', 'tarefas concluídas')}` : plural(total, 'tarefa', 'tarefas');
  return h('span', { class: 'hq-count tabular', title, 'aria-label': title }, icon('list', { size: 12 }), h('span', null, text));
}

/** Progresso agregado de um projeto (média das demandas). */
function projectProgressCell(app, project) {
  const progress = app.sel.projectProgress(project.id);
  const title = progress.percent === null ? 'Sem demandas com progresso medido' : `Progresso médio das ${plural(progress.counted, 'demanda', 'demandas')}: ${progress.percent}%`;
  return h(
    'span',
    { class: 'hq-progress', title },
    progressBar(progress.value, { size: 'sm', title }),
    progress.percent === null ? null : h('span', { class: 'hq-progress-pct tabular' }, `${progress.percent}%`),
  );
}

/** Clique no corpo de uma linha de projeto/grupo: expande/recolhe (controles tratam o próprio clique). */
function headerClick(row, api) {
  return (ev) => {
    const hit = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest(INTERACTIVE) : null;
    if (hit && ev.currentTarget.contains(hit)) return;
    api.toggle(row);
  };
}

// ---------------------------------------------------------------------------
// Linhas
// ---------------------------------------------------------------------------

function projectRow(app, row, api, view) {
  const project = row.entity;
  const name = project.name || 'Sem nome';
  const count = row.node.demands.length;
  return h(
    'div',
    {
      ...treeAttrs(row, view),
      ...projectDrop(app, project),
      key: row.key,
      class: cx('hq-row', 'hq-header', 'hq-project', project.archived_at && 'is-archived', row.locked && 'is-locked'),
      style: { '--en-indent': '0' },
      'data-project-id': project.id,
      'aria-label': `Projeto ${name}`,
      onclick: headerClick(row, api),
      oncontextmenu: (ev) => {
        ev.preventDefault();
        openProjectMenu(app, project.id, { x: ev.clientX, y: ev.clientY });
      },
    },
    twisty(row, api, name),
    projectDot(project),
    h('span', { class: 'hq-header-name' }, h('span', { class: 'hq-header-title truncate' }, name), project.code ? h('span', { class: 'hq-header-code' }, project.code) : null),
    h('span', { class: 'hq-header-meta tabular' }, plural(count, 'demanda', 'demandas')),
    h('span', { class: 'hq-spacer' }),
    projectProgressCell(app, project),
    addButton(row, api, `Adicionar demanda em ${name}`),
    iconButton({
      icon: 'more-horizontal',
      title: `Opções de ${name}`,
      size: 'sm',
      class: 'hq-menu',
      onclick: (ev) => {
        ev.stopPropagation();
        openProjectMenu(app, project.id, ev.currentTarget);
      },
    }),
  );
}

function groupRow(app, row, api, view) {
  const none = row.group === 'none';
  const name = none ? 'Sem projeto' : 'Tarefas avulsas';
  const count = row.node.length;
  return h(
    'div',
    {
      ...treeAttrs(row, view),
      ...(none ? noProjectDrop(app) : looseDrop(app)),
      key: row.key,
      class: cx('hq-row', 'hq-header', 'hq-group', `hq-group-${row.group}`),
      style: { '--en-indent': '0' },
      'aria-label': name,
      onclick: headerClick(row, api),
    },
    twisty(row, api, name),
    h('span', { class: 'hq-group-icon', 'aria-hidden': 'true' }, icon(none ? 'circle-dashed' : 'inbox', { size: 14 })),
    h('span', { class: 'hq-header-name' }, h('span', { class: 'hq-header-title truncate' }, name)),
    h('span', { class: 'hq-header-meta tabular' }, none ? plural(count, 'demanda', 'demandas') : plural(count, 'tarefa', 'tarefas')),
    h('span', { class: 'hq-spacer' }),
    addButton(row, api, none ? 'Adicionar demanda sem projeto' : 'Adicionar tarefa avulsa'),
  );
}

function demandTreeRow(app, row, api, view) {
  const demand = row.entity;
  // No celular o "+" sai da linha (ocuparia uma linha inteira): "Adicionar tarefa" fica no menu "…".
  const columns = [
    () => twisty(row, api, demand.name),
    'title',
    () => demandCount(app, demand),
    'progress',
    'status',
    'priority',
    'due',
    view.mobile ? null : () => addButton(row, api, 'Adicionar tarefa'),
    'menu',
  ].filter(Boolean);
  const el = demandRow(app, demand, {
    columns,
    showNextAction: true,
    class: cx('hq-row', 'hq-demand', !row.matched && 'hq-context', view.selected === `demand:${demand.id}` && 'is-selected'),
    attrs: {
      ...treeAttrs(row, view),
      ...demandDnd(app, demand),
      style: { '--en-indent': String(row.level - 1) },
    },
  });
  // O envoltório recebe as TAREFAS soltas sobre a demanda; a linha recebe as DEMANDAS (reordenar).
  return h('div', { key: `w:${demand.id}`, class: 'hq-dwrap', role: 'none', ...demandTaskDrop(app, demand) }, el);
}

function taskTreeRow(app, row, api, view) {
  const task = row.entity;
  const sub = row.kind === 'subtask';
  const parentKey = row.parent || '';
  const demand = app.sel.demandOf(task);
  const where = sub
    ? { topLevel: false, parentId: idOfKey(parentKey), demandId: demand ? demand.id : null }
    : { topLevel: true, parentId: null, demandId: parentKey.startsWith('d:') ? idOfKey(parentKey) : null };
  const columns = [
    () => twisty(row, api, task.name),
    'check',
    'title',
    'flags',
    app.sel.timerOf(task.id) ? 'timer' : null,
    'status',
    'priority',
    'due',
    view.mobile ? null : () => (sub ? addSpacer() : addButton(row, api, 'Adicionar subtarefa')),
    'menu',
  ].filter(Boolean);
  return taskRow(app, task, {
    columns,
    indent: row.level - 1,
    class: cx('hq-row', 'hq-task', sub && 'hq-subtask', !row.matched && 'hq-context', view.selected === `task:${task.id}` && 'is-selected'),
    attrs: { ...treeAttrs(row, view), ...taskDnd(app, task, where) },
  });
}

function addRow(app, row, api) {
  const placeholder = row.addType === 'demand' ? 'Nome da nova demanda' : row.defaults && row.defaults.parent_id ? 'Nome da nova subtarefa' : 'Nome da nova tarefa';
  return h(
    'div',
    {
      key: row.key,
      class: 'hq-addrow',
      role: 'none',
      style: { '--en-indent': String(row.level - 1) },
      'data-add-for': row.parent,
      onkeydown: (ev) => {
        if (ev.key !== 'Escape' || ev.defaultPrevented) return;
        ev.preventDefault();
        ev.stopPropagation();
        api.stopAdding(row.parent, ev.currentTarget);
      },
      onfocusout: (ev) => {
        const wrap = ev.currentTarget;
        const to = ev.relatedTarget;
        if (to instanceof Node && wrap.contains(to)) return;
        const input = wrap.querySelector('input');
        if (input && input.value.trim() === '') api.stopAdding(row.parent, null);
      },
      ref: (el) => {
        if (!el.isConnected || el.__hqFocused) return;
        el.__hqFocused = true;
        const input = el.querySelector('input');
        if (input) input.focus({ preventScroll: false });
      },
    },
    quickAddRow(app, { type: row.addType, defaults: row.defaults, placeholder }),
    iconButton({ icon: 'x', title: 'Cancelar', size: 'sm', class: 'hq-addrow-close', onclick: (ev) => api.stopAdding(row.parent, ev.currentTarget) }),
  );
}

function hintRow(row, api) {
  return h(
    'div',
    { key: row.key, class: 'hq-hint', role: 'none', style: { '--en-indent': String(row.level - 1) } },
    h('span', { class: 'hq-hint-text' }, row.text),
    button({ label: row.action, icon: 'plus', size: 'sm', variant: 'ghost', class: 'hq-hint-action', onclick: () => api.startAdding(row.addKey) }),
  );
}

/** Fim da página desenhada: quantas linhas faltam e o botão que desenha mais uma página. */
function moreRow(shown, hidden, api) {
  const next = Math.min(ROW_LIMIT, hidden);
  return h(
    'div',
    { key: 'hq-more', class: 'hq-more', role: 'none', 'data-more': String(hidden) },
    h('span', { class: 'hq-more-text' }, `${plural(hidden, 'linha não exibida', 'linhas não exibidas')} — recolha níveis ou use os filtros para encurtar a árvore.`),
    button({ label: `Mostrar mais ${next}`, icon: 'chevron-down', size: 'sm', variant: 'ghost', class: 'hq-more-action', attrs: { 'data-action': 'show-more' }, onclick: () => api.showMore(shown) }),
  );
}

function renderRow(app, row, api, view) {
  switch (row.kind) {
    case 'project':
      return projectRow(app, row, api, view);
    case 'group':
      return groupRow(app, row, api, view);
    case 'demand':
      return demandTreeRow(app, row, api, view);
    case 'task':
    case 'subtask':
      return taskTreeRow(app, row, api, view);
    case 'add':
      return addRow(app, row, api);
    case 'hint':
      return hintRow(row, api);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Teclado
// ---------------------------------------------------------------------------

function treeKeydown(ev, rowsByKey, api) {
  if (ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  const el = ev.target;
  if (!(el instanceof Element) || !el.hasAttribute('data-node')) return; // só com o foco na própria linha
  const key = el.getAttribute('data-node');
  const row = rowsByKey.get(key);
  if (!row) return;
  const tree = ev.currentTarget;
  const all = [...tree.querySelectorAll('[data-node]')];
  const index = all.indexOf(el);
  const byKey = (k) => all.find((node) => node.getAttribute('data-node') === k) || null;
  let handled = true;
  switch (ev.key) {
    case 'ArrowDown':
      focusRow(all[index + 1]);
      break;
    case 'ArrowUp':
      focusRow(all[index - 1]);
      break;
    case 'Home':
      focusRow(all[0]);
      break;
    case 'End':
      focusRow(all[all.length - 1]);
      break;
    case 'ArrowRight':
      if (row.expandable && !row.expanded) api.toggle(row);
      else if (row.expanded) focusRow(all.find((node) => node.getAttribute('data-parent') === key) || null);
      break;
    case 'ArrowLeft':
      if (row.expandable && row.expanded) api.toggle(row);
      else if (row.parent) focusRow(byKey(row.parent));
      break;
    case 'Enter':
    case ' ':
      // demandas e tarefas: a linha padrão já abre o painel (e marca o evento); aqui só projetos e grupos
      if (row.kind === 'project' || row.kind === 'group') api.toggle(row);
      else handled = false;
      break;
    default:
      handled = false;
  }
  if (handled) {
    ev.preventDefault();
    ev.stopPropagation();
  }
}

// ---------------------------------------------------------------------------
// Barra de ferramentas e estados vazios
// ---------------------------------------------------------------------------

function toolbar(model, state, api) {
  const scoped = !!model.scope;
  const options = LEVEL_OPTIONS.filter((option) => !(scoped && option.value === 'projects'));
  const level = options.some((option) => option.value === state.level) ? state.level : null;
  return h(
    'div',
    { class: 'hq-toolbar', role: 'toolbar', 'aria-label': 'Expandir e recolher a árvore' },
    h('span', { class: 'hq-toolbar-label', 'aria-hidden': 'true' }, 'Nível'),
    segmented({ options, value: level, size: 'sm', ariaLabel: 'Abrir a árvore até o nível', class: 'hq-levels', onchange: (value) => api.applyLevel(value) }),
    h('span', { class: 'hq-spacer' }),
    button({ label: 'Expandir tudo', icon: 'chevron-down', size: 'sm', variant: 'ghost', title: 'Expandir tudo', ariaLabel: 'Expandir tudo', class: 'hq-expand-all', attrs: { 'data-action': 'expand-all' }, onclick: () => api.applyLevel('all') }),
    button({ label: 'Recolher tudo', icon: 'chevron-up', size: 'sm', variant: 'ghost', title: 'Recolher tudo', ariaLabel: 'Recolher tudo', class: 'hq-collapse-all', attrs: { 'data-action': 'collapse-all' }, onclick: () => api.applyLevel(scoped ? 'demands' : 'projects') }),
  );
}

function emptyBody(app, model, api) {
  if (!model.hasAnything) {
    return emptyState({
      icon: 'tree',
      title: 'Nada na hierarquia ainda',
      text: 'Crie um projeto e as demandas dele: tarefas e subtarefas aparecem aqui, em árvore, com o progresso de cada nível.',
      action: [
        button({ label: 'Nova demanda', icon: 'plus', variant: 'primary', size: 'sm', attrs: { 'data-action': 'new-demand' }, onclick: () => app.ui && app.ui.quickCreate('demand') }),
        button({ label: 'Novo projeto', icon: 'folder', size: 'sm', attrs: { 'data-action': 'new-project' }, onclick: () => app.ui && app.ui.createProject() }),
      ],
      class: 'hq-empty',
    });
  }
  if (model.active) {
    return emptyState({
      icon: 'search',
      title: 'Nada corresponde aos filtros',
      text: 'Nenhuma demanda ou tarefa passa na busca e nos filtros atuais.',
      action: button({ label: 'Limpar filtros', icon: 'x', size: 'sm', attrs: { 'data-action': 'clear-filters' }, onclick: () => api.clearFilters() }),
      class: 'hq-empty',
    });
  }
  return emptyState({
    icon: 'tree',
    title: 'Nada para mostrar',
    text: 'Os itens existentes estão cancelados ou arquivados — use “Exibir” para vê-los, ou crie uma demanda.',
    action: button({ label: 'Nova demanda', icon: 'plus', variant: 'primary', size: 'sm', onclick: () => app.ui && app.ui.quickCreate('demand') }),
    class: 'hq-empty',
  });
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

function renderView(app, ctx) {
  const state = plainObject(ctx.state);
  const filters = normalizeFilters(state.filters);
  const model = buildModel(app, filters);
  const adding = typeof state.adding === 'string' && state.adding ? state.adding : null;
  const allRows = flattenTree(model, { isExpanded: expansionOf(model, state), adding });
  const api = createApi(app, ctx, model, state);

  // Desenha no máximo `limit` linhas (páginas de ROW_LIMIT): cada linha custa dezenas de elementos e a tela é
  // redesenhada a cada mudança. A linha de criação em linha aberta sempre entra.
  const limit = Number.isInteger(state.limit) && state.limit > ROW_LIMIT ? state.limit : ROW_LIMIT;
  let cut = Math.min(allRows.length, limit);
  if (adding) {
    const at = allRows.findIndex((row) => row.kind === 'add');
    if (at >= cut) cut = at + 1;
  }
  const rows = cut < allRows.length ? allRows.slice(0, cut) : allRows;
  const hidden = allRows.length - rows.length;

  const rowsByKey = new Map();
  for (const row of rows) if (NODE_KINDS.has(row.kind)) rowsByKey.set(row.key, row);
  const firstKey = rowsByKey.size ? rowsByKey.keys().next().value : null;
  const focusKey = typeof state.focus === 'string' && rowsByKey.has(state.focus) ? state.focus : firstKey;
  const panel = app.ui && typeof app.ui.panel === 'function' ? app.ui.panel() : null;
  const selected = panel ? `${panel.type}:${panel.id}` : null;

  const bar = filterBar(app, {
    filters,
    onchange: (next) => api.setFilters(next),
    type: 'task',
    count: { shown: model.shown, total: model.total },
  });

  const body = rows.length
    ? h(
        'div',
        {
          class: cx('hq-tree', model.active && 'is-filtered'),
          role: 'tree',
          'aria-label': 'Hierarquia: projetos, demandas, tarefas e subtarefas',
          onkeydown: (ev) => treeKeydown(ev, rowsByKey, api),
          onfocusin: (ev) => {
            const el = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[data-node]') : null;
            if (el) api.setFocus(el.getAttribute('data-node'), el);
          },
        },
        rows.map((row) => renderRow(app, row, api, { focusKey, mobile: !!ctx.isMobile, selected })),
        hidden > 0 ? moreRow(rows.length, hidden, api) : null,
      )
    : emptyBody(app, model, api);

  return h(
    'div',
    { class: cx('v-hierarquia', ctx.isMobile && 'is-mobile'), 'data-filtered': model.active ? 'true' : null },
    model.hasAnything ? h('div', { class: 'hq-head' }, bar, toolbar(model, state, api)) : null,
    body,
  );
}

export default {
  id: 'hierarquia',
  path: '/hierarquia',
  title: 'Hierarquia',
  icon: 'tree',
  order: 60,
  section: 'views',

  /** Ao entrar, a criação em linha que ficou aberta de outra visita é descartada e a árvore volta à 1ª página. */
  onEnter(app, ctx) {
    if (ctx && ctx.state && (ctx.state.adding || ctx.state.limit)) ctx.setState({ adding: null, limit: null });
  },

  /** Ao sair, descarta a gravação pendente da linha focada (o foco já não está nesta tela). */
  onLeave() {
    clearTimeout(focusTimer);
  },

  render(app, ctx) {
    return renderView(app, ctx);
  },
};
