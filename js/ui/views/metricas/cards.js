// Tela "Métricas" — cartões de indicador, cartões de gráfico, cabeçalhos de seção e selos de variação.
// Funções puras de renderização (devolvem elementos); nenhuma escrita no banco.

import { cx, h } from '../../../core/dom.js';
import { METRIC_LABELS } from '../../../domain/metrics.js';
import { icon } from '../../kit/icons.js';
import { openPopover } from '../../kit/overlays.js';
import { POLARITY, computeDelta, valueText } from './model.js';

// ---------------------------------------------------------------------------
// Peças visuais
// ---------------------------------------------------------------------------

/** Explicação de um indicador num popover (o title nativo não aparece em telas de toque). */
function openHelp(anchor, label, help) {
  openPopover(
    anchor,
    () =>
      h(
        'div',
        { class: 'v-metricas-help' },
        h('div', { class: 'v-metricas-help-title' }, label),
        h('p', { class: 'v-metricas-help-text' }, help),
        h('p', { class: 'v-metricas-help-note' }, icon('clock', { size: 12 }), 'Calculado a partir do histórico de alterações.'),
      ),
    { width: 300, ariaLabel: `Como é calculado: ${label}` },
  );
}

function infoButton(label, help) {
  return h(
    'button',
    {
      type: 'button',
      class: 'v-metricas-info',
      title: help,
      'aria-label': `Como é calculado: ${label}`,
      onclick: (ev) => {
        ev.stopPropagation();
        openHelp(ev.currentTarget, label, help);
      },
    },
    icon('info', { size: 13 }),
  );
}

/** Selo de variação em relação ao período anterior (▲ / ▼, verde quando melhora, vermelho quando piora). */
function deltaChip(delta, previousText, compare) {
  if (!delta) return null;
  const tone = delta.good === true ? 'is-good' : delta.good === false ? 'is-bad' : 'is-neutral';
  const arrow = delta.direction === 'up' ? '▲' : delta.direction === 'down' ? '▼' : '=';
  const tip = `Período anterior (${compare}): ${previousText}`;
  const spoken = delta.direction === 'flat' ? 'igual ao período anterior' : `${delta.direction === 'up' ? 'subiu' : 'caiu'} ${delta.text.replace(/^[+−]/, '')} em relação ao período anterior`;
  return h(
    'span',
    { class: cx('v-metricas-delta', tone), title: tip, 'aria-label': spoken, 'data-delta': delta.direction },
    h('span', { class: 'v-metricas-delta-arrow', 'aria-hidden': 'true' }, arrow),
    h('span', { class: 'tabular', 'aria-hidden': 'true' }, delta.direction === 'flat' ? 'igual' : delta.text),
  );
}

/**
 * Cartão de indicador.
 * @param {object} o
 * @param {string} o.key chave em METRIC_LABELS (vira data-metric)
 * @param {string} [o.label] legenda (padrão: METRIC_LABELS)
 * @param {string} [o.help] explicação (padrão: METRIC_LABELS)
 * @param {{ text: string, unit: string, empty?: boolean }} o.value valor formatado
 * @param {Node|string|null} [o.secondary] linha de apoio
 * @param {Node|null} [o.delta] selo de variação
 * @param {Node|null} [o.chart] minigráfico/barra
 * @param {string} [o.span] 'span-2' | 'span-full'
 */
export function metricCard({ key, label, help, value, secondary, delta, chart, span, tone }) {
  const meta = METRIC_LABELS[key] || {};
  const caption = label || meta.label || key;
  const explanation = help || meta.help || '';
  const empty = !!value.empty;
  return h(
    'article',
    { key: `card-${key}`, class: cx('v-metricas-card', span, empty && 'is-empty', tone && `tone-${tone}`), 'data-metric': key, title: explanation },
    h('div', { class: 'v-metricas-card-head' }, h('span', { class: 'v-metricas-card-label' }, caption), explanation ? infoButton(caption, explanation) : null),
    h(
      'div',
      { class: 'v-metricas-card-value' },
      h('span', { class: 'v-metricas-num tabular', 'data-value': true }, value.text),
      value.unit ? h('span', { class: 'v-metricas-unit' }, value.unit) : null,
      chart ? h('span', { class: 'v-metricas-card-spark' }, chart) : null,
    ),
    h(
      'div',
      { class: 'v-metricas-card-foot' },
      empty ? h('span', { class: 'v-metricas-sub is-empty' }, 'sem dados no período') : [delta, secondary ? h('span', { class: 'v-metricas-sub' }, secondary) : null],
    ),
  );
}

/** Cartão com um gráfico. */
export function chartCard({ key, title, help, caption, chart, span = 'span-2', aside }) {
  const meta = METRIC_LABELS[key] || {};
  const explanation = help || meta.help || '';
  return h(
    'article',
    { key: `chart-${key}`, class: cx('v-metricas-card', 'is-chart', span), 'data-chart-card': key },
    h(
      'div',
      { class: 'v-metricas-card-head' },
      h('span', { class: 'v-metricas-chart-title' }, title),
      explanation ? infoButton(title, explanation) : null,
      aside ? h('span', { class: 'v-metricas-card-aside' }, aside) : null,
    ),
    caption ? h('p', { class: 'v-metricas-chart-caption' }, caption) : null,
    h('div', { class: 'v-metricas-chart-body' }, chart),
  );
}

export function section({ id, title, iconName, description, children }) {
  return h(
    'section',
    { key: `section-${id}`, class: 'v-metricas-section', 'data-section': id, 'aria-labelledby': `v-metricas-h-${id}` },
    h(
      'header',
      { class: 'v-metricas-section-head' },
      h('h2', { class: 'v-metricas-section-title', id: `v-metricas-h-${id}` }, icon(iconName, { size: 15 }), h('span', null, title)),
      description ? h('p', { class: 'v-metricas-section-desc' }, description) : null,
    ),
    h('div', { class: 'v-metricas-grid' }, children),
  );
}

// ---------------------------------------------------------------------------
// Comparação
// ---------------------------------------------------------------------------

/** Fábrica de selos de variação para um par (atual, anterior). */
export function deltaMaker(cur, prev, compare) {
  return (path, unit, nouns) => {
    if (!prev) return null;
    const [group, key] = path.split('.');
    const a = cur[group][key];
    const b = prev[group][key];
    const delta = computeDelta(a, b, unit, Object.hasOwn(POLARITY, key) ? POLARITY[key] : null);
    return deltaChip(delta, valueText(b, unit, nouns), compare);
  };
}
