// Gráficos do kit: SVG simples, sem dependências, com cores vindas dos tokens (css/tokens.css).
//
//   barChart({ data: [{ label: 'seg', value: 3 }, { label: 'ter', value: 5 }] })
//   lineChart({ series: [{ name: 'Concluídas', points: [{ x: 'S1', y: 4 }, { x: 'S2', y: 7 }] }], area: true })
//   hbarList({ items: [{ label: 'Projeto A', value: 12.5 }], format: (h) => `${h} h` })
//
// Como funcionam:
//   • cada função devolve um elemento pronto (funções puras de renderização, como o resto do kit);
//   • os gráficos de eixos (barras, linhas) se desenham na LARGURA REAL do contêiner: o texto fica sempre
//     em 11 px, nunca esticado. Fora do documento usam 480 px; ao entrar na tela (e a cada mudança de
//     largura) são redesenhados sozinhos (ResizeObserver);
//   • acessíveis: role="img" + aria-label resumindo os dados; cada marca tem dica nativa (<title>);
//   • dados vazios, nulos, zerados ou negativos nunca quebram o desenho (sem NaN, sem eixo torto);
//   • texto usa as cores de texto; só as MARCAS usam a cor da série. Duas séries ou mais ganham legenda.
//
// Cores: `color` aceita um nome de token ('--chart-3'), um tom ('accent', 'success', 'warning', 'danger',
// 'info', 'muted'), uma cor de status ('blue', 'green'…) ou qualquer cor CSS. Sem `color`, as séries usam a
// paleta categórica --chart-1 … --chart-8 NA ORDEM (a ordem é o que garante a leitura por daltônicos).
// Da nona série em diante a cor é a neutra (--chart-muted): prefira agrupar o excedente em "Outros".
//
// Exemplos vivos: dev/kit.html.

import { cx, h, s } from '../../core/dom.js';
import { formatNumber, formatPercent } from '../../core/format.js';

/** Largura usada enquanto o gráfico ainda não está no documento. */
export const CHART_DEFAULT_WIDTH = 480;

/** Quantidade de cores da paleta categórica (--chart-1 … --chart-8). */
export const CHART_SERIES_COLORS = 8;

const MIN_WIDTH = 140;
const FONT_SIZE = 11;
const CHAR_WIDTH = 6.1; // largura média de um caractere a 11 px
const BAR_MAX = 24; // espessura máxima de uma barra
const BAR_RADIUS = 4; // canto arredondado na ponta do dado (a base é reta)
const SEGMENT_GAP = 2; // respiro entre barras/segmentos vizinhos
const SUMMARY_ITEMS = 12; // quantos itens entram no resumo acessível

const TONE_COLORS = {
  accent: '--accent',
  success: '--success',
  warning: '--warning',
  danger: '--danger',
  info: '--info',
  muted: '--chart-muted',
  gray: '--st-gray',
  slate: '--st-slate',
  blue: '--st-blue',
  amber: '--st-amber',
  red: '--st-red',
  violet: '--st-violet',
  green: '--st-green',
  neutral: '--st-neutral',
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const round = (n) => Math.round(n * 100) / 100;

/** Número finito ou null. */
function num(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

function defaultFormat(value) {
  return formatNumber(value, Number.isInteger(value) ? 0 : 1);
}

/** Envolve o formatador do chamador: nunca lança e sempre devolve texto. */
function safeFormat(format) {
  const fn = typeof format === 'function' ? format : defaultFormat;
  return (value) => {
    try {
      const out = fn(value);
      return out === null || out === undefined ? defaultFormat(value) : String(out);
    } catch {
      return defaultFormat(value);
    }
  };
}

/**
 * Converte a cor informada numa cor CSS.
 *   chartColor('--chart-2') → 'var(--chart-2)';  chartColor('success') → 'var(--success)';
 *   chartColor(undefined, 0) → 'var(--chart-1)';  chartColor(undefined, 9) → 'var(--chart-muted)'
 * @param {string|null|undefined} color token, tom, cor de status ou cor CSS
 * @param {number} [index=0] posição da série (usada quando não há cor)
 * @returns {string}
 */
export function chartColor(color, index = 0) {
  if (typeof color === 'string' && color.trim() !== '') {
    const name = color.trim();
    if (name.startsWith('--')) return `var(${name})`;
    if (Object.hasOwn(TONE_COLORS, name)) return `var(${TONE_COLORS[name]})`;
    return name;
  }
  const slot = Number.isInteger(index) && index >= 0 ? index : 0;
  return slot < CHART_SERIES_COLORS ? `var(--chart-${slot + 1})` : 'var(--chart-muted)';
}

/**
 * Escala "redonda" para um eixo: limites e marcas em números limpos (0, 5, 10… ou 0, 0,5, 1…).
 *   niceTicks(0, 9, 4) → { min: 0, max: 10, step: 2.5 | 2 …, ticks: [...] }
 * Sempre devolve pelo menos duas marcas; valores inválidos viram 0.
 * @param {number} min
 * @param {number} max
 * @param {number} [count=4] quantidade desejada de intervalos
 * @param {{ integer?: boolean }} [options] `integer`: só marcas inteiras (contagens)
 * @returns {{ min: number, max: number, step: number, ticks: number[] }}
 */
export function niceTicks(min, max, count = 4, { integer = false } = {}) {
  let lo = num(min) ?? 0;
  let hi = num(max) ?? 0;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (hi === lo) hi = lo + 1;
  const wanted = Math.max(1, Math.min(10, Math.floor(num(count) ?? 4)));
  const raw = (hi - lo) / wanted;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 && !integer ? 2.5 : norm <= 5 ? 5 : 10) * magnitude;
  if (integer) step = Math.max(1, Math.round(step));
  const start = Math.floor(lo / step + 1e-9) * step;
  const end = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  const total = Math.round((end - start) / step);
  for (let i = 0; i <= total && i < 50; i++) ticks.push(Number((start + i * step).toPrecision(12)));
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
}

function truncateLabel(label, maxChars) {
  const value = text(label);
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, 1);
  return `${value.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

/** Resumo para leitores de tela: "Título. A: 3, B: 5 e mais 4." */
function summarize(title, parts, emptyText = 'sem dados') {
  const shown = parts.slice(0, SUMMARY_ITEMS);
  const rest = parts.length - shown.length;
  let body = shown.length === 0 ? emptyText : shown.join('; ');
  if (rest > 0) body += `; e mais ${rest}`;
  return title ? `${title}. ${body}.` : `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
}

