// Atalhos de teclado. Sem dependências.
//
//   const shortcuts = createShortcuts({ isBlocked: () => modalAberto() });
//   shortcuts.register({ keys: 'n', label: 'Nova tarefa', group: 'Criar', run: () => … });
//   shortcuts.register({ keys: 'mod+k', label: 'Buscar', group: 'Geral', allowInInput: true, run: … });
//   shortcuts.register({ keys: 'g d', label: 'Ir para o Dashboard', group: 'Navegação', run: … });
//
// Sintaxe de `keys`: modificadores e tecla unidos por '+' ('shift+n', 'mod+enter', 'ctrl+alt+x');
// sequências separadas por espaço ('g d'). 'mod' = Ctrl no Windows/Linux e Cmd no macOS.
// Nomes de tecla: letras, dígitos, símbolos ('?', '/', '.'), 'escape' (esc), 'enter', 'delete' (del),
// 'backspace', 'tab', 'space', 'up' / 'down' / 'left' / 'right', 'home', 'end', 'pageup', 'pagedown', 'f1'…

/** Prazo padrão entre as teclas de uma sequência ('g d'). */
const SEQUENCE_TIMEOUT_MS = 1200;

const KEY_ALIASES = {
  esc: 'escape',
  del: 'delete',
  return: 'enter',
  space: ' ',
  spacebar: ' ',
  espaco: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  plus: '+',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
};

const MODIFIER_ALIASES = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  mod: 'mod',
};

/** Teclas que são só modificadores: nunca disparam atalho nem interrompem uma sequência. */
const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta', 'altgraph', 'capslock', 'numlock', 'scrolllock', 'fn', 'fnlock', 'os', 'hyper', 'super', 'symbol', 'symbollock']);

/** Tipos de <input> em que não se digita texto (o foco neles não bloqueia atalhos de letras). */
const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'file', 'color', 'range']);

