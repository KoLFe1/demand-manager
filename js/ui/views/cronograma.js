// Visualização "Cronograma" (#/cronograma): linha do tempo (Gantt) das demandas e tarefas.
//
//   • coluna da esquerda (fixa ao rolar na horizontal): código + nome; clicar abre o painel lateral;
//   • à direita, um SVG com a régua (meses/semanas/dias), a linha de "hoje", as barras coloridas pelo status
//     (atrasadas com contorno vermelho), marcos (losango) para itens só com prazo, a barra-resumo de cada
//     demanda e as setas de dependência (vermelhas quando há conflito de prazo);
//   • barra de ferramentas: projeto (padrão = filtro global), zoom Dias/Semanas/Meses, "Mostrar concluídas"
//     e "Subtarefas"; itens sem nenhuma data ficam na lista "Sem datas" abaixo do gráfico;
//   • legenda (planejada, durações estimadas tracejadas, marco, início planejado, demanda);
//   • arrastar (mouse/caneta; desligado em ponteiro grosso/toque): a barra inteira move início e prazo juntos
//     N dias; a borda direita muda só o prazo; teclado: barra focada + Shift+←/→ move 1 dia. Grava por
//     app.cmd.updateTask (auditado) com aviso [Desfazer]; patch puro em ganttDragPatch (domain/gantt.js).
//
// Regras (puras) em js/domain/gantt.js. Estado da tela: { scale, showDone, showSubtasks, projectId }
// (projectId ausente = segue o filtro global; '__all' = todos; '' = sem projeto; id = o projeto).

import { cx, h, s } from '../../core/dom.js';
import { diffDays, formatDate } from '../../core/dates.js';
import { plural } from '../../core/format.js';
import { statusById } from '../../domain/statuses.js';
import { ESTIMATE_TITLES, GANTT_SCALE_LABELS, GANTT_SCALES, START_MARKER_TITLE, buildGantt, ganttDragPatch, ganttTicks, ganttWindow } from '../../domain/gantt.js';
import { handleError, notify } from '../shared/entity.js';
import { button, segmented, switchInput } from '../kit/controls.js';
import { emptyState } from '../kit/display.js';
import { pickFromList } from '../kit/pickers.js';
import { openScheduleDialog } from '../schedule.js';

const ROW_H = 32;
const HEAD_H = 44;
const ALL = '__all';
const SCALES = Object.freeze(['day', 'week', 'month']);
/** Largura (px) da alça de redimensionar na borda direita da barra. */
const HANDLE_W = 6;
/** Deslocamento mínimo (px) para o gesto virar arrasto (abaixo disso é clique). */
const DRAG_SLOP = 4;

/** Depois de um arrasto, o clique que o navegador dispara em seguida não abre o painel (nível de módulo:
 *  o morph pode trocar o tratador entre o pointerup e o click). */
let suppressClick = false;

/** Última combinação (escala|janela) para a qual já rolamos até "hoje". */
let scrolledKey = null;

// Cache por app (a chave usa a versão do banco, que recomeça em outro app/banco aberto na mesma página).
let cache = { app: null, key: null, value: null };
function modelOf(app, { projectId, showDone, showSubtasks }) {
  const key = [app.store.version(), app.clock.today(), projectId === null ? '*' : projectId, showDone ? 1 : 0, showSubtasks ? 1 : 0, app.settings.get('capacity.hoursPerDay')].join('|');
  if (cache.app === app && cache.key === key) return cache.value;
  const n = Number(app.settings.get('capacity.hoursPerDay'));
  const value = buildGantt({
    tasks: app.sel.tasks(),
    demands: app.sel.demands(),
    graph: app.sel.graph(),
    conflicts: app.sel.conflicts(),
    statuses: app.sel.statuses(),
    today: app.clock.today(),
    hoursPerDay: Number.isFinite(n) && n > 0 ? n : 8,
    projectId,
    showDone,
    showSubtasks,
  });
  cache = { app, key, value };
  return value;
}

