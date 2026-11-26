// Modelos de demanda na interface: diálogo "Nova demanda a partir de modelo", "Salvar como modelo" e as
// ações de renomear/excluir usadas em Configurações.
//
//   const demanda = await openTemplateDialog(app);          // demanda criada (aberta no painel) ou null
//   await saveDemandAsTemplate(app, demandId);               // pede o nome e salva
//
// Os modelos salvos ficam na configuração sincronizada 'templates'; o embutido vem de domain/templates.js.

import { cx, h } from '../core/dom.js';
import { formatDate } from '../core/dates.js';
import { availableTemplates, planTemplate } from '../domain/templates.js';
import { dateInput, field, selectInput, textInput } from './kit/controls.js';
import { icon } from './kit/icons.js';
import { confirmDialog, openModal, promptDialog } from './kit/overlays.js';
import { handleError, notify } from './shared/entity.js';

const hasId = (id) => id !== null && id !== undefined && id !== '';
const isCommandError = (err) => !!err && typeof err === 'object' && err.name === 'CommandError' && typeof err.code === 'string';

/** Modelos disponíveis (embutido + salvos válidos). */
export function listTemplates(app) {
  return availableTemplates(app.settings.get('templates', null));
}

const daysText = (n) => (n === 1 ? '1 dia útil' : `${n} dias úteis`);

/**
 * Abre o diálogo "Nova demanda a partir de modelo".
 * @param {object} app
 * @param {{ templateId?: string, project_id?: string|null }} [defaults]
 * @returns {Promise<object|null>} a demanda criada, ou null se cancelou
 */
export function openTemplateDialog(app, defaults = {}) {
  return new Promise((resolve) => {
    const templates = listTemplates(app);
    const scope = app.ui && app.ui.scope && hasId(app.ui.scope.projectId) ? app.ui.scope.projectId : null;
    const projectId = hasId(defaults.project_id) ? defaults.project_id : scope;
    const form = {
      templateId: templates.some((t) => t.id === defaults.templateId) ? defaults.templateId : templates[0].id,
      name: '',
      project_id: app.sel.project(projectId) ? projectId : null,
      startDate: null,
      error: null,
    };
    let created = null;
    let dialog = null;

    const current = () => templates.find((t) => t.id === form.templateId) || templates[0];
    const refresh = () => dialog && dialog.update();

    const create = () => {
      try {
        created = app.cmd.createDemandFromTemplate(form.templateId, {
          name: form.name.trim() || undefined,
          project_id: form.project_id || null,
          startDate: form.startDate || null,
        });
      } catch (err) {
        if (isCommandError(err)) {
          form.error = err.message;
          refresh();
        } else handleError(app, err);
        return;
      }
      dialog.close('created');
      notify(app, `Demanda “${created.name}” criada a partir do modelo`, { tone: 'success', duration: 3000 });
      if (app.ui && typeof app.ui.openPanel === 'function') {
        try {
          app.ui.openPanel('demand', created.id);
        } catch (err) {
          handleError(app, err);
        }
      }
    };

    const preview = () => {
      const template = current();
      let plan;
      try {
        plan = planTemplate(template, { startDate: form.startDate });
      } catch (err) {
        return h('p', { class: 'field-error' }, err.message);
      }
      const today = app.clock.today();
      const names = new Map(plan.tasks.map((t) => [t.key, t.name]));
      return h(
        'div',
        { class: 'tpl-preview' },
        h(
          'div',
          { class: 'tpl-preview-head' },
          h('span', null, `${plan.tasks.length} ${plan.tasks.length === 1 ? 'tarefa' : 'tarefas'}`),
          plan.end ? h('span', { class: 'tpl-preview-end' }, `Prazo da demanda: ${formatDate(plan.end, 'weekday', today)}`) : h('span', { class: 'tpl-preview-end' }, 'Sem data de início: tarefas sem datas'),
        ),
        h(
          'ol',
          { class: 'tpl-tasks', 'aria-label': 'Tarefas do modelo' },
          plan.tasks.map((task) =>
            h(
              'li',
              { key: task.key, class: 'tpl-task', 'data-tpl-task': task.key },
              h('span', { class: 'tpl-task-name' }, task.name, task.subtasks.length ? h('span', { class: 'tpl-task-subs' }, ` · ${task.subtasks.length} sub`) : null),
              h(
                'span',
                { class: 'tpl-task-meta' },
                task.planned_start
                  ? h('span', { class: 'tpl-task-dates tabular' }, `${formatDate(task.planned_start, 'daymonth', today)} → ${formatDate(task.due_date, 'daymonth', today)}`)
                  : h('span', { class: 'tpl-task-dates' }, daysText(task.durationDays)),
                h('span', { class: 'tpl-task-dep', title: task.dependsOn.length ? `Depende de: ${task.dependsOn.map((k) => names.get(k)).join(', ')}` : null }, task.dependsOn.length ? icon('link', { size: 12 }) : null),
              ),
            ),
          ),
        ),
      );
    };

    const render = () => {
      const template = current();
      return h(
        'div',
        { class: 'tpl-form' },
        field(
          { label: 'Modelo', hint: template.description || null },
          selectInput({
            value: form.templateId,
            ariaLabel: 'Modelo',
            class: 'tpl-select',
            options: templates.map((t) => ({ value: t.id, label: t.builtin ? `${t.name} (embutido)` : t.name })),
            onchange: (value) => {
              form.templateId = value;
              form.error = null;
              refresh();
            },
          }),
        ),
        field(
          { label: 'Nome da demanda', error: form.error },
          textInput({
            value: form.name,
            placeholder: template.name,
            ariaLabel: 'Nome da demanda',
            maxlength: 300,
            autofocus: true,
            class: 'tpl-name',
            oninput: (text) => {
              form.name = text;
            },
            onenter: (text) => {
              form.name = text;
              create();
            },
          }),
        ),
        h(
          'div',
          { class: 'tpl-row' },
          field(
            { label: 'Projeto' },
            selectInput({
              value: form.project_id || '',
              ariaLabel: 'Projeto',
              class: 'tpl-project',
              options: [{ value: '', label: 'Sem projeto' }, ...app.sel.projects().map((p) => ({ value: p.id, label: p.name }))],
              onchange: (value) => {
                form.project_id = value || null;
              },
            }),
          ),
          field(
            { label: 'Início (opcional)' },
            dateInput({
              value: form.startDate,
              clearable: true,
              ariaLabel: 'Data de início',
              class: 'tpl-start',
              onchange: (value) => {
                form.startDate = value || null;
                refresh();
              },
            }),
          ),
        ),
        preview(),
      );
    };

    dialog = openModal({
      title: 'Nova demanda a partir de modelo',
      size: 'md',
      class: cx('tpl-modal'),
      render,
      actions: () => [
        { label: 'Cancelar', value: 'cancel' },
        { label: 'Criar demanda', variant: 'primary', onclick: () => create() },
      ],
      onclose: () => resolve(created),
    });
  });
}

