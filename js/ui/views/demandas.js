// Visualização "Demandas" — lista (seção 10.1 do pedido) com edição rápida.
//
// Dois modos (controle segmentado, guardado em ctx.state.mode):
//   • Demandas — tabela com Nome, Projeto, Prioridade, Status, Prazo, Progresso, Próxima ação e Responsável;
//     ordenação pelos cabeçalhos, agrupamento opcional, linhas que expandem para mostrar as tarefas da
//     demanda, criação rápida no fim e reordenação manual por arrasto (views/demandas/demand-table.js);
//   • Tarefas — tabela plana de tarefas, ordenada por prioridade e prazo, com filtros, agrupamento e a opção
//     "Incluir subtarefas" (views/demandas/task-table.js).
// No celular (ou com pouco espaço) as linhas viram cartões de duas linhas, os cabeçalhos somem e a ordenação
// e o agrupamento vão para um menu.
//
// Estado da tela (ctx.state, salvo por dispositivo): mode, dFilters/dSort/dGroup/dCollapsed, expanded,
// tFilters/tSort/tGroup/tCollapsed, withSubtasks e editing (nome em edição; zerado ao entrar na tela).

import { cx, h } from '../../core/dom.js';
import { formatNumber, plural } from '../../core/format.js';
import { defaultFilters } from '../../domain/filters.js';
import { button, iconButton, segmented, switchInput } from '../kit/controls.js';
import { emptyState } from '../kit/display.js';
import { openMenu } from '../kit/overlays.js';
import { applyViewFilters, filterBar, normalizeFilters, sortViewItems } from '../shared/filterbar.js';
import { notify, quickAddRow } from '../shared/entity.js';
import { DEFAULT_SORTS, GROUPS, SORT_KEYS, SORT_TEXT, STATE_KEYS, TASK_PAGE, readState, scopeProjectId } from './demandas/common.js';
import { demandTable } from './demandas/demand-table.js';
import { taskTable } from './demandas/task-table.js';

const NOUNS = Object.freeze({
  demands: Object.freeze({ type: 'demand', one: 'demanda', many: 'demandas' }),
  tasks: Object.freeze({ type: 'task', one: 'tarefa', many: 'tarefas' }),
});

/**
 * Itens do modo (já filtrados e ordenados) e os números do resumo.
 * @returns {{ rows: object[], total: number, overdue: number, noDue: number }}
 */
function modelOf(app, mode, view, withSubtasks) {
  const { sel } = app;
  const type = NOUNS[mode].type;
  let base = mode === 'demands' ? sel.demands({ includeArchived: true }) : sel.tasks({ includeArchived: true });
  if (mode === 'tasks' && !withSubtasks) base = base.filter((task) => !sel.parentOf(task));
  const shown = applyViewFilters(app, base, view.filters, type);
  // Total = o que existe no escopo com as mesmas opções de "Exibir" (só os filtros de busca ficam de fora).
  const f = view.filters;
  const total = applyViewFilters(app, base, { ...defaultFilters(), showDone: true, showCancelled: f.showCancelled, showArchived: f.showArchived }, type).length;
  let overdue = 0;
  let noDue = 0;
  for (const item of shown) {
    const info = sel.deadline(item);
    if (info.state === 'overdue') overdue += 1;
    else if (info.state === 'no_due') noDue += 1;
  }
  return { rows: sortViewItems(app, shown, view.sort, type), total, overdue, noDue };
}

/** Depois de criar pela linha do fim: avisa quando os filtros da tela escondem o item novo. */
function afterQuickCreate(app, noun, filters, row) {
  if (!row || !row.id) return;
  const fresh = noun.type === 'task' ? app.sel.task(row.id) : app.sel.demand(row.id);
  if (!fresh || applyViewFilters(app, [fresh], filters, noun.type).length) return;
  const label = noun.one.charAt(0).toUpperCase() + noun.one.slice(1);
  notify(app, `${label} criada, mas os filtros atuais a escondem da lista.`, {
    action: { label: 'Abrir', onclick: () => app.ui.openPanel(noun.type, row.id) },
  });
}

