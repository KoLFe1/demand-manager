// Ícones do Demand Manager: traço (stroke) numa grade de 24 × 24, cor = currentColor, espessura 1,75.
//
//   icon('check')                           → <svg class="icon" width="16" height="16" aria-hidden="true">
//   icon('trash', { size: 14, class: 'x' }) → tamanho e classe extra
//   icon('info', { title: 'Detalhes' })     → com nome acessível (role="img" + <title>)
//
// Cada ícone é uma lista de formas:
//   'M5 12h14'                  caminho (atributo d)
//   ['c', cx, cy, r, extra?]    círculo
//   ['r', x, y, w, h, rx?, extra?]  retângulo
// `extra` é um objeto de atributos SVG (ex.: { fill: 'currentColor', stroke: 'none' }).

import { s } from '../../core/dom.js';

const FILLED = Object.freeze({ fill: 'currentColor', stroke: 'none' });
const dot = (cx, cy, r = 1.25) => ['c', cx, cy, r, FILLED];

/**
 * Barras de sinal (prioridade): `level` barras cheias (classe 'signal-on'), as demais esmaecidas ('signal-off').
 * A opacidade das inativas vem do CSS (token --p-off), para manter um contraste mínimo também no tema escuro.
 */
function signal(level) {
  const bars = [
    [5, 16.5],
    [9.7, 12.5],
    [14.3, 8.5],
    [19, 4.5],
  ];
  return bars.map(([x, top], index) => [
    'p',
    `M${x} 20V${top}`,
    { 'stroke-width': 2.6, class: index < level ? 'signal-on' : 'signal-off' },
  ]);
}

const SLASH = 'M4 4l16 16';
const CALENDAR = [['r', 4, 5, 16, 15, 2], 'M4 10h16', 'M8 3v4', 'M16 3v4'];
const CLOUD = 'M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 10.6a4 4 0 0 1-.5 7.9z';
const EYE = 'M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z';
const RING = ['c', 12, 12, 9];