/**
 * "Salvar como modelo…": pede o nome e grava a demanda como modelo.
 * @param {object} app
 * @param {string} demandId
 * @returns {Promise<object|null>} o modelo salvo ou null
 */
export async function saveDemandAsTemplate(app, demandId) {
  const demand = app.sel.demand(demandId);
  if (!demand) return null;
  const name = await promptDialog({
    title: 'Salvar como modelo',
    label: 'Nome do modelo',
    value: demand.name,
    required: true,
    confirmLabel: 'Salvar modelo',
    hint: 'Guarda as tarefas, subtarefas, durações, estimativas e dependências (datas viram deslocamentos em dias úteis).',
  });
  if (name === null) return null;
  try {
    const template = app.cmd.saveDemandAsTemplate(demandId, { name });
    notify(app, `Modelo “${template.name}” salvo (${template.tasks.length} ${template.tasks.length === 1 ? 'tarefa' : 'tarefas'})`, { tone: 'success' });
    return template;
  } catch (err) {
    handleError(app, err);
    return null;
  }
}

/** Renomeia um modelo salvo (pede o nome). */
export async function renameTemplate(app, template) {
  const name = await promptDialog({ title: 'Renomear modelo', label: 'Nome', value: template.name, required: true });
  if (name === null) return;
  try {
    app.cmd.renameTemplate(template.id, name);
  } catch (err) {
    handleError(app, err);
  }
}

/** Exclui um modelo salvo (com confirmação). */
export async function deleteTemplate(app, template) {
  const ok = await confirmDialog({
    title: 'Excluir modelo?',
    message: `O modelo “${template.name}” deixa de aparecer na criação de demandas. As demandas já criadas com ele não mudam.`,
    confirmLabel: 'Excluir',
    danger: true,
  });
  if (!ok) return;
  try {
    app.cmd.deleteTemplate(template.id);
    notify(app, 'Modelo excluído', { tone: 'success' });
  } catch (err) {
    handleError(app, err);
  }
}
