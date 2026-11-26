// Controles do kit: botões, campos, seleção, abas, edição no lugar.
//
// Todos são FUNÇÕES PURAS DE RENDERIZAÇÃO: recebem opções e devolvem um elemento criado com h().
// Podem ser chamados a cada render — o morph (core/dom.js) aplica só a diferença e preserva foco e digitação.
//
// Convenções (valem para todos):
//   • callbacks recebem (valor, evento): oninput(texto, ev), onchange(valor, ev)…
//   • `class` acrescenta classes ao elemento raiz; `attrs` acrescenta atributos ao elemento nativo
//     (ex.: attrs: { 'data-entity': 'task:1', name: 'titulo' });
//   • `size: 'sm'` = 24 px de altura (padrão 'md' = 28 px);
//   • `icon` aceita o nome de um ícone (icons.js) ou um nó pronto.
//
// Exemplos vivos de tudo: dev/kit.html.

import { cx, h } from '../../core/dom.js';
import { icon as makeIcon } from './icons.js';

/** Ícone a partir de um nome ou de um nó pronto (null quando não há). */
function toIcon(value, size = 16, className) {
  if (value == null || value === false || value === '') return null;
  if (typeof value === 'string') return makeIcon(value, { size, class: className });
  return value;
}

/** Só inclui a chave `value` quando o chamador informou um valor (campo "controlado" pelo render). */
function valueProp(value) {
  return value === undefined ? null : { value: value == null ? '' : String(value) };
}

function call(fn, ...args) {
  return typeof fn === 'function' ? fn(...args) : undefined;
}

/** Monta as teclas de um atalho ('Ctrl+K' → <kbd>Ctrl</kbd><kbd>K</kbd>). */
function shortcutHint(keys) {
  if (keys == null || keys === '') return null;
  const parts = Array.isArray(keys) ? keys : String(keys).split('+');
  return h(
    'span',
    { class: 'kbd-group btn-kbd', 'aria-hidden': 'true' },
    parts.filter((part) => part !== '').map((part) => h('kbd', { class: 'kbd' }, String(part).trim())),
  );
}

// ---------------------------------------------------------------------------
// Botões
// ---------------------------------------------------------------------------

/**
 * Botão.
 *
 *   button({ label: 'Salvar', variant: 'primary', onclick: salvar })
 *   button({ label: 'Nova tarefa', icon: 'plus', kbd: 'N', size: 'sm' })
 *   button({ label: 'Excluir', variant: 'danger', disabled: true })
 *   button({ label: 'Filtros', icon: 'filter', active: temFiltro })   // aria-pressed + realce
 *
 * @param {object} options
 * @param {string|Node} [options.label] texto do botão
 * @param {string|Node} [options.icon] ícone à esquerda (nome ou nó)
 * @param {string|Node} [options.iconRight] ícone à direita
 * @param {'default'|'primary'|'ghost'|'danger'|'subtle'} [options.variant='default']
 *        default = contorno; primary = cor de destaque; ghost = sem contorno; danger = ação destrutiva;
 *        subtle = fundo suave
 * @param {'md'|'sm'} [options.size='md']
 * @param {(ev: MouseEvent) => void} [options.onclick]
 * @param {string} [options.title] dica nativa
 * @param {boolean} [options.disabled]
 * @param {string|string[]} [options.kbd] atalho mostrado à direita ('N', 'Ctrl+K')
 * @param {boolean} [options.active] estado ligado/desligado (define aria-pressed)
 * @param {'button'|'submit'|'reset'} [options.type='button']
 * @param {string} [options.ariaLabel]
 * @param {boolean} [options.block] ocupa a largura toda
 * @param {string|Array|object} [options.class]
 * @param {object} [options.attrs] atributos extras do <button>
 * @returns {HTMLButtonElement}
 */
export function button({
  label,
  icon,
  iconRight,
  variant = 'default',
  size = 'md',
  onclick,
  title,
  disabled = false,
  kbd,
  active,
  type = 'button',
  ariaLabel,
  block = false,
  class: className,
  attrs,
} = {}) {
  const iconSize = size === 'sm' ? 14 : 16;
  return h(
    'button',
    {
      type,
      class: cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', active && 'is-active', block && 'btn-block', className),
      onclick,
      title,
      disabled: !!disabled,
      'aria-pressed': active === undefined ? null : !!active,
      'aria-label': ariaLabel || null,
      ...attrs,
    },
    toIcon(icon, iconSize),
    label == null || label === '' ? null : h('span', { class: 'btn-label' }, label),
    shortcutHint(kbd),
    toIcon(iconRight, iconSize),
  );
}

/**
 * Botão só com ícone. `title` é obrigatório: vira a dica nativa E o nome acessível (aria-label).
 *
 *   iconButton({ icon: 'more-horizontal', title: 'Mais ações', onclick: abrirMenu })
 *   iconButton({ icon: 'panel-right', title: 'Painel', active: aberto, size: 'sm' })
 *
 * @param {object} options
 * @param {string|Node} options.icon
 * @param {string} options.title
 * @param {(ev: MouseEvent) => void} [options.onclick]
 * @param {'md'|'sm'} [options.size='md']
 * @param {boolean} [options.active]
 * @param {boolean} [options.disabled]
 * @param {'ghost'|'default'|'primary'|'danger'|'subtle'} [options.variant='ghost']
 * @param {string|Array|object} [options.class]
 * @param {object} [options.attrs]
 * @returns {HTMLButtonElement}
 */