/** Teclas com função própria em controles focados (botão, link, caixa de seleção, controle deslizante…). */
const ACTIVATION_KEYS = new Set(['enter', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

const ACTIVATABLE_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab', 'checkbox', 'radio', 'switch', 'slider', 'treeitem']);

const KEY_LABELS = {
  escape: 'Esc',
  enter: 'Enter',
  delete: 'Del',
  backspace: 'Backspace',
  tab: 'Tab',
  ' ': 'Espaço',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  insert: 'Ins',
};

function detectMac() {
  try {
    const nav = globalThis.navigator;
    if (!nav) return false;
    const platform = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || '';
    return /mac|iphone|ipad|ipod/i.test(platform);
  } catch {
    return false;
  }
}

const isLetter = (ch) => ch.length === 1 && ch.toLowerCase() !== ch.toUpperCase();
const isDigit = (ch) => ch.length === 1 && ch >= '0' && ch <= '9';

/** Interpreta uma combinação ('mod+k', 'shift+n', '?', 'ctrl++'). Lança TypeError se for inválida. */
function parseCombo(text) {
  let rest = text;
  let key = null;
  // A própria tecla '+': sozinha ou no fim ('ctrl++').
  if (rest === '+') {
    key = '+';
    rest = '';
  } else if (rest.endsWith('++')) {
    key = '+';
    rest = rest.slice(0, -2);
  }
  const tokens = rest === '' ? [] : rest.split('+');
  if (key === null) key = tokens.pop();
  if (key === undefined || key === '') throw new TypeError(`Atalho inválido: "${text}"`);
  const combo = { key: '', ctrl: false, alt: false, shift: false, meta: false, mod: false, shiftGiven: false };
  for (const token of tokens) {
    const modifier = MODIFIER_ALIASES[token.toLowerCase()];
    if (modifier === undefined) throw new TypeError(`Modificador desconhecido em "${text}": "${token}"`);
    combo[modifier] = true;
    if (modifier === 'shift') combo.shiftGiven = true;
  }
  const lower = key.toLowerCase();
  if (MODIFIER_ALIASES[lower] !== undefined && lower.length > 1) throw new TypeError(`Atalho sem tecla: "${text}"`);
  combo.key = KEY_ALIASES[lower] !== undefined ? KEY_ALIASES[lower] : lower;
  return combo;
}

/** Interpreta `keys` ('g d', 'mod+k') numa lista de combinações (uma por passo da sequência). */
function parseKeys(keys) {
  // Um espaço sozinho é a tecla de espaço; nos demais casos os espaços separam os passos da sequência.
  if (keys === ' ') return [parseCombo('space')];
  if (typeof keys !== 'string' || keys.trim() === '') throw new TypeError('Atalho inválido: keys precisa ser um texto como "n", "mod+k" ou "g d"');
  return keys.trim().split(/\s+/).map(parseCombo);
}

/**
 * O evento corresponde à combinação?
 * Compara event.key sem diferenciar maiúsculas e exige exatamente os mesmos modificadores. Para símbolos e
 * dígitos ('?', '/', '1') o Shift é ignorado quando o atalho não o pede — ele depende do layout do teclado.
 */
function comboMatches(combo, event, mac) {
  const rawKey = typeof event.key === 'string' ? event.key : '';
  const key = rawKey.toLowerCase();
  let ctrl = !!event.ctrlKey;
  let alt = !!event.altKey;
  const shift = !!event.shiftKey;
  const meta = !!event.metaKey;
  const symbol = combo.key.length === 1 && combo.key !== ' ' && !isLetter(combo.key);
  // AltGr (Windows) chega como Ctrl+Alt: para caracteres produzidos com ele, esses dois não contam.
  if (symbol && ctrl && alt && typeof event.getModifierState === 'function' && event.getModifierState('AltGraph')) {
    ctrl = false;
    alt = false;
  }
  const wantCtrl = combo.ctrl || (combo.mod && !mac);
  const wantMeta = combo.meta || (combo.mod && mac);
  if (ctrl !== wantCtrl || meta !== wantMeta || alt !== combo.alt) return false;

  let keyOk = key === combo.key;
  if (!keyOk && isDigit(combo.key) && typeof event.code === 'string') {
    // 'shift+1' (a tecla produz '!') e teclado numérico: confere a tecla física.
    if (combo.shift || combo.ctrl || combo.alt || combo.meta || combo.mod) keyOk = event.code === `Digit${combo.key}` || event.code === `Numpad${combo.key}`;
  }
  if (!keyOk) return false;

  if (symbol && !combo.shiftGiven) return true; // '?' vale com ou sem Shift, conforme o layout
  return shift === combo.shift;
}

/** Elemento em que o evento realmente aconteceu (atravessa shadow DOM). */
function eventTarget(event) {
  try {
    if (typeof event.composedPath === 'function') {
      const path = event.composedPath();
      if (path && path.length > 0) return path[0];
    }
  } catch {
    /* evento sintético sem composedPath */
  }
  return event.target || null;
}

/** O usuário está digitando em `el`? (campo de texto, textarea, select ou conteúdo editável) */
function isTypingTarget(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.nodeName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(String(el.type || '').toLowerCase());
  if (el.isContentEditable === true) return true;
  // isContentEditable só vale para elementos renderizados; confere o atributo nos ancestrais também.
  const host = typeof el.closest === 'function' ? el.closest('[contenteditable]') : null;
  if (host === null) return false;
  const mode = host.getAttribute('contenteditable');
  return mode !== null && mode.toLowerCase() !== 'false';
}

/** `el` é um controle que usa Enter/Espaço/setas por conta própria? (botão, link, caixa de seleção…) */
function isActivatable(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.nodeName;
  if (tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'INPUT') return true;
  if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href');
  const role = el.getAttribute('role');
  return role !== null && ACTIVATABLE_ROLES.has(role.toLowerCase());
}

function formatCombo(combo, mac) {
  const lower = combo.key;
  let label = KEY_LABELS[lower];
  if (label === undefined) {
    if (lower.length === 1) label = lower.toUpperCase();
    else if (/^f\d{1,2}$/.test(lower)) label = lower.toUpperCase();
    else label = lower.charAt(0).toUpperCase() + lower.slice(1);
  }
  const ctrl = combo.ctrl || (combo.mod && !mac);
  const meta = combo.meta || (combo.mod && mac);
  if (mac) {
    return `${ctrl ? '⌃' : ''}${combo.alt ? '⌥' : ''}${combo.shift ? '⇧' : ''}${meta ? '⌘' : ''}${label}`;
  }
  const parts = [];
  if (ctrl) parts.push('Ctrl');
  if (meta) parts.push('Win');
  if (combo.alt) parts.push('Alt');
  if (combo.shift) parts.push('Shift');
  parts.push(label);
  return parts.join('+');
}

/**
 * Rótulo legível de um atalho, para menus e para a ajuda de atalhos.
 *   formatKeys('mod+k') → 'Ctrl+K' (no macOS: '⌘K');  formatKeys('g d') → 'G então D';
 *   formatKeys('shift+n') → 'Shift+N';  formatKeys('escape') → 'Esc';  formatKeys('?') → '?'
 * Texto vazio ou inválido devolve ''.
 * @param {string} keys atalho na sintaxe de register()
 * @param {{ isMac?: boolean }} [options] força o estilo da plataforma (padrão: detecta pelo navegador)
 * @returns {string}
 */
export function formatKeys(keys, { isMac } = {}) {
  let combos;
  try {
    combos = parseKeys(keys);
  } catch {
    return '';
  }
  const mac = typeof isMac === 'boolean' ? isMac : detectMac();
  return combos.map((combo) => formatCombo(combo, mac)).join(' então ');
}

/**
 * Cria o gerenciador de atalhos de teclado e já passa a ouvir `keydown` em `target`.
 *
 * `register(def)` → função que cancela o registro. `def`:
 *   - `keys`: texto ('n', 'shift+n', 'mod+k', 'g d', '?', 'escape', 'delete', '1') ou lista de alternativas;
 *   - `label`, `group`: textos mostrados na ajuda de atalhos (`list()`);
 *   - `run(event)`: ação (o valor devolvido é ignorado; uma exceção é registrada com console.error);
 *   - `when()`: opcional; o atalho só vale quando devolve verdadeiro;
 *   - `allowInInput`: vale mesmo com o foco num campo de digitação (input de texto, textarea, select,
 *     contenteditable) ou, para Enter/Espaço/setas, num botão/link/caixa de seleção;
 *   - `global`: continua valendo quando `isBlocked()` devolve true (ex.: um modal aberto).
 *
 * `handle(event)` → true quando algum atalho rodou (e então chama `event.preventDefault()`).
 * Regras de correspondência:
 *   - `event.key` sem diferenciar maiúsculas, com exatamente os mesmos modificadores; em símbolos e dígitos
 *     ('?', '/') o Shift não é exigido nem proibido, pois depende do layout do teclado;
 *   - sequências ('g d'): a tecla seguinte precisa chegar em até 1,2 s; a primeira tecla de uma sequência tem
 *     precedência sobre um atalho de tecla única igual; uma tecla que não continua a sequência a cancela e é
 *     avaliada do zero;
 *   - entre atalhos com as mesmas teclas, vale o registrado por último que esteja habilitado (`when`);
 *   - eventos já tratados (`defaultPrevented`), de composição (IME) e teclas só modificadoras são ignorados.
 *
 * `list()` → `[{ keys, label, group }]` na ordem de registro (atalhos com `hidden: true` ficam de fora).
 * `setEnabled(false)` suspende tudo; `destroy()` remove o ouvinte e os registros.
 *
 * @param {{ target?: EventTarget|null, isBlocked?: () => boolean, isMac?: boolean, sequenceTimeout?: number, now?: () => number }} [options]
 *   `isMac`, `sequenceTimeout` (ms) e `now` (relógio em ms) existem para testes.
 * @returns {{
 *   register: (def: object) => (() => void),
 *   list: () => Array<{ keys: string, label: string, group: string }>,
 *   handle: (event: KeyboardEvent) => boolean,
 *   setEnabled: (enabled: boolean) => void,
 *   destroy: () => void,
 * }}
 */
export function createShortcuts({
  target = typeof window !== 'undefined' ? window : null,
  isBlocked = () => false,
  isMac,
  sequenceTimeout = SEQUENCE_TIMEOUT_MS,
  now = () => performance.now(),
} = {}) {
  const mac = typeof isMac === 'boolean' ? isMac : detectMac();
  /** @type {Array<{ def: object, keys: string, sequences: Array<Array<object>> }>} */
  let entries = [];
  let enabled = true;
  let destroyed = false;
  /** Sequência em andamento: candidatos (entrada + sequência) e quantos passos já casaram. */
  let pending = null;

  function register(def) {
    if (def === null || typeof def !== 'object') throw new TypeError('shortcuts.register: informe { keys, label, group, run }');
    if (typeof def.run !== 'function') throw new TypeError('shortcuts.register: run precisa ser uma função');
    const alternatives = Array.isArray(def.keys) ? def.keys : [def.keys];
    if (alternatives.length === 0) throw new TypeError('shortcuts.register: keys está vazio');
    const entry = { def, keys: String(alternatives[0]), sequences: alternatives.map(parseKeys) };
    entries.push(entry);
    return () => {
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
      if (pending !== null) pending.candidates = pending.candidates.filter((item) => item.entry !== entry);
    };
  }

  function list() {
    return entries
      .filter((entry) => entry.def.hidden !== true)
      .map((entry) => ({ keys: entry.keys, label: entry.def.label || '', group: entry.def.group || '' }));
  }

  function blocked() {
    try {
      return !!isBlocked();
    } catch (err) {
      console.error('[shortcuts] erro em isBlocked()', err);
      return false;
    }
  }

  /** O atalho pode rodar neste contexto? (foco, modal aberto, condição `when`) */
  function eligible(def, context, lastCombo) {
    if (context.blocked && def.global !== true) return false;
    if (def.allowInInput !== true) {
      if (context.typing) return false;
      const plain = !lastCombo.ctrl && !lastCombo.alt && !lastCombo.meta && !lastCombo.mod;
      if (context.activatable && plain && ACTIVATION_KEYS.has(lastCombo.key)) return false;
    }
    if (typeof def.when === 'function') {
      try {
        if (!def.when()) return false;
      } catch (err) {
        console.error('[shortcuts] erro em when()', err);
        return false;
      }
    }
    return true;
  }

  /** Roda o atalho; um erro na ação é registrado e não se propaga para o tratador de teclado. */
  function execute(def, event) {
    event.preventDefault();
    try {
      def.run(event);
    } catch (err) {
      console.error(`[shortcuts] erro ao executar o atalho "${def.label || def.keys}"`, err);
    }
  }

  function handle(event) {
    if (!enabled || destroyed || !event || event.defaultPrevented) return false;
    if (event.isComposing === true || event.keyCode === 229) return false; // digitação por IME
    const rawKey = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (rawKey === '' || rawKey === 'dead' || rawKey === 'unidentified' || rawKey === 'process') return false;
    if (MODIFIER_KEYS.has(rawKey)) return false; // não dispara nada nem interrompe uma sequência

    const el = eventTarget(event);
    const context = { typing: isTypingTarget(el), activatable: isActivatable(el), blocked: blocked() };
    const time = now();

    // 1) Continuação de uma sequência em andamento ('g' já foi, agora vem o 'd').
    if (pending !== null) {
      const previous = pending;
      pending = null;
      if (time <= previous.expires) {
        const step = previous.step;
        const complete = [];
        const partial = [];
        for (const item of previous.candidates) {
          const sequence = item.sequence;
          if (!comboMatches(sequence[step], event, mac)) continue;
          if (sequence.length === step + 1) complete.push(item);
          else partial.push(item);
        }
        for (let i = complete.length - 1; i >= 0; i--) {
          const { entry, sequence } = complete[i];
          if (!eligible(entry.def, context, sequence[step])) continue;
          execute(entry.def, event);
          return true;
        }
        const alive = partial.filter((item) => eligible(item.entry.def, context, item.sequence[step]));
        if (alive.length > 0) {
          pending = { candidates: alive, step: step + 1, expires: time + sequenceTimeout };
          return false;
        }
      }
      // Não continuou a sequência (ou o prazo venceu): a tecla é avaliada do zero, logo abaixo.
    }

    // 2) Primeira tecla: começo de sequência tem precedência sobre atalho de tecla única.
    const singles = [];
    const starters = [];
    for (const entry of entries) {
      for (const sequence of entry.sequences) {
        if (!comboMatches(sequence[0], event, mac)) continue;
        if (sequence.length === 1) singles.push({ entry, sequence });
        else starters.push({ entry, sequence });
      }
    }
    const aliveStarters = starters.filter((item) => eligible(item.entry.def, context, item.sequence[0]));
    if (aliveStarters.length > 0) {
      pending = { candidates: aliveStarters, step: 1, expires: time + sequenceTimeout };
      return false;
    }
    for (let i = singles.length - 1; i >= 0; i--) {
      const { entry, sequence } = singles[i];
      if (!eligible(entry.def, context, sequence[0])) continue;
      execute(entry.def, event);
      return true;
    }
    return false;
  }

  function onKeyDown(event) {
    handle(event);
  }

  function setEnabled(value) {
    enabled = !!value;
    if (!enabled) pending = null;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    pending = null;
    entries = [];
    if (target && typeof target.removeEventListener === 'function') target.removeEventListener('keydown', onKeyDown);
  }

  if (target && typeof target.addEventListener === 'function') target.addEventListener('keydown', onKeyDown);

  return { register, list, handle, setEnabled, destroy };
}
