// "Próximas ações" e recomendações de prioridade (seções 5 e 12 do pedido). Puro: sem DOM, sem banco e sem
// relógio implícito — "hoje" e "agora" chegam por parâmetro.
//
// Duas perguntas respondidas aqui:
//   • nextActions:         "o que eu faço agora?" — lista pontuada e explicada das tarefas abertas;
//   • prioritySuggestions: "alguma prioridade está incoerente?" — o sistema NUNCA muda prioridade sozinho:
//     só sugere, com justificativa, e o usuário aplica ou dispensa.
//
// Vocabulário (o mesmo de dependencies.js): tarefa VIVA = aberta (nem concluída nem cancelada), não excluída e
// não arquivada; "destrava N tarefas" = N tarefas vivas que dependem dela, direta ou transitivamente.

import { compareDates, countWorkdays, diffDays, isValidDateStr, isoToDateStr, ms } from '../core/dates.js';
import { blockingPrereqs, isLiveTask, openDownstream } from './dependencies.js';
import { priorityById, priorityRank } from './priorities.js';
import { categoryOf } from './statuses.js';

const NONE = Object.freeze([]);
const DAY_MS = 86400000;
const UNNAMED = 'Tarefa sem nome';
const NAME_COLLATOR = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/**
 * Pesos da pontuação de nextActions — num só lugar, para ajustar e testar.
 *   • `priority`: pontos por prioridade da tarefa;
 *   • prazo: `overdue` + `overduePerDay` por dia de atraso (o extra limitado a `overdueExtraCap`); `dueToday`;
 *     `dueSoon` (vence em 1…soonDays dias); `dueWeek` (depois disso, até `weekDays` dias);
 *   • `status`: pontos por CATEGORIA do status (aguardando/bloqueada não pontuam: vão para o grupo "destravar");
 *   • impacto: `unblocksEach` por tarefa viva que depende dela (limitado a `unblocksCap`) e `unblocksUrgent`
 *     quando alguma dessas tarefas está atrasada ou vence em até soonDays dias;
 *   • `demandPriority`: pontos pela prioridade da demanda da tarefa.
 */
export const SCORE = Object.freeze({
  priority: Object.freeze({ P1: 40, P2: 25, P3: 10, P4: 0 }),
  overdue: 50,
  overduePerDay: 2,
  overdueExtraCap: 20,
  dueToday: 45,
  dueSoon: 30,
  dueWeek: 15,
  weekDays: 7,
  status: Object.freeze({ active: 15, review: 10, planned: 5, backlog: 0, waiting: 0, blocked: 0 }),
  unblocksEach: 8,
  unblocksCap: 24,
  unblocksUrgent: 10,
  demandPriority: Object.freeze({ P1: 10, P2: 5 }),
});

/** Parâmetros das regras de prioritySuggestions. */
export const SUGGESTION_RULES = Object.freeze({
  /** "Destrava muitas": a partir de quantas tarefas vivas dependentes a tarefa merece pelo menos P2. */
  blocksMany: 3,
  /** Janela (dias) em que uma tarefa de demanda crítica com prazo merece pelo menos P2. */
  demandWindowDays: 7,
  /** Dias sem prazo nem início depois dos quais uma tarefa crítica recebe a sugestão de baixar para P2. */
  staleCriticalDays: 14,
});

/** Códigos dos motivos (`reasons[].code`) devolvidos por nextActions e prioritySuggestions. */
export const REASON_CODES = Object.freeze({
  OVERDUE: 'overdue',
  DUE_TODAY: 'due_today',
  DUE_SOON: 'due_soon',
  DUE_WEEK: 'due_week',
  P1: 'p1',
  P2: 'p2',
  IN_PROGRESS: 'in_progress',
  IN_REVIEW: 'in_review',
  UNBLOCKS: 'unblocks',
  UNBLOCKS_URGENT: 'unblocks_urgent',
  WAITING: 'waiting',
  BLOCKED: 'blocked',
  BLOCKED_BY_DEPENDENCY: 'blocked_by_dependency',
  DEMAND_PRIORITY: 'demand_priority',
  TIGHT_ESTIMATE: 'tight_estimate',
  STALE_CRITICAL: 'stale_critical',
});