export function iconButton({ icon, title, onclick, size = 'md', active, disabled = false, variant = 'ghost', class: className, attrs } = {}) {
  if (!title) console.warn('[kit] iconButton sem title: o botão fica sem nome acessível');
  return h(
    'button',
    {
      type: 'button',
      class: cx('btn', 'btn-icon', `btn-${variant}`, size === 'sm' && 'btn-sm', active && 'is-active', className),
      onclick,
      title: title || null,
      'aria-label': title || null,
      'aria-pressed': active === undefined ? null : !!active,
      disabled: !!disabled,
      ...attrs,
    },
    toIcon(icon, size === 'sm' ? 14 : 16),
  );
}

// ---------------------------------------------------------------------------
// Campos de texto
// ---------------------------------------------------------------------------

/**
 * Foca uma única vez o campo marcado com autofocus, quando ele já está no documento.
 * O campo leva o atributo data-autofocus (e não o `autofocus` nativo, que o navegador processa por conta
 * própria ao inserir o elemento): as camadas do kit procuram por ele para decidir o foco inicial.
 */
function focusOnce(el) {
  if (el.__autofocused || !el.isConnected) return;
  el.__autofocused = true;
  if (document.activeElement !== el) el.focus({ preventScroll: true });
}

function inputOf(target) {
  const root = target.closest('.input');
  return root ? root.querySelector('input, textarea') : null;
}

/**
 * Campo de texto de uma linha.
 *
 *   textInput({ value: nome, placeholder: 'Nome da demanda', oninput: (v) => setState({ nome: v }) })
 *   textInput({ value: q, icon: 'search', clearable: true, onenter: buscar, onescape: fechar })
 *
 * `value` definido = campo controlado (o render impõe o valor, mas o morph nunca atropela quem está digitando).
 * Sem `value`, o campo guarda o que o usuário digitou.
 *
 * @param {object} options
 * @param {string|number|null} [options.value]
 * @param {string} [options.placeholder]
 * @param {(text: string, ev: Event) => void} [options.oninput] a cada tecla
 * @param {(text: string, ev: Event) => void} [options.onchange] ao confirmar (Enter/sair do campo)
 * @param {(text: string, ev: KeyboardEvent) => void} [options.onenter]
 * @param {(text: string, ev: KeyboardEvent) => void} [options.onescape] se informado, o Esc não fecha o que está em volta
 * @param {(text: string, ev: FocusEvent) => void} [options.onblur]
 * @param {string} [options.type='text'] text, search, email, password, url, tel…
 * @param {'md'|'sm'} [options.size='md']
 * @param {string|Node} [options.icon] ícone à esquerda
 * @param {boolean} [options.clearable] mostra o botão "limpar" quando há texto
 * @param {() => void} [options.onclear] chamado depois de limpar (além de oninput/onchange com '')
 * @param {boolean} [options.autofocus]
 * @param {string} [options.ariaLabel]
 * @param {boolean} [options.disabled]
 * @param {boolean} [options.readonly]
 * @param {boolean} [options.invalid] marca o campo como inválido (aria-invalid)
 * @param {number} [options.maxlength]
 * @param {string|Array|object} [options.class]
 * @param {object} [options.attrs] atributos extras do <input>
 * @returns {HTMLSpanElement} `<span class="input">` contendo o `<input class="input-el">`
 */
export function textInput({
  value,
  placeholder,
  oninput,
  onchange,
  onenter,
  onescape,
  onblur,
  type = 'text',
  size = 'md',
  icon,
  clearable = false,
  onclear,
  autofocus = false,
  ariaLabel,
  disabled = false,
  readonly = false,
  invalid = false,
  maxlength,
  class: className,
  attrs,
} = {}) {
  const onkeydown =
    onenter || onescape
      ? (ev) => {
          if (ev.isComposing) return;
          if (ev.key === 'Enter' && onenter) {
            ev.preventDefault();
            onenter(ev.currentTarget.value, ev);
          } else if (ev.key === 'Escape' && onescape) {
            ev.preventDefault();
            ev.stopPropagation();
            onescape(ev.currentTarget.value, ev);
          }
        }
      : null;

  const clear = (ev) => {
    const input = inputOf(ev.currentTarget);
    if (!input || input.disabled || input.readOnly) return;
    input.value = '';
    call(oninput, '', ev);
    call(onchange, '', ev);
    call(onclear);
    input.focus();
  };

  return h(
    'span',
    {
      class: cx('input', size === 'sm' && 'input-sm', icon && 'has-icon', clearable && 'has-clear', disabled && 'is-disabled', invalid && 'is-invalid', className),
    },
    toIcon(icon, 14, 'input-icon'),
    h('input', {
      class: 'input-el',
      type,
      // o botão "limpar" some por CSS (:placeholder-shown) — por isso sempre existe um placeholder
      placeholder: placeholder || (clearable ? ' ' : null),
      'aria-label': ariaLabel || placeholder || null,
      'aria-invalid': invalid ? true : null,
      disabled: !!disabled,
      readonly: !!readonly,
      maxlength: maxlength || null,
      autocomplete: 'off',
      spellcheck: type === 'text' ? null : false,
      'data-autofocus': autofocus ? true : null,
      ref: autofocus ? focusOnce : null,
      oninput: oninput ? (ev) => oninput(ev.currentTarget.value, ev) : null,
      onchange: onchange ? (ev) => onchange(ev.currentTarget.value, ev) : null,
      onblur: onblur ? (ev) => onblur(ev.currentTarget.value, ev) : null,
      onkeydown,
      ...valueProp(value),
      ...attrs,
    }),
    clearable
      ? h('button', { type: 'button', class: 'input-clear', title: 'Limpar', 'aria-label': 'Limpar', tabindex: -1, onclick: clear }, makeIcon('x', { size: 12 }))
      : null,
  );
}

