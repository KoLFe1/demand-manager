// Projetos: diálogo de criar/editar (nome, código, cor, descrição), arquivar/desarquivar e excluir.
//
//   await openProjectDialog(app)               // novo projeto → Promise<projeto | null>
//   await openProjectDialog(app, projectId)    // editar
//   openProjectMenu(app, projectId, anchor)    // menu de contexto (Editar, Arquivar, Excluir…)
//
// Toda escrita passa por app.cmd.* (createProject, updateProject, archiveProject, deleteProject).

import { cx, h } from '../core/dom.js';
import { button, field, textArea, textInput } from './kit/controls.js';
import { icon } from './kit/icons.js';
import { confirmDialog, openMenu, openModal, toast } from './kit/overlays.js';

/** Cores disponíveis para projetos (nomes dos tons de status em css/tokens.css). */
export const PROJECT_COLORS = Object.freeze([
  Object.freeze({ id: 'blue', label: 'Azul' }),
  Object.freeze({ id: 'green', label: 'Verde' }),
  Object.freeze({ id: 'amber', label: 'Âmbar' }),
  Object.freeze({ id: 'red', label: 'Vermelho' }),
  Object.freeze({ id: 'violet', label: 'Violeta' }),
  Object.freeze({ id: 'slate', label: 'Ardósia' }),
  Object.freeze({ id: 'gray', label: 'Cinza' }),
]);

const COLOR_IDS = new Set(PROJECT_COLORS.map((c) => c.id));

/**
 * Cor efetiva de um projeto (cor desconhecida ou ausente → 'blue').
 * @param {object|string|null} projectOrColor projeto ou o próprio nome da cor
 * @returns {string} id da cor (PROJECT_COLORS)
 */
export function projectColor(projectOrColor) {
  const value = projectOrColor && typeof projectOrColor === 'object' ? projectOrColor.color : projectOrColor;
  return typeof value === 'string' && COLOR_IDS.has(value) ? value : 'blue';
}

/**
 * Ponto colorido de um projeto (para listas, chips e menus).
 * @param {object|string|null} projectOrColor
 * @param {{ size?: number, class?: string }} [options]
 * @returns {HTMLSpanElement}
 */
export function projectDot(projectOrColor, { size = 8, class: className } = {}) {
  return h('span', {
    class: cx('project-dot', className),
    style: { '--dot': `var(--st-${projectColor(projectOrColor)})`, width: `${size}px`, height: `${size}px` },
    'aria-hidden': 'true',
  });
}

function errorMessage(err) {
  return err && typeof err.message === 'string' && err.message ? err.message : 'Não foi possível salvar o projeto.';
}

/**
 * Abre o diálogo de criação (sem `projectId`) ou de edição de um projeto.
 * @param {object} app
 * @param {string|null} [projectId] projeto a editar; vazio = novo projeto
 * @param {{ name?: string }} [defaults] valores iniciais de um projeto novo
 * @returns {Promise<object|null>} o projeto criado/alterado, ou null se o usuário cancelou
 */
export function openProjectDialog(app, projectId = null, defaults = {}) {
  const existing = projectId ? app.sel.project(projectId) : null;
  if (projectId && !existing) {
    toast('Projeto não encontrado: ele pode ter sido excluído.', { tone: 'danger' });
    return Promise.resolve(null);
  }
  const form = {
    name: existing ? existing.name || '' : String((defaults && defaults.name) || ''),
    code: existing ? existing.code || '' : '',
    color: projectColor(existing ? existing.color : 'blue'),
    description: existing ? existing.description || '' : '',
  };
  let error = '';
  let dialog = null;
  let result = null;

  const submit = (close) => {
    const name = form.name.trim();
    if (!name) {
      error = 'Informe o nome do projeto.';
      dialog.update();
      return;
    }
    const values = {
      name,
      code: form.code.trim() ? form.code.trim().toUpperCase() : null,
      color: form.color,
      description: form.description.trim() ? form.description.trim() : null,
    };
    try {
      result = existing ? app.cmd.updateProject(existing.id, values) : app.cmd.createProject(values);
    } catch (err) {
      error = errorMessage(err);
      dialog.update();
      return;
    }
    toast(existing ? 'Projeto atualizado' : `Projeto “${name}” criado`, { tone: 'success' });
    close('saved');
  };

  return new Promise((resolve) => {
    dialog = openModal({
      title: existing ? 'Editar projeto' : 'Novo projeto',
      size: 'sm',
      class: 'project-dialog',
      render: (close) =>
        h(
          'div',
          { class: 'col gap-3' },
          field(
            { label: 'Nome', error: error || null, required: true },
            textInput({
              value: form.name,
              placeholder: 'Ex.: Projeto Alfa',
              autofocus: true,
              maxlength: 120,
              attrs: { name: 'project-name' },
              oninput: (text) => {
                form.name = text;
                if (error) {
                  error = '';
                  dialog.update();
                }
              },
              onenter: () => submit(close),
            }),
          ),
          field(
            { label: 'Código', hint: 'Sigla curta, opcional (ex.: PAL)' },
            textInput({
              value: form.code,
              placeholder: 'PAL',
              maxlength: 12,
              attrs: { name: 'project-code' },
              oninput: (text) => {
                form.code = text;
              },
              onenter: () => submit(close),
            }),
          ),
          h(
            'div',
            { class: 'field', role: 'group', 'aria-label': 'Cor' },
            h('span', { class: 'field-label' }, 'Cor'),
            h(
              'div',
              { class: 'project-swatches', role: 'radiogroup', 'aria-label': 'Cor do projeto' },
              PROJECT_COLORS.map((color) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: color.id,
                    class: cx('project-swatch', form.color === color.id && 'is-active'),
                    role: 'radio',
                    'aria-checked': form.color === color.id,
                    'aria-label': color.label,
                    title: color.label,
                    'data-color': color.id,
                    style: { '--dot': `var(--st-${color.id})` },
                    onclick: () => {
                      form.color = color.id;
                      dialog.update();
                    },
                  },
                  form.color === color.id ? icon('check', { size: 14 }) : null,
                ),
              ),
            ),
          ),
          field(
            { label: 'Descrição' },
            textArea({
              value: form.description,
              rows: 3,
              autoGrow: true,
              placeholder: 'Opcional',
              oninput: (text) => {
                form.description = text;
              },
              onsubmit: () => submit(close),
            }),
          ),
        ),
      actions: [
        { label: 'Cancelar', onclick: (close) => close(null) },
        { label: existing ? 'Salvar' : 'Criar projeto', variant: 'primary', onclick: (close) => submit(close) },
      ],
      onclose: () => resolve(result),
    });
  });
}

