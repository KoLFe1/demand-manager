// Visualização "Cronograma" (#/cronograma): linha do tempo (Gantt) das demandas e tarefas.
//
//   • coluna da esquerda (fixa ao rolar na horizontal): código + nome; clicar abre o painel lateral;
//   • à direita, um SVG com a régua (meses/semanas/dias), a linha de "hoje", as barras coloridas pelo status
//     (atrasadas com contorno vermelho), marcos (losango) para itens só com prazo, a barra-resumo de cada
//     demanda e as setas de dependência (vermelhas quando há conflito de prazo);
//   • barra de ferramentas: projeto (padrão = filtro global), zoom Dias/Semanas/Meses, "Mostrar concluídas"
//     e "Subtarefas"; itens sem nenhuma data ficam na lista "Sem datas" abaixo do gráfico.
//
// Regras (puras) em js/domain/gantt.js. Estado da tela: { scale, showDone, showSubtasks, projectId }
// (projectId ausente = segue o filtro global; '__all' = todos; '' = sem projeto; id = o projeto).

import { cx, h, s } from '../../core/dom.js';
import { diffDays, formatDate } from '../../core/dates.js';
import { plural } from '../../core/format.js';
import { statusById } from '../../domain/statuses.js';
import { GANTT_SCALE_LABELS, GANTT_SCALES, buildGantt, ganttTicks, ganttWindow } from '../../domain/gantt.js';
import { button, segmented, switchInput } from '../kit/controls.js';
import { emptyState } from '../kit/display.js';
import { pickFromList } from '../kit/pickers.js';

const ROW_H = 32;
const HEAD_H = 44;
const ALL = '__all';
const SCALES = Object.freeze(['day', 'week', 'month']);

/** Última combinação (escala|janela) para a qual já rolamos até "hoje". */
let scrolledKey = null;

let cache = { key: null, value: null };
function modelOf(app, { projectId, showDone, showSubtasks }) {
  const key = [app.store.version(), app.clock.today(), projectId === null ? '*' : projectId, showDone ? 1 : 0, showSubtasks ? 1 : 0, app.settings.get('capacity.hoursPerDay')].join('|');
  if (cache.key === key) return cache.value;
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
  cache = { key, value };
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
  const dates = row.kind === 'milestone' ? `Prazo: ${formatDate(row.end, 'short', today)}` : `${formatDate(row.start, 'short', today)} → ${formatDate(row.end, 'short', today)}`;
  const extra = [];
  if (row.source === 'estimate') extra.push('início estimado pela estimativa');
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
    const undated = model.undated.length
      ? h(
          'section',
          { class: 'v-crono-undated', 'aria-label': 'Sem datas' },
          h('h3', { class: 'v-crono-undated-title' }, 'Sem datas ', h('span', { class: 'v-crono-count' }, String(model.undated.length))),
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
      chart,
      undated,
    );
  },
};

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

  // Barras.
  const bars = model.rows.map((r, i) => {
    const color = statusById(statuses, r.status).color || 'gray';
    const y = midY(i);
    const common = {
      key: r.key,
      class: cx('v-crono-item', `is-${r.kind}`, `st-${color}`, r.type === 'demand' && 'is-demand', r.overdue && 'is-overdue', r.conflict && 'is-conflict', (r.category === 'done' || r.category === 'cancelled') && 'is-closed'),
      'data-entity': r.key,
      tabindex: '0',
      role: 'button',
      'aria-label': rowTitle(app, r),
      onclick: () => open(r.type, r.id),
      onkeydown: (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open(r.type, r.id);
        }
      },
    };
    const title = s('title', null, rowTitle(app, r));
    if (r.kind === 'milestone') {
      const cx0 = X(r.end) + px / 2;
      const k = 7;
      return s('g', common, title, s('path', { d: `M${cx0},${y - k} L${cx0 + k},${y} L${cx0},${y + k} L${cx0 - k},${y} Z`, class: 'v-crono-diamond' }));
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
      s('rect', { x: g.x, y: y - 9, width: g.w, height: 18, rx: 4, class: cx('v-crono-bar', r.source === 'estimate' && 'is-estimated', r.openEnd && 'is-open-end') }),
      label,
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