/**
 * Campo de busca: textInput com lupa, botão de limpar e Esc para limpar.
 *
 *   searchInput({ value: state.q, oninput: (q) => setState({ q }), placeholder: 'Buscar demandas…' })
 *
 * @param {object} options
 * @param {string} [options.value]
 * @param {string} [options.placeholder='Buscar…']
 * @param {(text: string, ev: Event) => void} [options.oninput]
 * @param {() => void} [options.onclear] chamado quando o usuário limpa (botão ou Esc com texto)
 * @param {(text: string, ev: KeyboardEvent) => void} [options.onenter]
 * @param {'md'|'sm'} [options.size='md']
 * @param {boolean} [options.autofocus]
 * @param {string} [options.ariaLabel]
 * @param {string|Array|object} [options.class]
 * @param {object} [options.attrs]
 * @returns {HTMLSpanElement}
 */
export function searchInput({ value, placeholder = 'Buscar…', oninput, onclear, onenter, size = 'md', autofocus = false, ariaLabel, class: className, attrs } = {}) {
  return textInput({
    value,
    placeholder,
    oninput,
    onclear,
    size,
    autofocus,
    ariaLabel: ariaLabel || placeholder,
    type: 'search',
    icon: 'search',
    clearable: true,
    class: cx('input-search', className),
    attrs: {
      // Esc com texto: limpa e fica no campo. Esc com o campo vazio: deixa passar (fecha o que estiver em volta).
      onkeydown: (ev) => {
        if (ev.isComposing) return;
        const input = ev.currentTarget;
        if (ev.key === 'Enter' && onenter) {
          ev.preventDefault();
          onenter(input.value, ev);
        } else if (ev.key === 'Escape' && input.value !== '') {
          ev.preventDefault();
          ev.stopPropagation();
          input.value = '';
          call(oninput, '', ev);
          call(onclear);
        }
      },
      ...attrs,
    },
  });
}

const SUPPORTS_FIELD_SIZING = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');

/** Ajusta a altura do <textarea> ao conteúdo (só onde o CSS field-sizing não existe). */
function growTextArea(el) {
  if (SUPPORTS_FIELD_SIZING || !el.isConnected) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}

/**
 * Campo de texto de várias linhas.
 *
 *   textArea({ value: descricao, rows: 4, autoGrow: true, onchange: (texto) => app.cmd.updateTask(id, { description: texto }) })
 *
 * @param {object} options
 * @param {string|null} [options.value]
 * @param {string} [options.placeholder]
 * @param {number} [options.rows=3]
 * @param {boolean} [options.autoGrow] cresce com o conteúdo (sem barra de rolagem)
 * @param {(text: string, ev: Event) => void} [options.onchange] ao sair do campo com alteração
 * @param {(text: string, ev: Event) => void} [options.oninput]
 * @param {(text: string, ev: FocusEvent) => void} [options.onblur]
 * @param {(text: string, ev: KeyboardEvent) => void} [options.onsubmit] Ctrl/Cmd+Enter
 * @param {string} [options.ariaLabel]
 * @param {boolean} [options.disabled]
 * @param {boolean} [options.invalid]
 * @param {number} [options.maxlength]
 * @param {boolean} [options.autofocus]
 * @param {string|Array|object} [options.class]
 * @param {object} [options.attrs]
 * @returns {HTMLTextAreaElement}
 */
export function textArea({
  value,
  placeholder,
  rows = 3,
  autoGrow = false,
  onchange,
  oninput,
  onblur,
  onsubmit,
  ariaLabel,
  disabled = false,
  invalid = false,
  maxlength,
  autofocus = false,
  class: className,
  attrs,
} = {}) {
  const ref =
    autoGrow || autofocus
      ? (el) => {
          if (autoGrow) growTextArea(el);
          if (autofocus) focusOnce(el);
        }
      : null;
  return h('textarea', {
    class: cx('textarea', autoGrow && 'textarea-autogrow', invalid && 'is-invalid', className),
    rows,
    placeholder: placeholder || null,
    'aria-label': ariaLabel || placeholder || null,
    'aria-invalid': invalid ? true : null,
    disabled: !!disabled,
    maxlength: maxlength || null,
    'data-autofocus': autofocus ? true : null,
    ref,
    oninput:
      oninput || autoGrow
        ? (ev) => {
            if (autoGrow) growTextArea(ev.currentTarget);
            call(oninput, ev.currentTarget.value, ev);
          }
        : null,
    onchange: onchange ? (ev) => onchange(ev.currentTarget.value, ev) : null,
    onblur: onblur ? (ev) => onblur(ev.currentTarget.value, ev) : null,
    onkeydown: onsubmit
      ? (ev) => {
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && !ev.isComposing) {
            ev.preventDefault();
            onsubmit(ev.currentTarget.value, ev);
          }
        }
      : null,
    ...valueProp(value),
    ...attrs,
  });
}

/**
 * Lista suspensa nativa.
 *
 *   selectInput({ value: ordem, options: [{ value: 'due_date', label: 'Prazo' }, { value: 'name', label: 'Nome' }],
 *                 onchange: (v) => setState({ ordem: v }) })
 *
 * @param {object} options
 * @param {string|number|null} [options.value]
 * @param {Array<{ value: string|number, label: string, disabled?: boolean }>} options.options
 * @param {(value: string, ev: Event) => void} [options.onchange]
 * @param {'md'|'sm'} [options.size='md']
 * @param {string} [options.ariaLabel]
 * @param {string} [options.placeholder] opção vazia inicial (valor '')
 * @param {boolean} [options.disabled]
 * @param {string|Array|object} [options.class]
 * @param {object} [options.attrs] atributos extras do <select>
 * @returns {HTMLSpanElement} `<span class="select">` contendo o `<select>`
 */
