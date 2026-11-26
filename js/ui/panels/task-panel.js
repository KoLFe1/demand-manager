// Painel lateral de edição de TAREFA (seções 2, 3, 6, 8 e 13 do pedido).
//
//   export default { title(app, id), render(app, id, ctx) }      ctx = { state, setState(patch), close() }
//
// Tudo salva na hora (ao mudar / sair do campo) pelos comandos (app.cmd.*) — não há botão "Salvar".
// Abas: Detalhes | Tempo | Histórico. O estado do painel (aba, formulários abertos, erros) fica em ctx.state.
//
// Este módulo também exporta os blocos comuns aos dois painéis (cabeçalho, linhas de propriedade, seções,
// observações, histórico, estado "não encontrado"), usados por demand-panel.js.

import { cx, h } from '../../core/dom.js';
import { formatDate, formatDateTime, formatTime, isoToDateStr } from '../../core/dates.js';
import { plural } from '../../core/format.js';
import { validateNewDependency } from '../../domain/dependencies.js';
import { describeEvent, groupByDay } from '../../domain/history.js';
import { isCountable } from '../../domain/progress.js';
import { isClosedCategory } from '../../domain/statuses.js';
import { ACTIONS } from '../../domain/timeline.js';
import { TIMER, elapsedSeconds, estimateVsActual, formatDuration, timerState } from '../../domain/timetracking.js';
import { badge, alertBox, emptyState, progressBar, statusBadge } from '../kit/display.js';
import { button, formatDurationText, iconButton, inlineEdit, numberInput, parseDurationText, switchInput, tabs, textArea } from '../kit/controls.js';
import { sortableItem, sortableList } from '../kit/dnd.js';
import { icon } from '../kit/icons.js';
import { confirmDialog, isMobileViewport } from '../kit/overlays.js';
import { pickFromList } from '../kit/pickers.js';
import {
  checkControl,
  demandControl,
  dueControl,
  entityActions,
  entityFlags,
  entityTitle,
  estimateControl,
  handleError,
  liveElapsed,
  notify,
  openEntityMenu,
  ownerControl,
  priorityControl,
  projectDot,
  quickAddRow,
  statusControl,
  tagsControl,
  taskRow,
  timerControl,
} from '../shared/entity.js';

const TASK_TABS = ['details', 'time', 'history'];
const hasId = (id) => id !== null && id !== undefined && id !== '';
const quoted = (text) => `“${text}”`;
const nameOf = (entity) => (entity && typeof entity.name === 'string' && entity.name.trim() ? entity.name.trim() : 'Sem nome');
const isCommandError = (err) => !!err && typeof err === 'object' && err.name === 'CommandError' && typeof err.code === 'string';

// ---------------------------------------------------------------------------
// Blocos comuns aos painéis
// ---------------------------------------------------------------------------

/**
 * Normaliza o contexto que a casca passa ao painel (tolerante a campos ausentes).
 * @param {{ state?: object, setState?: Function, close?: Function }|null} ctx
 * @returns {{ state: object, setState: (patch: object) => void, close: () => void }}
 */
export function panelContext(ctx) {
  const state = ctx && ctx.state && typeof ctx.state === 'object' ? ctx.state : {};
  const setState = ctx && typeof ctx.setState === 'function' ? (patch) => ctx.setState(patch) : () => {};
  const close = ctx && typeof ctx.close === 'function' ? () => ctx.close() : () => {};
  return { state, setState, close };
}

/**
 * O painel está em modo celular (tela cheia)? Usa app.ui.isMobile() quando a casca o oferece.
 * @param {object} app
 * @returns {boolean}
 */
export function isPanelMobile(app) {
  try {
    if (app && app.ui && typeof app.ui.isMobile === 'function') return !!app.ui.isMobile();
  } catch {
    /* casca indisponível */
  }
  return isMobileViewport();
}

/**
 * Executa uma escrita tratando erros (aviso vermelho para CommandError).
 * @param {object} app
 * @param {() => any} fn
 * @returns {any} o resultado, ou null quando falhou
 */
export function safely(app, fn) {
  try {
    return fn();
  } catch (err) {
    handleError(app, err);
    return null;
  }
}

/** Grava campos de uma tarefa/demanda (atalho com tratamento de erro). */
export function saveFields(app, type, id, patch, options) {
  return safely(app, () => (type === 'task' ? app.cmd.updateTask(id, patch, options) : app.cmd.updateDemand(id, patch, options)));
}

/**
 * Cabeçalho do painel: trilha (à esquerda) e ações (à direita), com o botão de fechar no fim.
 * @param {object} app
 * @param {{ crumbs?: Node, actions?: Node[], close: () => void }} options
 * @returns {HTMLElement}
 */
export function panelHeader(app, { crumbs, actions = [], close }) {
  const mobile = isPanelMobile(app);
  return h(
    'header',
    { class: 'pn-header' },
    mobile ? iconButton({ icon: 'arrow-left', title: 'Voltar', onclick: () => close(), class: 'pn-back' }) : null,
    h('div', { class: 'pn-header-main' }, crumbs || null),
    h(
      'div',
      { class: 'pn-header-actions' },
      actions,
      mobile ? null : iconButton({ icon: 'x', title: 'Fechar painel', onclick: () => close(), class: 'pn-close' }),
    ),
  );
}

/**
 * Item clicável da trilha (Projeto › Demanda › Tarefa pai).
 * @param {Node|null} glyph ícone ou ponto colorido
 * @param {string} text
 * @param {(() => void)|null} onclick
 * @param {string} [title]
 * @returns {HTMLElement}
 */
export function crumb(glyph, text, onclick, title) {
  if (typeof onclick !== 'function') return h('span', { class: 'pn-crumb is-static', title: title || text }, glyph, h('span', { class: 'pn-crumb-text' }, text));
  return h('button', { type: 'button', class: 'pn-crumb', title: title || text, onclick }, glyph, h('span', { class: 'pn-crumb-text' }, text));
}

/** Trilha com separadores. */
export function crumbTrail(items) {
  const list = items.filter(Boolean);
  const nodes = [];
  list.forEach((item, index) => {
    if (index > 0) nodes.push(h('span', { class: 'pn-crumb-sep', 'aria-hidden': 'true' }, icon('chevron-right', { size: 12 })));
    nodes.push(item);
  });
  return h('nav', { class: 'pn-crumbs', 'aria-label': 'Localização' }, nodes);
}