const R = REASON_CODES;

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

function toList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') return [...value];
  return NONE;
}

/** Consulta por id num Map ou num objeto simples. */
function lookup(byId, id) {
  if (!byId || id === null || id === undefined) return undefined;
  if (typeof byId.get === 'function') return byId.get(id);
  return Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : undefined;
}

/** Tarefas válidas (com id), sem repetição de id (vale a primeira ocorrência), na ordem recebida. */
function uniqueTasks(tasks) {
  const seen = new Set();
  const out = [];
  for (const task of toList(tasks)) {
    if (!task || task.id === null || task.id === undefined || seen.has(task.id)) continue;
    seen.add(task.id);
    out.push(task);
  }
  return out;
}

/** Índice de demandas: usa `demandsById` (Map ou objeto) ou monta um a partir da lista `demands`. */
function demandIndex(demandsById, demands) {
  if (demandsById) return demandsById;
  const list = toList(demands);
  if (!list.length) return null;
  const map = new Map();
  for (const demand of list) if (demand && demand.id !== null && demand.id !== undefined) map.set(demand.id, demand);
  return map;
}

function requireToday(today, where) {
  if (!isValidDateStr(today)) {
    throw new TypeError(`${where}: "today" precisa ser uma data 'YYYY-MM-DD' (recebido: ${JSON.stringify(today) ?? String(today)})`);
  }
  return today;
}

const validDate = (value) => (isValidDateStr(value) ? value : null);
const normalizeSoonDays = (soonDays) => (Number.isFinite(soonDays) && soonDays >= 0 ? Math.floor(soonDays) : 3);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const clean = (text) => (typeof text === 'string' ? text.trim() : '');

function taskName(task) {
  return clean(task && task.name) || UNNAMED;
}

const quoted = (task) => `“${taskName(task)}”`;