export function selectInput({ value, options = [], onchange, size = 'md', ariaLabel, placeholder, disabled = false, class: className, attrs } = {}) {
  const list = Array.isArray(options) ? options : [];
  return h(
    'span',
    { class: cx('select', size === 'sm' && 'select-sm', disabled && 'is-disabled', className) },
    h(
      'select',
      {
        class: 'select-el',
        'aria-label': ariaLabel || null,
        disabled: !!disabled,
        onchange: onchange ? (ev) => onchange(ev.currentTarget.value, ev) : null,
        ...valueProp(value),
        ...attrs,
      },
      placeholder ? h('option', { value: '' }, placeholder) : null,
      list.map((option) => {
        if (option == null) return null;
        const item = typeof option === 'object' ? option : { value: option, label: String(option) };
        return h('option', { value: item.value == null ? '' : String(item.value), disabled: !!item.disabled }, item.label == null ? String(item.value) : item.label);
      }),
    ),
    makeIcon('chevron-down', { size: 14, class: 'select-caret' }),
  );
}

/**
 * Caixa de seleção.
 *
 *   checkbox({ checked: tarefa.required, label: 'Obrigatória', onchange: (marcada) => … })
 *   checkbox({ checked: algumas, indeterminate: algumas && !todas, label: 'Selecionar todas' })
 *
 * @param {object} options
 * @param {boolean} [options.checked]
 * @param {string|Node} [options.label]
 * @param {(checked: boolean, ev: Event) => void} [options.onchange]
 * @param {boolean} [options.indeterminate] estado "parcial" (traço)
 * @param {boolean} [options.disabled]
 * @param {string} [options.ariaLabel] nome acessível quando não há label visível
 * @param {string} [options.title]
 * @param {string|Array|object} [options.class]
 * @param {object} [options.attrs] atributos extras do <input>
 * @returns {HTMLLabelElement}
 */
export function checkbox({ checked = false, label, onchange, indeterminate = false, disabled = false, ariaLabel, title, class: className, attrs } = {}) {
  return h(
    'label',
    { class: cx('checkbox', disabled && 'is-disabled', className), title: title || null },
    h('input', {
      type: 'checkbox',
      class: 'checkbox-input',
      checked: !!checked,
      indeterminate: !!indeterminate,
      disabled: !!disabled,
      'aria-label': ariaLabel || null,
      onchange: onchange ? (ev) => onchange(ev.currentTarget.checked, ev) : null,
      ...attrs,
    }),
    h('span', { class: 'checkbox-box', 'aria-hidden': 'true' }, makeIcon('check', { size: 12, class: 'checkbox-check' }), makeIcon('minus', { size: 12, class: 'checkbox-dash' })),
    label == null || label === '' ? null : h('span', { class: 'checkbox-label' }, label),
  );
}

/**
 * Interruptor liga/desliga.
 *
 *   switchInput({ checked: prefs.compacto, label: 'Modo compacto', onchange: (ligado) => … })
 *
 * @param {object} options
 * @param {boolean} [options.checked]
 * @param {string|Node} [options.label]
 * @param {(checked: boolean, ev: Event) => void} [options.onchange]
 * @param {boolean} [options.disabled]
 * @param {string} [options.ariaLabel]
 * @param {string|Array|object} [options.class]
 * @param {object} [options.attrs]
 * @returns {HTMLLabelElement}
 */
export function switchInput({ checked = false, label, onchange, disabled = false, ariaLabel, class: className, attrs } = {}) {
  return h(
    'label',
    { class: cx('switch', disabled && 'is-disabled', className) },
    h('input', {
      type: 'checkbox',
      role: 'switch',
      class: 'switch-input',
      checked: !!checked,
      disabled: !!disabled,
      'aria-label': ariaLabel || null,
      onchange: onchange ? (ev) => onchange(ev.currentTarget.checked, ev) : null,
      ...attrs,
    }),
    h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })),
    label == null || label === '' ? null : h('span', { class: 'switch-label' }, label),
  );
}

/**
 * Campo de data nativo. Troca strings 'YYYY-MM-DD' (null = sem data).
 *
 *   dateInput({ value: tarefa.planned_start, onchange: (data) => app.cmd.updateTask(id, { planned_start: data }) })
 *
 * @param {object} options
 * @param {string|null} [options.value] 'YYYY-MM-DD' ou null
 * @param {(value: string|null, ev: Event) => void} [options.onchange]
 * @param {string} [options.min] 'YYYY-MM-DD'
 * @param {string} [options.max] 'YYYY-MM-DD'
 * @param {boolean} [options.clearable] botão para limpar a data
 * @param {'md'|'sm'} [options.size='md']
 * @param {string} [options.ariaLabel]
 * @param {boolean} [options.disabled]
 * @param {string|Array|object} [options.class]
 * @param {object} [options.attrs]
 * @returns {HTMLSpanElement}
 */
export function dateInput({ value, onchange, min, max, clearable = false, size = 'md', ariaLabel, disabled = false, class: className, attrs } = {}) {
  const hasValue = value != null && value !== '';
  return h(
    'span',
    { class: cx('input', 'input-date', size === 'sm' && 'input-sm', clearable && 'has-clear', hasValue && 'has-value', disabled && 'is-disabled', className) },
    h('input', {
      class: 'input-el tabular',
      type: 'date',
      min: min || null,
      max: max || null,
      'aria-label': ariaLabel || null,
      disabled: !!disabled,
      onchange: (ev) => {
        const input = ev.currentTarget;
        const root = input.closest('.input');
        if (root) root.classList.toggle('has-value', input.value !== '');
        call(onchange, input.value || null, ev);
      },
      ...valueProp(value),
      ...attrs,
    }),
    clearable
      ? h(
          'button',
          {
            type: 'button',
            class: 'input-clear',
            title: 'Limpar data',
            'aria-label': 'Limpar data',
            onclick: (ev) => {
              const input = inputOf(ev.currentTarget);
              if (!input || input.disabled || input.value === '') return;
              input.value = '';
              const root = input.closest('.input');
              if (root) root.classList.remove('has-value');
              call(onchange, null, ev);
            },
          },
          makeIcon('x', { size: 12 }),
        )
      : null,
  );
}

