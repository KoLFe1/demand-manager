// Seletores do kit: pequenas perguntas ao usuário, ancoradas num elemento, que devolvem uma PROMESSA.
// Todos resolvem `null` quando o usuário desiste (Esc, clique fora).
//
//   const id = await pickStatus(botao, { statuses, current: tarefa.status });
//   if (id !== null) app.cmd.setStatus('task', tarefa.id, id);
//
// Construídos sobre overlays.js (menu e popover): no celular viram folhas inferiores.
// Exemplos vivos: dev/kit.html.

import { cx, h } from '../../core/dom.js';
import {
  MONTHS,
  WEEKDAYS_LONG,
  WEEKDAYS_MIN,
  addDays,
  addMonths,
  endOfWeek,
  formatDate,
  isValidDateStr,
  monthMatrix,
  parseDate,
  startOfMonth,
  startOfWeek,
  todayStr,
  weekdayIndex,
} from '../../core/dates.js';
import { normalizeText } from '../../core/format.js';
import { PRIORITIES, priorityById } from '../../domain/priorities.js';
import { button, textInput } from './controls.js';
import { priorityBadge, statusBadge } from './display.js';
import { icon as makeIcon } from './icons.js';
import { openMenu, openPopover } from './overlays.js';

/** Valor devolvido por pickFromList quando o usuário escolhe a opção vazia ("Nenhum"). */
export const EMPTY_CHOICE = '';

/** Quantos itens pickFromList desenha de uma vez (o resto aparece ao refinar a busca). */
export const PICK_LIST_LIMIT = 80;

/** Abre um menu e resolve com o valor do item escolhido (null se fechou sem escolher). */
function pickFromMenu(anchor, buildItems, options) {
  return new Promise((resolve) => {
    let chosen = null;
    const choose = (value) => () => {
      chosen = value;
    };
    openMenu(anchor, buildItems(choose), {
      ...options,
      // O menu fecha antes de chamar o onclick do item: resolve só depois que os dois aconteceram.
      onclose: () => queueMicrotask(() => resolve(chosen)),
    });
  });
}

// ---------------------------------------------------------------------------
// Status e prioridade
// ---------------------------------------------------------------------------

/**
 * Escolha de status.
 *
 *   const id = await pickStatus(ev.currentTarget, { statuses: app.sel.statuses(), current: tarefa.status });
 *
 * Status marcados com `hidden: true` não são oferecidos (a não ser que seja o atual).
 *
 * @param {Element|{ x: number, y: number }} anchor
 * @param {object} options
 * @param {Array<{ id: string, label: string, category: string, color: string, hidden?: boolean }>} options.statuses
 * @param {string} [options.current] id do status atual (aparece marcado)
 * @param {string} [options.title='Status']
 * @returns {Promise<string|null>} id do status escolhido, ou null
 */
export function pickStatus(anchor, { statuses, current, title = 'Status' } = {}) {
  const list = (Array.isArray(statuses) ? statuses : []).filter((status) => status && status.id && (status.hidden !== true || status.id === current));
  return pickFromMenu(
    anchor,
    (choose) =>
      list.map((status) => ({
        label: status.label || status.id,
        icon: statusBadge(status, { compact: true }),
        checked: status.id === current,
        onclick: choose(status.id),
      })),
    { title, minWidth: 200, class: 'menu-status' },
  );
}

/**
 * Escolha de prioridade (P1–P4), com uma sugestão opcional em destaque.
 *
 *   const p = await pickPriority(botao, { current: 'P3', suggestion: { priority: 'P2', text: 'Vence em 2 dias e destrava 3 tarefas' } });
 *
 * @param {Element|{ x: number, y: number }} anchor
 * @param {object} [options]
 * @param {string} [options.current] prioridade atual
 * @param {{ priority: string, text?: string }|null} [options.suggestion] recomendação do sistema (o usuário decide)
 * @param {string} [options.title='Prioridade']
 * @returns {Promise<string|null>} 'P1'…'P4', ou null
 */
