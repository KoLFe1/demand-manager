// Visualização "Relatório" (#/relatorio): relatório de status do período, pronto para e-mail/Teams/PDF.
//
//   • período: presets (Semana atual, Semana passada, Últimos 7 dias, Mês atual) ou personalizado (de/até);
//   • projeto: todos, sem projeto ou um projeto (o escopo global de projeto vale quando não há escolha);
//   • documento: resumo + um bloco por projeto com as seções de js/domain/report.js;
//   • ações: "Copiar texto", "Imprimir / PDF" (window.print + @media print em css/views/relatorio.css),
//     "Compartilhar" (só com navigator.share) e "Enviar por e-mail" (mailto: com o texto, cortado com
//     segurança; o texto completo vai junto para a área de transferência).
//
// Dados: app.sel.statusReport({ range, projectId }) (memorizado). Estado da tela: { preset, from, to, projectId }.

import { cx, h } from '../../core/dom.js';
import { formatDate } from '../../core/dates.js';
import { safeHref } from '../../core/safeurl.js';
import { DEFAULT_REPORT_PRESET, REPORT_PRESETS, REPORT_SECTIONS, presetRange, reportToText } from '../../domain/report.js';
import { copyToClipboard } from '../kit/clipboard.js';
import { button, dateInput, selectInput } from '../kit/controls.js';
import { emptyState } from '../kit/display.js';
import { icon } from '../kit/icons.js';
import { pickFromList } from '../kit/pickers.js';
import { notify } from '../shared/entity.js';

const ALL = '__all';
const CUSTOM = 'custom';
const PRESET_IDS = new Set(REPORT_PRESETS.map((p) => p.id));

/** Limite do corpo do mailto JÁ CODIFICADO (clientes de e-mail no Windows cortam URLs acima de ~2000). */
export const MAILTO_BODY_LIMIT = 1800;
export const MAILTO_TRUNCATED_NOTE = '(texto completo copiado)';

/**
 * Link mailto: com assunto e corpo; o corpo é cortado em fim de linha para caber em `limit` caracteres
 * codificados, com a nota "(texto completo copiado)" quando cortado.
 * @returns {{ href: string, truncated: boolean }}
 */
export function buildMailto(subject, text, limit = MAILTO_BODY_LIMIT) {
  const enc = (s) => encodeURIComponent(s);
  let body = String(text || '');
  let truncated = false;
  if (enc(body).length > limit) {
    truncated = true;
    const note = `\n…\n${MAILTO_TRUNCATED_NOTE}`;
    const budget = limit - enc(note).length;
    const lines = body.split('\n');
    let out = '';
    for (const line of lines) {
      const next = out ? `${out}\n${line}` : line;
      if (enc(next).length > budget) break;
      out = next;
    }
    if (!out) {
      // primeira linha já não cabe: corta por caracteres (sem quebrar pares substitutos)
      for (const ch of Array.from(lines[0] || '')) {
        if (enc(out + ch).length > budget) break;
        out += ch;
      }
    }
    body = out + note;
  }
  return { href: `mailto:?subject=${enc(subject)}&body=${enc(body)}`, truncated };
}

function scopeProjectId(app) {
  return (app.ui && app.ui.scope && app.ui.scope.projectId) || null;
}

/** Projeto efetivo: escolha da tela (ALL = todos; '' = sem projeto) ou o escopo global. */
function effectiveProject(app, state) {
  if (state.projectId === ALL) return null;
  if (typeof state.projectId === 'string' && (state.projectId === '' || app.sel.project(state.projectId))) return state.projectId;
  return scopeProjectId(app);
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
  if (chosen === null || chosen === undefined) return;
  onchange(chosen === '__none' ? '' : chosen);
}