/**
 * Campo numérico.
 *
 *   numberInput({ value: tarefa.weight, min: 0, max: 100, step: 5, suffix: '%', onchange: (n) => … })
 *
 * @param {object} options
 * @param {number|null} [options.value]
 * @param {number} [options.min]
 * @param {number} [options.max]
 * @param {number} [options.step]
 * @param {(value: number|null, ev: Event) => void} [options.onchange] número já limitado a min/max; null = campo vazio
 * @param {string} [options.suffix] unidade mostrada à direita ('%', 'h', 'dias')
 * @param {string} [options.placeholder]
 * @param {'md'|'sm'} [options.size='md']
 * @param {string} [options.ariaLabel]
 * @param {boolean} [options.disabled]
 * @param {string|Array|object} [options.class]
 * @param {object} [options.attrs]
 * @returns {HTMLSpanElement}
 */
export function numberInput({ value, min, max, step, onchange, suffix, placeholder, size = 'md', ariaLabel, disabled = false, class: className, attrs } = {}) {
  const shown = value === undefined ? undefined : Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : '';
  return h(
    'span',
    { class: cx('input', 'input-number', size === 'sm' && 'input-sm', disabled && 'is-disabled', className) },
    h('input', {
      class: 'input-el tabular',
      type: 'number',
      inputmode: 'decimal',
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
      step: Number.isFinite(step) ? step : null,
      placeholder: placeholder || null,
      'aria-label': ariaLabel || null,
      disabled: !!disabled,
      onchange: (ev) => {
        const input = ev.currentTarget;
        if (input.value.trim() === '') {
          call(onchange, null, ev);
          return;
        }
        let number = input.valueAsNumber;
        if (!Number.isFinite(number)) return; // texto que não é número: o navegador já sinaliza
        if (Number.isFinite(min) && number < min) number = min;
        if (Number.isFinite(max) && number > max) number = max;
        if (number !== input.valueAsNumber) input.value = String(number);
        call(onchange, number, ev);
      },
      ...valueProp(shown),
      ...attrs,
    }),
    suffix ? h('span', { class: 'input-suffix', 'aria-hidden': 'true' }, suffix) : null,
  );
}

// ---------------------------------------------------------------------------
// Duração
// ---------------------------------------------------------------------------

const DURATION_NUMBER = '(\\d+(?:[.,]\\d+)?)';
const DURATION_CLOCK = /^(\d+):([0-5]?\d)$/;
const DURATION_HOURS = new RegExp(`^${DURATION_NUMBER} ?(?:horas|hora|hrs|hr|h)(?: ?(?:e )?(\\d+) ?(?:minutos|minuto|mins|min|m)?)?$`);
const DURATION_MINUTES = new RegExp(`^${DURATION_NUMBER} ?(?:minutos|minuto|mins|min|m)$`);
const MAX_DURATION_MINUTES = 60 * 24 * 365;

/**
 * Lê uma duração digitada e devolve MINUTOS inteiros (mesmas regras de domain/timetracking.js).
 * Aceita '90' (minutos), '90m', '45 min', '1h', '1h30', '1h 30m', '1,5h', '1:30'. Devolve null se não entender.
 * @param {string|number|null} text
 * @returns {number|null}
 */
export function parseDurationText(text) {
  const finish = (minutes) => {
    if (!Number.isFinite(minutes) || minutes < 0) return null;
    const rounded = Math.round(minutes);
    return rounded > MAX_DURATION_MINUTES ? null : rounded;
  };
  if (typeof text === 'number') return finish(text);
  if (typeof text !== 'string') return null;
  const clean = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!clean) return null;
  const number = (value) => Number(value.replace(',', '.'));
  let match = DURATION_CLOCK.exec(clean);
  if (match) return finish(Number(match[1]) * 60 + Number(match[2]));
  if (/^\d+$/.test(clean)) return finish(Number(clean));
  match = DURATION_HOURS.exec(clean);
  if (match) return finish(number(match[1]) * 60 + (match[2] ? Number(match[2]) : 0));
  match = DURATION_MINUTES.exec(clean);
  if (match) return finish(number(match[1]));
  return null;
}

/**
 * Formata minutos como texto curto: 90 → '1h 30min'; 45 → '45min'; 120 → '2h'; null → ''.
 * @param {number|null} minutes
 * @returns {string}
 */
export function formatDurationText(minutes) {
  if (minutes == null || minutes === '' || !Number.isFinite(Number(minutes))) return '';
  const total = Math.max(0, Math.round(Number(minutes)));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest}min`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}min`;
}

/**
 * Campo de duração em texto livre ("1h30", "45min", "1,5h"). Trabalha em MINUTOS.
 *
 *   durationInput({ minutes: tarefa.estimate_minutes, onchange: (min) => app.cmd.updateTask(id, { estimate_minutes: min }) })
 *
 * Ao confirmar (Enter ou sair do campo): texto vazio → onchange(null); texto válido → o campo mostra a
 * duração formatada e chama onchange(minutos); texto inválido → o campo fica marcado como inválido e
 * onchange NÃO é chamado.
 *
 * @param {object} options
 * @param {number|null} [options.minutes]
 * @param {(minutes: number|null, ev: Event) => void} [options.onchange]
 * @param {string} [options.placeholder='ex.: 1h30']
 * @param {(text: string) => number|null} [options.parse] leitura do texto (padrão: parseDurationText)
 * @param {(minutes: number) => string} [options.format] formatação (padrão: formatDurationText)
 * @param {'md'|'sm'} [options.size='md']
 * @param {string} [options.ariaLabel='Duração']
 * @param {boolean} [options.disabled]
 * @param {string|Array|object} [options.class]
 * @param {object} [options.attrs]
 * @returns {HTMLSpanElement}
 */
