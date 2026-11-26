// Elementos de exibição do kit: selos, indicadores de status/prioridade/prazo, progresso, etiquetas,
// estados vazios, cabeçalhos de seção, cartões de número, avisos e esqueletos de carregamento.
//
// Funções puras: recebem dados e devolvem um elemento (ou null quando não há o que mostrar).
// Quando recebem `onclick`, viram <button> (acessíveis pelo teclado); sem ele, são texto comum.
//
// Exemplos vivos de tudo: dev/kit.html.

import { cx, h } from '../../core/dom.js';
import { formatDate } from '../../core/dates.js';
import { formatPercent, initials } from '../../core/format.js';
import { priorityById } from '../../domain/priorities.js';
import { icon as makeIcon } from './icons.js';

/** Tons aceitos por badge(): semânticos + as cores de status. */
export const TONES = Object.freeze(['neutral', 'accent', 'info', 'success', 'warning', 'danger', 'gray', 'slate', 'blue', 'amber', 'red', 'violet', 'green']);

/** Cores de status conhecidas (campo `color` de um status). Qualquer outra cai em 'gray'. */
export const STATUS_COLORS = Object.freeze(['gray', 'slate', 'blue', 'amber', 'red', 'violet', 'green', 'neutral']);

/** Ícone de cada categoria de status — a forma muda junto com a cor (a cor nunca é a única pista). */
export const STATUS_ICONS = Object.freeze({
  backlog: 'circle-dashed',
  planned: 'circle',
  active: 'circle-half',
  waiting: 'hourglass',
  blocked: 'ban',
  review: 'eye',
  done: 'check-circle',
  cancelled: 'x-circle',
});

const TONE_ALIASES = { default: 'neutral', ok: 'success', warn: 'warning', error: 'danger', muted: 'neutral' };

function toneOf(tone) {
  const name = TONE_ALIASES[tone] || tone;
  return TONES.includes(name) ? name : 'neutral';
}

function toIcon(value, size = 14, className) {
  if (value == null || value === false || value === '') return null;
  if (typeof value === 'string') return makeIcon(value, { size, class: className });
  return value;
}

/** <button> quando há onclick; senão <span>. */
function clickable(onclick, props, ...children) {
  if (typeof onclick === 'function') return h('button', { type: 'button', ...props, onclick }, ...children);
  return h('span', props, ...children);
}

// ---------------------------------------------------------------------------
// Selos
// ---------------------------------------------------------------------------

/**
 * Selo de texto curto.
 *
 *   badge('Novo', { tone: 'accent' })
 *   badge('Atrasada', { tone: 'danger', icon: 'alert-triangle' })
 *   badge('3 pendentes', { tone: 'warning', soft: false })     // preenchido
 *
 * @param {string|number|Node} text
 * @param {object} [options]
 * @param {'neutral'|'accent'|'info'|'success'|'warning'|'danger'|'gray'|'slate'|'blue'|'amber'|'red'|'violet'|'green'} [options.tone='neutral']
 * @param {string|Node} [options.icon]
 * @param {boolean} [options.soft=true] true = fundo suave; false = preenchido com a cor sólida
 * @param {string} [options.title]
 * @param {(ev: MouseEvent) => void} [options.onclick]
 * @param {string|Array|object} [options.class]
 * @returns {HTMLElement}
 */
export function badge(text, { tone = 'neutral', icon, soft = true, title, onclick, class: className } = {}) {
  return clickable(
    onclick,
    { class: cx('badge', `badge-${toneOf(tone)}`, !soft && 'badge-solid', className), title: title || null },
    toIcon(icon, 12),
    text == null || text === '' ? null : h('span', { class: 'badge-text' }, text),
  );
}

/**
 * Contador pequeno (número em pílula). Devolve null para valores vazios; zero só aparece com `showZero`.
 *
 *   countBadge(12)                         // "12"
 *   countBadge(240, { max: 99 })           // "99+"
 *   countBadge(3, { tone: 'danger' })      // atrasadas
 *
 * @param {number|null} n
 * @param {{ tone?: string, max?: number, showZero?: boolean, title?: string, class?: string }} [options]
 * @returns {HTMLSpanElement|null}
 */