export function pickPriority(anchor, { current, suggestion, title = 'Prioridade' } = {}) {
  const suggested = suggestion && PRIORITIES.some((p) => p.id === suggestion.priority) ? priorityById(suggestion.priority) : null;
  return pickFromMenu(
    anchor,
    (choose) => {
      const items = [];
      if (suggested !== null && suggested.id !== current) {
        items.push({
          label: `Sugestão: ${suggested.id} · ${suggested.label}`,
          description: suggestion.text || null,
          icon: 'sparkles',
          class: 'menu-item-suggestion',
          onclick: choose(suggested.id),
        });
        items.push({ separator: true });
      }
      for (const priority of PRIORITIES) {
        items.push({
          label: `${priority.id} · ${priority.label}`,
          icon: priorityBadge(priority.id, { compact: true }),
          checked: priority.id === current,
          onclick: choose(priority.id),
        });
      }
      return items;
    },
    { title, minWidth: 200, class: 'menu-priority' },
  );
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/**
 * Escolha de data com mini calendário (semana começa na segunda) e atalhos.
 *
 *   const r = await pickDate(botao, { value: tarefa.due_date });
 *   if (r !== null) app.cmd.setDueDate('task', id, r.value);            // r.value = 'YYYY-MM-DD' ou null ("Sem prazo")
 *
 *   const r = await pickDate(botao, { value, withReason: true });        // pede também o "Motivo da alteração"
 *   if (r !== null) app.cmd.setDueDate('task', id, r.value, { reason: r.reason });
 *
 * Atalhos: Hoje, Amanhã, Próxima segunda, Em 1 semana e (com `allowClear`) Sem prazo.
 * Teclado no calendário: setas (dia/semana), Home/End (início/fim da semana), PageUp/PageDown (mês; com
 * Shift, ano), Enter/Espaço escolhe. Sem `withReason`, escolher uma data já confirma; com `withReason`, a
 * data fica marcada e o botão "Aplicar" (ou Enter no campo do motivo) confirma.
 *
 * @param {Element|{ x: number, y: number }} anchor
 * @param {object} [options]
 * @param {string|null} [options.value] data atual 'YYYY-MM-DD'
 * @param {boolean} [options.allowClear=true] oferece "Sem prazo"
 * @param {string} [options.title]
 * @param {boolean} [options.withReason] acrescenta o campo opcional "Motivo da alteração"
 * @param {string} [options.min] primeira data permitida 'YYYY-MM-DD'
 * @param {string} [options.today] data de hoje (padrão: relógio do sistema) — passe app.clock.today()
 * @param {string} [options.clearLabel='Sem prazo']
 * @returns {Promise<{ value: string|null, reason: string|null }|null>} null se o usuário desistiu
 */
export function pickDate(anchor, { value, allowClear = true, title, withReason = false, min, today, clearLabel = 'Sem prazo' } = {}) {
  const now = isValidDateStr(today) ? today : todayStr();
  const minDate = isValidDateStr(min) ? min : null;
  const initial = isValidDateStr(value) ? value : null;
  const allowed = (date) => minDate === null || date >= minDate;
  const firstAllowed = (date) => (allowed(date) ? date : minDate);

  return new Promise((resolve) => {
    let result = null;
    let selected = initial;
    let cleared = false;
    let focusDay = firstAllowed(initial || now);
    let view = startOfMonth(focusDay);
    let reason = '';
    let pop = null;
    let grabFocus = true; // o dia em foco recebe o foco do teclado no próximo render

    const finish = (date) => {
      result = { value: date, reason: withReason && reason.trim() ? reason.trim() : null };
      pop.close('select');
    };

    const pick = (date) => {
      if (date !== null && !allowed(date)) return;
      if (!withReason) {
        finish(date);
        return;
      }
      selected = date;
      cleared = date === null;
      if (date !== null) {
        focusDay = date;
        view = startOfMonth(date);
      }
      pop.update();
    };

    const refocus = () => {
      pop.update();
      const cell = pop.el.querySelector(`.datepicker-day[data-date="${focusDay}"]`);
      if (cell) cell.focus({ preventScroll: true });
    };

    const moveFocus = (date) => {
      if (!date) return;
      focusDay = firstAllowed(date);
      view = startOfMonth(focusDay);
      refocus();
    };

    const shiftMonth = (delta) => {
      view = addMonths(view, delta);
      const moved = addMonths(focusDay, delta);
      focusDay = firstAllowed(moved);
      if (startOfMonth(focusDay) !== view) view = startOfMonth(focusDay);
      pop.update();
    };

    const onGridKeydown = (ev) => {
      const cell = ev.target instanceof Element ? ev.target.closest('.datepicker-day') : null;
      if (cell === null) return;
      const date = cell.dataset.date;
      let next = null;
      switch (ev.key) {
        case 'ArrowLeft':
          next = addDays(date, -1);
          break;
        case 'ArrowRight':
          next = addDays(date, 1);
          break;
        case 'ArrowUp':
          next = addDays(date, -7);
          break;
        case 'ArrowDown':
          next = addDays(date, 7);
          break;
        case 'Home':
          next = startOfWeek(date);
          break;
        case 'End':
          next = endOfWeek(date);
          break;
        case 'PageUp':
          next = addMonths(date, ev.shiftKey ? -12 : -1);
          break;
        case 'PageDown':
          next = addMonths(date, ev.shiftKey ? 12 : 1);
          break;
        default:
          return;
      }
      ev.preventDefault();
      moveFocus(next);
    };

    const quick = [
      { label: 'Hoje', date: now },
      { label: 'Amanhã', date: addDays(now, 1) },
      { label: 'Próxima segunda', date: addDays(startOfWeek(now), 7) },
      { label: 'Em 1 semana', date: addDays(now, 7) },
    ];

    const render = () => {
      const base = parseDate(view);
      const weeks = monthMatrix(base.getFullYear(), base.getMonth());
      const monthLabel = `${MONTHS[base.getMonth()]} de ${base.getFullYear()}`;
      const month = view.slice(0, 7);
      const autofocusDay = grabFocus;
      grabFocus = false;
      return h(
        'div',
        { class: cx('datepicker', withReason && 'datepicker-with-reason') },
        title ? h('div', { class: 'datepicker-title' }, title) : null,
        h(
          'div',
          { class: 'datepicker-quick' },
          quick.map((choice) =>
            h(
              'button',
              {
                type: 'button',
                class: cx('datepicker-quick-item', withReason && selected === choice.date && !cleared && 'is-selected'),
                disabled: !allowed(choice.date),
                'data-date': choice.date,
                onclick: () => pick(choice.date),
              },
              h('span', null, choice.label),
              h('span', { class: 'datepicker-quick-date tabular' }, formatDate(choice.date, 'weekday', now)),
            ),
          ),
          allowClear
            ? h(
                'button',
                { type: 'button', class: cx('datepicker-quick-item', 'datepicker-clear', withReason && cleared && 'is-selected'), 'data-clear': 'true', onclick: () => pick(null) },
                h('span', null, clearLabel),
              )
            : null,
        ),
        h(
          'div',
          { class: 'datepicker-calendar' },
          h(
            'div',
            { class: 'datepicker-head' },
            h('span', { class: 'datepicker-month', 'aria-live': 'polite' }, monthLabel),
            h('button', { type: 'button', class: 'btn btn-icon btn-ghost btn-sm', title: 'Mês anterior', 'aria-label': 'Mês anterior', 'data-nav': 'prev', onclick: () => shiftMonth(-1) }, makeIcon('chevron-left', { size: 14 })),
            h('button', { type: 'button', class: 'btn btn-icon btn-ghost btn-sm', title: 'Próximo mês', 'aria-label': 'Próximo mês', 'data-nav': 'next', onclick: () => shiftMonth(1) }, makeIcon('chevron-right', { size: 14 })),
          ),
          h(
            'div',
            { class: 'datepicker-grid', role: 'grid', 'aria-label': monthLabel, onkeydown: onGridKeydown },
            h(
              'div',
              { class: 'datepicker-week datepicker-weekdays', role: 'row' },
              WEEKDAYS_MIN.map((letter, index) => h('span', { class: 'datepicker-weekday', role: 'columnheader', title: WEEKDAYS_LONG[index], 'aria-label': WEEKDAYS_LONG[index] }, letter)),
            ),
            weeks.map((week) =>
              h(
                'div',
                { class: 'datepicker-week', role: 'row', key: week[0] },
                week.map((date) => {
                  const isSelected = !cleared && date === selected;
                  const isFocus = date === focusDay;
                  return h(
                    'button',
                    {
                      type: 'button',
                      key: date,
                      class: cx('datepicker-day', 'tabular', {
                        'is-outside': date.slice(0, 7) !== month,
                        'is-today': date === now,
                        'is-selected': isSelected,
                        'is-weekend': weekdayIndex(date) >= 5,
                      }),
                      role: 'gridcell',
                      'data-date': date,
                      'aria-selected': isSelected,
                      'aria-current': date === now ? 'date' : null,
                      'aria-label': `${WEEKDAYS_LONG[weekdayIndex(date)]}, ${formatDate(date, 'long')}${date === now ? ' (hoje)' : ''}`,
                      tabindex: isFocus ? 0 : -1,
                      'data-autofocus': isFocus && autofocusDay ? true : null,
                      disabled: !allowed(date),
                      onclick: () => pick(date),
                    },
                    String(Number(date.slice(8))),
                  );
                }),
              ),
            ),
          ),
        ),
        withReason
          ? h(
              'div',
              { class: 'datepicker-footer' },
              textInput({
                value: reason,
                placeholder: 'Motivo da alteração (opcional)',
                ariaLabel: 'Motivo da alteração',
                oninput: (text) => {
                  reason = text;
                },
                onenter: () => finish(cleared ? null : selected),
                class: 'datepicker-reason',
              }),
              h(
                'div',
                { class: 'datepicker-actions' },
                h('span', { class: 'datepicker-summary tabular' }, cleared ? clearLabel : selected ? formatDate(selected, 'weekday', now) : 'Escolha uma data'),
                button({ label: 'Aplicar', variant: 'primary', size: 'sm', disabled: !cleared && !selected, onclick: () => finish(cleared ? null : selected) }),
              ),
            )
          : null,
      );
    };

    pop = openPopover(anchor, render, {
      class: 'popover-datepicker',
      ariaLabel: title || 'Escolher data',
      onclose: () => resolve(result),
    });
  });
}

// ---------------------------------------------------------------------------
// Lista pesquisável
// ---------------------------------------------------------------------------

/**
 * Escolha em lista pesquisável (projeto, demanda, responsável, tarefa pré-requisito…).
 *
 *   const projectId = await pickFromList(botao, {
 *     items: projetos.map((p) => ({ id: p.id, label: p.name, icon: 'folder' })),
 *     current: demanda.project_id, allowEmpty: true, emptyLabel: 'Sem projeto', placeholder: 'Buscar projeto…',
 *   });
 *   if (projectId !== null) app.cmd.updateDemand(id, { project_id: projectId === EMPTY_CHOICE ? null : projectId });
 *
 *   const ids = await pickFromList(botao, { items, current: selecionados, multiple: true });   // array ou null
 *
 * • A busca ignora acentos e maiúsculas e procura no rótulo e na dica; todas as palavras digitadas precisam aparecer.
 * • Teclado: ↑ ↓ para andar, Enter para escolher (em `multiple`, Enter marca/desmarca e Ctrl+Enter aplica), Esc desiste.
 * • `allowEmpty` acrescenta a opção vazia (`emptyLabel`): na escolha única resolve com EMPTY_CHOICE (''); em
 *   `multiple` ela limpa a seleção.
 * • `create` oferece "criar" quando o texto digitado não bate exatamente com nenhum item: `oncreate(texto)` pode
 *   devolver o id do item criado (ou uma promessa dele); sem retorno, o próprio texto é usado como id.
 * • Listas longas: são desenhados no máximo PICK_LIST_LIMIT itens; o restante aparece ao refinar a busca.
 *
 * @param {Element|{ x: number, y: number }} anchor
 * @param {object} options
 * @param {Array<{ id: string, label: string, hint?: string, icon?: string|Node, group?: string, disabled?: boolean }>} options.items
 * @param {string|string[]|null} [options.current] id selecionado (ou lista de ids, em `multiple`)
 * @param {string} [options.placeholder='Buscar…']
 * @param {boolean} [options.multiple]
 * @param {boolean} [options.allowEmpty]
 * @param {string} [options.emptyLabel='Nenhum']
 * @param {{ label: (text: string) => string, oncreate: (text: string) => (string|void|Promise<string|void>) }} [options.create]
 * @param {string} [options.title]
 * @param {number} [options.width=280] largura do popover em px
 * @returns {Promise<string|string[]|null>} id escolhido; lista de ids em `multiple`; null se o usuário desistiu
 */
export function pickFromList(anchor, { items, current, placeholder = 'Buscar…', multiple = false, allowEmpty = false, emptyLabel = 'Nenhum', create, title, width = 280 } = {}) {
  const source = (Array.isArray(items) ? items : [])
    .filter((item) => item && item.id != null)
    .map((item) => ({ ...item, id: String(item.id), label: item.label == null ? String(item.id) : String(item.label) }));
  const searchText = new Map(source.map((item) => [item.id, normalizeText(`${item.label} ${item.hint ?? ''}`)]));
  const canCreate = create && typeof create.oncreate === 'function';
  const listId = `picklist-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise((resolve) => {
    let result = null;
    let pop = null;
    let rows = []; // linhas acionáveis: { kind: 'item' | 'empty' | 'create', item?, el }
    let active = -1;
    let busy = false;
    const selected = new Set(multiple ? (Array.isArray(current) ? current : current == null ? [] : [current]).map(String) : []);
    const currentId = !multiple && current != null ? String(current) : null;

    const input = h('input', {
      class: 'picklist-input',
      type: 'text',
      placeholder,
      'aria-label': placeholder,
      role: 'combobox',
      'aria-expanded': true,
      'aria-controls': listId,
      'aria-autocomplete': 'list',
      autocomplete: 'off',
      spellcheck: false,
      'data-autofocus': true,
      oninput: () => renderList(true),
    });
    const list = h('div', { class: 'picklist-list', id: listId, role: 'listbox', 'aria-multiselectable': multiple ? true : null });
    const count = h('span', { class: 'picklist-count tabular' });
    const shell = h(
      'div',
      { class: cx('picklist', multiple && 'picklist-multiple'), onkeydown: onKeydown },
      title ? h('div', { class: 'picklist-title' }, title) : null,
      h('div', { class: 'picklist-search' }, makeIcon('search', { size: 14 }), input),
      list,
      multiple
        ? h(
            'div',
            { class: 'picklist-footer' },
            count,
            button({ label: 'Aplicar', variant: 'primary', size: 'sm', attrs: { 'data-action': 'apply' }, onclick: () => apply() }),
          )
        : null,
    );

    function apply() {
      result = source.filter((item) => selected.has(item.id)).map((item) => item.id);
      // ids selecionados que não estão mais na lista (ex.: etiqueta antiga) são preservados
      for (const id of selected) if (!result.includes(id)) result.push(id);
      pop.close('select');
    }

    function setActive(index, scroll) {
      if (active >= 0 && rows[active]) rows[active].el.classList.remove('is-active');
      active = index >= 0 && index < rows.length ? index : -1;
      if (active < 0) {
        input.removeAttribute('aria-activedescendant');
        return;
      }
      const el = rows[active].el;
      el.classList.add('is-active');
      input.setAttribute('aria-activedescendant', el.id);
      if (scroll && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    }

    async function choose(index) {
      const row = rows[index];
      if (!row || busy) return;
      if (row.kind === 'item' && row.item.disabled) return;
      if (row.kind === 'create') {
        const text = input.value.trim();
        if (!text) return;
        busy = true;
        let created;
        try {
          created = await create.oncreate(text);
        } catch (err) {
          console.error('[kit] pickFromList: oncreate falhou', err);
          busy = false;
          return;
        }
        busy = false;
        const id = created == null || created === '' ? text : String(created);
        if (!multiple) {
          result = id;
          pop.close('select');
          return;
        }
        if (!searchText.has(id)) {
          source.push({ id, label: text });
          searchText.set(id, normalizeText(text));
        }
        selected.add(id);
        input.value = '';
        renderList(true);
        input.focus();
        return;
      }
      if (row.kind === 'empty') {
        if (!multiple) {
          result = EMPTY_CHOICE;
          pop.close('select');
          return;
        }
        selected.clear();
        renderList(false);
        return;
      }
      if (!multiple) {
        result = row.item.id;
        pop.close('select');
        return;
      }
      if (selected.has(row.item.id)) selected.delete(row.item.id);
      else selected.add(row.item.id);
      renderList(false);
    }

    function rowEl(index, kind, { label, hint, icon, isSelected, disabled, extraClass }) {
      return h(
        'div',
        {
          class: cx('picklist-item', isSelected && 'is-selected', disabled && 'is-disabled', extraClass),
          id: `${listId}-row-${index}`,
          role: 'option',
          'aria-selected': !!isSelected,
          'aria-disabled': disabled ? true : null,
          'data-kind': kind,
          onclick: () => choose(index),
          onpointermove: () => {
            if (active !== index) setActive(index, false);
          },
        },
        multiple && kind === 'item' ? h('span', { class: 'picklist-box', 'aria-hidden': 'true' }, isSelected ? makeIcon('check', { size: 12 }) : null) : null,
        icon ? h('span', { class: 'picklist-icon', 'aria-hidden': 'true' }, typeof icon === 'string' ? makeIcon(icon, { size: 14 }) : icon) : null,
        h('span', { class: 'picklist-label' }, label),
        hint ? h('span', { class: 'picklist-hint' }, hint) : null,
        !multiple && isSelected ? makeIcon('check', { size: 14, class: 'picklist-check' }) : null,
      );
    }

    function renderList(resetActive) {
      const previous = active >= 0 && rows[active] ? rows[active] : null;
      const query = normalizeText(input.value);
      const words = query ? query.split(/\s+/) : [];
      const matches = words.length === 0 ? source : source.filter((item) => words.every((word) => searchText.get(item.id).includes(word)));
      const nodes = [];
      rows = [];

      if (allowEmpty && words.length === 0) {
        const index = rows.length;
        const el = rowEl(index, 'empty', { label: emptyLabel, isSelected: multiple ? false : currentId === null || currentId === '', extraClass: 'picklist-empty-choice' });
        rows.push({ kind: 'empty', el });
        nodes.push(el);
      }

      // Agrupa preservando a ordem em que cada grupo apareceu.
      const groups = new Map();
      for (const item of matches) {
        const key = item.group == null ? '' : String(item.group);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      let drawn = 0;
      for (const [group, members] of groups) {
        if (drawn >= PICK_LIST_LIMIT) break;
        if (group !== '') nodes.push(h('div', { class: 'picklist-group', role: 'presentation' }, group));
        for (const item of members) {
          if (drawn >= PICK_LIST_LIMIT) break;
          const index = rows.length;
          const el = rowEl(index, 'item', {
            label: item.label,
            hint: item.hint,
            icon: item.icon,
            isSelected: multiple ? selected.has(item.id) : item.id === currentId,
            disabled: item.disabled,
          });
          el.dataset.id = item.id;
          rows.push({ kind: 'item', item, el });
          nodes.push(el);
          drawn++;
        }
      }
      const hidden = matches.length - drawn;
      if (hidden > 0) nodes.push(h('div', { class: 'picklist-more' }, `Mais ${hidden} ${hidden === 1 ? 'item' : 'itens'} — refine a busca`));

      const typedText = input.value.trim();
      if (canCreate && typedText !== '' && !source.some((item) => normalizeText(item.label) === query)) {
        const index = rows.length;
        const label = typeof create.label === 'function' ? create.label(typedText) : `Criar “${typedText}”`;
        const el = rowEl(index, 'create', { label, icon: 'plus', extraClass: 'picklist-create' });
        rows.push({ kind: 'create', el });
        nodes.push(el);
      }

      if (rows.length === 0) nodes.push(h('div', { class: 'picklist-empty' }, words.length > 0 ? 'Nada encontrado' : 'Lista vazia'));
      list.replaceChildren(...nodes);

      active = -1;
      let next = -1;
      if (!resetActive && previous) {
        next = rows.findIndex((row) => row.kind === previous.kind && (row.kind !== 'item' || row.item.id === previous.item.id));
      }
      if (next < 0 && words.length === 0 && currentId) next = rows.findIndex((row) => row.kind === 'item' && row.item.id === currentId);
      if (next < 0) next = rows.findIndex((row) => row.kind !== 'item' || !row.item.disabled);
      setActive(next, true);

      if (multiple) count.textContent = selected.size === 0 ? 'Nenhum selecionado' : selected.size === 1 ? '1 selecionado' : `${selected.size} selecionados`;
      if (pop) pop.reposition();
    }

    function move(delta) {
      const total = rows.length;
      if (total === 0) return;
      let index = active;
      for (let step = 0; step < total; step++) {
        index = active < 0 && step === 0 ? (delta > 0 ? 0 : total - 1) : (index + delta + total) % total;
        const row = rows[index];
        if (row.kind !== 'item' || !row.item.disabled) {
          setActive(index, true);
          return;
        }
      }
    }

    function onKeydown(ev) {
      if (ev.isComposing) return;
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        move(1);
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        move(-1);
      } else if (ev.key === 'Enter') {
        if (ev.target instanceof HTMLButtonElement) return; // Enter num botão do rodapé aciona o botão
        ev.preventDefault();
        ev.stopPropagation();
        if (multiple && (ev.ctrlKey || ev.metaKey)) apply();
        else if (active >= 0) choose(active);
      }
    }

    renderList(true);
    pop = openPopover(anchor, () => shell, {
      class: 'popover-picklist',
      width,
      ariaLabel: title || placeholder,
      onclose: () => resolve(result),
    });
    if (active >= 0 && rows[active]) rows[active].el.scrollIntoView({ block: 'nearest' });
  });
}

/**
 * Edição das etiquetas de um item: marca/desmarca as existentes e cria novas digitando.
 *
 *   const tags = await pickTags(botao, { tags: tarefa.tags, all: app.sel.tags() });
 *   if (tags !== null) app.cmd.updateTask(id, { tags });
 *
 * @param {Element|{ x: number, y: number }} anchor
 * @param {object} [options]
 * @param {string[]} [options.tags] etiquetas atuais do item
 * @param {string[]} [options.all] todas as etiquetas conhecidas (para sugerir)
 * @param {string} [options.title='Etiquetas']
 * @returns {Promise<string[]|null>} nova lista de etiquetas (na ordem da lista), ou null se o usuário desistiu
 */
export function pickTags(anchor, { tags, all, title = 'Etiquetas' } = {}) {
  const clean = (list) => (Array.isArray(list) ? list.filter((tag) => tag != null && String(tag).trim() !== '').map((tag) => String(tag).trim()) : []);
  const mine = clean(tags);
  const known = [...new Set([...clean(all), ...mine])].sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
  return pickFromList(anchor, {
    items: known.map((tag) => ({ id: tag, label: tag, icon: 'tag' })),
    current: mine,
    multiple: true,
    title,
    placeholder: 'Buscar ou criar etiqueta…',
    create: { label: (text) => `Criar etiqueta “${text}”`, oncreate: (text) => text.trim() },
  });
}