export function durationInput({
  minutes,
  onchange,
  placeholder = 'ex.: 1h30',
  parse = parseDurationText,
  format = formatDurationText,
  size = 'md',
  ariaLabel = 'Duração',
  disabled = false,
  class: className,
  attrs,
} = {}) {
  const shown = minutes == null || minutes === '' || !Number.isFinite(Number(minutes)) ? '' : format(Number(minutes));
  const setInvalid = (input, invalid) => {
    const root = input.closest('.input');
    if (root) root.classList.toggle('is-invalid', invalid);
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };
  return h(
    'span',
    { class: cx('input', 'input-duration', size === 'sm' && 'input-sm', disabled && 'is-disabled', className) },
    makeIcon('clock', { size: 14, class: 'input-icon' }),
    h('input', {
      class: 'input-el tabular',
      type: 'text',
      inputmode: 'text',
      placeholder,
      'aria-label': ariaLabel,
      title: 'Exemplos: 45min, 1h30, 1,5h, 1:30',
      disabled: !!disabled,
      autocomplete: 'off',
      spellcheck: false,
      oninput: (ev) => setInvalid(ev.currentTarget, false),
      onkeydown: (ev) => {
        if (ev.key === 'Enter' && !ev.isComposing) {
          ev.preventDefault();
          ev.currentTarget.blur(); // sair do campo dispara o "change" quando houve alteração
        }
      },
      onchange: (ev) => {
        const input = ev.currentTarget;
        const text = input.value.trim();
        if (text === '') {
          setInvalid(input, false);
          call(onchange, null, ev);
          return;
        }
        const parsed = parse(text);
        if (parsed == null || !Number.isFinite(parsed)) {
          setInvalid(input, true);
          return;
        }
        setInvalid(input, false);
        input.value = format(parsed);
        call(onchange, parsed, ev);
      },
      value: shown,
      ...attrs,
    }),
  );
}

// ---------------------------------------------------------------------------
// Escolha entre opções: segmentado e abas
// ---------------------------------------------------------------------------

/** Navegação por setas entre os itens habilitados de um grupo (segmentado/abas). */
function rovingKeydown(ev, selector) {
  const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  const isEdge = ev.key === 'Home' || ev.key === 'End';
  if (!(ev.key in keys) && !isEdge) return;
  const items = [...ev.currentTarget.querySelectorAll(selector)].filter((item) => !item.disabled);
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement);
  let next;
  if (ev.key === 'Home') next = 0;
  else if (ev.key === 'End') next = items.length - 1;
  else next = current < 0 ? 0 : (current + keys[ev.key] + items.length) % items.length;
  ev.preventDefault();
  items[next].focus();
  items[next].click();
}

/**
 * Controle segmentado (escolha única entre poucas opções).
 *
 *   segmented({ value: modo, onchange: (v) => setState({ modo: v }),
 *               options: [{ value: 'lista', label: 'Lista', icon: 'list' }, { value: 'quadro', label: 'Quadro', icon: 'kanban' }] })
 *
 * Opção sem `label` (só ícone) precisa de `title` (vira o nome acessível).
 *
 * @param {object} options
 * @param {Array<{ value: any, label?: string, icon?: string|Node, title?: string, disabled?: boolean }>} options.options
 * @param {any} [options.value] valor selecionado
 * @param {(value: any, ev: Event) => void} [options.onchange]
 * @param {'md'|'sm'} [options.size='md']
 * @param {string} [options.ariaLabel]
 * @param {string|Array|object} [options.class]
 * @returns {HTMLDivElement}
 */
export function segmented({ options = [], value, onchange, size = 'md', ariaLabel, class: className } = {}) {
  const list = (Array.isArray(options) ? options : []).filter(Boolean);
  const hasSelection = list.some((option) => option.value === value);
  return h(
    'div',
    {
      class: cx('segmented', size === 'sm' && 'segmented-sm', className),
      role: 'radiogroup',
      'aria-label': ariaLabel || null,
      onkeydown: (ev) => rovingKeydown(ev, '.segmented-item'),
    },
    list.map((option, index) => {
      const selected = option.value === value;
      return h(
        'button',
        {
          type: 'button',
          class: cx('segmented-item', selected && 'is-active'),
          role: 'radio',
          'aria-checked': selected,
          'aria-label': option.label ? null : option.title || null,
          title: option.title || null,
          disabled: !!option.disabled,
          tabindex: selected || (!hasSelection && index === 0) ? 0 : -1,
          onclick: (ev) => {
            if (!selected) call(onchange, option.value, ev);
          },
        },
        toIcon(option.icon, 14),
        option.label ? h('span', { class: 'segmented-label' }, option.label) : null,
      );
    }),
  );
}

/**
 * Abas.
 *
 *   tabs({ active: aba, onchange: (id) => setState({ aba: id }),
 *          tabs: [{ id: 'tarefas', label: 'Tarefas', count: 12 }, { id: 'historico', label: 'Histórico', icon: 'clock' }] })
 *
 * @param {object} options
 * @param {Array<{ id: string, label: string, count?: number, icon?: string|Node, disabled?: boolean }>} options.tabs
 * @param {string} [options.active] id da aba ativa
 * @param {(id: string, ev: Event) => void} [options.onchange]
 * @param {string} [options.ariaLabel]
 * @param {string|Array|object} [options.class]
 * @returns {HTMLDivElement}
 */
