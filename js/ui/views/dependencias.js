// Visualização "Dependências" (seção 6 do pedido): diagrama das tarefas e das ligações "depende de", com a
// cadeia realçada, conflitos de prazo, ciclos vindos da sincronização, criação/remoção de dependências e um
// modo Lista (padrão no celular).
//
// Estado da tela (ctx.state, salvo por dispositivo):
//   mode 'diagram' | 'list'      demandId null | id | '__none'     hideDone, showIsolated
//   zoom null (ajustar) | número  selectedId, hoverId               linking, linkFrom, linkError
//   focusSeen: último parâmetro de rota `focus` já tratado (o link "Ver no diagrama" do painel)
//
// Módulos auxiliares: dependencias/model.js (dados), diagram.js (SVG), actions.js (escritas e diálogos),
// panels.js (detalhes, conflitos, ciclos, legenda e lista).

import { cx, h } from '../../core/dom.js';
import { plural } from '../../core/format.js';
import { button, segmented, switchInput } from '../kit/controls.js';
import { emptyState } from '../kit/display.js';
import { pickFromList } from '../kit/pickers.js';
import { notify } from '../shared/entity.js';
import { createDependency, openEdgePopover, openNewDependency } from './dependencias/actions.js';
import { clearScrollRequest, measuredScale, nextZoom, renderDiagram, requestScroll } from './dependencias/diagram.js';
import { DEMAND_ALL, DEMAND_NONE, buildModel, listEntries, normalizeDemandFilter, taskName } from './dependencias/model.js';
import { conflictsCard, cyclesBanner, detailsCard, legendCard, renderList } from './dependencias/panels.js';

/** Último `focus` da rota para o qual já pedimos a rolagem (evita rolar de novo a cada desenho). */
let scrolledFocus = null;
/** Um arraste do fundo acabou de acontecer: o clique que vem junto não limpa a seleção. */
let suppressBackgroundClick = false;