// ---------------------------------------------------------------------------
// Moldura que se redesenha na largura real
// ---------------------------------------------------------------------------

let resizeObserver = null;

function observeResize(el) {
  if (typeof ResizeObserver !== 'function') return;
  if (resizeObserver === null) {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target;
        const state = target.__chart;
        if (!state) continue;
        const width = Math.floor(entry.contentRect.width);
        if (width > 0 && width !== state.width) renderChart(target, width);
      }
    });
  }
  resizeObserver.observe(el);
}

function renderChart(el, width) {
  const state = el.__chart;
  state.width = width;
  let nodes;
  try {
    nodes = state.draw(state.opts, Math.max(MIN_WIDTH, width));
  } catch (err) {
    console.error('[kit] erro ao desenhar o gráfico', err);
    nodes = [emptyPlot(state.opts && state.opts.height, 'Não foi possível desenhar o gráfico')];
  }
  el.replaceChildren(...nodes.filter(Boolean));
}

/** Chamado na criação e depois de cada morph, sempre com o elemento vivo. */
function syncChart(el, opts, draw) {
  let state = el.__chart;
  if (state === undefined) {
    state = el.__chart = { width: 0, opts, draw };
    observeResize(el);
  }
  state.opts = opts;
  state.draw = draw;
  const measured = el.isConnected ? Math.floor(el.clientWidth) : 0;
  renderChart(el, measured > 0 ? measured : CHART_DEFAULT_WIDTH);
}

/**
 * Contêiner do gráfico. data-morph="skip": o morph sincroniza os atributos e deixa o desenho por conta
 * do próprio gráfico (redesenhado no ref, já na largura medida).
 */
function chartFrame(kind, opts, draw) {
  return h('div', {
    class: cx('chart', `chart-${kind}`, opts.class),
    'data-morph': 'skip',
    'data-chart': kind,
    ref: (el) => syncChart(el, opts, draw),
  });
}

function emptyPlot(height, message = 'Sem dados para mostrar') {
  const size = num(height);
  return h('div', { class: 'chart-empty', role: 'img', 'aria-label': message, style: { height: `${size !== null && size > 0 ? size : 160}px` } }, h('span', null, message));
}