export function tabs({ tabs: items = [], active, onchange, ariaLabel, class: className } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  const hasActive = list.some((tab) => tab.id === active);
  return h(
    'div',
    {
      class: cx('tabs', className),
      role: 'tablist',
      'aria-label': ariaLabel || null,
      onkeydown: (ev) => rovingKeydown(ev, '.tabs-tab'),
    },
    list.map((tab, index) => {
      const selected = tab.id === active;
      return h(
        'button',
        {
          type: 'button',
          class: cx('tabs-tab', selected && 'is-active'),
          role: 'tab',
          'aria-selected': selected,
          'data-tab': tab.id,
          disabled: !!tab.disabled,
          tabindex: selected || (!hasActive && index === 0) ? 0 : -1,
          onclick: (ev) => {
            if (!selected) call(onchange, tab.id, ev);
          },
        },
        toIcon(tab.icon, 14),
        h('span', { class: 'tabs-label' }, tab.label),
        tab.count == null ? null : h('span', { class: 'tabs-count tabular' }, String(tab.count)),
      );
    }),
  );
}

// ---------------------------------------------------------------------------
// Campo com rótulo
// ---------------------------------------------------------------------------

const LABELABLE = 'input:not([type="checkbox"]):not([type="radio"]), select, textarea';

/**
 * Envolve um controle com rótulo, dica e mensagem de erro.
 *
 *   field({ label: 'Prazo', hint: 'Opcional' }, dateInput({ value, onchange }))
 *   field({ label: 'Nome', error: 'Informe um nome' }, textInput({ value, oninput }))
 *   field({ label: 'Estimativa', inline: true }, durationInput({ minutes, onchange }))   // rótulo ao lado
 *
 * Com um único campo nativo dentro (input/select/textarea), o conjunto é um `<label>` (clicar no rótulo foca
 * o campo). Com controles compostos (segmentado, vários botões), vira um grupo com aria-label.
 *
 * @param {object} options
 * @param {string} [options.label]
 * @param {string|Node} [options.hint] texto de apoio
 * @param {string} [options.error] mensagem de erro (substitui a dica e marca o campo como inválido)
 * @param {boolean} [options.inline] rótulo à esquerda do controle
 * @param {boolean} [options.required] marca visual de obrigatório
 * @param {string|Array|object} [options.class]
 * @param {Node} control
 * @returns {HTMLElement}
 */
export function field({ label, hint, error, inline = false, required = false, class: className } = {}, control) {
  const isElement = control != null && typeof control === 'object' && control.nodeType === 1;
  let native = null;
  if (isElement) {
    const found = control.matches(LABELABLE) ? [control] : [...control.querySelectorAll(LABELABLE)];
    const hasOtherControls = control.querySelector('[role="radio"], [role="tab"], input[type="checkbox"], input[type="radio"]') !== null;
    if (found.length === 1 && !hasOtherControls && !control.classList.contains('inline-edit')) native = found[0];
  }
  if (native !== null && error) {
    native.setAttribute('aria-invalid', 'true');
    const wrapper = native.closest('.input, .select');
    if (wrapper) wrapper.classList.add('is-invalid');
    else native.classList.add('is-invalid');
  }
  const message = error
    ? h('span', { class: 'field-error', role: 'alert' }, makeIcon('alert-circle', { size: 12 }), h('span', null, error))
    : hint
      ? h('span', { class: 'field-hint' }, hint)
      : null;
  return h(
    native !== null ? 'label' : 'div',
    {
      class: cx('field', inline && 'field-inline', error && 'has-error', className),
      role: native !== null ? null : 'group',
      'aria-label': native !== null ? null : label || null,
    },
    label ? h('span', { class: 'field-label' }, label, required ? h('span', { class: 'field-required', 'aria-hidden': 'true' }, ' *') : null) : null,
    h('span', { class: 'field-control' }, control, message),
  );
}

// ---------------------------------------------------------------------------
// Edição no lugar
// ---------------------------------------------------------------------------

function inlineEditText(state) {
  const value = state.opts.value;
  return value == null ? '' : String(value);
}

/** Mostra o texto (modo leitura). `text` permite mostrar na hora o que acabou de ser salvo. */
function showInlineEditView(el, state, text) {
  const opts = state.opts;
  let view = el.firstElementChild;
  if (view === null || !view.classList.contains('inline-edit-view') || el.childElementCount !== 1) {
    view = document.createElement('div');
    view.className = 'inline-edit-view';
    el.replaceChildren(view);
  }
  const shown = text === '' ? opts.placeholder : text;
  if (view.textContent !== shown) view.textContent = shown;
  view.classList.toggle('is-placeholder', text === '');
  // Dica com o texto inteiro: em colunas estreitas o valor aparece cortado com reticências.
  if (text !== '') {
    if (view.title !== text) view.title = text;
  } else if (view.hasAttribute('title')) {
    view.removeAttribute('title');
  }
  if (opts.disabled) {
    view.removeAttribute('role');
    view.removeAttribute('tabindex');
  } else {
    view.setAttribute('role', 'button');
    view.setAttribute('tabindex', '0');
  }
  const name = opts.ariaLabel ? `${opts.ariaLabel}: ${text || 'vazio'}` : null;
  if (name) view.setAttribute('aria-label', name);
  else view.removeAttribute('aria-label');
  el.classList.remove('is-editing');
}