/**
 * Arquiva ou desarquiva um projeto (as demandas dele passam a contar como arquivadas).
 * @param {object} app
 * @param {string} projectId
 * @param {boolean} [archived=true]
 * @returns {object|null} o projeto, ou null em caso de erro (já avisado)
 */
export function archiveProject(app, projectId, archived = true) {
  try {
    const row = app.cmd.archiveProject(projectId, archived);
    if (archived && app.ui && app.ui.scope && app.ui.scope.projectId === projectId) app.ui.setScope({ projectId: null });
    toast(archived ? 'Projeto arquivado' : 'Projeto desarquivado', {
      action: { label: 'Desfazer', onclick: () => safe(() => app.cmd.archiveProject(projectId, !archived)) },
    });
    return row;
  } catch (err) {
    toast(errorMessage(err), { tone: 'danger' });
    return null;
  }
}

function safe(fn) {
  try {
    return fn();
  } catch (err) {
    toast(errorMessage(err), { tone: 'danger' });
    return null;
  }
}

/**
 * Exclui um projeto depois de confirmar. As demandas dele continuam existindo, sem projeto.
 * @param {object} app
 * @param {string} projectId
 * @returns {Promise<boolean>} true quando excluiu
 */
export async function deleteProject(app, projectId) {
  const project = app.sel.project(projectId);
  if (!project) return false;
  const count = app.sel.demands({ includeArchived: true, projectId }).length;
  const ok = await confirmDialog({
    title: `Excluir o projeto “${project.name || 'sem nome'}”?`,
    message:
      count > 0
        ? `As ${count === 1 ? 'demanda dele continua' : `${count} demandas dele continuam`} existindo, agora sem projeto. O histórico é mantido.`
        : 'O projeto não tem demandas. O histórico é mantido.',
    confirmLabel: 'Excluir projeto',
    danger: true,
  });
  if (!ok) return false;
  try {
    app.cmd.deleteProject(projectId);
  } catch (err) {
    toast(errorMessage(err), { tone: 'danger' });
    return false;
  }
  if (app.ui && app.ui.scope && app.ui.scope.projectId === projectId) app.ui.setScope({ projectId: null });
  // Desfazer: só quando a camada de comandos sabe restaurar o projeto (e devolver as demandas a ele).
  const canUndo = !!(app.cmd && typeof app.cmd.restoreProject === 'function');
  toast('Projeto excluído', {
    tone: 'success',
    action: canUndo
      ? {
          label: 'Desfazer',
          onclick: () =>
            safe(() => {
              app.cmd.restoreProject(projectId);
              toast('Projeto restaurado', { tone: 'success' });
            }),
        }
      : undefined,
  });
  return true;
}

/**
 * Abre o menu de contexto de um projeto.
 * @param {object} app
 * @param {string} projectId
 * @param {Element|{ x: number, y: number }} anchor
 * @returns {(() => void)|null} função que fecha o menu
 */
export function openProjectMenu(app, projectId, anchor) {
  const project = app.store.get('projects', projectId);
  if (!project || project.deleted_at) return null;
  const scoped = !!(app.ui && app.ui.scope && app.ui.scope.projectId === projectId);
  return openMenu(
    anchor,
    [
      project.archived_at
        ? null
        : {
            label: scoped ? 'Mostrar todos os projetos' : 'Filtrar por este projeto',
            icon: 'filter',
            onclick: () => app.ui && app.ui.setScope({ projectId: scoped ? null : projectId }),
          },
      { label: 'Editar…', icon: 'pencil', onclick: () => openProjectDialog(app, projectId) },
      { separator: true },
      project.archived_at
        ? { label: 'Desarquivar', icon: 'archive', onclick: () => archiveProject(app, projectId, false) }
        : { label: 'Arquivar', icon: 'archive', onclick: () => archiveProject(app, projectId, true) },
      { label: 'Excluir…', icon: 'trash', danger: true, onclick: () => deleteProject(app, projectId) },
    ].filter(Boolean),
    { title: project.name || 'Projeto' },
  );
}

/** Botão "Novo projeto" (usado em estados vazios). */
export function newProjectButton(app, { size = 'sm', variant = 'default' } = {}) {
  return button({ label: 'Novo projeto', icon: 'plus', size, variant, onclick: () => openProjectDialog(app) });
}
