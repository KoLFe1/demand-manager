// Criação rápida de tarefa / demanda / projeto (diálogo curto aberto por atalho ou pelo botão "Nova").
//
//   const tarefa = await openQuickCreate(app, 'task', { demand_id });   // entidade criada ou null
//
// Teclado: Enter cria e fecha; Ctrl/Cmd+Enter cria e abre o painel; "Criar outra" mantém o diálogo aberto para
// cadastrar várias em sequência; Esc cancela. Só os campos essenciais aparecem (o resto se edita no painel).

import { cx, h } from '../core/dom.js';
import { formatDate } from '../core/dates.js';
import { iconButton, segmented, switchInput, textArea, textInput } from './kit/controls.js';
import { priorityBadge } from './kit/display.js';
import { icon } from './kit/icons.js';
import { openModal } from './kit/overlays.js';
import { EMPTY_CHOICE, pickDate, pickFromList, pickPriority } from './kit/pickers.js';
import { handleError, notify, projectDot, surfaceOutcome } from './shared/entity.js';

const TYPES = Object.freeze([
  { value: 'task', label: 'Tarefa', icon: 'check-circle', title: 'Nova tarefa' },
  { value: 'demand', label: 'Demanda', icon: 'layers', title: 'Nova demanda' },
  { value: 'project', label: 'Projeto', icon: 'folder', title: 'Novo projeto' },
]);

/** Cores oferecidas para projetos (tons de status do tema). */
export const PROJECT_COLORS = Object.freeze([
  { id: 'blue', label: 'Azul' },
  { id: 'violet', label: 'Violeta' },
  { id: 'green', label: 'Verde' },
  { id: 'amber', label: 'Âmbar' },
  { id: 'red', label: 'Vermelho' },
  { id: 'slate', label: 'Ardósia' },
  { id: 'gray', label: 'Cinza' },
]);

const hasId = (id) => id !== null && id !== undefined && id !== '';
const isCommandError = (err) => !!err && typeof err === 'object' && err.name === 'CommandError' && typeof err.code === 'string';

/** Demanda aberta no painel lateral (para pré-preencher a nova tarefa). */
function openDemandId(app) {
  try {
    const open = app.ui && typeof app.ui.panel === 'function' ? app.ui.panel() : null;
    return open && open.type === 'demand' && hasId(open.id) ? open.id : null;
  } catch {
    return null;
  }
}

/** Projeto do filtro global da casca (app.ui.scope.projectId), ou null. */
function scopeProjectId(app) {
  const scope = app.ui && app.ui.scope && hasId(app.ui.scope.projectId) ? app.ui.scope.projectId : null;
  return scope && app.sel.project(scope) ? scope : null;
}

/** Projeto em que o item do formulário vai cair (tarefa: pela tarefa principal ou pela demanda). */
function prospectiveProjectId(app, form) {
  if (form.type === 'demand') return form.project_id || null;
  if (form.type !== 'task') return null;
  const parent = form.parent_id ? app.sel.task(form.parent_id) : null;
  if (parent) return app.sel.projectIdOf('task', parent);
  const demand = form.demand_id ? app.sel.demand(form.demand_id) : null;
  return demand ? app.sel.projectIdOf('demand', demand) : null;
}

/**
 * Com um projeto no filtro global, as telas só mostram itens desse projeto: avisa quando o item recém-criado
 * ficou fora dele (senão ele "some" sem explicação) e oferece abri-lo.
 */
function warnOutOfScope(app, type, row) {
  const scope = scopeProjectId(app);
  if (!scope || !row || (type !== 'task' && type !== 'demand')) return;
  if (app.sel.projectIdOf(type, row) === scope) return;
  const project = app.sel.project(scope);
  const noun = type === 'task' ? 'Tarefa' : 'Demanda';
  notify(app, `${noun} criada, mas fora do projeto filtrado (${project ? project.name : 'projeto'}): ela não aparece nas listas enquanto o filtro estiver ativo.`, {
    tone: 'warn',
    duration: 8000,
    action: app.ui && typeof app.ui.openPanel === 'function' ? { label: 'Abrir', onclick: () => app.ui.openPanel(type, row.id) } : undefined,
  });
}

