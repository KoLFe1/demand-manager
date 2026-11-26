// Ações da tela Kanban (js/ui/views/kanban.js): soltar um cartão numa célula, criação rápida e os menus
// da coluna, das raias e da exibição. Toda escrita passa por app.cmd.* ou pelas ações de shared/entity.js.

import { openMenu, promptDialog } from '../../kit/overlays.js';
import { applyStatus, handleError, notify } from '../../shared/entity.js';
import { applyViewFilters } from '../../shared/filterbar.js';
import { LANE_LABELS, LANE_MODES, boardFilters } from './model.js';

export const NOUN = Object.freeze({
  task: { one: 'tarefa', many: 'tarefas', One: 'Tarefa', new: 'Nova tarefa', none: 'Nenhuma tarefa ainda' },
  demand: { one: 'demanda', many: 'demandas', One: 'Demanda', new: 'Nova demanda', none: 'Nenhuma demanda ainda' },
});

export const quoted = (text) => `“${text}”`;

// ---------------------------------------------------------------------------
// Ações (soltar, criar, menus)
// ---------------------------------------------------------------------------

/** Ponto da tela de um evento (âncora do popover do impedimento), ou null. */
function pointOf(ev) {
  return ev && Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY) && (ev.clientX || ev.clientY) ? { x: ev.clientX, y: ev.clientY } : null;
}

/**
 * Aplica um cartão solto numa célula: muda a raia (se for um campo editável), o status (fluxo padrão de
 * entity.js: avisos + pergunta do impedimento) e, com ordem manual, a posição.
 */
export function performDrop(app, st, { id, from, statusId, laneKey, place, event }) {
  const kind = st.mode;
  const entity = kind === 'task' ? app.sel.task(id) : app.sel.demand(id);
  if (!entity) return;
  const origin = from && typeof from === 'object' ? from : {};
  const manual = st.sort.key === 'manual';
  const position = manual && place && Object.keys(place).length ? place : null;
  let placed = false;
  if (st.lanes !== 'none' && laneKey !== null && laneKey !== undefined && origin.lane !== laneKey) {
    try {
      if (st.lanes === 'priority') app.cmd.setPriority(kind, id, laneKey);
      else if (st.lanes === 'demand' && kind === 'task') {
        app.cmd.moveTask(id, { demand_id: laneKey || null, ...(position || {}) });
        placed = true;
      } else if (st.lanes === 'project' && kind === 'demand') app.cmd.updateDemand(id, { project_id: laneKey || null });
    } catch (err) {
      handleError(app, err);
      return;
    }
  }
  if (origin.col !== statusId) {
    const result = applyStatus(app, kind, id, statusId, { anchor: pointOf(event) || undefined });
    if (!result) return;
  }
  if (position && !placed) {
    try {
      if (kind === 'task') app.cmd.moveTask(id, position);
      else app.cmd.reorderDemand(id, position);
    } catch (err) {
      handleError(app, err);
    }
  }
}

/** Depois de criar pela linha rápida: avisa quando o item novo não aparece no quadro (filtros/escopo). */
export function afterQuickCreate(app, st, row) {
  const kind = st.mode;
  const fresh = kind === 'task' ? app.sel.task(row.id) : app.sel.demand(row.id);
  if (!fresh) return;
  const visible = applyViewFilters(app, [fresh], boardFilters(st), kind).length > 0;
  if (!visible) {
    notify(app, `${NOUN[kind].One} criada, mas os filtros atuais a escondem do quadro.`, {
      action: { label: 'Abrir', onclick: () => app.ui.openPanel(kind, row.id) },
    });
  }
}

/** Pede o limite de WIP da coluna "Em andamento". */
async function editWipLimit(app, ctx, st, status) {
  const text = await promptDialog({
    title: 'Limite de WIP',
    label: `Máximo de cartões em ${quoted(status.label)}`,
    value: String(st.wipLimit),
    hint: 'Acima deste número, o cabeçalho da coluna fica em tom de alerta.',
    confirmLabel: 'Salvar',
    required: true,
  });
  if (text === null) return;
  const n = Number(text.replace(',', '.'));
  if (!Number.isInteger(n) || n < 1 || n > 999) {
    notify(app, 'Informe um número inteiro entre 1 e 999.', { tone: 'danger' });
    return;
  }
  ctx.setState({ wipLimit: n });
}

export function openColumnMenu(app, ctx, st, column, anchor) {
  const status = column.status;
  const noun = NOUN[st.mode];
  const items = [
    { label: `Adicionar ${noun.one}`, icon: 'plus', onclick: () => ctx.setState({ addTo: status.id }) },
  ];
  if (!ctx.isMobile) items.push({ label: 'Recolher coluna', icon: 'chevron-left', onclick: () => ctx.setState({ collapsed: { ...st.collapsed, [status.id]: true } }) });
  if (status.category === 'active') {
    items.push({ label: 'Limite de WIP…', icon: 'alert-triangle', hint: String(st.wipLimit), onclick: () => editWipLimit(app, ctx, st, status) });
  }
  items.push({ separator: true }, { label: 'Mostrar canceladas', checked: st.showCancelled, onclick: () => ctx.setState({ showCancelled: !st.showCancelled }) });
  openMenu(anchor, items, { title: status.label, minWidth: 220, align: 'end' });
}

export function openLanesMenu(ctx, st, anchor) {
  openMenu(
    anchor,
    LANE_MODES[st.mode].map((mode) => ({
      label: LANE_LABELS[mode],
      icon: mode === 'none' ? 'columns' : mode === 'demand' ? 'layers' : mode === 'project' ? 'folder' : 'signal-3',
      checked: st.lanes === mode,
      onclick: () => ctx.setState({ lanes: mode }),
    })),
    { title: 'Agrupar em raias', minWidth: 200, align: 'end' },
  );
}

export function openDisplayMenu(ctx, st, anchor) {
  const items = [];
  if (st.mode === 'task') {
    items.push({ label: 'Incluir subtarefas', description: 'Subtarefas viram cartões, com o nome da tarefa principal', checked: st.subtasks, onclick: () => ctx.setState({ subtasks: !st.subtasks }) });
  }
  items.push({ label: 'Mostrar canceladas', description: 'Acrescenta a coluna “Cancelada”', checked: st.showCancelled, onclick: () => ctx.setState({ showCancelled: !st.showCancelled }) });
  const collapsed = Object.keys(st.collapsed).length;
  if (collapsed) items.push({ separator: true }, { label: 'Expandir todas as colunas', icon: 'columns', onclick: () => ctx.setState({ collapsed: {} }) });
  openMenu(anchor, items, { title: 'Exibição', minWidth: 260, align: 'end' });
}

// ---------------------------------------------------------------------------
