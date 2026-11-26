// Ajuda de atalhos de teclado: diálogo gerado a partir de shortcuts.list() (core/shortcuts.js).
//
//   openShortcutHelp(app.ui.shortcuts.list())

import { h } from '../core/dom.js';
import { formatKeys } from '../core/shortcuts.js';
import { icon } from './kit/icons.js';
import { openModal } from './kit/overlays.js';

/** Ordem preferida dos grupos (os demais vêm depois, na ordem em que aparecem). */
const GROUP_ORDER = ['Geral', 'Criar', 'Navegação', 'Item selecionado'];

/**
 * Agrupa a lista de atalhos por `group`, na ordem de GROUP_ORDER e depois na de registro.
 * Atalhos com as mesmas teclas no mesmo grupo aparecem uma vez só.
 * @param {Array<{ keys: string, label: string, group: string }>} list
 * @returns {Array<{ group: string, items: Array<{ keys: string, label: string }> }>}
 */
export function groupShortcuts(list) {
  const groups = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !item.keys || !item.label) continue;
    const name = item.group || 'Outros';
    if (!groups.has(name)) groups.set(name, []);
    const items = groups.get(name);
    if (!items.some((other) => other.keys === item.keys && other.label === item.label)) items.push({ keys: item.keys, label: item.label });
  }
  const names = [...groups.keys()].sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(a);
    const ib = GROUP_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return names.map((group) => ({ group, items: groups.get(group) }));
}

/** Teclas de um atalho como <kbd> ("G então D" vira duas teclas com "então" entre elas). */
function keysNode(keys) {
  const text = formatKeys(keys);
  const steps = text.split(' então ');
  const parts = [];
  steps.forEach((step, index) => {
    if (index > 0) parts.push(h('span', { class: 'help-then' }, 'então'));
    // "Ctrl+K" → Ctrl + K; o próprio "+" (Ctrl++) fica como tecla.
    const keysOfStep = step === '+' ? ['+'] : step.split(/\+(?!$)/);
    for (const key of keysOfStep) parts.push(h('kbd', { class: 'kbd' }, key));
  });
  return h('span', { class: 'kbd-group help-keys' }, parts);
}

/**
 * Abre o diálogo com todos os atalhos de teclado, agrupados.
 * @param {Array<{ keys: string, label: string, group: string }>} list resultado de shortcuts.list()
 * @returns {{ close: Function, update: Function, el: HTMLElement }}
 */
export function openShortcutHelp(list) {
  const groups = groupShortcuts(list);
  return openModal({
    title: 'Atalhos de teclado',
    size: 'md',
    class: 'help-dialog',
    render: () =>
      h(
        'div',
        { class: 'help', 'data-shortcut-help': 'true' },
        h('p', { class: 'help-intro' }, icon('keyboard', { size: 16 }), h('span', null, 'Os atalhos não funcionam enquanto você digita num campo. Os de item valem para o item aberto no painel, em foco ou sob o mouse.')),
        h(
          'div',
          { class: 'help-groups' },
          groups.map(({ group, items }) =>
            h(
              'section',
              { class: 'help-group', key: group },
              h('h3', { class: 'help-group-title' }, group),
              h(
                'dl',
                { class: 'help-list' },
                items.map((item) => h('div', { class: 'help-row', key: `${item.keys}|${item.label}` }, h('dt', { class: 'help-label' }, item.label), h('dd', { class: 'help-key' }, keysNode(item.keys)))),
              ),
            ),
          ),
        ),
      ),
    actions: [{ label: 'Fechar', variant: 'primary' }],
  });
}