/** Valores iniciais do formulário a partir de `defaults` e do contexto da casca. */
function initialForm(app, type, defaults) {
  const d = defaults && typeof defaults === 'object' ? defaults : {};
  const parent = hasId(d.parent_id) ? app.sel.task(d.parent_id) : null;
  const demandId = hasId(d.demand_id) ? d.demand_id : openDemandId(app);
  const scope = app.ui && app.ui.scope && hasId(app.ui.scope.projectId) ? app.ui.scope.projectId : null;
  const projectId = hasId(d.project_id) ? d.project_id : scope;
  return {
    type: TYPES.some((t) => t.value === type) ? type : 'task',
    name: typeof d.name === 'string' ? d.name : '',
    // descrição só aparece quando veio preenchida (ex.: captura rápida do celular); null = sem o campo
    description: typeof d.description === 'string' ? d.description : null,
    parent_id: parent && !app.sel.parentOf(parent) ? parent.id : null,
    demand_id: app.sel.demand(demandId) ? demandId : null,
    project_id: app.sel.project(projectId) ? projectId : null,
    priority: typeof d.priority === 'string' ? d.priority : 'P3',
    due_date: typeof d.due_date === 'string' ? d.due_date : null,
    status: typeof d.status === 'string' ? d.status : undefined,
    code: '',
    color: 'blue',
    another: false,
    error: null,
    count: 0,
  };
}

function chipButton({ glyph, text, onclick, title, empty, disabled, className }) {
  return h(
    'button',
    { type: 'button', class: cx('qc-chip', empty && 'is-empty', className), onclick, title: title || text, disabled: !!disabled },
    glyph,
    h('span', { class: 'qc-chip-text' }, text),
  );
}

/**
 * Abre o diálogo de criação rápida.
 * @param {object} app
 * @param {'task'|'demand'|'project'} type tipo inicial (o usuário pode trocar no diálogo)
 * @param {{ demand_id?: string, parent_id?: string, project_id?: string, status?: string, due_date?: string,
 *           priority?: string, name?: string, description?: string }} [defaults] `description` (texto) mostra
 *        o campo Descrição já preenchido (captura rápida) e é gravado ao criar. valores iniciais. Sem demand_id, usa a demanda aberta no
 *        painel; sem project_id, o projeto do filtro global (app.ui.scope.projectId).
 * @returns {Promise<object|null>} a (última) entidade criada, ou null se o usuário cancelou sem criar
 */
