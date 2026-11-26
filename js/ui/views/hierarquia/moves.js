// Arrastar e soltar da tela "Hierarquia": props (dragSource / dropTarget do kit) de cada tipo de linha e os
// movimentos correspondentes — sempre por app.cmd.* (moveTask, reorderDemand, updateDemand). Movimento
// inválido (ex.: tarefa com subtarefas virando subtarefa) mostra a mensagem do comando.
//
//   tarefa de nível superior: antes/depois = reordena na demanda (uma subtarefa solta aqui é promovida);
//                             dentro = vira subtarefa desta tarefa
//   subtarefa:                antes/depois = reordena entre as subtarefas do mesmo pai
//   demanda:                  demanda antes/depois = reordena (e troca de projeto, se preciso);
//                             tarefa solta sobre a linha = move a tarefa para esta demanda (no fim)
//   projeto / "Sem projeto":  demanda solta sobre a linha = move a demanda para lá
//   "Tarefas avulsas":        tarefa solta sobre a linha = vira tarefa avulsa

import { truncate } from '../../../core/format.js';
import { dragSource, dropTarget } from '../../kit/dnd.js';
import { handleError, notify, surfaceOutcome } from '../../shared/entity.js';

const quoted = (text) => `“${truncate(text || 'Sem nome', 40)}”`;
const placeOf = (position, targetId) => (position === 'before' ? { beforeId: targetId } : { afterId: targetId });

/** Executa um movimento: avisos do comando viram toasts; erros, aviso vermelho. */
function run(app, type, id, fn) {
  try {
    fn();
    surfaceOutcome(app, app.cmd.lastOutcome(), { type, id });
    return true;
  } catch (err) {
    handleError(app, err);
    return false;
  }
}

/** Projeto efetivo de uma demanda (projeto inexistente conta como "sem projeto"). */
function projectIdOfDemand(app, demand) {
  const id = demand ? demand.project_id : null;
  return id && app.sel.project(id) ? id : null;
}

/** Tarefa-pai efetiva (null para tarefa de nível superior). */
function parentIdOf(app, task) {
  const parent = task ? app.sel.parentOf(task) : null;
  return parent ? parent.id : null;
}

/** Demanda efetiva de uma tarefa (null = avulsa). */
function demandIdOf(app, task) {
  const demand = task ? app.sel.demandOf(task) : null;
  return demand ? demand.id : null;
}

// ---------------------------------------------------------------------------
// Movimentos
// ---------------------------------------------------------------------------

/** Move a tarefa `id` em relação à linha de tarefa `target`. */
export function dropOnTask(app, id, target, position, { topLevel, parentId, demandId }) {
  if (id === target.id) return false;
  if (topLevel && position === 'inside') {
    const ok = run(app, 'task', id, () => app.cmd.moveTask(id, { parent_id: target.id }));
    if (ok) notify(app, `Agora é subtarefa de ${quoted(target.name)}`, { tone: 'success' });
    return ok;
  }
  if (topLevel) return run(app, 'task', id, () => app.cmd.moveTask(id, { demand_id: demandId, parent_id: null, ...placeOf(position, target.id) }));
  return run(app, 'task', id, () => app.cmd.moveTask(id, { parent_id: parentId, ...placeOf(position, target.id) }));
}

/** Move a tarefa `id` para o fim da demanda `demand` (como tarefa de nível superior). */
export function dropTaskOnDemand(app, id, demand) {
  const ok = run(app, 'task', id, () => app.cmd.moveTask(id, { demand_id: demand.id, parent_id: null }));
  if (ok) notify(app, `Tarefa movida para ${quoted(demand.name)}`, { tone: 'success' });
  return ok;
}

/** Transforma a tarefa `id` em tarefa avulsa (sem demanda, nível superior). */
export function dropTaskOnLoose(app, id) {
  const ok = run(app, 'task', id, () => app.cmd.moveTask(id, { demand_id: null, parent_id: null }));
  if (ok) notify(app, 'Tarefa movida para as tarefas avulsas', { tone: 'success' });
  return ok;
}

