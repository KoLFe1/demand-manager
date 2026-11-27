// "Exportar .ics": diálogo (escopo, demandas, tarefas, concluídas) e entrega do arquivo — download via Blob
// + âncora; no celular, navigator.share({ files }) quando o navegador aceita arquivos (senão, download).
// Usado pela barra do Calendário e pela seção "Calendário externo" das Configurações.

import { h } from '../core/dom.js';
import { ICS_FILENAME, ICS_MIME, buildCalendar, collectCalendarItems } from '../domain/ics.js';
import { field, selectInput, switchInput } from './kit/controls.js';
import { openModal } from './kit/overlays.js';
import { notify } from './shared/entity.js';

const ALL = '__all__';
const NONE = '__none__';
const hasId = (id) => id !== null && id !== undefined && id !== '';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Endereço do app (base dos links dos eventos): origem + caminho, sem consulta nem hash — parâmetros de
 * desenvolvimento (?db=, ?demo=1) ou de captura não podem ir parar no calendário de outra pessoa/aparelho.
 */
export function appUrlOf(loc = window.location) {
  try {
    return `${loc.origin}${loc.pathname}`;
  } catch {
    return '';
  }
}

/**
 * Itens e texto do .ics para as opções dadas.
 * @param {object} app
 * @param {{ projectId?: string|null, includeDemands?: boolean, includeTasks?: boolean, includeDone?: boolean }} opts
 * @returns {{ items: object[], text: string }}
 */
export function buildIcsFor(app, { projectId = null, includeDemands = true, includeTasks = true, includeDone = false } = {}) {
  const { sel } = app;
  const visible = (row) => !sel.isHidden(row);
  const items = collectCalendarItems({
    demands: sel.demands().filter(visible),
    tasks: sel.tasks().filter(visible),
    projectsById: sel.projectsById(),
    demandsById: sel.demandsById(),
    statuses: sel.statuses(),
    includeDemands,
    includeTasks,
    includeDone,
    projectId,
  });
  return { items, text: buildCalendar(items, { appUrl: appUrlOf(), nowIso: app.clock.nowIso() }) };
}

/** Baixa um Blob com o nome dado (âncora temporária). */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Entrega o texto .ics: compartilha (celular, se o navegador aceitar arquivos) ou baixa.
 * @returns {Promise<'shared'|'downloaded'|'cancelled'>}
 */
export async function deliverIcs(text, { mobile = false, filename = ICS_FILENAME } = {}) {
  const blob = new Blob([text], { type: `${ICS_MIME};charset=utf-8` });
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (mobile && nav && typeof nav.canShare === 'function' && typeof nav.share === 'function' && typeof File === 'function') {
    const file = new File([blob], filename, { type: ICS_MIME });
    let ok = false;
    try {
      ok = nav.canShare({ files: [file] });
    } catch {
      ok = false;
    }
    if (ok) {
      try {
        await nav.share({ files: [file], title: 'Prazos — Demand Manager' });
        return 'shared';
      } catch (err) {
        if (err && err.name === 'AbortError') return 'cancelled';
        // outro erro: cai no download
      }
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}

/**
 * Abre o diálogo "Exportar prazos (.ics)".
 * @param {object} app
 * @param {{ projectId?: string|null }} [defaults] projeto inicial (padrão: escopo global)
 * @returns {Promise<'shared'|'downloaded'|'cancelled'|null>}
 */
export function openIcsDialog(app, defaults = {}) {
  return new Promise((resolve) => {
    const scope = app.ui && app.ui.scope && hasId(app.ui.scope.projectId) ? app.ui.scope.projectId : null;
    const initial = defaults.projectId !== undefined ? defaults.projectId : scope;
    const form = {
      project: initial === '' ? NONE : hasId(initial) && app.sel.project(initial) ? initial : ALL,
      includeDemands: true,
      includeTasks: true,
      includeDone: false,
    };
    let result = null;
    let dialog = null;
    const projectId = () => (form.project === ALL ? null : form.project === NONE ? '' : form.project);
    const preview = () => buildIcsFor(app, { projectId: projectId(), includeDemands: form.includeDemands, includeTasks: form.includeTasks, includeDone: form.includeDone });
    const set = (patch) => {
      Object.assign(form, patch);
      if (dialog) dialog.update();
    };
    const projects = app.sel.projects().filter((p) => !p.archived_at && !p.deleted_at);
    const render = () => {
      const count = preview().items.length;
      return h(
        'div',
        { class: 'ics-dialog', 'data-ics-dialog': 'true' },
        h('p', { class: 'ics-dialog-intro' }, 'Gera um arquivo de calendário com os prazos abertos (um evento de dia inteiro por prazo, com lembrete na véspera às 9h) para importar no Outlook ou no Google Agenda.'),
        field(
          { label: 'Projetos' },
          selectInput({
            value: form.project,
            ariaLabel: 'Projetos',
            attrs: { 'data-ics': 'project' },
            options: [{ value: ALL, label: 'Todos os projetos' }, ...projects.map((p) => ({ value: p.id, label: p.name })), { value: NONE, label: 'Sem projeto' }],
            onchange: (value) => set({ project: value }),
          }),
        ),
        h(
          'div',
          { class: 'ics-dialog-switches' },
          switchInput({ checked: form.includeDemands, label: 'Prazos de demandas', attrs: { 'data-ics': 'demands' }, onchange: (v) => set({ includeDemands: v }) }),
          switchInput({ checked: form.includeTasks, label: 'Prazos de tarefas', attrs: { 'data-ics': 'tasks' }, onchange: (v) => set({ includeTasks: v }) }),
          switchInput({ checked: form.includeDone, label: 'Incluir concluídas', attrs: { 'data-ics': 'done' }, onchange: (v) => set({ includeDone: v }) }),
        ),
        h('p', { class: 'ics-dialog-count', 'data-ics-count': String(count), 'aria-live': 'polite' }, count ? `${plural(count, 'evento', 'eventos')} no arquivo.` : 'Nenhum prazo com essas opções. Defina prazos nas demandas ou tarefas (ou inclua as concluídas) para exportar.'),
      );
    };
    const confirm = async (close) => {
      const { items, text } = preview();
      if (!items.length) return;
      close('export');
      try {
        result = await deliverIcs(text, { mobile: !!(app.ui && typeof app.ui.isMobile === 'function' && app.ui.isMobile()) });
        if (result !== 'cancelled') notify(app, `Calendário exportado (${plural(items.length, 'evento', 'eventos')}).`, { tone: 'success' });
      } catch (err) {
        console.error('[ics] falha ao exportar', err);
        notify(app, 'Não foi possível exportar o calendário.', { tone: 'danger' });
      }
      resolve(result);
    };
    dialog = openModal({
      title: 'Exportar prazos (.ics)',
      size: 'sm',
      class: 'ics-modal',
      render,
      actions: () => [
        { label: 'Cancelar', value: 'cancel' },
        { label: 'Exportar', icon: 'download', variant: 'primary', disabled: (form.includeDemands || form.includeTasks) === false || preview().items.length === 0, onclick: (close) => confirm(close) },
      ],
      onclose: (reason) => {
        if (reason !== 'export') resolve(null);
      },
    });
  });
}