export function countBadge(n, { tone = 'neutral', max = 999, showZero = false, title, class: className } = {}) {
  const value = Number(n);
  if (n == null || n === '' || !Number.isFinite(value)) return null;
  if (value === 0 && !showZero) return null;
  const text = value > max ? `${max}+` : String(value);
  return h('span', { class: cx('count', `count-${toneOf(tone)}`, 'tabular', className), title: title || null }, text);
}

// ---------------------------------------------------------------------------
// Status, prioridade e prazo
// ---------------------------------------------------------------------------

/**
 * Indicador de status: ícone da categoria (na cor do status) + rótulo.
 *
 *   statusBadge(statusById(statuses, tarefa.status))
 *   statusBadge(status, { compact: true })                            // só o ícone, com dica
 *   statusBadge(status, { onclick: (ev) => pickStatus(ev.currentTarget, …) })   // vira botão
 *   statusBadge(status, { soft: true })                               // pílula com fundo suave
 *
 * @param {{ id?: string, label?: string, category?: string, color?: string }|null} status definição do status
 *        (de domain/statuses.js); null mostra "Sem status"
 * @param {object} [options]
 * @param {boolean} [options.compact] só o ícone (o rótulo vira dica e nome acessível)
 * @param {(ev: MouseEvent) => void} [options.onclick]
 * @param {string} [options.title] dica (padrão: o rótulo, quando compacto)
 * @param {boolean} [options.soft] fundo suave na cor do status
 * @param {number} [options.size=14] tamanho do ícone
 * @param {string|Array|object} [options.class]
 * @returns {HTMLElement}
 */
export function statusBadge(status, { compact = false, onclick, title, soft = false, size = 14, class: className } = {}) {
  const def = status && typeof status === 'object' ? status : {};
  const label = def.label ? String(def.label) : 'Sem status';
  const color = STATUS_COLORS.includes(def.color) ? def.color : 'gray';
  const glyph = STATUS_ICONS[def.category] || STATUS_ICONS.planned;
  return clickable(
    onclick,
    {
      class: cx('status', `status-${color}`, compact && 'status-compact', soft && 'status-soft', className),
      title: title || (compact ? label : null),
      'aria-label': compact ? `Status: ${label}` : null,
      role: compact && typeof onclick !== 'function' ? 'img' : null,
      'data-status': def.id || null,
      'data-category': def.category || null,
    },
    makeIcon(glyph, { size, class: 'status-icon' }),
    compact ? null : h('span', { class: 'status-label' }, label),
  );
}

/**
 * Indicador de prioridade — discreto: barras de sinal (4 = P1 … 1 = P4) + o código.
 *
 *   priorityBadge('P1')
 *   priorityBadge(tarefa.priority, { compact: true })                 // só as barras, com dica
 *   priorityBadge('P2', { onclick: (ev) => pickPriority(ev.currentTarget, { current: 'P2' }) })
 *
 * Id desconhecido cai na prioridade padrão (P3), como em domain/priorities.js.
 *
 * @param {string|null} priorityId 'P1'…'P4'
 * @param {object} [options]
 * @param {boolean} [options.compact] só o desenho
 * @param {(ev: MouseEvent) => void} [options.onclick]
 * @param {boolean} [options.showLabel] acrescenta o nome ("Crítica", "Alta"…)
 * @param {string|Array|object} [options.class]
 * @returns {HTMLElement}
 */