/** Arraste com o mouse no fundo do diagrama para mover a área visível. */
function panStart(ev) {
  if (ev.button !== 0 || ev.pointerType !== 'mouse') return;
  if (ev.target.closest('.v-dependencias-node, .v-dependencias-edge, button')) return;
  const scroller = ev.currentTarget;
  const start = { x: ev.clientX, y: ev.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
  let moved = false;
  const win = scroller.ownerDocument.defaultView;
  const move = (e) => {
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    moved = true;
    scroller.classList.add('is-panning');
    scroller.scrollLeft = start.left - dx;
    scroller.scrollTop = start.top - dy;
  };
  const up = () => {
    win.removeEventListener('pointermove', move);
    win.removeEventListener('pointerup', up);
    win.removeEventListener('pointercancel', up);
    scroller.classList.remove('is-panning');
    if (moved) {
      suppressBackgroundClick = true;
      win.setTimeout(() => (suppressBackgroundClick = false), 0);
    }
  };
  win.addEventListener('pointermove', move);
  win.addEventListener('pointerup', up);
  win.addEventListener('pointercancel', up);
}

/** Vizinho mais próximo numa direção (setas do teclado entre os nós). */
function neighbourInDirection(model, id, key) {
  const from = model.position.get(id);
  if (!from) return null;
  let best = null;
  let bestScore = Infinity;
  for (const node of model.nodes) {
    if (node.id === id) continue;
    const dx = node.x - from.x;
    const dy = node.y - from.y;
    let primary;
    let secondary;
    if (key === 'ArrowRight') [primary, secondary] = [dx, dy];
    else if (key === 'ArrowLeft') [primary, secondary] = [-dx, dy];
    else if (key === 'ArrowDown') [primary, secondary] = [dy, dx];
    else [primary, secondary] = [-dy, dx];
    if (primary <= 0) continue;
    const score = primary + Math.abs(secondary) * 2;
    if (score < bestScore) {
      bestScore = score;
      best = node.id;
    }
  }
  return best;
}

function demandLabel(app, demandId) {
  if (demandId === DEMAND_NONE) return 'Sem demanda';
  if (demandId) {
    const demand = app.sel.demand(demandId);
    if (demand) return demand.name || 'Demanda sem nome';
  }
  return 'Todas as demandas';
}

async function pickDemand(app, anchor, current, projectId, onchange) {
  const demands = app.sel.demands(projectId ? { projectId } : undefined);
  const items = [
    { id: '__all', label: 'Todas as demandas', icon: 'layers' },
    { id: DEMAND_NONE, label: 'Sem demanda (tarefas avulsas)', icon: 'inbox' },
    ...demands.map((d) => ({ id: d.id, label: d.name || 'Demanda sem nome', hint: app.sel.code('demand', d), icon: 'layers' })),
  ];
  const chosen = await pickFromList(anchor, { items, current: current || '__all', placeholder: 'Buscar demanda…', title: 'Demanda', width: 320 });
  if (chosen === null) return;
  onchange(chosen === '__all' ? DEMAND_ALL : chosen);
}

function emptyView(app, model, { demandId, hideDone, mode, projectId, onNew, update }) {
  const project = projectId ? app.sel.project(projectId) : null;
  if (model.scopeEdgeCount > 0) {
    return emptyState({
      icon: 'check-circle',
      title: 'Nenhuma dependência em aberto',
      text: hideDone ? 'Todas as dependências deste filtro já foram concluídas. Mostre as concluídas para ver o histórico das ligações.' : 'Nada a mostrar com os filtros atuais.',
      action: [
        hideDone ? button({ label: 'Mostrar concluídas', icon: 'eye', onclick: () => update({ hideDone: false }), attrs: { 'data-action': 'show-done' } }) : null,
        button({ label: 'Nova dependência', icon: 'plus', variant: 'primary', onclick: onNew, attrs: { 'data-action': 'new-dependency' } }),
      ],
      class: 'v-dependencias-empty',
    });
  }
  if (demandId !== DEMAND_ALL) {
    return emptyState({
      icon: 'git-branch',
      title: demandId === DEMAND_NONE ? 'Nenhuma dependência entre tarefas avulsas' : 'Nenhuma dependência nesta demanda',
      text: `As tarefas de “${demandLabel(app, demandId)}” não têm dependências. Escolha outra demanda ou crie uma ligação.`,
      action: [
        button({ label: 'Ver todas as demandas', icon: 'layers', onclick: () => update({ demandId: DEMAND_ALL }), attrs: { 'data-action': 'clear-demand' } }),
        button({ label: 'Nova dependência', icon: 'plus', variant: 'primary', onclick: onNew, attrs: { 'data-action': 'new-dependency' } }),
      ],
      class: 'v-dependencias-empty',
    });
  }
  if (model.scopeTaskCount < 2) {
    return emptyState({
      icon: 'git-branch',
      title: 'Crie tarefas para ligá-las',
      text: 'Dependências ligam duas tarefas: uma só pode avançar depois que a outra (o pré-requisito) estiver pronta. Cadastre pelo menos duas tarefas para começar.',
      action: button({ label: 'Nova tarefa', icon: 'plus', variant: 'primary', onclick: () => app.ui.quickCreate('task'), attrs: { 'data-action': 'new-task' } }),
      class: 'v-dependencias-empty',
    });
  }
  return emptyState({
    icon: 'git-branch',
    title: project ? `Nenhuma dependência em ${project.name}` : 'Nenhuma dependência ainda',
    text: 'Dependências dizem o que precisa ficar pronto antes de outra tarefa avançar. Enquanto o pré-requisito estiver aberto, a tarefa aparece com cadeado de bloqueada, a cadeia fica visível aqui e os conflitos de prazo são apontados.',
    action: [
      mode === 'diagram' ? button({ label: 'Ligar no diagrama', icon: 'link', onclick: () => update({ showIsolated: true, linking: true, linkFrom: null, linkError: null }), attrs: { 'data-action': 'start-linking' } }) : null,
      button({ label: 'Nova dependência', icon: 'plus', variant: 'primary', onclick: onNew, attrs: { 'data-action': 'new-dependency' } }),
    ],
    class: 'v-dependencias-empty',
  });
}

export default {
  id: 'dependencias',
  path: '/dependencias',
  title: 'Dependências',
  icon: 'git-branch',
  order: 80,
  section: 'views',

  /** Ciclos de dependência (dados danificados) pedem atenção na navegação. */
  badge(app) {
    try {
      return app.sel.cycles().length;
    } catch {
      return 0;
    }
  },

  onEnter(app, ctx) {
    const patch = {};
    if (ctx.state.hoverId || ctx.state.linkFrom || ctx.state.linkError) Object.assign(patch, { hoverId: null, linkFrom: null, linkError: null });
    // Chegou de novo por "Ver no diagrama" da mesma tarefa: o foco vale outra vez.
    if (ctx.params.focus && ctx.state.focusSeen === ctx.params.focus) patch.focusSeen = null;
    if (Object.keys(patch).length) ctx.setState(patch);
  },

  onLeave() {
    scrolledFocus = null;
    clearScrollRequest();
  },

  render(app, ctx) {
    const { state, params, isMobile } = ctx;
    const projectId = (app.ui && app.ui.scope && app.ui.scope.projectId) || null;
    const demandId = normalizeDemandFilter(app, state.demandId);
    const hideDone = state.hideDone === true;
    const showIsolated = state.showIsolated === true;

    // Parâmetro de rota focus=<id> ("Ver no diagrama"): pré-seleciona e rola até a tarefa uma vez.
    const focusParam = typeof params.focus === 'string' && params.focus ? params.focus : null;
    const focusFresh = !!focusParam && focusParam !== state.focusSeen && !!app.sel.task(focusParam);
    if (!focusParam) scrolledFocus = null;
    if (focusFresh && scrolledFocus !== focusParam) {
      scrolledFocus = focusParam;
      requestScroll(focusParam);
    }
    const update = (patch) => ctx.setState(focusFresh ? { focusSeen: focusParam, ...patch } : patch);

    const mode = focusFresh ? 'diagram' : state.mode === 'list' || state.mode === 'diagram' ? state.mode : isMobile ? 'list' : 'diagram';
    const linking = mode === 'diagram' && state.linking === true;
    const zoom = typeof state.zoom === 'number' && state.zoom > 0 ? state.zoom : null;

    const model = buildModel(app, { demandId, hideDone, showIsolated, projectId, forceId: focusFresh ? focusParam : null });
    const selectedId = focusFresh ? focusParam : state.selectedId && model.byId.has(state.selectedId) ? state.selectedId : null;
    const hoverId = state.hoverId && model.position.has(state.hoverId) ? state.hoverId : null;
    const activeId = hoverId || (selectedId && model.position.has(selectedId) ? selectedId : null);
    const detailId = hoverId || selectedId;
    const linkFrom = linking && state.linkFrom && model.position.has(state.linkFrom) ? state.linkFrom : null;

    const select = (id, { scroll = false } = {}) => {
      if (scroll) requestScroll(id);
      update({ selectedId: id });
    };
    const openTask = (id) => app.ui.openPanel('task', id);
    const onNew = () =>
      openNewDependency(app, {
        taskId: selectedId,
        onCreated: (taskId) => {
          requestScroll(taskId);
          update({ selectedId: taskId });
        },
      });

    const finishLink = (dependentId) => {
      const result = createDependency(app, dependentId, linkFrom);
      if (result.ok) {
        update({ linkFrom: null, linkError: null, selectedId: dependentId });
      } else {
        notify(app, result.message, { tone: 'danger', duration: 7000 });
        update({ linkFrom: null, linkError: result.message });
      }
    };

    const handlers = {
      // Forma funcional: entrar e sair rápido antes do próximo desenho não deixa um realce preso.
      onHover: (id) => ctx.setState((prev) => (prev.hoverId === id ? null : { hoverId: id })),
      onHoverEnd: (id) => ctx.setState((prev) => (prev.hoverId === id ? { hoverId: null } : null)),
      onNodeClick: (id) => {
        if (linking) {
          if (!linkFrom) update({ linkFrom: id, linkError: null });
          else if (linkFrom === id) update({ linkFrom: null });
          else finishLink(id);
          return;
        }
        select(id);
      },
      onNodeOpen: (id) => {
        if (!linking) openTask(id);
      },
      onNodeKey: (id, ev) => {
        if (ev.target !== ev.currentTarget || ev.altKey || ev.ctrlKey || ev.metaKey) return;
        if (ev.key === 'Enter') {
          ev.preventDefault();
          if (linking) handlers.onNodeClick(id);
          else openTask(id);
        } else if (ev.key === ' ') {
          ev.preventDefault();
          handlers.onNodeClick(id);
        } else if (ev.key === 'Escape' && (linking || selectedId)) {
          ev.preventDefault();
          if (linking) update({ linking: false, linkFrom: null, linkError: null });
          else update({ selectedId: null });
        } else if (ev.key.startsWith('Arrow')) {
          const next = neighbourInDirection(model, id, ev.key);
          if (!next) return;
          ev.preventDefault();
          const svg = ev.currentTarget.ownerSVGElement;
          const target = svg && svg.querySelector(`[data-entity="task:${CSS.escape(next)}"]`);
          if (target) {
            target.focus();
            target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          }
        }
      },
      onEdge: (edge, point) => {
        if (linking) return;
        openEdgePopover(app, edge, point, { onOpen: (id) => openTask(id) });
      },
      onBackground: () => {
        if (suppressBackgroundClick) return;
        if (linking && linkFrom) update({ linkFrom: null });
        else if (selectedId) update({ selectedId: null });
      },
      onPanStart: panStart,
      onWheel: (ev) => {
        if (!(ev.ctrlKey || ev.metaKey)) return;
        ev.preventDefault();
        const current = zoom || measuredScale(ev.currentTarget, model.width);
        const next = nextZoom(current, ev.deltaY < 0 ? 1 : -1);
        if (next !== zoom) update({ zoom: next });
      },
      onZoom: (direction, el) => {
        const current = zoom || measuredScale(el, model.width);
        if (selectedId) requestScroll(selectedId);
        update({ zoom: nextZoom(current, direction) });
      },
      onZoomFit: () => update({ zoom: null }),
      onLinkCancel: () => {
        if (linkFrom) update({ linkFrom: null, linkError: null });
        else update({ linking: false, linkFrom: null, linkError: null });
      },
    };

    // ----- barra de ferramentas ---------------------------------------------------------------------
    const toolbar = h(
      'div',
      { class: 'v-dependencias-toolbar' },
      segmented({
        value: mode,
        size: 'sm',
        ariaLabel: 'Modo de visualização',
        class: 'v-dependencias-mode',
        options: [
          { value: 'diagram', label: 'Diagrama', icon: 'git-branch' },
          { value: 'list', label: 'Lista', icon: 'list' },
        ],
        onchange: (value) => update({ mode: value, linking: false, linkFrom: null, hoverId: null }),
      }),
      button({
        label: demandLabel(app, demandId),
        icon: 'layers',
        iconRight: 'chevron-down',
        size: 'sm',
        active: demandId !== DEMAND_ALL,
        class: 'v-dependencias-demand',
        title: 'Filtrar por demanda',
        attrs: { 'data-action': 'pick-demand' },
        onclick: (ev) => pickDemand(app, ev.currentTarget, demandId, projectId, (value) => update({ demandId: value, selectedId: null, hoverId: null })),
      }),
      switchInput({ checked: hideDone, label: 'Ocultar concluídas', class: 'v-dependencias-switch', attrs: { 'data-toggle': 'hide-done' }, onchange: (checked) => update({ hideDone: checked }) }),
      mode === 'diagram'
        ? switchInput({ checked: showIsolated, label: 'Mostrar tarefas sem dependências', class: 'v-dependencias-switch', attrs: { 'data-toggle': 'show-isolated' }, onchange: (checked) => update({ showIsolated: checked }) })
        : null,
      h('span', { class: 'v-dependencias-toolbar-spacer' }),
      mode === 'diagram' && model.nodes.length > 1
        ? button({
            label: linking ? 'Ligando…' : 'Ligar',
            icon: 'link',
            size: 'sm',
            active: linking,
            title: linking ? 'Sair do modo ligar (Esc)' : 'Modo ligar: clique no pré-requisito e depois na tarefa que depende dele',
            attrs: { 'data-action': 'toggle-link' },
            onclick: () => update(linking ? { linking: false, linkFrom: null, linkError: null } : { linking: true, linkFrom: null, linkError: null, hoverId: null }),
          })
        : null,
      button({ label: 'Nova dependência', icon: 'plus', size: 'sm', variant: 'primary', attrs: { 'data-action': 'new-dependency' }, onclick: onNew }),
    );

    const banner = cyclesBanner(app, model.cycles, { onSelect: (id) => select(id, { scroll: true }) });

    // ----- conteúdo ---------------------------------------------------------------------------------
    let main;
    let side;
    let isEmpty = false;
    if (mode === 'list') {
      const entries = listEntries(app, model, { hideDone });
      if (!entries.length) {
        isEmpty = true;
        main = emptyView(app, model, { demandId, hideDone, mode, projectId, onNew, update });
      } else {
        main = renderList(app, entries, { selectedId });
      }
      side = [conflictsCard(app, model, { selectedId, onSelect: (id) => openTask(id) }), legendCard({ mode })];
    } else if (!model.nodes.length) {
      isEmpty = true;
      main = emptyView(app, model, { demandId, hideDone, mode, projectId, onNew, update });
      side = model.conflicts.length ? [conflictsCard(app, model, { selectedId, onSelect: (id) => select(id, { scroll: true }) })] : null;
    } else {
      main = h(
        'div',
        { class: 'v-dependencias-diagram' },
        state.linkError && linking
          ? h('div', { class: 'v-dependencias-linkerror', role: 'alert' }, h('span', null, state.linkError), h('button', { type: 'button', class: 'v-dependencias-linkerror-close', 'aria-label': 'Dispensar', onclick: () => update({ linkError: null }) }, '×'))
          : null,
        renderDiagram(app, model, { zoom, selectedId, activeId, linking, linkFrom, handlers }),
      );
      side = [
        detailsCard(app, model, detailId, {
          selected: detailId === selectedId,
          onSelect: (id) => select(id, { scroll: true }),
          onOpen: openTask,
          onAddPrereq: (id) => openNewDependency(app, { taskId: id, onCreated: (taskId) => update({ selectedId: taskId }) }),
          onAddDependent: (id) => openNewDependency(app, { prereqId: id, onCreated: (taskId) => update({ selectedId: taskId }) }),
        }),
        conflictsCard(app, model, { selectedId, onSelect: (id) => select(id, { scroll: true }) }),
        legendCard({ mode }),
      ];
    }

    const summary = model.nodes.length
      ? `${plural(model.nodes.length, 'tarefa', 'tarefas')} · ${plural(model.edges.length, 'ligação', 'ligações')}`
      : null;

    return h(
      'div',
      {
        class: cx('v-dependencias', `is-${mode}`, isMobile && 'is-mobile', isEmpty && 'is-empty'),
        'data-mode': mode,
        onkeydown: (ev) => {
          if (ev.key === 'Escape' && linking && !ev.defaultPrevented) {
            ev.preventDefault();
            update({ linking: false, linkFrom: null, linkError: null });
          }
        },
      },
      toolbar,
      summary && mode === 'diagram' ? h('div', { class: 'v-dependencias-summary', 'aria-live': 'polite' }, summary, selectedId && model.byId.get(selectedId) ? ` · selecionada: ${taskName(model.byId.get(selectedId))}` : null) : null,
      banner,
      h('div', { class: cx('v-dependencias-body', !side && 'is-single') }, h('div', { class: 'v-dependencias-main' }, main), side ? h('aside', { class: 'v-dependencias-side', 'aria-label': 'Detalhes e conflitos' }, side) : null),
    );
  },
};