/** Escopo efetivo: escolha da tela ou, sem escolha, o filtro global de projeto. */
function effectiveProject(app, state) {
  if (state.projectId === ALL) return null;
  if (typeof state.projectId === 'string') {
    if (state.projectId === '' || app.sel.project(state.projectId)) return state.projectId;
  }
  return (app.ui && app.ui.scope && app.ui.scope.projectId) || null;
}

function projectLabel(app, projectId) {
  if (projectId === null) return 'Todos os projetos';
  if (projectId === '') return 'Sem projeto';
  const p = app.sel.project(projectId);
  return p ? p.name || 'Projeto sem nome' : 'Todos os projetos';
}

async function pickProject(app, anchor, current, onchange) {
  const items = [
    { id: ALL, label: 'Todos os projetos', icon: 'layers' },
    { id: '__none', label: 'Sem projeto', icon: 'inbox' },
    ...app.sel.projects().map((p) => ({ id: p.id, label: p.name || 'Projeto sem nome', icon: 'folder' })),
  ];
  const chosen = await pickFromList(anchor, { items, current: current === null ? ALL : current === '' ? '__none' : current, placeholder: 'Buscar projeto…', title: 'Projeto', width: 300 });
  if (chosen === null) return;
  onchange(chosen === '__none' ? '' : chosen);
}

const entityName = (e) => (e && typeof e.name === 'string' && e.name.trim()) || 'Sem nome';