export function priorityBadge(priorityId, { compact = false, onclick, showLabel = false, class: className } = {}) {
  const def = priorityById(priorityId);
  const bars = 5 - def.rank; // P1 = 4 barras
  const description = `Prioridade ${def.id} — ${def.label}`;
  return clickable(
    onclick,
    {
      class: cx('priority', `priority-${def.id.toLowerCase()}`, compact && 'priority-compact', className),
      title: description,
      'aria-label': compact ? description : null,
      role: compact && typeof onclick !== 'function' ? 'img' : null,
      'data-priority': def.id,
    },
    makeIcon(`signal-${bars}`, { size: 14, class: 'priority-icon' }),
    compact ? null : h('span', { class: 'priority-code tabular' }, def.id),
    !compact && showLabel ? h('span', { class: 'priority-label' }, def.label) : null,
  );
}

const DEADLINE_TONES = { ok: 'ok', warn: 'warn', danger: 'danger', muted: 'muted', success: 'success' };

/**
 * Desenho de cada estado de prazo (domain/deadlines.js) — a forma muda junto com a cor, para que estados de
 * mesmo tom não se confundam: "próxima do vencimento" (relógio) × "concluída com atraso" (marca de concluída
 * com o atraso escrito) × "no prazo" (calendário).
 */
const DEADLINE_GLYPHS = Object.freeze({
  on_time: 'calendar',
  due_soon: 'clock',
  overdue: 'alert-circle',
  done_on_time: 'check',
  done_late: 'check',
  done: 'check',
});

/**
 * Indicador de prazo. Recebe o objeto devolvido por deadlineInfo() (domain/deadlines.js).
 *
 *   deadlineChip(app.sel.deadline(tarefa))                          // "em 3 dias", "há 2 dias", "5 dez"
 *   deadlineChip(info, { showLabel: true })                         // sem prazo → "Sem prazo" esmaecido
 *   deadlineChip(info, { onclick: (ev) => pickDate(ev.currentTarget, { value: info.due_date }) })
 *
 * Sem prazo: devolve null — a menos que `showLabel` (mostra "Sem prazo") ou `onclick` (mostra só o
 * calendário, para o usuário poder definir um prazo).
 *
 * @param {{ state?: string, label?: string, shortLabel?: string, tone?: string, daysLate?: number, due_date?: string|null }|null} info
 * @param {object} [options]
 * @param {(ev: MouseEvent) => void} [options.onclick]
 * @param {boolean} [options.showLabel] mostra "Sem prazo" quando não há prazo
 * @param {string|Array|object} [options.class]
 * @returns {HTMLElement|null}
 */
export function deadlineChip(info, { onclick, showLabel = false, class: className } = {}) {
  const data = info && typeof info === 'object' ? info : {};
  const due = typeof data.due_date === 'string' && data.due_date ? data.due_date : null;
  const interactive = typeof onclick === 'function';

  if (due === null) {
    if (!showLabel && !interactive) return null;
    return clickable(
      onclick,
      {
        class: cx('deadline', 'deadline-muted', 'is-empty', className),
        title: interactive ? 'Definir prazo' : null,
        'aria-label': !showLabel ? 'Definir prazo' : null,
      },
      makeIcon('calendar', { size: 14, class: 'deadline-icon' }),
      showLabel ? h('span', { class: 'deadline-text' }, 'Sem prazo') : null,
    );
  }

  const tone = DEADLINE_TONES[data.tone] || 'muted';
  const text = data.shortLabel || formatDate(due, 'short');
  const daysLate = Number(data.daysLate) > 0 ? Math.round(Number(data.daysLate)) : 0;
  const late = daysLate > 0 ? ` (${daysLate} ${daysLate === 1 ? 'dia' : 'dias'})` : '';
  const detail = `Prazo: ${formatDate(due, 'numeric')}${data.label ? ` · ${data.label}${late}` : ''}`;
  const glyph = DEADLINE_GLYPHS[data.state] || 'calendar';
  // Concluída com atraso: além do tom, o atraso aparece no próprio selo ("+6d") — dá para ler sem a cor e sem a dica.
  const lateMark = data.state === 'done_late' && daysLate > 0 ? h('span', { class: 'deadline-late tabular' }, `+${daysLate}d`) : null;
  return clickable(
    onclick,
    {
      class: cx('deadline', `deadline-${tone}`, className),
      title: detail,
      'data-state': data.state || null,
    },
    makeIcon(glyph, { size: 14, class: 'deadline-icon' }),
    h('span', { class: 'deadline-text tabular' }, text),
    lateMark,
  );
}