/**
 * Linha da grade de propriedades: rótulo + controle.
 * @param {string} label
 * @param {Node|Node[]|null} control
 * @param {{ full?: boolean, hint?: string|Node, key?: string }} [options] full = ocupa as duas colunas
 * @returns {HTMLElement}
 */
export function propRow(label, control, { full = false, hint, key } = {}) {
  return h(
    'div',
    { class: cx('pn-prop', full && 'is-full'), key: key || label },
    h('span', { class: 'pn-prop-label' }, label),
    h('div', { class: 'pn-prop-value' }, control, hint ? h('span', { class: 'pn-prop-hint' }, hint) : null),
  );
}

/**
 * Seção do painel com título, contagem e ações.
 * @param {string} title
 * @param {{ count?: string|number|null, actions?: Node|Node[], icon?: string, key?: string, class?: string }} options
 * @param {...Node} children
 * @returns {HTMLElement}
 */
export function section(title, { count, actions, icon: glyph, key, class: className } = {}, ...children) {
  return h(
    'section',
    { class: cx('pn-section', className), key: key || title },
    h(
      'div',
      { class: 'pn-section-head' },
      glyph ? icon(glyph, { size: 14, class: 'pn-section-icon' }) : null,
      h('h3', { class: 'pn-section-title' }, title),
      count === null || count === undefined || count === '' ? null : h('span', { class: 'pn-section-count tabular' }, String(count)),
      actions ? h('div', { class: 'pn-section-actions' }, actions) : null,
    ),
    h('div', { class: 'pn-section-body' }, children),
  );
}

/**
 * Estado "não encontrado" (entidade excluída ou inexistente), com fechar e — se foi excluída — restaurar.
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {string} id
 * @param {() => void} close
 * @returns {HTMLElement}
 */
export function notFound(app, type, id, close) {
  const table = type === 'task' ? 'tasks' : 'demands';
  const row = hasId(id) ? app.store.get(table, id) : null;
  const deleted = !!(row && row.deleted_at);
  const noun = type === 'task' ? 'Tarefa' : 'Demanda';
  const restore = () =>
    safely(app, () => {
      if (type === 'task') app.cmd.restoreTask(id);
      else app.cmd.restoreDemand(id);
      notify(app, `${noun} restaurada`, { tone: 'success' });
    });
  return h(
    'div',
    { class: 'pn pn-missing', key: `${type}:missing:${id}` },
    panelHeader(app, { crumbs: null, close }),
    h(
      'div',
      { class: 'pn-scroll' },
      emptyState({
        icon: deleted ? 'trash' : 'search',
        title: `${noun} não encontrada`,
        text: deleted
          ? `${row && row.name ? quoted(row.name) : `Esta ${noun.toLowerCase()}`} foi excluída. Você pode restaurá-la ou fechar o painel.`
          : `Ela pode ter sido excluída em outro dispositivo ou o link está incompleto.`,
        action: [
          deleted ? button({ label: 'Restaurar', icon: 'undo', variant: 'primary', onclick: restore }) : null,
          button({ label: 'Fechar', onclick: () => close() }),
        ],
      }),
    ),
  );
}

/**
 * Editor de um campo de texto longo (descrição, objetivo, entregáveis): cresce com o conteúdo e salva ao sair.
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @param {string} field
 * @param {{ placeholder?: string, ariaLabel?: string, rows?: number }} [options]
 * @returns {HTMLTextAreaElement}
 */
export function longTextField(app, type, entity, field, { placeholder = 'Adicione um texto…', ariaLabel, rows = 2 } = {}) {
  return textArea({
    value: entity[field] || '',
    placeholder,
    rows,
    autoGrow: true,
    ariaLabel: ariaLabel || placeholder,
    class: 'pn-textarea',
    attrs: { 'data-field': field },
    onchange: (text) => {
      const next = text.trim() ? text : null;
      if ((entity[field] || null) === next) return;
      saveFields(app, type, entity.id, { [field]: next });
    },
  });
}

/** Instante ISO → valor de <input type="datetime-local"> (hora local). */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Editor do início real (data e hora local).
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @returns {HTMLElement}
 */
export function actualStartField(app, type, entity) {
  return h(
    'span',
    { class: 'input input-sm pn-datetime' },
    h('input', {
      class: 'input-el tabular',
      type: 'datetime-local',
      'aria-label': 'Início real',
      value: toLocalInput(entity.actual_start),
      onchange: (ev) => {
        const raw = ev.currentTarget.value;
        let next = null;
        if (raw) {
          const d = new Date(raw); // interpretação do texto digitado (hora local), não "agora"
          if (Number.isNaN(d.getTime())) return;
          next = d.toISOString();
        }
        saveFields(app, type, entity.id, { actual_start: next });
      },
    }),
  );
}

/**
 * Alertas de impedimento editáveis ("Qual o impedimento?" / "Aguardando quem ou o quê?").
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @returns {HTMLElement|null}
 */
export function impedimentAlert(app, type, entity) {
  const category = app.sel.status(entity.status).category;
  if (category !== 'blocked' && category !== 'waiting') return null;
  const field = category === 'blocked' ? 'blocked_reason' : 'waiting_on';
  const question = category === 'blocked' ? 'Qual o impedimento?' : 'Aguardando quem ou o quê?';
  return alertBox({
    tone: category === 'blocked' ? 'danger' : 'warning',
    icon: category === 'blocked' ? 'ban' : 'hourglass',
    title: question,
    class: 'pn-impediment',
    text: inlineEdit({
      value: entity[field] || '',
      placeholder: category === 'blocked' ? 'Descreva o impedimento' : 'De quem ou do quê você está esperando?',
      ariaLabel: question,
      allowEmpty: true,
      class: 'pn-impediment-edit',
      onsave: (text) => safely(app, () => app.cmd.setStatus(type, entity.id, entity.status, { [field]: text })),
    }),
  });
}

/**
 * Aviso de item arquivado, com "Desarquivar".
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @returns {HTMLElement|null}
 */
export function archivedAlert(app, type, entity) {
  if (!app.sel.isHidden(type, entity)) return null;
  const own = !!entity.archived_at;
  const noun = type === 'task' ? 'tarefa' : 'demanda';
  return alertBox({
    tone: 'neutral',
    icon: 'archive',
    text: own ? `Esta ${noun} está arquivada.` : `Esta ${noun} está arquivada junto com ${type === 'task' ? 'a demanda ou a tarefa principal' : 'o projeto'}.`,
    actions: own ? button({ label: 'Desarquivar', size: 'sm', onclick: () => entityActions.archive(app, type, entity.id) }) : null,
  });
}