/** Período efetivo a partir do estado (preset ou personalizado). */
export function rangeOf(state, today) {
  const preset = state.preset === CUSTOM || PRESET_IDS.has(state.preset) ? state.preset : DEFAULT_REPORT_PRESET;
  if (preset === CUSTOM) {
    const base = presetRange(DEFAULT_REPORT_PRESET, today);
    const from = typeof state.from === 'string' && state.from ? state.from : base.from;
    const to = typeof state.to === 'string' && state.to ? state.to : base.to;
    return { preset, range: from <= to ? { from, to } : { from: to, to: from } };
  }
  return { preset, range: presetRange(preset, today) };
}

const canShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

async function copyText(app, text, message = 'Texto do relatório copiado.') {
  const ok = await copyToClipboard(text, window);
  notify(app, ok ? message : 'Não foi possível copiar o texto.', { tone: ok ? 'success' : 'danger' });
  return ok;
}

function itemView(app, item) {
  return h(
    'li',
    { key: item.key, class: 'v-rel-item', 'data-entity': item.key },
    h(
      'a',
      {
        href: safeHref(`#/relatorio?panel=${item.type}:${encodeURIComponent(item.id)}`),
        class: 'v-rel-item-link',
        title: 'Abrir',
        onclick: (ev) => {
          ev.preventDefault();
          app.ui.openPanel(item.type, item.id);
        },
      },
      item.code ? h('span', { class: 'v-rel-code tabular' }, item.code) : null,
      h('span', { class: 'v-rel-name' }, item.name),
      item.type === 'task' && item.demandName ? h('span', { class: 'v-rel-demand' }, ` (${item.demandName})`) : null,
    ),
    item.detail ? h('span', { class: 'v-rel-detail' }, ` — ${item.detail}`) : null,
  );
}

function projectView(app, project) {
  return h(
    'section',
    { class: 'v-rel-project', key: `p:${project.id || '-'}`, 'data-project': project.id || '' },
    h('h2', { class: 'v-rel-project-title' }, project.name),
    REPORT_SECTIONS.map((section) => {
      const items = project.sections[section.id];
      if (!items.length) return null;
      return h(
        'div',
        { class: cx('v-rel-section', `is-${section.id}`), key: section.id, 'data-section': section.id },
        h('h3', { class: 'v-rel-section-title' }, section.title, h('span', { class: 'v-rel-count tabular' }, String(items.length))),
        h('ul', { class: 'v-rel-list' }, items.map((item) => itemView(app, item))),
      );
    }),
  );
}