/** Reordena a demanda `id` antes/depois de `target` (trocando de projeto quando o alvo é de outro). */
export function dropOnDemand(app, id, target, position) {
  const dragged = app.sel.demand(id);
  if (!dragged || id === target.id) return false;
  const targetProject = projectIdOfDemand(app, target);
  return run(app, 'demand', id, () => {
    if (projectIdOfDemand(app, dragged) !== targetProject) app.cmd.updateDemand(id, { project_id: targetProject });
    app.cmd.reorderDemand(id, placeOf(position, target.id));
  });
}

/** Move a demanda `id` para o projeto `projectId` (null = sem projeto). */
export function dropDemandOnProject(app, id, projectId) {
  const ok = run(app, 'demand', id, () => app.cmd.updateDemand(id, { project_id: projectId }));
  if (ok) {
    const project = projectId ? app.sel.project(projectId) : null;
    notify(app, project ? `Demanda movida para ${quoted(project.name)}` : 'Demanda agora está sem projeto', { tone: 'success' });
  }
  return ok;
}

// ---------------------------------------------------------------------------
// Props das linhas
// ---------------------------------------------------------------------------

/**
 * Linha de tarefa (nível superior ou subtarefa): origem e destino.
 * @param {object} app
 * @param {object} task
 * @param {{ topLevel: boolean, parentId: string|null, demandId: string|null }} where
 */
export function taskDnd(app, task, where) {
  const source = dragSource({ type: 'task', id: task.id, data: { parentId: where.parentId, demandId: where.demandId } });
  const target = dropTarget({
    accept: ['task'],
    mode: where.topLevel ? 'all' : 'sort',
    canDrop: ({ id, position }) => {
      if (id === task.id) return false;
      if (!where.topLevel && id === where.parentId) return false; // o pai sobre a própria subtarefa
      if (where.topLevel && position === 'inside') {
        const dragged = app.sel.task(id);
        if (!dragged || parentIdOf(app, dragged) === task.id) return false; // já é subtarefa desta
      }
      return true;
    },
    ondrop: ({ id, position }) => dropOnTask(app, id, task, position, where),
  });
  return { ...source, ...target };
}

/** Linha de demanda: origem e destino de outras demandas (reordenar / trocar de projeto). */
export function demandDnd(app, demand) {
  const source = dragSource({ type: 'demand', id: demand.id });
  const target = dropTarget({
    accept: ['demand'],
    mode: 'sort',
    canDrop: ({ id }) => id !== demand.id,
    ondrop: ({ id, position }) => dropOnDemand(app, id, demand, position),
  });
  return { ...source, ...target };
}

/** Envoltório da linha de demanda: recebe tarefas soltas sobre ela (move para esta demanda). */
export function demandTaskDrop(app, demand) {
  return dropTarget({
    accept: ['task'],
    mode: 'inside',
    canDrop: ({ id }) => {
      const dragged = app.sel.task(id);
      return !!dragged && !(demandIdOf(app, dragged) === demand.id && parentIdOf(app, dragged) === null);
    },
    ondrop: ({ id }) => dropTaskOnDemand(app, id, demand),
  });
}

/** Linha de projeto: recebe demandas (move para o projeto). */
export function projectDrop(app, project) {
  return dropTarget({
    accept: ['demand'],
    mode: 'inside',
    canDrop: ({ id }) => {
      const dragged = app.sel.demand(id);
      return !!dragged && projectIdOfDemand(app, dragged) !== project.id;
    },
    ondrop: ({ id }) => dropDemandOnProject(app, id, project.id),
  });
}

/** Grupo "Sem projeto": recebe demandas (tira do projeto). */
export function noProjectDrop(app) {
  return dropTarget({
    accept: ['demand'],
    mode: 'inside',
    canDrop: ({ id }) => {
      const dragged = app.sel.demand(id);
      return !!dragged && projectIdOfDemand(app, dragged) !== null;
    },
    ondrop: ({ id }) => dropDemandOnProject(app, id, null),
  });
}

/** Grupo "Tarefas avulsas": recebe tarefas (tira da demanda). */
export function looseDrop(app) {
  return dropTarget({
    accept: ['task'],
    mode: 'inside',
    canDrop: ({ id }) => {
      const dragged = app.sel.task(id);
      return !!dragged && !(demandIdOf(app, dragged) === null && parentIdOf(app, dragged) === null);
    },
    ondrop: ({ id }) => dropTaskOnLoose(app, id),
  });
}
