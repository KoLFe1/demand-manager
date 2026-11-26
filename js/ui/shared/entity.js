// Controles de demanda/tarefa compartilhados por TODAS as telas e pelos painéis laterais.
//
// Este é o ÚNICO lugar onde mora a interação com demandas e tarefas: status, prioridade, prazo, cronômetro,
// menu de contexto, linhas e cartões padrão. As telas compõem estas peças — assim uma tarefa se parece e se
// comporta igual em qualquer lugar do app.
//
//   taskRow(app, tarefa)                          linha padrão de tarefa (listas)
//   demandRow(app, demanda)                       linha padrão de demanda
//   entityCard(app, 'task', tarefa)               cartão compacto (Kanban, calendário)
//   statusControl(app, 'task', tarefa)            selo de status que abre o seletor
//   entityActions.complete(app, 'task', id)       fluxo completo (comando + avisos + desfazer)
//   openEntityMenu(app, 'task', id, { x, y })     menu de contexto
//
// Regras ("poucos cliques"):
//   • toda escrita passa por app.cmd.*; erros de regra (CommandError) viram aviso vermelho;
//   • a troca de status é aplicada na hora; os avisos do comando aparecem DEPOIS, com a ação que resolve
//     ("Concluir as 3 subtarefas", "Concluir a demanda", "Desfazer"…);
//   • excluir tarefa não pergunta (oferece Desfazer); excluir demanda confirma quantas tarefas vão junto;
//   • prioridade nunca muda sozinha: sugestões aparecem como dica, o usuário aplica ou dispensa;
//   • `type` é sempre 'task' ou 'demand'.

import { cx, h } from '../../core/dom.js';
import { formatDate } from '../../core/dates.js';
import { plural, truncate } from '../../core/format.js';
import { effectiveWeights, isCountable, weightWarningText } from '../../domain/progress.js';
import { followUpInfo, isOtherOwner } from '../../domain/followup.js';
import { firstOfCategory, isClosedCategory, isInFlightCategory, isOpenCategory } from '../../domain/statuses.js';
import { TIMER, elapsedSeconds, estimateVsActual, formatDuration, timerState } from '../../domain/timetracking.js';
import { button, durationInput, formatDurationText, iconButton, inlineEdit, textInput } from '../kit/controls.js';
import { STATUS_COLORS, STATUS_ICONS, avatar, deadlineChip, ownerChip, priorityBadge, progressBar, statusBadge, tagList } from '../kit/display.js';
import { icon } from '../kit/icons.js';
import { confirmDialog, openMenu, openModal, openPopover, promptDialog, toast as kitToast } from '../kit/overlays.js';
import { EMPTY_CHOICE, pickDate, pickFromList, pickPriority as kitPickPriority, pickStatus as kitPickStatus, pickTags } from '../kit/pickers.js';

/** Colunas padrão da linha de tarefa. */
export const TASK_ROW_COLUMNS = Object.freeze(['check', 'title', 'flags', 'status', 'priority', 'due', 'menu']);
/** Colunas padrão da linha de demanda. */
export const DEMAND_ROW_COLUMNS = Object.freeze(['title', 'project', 'progress', 'status', 'priority', 'due', 'menu']);

/** Elementos que tratam o próprio clique dentro de uma linha/cartão (o clique não abre o painel). */
const INTERACTIVE = 'button, a, input, textarea, select, label, [data-stop], .inline-edit, [role="checkbox"], [role="switch"]';

const NOUN = Object.freeze({
  task: { one: 'Tarefa', lower: 'tarefa', article: 'a', done: 'concluída' },
  demand: { one: 'Demanda', lower: 'demanda', article: 'a', done: 'concluída' },
});

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

const hasId = (id) => id !== null && id !== undefined && id !== '';
const quoted = (text) => `“${text}”`;
const nameOf = (entity) => (entity && typeof entity.name === 'string' && entity.name.trim() ? entity.name.trim() : 'Sem nome');
const isElement = (value) => value !== null && typeof value === 'object' && value.nodeType === 1;
const isPoint = (value) => value !== null && typeof value === 'object' && Number.isFinite(value.x) && Number.isFinite(value.y);

/** Entidade viva (não excluída) de um tipo; null quando não existe. */
function entityOf(app, type, id) {
  if (!hasId(id)) return null;
  if (type === 'task') return app.sel.task(id);
  if (type === 'demand') return app.sel.demand(id);
  return null;
}

/** Categoria do status de uma entidade ('planned' para status desconhecido). */
function categoryOfEntity(app, entity) {
  return entity ? app.sel.status(entity.status).category : 'planned';
}

/** Âncora utilizável por um seletor: elemento ainda no documento, ponto da tela ou o centro da janela. */
function anchorOf(anchor) {
  if (isElement(anchor) && anchor.isConnected) return anchor;
  if (isPoint(anchor)) return anchor;
  const w = typeof window !== 'undefined' ? window.innerWidth : 800;
  const hgt = typeof window !== 'undefined' ? window.innerHeight : 600;
  return { x: Math.round(w / 2), y: Math.round(hgt / 3) };
}

/** Erro de regra de negócio (CommandError), reconhecido também quando vem de outra cópia do módulo. */
function isCommandError(err) {
  return !!err && typeof err === 'object' && err.name === 'CommandError' && typeof err.code === 'string';
}

/**
 * Mostra um aviso rápido: usa o da casca (app.ui.toast) quando existe, senão o do kit.
 * @param {object} app
 * @param {string} message
 * @param {object} [options] mesmas opções de toast() do kit (tone, action, actions, duration, id) — repassadas sem mudança
 */
export function notify(app, message, options) {
  try {
    if (app && app.ui && typeof app.ui.toast === 'function') return app.ui.toast(message, options);
  } catch (err) {
    console.error('[entity] app.ui.toast falhou; usando o aviso do kit', err);
  }
  return kitToast(message, options);
}

/**
 * Trata um erro vindo de um comando: CommandError vira aviso vermelho com a mensagem do comando; erros
 * inesperados vão para o console e aparecem como uma mensagem genérica.
 * @param {object} app
 * @param {unknown} err
 */
export function handleError(app, err) {
  if (isCommandError(err)) {
    notify(app, err.message, { tone: 'danger', duration: 6000 });
    return;
  }
  console.error('[entity] erro inesperado', err);
  notify(app, 'Não foi possível concluir a ação. Tente de novo.', { tone: 'danger' });
}

/** Executa `fn` tratando erros; devolve o resultado ou null quando falhou. */
function attempt(app, fn) {
  try {
    return fn();
  } catch (err) {
    handleError(app, err);
    return null;
  }
}

/** Versão assíncrona de attempt (fluxos com diálogos). */
async function attemptAsync(app, fn) {
  try {
    return await fn();
  } catch (err) {
    handleError(app, err);
    return null;
  }
}

/** Grava campos de uma demanda/tarefa pelo comando certo e mostra os avisos que ele deixar. */
function update(app, type, id, patch, options) {
  return attempt(app, () => {
    const row = type === 'task' ? app.cmd.updateTask(id, patch, options) : app.cmd.updateDemand(id, patch, options);
    surfaceOutcome(app, app.cmd.lastOutcome(), { type, id });
    return row;
  });
}

/** Status aberto para o qual uma entidade encerrada volta ao ser reaberta (o anterior, pelo histórico). */
function reopenTarget(app, type, entity) {
  const list = app.sel.statuses();
  for (const ev of app.sel.history(type, entity.id)) {
    if (ev.action !== 'status_changed' || ev.new_value !== entity.status) continue;
    const previous = list.find((s) => s.id === ev.old_value);
    if (previous && isOpenCategory(previous.category)) return previous.id;
    break;
  }
  const fallback = firstOfCategory(list, 'active') || firstOfCategory(list, 'planned');
  return fallback ? fallback.id : null;
}

function statusIdOfCategory(app, category) {
  const found = firstOfCategory(app.sel.statuses(), category);
  return found ? found.id : null;
}

/** Fecha o painel lateral se ele mostra esta entidade. */
function closePanelIfShowing(app, type, id) {
  try {
    const ui = app.ui;
    if (!ui || typeof ui.panel !== 'function' || typeof ui.closePanel !== 'function') return;
    const open = ui.panel();
    if (open && open.type === type && open.id === id) ui.closePanel();
  } catch (err) {
    console.error('[entity] não consegui fechar o painel', err);
  }
}

// ---------------------------------------------------------------------------
// Avisos dos comandos
// ---------------------------------------------------------------------------

/**
 * Mostra os avisos (warnings) e a automação de um comando como toasts com ação.
 *   open_subtasks → "Concluir as N subtarefas"; all_subtasks_done → "Concluir a tarefa";
 *   demand_can_complete → "Concluir a demanda"; open_prereqs / open_tasks / demand_is_done → aviso;
 *   autoStartedDemand → "Demanda marcada Em andamento" com "Desfazer".
 * @param {object} app
 * @param {{ warnings?: Array<{code: string, message: string, data?: object}>, autoStartedDemand?: string|null,
 *           autoStartedFrom?: string|null }|null} outcome resultado de setStatus/completeTask ou cmd.lastOutcome()
 * @param {{ type?: 'task'|'demand', id?: string }} [context] entidade que originou o comando
 */