function compareIds(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Desempate comum: prazo (sem prazo por último) → nome → id. */
function compareDueThenName(a, b) {
  return (
    compareDates(validDate(a.due_date), validDate(b.due_date)) ||
    NAME_COLLATOR.compare(taskName(a), taskName(b)) ||
    compareIds(a.id, b.id)
  );
}

/** Dias até o prazo (negativo = atrasada); null quando não há prazo válido. */
function daysUntil(due, today) {
  return due ? diffDays(today, due) : null;
}

/**
 * Motivo ligado ao prazo: atrasada, vence hoje, vence em breve (1…soonDays) ou vence na semana (até weekDays).
 * @returns {{ code: string, label: string }|null} null quando não há prazo ou ele está além de weekDays dias
 */
function deadlineReason(daysLeft, soonDays) {
  if (daysLeft === null) return null;
  if (daysLeft < 0) return { code: R.OVERDUE, label: `Atrasada há ${plural(-daysLeft, 'dia', 'dias')}` };
  if (daysLeft === 0) return { code: R.DUE_TODAY, label: 'Vence hoje' };
  const label = daysLeft === 1 ? 'Vence amanhã' : `Vence em ${daysLeft} dias`;
  if (daysLeft <= soonDays) return { code: R.DUE_SOON, label };
  if (daysLeft <= SCORE.weekDays) return { code: R.DUE_WEEK, label };
  return null;
}

/** Pontos de prazo correspondentes a um motivo de deadlineReason. */
function deadlinePoints(reason, daysLeft) {
  if (!reason) return 0;
  switch (reason.code) {
    case R.OVERDUE:
      return SCORE.overdue + Math.min(SCORE.overdueExtraCap, SCORE.overduePerDay * -daysLeft);
    case R.DUE_TODAY:
      return SCORE.dueToday;
    case R.DUE_SOON:
      return SCORE.dueSoon;
    default:
      return SCORE.dueWeek;
  }
}

const unblocksReason = (count) => ({ code: R.UNBLOCKS, label: `Destrava ${plural(count, 'tarefa', 'tarefas')}` });

/** Demanda da tarefa, se existir e não estiver excluída. */
function demandOf(task, demands) {
  const demand = lookup(demands, task.demand_id);
  return demand && !demand.deleted_at ? demand : null;
}

/** Tarefas vivas que esperam por esta (vazio, sem custo, quando ninguém depende dela). */
function waitingOn(task, ctx) {
  const direct = ctx.graph && ctx.graph.dependents ? ctx.graph.dependents.get(task.id) : null;
  return direct && direct.size ? openDownstream(task.id, ctx) : NONE;
}

// ---------------------------------------------------------------------------
// Próximas ações
// ---------------------------------------------------------------------------

/**
 * @typedef {object} NextAction
 * @property {object} task   a tarefa (a mesma linha recebida)
 * @property {number} score  pontuação (ver SCORE)
 * @property {'do'|'unblock'} group `do` = pode ser feita agora; `unblock` = precisa de uma ação para destravar
 *           (cobrar o terceiro, remover o impedimento ou concluir o pré-requisito)
 * @property {Array<{ code: string, label: string }>} reasons motivos, em pt-BR, que explicam a posição
 */

/**
 * Lista "Próximas ações": as tarefas abertas que mais merecem atenção, pontuadas e explicadas.
 *
 * Candidatas: tarefas vivas (abertas, não excluídas, não arquivadas). Ficam de fora as tarefas de categoria
 * "backlog" sem prazo e com prioridade P3/P4 (ainda não planejadas).
 *
 * Grupo:
 *   • `unblock` — status de categoria "bloqueada" ou "aguardando terceiros", OU bloqueada por dependência
 *     (tem pré-requisito ainda aberto);
 *   • `do` — todas as outras: podem ser trabalhadas agora.
 *
 * Pontuação (constantes em SCORE): prioridade P1 40 / P2 25 / P3 10 / P4 0; prazo — atrasada 50 + 2 por dia
 * de atraso (extra até 20), vence hoje 45, vence em 1…soonDays dias 30, depois disso até 7 dias 15; status —
 * em andamento 15, em revisão 10, planejada 5, backlog 0; impacto — 8 por tarefa viva que depende dela, direta
 * ou transitivamente (até 24), mais 10 quando alguma delas está atrasada ou vence em até soonDays dias;
 * prioridade da demanda — P1 10 / P2 5.
 *
 * Motivos (`reasons`, na ordem): o que trava (`waiting` 'Aguardando: …', `blocked` 'Bloqueada: …',
 * `blocked_by_dependency` 'Depende de “X”'), prazo (`overdue` 'Atrasada há 2 dias', `due_today` 'Vence hoje',
 * `due_soon` 'Vence em 3 dias' / 'Vence amanhã', `due_week` 'Vence em 5 dias'), prioridade (`p1` 'Prioridade
 * crítica', `p2` 'Prioridade alta'), status (`in_progress` 'Já em andamento', `in_review` 'Aguardando revisão'),
 * impacto (`unblocks` 'Destrava 2 tarefas', `unblocks_urgent` 'Destrava “Y”, que está atrasada') e
 * `demand_priority` 'Demanda prioritária'.
 *
 * Ordem: primeiro o grupo `do`, por pontuação decrescente; depois `unblock`, por pontuação decrescente.
 * Empate: prazo (sem prazo por último) → nome → id.
 *
 * @param {object} params
 * @param {Iterable<object>} params.tasks        tarefas (o chamador já tirou as ocultas; encerradas são ignoradas)
 * @param {Map|object} [params.demandsById]      id → demanda (para a prioridade da demanda)
 * @param {Iterable<object>} [params.demands]    alternativa a `demandsById`: a lista de demandas
 * @param {object} params.graph                  grafo de buildGraph
 * @param {Array} [params.statuses]              lista efetiva de status (padrão: os de fábrica)
 * @param {string} params.today                  'YYYY-MM-DD' (obrigatório; TypeError se inválido)
 * @param {number} [params.limit=10]             tamanho máximo da lista INTEIRA (Infinity ou null = sem limite)
 * @param {number} [params.soonDays=3]           até quantos dias um prazo é "próximo"
 * @returns {NextAction[]}
 */
export function nextActions({ tasks, demandsById, demands, graph, statuses, today, limit = 10, soonDays = 3 } = {}) {
  requireToday(today, 'nextActions');
  const soon = normalizeSoonDays(soonDays);
  const list = uniqueTasks(tasks);
  const tasksById = new Map(list.map((task) => [task.id, task]));
  const demandsIndex = demandIndex(demandsById, demands);
  const ctx = { graph, tasksById, statuses, demandsById: demandsIndex };

  const out = [];
  for (const task of list) {
    if (!isLiveTask(task, ctx)) continue;
    const category = categoryOf(statuses, task.status);
    const priority = priorityById(task.priority).id;
    const due = validDate(task.due_date);
    if (category === 'backlog' && !due && priorityRank(priority) >= 3) continue;

    const reasons = [];
    let score = 0;

    // O que trava a tarefa (define o grupo).
    const blockers = blockingPrereqs(task.id, ctx);
    const stuck = category === 'waiting' || category === 'blocked';
    if (category === 'waiting') {
      const who = clean(task.waiting_on);
      reasons.push({ code: R.WAITING, label: who ? `Aguardando: ${who}` : 'Aguardando terceiros' });
    } else if (category === 'blocked') {
      const why = clean(task.blocked_reason);
      reasons.push({ code: R.BLOCKED, label: why ? `Bloqueada: ${why}` : 'Bloqueada' });
    }
    if (blockers.length) {
      const others = blockers.length - 1;
      const label = others ? `Depende de ${quoted(blockers[0])} e de mais ${plural(others, 'tarefa', 'tarefas')}` : `Depende de ${quoted(blockers[0])}`;
      reasons.push({ code: R.BLOCKED_BY_DEPENDENCY, label });
    }

    // Prazo.
    const daysLeft = daysUntil(due, today);
    const deadline = deadlineReason(daysLeft, soon);
    if (deadline) {
      score += deadlinePoints(deadline, daysLeft);
      reasons.push(deadline);
    }

    // Prioridade.
    score += SCORE.priority[priority] || 0;
    if (priority === 'P1') reasons.push({ code: R.P1, label: 'Prioridade crítica' });
    else if (priority === 'P2') reasons.push({ code: R.P2, label: 'Prioridade alta' });

    // Status.
    score += SCORE.status[category] || 0;
    if (category === 'active') reasons.push({ code: R.IN_PROGRESS, label: 'Já em andamento' });
    else if (category === 'review') reasons.push({ code: R.IN_REVIEW, label: 'Aguardando revisão' });

    // Impacto: quem espera por esta tarefa.
    const downstream = waitingOn(task, ctx);
    if (downstream.length) {
      score += Math.min(SCORE.unblocksCap, SCORE.unblocksEach * downstream.length);
      reasons.push(unblocksReason(downstream.length));
      let urgent = null;
      for (const other of downstream) {
        const otherDue = validDate(other.due_date);
        if (!otherDue || diffDays(today, otherDue) > soon) continue;
        if (!urgent || compareDueThenName(other, urgent) < 0) urgent = other;
      }
      if (urgent) {
        score += SCORE.unblocksUrgent;
        const late = urgent.due_date < today;
        reasons.push({ code: R.UNBLOCKS_URGENT, label: `Destrava ${quoted(urgent)}, que ${late ? 'está atrasada' : 'vence em breve'}` });
      }
    }

    // Prioridade da demanda.
    const demand = demandOf(task, demandsIndex);
    const demandPoints = demand ? SCORE.demandPriority[demand.priority] || 0 : 0;
    if (demandPoints) {
      score += demandPoints;
      reasons.push({ code: R.DEMAND_PRIORITY, label: 'Demanda prioritária' });
    }

    out.push({ task, score, group: stuck || blockers.length ? 'unblock' : 'do', reasons });
  }

  out.sort((a, b) => (a.group === b.group ? 0 : a.group === 'do' ? -1 : 1) || b.score - a.score || compareDueThenName(a.task, b.task));

  if (limit === null || limit === Infinity) return out;
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 10;
  return out.length > max ? out.slice(0, max) : out;
}

// ---------------------------------------------------------------------------
// Recomendações de prioridade
// ---------------------------------------------------------------------------

/** Ordem canônica dos motivos numa sugestão (a justificativa segue esta ordem). */
const SUGGESTION_REASON_ORDER = Object.freeze([R.OVERDUE, R.DUE_TODAY, R.DUE_SOON, R.DUE_WEEK, R.UNBLOCKS, R.TIGHT_ESTIMATE, R.DEMAND_PRIORITY, R.STALE_CRITICAL]);

/** Minutos → '20 h', '1 h 30 min', '45 min'. */
function formatEffort(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Junta os rótulos numa frase: 'Vence amanhã e destrava 2 tarefas'. */
function joinLabels(reasons) {
  const parts = reasons.map((reason, i) => (i === 0 ? reason.label : reason.label.charAt(0).toLowerCase() + reason.label.slice(1)));
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;
}

/**
 * Assinatura de uma sugestão: `taskId:prioridadeSugerida:códigos dos motivos em ordem alfabética, separados
 * por vírgula`. É o que se guarda quando o usuário dispensa a sugestão — ela só volta a aparecer se a situação
 * mudar (outra prioridade sugerida ou outros motivos).
 *
 * @param {string} taskId
 * @param {string} suggested 'P1'…'P4'
 * @param {Array<{ code: string }|string>} reasons motivos (objetos com `code`) ou os próprios códigos
 * @returns {string}
 */
export function suggestionSignature(taskId, suggested, reasons) {
  const codes = toList(reasons).map((reason) => (reason !== null && typeof reason === 'object' ? reason.code : reason));
  return `${taskId}:${suggested}:${[...new Set(codes)].sort().join(',')}`;
}

/** Idade da tarefa em dias (fracionária quando há `nowIso`); null se `created_at` é inválido. */
function ageInDays(task, today, nowIso) {
  const createdMs = ms(task.created_at);
  if (!Number.isFinite(createdMs)) return null;
  const nowMs = ms(nowIso);
  if (Number.isFinite(nowMs)) return (nowMs - createdMs) / DAY_MS;
  return diffDays(isoToDateStr(task.created_at), today);
}

/**
 * @typedef {object} PrioritySuggestion
 * @property {string} taskId
 * @property {'P1'|'P2'|'P3'|'P4'} current    prioridade atual (id desconhecido conta como a padrão, P3)
 * @property {'P1'|'P2'} suggested            prioridade sugerida
 * @property {'raise'|'lower'} direction      `raise` = ficar mais urgente; `lower` = ficar menos urgente
 * @property {Array<{ code: string, label: string }>} reasons motivos da regra (ou regras) que pedem a prioridade sugerida
 * @property {string} justification           uma frase em pt-BR juntando os motivos
 * @property {string} signature               ver suggestionSignature
 */

/**
 * Recomendações de prioridade. O sistema NUNCA muda prioridades sozinho: devolve sugestões com justificativa,
 * e o usuário aceita ou dispensa (a assinatura dispensada entra em `dismissed`).
 *
 * Só tarefas vivas (abertas, não excluídas, não arquivadas). Cada regra pede uma prioridade mínima; sugere-se
 * a mais urgente delas quando é mais urgente que a prioridade atual (`direction: 'raise'`):
 *   1. atrasada ou vence hoje E destrava pelo menos uma tarefa aberta → P1;
 *   2. atrasada → pelo menos P2 (P1 quando a demanda da tarefa é P1);
 *   3. vence em até soonDays dias (hoje incluído) e a estimativa restante (`estimate_minutes` menos o tempo já
 *      apontado, quando informado) não cabe nos dias úteis que faltam — countWorkdays(hoje, prazo) ×
 *      hoursPerDay → pelo menos P2;
 *   4. destrava 3 ou mais tarefas abertas → pelo menos P2;
 *   5. a demanda é P1 e a tarefa vence em até 7 dias → pelo menos P2.
 * "Destrava" conta as tarefas vivas que dependem dela, direta ou transitivamente.
 *
 * Uma regra para baixar (`direction: 'lower'`): tarefa P1 sem prazo, não iniciada (backlog/planejada), que não
 * destrava ninguém e foi criada há mais de 14 dias → sugere P2 ('Crítica há N dias sem prazo nem início').
 *
 * Motivos: `overdue`, `due_today`, `due_soon`, `due_week`, `unblocks`, `tight_estimate`, `demand_priority`,
 * `stale_critical`. Entram os motivos de todas as regras que pedem exatamente a prioridade sugerida.
 *
 * Ordem (por urgência): primeiro as sugestões de subir — P1 antes de P2, depois prazo mais próximo (sem prazo
 * por último), depois o maior salto, depois nome; por fim as de baixar (as mais antigas primeiro).
 *
 * @param {object} params
 * @param {Iterable<object>} params.tasks
 * @param {Map|object} [params.demandsById]      id → demanda
 * @param {Iterable<object>} [params.demands]    alternativa a `demandsById`: a lista de demandas
 * @param {object} params.graph                  grafo de buildGraph
 * @param {Array} [params.statuses]
 * @param {string} params.today                  'YYYY-MM-DD' (obrigatório; TypeError se inválido)
 * @param {Iterable<string>} [params.dismissed]  assinaturas dispensadas pelo usuário (array ou Set)
 * @param {string} [params.nowIso]               instante atual (ISO UTC), para a idade da tarefa; sem ele a
 *                                               idade é contada em dias de calendário até `today`
 * @param {number} [params.soonDays=3]
 * @param {number} [params.hoursPerDay=8]        horas de trabalho por dia útil
 * @param {Map|object} [params.trackedSecondsByTask] opcional: id → segundos já apontados (abate da estimativa)
 * @returns {PrioritySuggestion[]}
 */
export function prioritySuggestions({
  tasks,
  demandsById,
  demands,
  graph,
  statuses,
  today,
  dismissed = [],
  nowIso,
  soonDays = 3,
  hoursPerDay = 8,
  trackedSecondsByTask,
} = {}) {
  requireToday(today, 'prioritySuggestions');
  const soon = normalizeSoonDays(soonDays);
  const hours = Number.isFinite(hoursPerDay) && hoursPerDay > 0 ? hoursPerDay : 8;
  const list = uniqueTasks(tasks);
  const tasksById = new Map(list.map((task) => [task.id, task]));
  const demandsIndex = demandIndex(demandsById, demands);
  const ctx = { graph, tasksById, statuses, demandsById: demandsIndex };
  const ignored = dismissed instanceof Set ? dismissed : new Set(toList(dismissed));

  const found = [];
  for (const task of list) {
    if (!isLiveTask(task, ctx)) continue;
    const current = priorityById(task.priority).id;
    const currentRank = priorityRank(current);
    const due = validDate(task.due_date);
    const daysLeft = daysUntil(due, today);
    const category = categoryOf(statuses, task.status);
    const unblocks = waitingOn(task, ctx).length;
    const demand = demandOf(task, demandsIndex);
    const criticalDemand = !!demand && demand.priority === 'P1';

    let suggested = null;
    let direction = 'raise';
    let reasons = [];

    if (currentRank > 1) {
      // Cada regra pede uma prioridade mínima (rank 1 = P1, 2 = P2) e traz os seus motivos.
      const asks = [];
      const deadline = daysLeft === null ? null : deadlineReason(daysLeft, soon);
      const demandReason = { code: R.DEMAND_PRIORITY, label: 'Faz parte de uma demanda crítica' };
      if (daysLeft !== null && daysLeft <= 0 && unblocks >= 1) asks.push({ rank: 1, reasons: [deadline, unblocksReason(unblocks)] });
      if (daysLeft !== null && daysLeft < 0) {
        asks.push(criticalDemand ? { rank: 1, reasons: [deadline, demandReason] } : { rank: 2, reasons: [deadline] });
      }
      if (daysLeft !== null && daysLeft >= 0 && daysLeft <= soon) {
        const estimate = Number(task.estimate_minutes);
        const tracked = Number(lookup(trackedSecondsByTask, task.id));
        const remaining = Number.isFinite(estimate) ? estimate - (Number.isFinite(tracked) && tracked > 0 ? tracked / 60 : 0) : 0;
        const workdays = countWorkdays(today, due);
        if (remaining > 0 && remaining > workdays * hours * 60) {
          const label = workdays
            ? `A estimativa restante (${formatEffort(remaining)}) não cabe ${workdays === 1 ? 'no único dia útil' : `nos ${workdays} dias úteis`} até o prazo`
            : `Não há dia útil até o prazo para a estimativa restante (${formatEffort(remaining)})`;
          asks.push({ rank: 2, reasons: [deadline, { code: R.TIGHT_ESTIMATE, label }] });
        }
      }
      if (unblocks >= SUGGESTION_RULES.blocksMany) asks.push({ rank: 2, reasons: [unblocksReason(unblocks)] });
      if (criticalDemand && daysLeft !== null && daysLeft >= 0 && daysLeft <= SUGGESTION_RULES.demandWindowDays) {
        asks.push({ rank: 2, reasons: [deadline, demandReason] });
      }

      let best = Infinity;
      for (const ask of asks) if (ask.rank < best) best = ask.rank;
      if (best < currentRank) {
        suggested = best === 1 ? 'P1' : 'P2';
        const byCode = new Map();
        for (const ask of asks) {
          if (ask.rank !== best) continue;
          for (const reason of ask.reasons) if (reason && !byCode.has(reason.code)) byCode.set(reason.code, reason);
        }
        reasons = SUGGESTION_REASON_ORDER.filter((code) => byCode.has(code)).map((code) => byCode.get(code));
      }
    } else if (!due && (category === 'backlog' || category === 'planned') && unblocks === 0) {
      const age = ageInDays(task, today, nowIso);
      if (age !== null && age > SUGGESTION_RULES.staleCriticalDays) {
        suggested = 'P2';
        direction = 'lower';
        reasons = [{ code: R.STALE_CRITICAL, label: `Crítica há ${Math.floor(age)} dias sem prazo nem início` }];
      }
    }

    if (!suggested) continue;
    const signature = suggestionSignature(task.id, suggested, reasons);
    if (ignored.has(signature)) continue;
    found.push({
      suggestion: { taskId: task.id, current, suggested, direction, reasons, justification: joinLabels(reasons), signature },
      task,
      jump: currentRank - priorityRank(suggested),
      age: direction === 'lower' ? ageInDays(task, today, nowIso) : 0,
    });
  }

  found.sort(
    (a, b) =>
      (a.suggestion.direction === b.suggestion.direction ? 0 : a.suggestion.direction === 'raise' ? -1 : 1) ||
      priorityRank(a.suggestion.suggested) - priorityRank(b.suggestion.suggested) ||
      b.age - a.age ||
      compareDates(validDate(a.task.due_date), validDate(b.task.due_date)) ||
      b.jump - a.jump ||
      NAME_COLLATOR.compare(taskName(a.task), taskName(b.task)) ||
      compareIds(a.task.id, b.task.id),
  );
  return found.map((item) => item.suggestion);
}