// ---------------------------------------------------------------------------
// Progresso
// ---------------------------------------------------------------------------

/**
 * Barra de progresso. `value` vai de 0 a 1; null/undefined mostra um travessão (sem tarefas contáveis).
 *
 *   progressBar(0.42, { showLabel: true })           // barra + "42%"
 *   progressBar(app.sel.demandProgress(id).value)    // pode ser null → "—"
 *   progressBar(1)                                   // completa fica verde
 *
 * @param {number|null} value fração 0..1 (valores fora da faixa são limitados)
 * @param {object} [options]
 * @param {'md'|'sm'} [options.size='md'] espessura (6 px ou 4 px)
 * @param {boolean} [options.showLabel] mostra o percentual ao lado
 * @param {'accent'|'success'|'warning'|'danger'|'neutral'} [options.tone] padrão: destaque (verde quando completa)
 * @param {string} [options.title]
 * @param {string|Array|object} [options.class]
 * @returns {HTMLElement}
 */
export function progressBar(value, { size = 'md', showLabel = false, tone, title, class: className } = {}) {
  const number = value == null || value === '' ? NaN : Number(value);
  if (!Number.isFinite(number)) {
    return h('span', { class: cx('progress', 'progress-empty', className), title: title || 'Sem tarefas para medir o progresso', 'aria-label': 'Progresso indisponível' }, '—');
  }
  const fraction = Math.min(1, Math.max(0, number));
  const percent = Math.round(fraction * 100);
  const resolved = tone || (fraction >= 1 ? 'success' : 'accent');
  return h(
    'span',
    {
      class: cx('progress', size === 'sm' && 'progress-sm', `progress-${resolved}`, className),
      role: 'progressbar',
      'aria-valuemin': 0,
      'aria-valuemax': 100,
      'aria-valuenow': percent,
      'aria-label': 'Progresso',
      title: title || formatPercent(fraction),
    },
    h('span', { class: 'progress-track' }, h('span', { class: 'progress-fill', style: { width: `${percent}%` } })),
    showLabel ? h('span', { class: 'progress-label tabular' }, formatPercent(fraction)) : null,
  );
}

// ---------------------------------------------------------------------------
// Etiquetas e pessoas
// ---------------------------------------------------------------------------

/**
 * Etiqueta (tag).
 *
 *   tagChip('financeiro')
 *   tagChip('urgente', { onremove: () => removerEtiqueta('urgente') })
 *   tagChip('cliente-x', { onclick: () => filtrarPor('cliente-x') })
 *
 * @param {string} text
 * @param {object} [options]
 * @param {(ev: MouseEvent) => void} [options.onremove] mostra o "x" de remover
 * @param {(ev: MouseEvent) => void} [options.onclick]
 * @param {string|Array|object} [options.class]
 * @returns {HTMLSpanElement}
 */
export function tagChip(text, { onremove, onclick, class: className } = {}) {
  const label = text == null ? '' : String(text);
  const body =
    typeof onclick === 'function'
      ? h('button', { type: 'button', class: 'chip-text', onclick, title: label }, label)
      : h('span', { class: 'chip-text', title: label }, label);
  return h(
    'span',
    { class: cx('chip', typeof onclick === 'function' && 'chip-clickable', className) },
    body,
    typeof onremove === 'function'
      ? h('button', { type: 'button', class: 'chip-remove', onclick: onremove, title: `Remover ${label}`, 'aria-label': `Remover ${label}` }, makeIcon('x', { size: 10 }))
      : null,
  );
}