const ICONS = {
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  'check-circle': [RING, 'M8.3 12.3l2.6 2.6 4.8-5.3'],
  circle: [RING],
  'circle-dot': [RING, ['c', 12, 12, 3.2, FILLED]],
  'circle-half': [RING, ['p', 'M12 6.2a5.8 5.8 0 0 1 0 11.6z', FILLED]],
  'circle-dashed': [['c', 12, 12, 9, { 'stroke-dasharray': '3.6 3.47' }]],
  'x-circle': [RING, 'M9 9l6 6', 'M15 9l-6 6'],
  ban: [RING, 'M5.7 5.7l12.6 12.6'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  'chevron-right': ['M9 6l6 6-6 6'],
  'chevron-down': ['M6 9l6 6 6-6'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  'chevron-up': ['M6 15l6-6 6 6'],
  'more-horizontal': [dot(5, 12, 1.5), dot(12, 12, 1.5), dot(19, 12, 1.5)],
  search: [['c', 11, 11, 6.5], 'M16 16l4.5 4.5'],
  filter: ['M4 5.5h16l-6.3 7.3v5.4l-3.4 1.6v-7z'],
  sort: ['M7 4v16', 'M3.5 16.5L7 20l3.5-3.5', 'M17 20V4', 'M13.5 7.5L17 4l3.5 3.5'],
  calendar: CALENDAR,
  'calendar-week': [...CALENDAR, ['p', 'M7.5 15h9', { 'stroke-width': 2.4 }]],
  clock: [RING, 'M12 7.5V12l3 2'],
  timer: [['c', 12, 13.5, 7.5], 'M12 13.5V10', 'M9.5 3h5', 'M12 3v3', 'M18.3 7.2l1.2-1.2'],
  play: ['M8 5.5v13l10.5-6.5z'],
  pause: [['r', 7, 5, 3.6, 14, 1], ['r', 13.4, 5, 3.6, 14, 1]],
  stop: [['r', 6, 6, 12, 12, 2]],
  flag: ['M5 21V4', 'M5 4.5h11.5l-2 4 2 4H5'],
  link: [
    'M10 13.5a4.5 4.5 0 0 0 6.5.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.4 1.4',
    'M14 10.5a4.5 4.5 0 0 0-6.5-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4',
  ],
  unlink: [
    'M16.2 14.2l3.3-3.3a4.5 4.5 0 0 0-6.4-6.4l-1.4 1.4',
    'M7.8 9.8l-3.3 3.3a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4',
    'M8 3.5v2.3',
    'M3.5 8h2.3',
    'M16 20.5v-2.3',
    'M20.5 16h-2.3',
  ],
  lock: [['r', 5, 11, 14, 9.5, 2], 'M8 11V7.5a4 4 0 0 1 8 0V11'],
  'alert-triangle': ['M12 4.2L21 19.5H3z', 'M12 10v4.2', 'M12 17.1v.01'],
  'alert-circle': [RING, 'M12 7.8v5', 'M12 16.2v.01'],
  info: [RING, 'M12 11v5.2', 'M12 7.8v.01'],
  'help-circle': [RING, 'M9.6 9.4a2.5 2.5 0 1 1 3.7 2.2c-.8.5-1.3 1-1.3 1.9', 'M12 16.7v.01'],
  archive: [['r', 3.5, 4.5, 17, 4.5, 1], 'M5 9v9a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V9', 'M10 13h4'],
  trash: [
    'M4.5 6.5h15',
    'M9 6.5V4.8a.8.8 0 0 1 .8-.8h4.4a.8.8 0 0 1 .8.8v1.7',
    'M6.5 6.5l.8 12.1a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12.1',
    'M10 10.5V16',
    'M14 10.5V16',
  ],
  copy: [['r', 8.5, 8.5, 11.5, 11.5, 2], 'M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5'],
  pencil: ['M4 20l1-4.2L16.3 4.5a1.8 1.8 0 0 1 2.6 0l.6.6a1.8 1.8 0 0 1 0 2.6L8.2 19z', 'M14.5 6.3l3.2 3.2'],
  move: ['M12 3v18', 'M3 12h18', 'M9 6l3-3 3 3', 'M9 18l3 3 3-3', 'M6 9l-3 3 3 3', 'M18 9l3 3-3 3'],
  message: ['M20 12.2a7.7 7.7 0 0 1-11.3 6.8L4 20l1.1-4.4A7.7 7.7 0 1 1 20 12.2z'],
  'file-text': [
    'M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z',
    'M14 3.5V8h4.5',
    'M9 12.5h6',
    'M9 16h6',
  ],
  list: ['M9 6.5h11', 'M9 12h11', 'M9 17.5h11', 'M4.5 6.5v.01', 'M4.5 12v.01', 'M4.5 17.5v.01'],
  kanban: [['r', 3.5, 4, 5, 16, 1.2], ['r', 9.5, 4, 5, 9.5, 1.2], ['r', 15.5, 4, 5, 13, 1.2]],
  tree: [['r', 3.5, 3, 7, 5, 1.2], 'M7 8v10.5h4.5', 'M7 12h4.5', ['r', 11.5, 9.5, 9, 5, 1.2], ['r', 11.5, 16, 9, 5, 1.2]],
  inbox: [
    'M3.5 13l3-8h11l3 8',
    'M3.5 13v5A1.5 1.5 0 0 0 5 19.5h14a1.5 1.5 0 0 0 1.5-1.5v-5',
    'M3.5 13h5l1.2 2.5h4.6l1.2-2.5h5',
  ],
  chart: ['M4 20h16', 'M7 20v-6', 'M12 20V5', 'M17 20v-9'],
  dashboard: [['r', 3.5, 3.5, 7, 9, 1.2], ['r', 13.5, 3.5, 7, 5, 1.2], ['r', 13.5, 11.5, 7, 9, 1.2], ['r', 3.5, 15.5, 7, 5, 1.2]],
  settings: [
    ['c', 12, 12, 2.6],
    ['c', 12, 12, 6.6],
    'M12 2.8v2.6',
    'M12 18.6v2.6',
    'M2.8 12h2.6',
    'M18.6 12h2.6',
    'M5.5 5.5l1.8 1.8',
    'M16.7 16.7l1.8 1.8',
    'M5.5 18.5l1.8-1.8',
    'M16.7 7.3l1.8-1.8',
  ],
  user: [['c', 12, 8, 3.8], 'M4.8 20a7.2 7.2 0 0 1 14.4 0'],
  cloud: [CLOUD],
  'cloud-off': [CLOUD, SLASH],
  refresh: ['M4 12a8 8 0 0 1 14-5.3', 'M18.5 3v4h-4', 'M20 12a8 8 0 0 1-14 5.3', 'M5.5 21v-4h4'],
  sun: [
    ['c', 12, 12, 4],
    'M12 2.5v2',
    'M12 19.5v2',
    'M2.5 12h2',
    'M19.5 12h2',
    'M5.3 5.3l1.4 1.4',
    'M17.3 17.3l1.4 1.4',
    'M5.3 18.7l1.4-1.4',
    'M17.3 6.7l1.4-1.4',
  ],
  moon: ['M20 14.5A8.5 8.5 0 1 1 9.5 4 6.8 6.8 0 0 0 20 14.5z'],
  grip: [dot(9, 6, 1.3), dot(15, 6, 1.3), dot(9, 12, 1.3), dot(15, 12, 1.3), dot(9, 18, 1.3), dot(15, 18, 1.3)],
  'arrow-right': ['M5 12h14', 'M13 6l6 6-6 6'],
  'arrow-left': ['M19 12H5', 'M11 6l-6 6 6 6'],
  'arrow-up': ['M12 19V5', 'M6 11l6-6 6 6'],
  'arrow-down': ['M12 5v14', 'M6 13l6 6 6-6'],
  'rotate-ccw': ['M4 12a8 8 0 1 0 2.6-5.9L4 8.5', 'M4 4v4.5h4.5'],
  undo: ['M8 14l-4-4 4-4', 'M4 10h10.5a5.5 5.5 0 0 1 0 11H11'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 13.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4.5'],
  folder: ['M3.5 7a2 2 0 0 1 2-2h3.6l2 2.5h7.4a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
  target: [RING, ['c', 12, 12, 5], dot(12, 12, 1.4)],
  layers: ['M12 3.5l8.5 4.5-8.5 4.5L3.5 8z', 'M3.5 12l8.5 4.5 8.5-4.5', 'M3.5 16l8.5 4.5 8.5-4.5'],
  zap: ['M13 3L5 13.5h6L10.5 21l8-10.5h-6z'],
  hourglass: [
    'M6.5 3.5h11',
    'M6.5 20.5h11',
    'M7.5 3.5v3.2c0 1.6.8 2.6 2 3.6L12 12l2.5-1.7c1.2-1 2-2 2-3.6V3.5',
    'M7.5 20.5v-3.2c0-1.6.8-2.6 2-3.6L12 12l2.5 1.7c1.2 1 2 2 2 3.6v3.2',
  ],
  eye: [EYE, ['c', 12, 12, 2.8]],
  'eye-off': [EYE, ['c', 12, 12, 2.8], SLASH],
  download: ['M12 4v11', 'M7.5 10.5L12 15l4.5-4.5', 'M4.5 19.5h15'],
  printer: ['M7 9V4h10v5', ['r', 4, 9, 16, 7, 2], 'M7 14h10v6H7z'],
  share: ['M12 15V4', 'M8 7.5L12 4l4 3.5', 'M8 11H6.5A2.5 2.5 0 0 0 4 13.5v4A2.5 2.5 0 0 0 6.5 20h11a2.5 2.5 0 0 0 2.5-2.5v-4a2.5 2.5 0 0 0-2.5-2.5H16'],
  mail: [['r', 3.5, 5.5, 17, 13, 2], 'M4 7.5l8 5.5 8-5.5'],
  upload: ['M12 15V4', 'M7.5 8.5L12 4l4.5 4.5', 'M4.5 19.5h15'],
  logout: ['M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10', 'M15 8l4 4-4 4', 'M19 12H9.5'],
  login: ['M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14', 'M10 8l4 4-4 4', 'M14 12H4.5'],
  keyboard: [
    ['r', 2.5, 6, 19, 12, 2],
    'M6.5 10v.01',
    'M10 10v.01',
    'M14 10v.01',
    'M17.5 10v.01',
    'M6.5 14v.01',
    'M17.5 14v.01',
    'M9.5 14h5',
  ],
  menu: ['M4 6.5h16', 'M4 12h16', 'M4 17.5h16'],
  'panel-right': [['r', 3.5, 4.5, 17, 15, 2], 'M14.5 4.5v15'],
  tag: ['M3.5 12.3V5A1.5 1.5 0 0 1 5 3.5h7.3l8.2 8.2a1.5 1.5 0 0 1 0 2.1l-6.7 6.7a1.5 1.5 0 0 1-2.1 0z', 'M8 8v.01'],
  bell: ['M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z', 'M10 20.5a2.2 2.2 0 0 0 4 0'],
  home: ['M4 11l8-7 8 7', 'M6 9.5V19a1 1 0 0 0 1 1h3.5v-5.5h3V20H17a1 1 0 0 0 1-1V9.5'],
  sparkles: [
    'M10 4l1.6 4.4L16 10l-4.4 1.6L10 16l-1.6-4.4L4 10l4.4-1.6z',
    'M17.5 14l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z',
  ],
  'git-branch': [['c', 6.5, 5.5, 2.2], ['c', 6.5, 18.5, 2.2], ['c', 17.5, 8, 2.2], 'M6.5 7.7v8.6', 'M17.5 10.2c0 3.2-3 4.4-11 4.4'],
  columns: [['r', 3.5, 4.5, 17, 15, 2], 'M9.2 4.5v15', 'M14.8 4.5v15'],
  rows: [['r', 3.5, 4.5, 17, 15, 2], 'M3.5 9.5h17', 'M3.5 14.5h17'],
  maximize: ['M4.5 9V4.5H9', 'M15 4.5h4.5V9', 'M19.5 15v4.5H15', 'M9 19.5H4.5V15'],
  'signal-1': signal(1),
  'signal-2': signal(2),
  'signal-3': signal(3),
  'signal-4': signal(4),
};

/** Nomes de todos os ícones disponíveis (ordem alfabética). */
export const ICON_NAMES = Object.freeze(Object.keys(ICONS).sort());

/** Desenho neutro usado quando o nome não existe. */
const PLACEHOLDER = [['r', 4.5, 4.5, 15, 15, 3, { 'stroke-dasharray': '2.5 2.5' }]];

const warned = new Set();

function shape(def) {
  if (typeof def === 'string') return s('path', { d: def });
  const kind = def[0];
  if (kind === 'c') return s('circle', { cx: def[1], cy: def[2], r: def[3], ...(def[4] || null) });
  if (kind === 'r') {
    const extra = typeof def[5] === 'object' ? def[5] : def[6];
    const rx = typeof def[5] === 'number' ? def[5] : null;
    return s('rect', { x: def[1], y: def[2], width: def[3], height: def[4], rx, ...(extra || null) });
  }
  return s('path', { d: def[1], ...(def[2] || null) });
}

/**
 * Existe um ícone com esse nome?
 * @param {string} name
 * @returns {boolean}
 */
export function hasIcon(name) {
  return typeof name === 'string' && Object.hasOwn(ICONS, name);
}

/**
 * Cria um ícone SVG (traço, cor do texto ao redor).
 *
 *   icon('plus')                              // 16 px, decorativo (aria-hidden)
 *   icon('alert-triangle', { size: 14, class: 'text-warning' })
 *   icon('lock', { title: 'Bloqueada por dependência' })   // com nome acessível e dica nativa
 *
 * Nome desconhecido desenha um quadrado tracejado neutro e avisa uma única vez no console.
 *
 * @param {string} name um dos nomes em ICON_NAMES
 * @param {{ size?: number, class?: string|Array|object, title?: string }} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 16, class: className, title } = {}) {
  let shapes = hasIcon(name) ? ICONS[name] : null;
  if (shapes === null) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[kit] ícone desconhecido: "${String(name)}"`);
    }
    shapes = PLACEHOLDER;
  }
  const px = Number.isFinite(size) && size > 0 ? size : 16;
  const labelled = typeof title === 'string' && title !== '';
  return s(
    'svg',
    {
      class: ['icon', className],
      width: px,
      height: px,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.75,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      focusable: 'false',
      'data-icon': hasIcon(name) ? name : 'placeholder',
      role: labelled ? 'img' : null,
      'aria-hidden': labelled ? null : 'true',
      'aria-label': labelled ? title : null,
    },
    labelled ? s('title', null, title) : null,
    shapes.map(shape),
  );
}