/** Botões-resumo "3 atrasadas" / "5 sem prazo" (clicar filtra por aquela faixa de prazo). */
function counters(model, view, mode, onfilter) {
  const noun = NOUNS[mode];
  const chip = (id, n, text, tone) => {
    const active = view.filters.deadline === id;
    if (!n && !active) return null;
    return h(
      'button',
      {
        type: 'button',
        key: `counter-${id}`,
        class: cx('v-dm-counter', `is-${tone}`, active && 'is-active'),
        'data-counter': id,
        'aria-pressed': active,
        title: active ? 'Mostrar todos os prazos' : `Mostrar só as ${noun.many} ${id === 'overdue' ? 'atrasadas' : 'sem prazo'}`,
        onclick: () => onfilter({ ...view.filters, deadline: active ? null : id }),
      },
      h('span', { class: 'v-dm-counter-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'tabular' }, formatNumber(n)),
      ` ${text}`,
    );
  };
  return [
    chip('overdue', model.overdue, model.overdue === 1 ? 'atrasada' : 'atrasadas', 'danger'),
    chip('no_due', model.noDue, 'sem prazo', 'muted'),
  ];
}

/** Menu "Agrupar por". */
function openGroupMenu(anchor, mode, view, onchange) {
  openMenu(
    anchor,
    GROUPS[mode].map((g) => ({ label: g.label, checked: view.group === g.id, onclick: () => onchange(g.id) })),
    { title: 'Agrupar por', minWidth: 200, align: 'end', class: 'v-dm-menu' },
  );
}

/** Menu do celular / espaço estreito: ordenação, direção, agrupamento (e subtarefas, no modo Tarefas). */
function openSortMenu(anchor, mode, view, { onsort, ongroup, withSubtasks, onsubtasks }) {
  const items = [
    { heading: 'Ordenar por' },
    ...SORT_KEYS[mode].map((key) => ({ label: SORT_TEXT[key], checked: view.sort.key === key, onclick: () => onsort({ key, dir: view.sort.key === key ? view.sort.dir : 'asc' }) })),
    { separator: true },
    { label: 'Crescente', icon: 'arrow-up', checked: view.sort.dir === 'asc', disabled: view.sort.key === 'manual', onclick: () => onsort({ ...view.sort, dir: 'asc' }) },
    { label: 'Decrescente', icon: 'arrow-down', checked: view.sort.dir === 'desc', disabled: view.sort.key === 'manual', onclick: () => onsort({ ...view.sort, dir: 'desc' }) },
    { separator: true },
    { heading: 'Agrupar por' },
    ...GROUPS[mode].map((g) => ({ label: g.label, checked: view.group === g.id, onclick: () => ongroup(g.id) })),
  ];
  if (mode === 'tasks') items.push({ separator: true }, { label: 'Incluir subtarefas', checked: withSubtasks, onclick: () => onsubtasks(!withSubtasks) });
  openMenu(anchor, items, { title: 'Ordenar e agrupar', minWidth: 220, align: 'end', class: 'v-dm-menu' });
}

/** Estado vazio: nada cadastrado × nada corresponde aos filtros. */
function emptyView(app, mode, model, { onclear }) {
  const noun = NOUNS[mode];
  if (model.total === 0) {
    const scoped = scopeProjectId(app);
    const project = scoped ? app.sel.project(scoped) : null;
    return emptyState({
      icon: mode === 'demands' ? 'list' : 'check-circle',
      title: mode === 'demands' ? 'Nenhuma demanda ainda' : 'Nenhuma tarefa ainda',
      text:
        mode === 'demands'
          ? project
            ? `O projeto ${project.name} ainda não tem demandas. Crie a primeira para organizar as tarefas.`
            : 'Crie a primeira demanda para organizar suas tarefas, prazos e próximas ações.'
          : 'As tarefas das suas demandas aparecem aqui, ordenadas por prioridade e prazo.',
      action: button({
        label: mode === 'demands' ? 'Nova demanda' : 'Nova tarefa',
        icon: 'plus',
        variant: 'primary',
        attrs: { 'data-action': 'create' },
        onclick: () => app.ui.quickCreate(noun.type, mode === 'demands' && scoped ? { project_id: scoped } : undefined),
      }),
      class: 'v-dm-empty',
    });
  }
  return emptyState({
    icon: 'search',
    title: `Nenhuma ${noun.one} corresponde aos filtros`,
    text: `Há ${plural(model.total, noun.one, noun.many)} no total. Ajuste a busca ou limpe os filtros para ver tudo.`,
    action: button({ label: 'Limpar filtros', icon: 'x', attrs: { 'data-action': 'clear-filters' }, onclick: onclear }),
    class: 'v-dm-empty',
  });
}

export default {
  id: 'demandas',
  path: '/demandas',
  title: 'Demandas',
  icon: 'list',
  order: 30,
  section: 'main',

  /**
   * Ao entrar na tela, nenhuma edição de nome fica pendurada de uma visita anterior. Links de outras telas
   * (ex.: Início › Atrasadas › "Ver na lista") chegam com ?deadline=…[&mode=tasks|demands]: o modo pedido abre
   * com os filtros padrão mais essa faixa de prazo, para mostrar exatamente aqueles itens.
   */
  onEnter(app, ctx) {
    if (!ctx) return;
    const state = ctx.state || {};
    const params = ctx.params || {};
    const patch = {};
    if (state.editing) patch.editing = null;
    if (state.tLimit !== undefined && state.tLimit !== null) patch.tLimit = null; // "Mostrar mais" recomeça da 1ª página
    const deadline = params.deadline ? normalizeFilters({ deadline: params.deadline }).deadline : null;
    if (deadline) {
      const mode = params.mode === 'demands' ? 'demands' : params.mode === 'tasks' ? 'tasks' : readState(state).mode;
      const base = mode === 'tasks' ? { ...defaultFilters(), showDone: false } : defaultFilters();
      patch.mode = mode;
      patch[STATE_KEYS[mode].filters] = { ...base, deadline };
      if (mode === 'tasks') patch.withSubtasks = true;
    }
    if (Object.keys(patch).length) ctx.setState(patch);
  },

  /**
   * @param {object} app
   * @param {{ state: object, setState: Function, params: object, isMobile: boolean }} ctx
   * @returns {HTMLElement}
   */
  render(app, ctx) {
    const st = readState(ctx.state);
    const mode = st.mode;
    const view = st[mode];
    const keys = STATE_KEYS[mode];
    const noun = NOUNS[mode];
    const withSubtasks = st.tasks.withSubtasks;
    const model = modelOf(app, mode, view, withSubtasks);
    const scoped = scopeProjectId(app);

    const setFilters = (next) => ctx.setState({ [keys.filters]: next });
    const setSort = (next) => ctx.setState({ [keys.sort]: next });
    const setGroup = (next) => ctx.setState({ [keys.group]: next });
    const setSubtasks = (value) => ctx.setState({ withSubtasks: !!value });
    const clearFilters = () => setFilters(defaultFilters());
    const groupLabel = GROUPS[mode].find((g) => g.id === view.group).label;
    const sortLabel = SORT_TEXT[view.sort.key] || SORT_TEXT[DEFAULT_SORTS[mode].key];

    const toolbar = h(
      'div',
      { key: 'toolbar', class: 'v-dm-toolbar' },
      segmented({
        value: mode,
        size: 'sm',
        ariaLabel: 'Mostrar',
        class: 'v-dm-mode',
        options: [
          { value: 'demands', label: 'Demandas', icon: 'layers' },
          { value: 'tasks', label: 'Tarefas', icon: 'check-circle' },
        ],
        onchange: (value) => ctx.setState({ mode: value, editing: null }),
      }),
      h('div', { class: 'v-dm-counters', role: 'group', 'aria-label': 'Resumo de prazos' }, counters(model, view, mode, setFilters)),
      h('span', { class: 'v-dm-spacer' }),
      mode === 'tasks'
        ? switchInput({ checked: withSubtasks, label: 'Incluir subtarefas', class: 'v-dm-subtasks-switch', onchange: setSubtasks })
        : null,
      button({
        label: view.group === 'none' ? 'Agrupar' : `Agrupar: ${groupLabel}`,
        icon: 'rows',
        iconRight: 'chevron-down',
        size: 'sm',
        variant: view.group === 'none' ? 'ghost' : 'subtle',
        class: 'v-dm-group-btn',
        attrs: { 'data-action': 'group', 'aria-haspopup': 'menu' },
        onclick: (ev) => openGroupMenu(ev.currentTarget, mode, view, setGroup),
      }),
      button({
        label: sortLabel,
        icon: 'sort',
        size: 'sm',
        class: 'v-dm-sort-btn',
        ariaLabel: `Ordenar e agrupar (ordenado por ${sortLabel.toLowerCase()})`,
        attrs: { 'data-action': 'sort-menu', 'aria-haspopup': 'menu' },
        onclick: (ev) => openSortMenu(ev.currentTarget, mode, view, { onsort: setSort, ongroup: setGroup, withSubtasks, onsubtasks: setSubtasks }),
      }),
    );

    const bar = h(
      'div',
      { key: `fb-${mode}`, class: 'v-dm-filters' },
      filterBar(app, {
        filters: view.filters,
        onchange: setFilters,
        type: noun.type,
        count: { shown: model.rows.length, total: model.total },
      }),
    );

    // Item aberto no painel lateral: a linha dele fica destacada.
    const panel = app.ui && typeof app.ui.panel === 'function' ? app.ui.panel() : null;
    const selected = panel ? `${panel.type}:${panel.id}` : null;

    let content;
    if (model.rows.length === 0) {
      content = emptyView(app, mode, model, { onclear: clearFilters });
    } else if (mode === 'demands') {
      content = demandTable(app, ctx, { rows: model.rows, view, expanded: st.expanded, editing: st.editing, selected, onsort: setSort });
    } else {
      content = taskTable(app, ctx, {
        rows: model.rows,
        view,
        editing: st.editing,
        selected,
        onsort: setSort,
        limit: view.limit,
        page: TASK_PAGE,
        onmore: () => ctx.setState({ tLimit: view.limit + TASK_PAGE }),
      });
    }

    // Item criado pela linha do fim que os filtros atuais escondem: avisa (com "Abrir"), como no Kanban.
    const onCreated = (row) => afterQuickCreate(app, noun, view.filters, row);
    const add =
      mode === 'demands'
        ? quickAddRow(app, {
            type: 'demand',
            defaults: scoped ? { project_id: scoped } : {},
            placeholder: 'Adicionar demanda',
            class: 'v-dm-quickadd',
            onCreated,
          })
        : scoped
          ? null
          : quickAddRow(app, { type: 'task', placeholder: 'Adicionar tarefa avulsa', class: 'v-dm-quickadd', onCreated });

    return h(
      'div',
      { class: cx('v-demandas', `is-${mode}`, ctx.isMobile && 'is-mobile'), 'data-mode': mode },
      toolbar,
      bar,
      h('div', { key: `content-${mode}`, class: 'v-dm-content' }, content, add ? h('div', { key: 'add', class: 'v-dm-add' }, add) : null),
    );
  },
};