export default {
  id: 'relatorio',
  title: 'Relatório',
  icon: 'file-text',
  section: 'analysis',

  render(app, ctx) {
    const { state, isMobile } = ctx;
    const today = app.clock.today();
    const { preset, range } = rangeOf(state, today);
    const projectId = effectiveProject(app, state);
    const update = (patch) => ctx.setState(patch);
    const report = app.sel.statusReport({ range, projectId });
    const text = reportToText(report);
    const subject = `Status — ${report.label}`;
    const mail = buildMailto(subject, text);

    const toolbar = h(
      'div',
      { class: 'v-rel-toolbar no-print' },
      selectInput({
        value: preset,
        size: 'sm',
        ariaLabel: 'Período',
        class: 'v-rel-preset',
        attrs: { 'data-control': 'preset' },
        options: [...REPORT_PRESETS.map((p) => ({ value: p.id, label: p.label })), { value: CUSTOM, label: 'Personalizado' }],
        onchange: (value) => (value === CUSTOM ? update({ preset: CUSTOM, from: range.from, to: range.to }) : update({ preset: value })),
      }),
      preset === CUSTOM
        ? h(
            'span',
            { class: 'v-rel-custom' },
            dateInput({ value: range.from, size: 'sm', ariaLabel: 'De', attrs: { 'data-control': 'from' }, onchange: (value) => value && update({ preset: CUSTOM, from: value, to: range.to }) }),
            h('span', { class: 'v-rel-sep' }, 'a'),
            dateInput({ value: range.to, size: 'sm', ariaLabel: 'Até', attrs: { 'data-control': 'to' }, onchange: (value) => value && update({ preset: CUSTOM, from: range.from, to: value }) }),
          )
        : null,
      button({
        label: projectLabel(app, projectId),
        icon: 'folder',
        iconRight: 'chevron-down',
        size: 'sm',
        active: projectId !== null,
        class: 'v-rel-project-btn',
        title: 'Filtrar por projeto',
        attrs: { 'data-action': 'pick-project' },
        onclick: (ev) => pickProject(app, ev.currentTarget, projectId, (value) => update({ projectId: value === null ? ALL : value })),
      }),
      h('span', { class: 'v-rel-spacer' }),
      h(
        'div',
        { class: 'v-rel-actions' },
        button({ label: 'Copiar texto', icon: 'copy', size: 'sm', attrs: { 'data-action': 'copy' }, onclick: () => copyText(app, text) }),
        button({ label: isMobile ? 'PDF' : 'Imprimir / PDF', icon: 'printer', size: 'sm', attrs: { 'data-action': 'print' }, onclick: () => window.print() }),
        canShare()
          ? button({
              label: 'Compartilhar',
              icon: 'share',
              size: 'sm',
              attrs: { 'data-action': 'share' },
              onclick: () => navigator.share({ title: subject, text }).catch(() => {}),
            })
          : null,
        h(
          'a',
          {
            class: 'btn btn-default btn-sm v-rel-mail',
            href: safeHref(mail.href),
            'data-action': 'mail',
            title: mail.truncated ? 'O texto é longo: o e-mail leva um resumo e o texto completo fica copiado' : 'Abrir no programa de e-mail',
            onclick: () => {
              copyText(app, text, mail.truncated ? 'Texto completo copiado — cole no e-mail se ele vier cortado.' : 'Texto do relatório copiado.');
            },
          },
          icon('mail', { size: 14 }),
          h('span', { class: 'btn-label' }, 'Enviar por e-mail'),
        ),
      ),
    );

    const c = report.counts;
    const summary = [
      ['done', 'concluídas'],
      ['inProgress', 'em andamento'],
      ['blocked', 'bloqueios/aguardando'],
      ['risks', 'atrasadas'],
    ];
    const doc = h(
      'article',
      { class: 'v-rel-doc', 'aria-label': 'Relatório de status' },
      h(
        'header',
        { class: 'v-rel-head' },
        h('h1', { class: 'v-rel-title' }, 'Relatório de status'),
        h(
          'p',
          { class: 'v-rel-meta' },
          h('span', { class: 'v-rel-period', 'data-period': `${report.range.from}|${report.range.to}` }, report.label),
          report.projectName ? h('span', null, ` · ${report.projectName}`) : null,
          h('span', { class: 'v-rel-generated' }, ` · gerado em ${formatDate(today, 'numeric')}`),
        ),
        h(
          'ul',
          { class: 'v-rel-summary' },
          summary.map(([id, label]) => h('li', { key: id, class: cx('v-rel-stat', `is-${id}`) }, h('strong', { class: 'tabular' }, String(c[id] || 0)), h('span', null, ` ${label}`))),
        ),
      ),
      report.projects.length
        ? report.projects.map((project) => projectView(app, project))
        : emptyState({
            icon: 'file-text',
            title: 'Nada a relatar no período',
            text: 'Nenhuma conclusão, item em andamento, bloqueio, próximo passo ou atraso neste período e filtro. Escolha um período maior ou outro projeto.',
            action: preset !== 'month' ? button({ label: 'Ver o mês atual', icon: 'calendar', variant: 'primary', size: 'sm', onclick: () => update({ preset: 'month' }), attrs: { 'data-action': 'report-month' } }) : null,
            compact: true,
            class: 'v-rel-empty',
          }),
    );

    return h('div', { class: cx('v-relatorio', isMobile && 'is-mobile'), 'data-preset': preset }, toolbar, doc);
  },
};