/**
 * Lista de etiquetas, com limite opcional ("+2").
 *
 *   tagList(tarefa.tags, { max: 3 })
 *   tagList(tags, { onremove: (tag) => …, onclick: (tag) => … })
 *
 * @param {string[]|null} tags
 * @param {object} [options]
 * @param {number} [options.max] quantas mostrar antes de resumir em "+N"
 * @param {(tag: string, ev: MouseEvent) => void} [options.onremove]
 * @param {(tag: string, ev: MouseEvent) => void} [options.onclick]
 * @param {string|Array|object} [options.class]
 * @returns {HTMLSpanElement|null} null quando não há etiquetas
 */
export function tagList(tags, { max, onremove, onclick, class: className } = {}) {
  const list = Array.isArray(tags) ? tags.filter((tag) => tag != null && String(tag).trim() !== '').map(String) : [];
  if (list.length === 0) return null;
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : list.length;
  const shown = list.slice(0, limit);
  const hidden = list.slice(limit);
  return h(
    'span',
    { class: cx('chip-list', className) },
    shown.map((tag) =>
      tagChip(tag, {
        onremove: typeof onremove === 'function' ? (ev) => onremove(tag, ev) : undefined,
        onclick: typeof onclick === 'function' ? (ev) => onclick(tag, ev) : undefined,
      }),
    ),
    hidden.length > 0 ? h('span', { class: 'chip chip-more tabular', title: hidden.join(', ') }, `+${hidden.length}`) : null,
  );
}

const AVATAR_COLORS = ['blue', 'violet', 'green', 'amber', 'red', 'slate'];