function finishInlineEdit(el, save, refocus) {
  const state = el.__inlineEdit;
  if (!state || !state.editing) return;
  const opts = state.opts;
  const input = state.input;
  state.editing = false; // antes de mexer no DOM: tirar o campo dispara "blur" de novo
  state.input = null;
  let text = input.value;
  if (!opts.multiline) text = text.replace(/\s*\n\s*/g, ' ');
  text = text.trim();
  const original = state.original;
  const changed = save && text !== original.trim() && (text !== '' || opts.allowEmpty);
  // Mostra já o texto novo; o próximo render confirma (ou corrige) com o valor que estiver no banco.
  showInlineEditView(el, state, changed ? text : inlineEditText(state));
  if (refocus && el.isConnected) {
    const view = el.firstElementChild;
    if (view && view.hasAttribute('tabindex')) view.focus({ preventScroll: true });
  }
  if (changed) call(opts.onsave, text);
  else if (!save) call(opts.oncancel);
}

function startInlineEdit(el, selectAll) {
  const state = el.__inlineEdit;
  if (!state || state.editing || state.opts.disabled) return;
  const opts = state.opts;
  const text = inlineEditText(state);
  const view = el.firstElementChild;
  const height = view ? view.getBoundingClientRect().height : 0;
  const input = document.createElement(opts.multiline ? 'textarea' : 'input');
  input.className = 'inline-edit-input';
  if (opts.multiline) {
    input.rows = 1;
    if (height > 0 && !SUPPORTS_FIELD_SIZING) input.style.height = `${Math.ceil(height)}px`;
  } else {
    input.type = 'text';
  }
  input.value = text;
  input.placeholder = opts.placeholder;
  input.autocomplete = 'off';
  if (opts.maxlength) input.maxLength = opts.maxlength;
  input.setAttribute('aria-label', opts.ariaLabel || opts.placeholder);
  input.addEventListener('keydown', (ev) => {
    if (ev.isComposing) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation(); // o Esc cancela a edição, não fecha o painel/diálogo em volta
      finishInlineEdit(el, false, true);
    } else if (ev.key === 'Enter' && (!state.opts.multiline || ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      ev.stopPropagation();
      finishInlineEdit(el, true, true);
    }
  });
  input.addEventListener('blur', () => finishInlineEdit(el, true, false));
  if (opts.multiline) {
    input.addEventListener('input', () => {
      if (SUPPORTS_FIELD_SIZING) return;
      input.style.height = 'auto';
      input.style.height = `${input.scrollHeight}px`;
    });
  }
  state.editing = true;
  state.original = text;
  state.input = input;
  el.classList.add('is-editing');
  el.replaceChildren(input);
  input.focus({ preventScroll: true });
  if (selectAll) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
}

/** Chamado na criação e depois de cada morph, com o elemento vivo. */
function syncInlineEdit(el, opts) {
  let state = el.__inlineEdit;
  if (state === undefined) {
    state = el.__inlineEdit = { opts, editing: false, input: null, original: '' };
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.inline-edit-view')) startInlineEdit(el, false);
    });
    el.addEventListener('keydown', (ev) => {
      if (!ev.target.classList || !ev.target.classList.contains('inline-edit-view')) return;
      if (ev.key === 'Enter' || ev.key === 'F2' || ev.key === ' ') {
        ev.preventDefault();
        ev.stopPropagation();
        startInlineEdit(el, true);
      }
    });
  }
  state.opts = opts;
  if (state.editing) {
    // O morph acabou de sincronizar os atributos (e tirou a classe): quem está digitando continua digitando.
    el.classList.add('is-editing');
    return;
  }
  showInlineEditView(el, state, inlineEditText(state));
}

/**
 * Texto editável no lugar (título de tarefa, nome de projeto, descrição curta).
 *
 *   inlineEdit({ value: tarefa.name, ariaLabel: 'Nome da tarefa', onsave: (nome) => app.cmd.updateTask(id, { name: nome }) })
 *   inlineEdit({ value: demanda.description, multiline: true, placeholder: 'Adicionar descrição…', allowEmpty: true, onsave })
 *
 * Comportamento:
 *   • clicar (ou Enter / F2 com o foco no texto) entra em edição;
 *   • Enter salva, Esc cancela, sair do campo salva. Com `multiline`, Enter quebra a linha e Ctrl+Enter salva;
 *   • `onsave(texto)` só é chamado se o texto mudou (já sem espaços nas pontas). Texto vazio só é salvo com
 *     `allowEmpty: true` — senão a edição é desfeita;
 *   • a edição em curso SOBREVIVE a novos renders: o elemento é marcado com data-morph="skip" e gerencia os
 *     próprios filhos; enquanto o usuário digita, nada é sobrescrito.
 *
 * @param {object} options
 * @param {string|null} [options.value]
 * @param {string} [options.placeholder='Clique para editar']
 * @param {(text: string) => void} [options.onsave]
 * @param {() => void} [options.oncancel] chamado quando a edição é cancelada com Esc
 * @param {boolean} [options.multiline]
 * @param {boolean} [options.allowEmpty=false]
 * @param {boolean} [options.disabled] só leitura
 * @param {number} [options.maxlength]
 * @param {string|Array|object} [options.class] ex.: 'text-xl strong' para um título
 * @param {string} [options.ariaLabel] o que está sendo editado (ex.: 'Nome da tarefa')
 * @returns {HTMLDivElement}
 */
export function inlineEdit({
  value,
  placeholder = 'Clique para editar',
  onsave,
  oncancel,
  multiline = false,
  allowEmpty = false,
  disabled = false,
  maxlength,
  class: className,
  ariaLabel,
} = {}) {
  const opts = { value, placeholder, onsave, oncancel, multiline: !!multiline, allowEmpty: !!allowEmpty, disabled: !!disabled, maxlength, ariaLabel };
  return h('div', {
    class: cx('inline-edit', multiline && 'inline-edit-multiline', disabled && 'is-disabled', className),
    'data-morph': 'skip',
    ref: (el) => syncInlineEdit(el, opts),
  });
}