/**
 * Observações: compositor (Ctrl+Enter salva) e lista da mais nova para a mais antiga, com editar e excluir.
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {string} id
 * @returns {HTMLElement}
 */
export function notesSection(app, type, id) {
  const notes = app.sel.notes(type, id);
  const submit = (anchor) => {
    const root = anchor && anchor.closest ? anchor.closest('.pn-notes') : null;
    const field = root ? root.querySelector('.pn-note-composer textarea') : null;
    if (!field) return;
    const text = field.value.trim();
    if (!text) {
      field.focus();
      return;
    }
    const note = safely(app, () => app.cmd.addNote(type, id, text));
    if (note) {
      field.value = '';
      field.style.height = '';
      field.focus({ preventScroll: true });
    }
  };
  const remove = async (note) => {
    const ok = await confirmDialog({ title: 'Excluir observação?', message: 'A observação será removida desta lista.', confirmLabel: 'Excluir', danger: true });
    if (ok) safely(app, () => app.cmd.deleteNote(note.id));
  };
  return section(
    'Observações',
    { count: notes.length || null, icon: 'message', class: 'pn-notes', key: 'notes' },
    h(
      'div',
      { class: 'pn-note-composer' },
      textArea({
        placeholder: 'Escreva uma observação…',
        rows: 2,
        autoGrow: true,
        ariaLabel: 'Nova observação',
        onsubmit: (text, ev) => submit(ev.currentTarget),
      }),
      h(
        'div',
        { class: 'pn-note-composer-foot' },
        h('span', { class: 'pn-hint' }, 'Ctrl+Enter para salvar'),
        button({ label: 'Adicionar', size: 'sm', icon: 'plus', onclick: (ev) => submit(ev.currentTarget), class: 'pn-note-add' }),
      ),
    ),
    notes.length
      ? h(
          'ul',
          { class: 'pn-note-list' },
          notes.map((note) =>
            h(
              'li',
              { class: 'pn-note', key: note.id },
              h(
                'div',
                { class: 'pn-note-head' },
                h('span', { class: 'pn-note-date tabular' }, formatDateTime(note.created_at) || '—'),
                note.updated_at && note.created_at && note.updated_at > note.created_at ? h('span', { class: 'pn-note-edited' }, 'editada') : null,
                h(
                  'span',
                  { class: 'pn-note-actions' },
                  iconButton({
                    icon: 'pencil',
                    title: 'Editar observação',
                    size: 'sm',
                    onclick: (ev) => {
                      const view = ev.currentTarget.closest('.pn-note').querySelector('.inline-edit-view');
                      if (view) view.click();
                    },
                  }),
                  iconButton({ icon: 'trash', title: 'Excluir observação', size: 'sm', onclick: () => remove(note) }),
                ),
              ),
              inlineEdit({ value: note.body || '', multiline: true, ariaLabel: 'Observação', class: 'pn-note-body', onsave: (text) => safely(app, () => app.cmd.updateNote(note.id, text)) }),
            ),
          ),
        )
      : h('p', { class: 'pn-empty-line' }, 'Nenhuma observação ainda.'),
  );
}

/** Rótulo do dia na linha do tempo ("Hoje", "Ontem", "seg, 23 nov"). */
function dayLabel(date, today) {
  if (!date) return 'Sem data';
  if (date === today) return 'Hoje';
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const pad = (n) => String(n).padStart(2, '0');
  const yesterday = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (date === yesterday) return 'Ontem';
  return formatDate(date, 'weekday', today);
}

/**
 * Aba Histórico: linha do tempo agrupada por dia (sel.history + describeEvent). Alterações de descrição podem
 * expandir o texto anterior.
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {string} id
 * @param {{ state: object, setState: Function }} pctx
 * @returns {HTMLElement}
 */