function hashText(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

/**
 * Círculo com as iniciais de uma pessoa (a cor é estável para o mesmo nome).
 *
 *   avatar('Ana Souza')                 // "AS"
 *   avatar('Ana', { size: 28 })
 *
 * @param {string|null} name
 * @param {{ size?: number, class?: string }} [options]
 * @returns {HTMLSpanElement}
 */
export function avatar(name, { size = 20, class: className } = {}) {
  const text = name == null ? '' : String(name).trim();
  const letters = initials(text);
  const color = text ? AVATAR_COLORS[hashText(text.toLowerCase()) % AVATAR_COLORS.length] : 'gray';
  return h(
    'span',
    {
      class: cx('avatar', `avatar-${color}`, className),
      style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.max(9, Math.round(size * 0.44))}px` },
      title: text || 'Sem responsável',
      role: 'img',
      'aria-label': text || 'Sem responsável',
    },
    letters || makeIcon('user', { size: Math.round(size * 0.6) }),
  );
}

/**
 * Responsável: avatar + nome. Devolve null quando não há nome.
 *
 *   ownerChip(tarefa.owner)
 *
 * @param {string|null} name
 * @param {{ onclick?: (ev: MouseEvent) => void, class?: string }} [options]
 * @returns {HTMLElement|null}
 */
export function ownerChip(name, { onclick, class: className } = {}) {
  const text = name == null ? '' : String(name).trim();
  if (!text) return null;
  return clickable(onclick, { class: cx('owner', className), title: text }, avatar(text, { size: 18 }), h('span', { class: 'owner-name' }, text));
}

// ---------------------------------------------------------------------------
// Teclas, divisores e carregamento
// ---------------------------------------------------------------------------

/**
 * Teclas de atalho.
 *
 *   kbd('Ctrl+K')         // <kbd>Ctrl</kbd><kbd>K</kbd>
 *   kbd(['g', 'd'])       // sequência
 *
 * @param {string|string[]} keys 'Ctrl+K' ou lista de teclas
 * @returns {HTMLSpanElement}
 */
export function kbd(keys) {
  const parts = Array.isArray(keys) ? keys : String(keys == null ? '' : keys).split('+');
  return h(
    'span',
    { class: 'kbd-group' },
    parts.map((part) => String(part).trim()).filter(Boolean).map((part) => h('kbd', { class: 'kbd' }, part)),
  );
}

/**
 * Indicador de carregamento giratório.
 *
 *   spinner()                       // 16 px
 *   spinner({ size: 24, label: 'Sincronizando' })
 *
 * @param {{ size?: number, label?: string, class?: string }} [options]
 * @returns {HTMLSpanElement}
 */
export function spinner({ size = 16, label = 'Carregando', class: className } = {}) {
  return h('span', { class: cx('spinner', className), role: 'status', 'aria-label': label, style: { width: `${size}px`, height: `${size}px` } });
}

/**
 * Linha divisória (horizontal por padrão), com rótulo opcional no meio.
 *
 *   divider()
 *   divider({ label: 'ou' })
 *   divider({ vertical: true })     // dentro de uma .row
 *
 * @param {{ label?: string, vertical?: boolean, class?: string }} [options]
 * @returns {HTMLElement}
 */
export function divider({ label, vertical = false, class: className } = {}) {
  if (vertical) return h('span', { class: cx('divider', 'divider-vertical', className), role: 'separator', 'aria-orientation': 'vertical' });
  if (label) return h('div', { class: cx('divider', 'divider-labelled', className), role: 'separator' }, h('span', { class: 'divider-label' }, label));
  return h('hr', { class: cx('divider', className) });
}

/**
 * Esqueleto de carregamento: linhas de lista "fantasma".
 *
 *   skeletonRows(5)                       // cinco linhas de lista
 *   skeletonRows(3, { avatar: true })
 *
 * @param {number} [rows=3]
 * @param {{ avatar?: boolean, class?: string }} [options]
 * @returns {HTMLDivElement}
 */
export function skeletonRows(rows = 3, { avatar: withAvatar = false, class: className } = {}) {
  const count = Number.isFinite(rows) && rows > 0 ? Math.min(50, Math.floor(rows)) : 3;
  const widths = [62, 48, 74, 55, 68, 42];
  return h(
    'div',
    { class: cx('skeleton-rows', className), role: 'status', 'aria-label': 'Carregando', 'aria-busy': true },
    Array.from({ length: count }, (_, index) =>
      h(
        'div',
        { class: 'skeleton-row' },
        h('span', { class: cx('skeleton', withAvatar ? 'skeleton-circle' : 'skeleton-dot') }),
        h('span', { class: 'skeleton skeleton-line', style: { width: `${widths[index % widths.length]}%` } }),
        h('span', { class: 'skeleton skeleton-line skeleton-short' }),
      ),
    ),
  );
}

/**
 * Bloco fantasma avulso (para montar esqueletos sob medida).
 *
 *   skeleton({ width: 120, height: 14 })
 *   skeleton({ width: '100%', height: 160, radius: 10 })    // lugar de um gráfico
 *
 * @param {{ width?: number|string, height?: number|string, radius?: number, class?: string }} [options]
 * @returns {HTMLSpanElement}
 */
export function skeleton({ width = '100%', height = 12, radius, class: className } = {}) {
  const px = (value) => (typeof value === 'number' ? `${value}px` : value);
  return h('span', {
    class: cx('skeleton', 'skeleton-block', className),
    'aria-hidden': 'true',
    style: { width: px(width), height: px(height), borderRadius: radius == null ? null : `${radius}px` },
  });
}

// ---------------------------------------------------------------------------
// Blocos de página
// ---------------------------------------------------------------------------

/**
 * Estado vazio de uma lista ou tela.
 *
 *   emptyState({ icon: 'inbox', title: 'Nada por aqui', text: 'Crie a primeira demanda para começar.',
 *                action: button({ label: 'Nova demanda', variant: 'primary', icon: 'plus', onclick }) })
 *   emptyState({ icon: 'search', title: 'Nenhum resultado', compact: true })
 *
 * @param {object} options
 * @param {string|Node} [options.icon]
 * @param {string} [options.title]
 * @param {string|Node} [options.text]
 * @param {Node|Node[]} [options.action] botão(ões) de ação
 * @param {boolean} [options.compact] menos espaço em volta (dentro de cartões)
 * @param {string|Array|object} [options.class]
 * @returns {HTMLDivElement}
 */
export function emptyState({ icon, title, text, action, compact = false, class: className } = {}) {
  return h(
    'div',
    { class: cx('empty', compact && 'empty-compact', className) },
    icon ? h('div', { class: 'empty-icon' }, toIcon(icon, compact ? 20 : 28)) : null,
    title ? h('div', { class: 'empty-title' }, title) : null,
    text ? h('div', { class: 'empty-text' }, text) : null,
    action ? h('div', { class: 'empty-action' }, action) : null,
  );
}

/**
 * Cabeçalho de seção (título + contagem + ações), opcionalmente recolhível.
 *
 *   sectionHeader({ title: 'Atrasadas', count: 4 })
 *   sectionHeader({ title: 'Concluídas', count: 18, collapsed: state.fechado, ontoggle: () => setState({ fechado: !state.fechado }),
 *                   actions: iconButton({ icon: 'plus', title: 'Adicionar', size: 'sm', onclick }) })
 *
 * @param {object} options
 * @param {string|Node} options.title
 * @param {number|null} [options.count]
 * @param {Node|Node[]} [options.actions] controles à direita
 * @param {boolean} [options.collapsed] estado recolhido (só faz sentido com ontoggle)
 * @param {(ev: MouseEvent) => void} [options.ontoggle] se informado, o título vira um botão de recolher/expandir
 * @param {string|Node} [options.icon]
 * @param {string|Array|object} [options.class]
 * @returns {HTMLDivElement}
 */
export function sectionHeader({ title, count, actions, collapsed = false, ontoggle, icon, class: className } = {}) {
  const heading = [
    toIcon(icon, 14, 'section-icon'),
    h('span', { class: 'section-title' }, title),
    count == null ? null : h('span', { class: 'section-count tabular' }, String(count)),
  ];
  const collapsible = typeof ontoggle === 'function';
  return h(
    'div',
    { class: cx('section-header', collapsed && 'is-collapsed', className) },
    collapsible
      ? h(
          'button',
          { type: 'button', class: 'section-toggle', 'aria-expanded': !collapsed, onclick: ontoggle },
          makeIcon('chevron-down', { size: 14, class: 'section-chevron' }),
          heading,
        )
      : h('div', { class: 'section-heading', role: 'heading', 'aria-level': 3 }, heading),
    actions ? h('div', { class: 'section-actions' }, actions) : null,
  );
}

/**
 * Cartão de indicador (um número em destaque).
 *
 *   statCard({ label: 'Concluídas na semana', value: 12, hint: 'meta: 15' })
 *   statCard({ label: 'Atrasadas', value: 4, tone: 'danger', icon: 'alert-triangle',
 *              trend: { direction: 'up', text: '+2 vs. semana passada', good: false } })
 *   statCard({ label: 'Horas', value: '32,5 h', chart: sparkline([4, 6, 5, 8, 7]) })
 *
 * @param {object} options
 * @param {string} options.label
 * @param {string|number|Node} options.value já formatado (use core/format.js)
 * @param {string|Node} [options.hint] linha de apoio
 * @param {'neutral'|'accent'|'success'|'warning'|'danger'|'info'} [options.tone='neutral'] cor do ícone e do valor
 * @param {string|Node} [options.icon]
 * @param {{ direction?: 'up'|'down'|'flat', text: string, good?: boolean|null }} [options.trend]
 *        variação: a seta mostra a direção; `good` define a cor (true verde, false vermelho, null neutro)
 * @param {Node} [options.chart] minigráfico à direita (ex.: sparkline)
 * @param {string} [options.unit] unidade mostrada menor, logo depois do valor ('h', 'dias', '%')
 * @param {string} [options.help] explicação do indicador: ícone "?" com dica (e dica no cartão inteiro)
 * @param {(ev: MouseEvent) => void} [options.onclick]
 * @param {string|Array|object} [options.class]
 * @returns {HTMLElement}
 *
 *   statCard({ label: 'Lead time', value: '4,2', unit: 'dias', help: 'Da criação à conclusão (mediana).' })
 */
export function statCard({ label, value, hint, tone = 'neutral', icon, trend, chart, unit, help, onclick, class: className } = {}) {
  let trendNode = null;
  if (trend && typeof trend === 'object' && trend.text) {
    const direction = trend.direction === 'up' || trend.direction === 'down' ? trend.direction : 'flat';
    const quality = trend.good === true ? 'good' : trend.good === false ? 'bad' : 'neutral';
    const arrow = direction === 'up' ? 'arrow-up' : direction === 'down' ? 'arrow-down' : 'minus';
    trendNode = h('span', { class: cx('stat-trend', `stat-trend-${quality}`) }, makeIcon(arrow, { size: 12 }), h('span', null, trend.text));
  }
  const empty = value == null || value === '';
  const helpText = typeof help === 'string' && help.trim() ? help.trim() : null;
  const unitText = !empty && unit != null && String(unit).trim() ? String(unit).trim() : null;
  return clickable(
    onclick,
    { class: cx('stat', `stat-${toneOf(tone)}`, typeof onclick === 'function' && 'stat-clickable', className), title: helpText },
    h(
      'span',
      { class: 'stat-main' },
      h(
        'span',
        { class: 'stat-label' },
        toIcon(icon, 14, 'stat-icon'),
        h('span', { class: 'truncate' }, label),
        helpText ? h('span', { class: 'stat-help', title: helpText, role: 'img', 'aria-label': helpText }, makeIcon('help-circle', { size: 12 })) : null,
      ),
      h('span', { class: 'stat-value' }, empty ? '—' : value, unitText ? h('span', { class: 'stat-unit' }, unitText) : null),
      trendNode || hint ? h('span', { class: 'stat-foot' }, trendNode, hint ? h('span', { class: 'stat-hint' }, hint) : null) : null,
    ),
    chart ? h('span', { class: 'stat-chart' }, chart) : null,
  );
}

const ALERT_ICONS = { info: 'info', success: 'check-circle', warning: 'alert-triangle', danger: 'alert-circle', neutral: 'info', accent: 'sparkles' };

/**
 * Caixa de aviso dentro da página.
 *
 *   alertBox({ tone: 'warning', title: 'Pesos não somam 100%', text: 'A soma atual é 80%.' })
 *   alertBox({ tone: 'danger', text: 'Falha ao sincronizar.', actions: button({ label: 'Tentar de novo', size: 'sm', onclick }) })
 *   alertBox({ tone: 'info', text: 'Sugestão: subir para P2.', ondismiss: () => dispensar() })
 *
 * @param {object} options
 * @param {'info'|'success'|'warning'|'danger'|'neutral'|'accent'} [options.tone='info']
 * @param {string|Node|false} [options.icon] padrão: o ícone do tom; false = sem ícone
 * @param {string} [options.title]
 * @param {string|Node} [options.text]
 * @param {Node|Node[]} [options.actions]
 * @param {(ev: MouseEvent) => void} [options.ondismiss] mostra o "x" de dispensar
 * @param {string|Array|object} [options.class]
 * @returns {HTMLDivElement}
 */
export function alertBox({ tone = 'info', icon, title, text, actions, ondismiss, class: className } = {}) {
  const resolved = toneOf(tone);
  const glyph = icon === false ? null : icon || ALERT_ICONS[resolved] || 'info';
  return h(
    'div',
    { class: cx('alert', `alert-${resolved}`, className), role: resolved === 'danger' || resolved === 'warning' ? 'alert' : 'status' },
    glyph ? h('span', { class: 'alert-icon' }, toIcon(glyph, 16)) : null,
    h(
      'div',
      { class: 'alert-main' },
      h('div', { class: 'alert-body' }, title ? h('div', { class: 'alert-title' }, title) : null, text ? h('div', { class: 'alert-text' }, text) : null),
      actions ? h('div', { class: 'alert-actions' }, actions) : null,
    ),
    typeof ondismiss === 'function'
      ? h('button', { type: 'button', class: 'alert-dismiss', onclick: ondismiss, title: 'Dispensar', 'aria-label': 'Dispensar' }, makeIcon('x', { size: 14 }))
      : null,
  );
}