function legend(entries, kind = 'bar') {
  if (entries.length < 2) return null;
  return h(
    'div',
    { class: 'chart-legend' },
    entries.map((entry) =>
      h(
        'span',
        { class: 'chart-legend-item' },
        h('span', { class: cx('chart-swatch', kind === 'line' && 'chart-swatch-line'), style: { background: entry.color }, 'aria-hidden': 'true' }),
        h('span', { class: 'chart-legend-name' }, entry.name),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Eixos cartesianos
// ---------------------------------------------------------------------------

/**
 * Calcula a área de desenho e a escala vertical.
 * @returns {{ width, height, left, right, top, bottom, plotW, plotH, ticks, y: (v: number) => number, zero: number }}
 */
function cartesian({ width, height, min, max, yTicks, format, integer, topPad = 8 }) {
  const size = num(height);
  const total = Math.max(80, size !== null && size > 0 ? size : 160);
  const flat = min === 0 && max === 0;
  const scale = niceTicks(Math.min(0, min), Math.max(0, max), yTicks, { integer });
  const ticks = flat ? [0] : scale.ticks;
  const labels = ticks.map((tick) => format(tick));
  const longest = labels.reduce((len, label) => Math.max(len, label.length), 1);
  const left = Math.min(Math.ceil(longest * CHAR_WIDTH) + 10, Math.floor(width * 0.3));
  const right = 8;
  const top = topPad;
  const bottom = 22;
  const plotW = Math.max(10, width - left - right);
  const plotH = Math.max(10, total - top - bottom);
  const span = scale.max - scale.min || 1;
  const y = (value) => round(top + plotH - ((value - scale.min) / span) * plotH);
  return { width, height: total, left, right, top, bottom, plotW, plotH, ticks, labels, y, zero: y(0) };
}

function gridLayer(frame) {
  const nodes = [];
  frame.ticks.forEach((tick, index) => {
    const y = frame.y(tick);
    const isZero = tick === 0;
    nodes.push(s('line', { class: isZero ? 'chart-axis' : 'chart-grid', x1: frame.left, x2: frame.left + frame.plotW, y1: y, y2: y }));
    nodes.push(s('text', { class: 'chart-tick', x: frame.left - 6, y: y + 3.5, 'text-anchor': 'end' }, frame.labels[index]));
  });
  return s('g', { class: 'chart-grid-layer', 'aria-hidden': 'true' }, nodes);
}

/** Rótulos do eixo X: cortados para caber na faixa; se não couberem, só um a cada N (contando a partir do último). */
function xLabelLayer(frame, labels) {
  const count = labels.length;
  if (count === 0) return null;
  const band = frame.plotW / count;
  const longest = labels.reduce((len, label) => Math.max(len, text(label).length), 0);
  const needed = Math.min(longest, 6) * CHAR_WIDTH + 8;
  const every = Math.max(1, Math.ceil(needed / band));
  const maxChars = Math.max(1, Math.floor((band * every - 4) / CHAR_WIDTH));
  const nodes = [];
  for (let i = 0; i < count; i++) {
    if ((count - 1 - i) % every !== 0) continue;
    const full = text(labels[i]);
    if (full === '') continue;
    nodes.push(
      s('text', { class: 'chart-label', x: round(frame.left + band * (i + 0.5)), y: frame.top + frame.plotH + 15, 'text-anchor': 'middle' }, truncateLabel(full, maxChars)),
    );
  }
  return s('g', { class: 'chart-x-labels', 'aria-hidden': 'true' }, nodes);
}

/** Caminho de uma barra vertical: reta na base (y0), arredondada na ponta do dado (y1). */
function barPath(x, y0, y1, width, radius = BAR_RADIUS) {
  const height = Math.abs(y1 - y0);
  if (!(height > 0) || !(width > 0)) return '';
  const r = round(Math.min(radius, width / 2, height));
  const dir = y1 < y0 ? 1 : -1; // 1 = cresce para cima
  const x2 = round(x + width);
  const inner = round(y1 + dir * r);
  return `M${round(x)} ${round(y0)}V${inner}Q${round(x)} ${round(y1)} ${round(x + r)} ${round(y1)}H${round(x2 - r)}Q${x2} ${round(y1)} ${x2} ${inner}V${round(y0)}Z`;
}

function svgRoot(frame, label, children) {
  return s(
    'svg',
    {
      class: 'chart-svg',
      viewBox: `0 0 ${frame.width} ${frame.height}`,
      width: frame.width,
      height: frame.height,
      role: 'img',
      'aria-label': label,
      focusable: 'false',
    },
    children,
  );
}

function hitRect(x, top, width, height) {
  return s('rect', { class: 'chart-hit', x: round(x), y: top, width: round(Math.max(0, width)), height, fill: 'transparent' });
}

// ---------------------------------------------------------------------------
// Barras
// ---------------------------------------------------------------------------

function drawBarChart(opts, width) {
  const format = safeFormat(opts.format);
  const data = (Array.isArray(opts.data) ? opts.data : [])
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({ label: text(item.label), value: num(item.value) ?? 0, color: item.color, title: item.title }));
  if (data.length === 0) return [emptyPlot(opts.height)];

  const values = data.map((item) => item.value);
  const highlight = !!opts.highlightLast;
  const frame = cartesian({
    width,
    height: opts.height,
    min: Math.min(...values),
    max: Math.max(...values),
    yTicks: opts.yTicks,
    format,
    integer: values.every(Number.isInteger),
    topPad: highlight ? 18 : 8,
  });
  const band = frame.plotW / data.length;
  const barWidth = Math.max(1, Math.min(BAR_MAX, band - SEGMENT_GAP, band * 0.72));
  const lastIndex = data.length - 1;

  const bands = data.map((item, index) => {
    const x = frame.left + band * index + (band - barWidth) / 2;
    const isLast = index === lastIndex;
    const color = item.color ? chartColor(item.color) : highlight && !isLast ? 'var(--chart-muted)' : 'var(--chart-1)';
    const d = barPath(x, frame.zero, frame.y(item.value), barWidth);
    const tip = item.title ? text(item.title) : `${item.label ? `${item.label}: ` : ''}${format(item.value)}`;
    return s(
      'g',
      { class: cx('chart-band', highlight && isLast && 'is-highlight'), 'data-index': index },
      s('title', null, tip),
      hitRect(frame.left + band * index, frame.top, band, frame.plotH),
      d ? s('path', { class: 'chart-bar', d, fill: color }) : null,
      highlight && isLast
        ? s(
            'text',
            { class: 'chart-value', x: round(x + barWidth / 2), y: round(Math.min(frame.zero, frame.y(item.value)) - 5), 'text-anchor': 'middle' },
            format(item.value),
          )
        : null,
    );
  });

  const label = summarize(opts.ariaLabel || 'Gráfico de barras', data.map((item) => `${item.label || '—'}: ${format(item.value)}`));
  return [svgRoot(frame, label, [gridLayer(frame), bands, xLabelLayer(frame, data.map((item) => item.label))])];
}

/**
 * Gráfico de barras verticais (uma série).
 *
 *   barChart({ data: [{ label: 'seg', value: 3 }, { label: 'ter', value: 5 }, { label: 'qua', value: 2 }] })
 *   barChart({ data: semanas, highlightLast: true, format: (n) => `${n} h` })      // última barra em destaque, com o valor
 *   barChart({ data: [{ label: 'Atrasadas', value: 4, color: 'danger' }], height: 120 })
 *
 * Valores nulos/inválidos contam como 0; negativos crescem para baixo a partir do zero. Sem dados: estado vazio.
 *
 * @param {object} options
 * @param {Array<{ label: string, value: number, color?: string, title?: string }>} options.data
 *        `color`: cor só daquela barra; `title`: dica nativa (padrão "rótulo: valor")
 * @param {number} [options.height=160] altura total em px
 * @param {(value: number) => string} [options.format] formatação dos valores (eixo, dicas e resumo)
 * @param {number} [options.yTicks=4] quantidade aproximada de linhas de grade
 * @param {boolean} [options.highlightLast] destaca a última barra (as outras ficam neutras) e mostra o valor dela
 * @param {string} [options.ariaLabel] título lido antes do resumo dos dados
 * @param {string|Array|object} [options.class]
 * @returns {HTMLDivElement}
 */
export function barChart({ data, height = 160, format, yTicks = 4, highlightLast = false, ariaLabel, class: className } = {}) {
  return chartFrame('bar', { data, height, format, yTicks, highlightLast, ariaLabel, class: className }, drawBarChart);
}

/** Normaliza categorias e séries dos gráficos agrupado/empilhado. */
function normalizeSeries(categories, series) {
  const cats = (Array.isArray(categories) ? categories : []).map(text);
  const list = (Array.isArray(series) ? series : [])
    .filter((item) => item !== null && typeof item === 'object')
    .map((item, index) => ({
      name: text(item.name) || `Série ${index + 1}`,
      color: chartColor(item.color, index),
      values: cats.map((_, i) => num(Array.isArray(item.values) ? item.values[i] : null) ?? 0),
    }));
  return { cats, list };
}

function drawGroupedBarChart(opts, width) {
  const format = safeFormat(opts.format);
  const { cats, list } = normalizeSeries(opts.categories, opts.series);
  if (cats.length === 0 || list.length === 0) return [emptyPlot(opts.height)];

  const all = list.flatMap((item) => item.values);
  const frame = cartesian({ width, height: opts.height, min: Math.min(...all), max: Math.max(...all), yTicks: opts.yTicks, format, integer: all.every(Number.isInteger) });
  const band = frame.plotW / cats.length;
  const inner = band * 0.76;
  const barWidth = Math.max(1, Math.min(BAR_MAX, (inner - SEGMENT_GAP * (list.length - 1)) / list.length));
  const groupWidth = barWidth * list.length + SEGMENT_GAP * (list.length - 1);

  const bands = cats.map((category, index) => {
    const start = frame.left + band * index + (band - groupWidth) / 2;
    const tip = [category, ...list.map((item) => `${item.name}: ${format(item.values[index])}`)].filter(Boolean).join('\n');
    return s(
      'g',
      { class: 'chart-band', 'data-index': index },
      s('title', null, tip),
      hitRect(frame.left + band * index, frame.top, band, frame.plotH),
      list.map((item, k) => {
        const d = barPath(start + k * (barWidth + SEGMENT_GAP), frame.zero, frame.y(item.values[index]), barWidth, Math.min(BAR_RADIUS, barWidth / 2));
        return d ? s('path', { class: 'chart-bar', d, fill: item.color, 'data-series': k }) : null;
      }),
    );
  });

  const parts = list.map((item) => `${item.name}: ${item.values.map((value, i) => `${cats[i] || '—'} ${format(value)}`).join(', ')}`);
  const label = summarize(opts.ariaLabel || 'Gráfico de barras agrupadas', parts);
  return [legend(list), svgRoot(frame, label, [gridLayer(frame), bands, xLabelLayer(frame, cats)])];
}

/**
 * Barras agrupadas: várias séries lado a lado em cada categoria, com legenda.
 *
 *   groupedBarChart({
 *     categories: ['S1', 'S2', 'S3'],
 *     series: [{ name: 'Planejadas', values: [8, 6, 9] }, { name: 'Concluídas', values: [6, 6, 7] }],
 *   })
 *
 * @param {object} options
 * @param {string[]} options.categories rótulos do eixo X
 * @param {Array<{ name: string, color?: string, values: number[] }>} options.series `values[i]` pertence a `categories[i]`
 * @param {number} [options.height=180]
 * @param {(value: number) => string} [options.format]
 * @param {number} [options.yTicks=4]
 * @param {string} [options.ariaLabel]
 * @param {string|Array|object} [options.class]
 * @returns {HTMLDivElement}
 */
export function groupedBarChart({ categories, series, height = 180, format, yTicks = 4, ariaLabel, class: className } = {}) {
  return chartFrame('grouped', { categories, series, height, format, yTicks, ariaLabel, class: className }, drawGroupedBarChart);
}

function drawStackedBarChart(opts, width) {
  const format = safeFormat(opts.format);
  const { cats, list } = normalizeSeries(opts.categories, opts.series);
  if (cats.length === 0 || list.length === 0) return [emptyPlot(opts.height)];

  const positives = cats.map((_, i) => list.reduce((sum, item) => sum + Math.max(0, item.values[i]), 0));
  const negatives = cats.map((_, i) => list.reduce((sum, item) => sum + Math.min(0, item.values[i]), 0));
  const all = list.flatMap((item) => item.values);
  const frame = cartesian({ width, height: opts.height, min: Math.min(...negatives), max: Math.max(...positives), yTicks: opts.yTicks, format, integer: all.every(Number.isInteger) });
  const band = frame.plotW / cats.length;
  const barWidth = Math.max(1, Math.min(BAR_MAX, band - SEGMENT_GAP, band * 0.72));

  const bands = cats.map((category, index) => {
    const x = frame.left + band * index + (band - barWidth) / 2;
    const total = positives[index] + negatives[index];
    const tip = [category, ...list.map((item) => `${item.name}: ${format(item.values[index])}`), list.length > 1 ? `Total: ${format(total)}` : null].filter(Boolean).join('\n');
    let up = 0;
    let down = 0;
    const lastUp = list.reduce((last, item, k) => (item.values[index] > 0 ? k : last), -1);
    const lastDown = list.reduce((last, item, k) => (item.values[index] < 0 ? k : last), -1);
    const segments = list.map((item, k) => {
      const value = item.values[index];
      if (value === 0) return null;
      const from = value > 0 ? up : down;
      const to = from + value;
      if (value > 0) up = to;
      else down = to;
      let y0 = frame.y(from);
      const y1 = frame.y(to);
      const isEnd = k === (value > 0 ? lastUp : lastDown);
      // respiro de 2 px entre segmentos empilhados (na cor do fundo: é só espaço vazio)
      if (from !== 0 && Math.abs(y1 - y0) > SEGMENT_GAP + 1) y0 += value > 0 ? -SEGMENT_GAP : SEGMENT_GAP;
      const d = barPath(x, y0, y1, barWidth, isEnd ? BAR_RADIUS : 0);
      return d ? s('path', { class: 'chart-bar', d, fill: item.color, 'data-series': k }) : null;
    });
    return s('g', { class: 'chart-band', 'data-index': index }, s('title', null, tip), hitRect(frame.left + band * index, frame.top, band, frame.plotH), segments);
  });

  const parts = cats.map((category, i) => `${category || '—'}: ${format(positives[i] + negatives[i])} (${list.map((item) => `${item.name} ${format(item.values[i])}`).join(', ')})`);
  const label = summarize(opts.ariaLabel || 'Gráfico de barras empilhadas', parts);
  return [legend(list), svgRoot(frame, label, [gridLayer(frame), bands, xLabelLayer(frame, cats)])];
}

/**
 * Barras empilhadas: as séries somam em cada categoria, com legenda.
 *
 *   stackedBarChart({
 *     categories: ['jan', 'fev', 'mar'],
 *     series: [{ name: 'No prazo', values: [12, 9, 14], color: 'success' }, { name: 'Com atraso', values: [3, 5, 2], color: 'warning' }],
 *   })
 *
 * Valores negativos empilham para baixo do zero. A dica de cada coluna lista todas as séries e o total.
 *
 * @param {object} options
 * @param {string[]} options.categories
 * @param {Array<{ name: string, color?: string, values: number[] }>} options.series
 * @param {number} [options.height=180]
 * @param {(value: number) => string} [options.format]
 * @param {number} [options.yTicks=4]
 * @param {string} [options.ariaLabel]
 * @param {string|Array|object} [options.class]
 * @returns {HTMLDivElement}
 */
export function stackedBarChart({ categories, series, height = 180, format, yTicks = 4, ariaLabel, class: className } = {}) {
  return chartFrame('stacked', { categories, series, height, format, yTicks, ariaLabel, class: className }, drawStackedBarChart);
}

// ---------------------------------------------------------------------------
// Linhas
// ---------------------------------------------------------------------------

function drawLineChart(opts, width) {
  const format = safeFormat(opts.format);
  const raw = (Array.isArray(opts.series) ? opts.series : []).filter((item) => item !== null && typeof item === 'object');
  // Eixo X: rótulos na ordem em que aparecem (a primeira série manda; as outras acrescentam o que faltar).
  const xs = [];
  const xIndex = new Map();
  for (const item of raw) {
    for (const point of Array.isArray(item.points) ? item.points : []) {
      if (point === null || typeof point !== 'object') continue;
      const key = text(point.x);
      if (!xIndex.has(key)) {
        xIndex.set(key, xs.length);
        xs.push(key);
      }
    }
  }
  const list = raw.map((item, index) => {
    const values = new Array(xs.length).fill(null);
    for (const point of Array.isArray(item.points) ? item.points : []) {
      if (point === null || typeof point !== 'object') continue;
      values[xIndex.get(text(point.x))] = num(point.y);
    }
    return { name: text(item.name) || `Série ${index + 1}`, color: chartColor(item.color, index), values };
  });
  const all = list.flatMap((item) => item.values).filter((value) => value !== null);
  if (xs.length === 0 || all.length === 0) return [emptyPlot(opts.height)];

  const frame = cartesian({ width, height: opts.height, min: Math.min(...all), max: Math.max(...all), yTicks: opts.yTicks, format, integer: all.every(Number.isInteger) });
  const band = frame.plotW / xs.length;
  const xAt = (i) => round(frame.left + band * (i + 0.5));

  const lines = list.map((item, k) => {
    // Valores ausentes (null) interrompem a linha em vez de derrubá-la até o zero.
    const runs = [];
    let run = [];
    item.values.forEach((value, i) => {
      if (value === null) {
        if (run.length > 0) runs.push(run);
        run = [];
      } else {
        run.push([xAt(i), frame.y(value)]);
      }
    });
    if (run.length > 0) runs.push(run);
    const nodes = [];
    for (const points of runs) {
      const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join('');
      if (opts.area && points.length > 1) {
        nodes.push(s('path', { class: 'chart-area', d: `${path}L${points[points.length - 1][0]} ${frame.zero}L${points[0][0]} ${frame.zero}Z`, fill: item.color }));
      }
      if (points.length > 1) nodes.push(s('path', { class: 'chart-line', d: path, stroke: item.color, fill: 'none' }));
      else nodes.push(s('circle', { class: 'chart-dot', cx: points[0][0], cy: points[0][1], r: 3, fill: item.color }));
    }
    // marcador no último ponto de cada série (com anel na cor do fundo)
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.length > 1) {
      const [x, y] = lastRun[lastRun.length - 1];
      nodes.push(s('circle', { class: 'chart-dot chart-dot-end', cx: x, cy: y, r: 4, fill: item.color }));
    }
    return s('g', { class: 'chart-series', 'data-series': k }, nodes);
  });

  // Camada de leitura: uma coluna por posição do eixo X, com a dica de TODAS as séries, a linha-guia e os pontos.
  const columns = xs.map((label, i) => {
    const tip = [label, ...list.map((item) => `${item.name}: ${item.values[i] === null ? '—' : format(item.values[i])}`)].filter(Boolean).join('\n');
    return s(
      'g',
      { class: 'chart-col', 'data-index': i },
      s('title', null, tip),
      hitRect(frame.left + band * i, frame.top, band, frame.plotH),
      s('line', { class: 'chart-crosshair', x1: xAt(i), x2: xAt(i), y1: frame.top, y2: frame.top + frame.plotH }),
      list.map((item) => (item.values[i] === null ? null : s('circle', { class: 'chart-dot chart-dot-hover', cx: xAt(i), cy: frame.y(item.values[i]), r: 4, fill: item.color }))),
    );
  });

  const parts = list.map((item) => {
    const known = item.values.map((value, i) => ({ value, x: xs[i] })).filter((point) => point.value !== null);
    if (known.length === 0) return `${item.name}: sem dados`;
    const first = known[0];
    const last = known[known.length - 1];
    const numbers = known.map((point) => point.value);
    return known.length === 1
      ? `${item.name}: ${format(first.value)} em ${first.x || '—'}`
      : `${item.name}: de ${format(first.value)} (${first.x || '—'}) a ${format(last.value)} (${last.x || '—'}), mínimo ${format(Math.min(...numbers))}, máximo ${format(Math.max(...numbers))}`;
  });
  const label = summarize(opts.ariaLabel || 'Gráfico de linhas', parts);
  return [legend(list, 'line'), svgRoot(frame, label, [gridLayer(frame), lines, columns, xLabelLayer(frame, xs)])];
}

/**
 * Gráfico de linhas (evolução no tempo), com legenda quando há duas séries ou mais.
 *
 *   lineChart({ series: [{ name: 'WIP', points: [{ x: '01/11', y: 4 }, { x: '08/11', y: 6 }, { x: '15/11', y: 5 }] }] })
 *   lineChart({ series: [abertas, concluidas], area: true, format: (n) => `${n} tarefas` })
 *
 * O eixo X usa os rótulos `x` na ordem em que aparecem. `y` nulo interrompe a linha (dado ausente).
 * Passar o mouse numa coluna mostra a dica com o valor de todas as séries naquele ponto.
 *
 * @param {object} options
 * @param {Array<{ name: string, color?: string, points: Array<{ x: string, y: number|null }> }>} options.series
 * @param {number} [options.height=180]
 * @param {(value: number) => string} [options.format]
 * @param {boolean} [options.area] preenche suavemente a área sob a linha
 * @param {number} [options.yTicks=4]
 * @param {string} [options.ariaLabel]
 * @param {string|Array|object} [options.class]
 * @returns {HTMLDivElement}
 */
export function lineChart({ series, height = 180, format, area = false, yTicks = 4, ariaLabel, class: className } = {}) {
  return chartFrame('line', { series, height, format, area, yTicks, ariaLabel, class: className }, drawLineChart);
}

// ---------------------------------------------------------------------------
// Barras horizontais com rótulo
// ---------------------------------------------------------------------------

/**
 * Lista de barras horizontais com rótulo e valor — para rankings como "horas por projeto".
 *
 *   hbarList({ items: [{ label: 'Projeto A', value: 12.5, hint: '5 tarefas' }, { label: 'Projeto B', value: 7 }],
 *              format: (h) => `${formatNumber(h, 1)} h` })
 *   hbarList({ items, max: 40 })      // escala fixa (ex.: capacidade da semana)
 *
 * A barra de cada item é proporcional ao maior valor (ou a `max`). Valores nulos/negativos ficam com barra
 * vazia. É uma lista de verdade (role="list"): o texto de cada linha é lido normalmente.
 *
 * @param {object} options
 * @param {Array<{ label: string, value: number, color?: string, hint?: string, title?: string }>} options.items
 * @param {(value: number) => string} [options.format]
 * @param {number} [options.max] valor que corresponde à barra cheia (padrão: o maior valor)
 * @param {string} [options.ariaLabel]
 * @param {string} [options.emptyText='Sem dados para mostrar']
 * @param {string|Array|object} [options.class]
 * @returns {HTMLDivElement}
 */
export function hbarList({ items, format, max, ariaLabel, emptyText = 'Sem dados para mostrar', class: className } = {}) {
  const fmt = safeFormat(format);
  const list = (Array.isArray(items) ? items : [])
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({ label: text(item.label), value: num(item.value), color: item.color, hint: text(item.hint), title: item.title }));
  if (list.length === 0) {
    return h('div', { class: cx('chart', 'chart-hbar', className), 'data-chart': 'hbar' }, h('div', { class: 'chart-empty chart-empty-compact', role: 'img', 'aria-label': emptyText }, h('span', null, emptyText)));
  }
  const limit = num(max);
  const top = limit !== null && limit > 0 ? limit : Math.max(0, ...list.map((item) => item.value ?? 0));
  return h(
    'div',
    { class: cx('chart', 'chart-hbar', className), 'data-chart': 'hbar', role: 'list', 'aria-label': ariaLabel || null },
    list.map((item) => {
      const value = item.value ?? 0;
      const fraction = top > 0 ? Math.min(1, Math.max(0, value / top)) : 0;
      const shown = item.value === null ? '—' : fmt(value);
      return h(
        'div',
        { class: 'hbar-row', role: 'listitem', title: item.title ? text(item.title) : `${item.label}: ${shown}` },
        h('span', { class: 'hbar-label' }, h('span', { class: 'hbar-name truncate' }, item.label || '—'), item.hint ? h('span', { class: 'hbar-hint truncate' }, item.hint) : null),
        h('span', { class: 'hbar-track', 'aria-hidden': 'true' }, h('span', { class: 'hbar-fill', style: { width: `${round(fraction * 100)}%`, background: chartColor(item.color, 0) } })),
        h('span', { class: 'hbar-value tabular' }, shown),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Anel de progresso e minigráfico
// ---------------------------------------------------------------------------

/**
 * Anel de progresso (0 a 1).
 *
 *   ring({ value: 0.42 })                       // 44 px, "42%" no centro
 *   ring({ value: 0.8, size: 64, stroke: 6, label: '8/10' })
 *   ring({ value: null })                       // sem dado: travessão
 *
 * @param {object} options
 * @param {number|null} options.value fração 0..1 (fora da faixa é limitada; null = sem dado)
 * @param {number} [options.size=44] diâmetro em px
 * @param {number} [options.stroke=5] espessura do traço
 * @param {string} [options.label] texto do centro (padrão: o percentual; '' esconde)
 * @param {string} [options.color] cor do traço (padrão: destaque; verde quando completo)
 * @param {string} [options.title] dica e nome acessível (padrão: "Progresso: 42%")
 * @param {string|Array|object} [options.class]
 * @returns {SVGSVGElement}
 */
export function ring({ value, size = 44, stroke = 5, label, color, title, class: className } = {}) {
  const px = Math.max(12, num(size) ?? 44);
  const thickness = Math.max(1, Math.min(px / 2 - 1, num(stroke) ?? 5));
  const number = num(value);
  const fraction = number === null ? null : Math.min(1, Math.max(0, number));
  const radius = round((px - thickness) / 2);
  const circumference = 2 * Math.PI * radius;
  const percent = fraction === null ? '—' : formatPercent(fraction);
  const center = label === undefined || label === null ? percent : String(label);
  const name = title || (fraction === null ? 'Progresso indisponível' : `Progresso: ${percent}`);
  const tone = color ? chartColor(color) : fraction !== null && fraction >= 1 ? 'var(--success)' : 'var(--accent)';
  const fontSize = Math.max(9, Math.min(16, Math.round(px * 0.26)));
  return s(
    'svg',
    { class: cx('ring', className), width: px, height: px, viewBox: `0 0 ${px} ${px}`, role: 'img', 'aria-label': name, focusable: 'false' },
    s('title', null, name),
    s('circle', { class: 'ring-track', cx: px / 2, cy: px / 2, r: radius, fill: 'none', 'stroke-width': thickness }),
    fraction !== null && fraction > 0
      ? s('circle', {
          class: 'ring-value',
          cx: px / 2,
          cy: px / 2,
          r: radius,
          fill: 'none',
          stroke: tone,
          'stroke-width': thickness,
          'stroke-linecap': fraction >= 1 ? 'butt' : 'round',
          'stroke-dasharray': `${round(circumference * fraction)} ${round(circumference)}`,
          transform: `rotate(-90 ${px / 2} ${px / 2})`,
        })
      : null,
    center !== '' && px >= 32
      ? s('text', { class: 'ring-label', x: px / 2, y: px / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': fontSize }, center)
      : null,
  );
}

/**
 * Minigráfico de tendência (linha sem eixos), de tamanho fixo — para cartões de indicador e linhas de tabela.
 *
 *   sparkline([4, 6, 5, 8, 7])
 *   sparkline(horasPorDia, { width: 120, height: 28, color: 'accent' })
 *
 * Valores não numéricos são ignorados. Com menos de dois valores desenha só a linha de base (e o ponto, se houver).
 *
 * @param {number[]} values
 * @param {object} [options]
 * @param {number} [options.width=80]
 * @param {number} [options.height=24]
 * @param {string} [options.color] cor da linha (padrão: neutra, com o último ponto em destaque)
 * @param {string} [options.title] nome acessível (padrão: resumo "de X a Y")
 * @param {string|Array|object} [options.class]
 * @returns {SVGSVGElement}
 */
export function sparkline(values, { width = 80, height = 24, color, title, class: className } = {}) {
  const w = Math.max(16, num(width) ?? 80);
  const hgt = Math.max(8, num(height) ?? 24);
  const points = (Array.isArray(values) ? values : []).map(num).filter((value) => value !== null);
  const pad = 3;
  const lineColor = color ? chartColor(color) : 'var(--text-faint)';
  const dotColor = color ? chartColor(color) : 'var(--chart-1)';
  const min = points.length > 0 ? Math.min(...points) : 0;
  const max = points.length > 0 ? Math.max(...points) : 0;
  const span = max - min;
  const xAt = (i) => round(points.length === 1 ? w - pad : pad + (i * (w - pad * 2)) / (points.length - 1));
  const yAt = (value) => round(span === 0 ? hgt / 2 : pad + (1 - (value - min) / span) * (hgt - pad * 2));
  const name =
    title ||
    (points.length === 0
      ? 'Tendência: sem dados'
      : points.length === 1
        ? `Tendência: ${defaultFormat(points[0])}`
        : `Tendência: de ${defaultFormat(points[0])} a ${defaultFormat(points[points.length - 1])} (mínimo ${defaultFormat(min)}, máximo ${defaultFormat(max)})`);
  const last = points.length - 1;
  return s(
    'svg',
    { class: cx('sparkline', className), width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, role: 'img', 'aria-label': name, focusable: 'false' },
    s('title', null, name),
    points.length < 2 ? s('line', { class: 'sparkline-base', x1: pad, x2: w - pad, y1: round(hgt / 2), y2: round(hgt / 2) }) : null,
    points.length >= 2 ? s('path', { class: 'sparkline-line', d: points.map((value, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)} ${yAt(value)}`).join(''), stroke: lineColor, fill: 'none' }) : null,
    points.length >= 1 ? s('circle', { class: 'sparkline-dot', cx: xAt(last), cy: yAt(points[last]), r: 2.5, fill: dotColor }) : null,
  );
}