export function historyTab(app, type, id, { state, setState }) {
  const events = app.sel.history(type, id);
  if (!events.length) return h('div', { class: 'pn-tab pn-history', key: 'history' }, emptyState({ icon: 'clock', title: 'Sem histórico', text: 'As alterações aparecem aqui.', compact: true }));
  const today = app.clock.today();
  const ctx = { statuses: app.sel.statuses(), tasksById: app.sel.tasksById(), demandsById: app.sel.demandsById(), projectsById: app.sel.projectsById(), today };
  const expanded = state.historyOpen && typeof state.historyOpen === 'object' ? state.historyOpen : {};
  return h(
    'div',
    { class: 'pn-tab pn-history', key: 'history' },
    groupByDay(events).map((group) =>
      h(
        'section',
        { class: 'pn-day', key: group.date || 'sem-data' },
        h('h4', { class: 'pn-day-title' }, dayLabel(group.date, today)),
        h(
          'ol',
          { class: 'pn-timeline' },
          group.events.map((ev) => {
            const info = describeEvent(ev, ctx);
            const canExpand = ev.action === ACTIONS.DESCRIPTION && typeof ev.old_value === 'string' && ev.old_value.trim() !== '';
            const open = canExpand && expanded[ev.id] === true;
            return h(
              'li',
              { class: cx('pn-event', `pn-event-${info.tone || 'default'}`), key: ev.id },
              h('span', { class: 'pn-event-icon', 'aria-hidden': 'true' }, icon(info.icon || 'pencil', { size: 14 })),
              h(
                'div',
                { class: 'pn-event-body' },
                h('div', { class: 'pn-event-text' }, info.text),
                info.detail && !open ? h('div', { class: 'pn-event-detail' }, info.detail) : null,
                open ? h('div', { class: 'pn-event-previous' }, ev.old_value) : null,
                canExpand
                  ? h(
                      'button',
                      { type: 'button', class: 'pn-link', onclick: () => setState({ historyOpen: { ...expanded, [ev.id]: !open } }) },
                      open ? 'Ocultar texto anterior' : 'Ver texto anterior',
                    )
                  : null,
              ),
              h('time', { class: 'pn-event-time tabular', datetime: ev.at || null, title: formatDateTime(ev.at) }, formatTime(ev.at)),
            );
          }),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tarefa: cabeçalho, alertas e abas
// ---------------------------------------------------------------------------

function taskCrumbs(app, task) {
  const parent = app.sel.parentOf(task);
  const demand = app.sel.demandOf(task);
  const project = demand ? app.sel.project(demand.project_id) : null;
  const ui = app.ui || {};
  return crumbTrail([
    project
      ? crumb(projectDot(project), project.name, typeof ui.setScope === 'function' ? () => ui.setScope({ projectId: project.id }) : null, `Projeto ${project.name}`)
      : null,
    demand
      ? crumb(icon('layers', { size: 14 }), demand.name, () => entityActions.open(app, 'demand', demand.id), `Abrir a demanda ${quoted(demand.name)}`)
      : crumb(icon('inbox', { size: 14 }), 'Tarefa avulsa', null, 'Esta tarefa não pertence a uma demanda'),
    parent ? crumb(icon('list', { size: 14 }), parent.name, () => entityActions.open(app, 'task', parent.id), `Abrir a tarefa principal ${quoted(parent.name)}`) : null,
  ]);
}

function taskAlerts(app, task) {
  const category = app.sel.status(task.status).category;
  const open = !isClosedCategory(category);
  const list = [archivedAlert(app, 'task', task)];
  if (open) {
    const blockers = app.sel.blockers(task.id);
    if (blockers.length) {
      list.push(
        alertBox({
          tone: 'danger',
          icon: 'lock',
          title: blockers.length === 1 ? 'Bloqueada por dependência' : `Bloqueada por ${blockers.length} dependências`,
          class: 'pn-alert-blockers',
          text: h(
            'span',
            { class: 'pn-inline-list' },
            'Aguardando a conclusão de ',
            blockers.map((t, i) => [
              i > 0 ? (i === blockers.length - 1 ? ' e ' : ', ') : null,
              h('button', { type: 'button', class: 'pn-link', onclick: () => entityActions.open(app, 'task', t.id) }, quoted(nameOf(t))),
            ]),
            '.',
          ),
        }),
      );
    }
    const conflicts = app.sel.conflictsOf(task.id);
    if (conflicts.length) {
      list.push(
        alertBox({
          tone: conflicts.some((c) => c.severity === 'danger') ? 'danger' : 'warning',
          title: conflicts.length === 1 ? 'Conflito de prazo' : `${conflicts.length} conflitos de prazo`,
          class: 'pn-alert-conflicts',
          text: h('ul', { class: 'pn-alert-list' }, conflicts.map((c, i) => h('li', { key: `${c.type}:${c.prereqId || i}` }, c.message))),
        }),
      );
    }
    const suggestion = app.sel.suggestionFor(task.id);
    if (suggestion) {
      list.push(
        alertBox({
          tone: 'accent',
          icon: 'sparkles',
          title: `Sugestão: prioridade ${suggestion.suggested} (hoje ${suggestion.current || task.priority})`,
          text: suggestion.justification || null,
          class: 'pn-alert-suggestion',
          actions: [
            button({ label: 'Aplicar', size: 'sm', variant: 'primary', onclick: () => safely(app, () => app.cmd.applySuggestion(suggestion)) }),
            button({ label: 'Dispensar', size: 'sm', variant: 'ghost', onclick: () => safely(app, () => app.cmd.dismissSuggestion(suggestion.signature)) }),
          ],
        }),
      );
    }
    list.push(impedimentAlert(app, 'task', task));
    const demand = app.sel.demandOf(task);
    if (demand && app.sel.status(demand.status).category === 'done') {
      list.push(
        alertBox({
          tone: 'info',
          text: `A demanda ${quoted(nameOf(demand))} já está concluída, mas esta tarefa continua aberta.`,
          actions: button({ label: 'Abrir demanda', size: 'sm', onclick: () => entityActions.open(app, 'demand', demand.id) }),
        }),
      );
    }
  }
  const nodes = list.filter(Boolean);
  return nodes.length ? h('div', { class: 'pn-alerts' }, nodes) : null;
}

/** Peso efetivo (em %) desta tarefa entre os irmãos contáveis — dica do campo "Peso". */
function effectiveWeightOf(app, task) {
  const parent = app.sel.parentOf(task);
  const demand = app.sel.demandOf(task);
  if (parent || !demand) return null;
  const progress = app.sel.demandProgress(demand.id);
  const item = progress.items.find((it) => it.id === task.id);
  return item ? Math.round(item.weight * 1000) / 10 : null;
}

function trackedField(app, task) {
  const tracked = app.sel.trackedSeconds(task.id);
  const cmp = estimateVsActual(task.estimate_minutes, tracked);
  const tone = cmp.state === 'over' ? 'danger' : cmp.state === 'on' ? 'success' : 'neutral';
  const label =
    cmp.state === 'none' || tracked === 0
      ? null
      : cmp.state === 'over'
        ? `${formatDuration(cmp.diffSeconds)} acima`
        : cmp.state === 'on'
          ? 'Dentro da estimativa'
          : `${formatDuration(-cmp.diffSeconds)} abaixo`;
  return h(
    'span',
    { class: 'pn-tracked' },
    h('span', { class: 'pn-tracked-value tabular' }, formatDuration(tracked)),
    label ? badge(label, { tone }) : null,
    cmp.ratio !== null && tracked > 0 ? progressBar(Math.min(1, cmp.ratio), { size: 'sm', tone: cmp.state === 'over' ? 'danger' : 'accent', title: `${Math.round(cmp.ratio * 100)}% da estimativa` }) : null,
  );
}

function detailsGrid(app, task) {
  const weight = effectiveWeightOf(app, task);
  return h(
    'div',
    { class: 'pn-props' },
    propRow('Status', statusControl(app, 'task', task, { soft: true })),
    propRow('Prioridade', priorityControl(app, 'task', task, { showLabel: true })),
    propRow('Responsável', ownerControl(app, 'task', task)),
    propRow('Prazo', dueControl(app, 'task', task, { placeholder: 'Sem prazo' })),
    propRow('Início planejado', dueControl(app, 'task', task, { field: 'planned_start', placeholder: 'Sem data' })),
    propRow('Início real', actualStartField(app, 'task', task)),
    propRow('Conclusão', h('span', { class: cx('pn-static tabular', !task.completed_at && 'is-empty') }, task.completed_at ? formatDateTime(task.completed_at) : '—')),
    propRow('Criação', h('span', { class: cx('pn-static tabular', !task.created_at && 'is-empty') }, formatDateTime(task.created_at) || '—')),
    propRow('Estimativa', estimateControl(app, 'task', task)),
    propRow('Tempo gasto', trackedField(app, task)),
    propRow('Demanda', demandControl(app, task)),
    propRow(
      'Peso',
      numberInput({
        value: task.weight === null || task.weight === undefined ? null : task.weight,
        min: 0,
        max: 100,
        step: 5,
        suffix: '%',
        size: 'sm',
        ariaLabel: 'Peso (%)',
        placeholder: weight === null ? 'auto' : String(weight).replace('.', ','),
        class: 'pn-weight',
        onchange: (n) => saveFields(app, 'task', task.id, { weight: n && n > 0 ? n : null }),
      }),
      { hint: task.weight ? null : weight === null ? null : 'automático' },
    ),
    propRow(
      'Obrigatória',
      switchInput({
        checked: task.required !== false,
        label: 'Entra no cálculo de progresso',
        onchange: (checked) => saveFields(app, 'task', task.id, { required: checked }),
      }),
    ),
    propRow('Tags', tagsControl(app, 'task', task), { full: true }),
  );
}

function subtasksSection(app, task) {
  if (app.sel.parentOf(task)) return null;
  const statuses = app.sel.statuses();
  const subs = app.sel.subtasks(task.id);
  const countable = subs.filter((s) => isCountable(s, statuses));
  const done = countable.filter((s) => app.sel.status(s.status).category === 'done').length;
  const fraction = app.sel.taskFraction(task.id);
  const onmove = ({ id, place }) => safely(app, () => app.cmd.moveTask(id, place));
  return section(
    'Subtarefas',
    {
      count: countable.length ? `${done}/${countable.length}` : null,
      icon: 'list',
      key: 'subtasks',
      class: 'pn-subtasks',
      actions: countable.length ? progressBar(fraction.value, { size: 'sm', title: `${done} de ${plural(countable.length, 'subtarefa concluída', 'subtarefas concluídas')}` }) : null,
    },
    subs.length
      ? h(
          'div',
          { class: 'pn-rows', ...sortableList({ type: `sub:${task.id}` }) },
          subs.map((sub) =>
            taskRow(app, sub, {
              columns: ['grip', 'check', 'title-edit', 'flags', 'status-compact', 'due', 'open', 'menu'],
              class: 'pn-subtask',
              attrs: sortableItem({ type: `sub:${task.id}`, id: sub.id, onmove, handle: '.en-grip' }),
            }),
          ),
        )
      : null,
    quickAddRow(app, { type: 'task', defaults: { parent_id: task.id }, placeholder: 'Adicionar subtarefa', class: 'pn-quickadd' }),
  );
}

/** Abre a lista pesquisável de tarefas para escolher um pré-requisito. */
async function addDependency(app, task, anchor, setState) {
  const graph = app.sel.graph();
  const tasksById = app.sel.tasksById();
  const demand = app.sel.demandOf(task);
  const demands = app.sel.demandsById();
  const prereqIds = new Set(app.sel.prereqs(task.id).map((t) => t.id));
  const reasonHint = { cycle: 'Criaria um ciclo', hierarchy: 'Subtarefa/principal', duplicate: 'Já é pré-requisito' };
  const candidates = app.sel
    .tasks()
    .filter((t) => t.id !== task.id && !prereqIds.has(t.id))
    .map((t) => {
      const own = app.sel.demandOf(t);
      const check = validateNewDependency(task.id, t.id, { graph, tasksById });
      if (!check.ok && check.reason === 'missing') return null;
      const same = demand ? own && own.id === demand.id : !own;
      return {
        task: t,
        same,
        open: app.sel.isOpen(t),
        group: same ? (demand ? 'Desta demanda' : 'Tarefas avulsas') : own && demands.get(own.id) ? own.name : 'Tarefas avulsas',
        hint: check.ok ? app.sel.status(t.status).label : reasonHint[check.reason] || 'Inválida',
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.same) - Number(a.same) || Number(b.open) - Number(a.open) || a.group.localeCompare(b.group, 'pt-BR') || nameOf(a.task).localeCompare(nameOf(b.task), 'pt-BR'));
  const chosen = await pickFromList(anchor, {
    items: candidates.map((c) => ({ id: c.task.id, label: `${app.sel.code('task', c.task)} ${nameOf(c.task)}`.trim(), hint: c.hint, group: c.group })),
    placeholder: 'Buscar tarefa…',
    title: 'Depende de…',
    width: 340,
  });
  if (chosen === null || chosen === '') return;
  try {
    app.cmd.addDependency(task.id, chosen);
    setState({ depError: null });
  } catch (err) {
    if (isCommandError(err)) {
      setState({ depError: err.message });
      notify(app, err.message, { tone: 'danger', duration: 7000 });
    } else handleError(app, err);
  }
}

function dependencyRow(app, other, onremove, removeTitle) {
  return h(
    'div',
    { class: 'pn-dep', key: other.id, dataset: { entity: `task:${other.id}` } },
    statusBadge(app.sel.status(other.status), { compact: true }),
    entityTitle(app, 'task', other),
    dueControl(app, 'task', other, { compact: true }),
    iconButton({ icon: 'x', title: removeTitle, size: 'sm', onclick: onremove, class: 'pn-dep-remove' }),
  );
}

function dependenciesSection(app, task, { state, setState }) {
  const prereqs = app.sel.prereqs(task.id);
  const dependents = app.sel.dependents(task.id);
  const ui = app.ui || {};
  return section(
    'Dependências',
    {
      icon: 'link',
      key: 'deps',
      class: 'pn-deps',
      actions: typeof ui.navigate === 'function' ? button({ label: 'Ver no diagrama', icon: 'git-branch', size: 'sm', variant: 'ghost', onclick: () => ui.navigate('/dependencias', { focus: task.id }) }) : null,
    },
    h('div', { class: 'pn-sub-head' }, h('span', null, 'Depende de'), prereqs.length ? h('span', { class: 'pn-section-count tabular' }, String(prereqs.length)) : null),
    prereqs.length
      ? h('div', { class: 'pn-dep-list' }, prereqs.map((p) => dependencyRow(app, p, () => safely(app, () => app.cmd.removeDependency(task.id, p.id)), 'Remover dependência')))
      : h('p', { class: 'pn-empty-line' }, 'Nenhum pré-requisito.'),
    state.depError ? alertBox({ tone: 'danger', text: state.depError, class: 'pn-dep-error', ondismiss: () => setState({ depError: null }) }) : null,
    button({ label: 'Adicionar pré-requisito', icon: 'plus', size: 'sm', variant: 'ghost', class: 'pn-dep-add', onclick: (ev) => addDependency(app, task, ev.currentTarget, setState) }),
    h('div', { class: 'pn-sub-head' }, h('span', null, 'Bloqueia'), dependents.length ? h('span', { class: 'pn-section-count tabular' }, String(dependents.length)) : null),
    dependents.length
      ? h('div', { class: 'pn-dep-list' }, dependents.map((d) => dependencyRow(app, d, () => safely(app, () => app.cmd.removeDependency(d.id, task.id)), 'Remover esta dependência')))
      : h('p', { class: 'pn-empty-line' }, 'Nenhuma tarefa depende desta.'),
  );
}

function detailsTab(app, task, pctx) {
  return h(
    'div',
    { class: 'pn-tab pn-details', key: 'details' },
    detailsGrid(app, task),
    section('Descrição', { icon: 'file-text', key: 'description' }, longTextField(app, 'task', task, 'description', { placeholder: 'Adicione uma descrição…', ariaLabel: 'Descrição', rows: 3 })),
    subtasksSection(app, task),
    dependenciesSection(app, task, pctx),
    notesSection(app, 'task', task.id),
  );
}

// ---------------------------------------------------------------------------
// Aba Tempo
// ---------------------------------------------------------------------------

/** Campo de formulário com valor inicial aplicado UMA vez (depois o que o usuário digita é preservado). */
function initial(value) {
  return (el) => {
    if (el.__pnInit) return;
    el.__pnInit = true;
    if (value !== null && value !== undefined) el.value = value;
  };
}

function formField(label, control, className) {
  return h('label', { class: cx('pn-form-field', className) }, h('span', { class: 'pn-form-label' }, label), control);
}

function plainInput(name, { type = 'text', placeholder, init, ariaLabel, className } = {}) {
  return h(
    'span',
    { class: cx('input', 'input-sm', className) },
    h('input', { class: 'input-el tabular', name, type, placeholder: placeholder || null, 'aria-label': ariaLabel || null, autocomplete: 'off', ref: initial(init) }),
  );
}

/** Lê o formulário de horas: devolve { input } ou { error }. */
function readTimeForm(form, taskId, today) {
  const get = (name) => {
    const el = form.elements.namedItem(name);
    return el && typeof el.value === 'string' ? el.value.trim() : '';
  };
  const durationText = get('duration');
  let durationMinutes;
  if (durationText) {
    const minutes = parseDurationText(durationText);
    if (minutes === null || minutes <= 0) return { error: 'Duração inválida. Exemplos: 45min, 1h30, 1,5h.' };
    durationMinutes = minutes;
  }
  return {
    input: {
      task_id: taskId,
      date: get('date') || today,
      start: get('start') || undefined,
      end: get('end') || undefined,
      durationMinutes,
      description: get('description') || undefined,
    },
  };
}

function overlapText(app, overlaps) {
  const items = (Array.isArray(overlaps) ? overlaps : []).map((o) => o && o.b).filter(Boolean);
  if (!items.length) return 'Este horário se sobrepõe a outro apontamento.';
  const parts = items.slice(0, 3).map((entry) => {
    const task = app.store.get('tasks', entry.task_id);
    const span = entry.started_at ? `${formatTime(entry.started_at)}–${entry.ended_at ? formatTime(entry.ended_at) : 'agora'}` : 'sem horário';
    return `${span} em ${task ? quoted(nameOf(task)) : 'outra tarefa'}`;
  });
  return `Este horário se sobrepõe a ${items.length === 1 ? 'outro apontamento' : `${items.length} apontamentos`}: ${parts.join('; ')}.`;
}

function addHoursForm(app, task, { state, setState }) {
  const today = app.clock.today();
  const pending = state.timeOverlap && state.timeOverlap.mode === 'add' ? state.timeOverlap : null;
  const finish = (form, entry) => {
    form.reset();
    const date = form.elements.namedItem('date');
    if (date) date.value = today;
    setState({ timeError: null, timeOverlap: null });
    notify(app, `Horas registradas: ${formatDuration(entry.duration_seconds)}`, { tone: 'success' });
  };
  const submit = (form, input, allowOverlap) => {
    try {
      const entry = app.cmd.addManualTime(input, { allowOverlap });
      finish(form, entry);
    } catch (err) {
      if (isCommandError(err) && err.code === 'overlap') setState({ timeError: null, timeOverlap: { mode: 'add', input, text: overlapText(app, err.data && err.data.overlaps) } });
      else if (isCommandError(err)) setState({ timeError: err.message, timeOverlap: null });
      else handleError(app, err);
    }
  };
  return h(
    'form',
    {
      class: 'pn-time-form',
      key: 'add-hours',
      onsubmit: (ev) => {
        ev.preventDefault();
        const form = ev.currentTarget;
        const read = readTimeForm(form, task.id, today);
        if (read.error) setState({ timeError: read.error, timeOverlap: null });
        else submit(form, read.input, false);
      },
    },
    h('div', { class: 'pn-form-title' }, icon('plus', { size: 14 }), 'Adicionar horas'),
    h(
      'div',
      { class: 'pn-form-grid' },
      formField('Data', plainInput('date', { type: 'date', init: today, ariaLabel: 'Data' }), 'is-date'),
      formField('Início', plainInput('start', { type: 'time', ariaLabel: 'Início' })),
      formField('Fim', plainInput('end', { type: 'time', ariaLabel: 'Fim' })),
      h('span', { class: 'pn-form-or', 'aria-hidden': 'true' }, 'ou'),
      formField('Duração', plainInput('duration', { placeholder: 'ex.: 1h30', ariaLabel: 'Duração' })),
      formField('Descrição', plainInput('description', { placeholder: 'O que foi feito? (opcional)', ariaLabel: 'Descrição' }), 'is-wide'),
    ),
    state.timeError ? h('p', { class: 'field-error pn-form-error', role: 'alert' }, icon('alert-circle', { size: 12 }), h('span', null, state.timeError)) : null,
    pending
      ? alertBox({
          tone: 'warning',
          title: 'Horário sobreposto',
          text: pending.text,
          class: 'pn-overlap',
          actions: [
            button({
              label: 'Registrar mesmo assim',
              size: 'sm',
              variant: 'primary',
              onclick: (ev) => submit(ev.currentTarget.closest('form'), pending.input, true),
            }),
            button({ label: 'Ajustar', size: 'sm', variant: 'ghost', onclick: () => setState({ timeOverlap: null }) }),
          ],
        })
      : null,
    h('div', { class: 'pn-form-actions' }, button({ label: 'Registrar', type: 'submit', size: 'sm', variant: 'primary', icon: 'check', class: 'pn-time-submit' })),
  );
}

function editEntryForm(app, entry, { state, setState }) {
  const open = timerState(entry) !== TIMER.DONE;
  const pending = state.timeOverlap && state.timeOverlap.mode === 'edit' && state.timeOverlap.id === entry.id ? state.timeOverlap : null;
  const save = (patch, allowOverlap) => {
    try {
      app.cmd.updateTimeEntry(entry.id, patch, { allowOverlap });
      setState({ editEntry: null, timeOverlap: null, editError: null });
    } catch (err) {
      if (isCommandError(err) && err.code === 'overlap') setState({ timeOverlap: { mode: 'edit', id: entry.id, input: patch, text: overlapText(app, err.data && err.data.overlaps) } });
      else if (isCommandError(err)) setState({ editError: err.message });
      else handleError(app, err);
    }
  };
  const date = entry.entry_date || isoToDateStr(entry.started_at) || app.clock.today();
  return h(
    'form',
    {
      class: 'pn-time-form is-edit',
      key: `edit:${entry.id}`,
      onsubmit: (ev) => {
        ev.preventDefault();
        const form = ev.currentTarget;
        const get = (name) => {
          const el = form.elements.namedItem(name);
          return el && typeof el.value === 'string' ? el.value.trim() : '';
        };
        if (open) {
          save({ description: get('description') || null }, false);
          return;
        }
        const patch = { description: get('description') || null, date: get('date') || date };
        const start = get('start');
        const end = get('end');
        const durationText = get('duration');
        if (durationText) {
          const minutes = parseDurationText(durationText);
          if (minutes === null || minutes <= 0) {
            setState({ editError: 'Duração inválida. Exemplos: 45min, 1h30, 1,5h.' });
            return;
          }
          if (minutes !== Math.round((entry.duration_seconds || 0) / 60) || !end) patch.durationMinutes = minutes;
        }
        const oldStart = entry.started_at ? formatTime(entry.started_at) : '';
        const oldEnd = entry.ended_at ? formatTime(entry.ended_at) : '';
        if (start !== oldStart) patch.start = start || null;
        if (end !== oldEnd) patch.end = end || null;
        save(patch, false);
      },
    },
    h('div', { class: 'pn-form-title' }, icon('pencil', { size: 14 }), open ? 'Descrição do cronômetro' : 'Editar apontamento'),
    h(
      'div',
      { class: 'pn-form-grid' },
      open ? null : formField('Data', plainInput('date', { type: 'date', init: date, ariaLabel: 'Data' }), 'is-date'),
      open ? null : formField('Início', plainInput('start', { type: 'time', init: entry.started_at ? formatTime(entry.started_at) : '', ariaLabel: 'Início' })),
      open ? null : formField('Fim', plainInput('end', { type: 'time', init: entry.ended_at ? formatTime(entry.ended_at) : '', ariaLabel: 'Fim' })),
      open ? null : h('span', { class: 'pn-form-or', 'aria-hidden': 'true' }, 'ou'),
      open ? null : formField('Duração', plainInput('duration', { init: formatDurationText(Math.round((entry.duration_seconds || 0) / 60)), ariaLabel: 'Duração' })),
      formField('Descrição', plainInput('description', { init: entry.description || '', placeholder: 'O que foi feito?', ariaLabel: 'Descrição' }), 'is-wide'),
    ),
    state.editError ? h('p', { class: 'field-error pn-form-error', role: 'alert' }, icon('alert-circle', { size: 12 }), h('span', null, state.editError)) : null,
    pending
      ? alertBox({
          tone: 'warning',
          title: 'Horário sobreposto',
          text: pending.text,
          actions: [button({ label: 'Salvar mesmo assim', size: 'sm', variant: 'primary', onclick: () => save(pending.input, true) })],
        })
      : null,
    h(
      'div',
      { class: 'pn-form-actions' },
      button({ label: 'Cancelar', size: 'sm', variant: 'ghost', onclick: () => setState({ editEntry: null, timeOverlap: null, editError: null }) }),
      button({ label: 'Salvar', type: 'submit', size: 'sm', variant: 'primary' }),
    ),
  );
}

function entryRow(app, entry, pctx) {
  if (pctx.state.editEntry === entry.id) return editEntryForm(app, entry, pctx);
  const state = timerState(entry);
  const date = entry.entry_date || isoToDateStr(entry.started_at);
  const span = entry.started_at ? `${formatTime(entry.started_at)}–${state === TIMER.RUNNING ? 'agora' : entry.ended_at ? formatTime(entry.ended_at) : '?'}` : 'Sem horário';
  const remove = async () => {
    const ok = await confirmDialog({
      title: 'Excluir apontamento?',
      message: `${formatDuration(elapsedSeconds(entry, app.clock.now().getTime()))}${date ? ` em ${formatDate(date, 'long')}` : ''} sairá do total da tarefa.`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (ok) safely(app, () => app.cmd.deleteTimeEntry(entry.id));
  };
  return h(
    'li',
    { class: cx('pn-entry', state !== TIMER.DONE && 'is-open'), key: entry.id },
    h('div', { class: 'pn-entry-when' }, h('span', { class: 'pn-entry-date' }, date ? formatDate(date, 'weekday', app.clock.today()) : '—'), h('span', { class: 'pn-entry-span tabular' }, span)),
    h(
      'div',
      { class: 'pn-entry-main' },
      h('span', { class: cx('pn-entry-desc', !entry.description && 'is-empty') }, entry.description || 'Sem descrição'),
      h(
        'span',
        { class: 'pn-entry-tags' },
        state === TIMER.RUNNING ? badge('Rodando', { tone: 'info', icon: 'play' }) : state === TIMER.PAUSED ? badge('Pausado', { tone: 'warning', icon: 'pause' }) : null,
        badge(entry.source === 'timer' ? 'Cronômetro' : 'Manual', { tone: 'neutral', icon: entry.source === 'timer' ? 'timer' : 'pencil' }),
      ),
    ),
    state === TIMER.DONE ? h('span', { class: 'pn-entry-duration tabular' }, formatDuration(entry.duration_seconds)) : liveElapsed(app, entry, { class: 'pn-entry-duration' }),
    h(
      'span',
      { class: 'pn-entry-actions' },
      iconButton({ icon: 'pencil', title: 'Editar apontamento', size: 'sm', onclick: () => pctx.setState({ editEntry: entry.id, timeOverlap: null, editError: null }) }),
      iconButton({ icon: 'trash', title: 'Excluir apontamento', size: 'sm', onclick: remove }),
    ),
  );
}

function stat(label, value, { tone = 'neutral', hint } = {}) {
  return h('div', { class: cx('pn-stat', `pn-stat-${tone}`) }, h('span', { class: 'pn-stat-label' }, label), h('span', { class: 'pn-stat-value tabular' }, value), hint ? h('span', { class: 'pn-stat-hint' }, hint) : null);
}

function timeTab(app, task, pctx) {
  const entries = app.sel.entriesOfTask(task.id);
  const tracked = app.sel.trackedSeconds(task.id);
  const withSubs = app.sel.trackedSeconds(task.id, { withSubtasks: true });
  const cmp = estimateVsActual(task.estimate_minutes, tracked);
  const diff = cmp.state === 'none' ? '—' : `${cmp.diffSeconds > 0 ? '+' : ''}${formatDuration(cmp.diffSeconds)}`;
  return h(
    'div',
    { class: 'pn-tab pn-time', key: 'time' },
    h('div', { class: 'pn-timer-big' }, timerControl(app, task, { size: 'lg' })),
    h(
      'div',
      { class: 'pn-stats' },
      stat('Estimado', task.estimate_minutes ? formatDurationText(task.estimate_minutes) : '—', { hint: task.estimate_minutes ? null : 'sem estimativa' }),
      stat('Realizado', formatDuration(tracked), { hint: withSubs > tracked ? `${formatDuration(withSubs)} com subtarefas` : null }),
      stat('Diferença', diff, { tone: cmp.state === 'over' ? 'danger' : cmp.state === 'on' ? 'success' : 'neutral', hint: cmp.state === 'over' ? 'acima da estimativa' : cmp.state === 'under' ? 'abaixo da estimativa' : cmp.state === 'on' ? 'dentro da estimativa' : null }),
    ),
    addHoursForm(app, task, pctx),
    section(
      'Apontamentos',
      { count: entries.length || null, icon: 'clock', key: 'entries' },
      entries.length ? h('ul', { class: 'pn-entries' }, entries.map((entry) => entryRow(app, entry, pctx))) : h('p', { class: 'pn-empty-line' }, 'Nenhum apontamento ainda. Use o cronômetro ou adicione horas acima.'),
    ),
  );
}

// ---------------------------------------------------------------------------
// Painel
// ---------------------------------------------------------------------------

function renderTask(app, id, ctx) {
  const pctx = panelContext(ctx);
  const task = app.sel.task(id);
  if (!task) return notFound(app, 'task', id, pctx.close);
  const status = app.sel.status(task.status);
  const closed = isClosedCategory(status.category);
  const tab = TASK_TABS.includes(pctx.state.tab) ? pctx.state.tab : 'details';
  const entries = app.sel.entriesOfTask(task.id);
  const history = app.sel.history('task', task.id);
  const code = app.sel.code('task', task);
  const parent = app.sel.parentOf(task);
  const flags = entityFlags(app, 'task', task, { hideNoDemand: true });

  return h(
    'div',
    { class: cx('pn', 'pn-task', closed && 'is-closed'), key: `task:${task.id}`, dataset: { entity: `task:${task.id}` }, role: 'region', 'aria-label': `Tarefa ${code} ${nameOf(task)}`.trim() },
    panelHeader(app, {
      crumbs: taskCrumbs(app, task),
      close: pctx.close,
      actions: [
        timerControl(app, task, { compact: true }),
        button({
          label: closed ? 'Reabrir' : 'Concluir',
          icon: closed ? 'rotate-ccw' : 'check',
          size: 'sm',
          class: cx('pn-complete', status.category === 'done' && 'is-done'),
          onclick: () => entityActions.complete(app, 'task', task.id),
        }),
        iconButton({ icon: 'more-horizontal', title: 'Mais ações', onclick: (ev) => openEntityMenu(app, 'task', task.id, ev.currentTarget), class: 'pn-menu' }),
      ],
    }),
    h(
      'div',
      { class: 'pn-scroll' },
      h(
        'div',
        { class: 'pn-titlebar' },
        checkControl(app, task),
        code ? h('span', { class: 'pn-code tabular' }, code) : null,
        h('span', { class: 'pn-kind' }, parent ? 'Subtarefa' : 'Tarefa'),
        flags,
      ),
      h(
        'div',
        { class: cx('pn-title', closed && 'is-closed') },
        inlineEdit({ value: task.name, ariaLabel: 'Nome da tarefa', placeholder: 'Sem nome', class: 'pn-title-edit', onsave: (name) => saveFields(app, 'task', task.id, { name }) }),
      ),
      taskAlerts(app, task),
      tabs({
        class: 'pn-tabs',
        active: tab,
        ariaLabel: 'Seções da tarefa',
        onchange: (next) => pctx.setState({ tab: next }),
        tabs: [
          { id: 'details', label: 'Detalhes' },
          { id: 'time', label: 'Tempo', count: entries.length || null },
          { id: 'history', label: 'Histórico', count: history.length || null },
        ],
      }),
      tab === 'time' ? timeTab(app, task, pctx) : tab === 'history' ? historyTab(app, 'task', task.id, pctx) : detailsTab(app, task, pctx),
    ),
  );
}

/** Painel de tarefa: { title(app, id), render(app, id, ctx) }. */
export default {
  /**
   * Título do painel (aba do navegador, leitores de tela).
   * @param {object} app
   * @param {string} id
   * @returns {string}
   */
  title(app, id) {
    const task = app && app.sel ? app.sel.task(id) : null;
    if (!task) return 'Tarefa';
    const code = app.sel.code('task', task);
    return code ? `${code} · ${nameOf(task)}` : nameOf(task);
  },

  /**
   * Desenha o painel (função pura de renderização; a casca aplica com morph).
   * @param {object} app
   * @param {string} id
   * @param {{ state: object, setState: (patch: object) => void, close: () => void }} ctx
   * @returns {HTMLElement}
   */
  render(app, id, ctx) {
    return renderTask(app, id, ctx);
  },
};