export function surfaceOutcome(app, outcome, context = {}) {
  if (!outcome || typeof outcome !== 'object') return;
  const warnings = Array.isArray(outcome.warnings) ? outcome.warnings : [];
  const { type, id } = context || {};
  for (const warning of warnings) {
    if (!warning || typeof warning !== 'object') continue;
    const data = warning.data && typeof warning.data === 'object' ? warning.data : {};
    switch (warning.code) {
      case 'open_subtasks': {
        if (type !== 'task' || !hasId(id)) {
          notify(app, warning.message, { tone: 'warn' });
          break;
        }
        const count = Number(data.count) || 0;
        const label = count === 1 ? 'Concluir a subtarefa' : `Concluir as ${count} subtarefas`;
        notify(app, warning.message, {
          tone: 'warn',
          duration: 8000,
          action: { label, onclick: () => attempt(app, () => surfaceOutcome(app, app.cmd.completeTask(id, { withSubtasks: true }), { type: 'task', id })) },
        });
        break;
      }
      case 'all_subtasks_done': {
        const parentId = data.parentId;
        notify(app, warning.message, {
          tone: 'success',
          duration: 8000,
          action: hasId(parentId)
            ? { label: 'Concluir a tarefa', onclick: () => attempt(app, () => surfaceOutcome(app, app.cmd.completeTask(parentId), { type: 'task', id: parentId })) }
            : undefined,
        });
        break;
      }
      case 'demand_can_complete': {
        const demandId = data.demandId;
        const doneId = statusIdOfCategory(app, 'done');
        notify(app, warning.message, {
          tone: 'success',
          duration: 8000,
          action:
            hasId(demandId) && doneId
              ? { label: 'Concluir a demanda', onclick: () => attempt(app, () => surfaceOutcome(app, app.cmd.setStatus('demand', demandId, doneId), { type: 'demand', id: demandId })) }
              : undefined,
        });
        break;
      }
      case 'open_prereqs':
      case 'open_tasks':
        notify(app, warning.message, { tone: 'warn', duration: 6000 });
        break;
      default:
        notify(app, warning.message, { duration: 6000 });
    }
  }
  if (hasId(outcome.autoStartedDemand)) {
    const demand = app.sel.demand(outcome.autoStartedDemand);
    const from = outcome.autoStartedFrom;
    const label = demand ? app.sel.status(demand.status).label : 'Em andamento';
    notify(app, `Demanda ${demand ? quoted(nameOf(demand)) + ' ' : ''}marcada ${label}`, {
      duration: 8000,
      action: hasId(from)
        ? { label: 'Desfazer', onclick: () => attempt(app, () => app.cmd.setStatus('demand', outcome.autoStartedDemand, from)) }
        : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Fluxos (status, cronômetro, motivo do bloqueio)
// ---------------------------------------------------------------------------

/**
 * Pergunta (sem bloquear) o motivo do bloqueio / de quem se espera, num popover. Pode ser pulado.
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {string} id
 * @param {'blocked'|'waiting'} category
 * @param {Element|{x: number, y: number}} [anchor]
 * @returns {{ close: Function }|null} o popover aberto
 */
export function askImpediment(app, type, id, category, anchor) {
  const entity = entityOf(app, type, id);
  if (!entity) return null;
  const field = category === 'blocked' ? 'blocked_reason' : 'waiting_on';
  const question = category === 'blocked' ? 'Qual o impedimento?' : 'Aguardando quem ou o quê?';
  let text = typeof entity[field] === 'string' ? entity[field] : '';
  const save = (close) => {
    const current = entityOf(app, type, id);
    close('save');
    if (!current || categoryOfEntity(app, current) !== category) return;
    attempt(app, () => app.cmd.setStatus(type, id, current.status, { [field]: text }));
  };
  return openPopover(
    anchorOf(anchor),
    (close) =>
      h(
        'form',
        {
          class: 'en-reason',
          onsubmit: (ev) => {
            ev.preventDefault();
            save(close);
          },
        },
        h('label', { class: 'en-reason-label' }, icon(category === 'blocked' ? 'ban' : 'hourglass', { size: 14 }), h('span', null, question)),
        textInput({
          value: text,
          autofocus: true,
          placeholder: category === 'blocked' ? 'Ex.: falta acesso ao servidor' : 'Ex.: aprovação do cliente',
          ariaLabel: question,
          oninput: (value) => {
            text = value;
          },
          class: 'en-reason-input',
        }),
        category === 'waiting' ? peopleChips(app, (name) => {
          text = name;
          save(close);
        }) : null,
        h(
          'div',
          { class: 'en-reason-actions' },
          button({ label: 'Pular', size: 'sm', variant: 'ghost', onclick: () => close('skip') }),
          button({ label: 'Salvar', size: 'sm', variant: 'primary', type: 'submit' }),
        ),
      ),
    { class: 'en-reason-popover', ariaLabel: question, width: 300 },
  );
}

/** Máximo de pessoas sugeridas como atalho no "Aguardando quem?". */
const PEOPLE_CHIPS_MAX = 8;

/**
 * Atalhos com as pessoas conhecidas (sel.people()) para preencher "Aguardando quem?" num clique.
 * @param {object} app
 * @param {(name: string) => void} onpick
 * @returns {HTMLElement|null} null quando ainda não há pessoas conhecidas
 */
export function peopleChips(app, onpick) {
  const people = typeof app.sel.people === 'function' ? app.sel.people().slice(0, PEOPLE_CHIPS_MAX) : [];
  if (!people.length) return null;
  return h(
    'div',
    { class: 'en-people', role: 'group', 'aria-label': 'Pessoas conhecidas' },
    people.map((person) =>
      h(
        'button',
        { type: 'button', class: 'en-person-chip', key: person.key, title: `Aguardando ${person.name}`, onclick: () => onpick(person.name) },
        avatar(person.name, { size: 16 }),
        h('span', null, person.name),
      ),
    ),
  );
}

/**
 * Aplica um status (na hora), mostra os avisos e, ao entrar em "Bloqueada"/"Aguardando terceiros",
 * pergunta o impedimento num popover que pode ser pulado.
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {string} id
 * @param {string} statusId
 * @param {{ anchor?: Element|{x: number, y: number}, reason?: string, ask?: boolean }} [options]
 * @returns {object|null} resultado de cmd.setStatus, ou null em caso de erro
 */
export function applyStatus(app, type, id, statusId, { anchor, reason, ask = true } = {}) {
  const result = attempt(app, () => app.cmd.setStatus(type, id, statusId, reason ? { reason } : undefined));
  if (!result) return null;
  surfaceOutcome(app, result, { type, id });
  const category = app.sel.status(statusId).category;
  const changed = !result.transition || result.transition.changed !== false;
  if (ask && changed && (category === 'blocked' || category === 'waiting')) askImpediment(app, type, id, category, anchor);
  return result;
}

/** Texto curto do tempo de um cronômetro. */
function timerText(app, entry) {
  return formatDuration(elapsedSeconds(entry, app.clock.now().getTime()));
}

/** Diálogo "já existe um cronômetro em andamento": resolve 'pause' | 'keep' | null. */
function askTimerConflict(app, running) {
  const list = Array.isArray(running) ? running.filter(Boolean) : [];
  const first = list[0] || null;
  const task = first ? app.store.get('tasks', first.task_id) : null;
  const name = task ? quoted(nameOf(task)) : 'outra tarefa';
  const more = list.length > 1 ? ` e em mais ${plural(list.length - 1, 'tarefa', 'tarefas')}` : '';
  const elapsed = first ? ` (${timerText(app, first)})` : '';
  return new Promise((resolve) => {
    openModal({
      title: 'Cronômetro em andamento',
      class: 'en-timer-conflict',
      body: `Já existe um cronômetro em andamento em ${name}${elapsed}${more}. O que fazer com ele?`,
      actions: [
        { label: 'Cancelar', value: 'cancel' },
        { label: 'Manter os dois', value: 'keep' },
        { label: 'Pausar aquele e iniciar este', variant: 'primary', value: 'pause', autofocus: true },
      ],
      onclose: (result) => resolve(result === 'pause' || result === 'keep' ? result : null),
    });
  });
}

/**
 * Liga o cronômetro de uma tarefa. Se outro estiver rodando, pergunta: pausar aquele, manter os dois ou
 * cancelar. Depois de ligar numa tarefa ainda não iniciada, oferece "Marcar Em andamento".
 * @param {object} app
 * @param {string} taskId
 * @returns {Promise<object|null>} o apontamento ligado, ou null
 */
export async function startTimer(app, taskId) {
  const run = async (others) => {
    try {
      return app.cmd.startTimer(taskId, { others });
    } catch (err) {
      if (isCommandError(err) && err.code === 'timer_running') {
        const choice = await askTimerConflict(app, err.data && err.data.running);
        return choice ? run(choice) : null;
      }
      throw err;
    }
  };
  const result = await attemptAsync(app, () => run('ask'));
  if (!result) return null;
  if (result.suggestStart) {
    const active = firstOfCategory(app.sel.statuses(), 'active');
    notify(app, 'Cronômetro iniciado', {
      duration: 7000,
      action: active ? { label: `Marcar ${active.label}`, onclick: () => applyStatus(app, 'task', taskId, active.id) } : undefined,
    });
  }
  return result.entry || null;
}

/**
 * Retoma um cronômetro pausado (com a mesma pergunta de startTimer se outro estiver rodando).
 * @param {object} app
 * @param {string} entryId
 * @returns {Promise<object|null>}
 */
export async function resumeTimer(app, entryId) {
  const run = async (others) => {
    try {
      return app.cmd.resumeTimer(entryId, { others });
    } catch (err) {
      if (isCommandError(err) && err.code === 'timer_running') {
        const choice = await askTimerConflict(app, err.data && err.data.running);
        return choice ? run(choice) : null;
      }
      throw err;
    }
  };
  return attemptAsync(app, () => run('ask'));
}

/**
 * Encerra um cronômetro perguntando (opcional) "O que foi feito?". Cancelar o diálogo NÃO encerra.
 * @param {object} app
 * @param {string} entryId
 * @returns {Promise<object|null>} o apontamento encerrado, ou null
 */
export async function stopTimer(app, entryId) {
  const entry = app.store.get('time_entries', entryId);
  if (!entry || entry.deleted_at) return null;
  const text = await promptDialog({
    title: 'Encerrar cronômetro',
    label: 'O que foi feito? (opcional)',
    placeholder: 'Descreva rapidamente o trabalho',
    value: entry.description || '',
    confirmLabel: 'Encerrar',
  });
  if (text === null) return null;
  const stopped = attempt(app, () => app.cmd.stopTimer(entryId, { description: text }));
  if (stopped) notify(app, `Tempo registrado: ${formatDuration(stopped.duration_seconds)}`, { tone: 'success' });
  return stopped;
}

// ---------------------------------------------------------------------------
// Ações completas (atalhos, menus e botões usam estas)
// ---------------------------------------------------------------------------

/**
 * Ações de interface sobre uma entidade. Cada função cuida do fluxo completo: pergunta o que for preciso,
 * chama app.cmd.* e mostra avisos (toast). Assinatura comum: (app, type, id, anchorEl?) com
 * type = 'task' | 'demand' — setPriority recebe a prioridade como 4º argumento. Nunca lançam erro.
 */
export const entityActions = Object.freeze({
  /** Abre o painel lateral da entidade. */
  open(app, type, id) {
    if (!app || !app.ui || typeof app.ui.openPanel !== 'function') return;
    attempt(app, () => app.ui.openPanel(type, id));
  },

  /** Conclui (ou reabre, se já encerrada) — tarefas pelos comandos completeTask/reopenTask. */
  complete(app, type, id) {
    const entity = entityOf(app, type, id);
    if (!entity) return null;
    const open = !isClosedCategory(categoryOfEntity(app, entity));
    if (type === 'task') {
      const result = attempt(app, () => (open ? app.cmd.completeTask(id) : app.cmd.reopenTask(id)));
      surfaceOutcome(app, result, { type, id });
      return result;
    }
    const target = open ? statusIdOfCategory(app, 'done') : reopenTarget(app, type, entity);
    return target ? applyStatus(app, type, id, target, { ask: false }) : null;
  },

  /** Grava a prioridade ('P1'…'P4'). */
  setPriority(app, type, id, priority) {
    return attempt(app, () => app.cmd.setPriority(type, id, priority));
  },

  /** Abre o seletor de status e aplica a escolha. */
  async pickStatus(app, type, id, anchor) {
    const entity = entityOf(app, type, id);
    if (!entity) return null;
    const chosen = await kitPickStatus(anchorOf(anchor), { statuses: app.sel.statuses(), current: entity.status });
    if (chosen === null || chosen === entity.status) return null;
    return applyStatus(app, type, id, chosen, { anchor });
  },

  /** Abre o seletor de prioridade (com a sugestão do sistema, quando houver) e aplica a escolha. */
  async pickPriority(app, type, id, anchor) {
    const entity = entityOf(app, type, id);
    if (!entity) return null;
    const suggestion = type === 'task' ? app.sel.suggestionFor(id) : null;
    const chosen = await kitPickPriority(anchorOf(anchor), {
      current: entity.priority,
      suggestion: suggestion ? { priority: suggestion.suggested, text: suggestion.justification } : null,
    });
    if (chosen === null || chosen === entity.priority) return null;
    if (suggestion && chosen === suggestion.suggested) return attempt(app, () => app.cmd.applySuggestion(suggestion));
    return attempt(app, () => app.cmd.setPriority(type, id, chosen));
  },

  /**
   * Abre o calendário do prazo (ou de outro campo de data, com { field }). Quando o item já tinha prazo, pede
   * o "Motivo da alteração" (opcional), que fica no histórico.
   */
  async pickDueDate(app, type, id, anchor, { field = 'due_date' } = {}) {
    const entity = entityOf(app, type, id);
    if (!entity) return null;
    const current = entity[field] || null;
    const isDue = field === 'due_date';
    const picked = await pickDate(anchorOf(anchor), {
      value: current,
      withReason: isDue && !!current,
      today: app.clock.today(),
      title: isDue ? 'Prazo' : field === 'follow_up_date' ? 'Cobrar em' : 'Início planejado',
      clearLabel: isDue ? 'Sem prazo' : 'Sem data',
    });
    if (picked === null || (picked.value || null) === current) return null;
    if (isDue) return attempt(app, () => app.cmd.setDueDate(type, id, picked.value, picked.reason ? { reason: picked.reason } : undefined));
    return update(app, type, id, { [field]: picked.value });
  },

  /** "Cobrei agora": registra a cobrança e agenda a próxima (padrão: 3 dias úteis). */
  logFollowUp(app, type, id, options) {
    const row = attempt(app, () => app.cmd.logFollowUp(type, id, options));
    if (!row) return null;
    const next = row.follow_up_date;
    notify(app, next ? `Cobrança registrada. Próxima cobrança: ${formatDate(next, 'short', app.clock.today())}` : 'Cobrança registrada', { tone: 'success' });
    return row;
  },

  /** "Retomar": sai de "Aguardando terceiros" e volta ao status anterior à espera. */
  resumeWaiting(app, type, id) {
    const result = attempt(app, () => app.cmd.resumeWaiting(type, id));
    if (result) surfaceOutcome(app, result, { type, id });
    return result;
  },

  /**
   * Move o prazo direto para `date` ('AAAA-MM-DD' ou null), sem diálogo — para arrastar entre dias/colunas —
   * e oferece "Desfazer" (volta ao prazo anterior). Mesma data: não faz nada e devolve null.
   */
  moveDueDate(app, type, id, date) {
    const entity = entityOf(app, type, id);
    if (!entity) return null;
    const previous = entity.due_date || null;
    const next = date || null;
    if (previous === next) return null;
    const row = attempt(app, () => app.cmd.setDueDate(type, id, next));
    if (!row) return null;
    surfaceOutcome(app, app.cmd.lastOutcome(), { type, id });
    const text = next ? `Prazo movido para ${formatDate(next, 'short', app.clock.today())}` : 'Prazo removido';
    notify(app, text, {
      duration: 6000,
      action: { label: 'Desfazer', onclick: () => attempt(app, () => app.cmd.setDueDate(type, id, previous)) },
    });
    return row;
  },

  /** Pede o texto e acrescenta uma observação. */
  async addNote(app, type, id) {
    if (!entityOf(app, type, id)) return null;
    const text = await promptDialog({ title: 'Nova observação', label: 'Observação', multiline: true, required: true, confirmLabel: 'Adicionar', hint: 'Ctrl+Enter para salvar' });
    if (text === null) return null;
    const note = attempt(app, () => app.cmd.addNote(type, id, text));
    if (note) notify(app, 'Observação adicionada', { tone: 'success' });
    return note;
  },

  /** Liga, pausa ou retoma o cronômetro da tarefa. */
  async toggleTimer(app, type, id) {
    if (type !== 'task' || !entityOf(app, 'task', id)) return null;
    const entry = app.sel.timerOf(id);
    if (entry && timerState(entry) === TIMER.RUNNING) return attempt(app, () => app.cmd.pauseTimer(entry.id));
    if (entry && timerState(entry) === TIMER.PAUSED) return resumeTimer(app, entry.id);
    return startTimer(app, id);
  },

  /** Duplica (a demanda vai com as tarefas) e oferece abrir a cópia. */
  duplicate(app, type, id) {
    if (!entityOf(app, type, id)) return null;
    const copy = attempt(app, () => (type === 'task' ? app.cmd.duplicateTask(id) : app.cmd.duplicateDemand(id, { withTasks: true })));
    if (copy) {
      notify(app, `${NOUN[type].one} duplicada`, { tone: 'success', action: { label: 'Abrir', onclick: () => entityActions.open(app, type, copy.id) } });
    }
    return copy;
  },

  /** Arquiva ou desarquiva (com Desfazer). */
  archive(app, type, id) {
    const entity = entityOf(app, type, id);
    if (!entity) return null;
    const archived = !entity.archived_at;
    const run = (value) => (type === 'task' ? app.cmd.archiveTask(id, value) : app.cmd.archiveDemand(id, value));
    const row = attempt(app, () => run(archived));
    if (row) {
      notify(app, `${NOUN[type].one} ${archived ? 'arquivada' : 'desarquivada'}`, {
        action: { label: 'Desfazer', onclick: () => attempt(app, () => run(!archived)) },
      });
    }
    return row;
  },

  /**
   * Exclui. Tarefa: na hora, com "Desfazer". Demanda: confirma dizendo quantas tarefas vão junto e depois
   * também oferece "Desfazer".
   */
  async remove(app, type, id) {
    const entity = entityOf(app, type, id);
    if (!entity) return null;
    if (type === 'demand') {
      const count = app.sel.allTasksOfDemand(id).length;
      const ok = await confirmDialog({
        title: 'Excluir demanda?',
        message: count
          ? `A demanda ${quoted(nameOf(entity))} e ${count === 1 ? 'a tarefa dela serão excluídas' : `as ${count} tarefas dela serão excluídas`}. Você poderá desfazer logo em seguida.`
          : `A demanda ${quoted(nameOf(entity))} será excluída. Você poderá desfazer logo em seguida.`,
        confirmLabel: 'Excluir',
        danger: true,
      });
      if (!ok) return null;
    }
    const row = attempt(app, () => (type === 'task' ? app.cmd.deleteTask(id) : app.cmd.deleteDemand(id)));
    if (!row) return null;
    closePanelIfShowing(app, type, id);
    notify(app, `${NOUN[type].one} excluída`, {
      duration: 8000,
      action: { label: 'Desfazer', onclick: () => attempt(app, () => (type === 'task' ? app.cmd.restoreTask(id) : app.cmd.restoreDemand(id))) },
    });
    return row;
  },

  /** Põe a tarefa no plano da semana corrente (com Desfazer). */
  addToWeek(app, type, id) {
    if (type !== 'task' || !entityOf(app, 'task', id)) return null;
    if (app.sel.weekOfTask(id)) {
      notify(app, 'A tarefa já está no plano desta semana');
      return app.sel.weekOfTask(id);
    }
    const item = attempt(app, () => app.cmd.addToWeek(id));
    if (item) {
      notify(app, 'Adicionada à semana', { tone: 'success', action: { label: 'Desfazer', onclick: () => attempt(app, () => app.cmd.removeFromWeek(item.id)) } });
    }
    return item;
  },
});

// ---------------------------------------------------------------------------
// Menu de contexto
// ---------------------------------------------------------------------------

/**
 * Abre o menu de contexto de uma demanda/tarefa, ancorado num elemento ou na posição do mouse.
 * Itens: Abrir, Concluir/Reabrir, Status, Prioridade, Prazo, cronômetro e semana (tarefa), adicionar
 * subtarefa/tarefa, Duplicar, Arquivar/Desarquivar, Cancelar e Excluir.
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {string} id
 * @param {Element|{x: number, y: number}} anchor
 * @param {{ items?: Array<object>|((entity: object) => Array<object>) }} [options] itens extras da tela (mesmo
 *        formato de openMenu), inseridos antes de Duplicar/Arquivar/Excluir
 * @returns {(() => void)|null} função que fecha o menu (null se a entidade não existe)
 */
export function openEntityMenu(app, type, id, anchor, { items: extraItems } = {}) {
  const entity = entityOf(app, type, id);
  if (!entity || (type !== 'task' && type !== 'demand')) return null;
  const status = app.sel.status(entity.status);
  const closed = isClosedCategory(status.category);
  const cancelled = status.category === 'cancelled';
  const cancelId = statusIdOfCategory(app, 'cancelled');
  const later = (fn) => (ev) => fn(isElement(anchor) && anchor.isConnected ? anchor : isPoint(anchor) ? anchor : null, ev);
  const items = [{ label: 'Abrir', icon: 'panel-right', onclick: () => entityActions.open(app, type, id) }];

  items.push(
    { label: closed ? 'Reabrir' : 'Concluir', icon: closed ? 'rotate-ccw' : 'check-circle', onclick: () => entityActions.complete(app, type, id) },
    { separator: true },
    { label: 'Status', icon: statusBadge(status, { compact: true }), hint: status.label, onclick: later((a) => entityActions.pickStatus(app, type, id, a)) },
    { label: 'Prioridade', icon: priorityBadge(entity.priority, { compact: true }), hint: entity.priority || 'P3', onclick: later((a) => entityActions.pickPriority(app, type, id, a)) },
    {
      label: 'Prazo',
      icon: 'calendar',
      hint: entity.due_date ? formatDate(entity.due_date, 'short', app.clock.today()) : 'Sem prazo',
      onclick: later((a) => entityActions.pickDueDate(app, type, id, a)),
    },
  );
  if (type === 'task') {
    const timer = app.sel.timerOf(id);
    const state = timer ? timerState(timer) : null;
    items.push(
      { separator: true },
      {
        label: state === TIMER.RUNNING ? 'Pausar cronômetro' : state === TIMER.PAUSED ? 'Retomar cronômetro' : 'Iniciar cronômetro',
        icon: state === TIMER.RUNNING ? 'pause' : 'play',
        hint: timer ? timerText(app, timer) : null,
        onclick: () => entityActions.toggleTimer(app, 'task', id),
      },
      {
        label: 'Adicionar à semana',
        icon: 'calendar-week',
        disabled: !!app.sel.weekOfTask(id),
        hint: app.sel.weekOfTask(id) ? 'Já está' : null,
        onclick: () => entityActions.addToWeek(app, 'task', id),
      },
    );
    if (!app.sel.parentOf(entity)) {
      items.push({ label: 'Adicionar subtarefa', icon: 'plus', onclick: () => quickCreate(app, 'task', { parent_id: id }) });
    }
  } else {
    items.push({ separator: true }, { label: 'Adicionar tarefa', icon: 'plus', onclick: () => quickCreate(app, 'task', { demand_id: id }) });
  }
  let extra = [];
  try {
    extra = typeof extraItems === 'function' ? extraItems(entity) : extraItems;
  } catch (err) {
    console.error('[entity] itens extras do menu falharam', err);
  }
  if (Array.isArray(extra) && extra.some(Boolean)) items.push({ separator: true }, ...extra.filter(Boolean), { separator: true });
  items.push(
    { label: 'Duplicar', icon: 'copy', onclick: () => entityActions.duplicate(app, type, id) },
    { label: entity.archived_at ? 'Desarquivar' : 'Arquivar', icon: 'archive', onclick: () => entityActions.archive(app, type, id) },
    { separator: true },
  );
  if (!cancelled && cancelId) {
    items.push({ label: 'Cancelar', icon: 'x-circle', description: 'Marca como cancelada (fora do progresso)', onclick: () => applyStatus(app, type, id, cancelId, { ask: false }) });
  }
  items.push({ label: 'Excluir', icon: 'trash', danger: true, onclick: () => entityActions.remove(app, type, id) });

  return openMenu(isElement(anchor) || isPoint(anchor) ? anchor : anchorOf(anchor), items, {
    title: `${app.sel.code(type, entity) || NOUN[type].one} · ${truncate(nameOf(entity), 40)}`,
    minWidth: 240,
    class: 'en-menu',
  });
}

/** Criação rápida pela casca (app.ui.quickCreate); sem casca, cria direto com um nome pedido. */
function quickCreate(app, type, defaults) {
  if (app.ui && typeof app.ui.quickCreate === 'function') {
    attempt(app, () => app.ui.quickCreate(type, defaults));
    return;
  }
  promptDialog({ title: defaults && defaults.parent_id ? 'Nova subtarefa' : 'Nova tarefa', label: 'Nome', required: true, confirmLabel: 'Criar' }).then((name) => {
    if (name === null) return;
    attempt(app, () => app.cmd.createTask({ ...defaults, name }));
  });
}

// ---------------------------------------------------------------------------
// Atributos, título e controles
// ---------------------------------------------------------------------------

/**
 * Props para espalhar numa linha/cartão de entidade: identidade (key), data-entity="tipo:id" (usado pelos
 * atalhos e pelo menu de contexto) e classes de estado. Combine as classes com as suas:
 *   const a = entityAttrs(app, 'task', t);  h('div', { ...a, class: cx('minha-linha', a.class) }, …)
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object|null} entity
 * @returns {{ key?: string, dataset?: { entity: string }, class: { 'is-done': boolean, 'is-cancelled': boolean,
 *            'is-archived': boolean, 'is-blocked': boolean } }}
 */
export function entityAttrs(app, type, entity) {
  if (!entity || !hasId(entity.id)) return { class: {} };
  const category = categoryOfEntity(app, entity);
  const open = !isClosedCategory(category);
  return {
    key: entity.id,
    dataset: { entity: `${type}:${entity.id}` },
    class: {
      'is-done': category === 'done',
      'is-cancelled': category === 'cancelled',
      'is-archived': !entity.deleted_at && app.sel.isHidden(type, entity),
      'is-blocked': open && (category === 'blocked' || (type === 'task' && app.sel.isBlockedByDependency(entity.id))),
    },
  };
}

/**
 * Título de uma entidade: código (T-12) + nome; riscado e esmaecido quando concluída/cancelada.
 * Clicar abre o painel (ou chama `onclick`). Com `editable`, o nome é editado no lugar e salvo pelo comando.
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @param {{ onclick?: (entity: object, ev: MouseEvent) => void, showCode?: boolean, editable?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function entityTitle(app, type, entity, { onclick, showCode = true, editable = false } = {}) {
  if (!entity) return h('span', { class: 'en-title is-missing' }, 'Item não encontrado');
  const category = categoryOfEntity(app, entity);
  const code = showCode ? app.sel.code(type, entity) : '';
  const classes = cx('en-title', { 'is-closed': isClosedCategory(category), 'is-done': category === 'done', 'is-cancelled': category === 'cancelled' });
  const codeNode = code ? h('span', { class: 'en-code tabular' }, code) : null;
  if (editable) {
    return h(
      'div',
      { class: cx(classes, 'is-editable') },
      codeNode,
      inlineEdit({
        value: entity.name,
        ariaLabel: `Nome da ${NOUN[type] ? NOUN[type].lower : 'tarefa'}`,
        placeholder: 'Sem nome',
        class: 'en-name-edit',
        onsave: (name) => update(app, type, entity.id, { name }),
      }),
    );
  }
  return h(
    'button',
    {
      type: 'button',
      class: classes,
      title: nameOf(entity),
      onclick: (ev) => {
        ev.stopPropagation();
        if (typeof onclick === 'function') onclick(entity, ev);
        else entityActions.open(app, type, entity.id);
      },
    },
    codeNode,
    h('span', { class: 'en-name' }, nameOf(entity)),
  );
}

/**
 * Caixa redonda que conclui / reabre a tarefa num clique. Em tarefas em andamento, aguardando, bloqueadas ou
 * em revisão mostra o ícone do status (na cor dele).
 * @param {object} app
 * @param {object} task
 * @param {{ size?: 'sm'|'md' }} [options]
 * @returns {HTMLButtonElement}
 */
export function checkControl(app, task, { size = 'md' } = {}) {
  if (!task) return h('span', { class: 'en-check is-placeholder', 'aria-hidden': 'true' });
  const status = app.sel.status(task.status);
  const done = status.category === 'done';
  const cancelled = status.category === 'cancelled';
  const inFlight = isInFlightCategory(status.category);
  const color = STATUS_COLORS.includes(status.color) ? status.color : 'gray';
  const glyphSize = size === 'sm' ? 10 : 12;
  let glyph = null;
  if (done) glyph = icon('check', { size: glyphSize });
  else if (cancelled) glyph = icon('x', { size: glyphSize });
  else if (inFlight) glyph = icon(STATUS_ICONS[status.category] || 'circle', { size: size === 'sm' ? 14 : 16 });
  const label = done || cancelled ? `Reabrir ${quoted(nameOf(task))}` : `Concluir ${quoted(nameOf(task))}`;
  return h(
    'button',
    {
      type: 'button',
      role: 'checkbox',
      class: cx('en-check', `en-check-${color}`, size === 'sm' && 'en-check-sm', { 'is-checked': done, 'is-cancelled': cancelled, 'is-inflight': inFlight }),
      'aria-checked': done,
      'aria-label': label,
      title: done ? 'Reabrir' : cancelled ? `${status.label} — clique para reabrir` : inFlight ? `${status.label} — clique para concluir` : 'Concluir',
      'data-stop': true,
      onclick: (ev) => {
        ev.stopPropagation();
        entityActions.complete(app, 'task', task.id);
      },
    },
    glyph,
  );
}

/**
 * Selo de status que abre o seletor (e aplica cmd.setStatus com os avisos).
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @param {{ compact?: boolean, readonly?: boolean, soft?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function statusControl(app, type, entity, { compact = false, readonly = false, soft = false } = {}) {
  const status = app.sel.status(entity ? entity.status : null);
  if (readonly || !entity) return statusBadge(status, { compact, soft, class: 'en-status' });
  return statusBadge(status, {
    compact,
    soft,
    class: 'en-status',
    title: compact ? `Status: ${status.label} — clique para alterar` : 'Alterar status',
    onclick: (ev) => {
      ev.stopPropagation();
      entityActions.pickStatus(app, type, entity.id, ev.currentTarget);
    },
  });
}

/**
 * Selo de prioridade que abre o seletor; quando o sistema tem uma sugestão para a tarefa, ela aparece como
 * dica dentro do seletor (e um pontinho marca o selo).
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @param {{ compact?: boolean, showLabel?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function priorityControl(app, type, entity, { compact = false, showLabel = false } = {}) {
  if (!entity) return priorityBadge(null, { compact });
  const suggestion = type === 'task' && app.sel.isOpen(entity) ? app.sel.suggestionFor(entity.id) : null;
  return priorityBadge(entity.priority, {
    compact,
    showLabel,
    class: cx('en-priority', suggestion && 'has-suggestion'),
    onclick: (ev) => {
      ev.stopPropagation();
      entityActions.pickPriority(app, type, entity.id, ev.currentTarget);
    },
  });
}

/** Botão de data vazia ("Sem prazo", "Definir data"). */
function emptyDateButton(text, onclick, compact) {
  return h(
    'button',
    { type: 'button', class: cx('deadline', 'deadline-muted', 'is-empty', 'en-due', compact && 'is-compact'), title: text, 'aria-label': text, onclick },
    icon('calendar', { size: 14, class: 'deadline-icon' }),
    compact ? null : h('span', { class: 'deadline-text' }, text),
  );
}

/**
 * Prazo (ou outro campo de data) com o calendário. Quando o item já tinha prazo, o calendário pede um
 * "Motivo da alteração" opcional, gravado no histórico.
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @param {{ field?: 'due_date'|'planned_start', compact?: boolean, placeholder?: string }} [options]
 * @returns {HTMLElement}
 */
export function dueControl(app, type, entity, { field = 'due_date', compact = false, placeholder } = {}) {
  if (!entity) return emptyDateButton(placeholder || 'Sem prazo', null, compact);
  const value = entity[field] || null;
  const onclick = (ev) => {
    ev.stopPropagation();
    entityActions.pickDueDate(app, type, entity.id, ev.currentTarget, { field });
  };
  if (!value) {
    if (compact && !placeholder) return deadlineChip(null, { onclick, class: cx('en-due', 'is-compact') });
    return emptyDateButton(placeholder || (field === 'due_date' ? 'Sem prazo' : 'Sem data'), onclick, compact);
  }
  if (field === 'due_date') return deadlineChip(app.sel.deadline(entity), { onclick, class: cx('en-due', compact && 'is-compact') });
  return h(
    'button',
    { type: 'button', class: cx('deadline', 'deadline-muted', 'en-due', 'en-date', compact && 'is-compact'), title: formatDate(value, 'long'), onclick },
    icon('calendar', { size: 14, class: 'deadline-icon' }),
    h('span', { class: 'deadline-text tabular' }, formatDate(value, 'short', app.clock.today())),
  );
}

/**
 * "Cobrar em": chip com a data (vermelho se vencida, âmbar se hoje) que abre o calendário.
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @param {{ compact?: boolean, placeholder?: string }} [options]
 * @returns {HTMLElement}
 */
export function followUpControl(app, type, entity, { compact = false, placeholder = 'Sem data' } = {}) {
  const onclick = (ev) => {
    ev.stopPropagation();
    if (entity) entityActions.pickDueDate(app, type, entity.id, ev.currentTarget, { field: 'follow_up_date' });
  };
  const value = entity ? entity.follow_up_date || null : null;
  if (!value) return emptyDateButton(placeholder, entity ? onclick : null, compact);
  const today = app.clock.today();
  const info = followUpInfo(value, today);
  const tone = info.tone === 'danger' ? 'deadline-danger' : info.tone === 'warn' ? 'deadline-warn' : 'deadline-muted';
  return h(
    'button',
    { type: 'button', class: cx('deadline', tone, 'en-due', 'en-followup', compact && 'is-compact'), title: `Cobrar em ${formatDate(value, 'long')} — ${info.label}`, onclick, dataset: { state: info.state } },
    icon('bell', { size: 14, class: 'deadline-icon' }),
    h('span', { class: 'deadline-text tabular' }, formatDate(value, 'short', today)),
  );
}

/** O painel deve mostrar "Cobrar em"? (aguardando terceiros, responsável é outra pessoa, ou já tem data) */
export function showsFollowUp(app, entity) {
  if (!entity) return false;
  if (entity.follow_up_date) return true;
  const category = categoryOfEntity(app, entity);
  if (isClosedCategory(category)) return false;
  return category === 'waiting' || isOtherOwner(entity.owner, app.settings.get('owner.default'));
}

/**
 * Responsável: avatar + nome, que abre a lista de responsáveis em uso (com "Sem responsável" e criação).
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @returns {HTMLElement}
 */
export function ownerControl(app, type, entity) {
  if (!entity) return h('span', { class: 'en-empty-value' }, '—');
  const onclick = async (ev) => {
    ev.stopPropagation();
    const anchor = ev.currentTarget;
    const owners = [...app.sel.owners()];
    const fallback = app.settings.get('owner.default');
    if (typeof fallback === 'string' && fallback.trim() && !owners.some((o) => o.toLowerCase() === fallback.trim().toLowerCase())) owners.unshift(fallback.trim());
    const chosen = await pickFromList(anchor, {
      items: owners.map((name) => ({ id: name, label: name, icon: avatar(name, { size: 16 }) })),
      current: entity.owner || null,
      allowEmpty: true,
      emptyLabel: 'Sem responsável',
      placeholder: 'Buscar ou digitar um nome…',
      title: 'Responsável',
      create: { label: (text) => `Usar ${quoted(text)}`, oncreate: (text) => text.trim() },
    });
    if (chosen === null) return;
    update(app, type, entity.id, { owner: chosen === EMPTY_CHOICE ? null : chosen });
  };
  const chip = ownerChip(entity.owner, { onclick, class: 'en-owner' });
  if (chip) return chip;
  return h('button', { type: 'button', class: 'owner en-owner is-empty', onclick, title: 'Definir responsável' }, icon('user', { size: 14 }), h('span', { class: 'owner-name' }, 'Sem responsável'));
}

/**
 * Estimativa em texto livre ("1h30", "45min"), salva ao confirmar.
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @returns {HTMLElement}
 */
export function estimateControl(app, type, entity) {
  return durationInput({
    minutes: entity ? entity.estimate_minutes : null,
    size: 'sm',
    ariaLabel: 'Estimativa',
    placeholder: 'ex.: 2h',
    class: 'en-estimate',
    disabled: !entity,
    onchange: (minutes) => {
      if (entity) update(app, type, entity.id, { estimate_minutes: minutes });
    },
  });
}

/**
 * Etiquetas: lista com "x" para remover e um botão que abre o seletor (marca/desmarca e cria novas).
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @returns {HTMLElement}
 */
export function tagsControl(app, type, entity) {
  const tags = entity && Array.isArray(entity.tags) ? entity.tags.filter((t) => typeof t === 'string' && t.trim()) : [];
  const edit = async (ev) => {
    ev.stopPropagation();
    if (!entity) return;
    const next = await pickTags(ev.currentTarget, { tags, all: app.sel.tags() });
    if (next !== null) update(app, type, entity.id, { tags: next });
  };
  return h(
    'div',
    { class: 'en-tags' },
    tagList(tags, { onremove: (tag) => entity && update(app, type, entity.id, { tags: tags.filter((t) => t !== tag) }) }),
    tags.length
      ? iconButton({ icon: 'plus', title: 'Editar tags', size: 'sm', onclick: edit, class: 'en-tags-add' })
      : button({ label: 'Adicionar tag', icon: 'tag', size: 'sm', variant: 'ghost', onclick: edit, class: 'en-tags-add' }),
  );
}

/** Ponto colorido de um projeto (cor do projeto mapeada para os tons de status). */
export function projectDot(project) {
  const color = project && STATUS_COLORS.includes(project.color) ? project.color : project ? 'blue' : 'gray';
  return h('span', { class: cx('en-dot', `en-dot-${color}`), 'aria-hidden': 'true' });
}

/**
 * Projeto de uma demanda (ponto colorido + nome), que abre a lista de projetos.
 * @param {object} app
 * @param {object} demand
 * @param {{ compact?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function projectControl(app, demand, { compact = false } = {}) {
  const project = demand ? app.sel.project(demand.project_id) : null;
  const onclick = async (ev) => {
    ev.stopPropagation();
    if (!demand) return;
    const chosen = await pickFromList(ev.currentTarget, {
      items: app.sel.projects().map((p) => ({ id: p.id, label: p.name, hint: p.code || null, icon: projectDot(p) })),
      current: project ? project.id : null,
      allowEmpty: true,
      emptyLabel: 'Sem projeto',
      placeholder: 'Buscar projeto…',
      title: 'Projeto',
    });
    if (chosen === null) return;
    update(app, 'demand', demand.id, { project_id: chosen === EMPTY_CHOICE ? null : chosen });
  };
  return h(
    'button',
    { type: 'button', class: cx('en-picker', 'en-project', !project && 'is-empty', compact && 'is-compact'), onclick, title: project ? `Projeto: ${project.name}` : 'Definir projeto' },
    projectDot(project),
    h('span', { class: 'en-picker-text' }, project ? project.name : 'Sem projeto'),
  );
}

/**
 * Demanda de uma tarefa (código + nome), que abre a lista de demandas para mover a tarefa.
 * @param {object} app
 * @param {object} task
 * @returns {HTMLElement}
 */
export function demandControl(app, task) {
  const demand = task ? app.sel.demandOf(task) : null;
  const onclick = async (ev) => {
    ev.stopPropagation();
    if (!task) return;
    const projects = app.sel.projectsById();
    const chosen = await pickFromList(ev.currentTarget, {
      items: app.sel.demands().map((d) => {
        const p = hasId(d.project_id) ? projects.get(d.project_id) : null;
        return { id: d.id, label: d.name, hint: app.sel.code('demand', d), group: p ? p.name : 'Sem projeto', icon: projectDot(p) };
      }),
      current: demand ? demand.id : null,
      allowEmpty: true,
      emptyLabel: 'Sem demanda (tarefa avulsa)',
      placeholder: 'Buscar demanda…',
      title: 'Mover para a demanda',
      width: 320,
    });
    if (chosen === null) return;
    const target = chosen === EMPTY_CHOICE ? null : chosen;
    if ((demand ? demand.id : null) === target) return;
    attempt(app, () => app.cmd.moveTask(task.id, { demand_id: target }));
  };
  return h(
    'button',
    { type: 'button', class: cx('en-picker', 'en-demand', !demand && 'is-empty'), onclick, title: demand ? `Demanda: ${demand.name}` : 'Mover para uma demanda' },
    icon('layers', { size: 14 }),
    demand ? h('span', { class: 'en-code tabular' }, app.sel.code('demand', demand)) : null,
    h('span', { class: 'en-picker-text' }, demand ? demand.name : 'Sem demanda'),
  );
}

/**
 * Resumo do progresso de uma demanda para dicas e cabeçalhos.
 * @param {object} app
 * @param {string} demandId
 * @returns {{ progress: object, summary: string, details: string[], weightText: string }}
 */
export function progressSummary(app, demandId) {
  const progress = app.sel.demandProgress(demandId);
  const details = [];
  if (progress.cancelled) details.push(plural(progress.cancelled, 'cancelada', 'canceladas'));
  if (progress.archived) details.push(plural(progress.archived, 'arquivada', 'arquivadas'));
  if (progress.optional) details.push(plural(progress.optional, 'opcional', 'opcionais'));
  const summary = progress.counted ? `${progress.completed} de ${plural(progress.counted, 'tarefa', 'tarefas')}` : 'Sem tarefas contáveis';
  let weightText = '';
  if (progress.warning) {
    const statuses = app.sel.statuses();
    const countable = app.sel.topTasks(demandId).filter((t) => isCountable(t, statuses));
    weightText = weightWarningText(progress.warning, effectiveWeights(countable).total);
  }
  return { progress, summary, details, weightText };
}

/**
 * Barra de progresso de uma demanda com o percentual e a dica "4 de 6 tarefas · 1 cancelada"; sem tarefas
 * contáveis mostra "—"; um alerta pequeno marca pesos que não somam 100%.
 * @param {object} app
 * @param {object} demand
 * @param {{ compact?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function progressControl(app, demand, { compact = false } = {}) {
  if (!demand) return h('span', { class: 'en-progress is-empty' }, '—');
  const { progress, summary, details, weightText } = progressSummary(app, demand.id);
  const tip = [summary, ...details].join(' · ') + (weightText ? `\n${weightText}` : '');
  return h(
    'span',
    { class: cx('en-progress', compact && 'is-compact', progress.value === null && 'is-empty'), title: tip, 'aria-label': `Progresso: ${progress.percent === null ? 'sem tarefas contáveis' : progress.percent + '%'} — ${tip}` },
    progressBar(progress.value, { size: 'sm', title: tip }),
    progress.percent === null ? null : h('span', { class: 'en-progress-pct tabular' }, `${progress.percent}%`),
    weightText ? h('span', { class: 'en-progress-warn', title: weightText }, icon('alert-triangle', { size: 12 })) : null,
  );
}

// ---------------------------------------------------------------------------
// Cronômetro
// ---------------------------------------------------------------------------

/** Elementos com o tempo corrente de um cronômetro → app (atualizados a cada segundo, só o texto). */
const ticking = new Map();
let tickHandle = 0;

/** Segundos → '12:05' ou '1:02:05'. */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

function tick() {
  for (const [el, app] of ticking) {
    if (!el.isConnected) {
      ticking.delete(el);
      continue;
    }
    const entry = app.store.get('time_entries', el.getAttribute('data-entry'));
    if (!entry || entry.deleted_at) continue;
    const text = formatClock(elapsedSeconds(entry, app.clock.now().getTime()));
    if (el.textContent !== text) el.textContent = text;
  }
  if (ticking.size === 0 && tickHandle) {
    clearInterval(tickHandle);
    tickHandle = 0;
  }
}

function registerTick(el, app) {
  ticking.set(el, app);
  if (!tickHandle) tickHandle = setInterval(tick, 1000);
}

/**
 * Tempo corrente de um apontamento, atualizado a cada segundo (só o texto muda; nada é re-renderizado).
 * @param {object} app
 * @param {object} entry linha de time_entries
 * @param {{ class?: string }} [options]
 * @returns {HTMLSpanElement}
 */
export function liveElapsed(app, entry, { class: className } = {}) {
  const running = timerState(entry) === TIMER.RUNNING;
  return h(
    'span',
    {
      class: cx('en-timer-elapsed', 'tabular', running && 'is-running', className),
      'data-entry': entry.id,
      ref: running ? (el) => registerTick(el, app) : null,
    },
    formatClock(elapsedSeconds(entry, app.clock.now().getTime())),
  );
}

/**
 * Cronômetro de uma tarefa: iniciar / pausar / retomar / encerrar, com o tempo corrente.
 * Com `entry`, o controle fica preso àquele apontamento (listas de apontamentos): pausa/retoma/encerra ele, e
 * não o cronômetro "da tarefa" (app.sel.timerOf). Apontamento encerrado ou de outra tarefa vira "nenhum".
 * @param {object} app
 * @param {object} task
 * @param {{ compact?: boolean, size?: 'md'|'lg', entry?: object }} [options]
 * @returns {HTMLElement}
 */
export function timerControl(app, task, { compact = false, size = 'md', entry: fixedEntry } = {}) {
  if (!task) return h('span', { class: 'en-timer is-none' });
  const bound = !!fixedEntry && typeof fixedEntry === 'object';
  const live = bound ? app.store.get('time_entries', fixedEntry.id) || fixedEntry : null;
  const entry = bound ? (live && !live.deleted_at && live.task_id === task.id && timerState(live) !== TIMER.DONE ? live : null) : app.sel.timerOf(task.id);
  const state = entry ? timerState(entry) : 'none';
  const large = size === 'lg';
  const btnSize = large ? 'md' : 'sm';
  const toggle = (ev) => {
    ev.stopPropagation();
    if (!bound || !entry) {
      entityActions.toggleTimer(app, 'task', task.id);
      return;
    }
    if (state === TIMER.RUNNING) attempt(app, () => app.cmd.pauseTimer(entry.id));
    else resumeTimer(app, entry.id);
  };
  const stop = (ev) => {
    ev.stopPropagation();
    if (entry) stopTimer(app, entry.id);
  };
  const parts = [];
  if (state === 'none') {
    parts.push(
      compact
        ? iconButton({ icon: 'play', title: 'Iniciar cronômetro', size: btnSize, onclick: toggle, class: 'en-timer-play' })
        : button({ label: large ? 'Iniciar cronômetro' : 'Iniciar', icon: 'play', size: btnSize, variant: large ? 'primary' : 'default', onclick: toggle, class: 'en-timer-play' }),
    );
  } else {
    parts.push(
      state === TIMER.RUNNING
        ? iconButton({ icon: 'pause', title: 'Pausar cronômetro', size: btnSize, variant: large ? 'default' : 'ghost', onclick: toggle, class: 'en-timer-pause' })
        : iconButton({ icon: 'play', title: 'Retomar cronômetro', size: btnSize, variant: large ? 'primary' : 'ghost', onclick: toggle, class: 'en-timer-play' }),
      liveElapsed(app, entry),
      iconButton({ icon: 'stop', title: 'Encerrar cronômetro', size: btnSize, variant: large ? 'default' : 'ghost', onclick: stop, class: 'en-timer-stop' }),
    );
  }
  return h(
    'span',
    {
      class: cx('en-timer', `is-${state}`, compact && 'is-compact', large && 'en-timer-lg'),
      'data-stop': true,
      title: state === TIMER.PAUSED ? 'Cronômetro pausado' : state === TIMER.RUNNING ? 'Cronômetro em andamento' : null,
    },
    parts,
  );
}

// ---------------------------------------------------------------------------
// Indicadores (flags)
// ---------------------------------------------------------------------------

function flag(glyph, text, { tone = 'neutral', title } = {}) {
  return h('span', { class: cx('en-flag', `en-flag-${tone}`), title: title || text }, icon(glyph, { size: 12 }), text === '' ? null : h('span', { class: 'en-flag-text' }, text));
}

/**
 * Pequenos indicadores, só quando relevantes: cadeado "Bloqueada por “X”", motivo do bloqueio, de quem se
 * espera, conflito de prazo (dica com as mensagens), subtarefas concluídas/total, observações, tempo apontado ×
 * estimativa e "Sem demanda".
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @param {{ hideNoDemand?: boolean, hideTime?: boolean }} [options] hideTime: sem o tempo apontado (telas que já
 *        mostram o tempo numa coluna própria)
 * @returns {HTMLElement|null} null quando não há nada a mostrar
 */
export function entityFlags(app, type, entity, { hideNoDemand = false, hideTime = false } = {}) {
  if (!entity) return null;
  const chips = [];
  const category = categoryOfEntity(app, entity);
  const open = !isClosedCategory(category);
  if (type === 'task' && open) {
    const blockers = app.sel.blockers(entity.id);
    if (blockers.length) {
      const names = blockers.map((t) => quoted(nameOf(t))).join(', ');
      chips.push(flag('lock', blockers.length === 1 ? `Bloqueada por ${quoted(truncate(nameOf(blockers[0]), 28))}` : `Bloqueada por ${blockers.length} tarefas`, { tone: 'danger', title: `Pré-requisitos em aberto: ${names}` }));
    }
  }
  if (open && category === 'blocked' && entity.blocked_reason) {
    chips.push(flag('ban', truncate(entity.blocked_reason, 32), { tone: 'danger', title: `Impedimento: ${entity.blocked_reason}` }));
  }
  if (open && category === 'waiting' && entity.waiting_on) {
    chips.push(flag('hourglass', truncate(entity.waiting_on, 32), { tone: 'warning', title: `Aguardando: ${entity.waiting_on}` }));
  }
  if (type === 'task' && open) {
    const conflicts = app.sel.conflictsOf(entity.id);
    if (conflicts.length) {
      const severe = conflicts.some((c) => c.severity === 'danger');
      chips.push(
        flag('alert-triangle', conflicts.length === 1 ? 'Conflito de prazo' : `${conflicts.length} conflitos de prazo`, {
          tone: severe ? 'danger' : 'warning',
          title: conflicts.map((c) => c.message).join('\n'),
        }),
      );
    }
  }
  if (type === 'task') {
    const statuses = app.sel.statuses();
    const subs = app.sel.subtasks(entity.id).filter((s) => isCountable(s, statuses));
    if (subs.length) {
      const done = subs.filter((s) => app.sel.status(s.status).category === 'done').length;
      chips.push(flag('list', `${done}/${subs.length}`, { tone: done === subs.length ? 'success' : 'neutral', title: `${done} de ${plural(subs.length, 'subtarefa concluída', 'subtarefas concluídas')}` }));
    }
  }
  const notes = app.sel.notes(type, entity.id).length;
  if (notes) chips.push(flag('message', String(notes), { title: plural(notes, 'observação', 'observações') }));
  if (type === 'task') {
    const tracked = hideTime ? 0 : app.sel.trackedSeconds(entity.id);
    if (tracked > 0) {
      const cmp = estimateVsActual(entity.estimate_minutes, tracked);
      const estimate = cmp.state === 'none' ? '' : ` / ${formatDurationText(entity.estimate_minutes)}`;
      chips.push(
        flag('clock', `${formatDuration(tracked)}${estimate}`, {
          tone: cmp.state === 'over' ? 'warning' : 'neutral',
          title: cmp.state === 'none' ? `Tempo apontado: ${formatDuration(tracked)}` : `Tempo apontado: ${formatDuration(tracked)} · estimativa: ${formatDurationText(entity.estimate_minutes)}`,
        }),
      );
    }
    if (!hideNoDemand && !app.sel.demandOf(entity) && !app.sel.parentOf(entity)) chips.push(flag('inbox', 'Sem demanda', { tone: 'muted', title: 'Tarefa avulsa (sem demanda)' }));
  }
  return chips.length ? h('span', { class: 'en-flags' }, chips) : null;
}

// ---------------------------------------------------------------------------
// Criação em linha
// ---------------------------------------------------------------------------

/**
 * Linha "+ Adicionar tarefa": digitar o nome + Enter cria pelo comando e mantém o foco no campo para a
 * próxima; Esc limpa.
 * @param {object} app
 * @param {{ type?: 'task'|'demand', defaults?: object, placeholder?: string, onCreated?: (row: object) => void,
 *           class?: string }} [options] defaults vão para createTask/createDemand (ex.: { demand_id } ou { parent_id })
 * @returns {HTMLDivElement}
 */
export function quickAddRow(app, { type = 'task', defaults = {}, placeholder, onCreated, class: className } = {}) {
  const text = placeholder || (type === 'demand' ? 'Adicionar demanda' : 'Adicionar tarefa');
  const create = (input) => {
    const name = input.value.trim();
    if (!name) return;
    const row = attempt(app, () => (type === 'demand' ? app.cmd.createDemand({ ...defaults, name }) : app.cmd.createTask({ ...defaults, name })));
    if (!row) return;
    surfaceOutcome(app, app.cmd.lastOutcome(), { type, id: row.id });
    input.value = '';
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    if (typeof onCreated === 'function') {
      try {
        onCreated(row);
      } catch (err) {
        console.error('[entity] onCreated falhou', err);
      }
    }
  };
  return h(
    'label',
    { class: cx('en-quickadd', className), 'data-stop': true },
    icon('plus', { size: 14, class: 'en-quickadd-icon' }),
    h('input', {
      class: 'en-quickadd-input',
      type: 'text',
      placeholder: text,
      'aria-label': text,
      autocomplete: 'off',
      enterkeyhint: 'done',
      onkeydown: (ev) => {
        if (ev.isComposing) return;
        const input = ev.currentTarget;
        if (ev.key === 'Enter') {
          ev.preventDefault();
          ev.stopPropagation();
          create(input);
        } else if (ev.key === 'Escape' && input.value !== '') {
          ev.preventDefault();
          ev.stopPropagation();
          input.value = '';
        }
      },
    }),
    h('span', { class: 'en-quickadd-hint', 'aria-hidden': 'true' }, 'Enter'),
  );
}

// ---------------------------------------------------------------------------
// Linhas e cartões
// ---------------------------------------------------------------------------

/**
 * O clique saiu de um controle dentro de `row`? Usa o caminho do evento (composedPath), registrado no disparo:
 * um controle que troca o próprio conteúdo durante o clique (ex.: inlineEdit vira campo) deixa o alvo fora do
 * documento, e aí ev.target.closest() não encontraria mais o controle.
 */
function clickedControl(ev, row) {
  const path = typeof ev.composedPath === 'function' ? ev.composedPath() : [];
  if (path.length) {
    for (const node of path) {
      if (node === row) return false;
      if (isElement(node) && node.matches(INTERACTIVE)) return true;
    }
    return false;
  }
  const hit = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest(INTERACTIVE) : null;
  return !!hit && hit !== row && row.contains(hit);
}

/** Clique no corpo de uma linha/cartão: abre (ou chama onclick), a menos que o alvo seja um controle. */
function bodyClick(handler) {
  return (ev) => {
    if (clickedControl(ev, ev.currentTarget)) return;
    handler(ev);
  };
}

function bodyKeydown(handler) {
  return (ev) => {
    if (ev.target !== ev.currentTarget || (ev.key !== 'Enter' && ev.key !== ' ')) return;
    ev.preventDefault();
    handler(ev);
  };
}

/** Roda primeiro o tratador da tela e depois o padrão, a menos que a tela tenha chamado preventDefault. */
function chain(own, fallback) {
  if (typeof own !== 'function') return fallback;
  return (ev) => {
    own(ev);
    if (!ev.defaultPrevented) fallback(ev);
  };
}

/**
 * Props do elemento de uma linha/cartão: `attrs` da tela + identidade (entityAttrs) + comportamento padrão.
 * A tela pode trocar o tabindex (ex.: roving tabindex com -1), acrescentar estilo e tratar onclick/onkeydown
 * antes do padrão (preventDefault cancela o padrão).
 */
function hostProps(extra, base, { className, style, open }) {
  let merged = extra.style !== undefined ? extra.style : null;
  if (style) {
    if (typeof merged === 'string') merged = `${merged};${Object.entries(style).map(([k, v]) => `${k}:${v}`).join(';')}`;
    else merged = { ...(merged && typeof merged === 'object' ? merged : {}), ...style };
  }
  return {
    ...extra,
    ...base,
    class: className,
    style: merged,
    tabindex: extra.tabindex !== undefined && extra.tabindex !== null ? extra.tabindex : 0,
    onclick: chain(extra.onclick, bodyClick(open)),
    onkeydown: chain(extra.onkeydown, bodyKeydown(open)),
  };
}

/**
 * Agrupa as células de uma linha: as que vêm antes do título (alça, caixa…) ficam à esquerda; título e
 * controles ficam num "corpo" (que no celular quebra em duas linhas); o menu final fica à direita.
 */
function rowChildren(columns, cells) {
  const titleIndex = columns.findIndex((c) => c === 'title' || c === 'title-edit');
  if (titleIndex < 0) return cells;
  const lastIndex = columns.length - 1;
  const lead = [];
  const body = [];
  const trail = [];
  cells.forEach((cell, index) => {
    if (index < titleIndex) lead.push(cell);
    else if (index === lastIndex && columns[index] === 'menu') trail.push(cell);
    else body.push(cell);
  });
  return [lead, h('div', { class: 'en-row-body' }, body), trail];
}

function menuButton(app, type, id, menuItems) {
  return iconButton({
    icon: 'more-horizontal',
    title: 'Mais ações',
    size: 'sm',
    class: 'en-menu-btn',
    onclick: (ev) => {
      ev.stopPropagation();
      openEntityMenu(app, type, id, ev.currentTarget, menuItems ? { items: menuItems } : undefined);
    },
  });
}

/** Colunas de prioridade: 'priority' (só as barras) ou 'priority-code' (barras + código "P2"). */
function priorityCell(app, type, entity, col) {
  return h('span', { class: cx('en-cell en-cell-priority', col === 'priority-code' && 'has-code') }, priorityControl(app, type, entity, { compact: col !== 'priority-code' }));
}

/**
 * Linha PADRÃO de tarefa (listas). Clicar no corpo abre o painel (ou chama `onclick`); os controles tratam o
 * próprio clique. Em telas estreitas a linha quebra em duas.
 *
 * Colunas: 'check', 'title', 'title-edit' (nome editável), 'flags', 'status', 'status-compact', 'priority',
 * 'priority-code' (barras + "P2"), 'due', 'owner', 'estimate', 'timer', 'progress', 'grip' (alça de arrasto),
 * 'open' (botão abrir), 'menu' — ou uma função (task) => Node para uma coluna sob medida.
 *
 * @param {object} app
 * @param {object} task
 * @param {{ columns?: Array<string|Function>, indent?: number, showDemand?: boolean, showTimer?: boolean,
 *           onclick?: (task: object, ev: Event) => void, class?: string|object, attrs?: object,
 *           flags?: { hideTime?: boolean, hideNoDemand?: boolean },
 *           menuItems?: Array<object>|((task: object) => Array<object>) }} [options]
 *        attrs: props extras do elemento da linha (ex.: sortableItem(...)); tabindex/style/onkeydown/onclick
 *        da tela são respeitados (ver hostProps). flags: opções de entityFlags. menuItems: itens extras do menu "…".
 * @returns {HTMLDivElement}
 */
export function taskRow(app, task, { columns = TASK_ROW_COLUMNS, indent = 0, showDemand = false, showTimer = false, onclick, class: className, attrs, flags: flagOptions, menuItems } = {}) {
  if (!task) return h('div', { class: 'en-row is-missing' }, 'Tarefa não encontrada');
  const base = entityAttrs(app, 'task', task);
  const open = (ev) => (typeof onclick === 'function' ? onclick(task, ev) : entityActions.open(app, 'task', task.id));
  const cols = Array.isArray(columns) ? [...columns] : [...TASK_ROW_COLUMNS];
  if (showTimer && !cols.includes('timer')) cols.splice(Math.max(0, cols.indexOf('menu')), 0, 'timer');
  const cells = cols.map((col) => {
    if (typeof col === 'function') return h('span', { class: 'en-cell en-cell-custom', 'data-stop': true }, col(task));
    switch (col) {
      case 'grip':
        return h('span', { class: 'en-cell en-cell-grip en-grip', title: 'Arraste para reordenar', 'aria-hidden': 'true' }, icon('grip', { size: 14 }));
      case 'check':
        return h('span', { class: 'en-cell en-cell-check' }, checkControl(app, task));
      case 'title':
      case 'title-edit': {
        const demand = showDemand ? app.sel.demandOf(task) : null;
        return h(
          'span',
          { class: 'en-cell en-cell-title' },
          entityTitle(app, 'task', task, { onclick: col === 'title' ? (t, ev) => open(ev) : undefined, editable: col === 'title-edit' }),
          demand ? h('span', { class: 'en-row-demand', title: `Demanda: ${demand.name}` }, truncate(demand.name, 40)) : null,
        );
      }
      case 'flags': {
        const flags = entityFlags(app, 'task', task, { hideNoDemand: !showDemand, ...(flagOptions || {}) });
        return flags ? h('span', { class: 'en-cell en-cell-flags' }, flags) : null;
      }
      case 'status':
        return h('span', { class: 'en-cell en-cell-status' }, statusControl(app, 'task', task));
      case 'status-compact':
        return h('span', { class: 'en-cell en-cell-status is-compact' }, statusControl(app, 'task', task, { compact: true }));
      case 'priority':
      case 'priority-code':
        return priorityCell(app, 'task', task, col);
      case 'due':
        return h('span', { class: 'en-cell en-cell-due' }, dueControl(app, 'task', task, { compact: true }));
      case 'owner':
        return h('span', { class: 'en-cell en-cell-owner' }, task.owner ? avatar(task.owner, { size: 20 }) : null);
      case 'estimate':
        return h('span', { class: 'en-cell en-cell-estimate tabular' }, task.estimate_minutes ? formatDurationText(task.estimate_minutes) : '');
      case 'timer':
        return h('span', { class: 'en-cell en-cell-timer' }, timerControl(app, task, { compact: true }));
      case 'progress': {
        const fraction = app.sel.taskFraction(task.id);
        return h('span', { class: 'en-cell en-cell-progress' }, fraction.source === 'subtasks' ? progressBar(fraction.value, { size: 'sm' }) : null);
      }
      case 'open':
        return h(
          'span',
          { class: 'en-cell en-cell-open' },
          iconButton({ icon: 'panel-right', title: 'Abrir', size: 'sm', onclick: (ev) => { ev.stopPropagation(); entityActions.open(app, 'task', task.id); } }),
        );
      case 'menu':
        return h('span', { class: 'en-cell en-cell-menu' }, menuButton(app, 'task', task.id, menuItems));
      default:
        return null;
    }
  });
  const extra = attrs && typeof attrs === 'object' ? attrs : {};
  return h(
    'div',
    hostProps(extra, base, {
      className: cx('en-row', 'en-task-row', base.class, indent > 0 && 'is-indented', extra.class, className),
      style: indent > 0 ? { '--en-indent': String(indent) } : null,
      open,
    }),
    rowChildren(cols, cells),
  );
}

/**
 * Linha PADRÃO de demanda (listas), opcionalmente com a próxima ação embaixo.
 *
 * Colunas: 'title', 'project', 'progress', 'status', 'priority', 'priority-code', 'due', 'owner', 'count'
 * (tarefas), 'flags', 'grip', 'menu' — ou uma função (demand) => Node.
 *
 * @param {object} app
 * @param {object} demand
 * @param {{ columns?: Array<string|Function>, onclick?: (demand: object, ev: Event) => void, class?: string|object,
 *           showNextAction?: boolean, attrs?: object, flags?: object,
 *           menuItems?: Array<object>|((demand: object) => Array<object>) }} [options] (ver taskRow)
 * @returns {HTMLDivElement}
 */
export function demandRow(app, demand, { columns = DEMAND_ROW_COLUMNS, onclick, class: className, showNextAction = false, attrs, flags: flagOptions, menuItems } = {}) {
  if (!demand) return h('div', { class: 'en-row is-missing' }, 'Demanda não encontrada');
  const base = entityAttrs(app, 'demand', demand);
  const open = (ev) => (typeof onclick === 'function' ? onclick(demand, ev) : entityActions.open(app, 'demand', demand.id));
  const cols = Array.isArray(columns) ? [...columns] : [...DEMAND_ROW_COLUMNS];
  const cells = cols.map((col) => {
    if (typeof col === 'function') return h('span', { class: 'en-cell en-cell-custom', 'data-stop': true }, col(demand));
    switch (col) {
      case 'grip':
        return h('span', { class: 'en-cell en-cell-grip en-grip', 'aria-hidden': 'true' }, icon('grip', { size: 14 }));
      case 'title':
        return h(
          'span',
          { class: 'en-cell en-cell-title' },
          entityTitle(app, 'demand', demand, { onclick: (d, ev) => open(ev) }),
          showNextAction && demand.next_action ? h('span', { class: 'en-next-action', title: `Próxima ação: ${demand.next_action}` }, icon('arrow-right', { size: 12 }), h('span', null, demand.next_action)) : null,
        );
      case 'project': {
        const project = app.sel.project(demand.project_id);
        return h('span', { class: 'en-cell en-cell-project' }, project ? h('span', { class: 'en-project-chip', title: project.name }, projectDot(project), h('span', { class: 'truncate' }, project.name)) : null);
      }
      case 'progress':
        return h('span', { class: 'en-cell en-cell-progress' }, progressControl(app, demand, { compact: true }));
      case 'status':
        return h('span', { class: 'en-cell en-cell-status' }, statusControl(app, 'demand', demand));
      case 'priority':
      case 'priority-code':
        return priorityCell(app, 'demand', demand, col);
      case 'due':
        return h('span', { class: 'en-cell en-cell-due' }, dueControl(app, 'demand', demand, { compact: true }));
      case 'owner':
        return h('span', { class: 'en-cell en-cell-owner' }, demand.owner ? avatar(demand.owner, { size: 20 }) : null);
      case 'count': {
        const count = app.sel.topTasks(demand.id).length;
        return h('span', { class: 'en-cell en-cell-count tabular', title: plural(count, 'tarefa', 'tarefas') }, String(count));
      }
      case 'flags': {
        const flags = entityFlags(app, 'demand', demand, flagOptions || {});
        return flags ? h('span', { class: 'en-cell en-cell-flags' }, flags) : null;
      }
      case 'menu':
        return h('span', { class: 'en-cell en-cell-menu' }, menuButton(app, 'demand', demand.id, menuItems));
      default:
        return null;
    }
  });
  const extra = attrs && typeof attrs === 'object' ? attrs : {};
  return h(
    'div',
    hostProps(extra, base, {
      className: cx('en-row', 'en-demand-row', base.class, showNextAction && demand.next_action && 'has-next-action', extra.class, className),
      open,
    }),
    rowChildren(cols, cells),
  );
}

/**
 * Cartão compacto (quadros e calendários): código, título, indicadores, prioridade, prazo e responsável.
 * @param {object} app
 * @param {'task'|'demand'} type
 * @param {object} entity
 * @param {{ showDemand?: boolean, showProject?: boolean, footer?: Node|Node[], onclick?: Function,
 *           class?: string|object, attrs?: object, flags?: object, menu?: boolean,
 *           menuItems?: Array<object>|((entity: object) => Array<object>) }} [options]
 *        menu: mostra o botão "Mais ações" no topo do cartão; flags/menuItems/attrs: ver taskRow
 * @returns {HTMLDivElement}
 */
export function entityCard(app, type, entity, { showDemand = true, showProject = false, footer, onclick, class: className, attrs, flags: flagOptions, menu = false, menuItems } = {}) {
  if (!entity) return h('div', { class: 'en-card is-missing' }, 'Item não encontrado');
  const base = entityAttrs(app, type, entity);
  const open = (ev) => (typeof onclick === 'function' ? onclick(entity, ev) : entityActions.open(app, type, entity.id));
  const demand = type === 'task' && showDemand ? app.sel.demandOf(entity) : null;
  const project = showProject ? app.sel.projectOf(type, entity) : null;
  const category = categoryOfEntity(app, entity);
  const extra = attrs && typeof attrs === 'object' ? attrs : {};
  return h(
    'div',
    hostProps(extra, base, { className: cx('en-card', `en-card-${type}`, base.class, extra.class, className), open }),
    h(
      'div',
      { class: 'en-card-top' },
      type === 'task' ? checkControl(app, entity, { size: 'sm' }) : statusControl(app, type, entity, { compact: true }),
      h('span', { class: 'en-code tabular' }, app.sel.code(type, entity)),
      project ? h('span', { class: 'en-card-context', title: project.name }, projectDot(project), h('span', { class: 'truncate' }, project.name)) : null,
      demand ? h('span', { class: 'en-card-context', title: demand.name }, icon('layers', { size: 12 }), h('span', { class: 'truncate' }, demand.name)) : null,
      h('span', { class: 'en-card-spacer' }),
      priorityControl(app, type, entity, { compact: true }),
      menu ? menuButton(app, type, entity.id, menuItems) : null,
    ),
    h('div', { class: cx('en-card-title', isClosedCategory(category) && 'is-closed') }, nameOf(entity)),
    entityFlags(app, type, entity, { hideNoDemand: !showDemand, ...(flagOptions || {}) }),
    h(
      'div',
      { class: 'en-card-meta' },
      type === 'task' ? statusControl(app, type, entity, { soft: true }) : progressControl(app, entity, { compact: true }),
      dueControl(app, type, entity, { compact: true }),
      h('span', { class: 'en-card-spacer' }),
      type === 'task' && app.sel.timerOf(entity.id) ? timerControl(app, entity, { compact: true }) : null,
      entity.owner ? avatar(entity.owner, { size: 20 }) : null,
    ),
    footer ? h('div', { class: 'en-card-footer' }, footer) : null,
  );
}