export function openQuickCreate(app, type = 'task', defaults = {}) {
  return new Promise((resolve) => {
    const form = initialForm(app, type, defaults);
    let last = null;
    let dialog = null;

    const nameInput = () => (dialog && dialog.el ? dialog.el.querySelector('.qc-name input') : null);
    const focusName = () => {
      const input = nameInput();
      if (input) input.focus({ preventScroll: true });
    };
    const refresh = () => {
      if (!dialog) return;
      dialog.update();
      const heading = dialog.el.querySelector('.modal-title');
      const def = TYPES.find((t) => t.value === form.type);
      if (heading && def) heading.textContent = def.title;
    };

    const create = ({ open = false } = {}) => {
      const input = nameInput();
      const name = (input ? input.value : form.name).trim();
      if (!name) {
        form.error = 'Informe um nome.';
        refresh();
        focusName();
        return;
      }
      const description = typeof form.description === 'string' && form.description.trim() ? form.description.trim() : null;
      let row = null;
      try {
        if (form.type === 'task') {
          const parent = form.parent_id ? app.sel.task(form.parent_id) : null;
          row = app.cmd.createTask({
            name,
            parent_id: parent ? parent.id : undefined,
            demand_id: parent ? undefined : form.demand_id || null,
            priority: form.priority,
            due_date: form.due_date || null,
            status: form.status,
            description,
          });
        } else if (form.type === 'demand') {
          row = app.cmd.createDemand({ name, project_id: form.project_id || null, priority: form.priority, due_date: form.due_date || null, status: form.status, description });
        } else {
          row = app.cmd.createProject({ name, code: form.code.trim() || null, color: form.color, description });
        }
      } catch (err) {
        if (isCommandError(err)) {
          form.error = err.message;
          refresh();
        } else handleError(app, err);
        return;
      }
      last = row;
      form.count += 1;
      if (form.type !== 'project') {
        surfaceOutcome(app, app.cmd.lastOutcome(), { type: form.type, id: row.id });
        warnOutOfScope(app, form.type, row);
      }
      if (open) {
        const createdType = form.type;
        dialog.close('created');
        if (createdType !== 'project' && app.ui && typeof app.ui.openPanel === 'function') {
          try {
            app.ui.openPanel(createdType, row.id);
          } catch (err) {
            handleError(app, err);
          }
        }
        return;
      }
      if (form.another) {
        const noun = TYPES.find((t) => t.value === form.type);
        notify(app, `${noun ? noun.label : 'Item'} “${name}” ${form.type === 'project' ? 'criado' : 'criada'}`, { tone: 'success', duration: 2500 });
        form.name = '';
        form.error = null;
        if (input) input.value = '';
        if (form.description !== null) form.description = '';
        if (form.type === 'project') form.code = '';
        refresh();
        focusName();
        return;
      }
      dialog.close('created');
    };

    const pickDemand = async (ev) => {
      const projects = app.sel.projectsById();
      const scope = scopeProjectId(app);
      // com um projeto no filtro global, as demandas dele vêm primeiro (é onde a tarefa continua visível)
      const demands = scope ? [...app.sel.demands()].sort((x, y) => Number(y.project_id === scope) - Number(x.project_id === scope)) : app.sel.demands();
      const chosen = await pickFromList(ev.currentTarget, {
        items: demands.map((d) => {
          const p = hasId(d.project_id) ? projects.get(d.project_id) : null;
          return { id: d.id, label: d.name, hint: app.sel.code('demand', d), group: p ? p.name : 'Sem projeto', icon: projectDot(p) };
        }),
        current: form.demand_id,
        allowEmpty: true,
        emptyLabel: 'Sem demanda (tarefa avulsa)',
        placeholder: 'Buscar demanda…',
        title: 'Demanda',
        width: 320,
      });
      if (chosen === null) return;
      form.demand_id = chosen === EMPTY_CHOICE ? null : chosen;
      refresh();
      focusName();
    };

    const pickProject = async (ev) => {
      const chosen = await pickFromList(ev.currentTarget, {
        items: app.sel.projects().map((p) => ({ id: p.id, label: p.name, hint: p.code || null, icon: projectDot(p) })),
        current: form.project_id,
        allowEmpty: true,
        emptyLabel: 'Sem projeto',
        placeholder: 'Buscar projeto…',
        title: 'Projeto',
      });
      if (chosen === null) return;
      form.project_id = chosen === EMPTY_CHOICE ? null : chosen;
      refresh();
      focusName();
    };

    const choosePriority = async (ev) => {
      const chosen = await pickPriority(ev.currentTarget, { current: form.priority });
      if (chosen === null) return;
      form.priority = chosen;
      refresh();
      focusName();
    };

    const chooseDate = async (ev) => {
      const picked = await pickDate(ev.currentTarget, { value: form.due_date, today: app.clock.today(), title: 'Prazo' });
      if (picked === null) return;
      form.due_date = picked.value;
      refresh();
      focusName();
    };

    const fieldsFor = () => {
      const today = app.clock.today();
      const dueChip = chipButton({
        glyph: icon('calendar', { size: 14 }),
        text: form.due_date ? formatDate(form.due_date, 'weekday', today) : 'Prazo',
        empty: !form.due_date,
        title: 'Prazo',
        onclick: chooseDate,
        className: 'qc-due',
      });
      const priorityChip = h(
        'span',
        { class: 'qc-chip qc-priority-wrap' },
        priorityBadge(form.priority, { showLabel: true, onclick: choosePriority, class: 'qc-priority' }),
      );
      if (form.type === 'task') {
        const parent = form.parent_id ? app.sel.task(form.parent_id) : null;
        const demand = form.demand_id ? app.sel.demand(form.demand_id) : null;
        return [
          parent
            ? h(
                'span',
                { class: 'qc-chip qc-parent', title: `Subtarefa de “${parent.name}”` },
                icon('list', { size: 14 }),
                h('span', { class: 'qc-chip-text' }, `Subtarefa de “${parent.name}”`),
                iconButton({
                  icon: 'x',
                  title: 'Criar como tarefa normal',
                  size: 'sm',
                  onclick: () => {
                    form.parent_id = null;
                    refresh();
                    focusName();
                  },
                }),
              )
            : chipButton({ glyph: icon('layers', { size: 14 }), text: demand ? demand.name : 'Sem demanda', empty: !demand, title: 'Demanda', onclick: pickDemand, className: 'qc-demand' }),
          priorityChip,
          dueChip,
        ];
      }
      if (form.type === 'demand') {
        const project = form.project_id ? app.sel.project(form.project_id) : null;
        return [
          chipButton({ glyph: projectDot(project), text: project ? project.name : 'Sem projeto', empty: !project, title: 'Projeto', onclick: pickProject, className: 'qc-project' }),
          priorityChip,
          dueChip,
        ];
      }
      return [
        textInput({
          value: form.code,
          placeholder: 'Código (opcional)',
          ariaLabel: 'Código do projeto',
          size: 'sm',
          maxlength: 12,
          class: 'qc-code',
          oninput: (text) => {
            form.code = text;
          },
          onenter: (text, ev) => create({ open: ev.ctrlKey || ev.metaKey }),
        }),
        h(
          'div',
          { class: 'qc-colors', role: 'radiogroup', 'aria-label': 'Cor do projeto' },
          PROJECT_COLORS.map((color) =>
            h(
              'button',
              {
                type: 'button',
                class: cx('qc-color', `en-dot-${color.id}`, form.color === color.id && 'is-active'),
                role: 'radio',
                'aria-checked': form.color === color.id,
                'aria-label': color.label,
                title: color.label,
                onclick: () => {
                  form.color = color.id;
                  refresh();
                },
              },
              form.color === color.id ? icon('check', { size: 12 }) : null,
            ),
          ),
        ),
      ];
    };

    /** Dica quando o item vai ficar fora do projeto do filtro global (e, portanto, escondido das telas). */
    const scopeHint = () => {
      const scope = scopeProjectId(app);
      if (!scope || (form.type !== 'task' && form.type !== 'demand')) return null;
      if (prospectiveProjectId(app, form) === scope) return null;
      const project = app.sel.project(scope);
      const text =
        form.type === 'task'
          ? `Sem uma demanda de ${project.name}, a tarefa fica fora do projeto filtrado e não aparece nas listas.`
          : `Sem o projeto ${project.name}, a demanda fica fora do projeto filtrado e não aparece nas listas.`;
      return h('p', { class: 'qc-scope-hint' }, icon('info', { size: 12 }), h('span', null, text));
    };

    const render = () =>
      h(
        'div',
        {
          class: cx('qc', `qc-${form.type}`),
          onkeydown: (ev) => {
            if (ev.key !== 'Enter' || ev.isComposing || ev.defaultPrevented) return;
            if (!(ev.ctrlKey || ev.metaKey)) return;
            if (ev.target && ev.target.closest && ev.target.closest('.qc-name, .qc-code')) return; // os campos tratam o próprio Enter
            ev.preventDefault();
            create({ open: true });
          },
        },
        segmented({
          value: form.type,
          ariaLabel: 'Tipo do item',
          size: 'sm',
          class: 'qc-types',
          options: TYPES.map((t) => ({ value: t.value, label: t.label, icon: t.icon })),
          onchange: (value) => {
            form.type = value;
            form.error = null;
            refresh();
            focusName();
          },
        }),
        textInput({
          value: form.name,
          autofocus: true,
          placeholder: form.type === 'task' ? 'Nome da tarefa' : form.type === 'demand' ? 'Nome da demanda' : 'Nome do projeto',
          ariaLabel: 'Nome',
          maxlength: 300,
          class: 'qc-name',
          invalid: !!form.error,
          oninput: (text) => {
            form.name = text;
            if (form.error) {
              form.error = null;
              refresh();
            }
          },
          onenter: (text, ev) => create({ open: ev.ctrlKey || ev.metaKey }),
        }),
        form.description !== null
          ? textArea({
              value: form.description,
              rows: 3,
              autoGrow: true,
              placeholder: 'Descrição',
              ariaLabel: 'Descrição',
              maxlength: 10000,
              class: 'qc-desc',
              oninput: (text) => {
                form.description = text;
              },
              onsubmit: () => create({ open: true }),
            })
          : null,
        form.error ? h('p', { class: 'field-error qc-error', role: 'alert' }, icon('alert-circle', { size: 12 }), h('span', null, form.error)) : null,
        h('div', { class: 'qc-fields' }, fieldsFor()),
        scopeHint(),
        h(
          'div',
          { class: 'qc-foot' },
          switchInput({
            checked: form.another,
            label: 'Criar outra',
            class: 'qc-another',
            onchange: (checked) => {
              form.another = checked;
              refresh();
              focusName();
            },
          }),
          h('span', { class: 'qc-hint' }, h('kbd', { class: 'kbd' }, 'Enter'), ' cria · ', h('kbd', { class: 'kbd' }, 'Ctrl'), h('kbd', { class: 'kbd' }, 'Enter'), ' cria e abre'),
        ),
      );

    dialog = openModal({
      title: (TYPES.find((t) => t.value === form.type) || TYPES[0]).title,
      size: 'sm',
      class: 'qc-modal',
      render,
      actions: () => [
        { label: 'Cancelar', value: 'cancel' },
        { label: 'Criar', variant: 'primary', onclick: () => create() },
      ],
      onclose: () => resolve(last),
    });
  });
}
