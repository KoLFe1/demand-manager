// Seção "Links e arquivos" dos painéis de demanda e tarefa.
//
// Lista os links do registro (ícone por tipo, rótulo e alvo truncado com dica), com:
//   • "Abrir" (web, e-mail, Office): âncora target=_blank rel="noopener noreferrer";
//   • "Copiar caminho" (rede, unidade, file://, Leapfrog, outros): navegadores bloqueiam file:// vindo de uma
//     página https, então o caminho vai para a área de transferência com a dica do Explorer;
//   • editar rótulo e remover (com "Desfazer").
// Campo de inclusão: cole um caminho/URL (+ rótulo opcional) e tecle Enter. Erros aparecem na própria seção.

import { h } from '../../core/dom.js';
import { linkInfo } from '../../domain/links.js';
import { alertBox } from '../kit/display.js';
import { button, iconButton, textInput } from '../kit/controls.js';
import { icon } from '../kit/icons.js';
import { promptDialog } from '../kit/overlays.js';
import { handleError, notify } from '../shared/entity.js';
import { section } from './task-panel.js';
import { copyToClipboard } from '../kit/clipboard.js';

export const COPY_HINT = 'Caminho copiado. No Windows: Win+E → Ctrl+L → Ctrl+V';

const isCommandError = (err) => !!err && typeof err === 'object' && err.name === 'CommandError' && typeof err.code === 'string';

export { copyToClipboard }; // mantido para quem importava daqui

async function copyLink(app, info) {
  const ok = await copyToClipboard(info.copyText);
  if (ok) notify(app, COPY_HINT, { tone: 'success', duration: 6000 });
  else notify(app, `Não foi possível copiar. Selecione e copie: ${info.copyText}`, { tone: 'warn', duration: 10000 });
}

async function editLabel(app, link, info) {
  const value = await promptDialog({ title: 'Rótulo do link', label: 'Rótulo', value: link.label || info.label, placeholder: 'Deixe vazio para usar o nome sugerido', hint: link.target });
  if (value === null || value === undefined) return;
  try {
    app.cmd.updateLink(link.id, { label: value });
  } catch (err) {
    handleError(app, err);
  }
}

function removeLink(app, link) {
  try {
    app.cmd.deleteLink(link.id);
  } catch (err) {
    handleError(app, err);
    return;
  }
  notify(app, 'Link removido', {
    action: {
      label: 'Desfazer',
      onclick: () => {
        try {
          app.cmd.restoreLink(link.id);
        } catch (err) {
          handleError(app, err);
        }
      },
    },
  });
}

function linkItem(app, link) {
  const info = linkInfo(link);
  const open = info.openMode === 'open' && info.href;
  const labelEl = open
    ? h('a', { class: 'pn-lk-label', href: info.href, target: '_blank', rel: 'noopener noreferrer' }, info.label)
    : h('span', { class: 'pn-lk-label' }, info.label);
  return h(
    'li',
    { class: 'pn-lk', key: link.id, dataset: { linkId: link.id, kind: info.kind } },
    h('span', { class: 'pn-lk-icon', title: info.kindLabel, 'aria-hidden': 'true' }, icon(info.icon, { size: 16 })),
    h('div', { class: 'pn-lk-main' }, labelEl, h('span', { class: 'pn-lk-target', title: link.target }, link.target)),
    h(
      'div',
      { class: 'pn-lk-actions' },
      open
        ? h('a', { class: 'btn btn-ghost btn-sm pn-lk-open', href: info.href, target: '_blank', rel: 'noopener noreferrer', title: `Abrir ${info.kindLabel.toLowerCase()}` }, icon('external', { size: 14 }), h('span', null, 'Abrir'))
        : button({ label: 'Copiar caminho', icon: 'copy', size: 'sm', variant: 'ghost', class: 'pn-lk-copy', title: 'Copiar para colar no Explorer', onclick: () => copyLink(app, info) }),
      iconButton({ icon: 'pencil', title: 'Editar rótulo', size: 'sm', class: 'pn-lk-edit', onclick: () => editLabel(app, link, info) }),
      iconButton({ icon: 'trash', title: 'Remover link', size: 'sm', class: 'pn-lk-remove', onclick: () => removeLink(app, link) }),
    ),
  );
}

/**
 * Seção "Links e arquivos".
 * @param {object} app
 * @param {'demand'|'task'|'project'} type
 * @param {string} id
 * @param {{ state: object, setState: Function }} pctx estado do painel (erro de validação em state.linkError)
 * @returns {HTMLElement}
 */
export function linksSection(app, type, id, { state, setState }) {
  const links = app.sel.links(type, id);
  const submit = (anchor) => {
    const root = anchor && anchor.closest ? anchor.closest('.pn-links') : null;
    const targetField = root ? root.querySelector('.pn-lk-new-target input') : null;
    const labelField = root ? root.querySelector('.pn-lk-new-label input') : null;
    if (!targetField) return;
    try {
      app.cmd.addLink(type, id, { target: targetField.value, label: labelField ? labelField.value : null });
    } catch (err) {
      if (isCommandError(err) && (err.code === 'invalid_target' || err.code === 'invalid_field')) {
        setState({ linkError: err.message });
        targetField.focus();
      } else handleError(app, err);
      return;
    }
    targetField.value = '';
    if (labelField) labelField.value = '';
    if (state.linkError) setState({ linkError: null });
    targetField.focus({ preventScroll: true });
  };
  return section(
    'Links e arquivos',
    { count: links.length || null, icon: 'link', class: 'pn-links', key: 'links' },
    links.length ? h('ul', { class: 'pn-lk-list' }, links.map((link) => linkItem(app, link))) : h('p', { class: 'pn-empty-line' }, 'Nenhum link ainda.'),
    h(
      'div',
      { class: 'pn-lk-new' },
      textInput({
        placeholder: 'Cole um caminho (\\\\servidor\\pasta, X:\\…) ou URL',
        ariaLabel: 'Novo link: caminho ou URL',
        size: 'sm',
        icon: 'link',
        invalid: !!state.linkError,
        class: 'pn-lk-new-target',
        onenter: (_v, ev) => submit(ev.currentTarget),
        oninput: () => {
          if (state.linkError) setState({ linkError: null });
        },
      }),
      textInput({ placeholder: 'Rótulo (opcional)', ariaLabel: 'Rótulo do novo link', size: 'sm', class: 'pn-lk-new-label', onenter: (_v, ev) => submit(ev.currentTarget) }),
      button({ label: 'Adicionar', icon: 'plus', size: 'sm', class: 'pn-lk-add', onclick: (ev) => submit(ev.currentTarget) }),
    ),
    state.linkError ? alertBox({ tone: 'danger', text: state.linkError, class: 'pn-lk-error', ondismiss: () => setState({ linkError: null }) }) : null,
  );
}