function rowTitle(app, row) {
  const st = statusById(app.sel.statuses(), row.status);
  const today = app.clock.today();
  const dates =
    row.kind === 'milestone'
      ? `Prazo: ${formatDate(row.end, 'short', today)}`
      : row.kind === 'start'
        ? `Início: ${formatDate(row.start, 'short', today)}`
        : `${formatDate(row.start, 'short', today)} → ${formatDate(row.end, 'short', today)}`;
  const extra = [];
  if (row.type === 'task' && ESTIMATE_TITLES[row.source]) extra.push(ESTIMATE_TITLES[row.source]);
  if (row.kind === 'start') extra.push(START_MARKER_TITLE);
  if (row.overdue) extra.push('atrasada');
  if (row.conflict) extra.push('conflito de dependência');
  return `${app.sel.code(row.type, row.entity)} ${entityName(row.entity)} — ${st.label} · ${dates}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

export default {
  id: 'cronograma',
  title: 'Cronograma',
  icon: 'rows',
  section: 'views',

  onLeave() {
    scrolledKey = null;
  },

  render(app, ctx) {
    const { state, isMobile } = ctx;
    const scale = SCALES.includes(state.scale) ? state.scale : 'week';
    const showDone = state.showDone === true;
    const showSubtasks = state.showSubtasks === true;
    const projectId = effectiveProject(app, state);
    const update = (patch) => ctx.setState(patch);
    const open = (type, id) => app.ui.openPanel(type, id);
    const today = app.clock.today();

    const model = modelOf(app, { projectId, showDone, showSubtasks });

    const toolbar = h(
      'div',
      { class: 'v-crono-toolbar' },
      button({
        label: projectLabel(app, projectId),
        icon: 'folder',
        iconRight: 'chevron-down',
        size: 'sm',
        active: projectId !== null,
        class: 'v-crono-project',
        title: 'Filtrar por projeto',
        attrs: { 'data-action': 'pick-project' },
        onclick: (ev) => pickProject(app, ev.currentTarget, projectId, (value) => update({ projectId: value })),
      }),
      segmented({
        value: scale,
        size: 'sm',
        ariaLabel: 'Escala da linha do tempo',
        class: 'v-crono-scale',
        options: SCALES.map((value) => ({ value, label: GANTT_SCALE_LABELS[value] })),
        onchange: (value) => update({ scale: value }),
      }),
      switchInput({ checked: showDone, label: 'Mostrar concluídas', class: 'v-crono-switch', attrs: { 'data-toggle': 'show-done' }, onchange: (checked) => update({ showDone: checked }) }),
      switchInput({ checked: showSubtasks, label: 'Subtarefas', class: 'v-crono-switch', attrs: { 'data-toggle': 'show-subtasks' }, onchange: (checked) => update({ showSubtasks: checked }) }),
      model.rows.length
        ? h('span', { class: 'v-crono-summary', 'aria-live': 'polite' }, plural(model.rows.length, 'linha', 'linhas'), model.links.length ? ` · ${plural(model.links.length, 'dependência', 'dependências')}` : null)
        : null,
    );

    if (!model.rows.length && !model.undated.length) {
      return h(
        'div',
        { class: cx('v-cronograma', 'is-empty', isMobile && 'is-mobile') },
        toolbar,
        emptyState({
          icon: 'rows',
          title: showDone ? 'Nada para mostrar' : 'Nenhum item em aberto',
          text: 'O cronograma mostra demandas e tarefas com início planejado ou prazo. Defina datas nas tarefas para vê-las na linha do tempo.',
          action: [
            !showDone ? button({ label: 'Mostrar concluídas', icon: 'eye', onclick: () => update({ showDone: true }), attrs: { 'data-action': 'show-done' } }) : null,
            button({ label: 'Nova tarefa', icon: 'plus', variant: 'primary', onclick: () => app.ui.quickCreate('task'), attrs: { 'data-action': 'new-task' } }),
          ],
          class: 'v-crono-empty',
        }),
      );
    }

    const chart = model.rows.length ? renderChart(app, model, { scale, today, isMobile, open }) : null;
    const legend = model.rows.length ? renderLegend() : null;
    const undated = model.undated.length
      ? h(
          'section',
          { class: 'v-crono-undated', 'aria-label': 'Sem datas' },
          h(
            'div',
            { class: 'v-crono-undated-head' },
            h('h3', { class: 'v-crono-undated-title' }, 'Sem datas ', h('span', { class: 'v-crono-count' }, String(model.undated.length))),
            scheduleButton(app, model.undated),
          ),
          h(
            'ul',
            { class: 'v-crono-undated-list' },
            model.undated.slice(0, 200).map((item) =>
              h(
                'li',
                { key: item.key },
                h(
                  'button',
                  { type: 'button', class: 'v-crono-undated-item', 'data-entity': item.key, onclick: () => open(item.type, item.id) },
                  h('span', { class: 'v-crono-code' }, app.sel.code(item.type, item.entity)),
                  h('span', { class: 'v-crono-name' }, entityName(item.entity)),
                ),
              ),
            ),
          ),
        )
      : null;

    return h(
      'div',
      { class: cx('v-cronograma', isMobile && 'is-mobile'), 'data-scale': scale },
      toolbar,
      model.truncated ? h('div', { class: 'v-crono-note', role: 'status' }, `Mostrando as primeiras ${model.rows.length} de ${model.total} linhas. Filtre por projeto para ver o restante.`) : null,
      legend,
      chart,
      undated,
    );
  },
};

/** Demandas abertas que têm itens na lista "Sem datas" (a própria demanda ou tarefas dela), na ordem da lista. */
function undatedDemands(app, undated) {
  const seen = new Map();
  for (const item of undated) {
    const demand = item.type === 'demand' ? item.entity : app.sel.demandOf(item.entity);
    if (demand && !seen.has(demand.id) && app.sel.isOpen(demand)) seen.set(demand.id, demand);
  }
  return [...seen.values()];
}

/** "Agendar datas vazias…" no cabeçalho de "Sem datas": abre direto com uma demanda, senão pergunta qual. */
function scheduleButton(app, undated) {
  const demands = undatedDemands(app, undated);
  if (!demands.length) return null;
  return button({
    label: 'Agendar datas vazias…',
    icon: 'calendar',
    size: 'sm',
    variant: 'ghost',
    class: 'v-crono-schedule',
    attrs: { 'data-action': 'schedule-empty' },
    onclick: async (ev) => {
      let id = demands.length === 1 ? demands[0].id : null;
      if (!id) {
        id = await pickFromList(ev.currentTarget, {
          items: demands.map((d) => ({ id: d.id, label: d.name, hint: app.sel.code('demand', d) })),
          placeholder: 'Buscar demanda…',
          title: 'Agendar qual demanda?',
          width: 320,
        });
      }
      if (id) openScheduleDialog(app, id);
    },
  });
}

/** Legenda das formas do cronograma. */
function renderLegend() {
  const swatch = (cls, shape) => s('svg', { class: 'v-crono-legend-swatch', width: 28, height: 14, viewBox: '0 0 28 14', 'aria-hidden': 'true' }, shape(cls));
  const bar = (cls) => s('rect', { x: 1, y: 2, width: 26, height: 10, rx: 3, class: cx('v-crono-legend-bar', cls) });
  const entries = [
    { key: 'planned', label: 'Planejada (início → prazo)', icon: swatch('', bar) },
    { key: 'estimate', label: ESTIMATE_TITLES.estimate, icon: swatch('is-estimated', bar) },
    { key: 'estimate_end', label: ESTIMATE_TITLES.estimate_end, icon: swatch('is-estimated', bar) },
    { key: 'milestone', label: 'Prazo (marco)', icon: swatch('', () => s('path', { d: 'M14,1 L20,7 L14,13 L8,7 Z', class: 'v-crono-legend-diamond' })) },
    { key: 'start', label: 'Início planejado (sem prazo)', icon: swatch('', () => s('path', { d: 'M10,1 V13 M10,1 L18,4 L10,7 Z', class: 'v-crono-legend-start' })) },
    { key: 'summary', label: 'Demanda (resumo)', icon: swatch('', () => s('rect', { x: 1, y: 4, width: 26, height: 6, rx: 2, class: 'v-crono-legend-summary' })) },
  ];
  return h(
    'ul',
    { class: 'v-crono-legend', 'aria-label': 'Legenda' },
    entries.map((e) => h('li', { key: e.key, class: 'v-crono-legend-item', 'data-legend': e.key }, e.icon, h('span', null, e.label))),
  );
}

/** Depois de mover pelo teclado, devolve o foco à barra (o morph pode ter recriado o nó). */
function refocus(el, key) {
  const root = el && el.ownerSVGElement ? el.ownerSVGElement : null;
  queueMicrotask(() => {
    const target = (root && root.querySelector(`.v-crono-item[data-entity="${key}"]`)) || el;
    if (target && target.isConnected && typeof target.focus === 'function') target.focus({ preventScroll: true });
  });
}

/** Ponteiro grosso (toque): sem arrasto, só toque para abrir o painel. */
function coarsePointer() {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/**
 * Grava o patch de arrasto (auditado por updateTask) e oferece [Desfazer].
 * @param {object} app
 * @param {object} row linha do modelo (tarefa)
 * @param {'move'|'resize'} mode
 * @param {number} days
 * @returns {object|null} o patch gravado
 */
export function applyGanttDrag(app, row, mode, days) {
  const patch = ganttDragPatch(row, mode, days);
  if (!patch) return null;
  const task = app.sel.task(row.id) || row.entity;
  const before = {};
  for (const k of Object.keys(patch)) before[k] = task[k] === undefined ? null : task[k];
  try {
    app.cmd.updateTask(task.id, patch);
  } catch (err) {
    handleError(app, err);
    return null;
  }
  const n = Math.abs(days);
  const what = mode === 'resize' ? `Prazo ${days > 0 ? 'adiado' : 'antecipado'}` : `Movida ${days > 0 ? 'para frente' : 'para trás'}`;
  const today = app.clock.today();
  const dateText = patch.due_date ? ` · prazo ${formatDate(patch.due_date, 'short', today)}` : patch.planned_start ? ` · início ${formatDate(patch.planned_start, 'short', today)}` : '';
  notify(app, `${what} ${plural(n, 'dia', 'dias')}${dateText}`, {
    action: {
      label: 'Desfazer',
      onclick: () => {
        try {
          app.cmd.updateTask(task.id, before);
        } catch (err) {
          handleError(app, err);
        }
      },
    },
  });
  return patch;
}

function renderChart(app, model, { scale, today, isMobile, open }) {
  const px = GANTT_SCALES[scale];
  const win = ganttWindow(model.range, scale, { minDays: Math.ceil((isMobile ? 260 : 1100) / px) });
  const ticks = ganttTicks(win, scale);
  const width = ticks.width;
  const height = model.rows.length * ROW_H;
  const X = (date) => diffDays(win.from, date) * px;
  const statuses = app.sel.statuses();
  const index = new Map(model.rows.map((r, i) => [r.key, i]));
  const midY = (i) => i * ROW_H + ROW_H / 2;
  const todayX = X(today) + px / 2;

  // Régua (cabeçalho).
  const head = s(
    'svg',
    { class: 'v-crono-ruler', width, height: HEAD_H, viewBox: `0 0 ${width} ${HEAD_H}`, 'aria-hidden': 'true' },
    ticks.major.map((t) =>
      s('g', { key: `M${t.date}` }, s('line', { x1: t.x, x2: t.x, y1: 0, y2: HEAD_H, class: 'v-crono-tick-major' }), t.width > 40 ? s('text', { x: t.x + 6, y: 15, class: 'v-crono-major-label' }, t.label) : null),
    ),
    ticks.minor.map((t) =>
      s(
        'g',
        { key: `m${t.date}` },
        t.weekend ? s('rect', { x: t.x, y: 22, width: t.width, height: HEAD_H - 22, class: 'v-crono-weekend' }) : null,
        s('line', { x1: t.x, x2: t.x, y1: 22, y2: HEAD_H, class: 'v-crono-tick-minor' }),
        t.width >= 18 ? s('text', { x: t.x + t.width / 2, y: 37, 'text-anchor': 'middle', class: cx('v-crono-minor-label', t.date === today && 'is-today') }, t.label) : null,
      ),
    ),
    s('line', { x1: 0, x2: width, y1: 22, y2: 22, class: 'v-crono-tick-minor' }),
  );

  // Linhas de grade + fins de semana (escala diária) + hoje.
  const grid = s(
    'g',
    { class: 'v-crono-grid' },
    ticks.minor.map((t) => (t.weekend ? s('rect', { key: `w${t.date}`, x: t.x, y: 0, width: t.width, height, class: 'v-crono-weekend' }) : null)),
    ticks.minor.map((t) => s('line', { key: `g${t.date}`, x1: t.x, x2: t.x, y1: 0, y2: height, class: 'v-crono-gridline' })),
    model.rows.map((r, i) => (i ? s('line', { key: `r${r.key}`, x1: 0, x2: width, y1: i * ROW_H, y2: i * ROW_H, class: 'v-crono-rowline' }) : null)),
  );

  const barGeom = (r) => {
    const x = X(r.start);
    const w = Math.max(4, (diffDays(r.start, r.end) + 1) * px);
    return { x, w, x2: x + w };
  };

  // Setas de dependência.
  const links = model.links.map((link) => {
    const a = model.rows[index.get(`task:${link.from}`)];
    const b = model.rows[index.get(`task:${link.to}`)];
    const ia = index.get(a.key);
    const ib = index.get(b.key);
    const ga = a.kind === 'milestone' ? { x2: X(a.end) + px / 2 + 6 } : barGeom(a);
    const gb = b.kind === 'milestone' ? { x: X(b.end) + px / 2 - 6 } : barGeom(b);
    const y1 = midY(ia);
    const y2 = midY(ib);
    const xa = ga.x2 + 6;
    const xb = gb.x - 4;
    let d;
    if (xb >= xa) d = `M${ga.x2},${y1} H${xa} V${y2} H${gb.x}`;
    else {
      const ym = y2 + (y2 > y1 ? -ROW_H / 2 : ROW_H / 2);
      d = `M${ga.x2},${y1} H${xa} V${ym} H${xb - 6} V${y2} H${gb.x}`;
    }
    return s(
      'path',
      { key: `l${link.key}`, d, class: cx('v-crono-link', link.conflict && 'is-conflict'), 'marker-end': link.conflict ? 'url(#v-crono-arrow-bad)' : 'url(#v-crono-arrow)', 'data-link': link.key },
      s('title', null, link.conflict ? 'Dependência com conflito de prazo' : 'Dependência'),
    );
  });

  // Arrastar: só tarefas desenhadas como barra/início, com mouse/caneta (ponteiro grosso = só abrir o painel).
  const coarse = coarsePointer();
  const canDrag = (r) => !coarse && r.type === 'task' && (r.kind === 'bar' || r.kind === 'start');
  const startDrag = (r, ev) => {
    if (ev.button !== 0 || !canDrag(r)) return;
    const el = ev.currentTarget;
    const mode = ev.target && ev.target.closest && ev.target.closest('.v-crono-handle') ? 'resize' : 'move';
    const x0 = ev.clientX;
    let days = 0;
    let dragging = false;
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      /* evento sintético sem ponteiro ativo */
    }
    const rect = el.querySelector('.v-crono-bar');
    const baseW = rect ? Number(rect.getAttribute('data-w')) || Number(rect.getAttribute('width')) : 0;
    const restore = () => {
      el.classList.remove('is-dragging');
      el.removeAttribute('transform');
      if (rect && baseW) rect.setAttribute('width', String(baseW));
    };
    const move = (e) => {
      const dx = e.clientX - x0;
      if (!dragging && Math.abs(dx) < DRAG_SLOP) return;
      dragging = true;
      days = Math.round(dx / px);
      el.classList.add('is-dragging');
      if (mode === 'move') el.setAttribute('transform', `translate(${days * px},0)`);
      else if (rect) rect.setAttribute('width', String(Math.max(px, baseW + days * px)));
    };
    const finish = (commit) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      restore();
      if (!dragging) return;
      suppressClick = true;
      setTimeout(() => {
        suppressClick = false;
      }, 0);
      if (commit && days) applyGanttDrag(app, r, mode, days);
    };
    const onUp = (e) => {
      move(e);
      finish(true);
    };
    const onCancel = () => finish(false);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
  };

  // Barras.
  const bars = model.rows.map((r, i) => {
    const color = statusById(statuses, r.status).color || 'gray';
    const y = midY(i);
    const draggable = canDrag(r);
    const common = {
      key: r.key,
      class: cx('v-crono-item', `is-${r.kind}`, `st-${color}`, r.type === 'demand' && 'is-demand', r.overdue && 'is-overdue', r.conflict && 'is-conflict', (r.category === 'done' || r.category === 'cancelled') && 'is-closed'),
      'data-entity': r.key,
      tabindex: '0',
      role: 'button',
      'aria-label': rowTitle(app, r),
      'data-draggable': draggable ? 'true' : null,
      onclick: () => {
        if (suppressClick) return;
        open(r.type, r.id);
      },
      onpointerdown: draggable ? (ev) => startDrag(r, ev) : null,
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open(r.type, r.id);
        } else if (ev.shiftKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && r.type === 'task' && (r.kind === 'bar' || r.kind === 'start')) {
          ev.preventDefault();
          if (applyGanttDrag(app, r, 'move', ev.key === 'ArrowRight' ? 1 : -1)) refocus(ev.currentTarget, r.key);
        }
      },
    };
    const title = s('title', null, rowTitle(app, r));
    if (r.kind === 'milestone') {
      const cx0 = X(r.end) + px / 2;
      const k = 7;
      return s('g', common, title, s('path', { d: `M${cx0},${y - k} L${cx0 + k},${y} L${cx0},${y + k} L${cx0 - k},${y} Z`, class: 'v-crono-diamond' }));
    }
    if (r.kind === 'start') {
      const x0 = X(r.start) + 1;
      return s(
        'g',
        common,
        title,
        s('rect', { x: x0 - 2, y: y - 10, width: Math.max(14, px), height: 20, class: 'v-crono-hit' }),
        s('path', { d: `M${x0},${y - 9} V${y + 9} M${x0},${y - 9} L${x0 + 10},${y - 5} L${x0},${y - 1} Z`, class: 'v-crono-start-marker' }),
      );
    }
    const g = barGeom(r);
    if (r.kind === 'summary') {
      return s(
        'g',
        common,
        title,
        s('rect', { x: g.x, y: y - 4, width: g.w, height: 8, rx: 2, class: 'v-crono-summary-bar' }),
        s('path', { d: `M${g.x},${y + 4} l0,5 l5,-5 Z M${g.x2},${y + 4} l0,5 l-5,-5 Z`, class: 'v-crono-summary-cap' }),
      );
    }
    const label = !isMobile && g.w > 60 ? s('text', { x: g.x + 6, y: y + 4, class: 'v-crono-bar-label' }, entityName(r.entity)) : null;
    return s(
      'g',
      common,
      title,
      s('rect', { x: g.x, y: y - 9, width: g.w, height: 18, rx: 4, 'data-w': String(g.w), 'data-source': r.source, class: cx('v-crono-bar', ESTIMATE_TITLES[r.source] && 'is-estimated', r.openEnd && 'is-open-end') }),
      label,
      draggable && g.w >= 12 ? s('rect', { x: g.x2 - HANDLE_W, y: y - 9, width: HANDLE_W, height: 18, class: 'v-crono-handle' }, s('title', null, 'Arraste para mudar o prazo')) : null,
    );
  });

  const body = s(
    'svg',
    { class: 'v-crono-chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': 'Linha do tempo' },
    s(
      'defs',
      null,
      s('marker', { id: 'v-crono-arrow', viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', orient: 'auto' }, s('path', { d: 'M0,0 L8,4 L0,8 Z', class: 'v-crono-arrowhead' })),
      s('marker', { id: 'v-crono-arrow-bad', viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', orient: 'auto' }, s('path', { d: 'M0,0 L8,4 L0,8 Z', class: 'v-crono-arrowhead is-conflict' })),
    ),
    grid,
    todayX >= 0 && todayX <= width ? s('line', { x1: todayX, x2: todayX, y1: 0, y2: height, class: 'v-crono-today' }) : null,
    s('g', { class: 'v-crono-links' }, links),
    s('g', { class: 'v-crono-bars' }, bars),
  );

  const labels = h(
    'div',
    { class: 'v-crono-labels' },
    model.rows.map((r) =>
      h(
        'button',
        {
          key: r.key,
          type: 'button',
          class: cx('v-crono-label', `depth-${r.depth}`, r.type === 'demand' && 'is-demand', r.overdue && 'is-overdue', (r.category === 'done' || r.category === 'cancelled') && 'is-closed'),
          'data-entity': r.key,
          title: rowTitle(app, r),
          onclick: () => open(r.type, r.id),
        },
        h('span', { class: 'v-crono-code' }, app.sel.code(r.type, r.entity)),
        h('span', { class: 'v-crono-name' }, entityName(r.entity)),
      ),
    ),
  );

  const key = `${scale}|${win.from}`;
  const scrollRef = (el) => {
    if (scrolledKey === key || !el.isConnected) return;
    scrolledKey = key;
    const labelsW = el.querySelector('.v-crono-labels');
    const offset = labelsW ? labelsW.offsetWidth : 0;
    el.scrollLeft = Math.max(0, todayX - (el.clientWidth - offset) * 0.3);
  };

  return h(
    'div',
    { class: 'v-crono-scroll', ref: scrollRef, style: { '--crono-row-h': `${ROW_H}px`, '--crono-head-h': `${HEAD_H}px` } },
    h(
      'div',
      { class: 'v-crono-canvas' },
      h('div', { class: 'v-crono-head' }, h('div', { class: 'v-crono-corner' }, `Hoje: ${formatDate(today, 'short', today)}`), head),
      h('div', { class: 'v-crono-body' }, labels, body),
    ),
  );
}

