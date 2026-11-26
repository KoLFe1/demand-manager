// Indicadores de prazo (seção 7 do pedido: "Controle de prazos"). Puro e determinístico.
//
// Tudo aqui compara o PRAZO (`due_date`, data local 'YYYY-MM-DD') com "hoje", que SEMPRE chega por
// parâmetro (`today`): nenhuma função consulta o relógio do sistema.
//
// Vocabulário:
//   • item ABERTO    = status de categoria nem "concluída" nem "cancelada" (ver statuses.js);
//   • item CONCLUÍDO = categoria "done": vale a data LOCAL de `completed_at` comparada com o prazo;
//   • item CANCELADO = não tem indicador de prazo (estado `none`).
// Arquivamento e exclusão NÃO são olhados aqui: quem chama decide quais itens entram.
//
// Prazo inválido (texto que não é uma data 'YYYY-MM-DD' real) é tratado como "sem prazo".

import { compareDates, diffDays, formatDate, isValidDateStr, isoToDateStr, relativeDay } from '../core/dates.js';
import { comparePriority } from './priorities.js';
import { categoryOf, isCancelledCategory, isDoneCategory, isOpen } from './statuses.js';

/** Estados possíveis do indicador de prazo. */
export const DEADLINE_STATES = Object.freeze({
  ON_TIME: 'on_time',
  DUE_SOON: 'due_soon',
  OVERDUE: 'overdue',
  NO_DUE: 'no_due',
  DONE_ON_TIME: 'done_on_time',
  DONE_LATE: 'done_late',
  DONE: 'done',
  NONE: 'none',
});

const S = DEADLINE_STATES;

/** Rótulo (pt-BR) de cada estado. "Vence hoje" é o caso particular de `due_soon` em que o prazo é hoje. */
export const DEADLINE_LABELS = Object.freeze({
  [S.ON_TIME]: 'No prazo',
  [S.DUE_SOON]: 'Próxima do vencimento',
  [S.OVERDUE]: 'Atrasada',
  [S.NO_DUE]: 'Sem prazo',
  [S.DONE_ON_TIME]: 'Concluída no prazo',
  [S.DONE_LATE]: 'Concluída com atraso',
  [S.DONE]: 'Concluída',
  [S.NONE]: '',
});

/** Rótulo usado no lugar de "Próxima do vencimento" quando o prazo é hoje. */
export const DUE_TODAY_LABEL = 'Vence hoje';

/** Tom visual de cada estado: 'ok' | 'warn' | 'danger' | 'muted' | 'success'. */
export const DEADLINE_TONES = Object.freeze({
  [S.ON_TIME]: 'ok',
  [S.DUE_SOON]: 'warn',
  [S.OVERDUE]: 'danger',
  [S.NO_DUE]: 'muted',
  [S.DONE_ON_TIME]: 'success',
  [S.DONE_LATE]: 'warn',
  [S.DONE]: 'success',
  [S.NONE]: 'muted',
});

/** Quantos dias antes do prazo um item aberto passa a ser "próximo do vencimento" (padrão). */
export const DEFAULT_SOON_DAYS = 3;

/** Dentro de quantos dias (para trás ou para a frente) o texto curto do prazo é relativo ("em 3 dias"). */
const RELATIVE_LABEL_DAYS = 7;

/**
 * Faixas de vencimento dos itens ABERTOS (alertas do pedido). São EXCLUSIVAS entre si:
 * `today` = vence hoje; `next3` = vence em 1 a 3 dias; `next7` = vence em 4 a 7 dias; `later` = depois disso.
 */
export const DUE_BUCKETS = Object.freeze({
  OVERDUE: 'overdue',
  TODAY: 'today',
  NEXT3: 'next3',
  NEXT7: 'next7',
  LATER: 'later',
  NO_DUE: 'no_due',
});

const NAME_COLLATOR = new Intl.Collator('pt-BR', { numeric: true });

const nameOf = (entity) => (entity && entity.name != null ? String(entity.name) : '');

/** Prazo válido do item ('YYYY-MM-DD') ou null. */
function dueDateOf(entity) {
  return entity && isValidDateStr(entity.due_date) ? entity.due_date : null;
}

/** Erro de programação (não de dados): sem "hoje" não há indicador confiável — falha cedo e com mensagem clara. */
function assertToday(today, where) {
  if (!isValidDateStr(today)) {
    throw new TypeError(`${where}: "today" precisa ser uma data 'YYYY-MM-DD' (recebido: ${JSON.stringify(today) ?? String(today)})`);
  }
}

function normalizeSoonDays(soonDays) {
  return Number.isFinite(soonDays) && soonDays >= 0 ? Math.floor(soonDays) : DEFAULT_SOON_DAYS;
}

/** Aceita array ou qualquer iterável de objetos; qualquer outra coisa vira lista vazia. */
function toList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') return [...value];
  return [];
}

/** Texto curto do prazo para selos: relativo perto de hoje, data abreviada longe; '' sem prazo. */
function shortDueLabel(due, today) {
  if (!due) return '';
  const distance = Math.abs(diffDays(today, due));
  return distance <= RELATIVE_LABEL_DAYS ? relativeDay(due, today) : formatDate(due, 'short', today);
}

function buildInfo(state, due, today, extra) {
  return {
    state,
    label: DEADLINE_LABELS[state],
    shortLabel: shortDueLabel(due, today),
    tone: DEADLINE_TONES[state],
    daysLeft: null,
    daysLate: 0,
    dueToday: false,
    due_date: due,
    ...extra,
  };
}

/**
 * Dias de atraso (ou de antecedência) da conclusão em relação ao prazo.
 * Compara a data LOCAL de `completed_at` com `due_date`; não olha o status.
 *
 * @param {object|null} entity demanda ou tarefa
 * @returns {number|null} positivo = concluída depois do prazo; 0 = no dia do prazo; negativo = antes do prazo;
 *          null quando não dá para calcular (sem prazo válido ou sem `completed_at` válido).
 */
export function completionDelayDays(entity) {
  const due = dueDateOf(entity);
  if (!due) return null;
  const completedOn = isoToDateStr(entity.completed_at);
  if (!completedOn) return null;
  return diffDays(due, completedOn);
}

/**
 * Indicador de prazo de uma demanda ou tarefa.
 *
 * Regras:
 *   • ABERTA (status nem concluído nem cancelado):
 *       sem prazo                     → `no_due`    "Sem prazo"
 *       prazo < hoje                  → `overdue`   "Atrasada" (`daysLate` > 0)
 *       prazo em 0…soonDays dias      → `due_soon`  "Próxima do vencimento" — se é hoje: `dueToday` e rótulo "Vence hoje"
 *       senão                         → `on_time`   "No prazo"
 *   • CONCLUÍDA: compara a data LOCAL de `completed_at` com o prazo:
 *       concluída até o dia do prazo  → `done_on_time` "Concluída no prazo" (também quando falta `completed_at`)
 *       concluída depois              → `done_late`    "Concluída com atraso" (`daysLate` = dias depois do prazo)
 *       sem prazo                     → `done`         "Concluída"
 *   • CANCELADA (ou item inexistente)  → `none` (rótulo vazio).
 *
 * @param {object|null} entity demanda ou tarefa (usa `status`, `due_date`, `completed_at`)
 * @param {object} ctx
 * @param {string} ctx.today      data de hoje 'YYYY-MM-DD' (obrigatória; lança TypeError se inválida)
 * @param {Array}  [ctx.statuses] lista efetiva de status (padrão: os status de fábrica)
 * @param {number} [ctx.soonDays=3] até quantos dias antes do prazo o item é "próximo do vencimento"
 * @returns {{ state: string, label: string, shortLabel: string, tone: 'ok'|'warn'|'danger'|'muted'|'success',
 *             daysLeft: number|null, daysLate: number, dueToday: boolean, due_date: string|null }}
 *   `daysLeft`  dias de hoje até o prazo, só para item aberto com prazo (negativo quando atrasado); senão null.
 *   `daysLate`  dias de atraso (`overdue` e `done_late`); 0 nos demais estados.
 *   `shortLabel` texto curto do prazo para selos: 'hoje', 'amanhã', 'ontem', 'em 3 dias', 'há 2 dias' quando o prazo
 *               está a até 7 dias de hoje; senão a data abreviada ('5 dez', '5 dez 2027'); '' sem prazo.
 *   `due_date`  o prazo válido do item, ou null.
 */
export function deadlineInfo(entity, { today, statuses, soonDays = DEFAULT_SOON_DAYS } = {}) {
  assertToday(today, 'deadlineInfo');
  if (!entity) return buildInfo(S.NONE, null, today);

  const due = dueDateOf(entity);
  const category = categoryOf(statuses, entity.status);

  if (isCancelledCategory(category)) return buildInfo(S.NONE, due, today);

  if (isDoneCategory(category)) {
    if (!due) return buildInfo(S.DONE, null, today);
    const delay = completionDelayDays(entity);
    if (delay !== null && delay > 0) return buildInfo(S.DONE_LATE, due, today, { daysLate: delay });
    return buildInfo(S.DONE_ON_TIME, due, today);
  }

  if (!due) return buildInfo(S.NO_DUE, null, today);

  const daysLeft = diffDays(today, due);
  if (daysLeft < 0) return buildInfo(S.OVERDUE, due, today, { daysLeft, daysLate: -daysLeft });
  if (daysLeft <= normalizeSoonDays(soonDays)) {
    const dueToday = daysLeft === 0;
    return buildInfo(S.DUE_SOON, due, today, dueToday ? { label: DUE_TODAY_LABEL, daysLeft, dueToday } : { daysLeft });
  }
  return buildInfo(S.ON_TIME, due, today, { daysLeft });
}

/** Faixa de vencimento sem validar `today` (uso interno, em laços). */
function bucketOf(entity, today, statuses) {
  if (!isOpen(entity, statuses)) return null;
  const due = dueDateOf(entity);
  if (!due) return DUE_BUCKETS.NO_DUE;
  const daysLeft = diffDays(today, due);
  if (daysLeft < 0) return DUE_BUCKETS.OVERDUE;
  if (daysLeft === 0) return DUE_BUCKETS.TODAY;
  if (daysLeft <= 3) return DUE_BUCKETS.NEXT3;
  if (daysLeft <= 7) return DUE_BUCKETS.NEXT7;
  return DUE_BUCKETS.LATER;
}

/**
 * Faixa de vencimento de um item (mesma definição usada por dueBuckets e pelo filtro de prazo das listas).
 *
 * @param {object|null} entity demanda ou tarefa
 * @param {{ today: string, statuses?: Array }} ctx `today` obrigatório ('YYYY-MM-DD')
 * @returns {'overdue'|'today'|'next3'|'next7'|'later'|'no_due'|null}
 *   `overdue` prazo vencido; `today` vence hoje; `next3` vence em 1–3 dias; `next7` vence em 4–7 dias;
 *   `later` vence em 8 dias ou mais; `no_due` aberto sem prazo; null para item concluído, cancelado ou inexistente.
 */
export function dueBucketOf(entity, { today, statuses } = {}) {
  assertToday(today, 'dueBucketOf');
  return bucketOf(entity, today, statuses);
}

/**
 * Comparador "por vencimento": prazo mais próximo primeiro (sem prazo por último), depois prioridade
 * (P1 primeiro), depois nome (ordem alfabética pt-BR, números em ordem numérica).
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareByDue(a, b) {
  return compareDates(dueDateOf(a), dueDateOf(b)) || comparePriority(a, b) || NAME_COLLATOR.compare(nameOf(a), nameOf(b));
}

/**
 * Alertas de vencimento: separa os itens ABERTOS COM PRAZO em faixas EXCLUSIVAS.
 * Itens concluídos, cancelados, sem prazo ou com prazo além de 7 dias não entram em nenhuma lista.
 * Arquivados/excluídos NÃO são filtrados aqui (quem chama decide o que entra).
 *
 * @param {Iterable<object>} entities demandas e/ou tarefas
 * @param {{ today: string, statuses?: Array }} ctx `today` obrigatório ('YYYY-MM-DD')
 * @returns {{ overdue: object[], today: object[], next3: object[], next7: object[] }}
 *   `overdue` = prazo vencido; `today` = vence hoje; `next3` = vence em 1 a 3 dias; `next7` = vence em 4 a 7 dias.
 *   Cada lista é nova e vem ordenada por prazo, depois prioridade, depois nome.
 */
export function dueBuckets(entities, { today, statuses } = {}) {
  assertToday(today, 'dueBuckets');
  const out = { overdue: [], today: [], next3: [], next7: [] };
  for (const entity of toList(entities)) {
    const bucket = bucketOf(entity, today, statuses);
    if (bucket !== null && Object.hasOwn(out, bucket)) out[bucket].push(entity);
  }
  for (const list of Object.values(out)) list.sort(compareByDue);
  return out;
}

/**
 * O item está atrasado? (aberto e com prazo anterior a hoje)
 *
 * @param {object|null} entity
 * @param {{ today: string, statuses?: Array }} ctx
 * @returns {boolean}
 */
export function isOverdue(entity, { today, statuses } = {}) {
  assertToday(today, 'isOverdue');
  return bucketOf(entity, today, statuses) === DUE_BUCKETS.OVERDUE;
}

/**
 * O item aberto vence de hoje até daqui a `days` dias (inclusive nas duas pontas)?
 * Itens atrasados, sem prazo, concluídos ou cancelados devolvem false.
 *
 * @param {object|null} entity
 * @param {number} days quantidade de dias à frente (0 = só hoje)
 * @param {{ today: string, statuses?: Array }} ctx
 * @returns {boolean}
 */
export function isDueWithin(entity, days, { today, statuses } = {}) {
  assertToday(today, 'isDueWithin');
  if (!Number.isFinite(days) || days < 0) return false;
  if (!isOpen(entity, statuses)) return false;
  const due = dueDateOf(entity);
  if (!due) return false;
  const daysLeft = diffDays(today, due);
  return daysLeft >= 0 && daysLeft <= days;
}

/**
 * Quantidade de itens em cada estado de prazo.
 *
 * @param {Iterable<object>} entities demandas e/ou tarefas (entradas nulas são ignoradas)
 * @param {{ today: string, statuses?: Array, soonDays?: number }} ctx mesmo contexto de deadlineInfo
 * @returns {{ on_time: number, due_soon: number, overdue: number, no_due: number,
 *             done_on_time: number, done_late: number, done: number, none: number }}
 *   todas as chaves estão sempre presentes (zero quando não há itens no estado).
 */
export function deadlineCounts(entities, ctx = {}) {
  assertToday(ctx.today, 'deadlineCounts');
  const counts = {};
  for (const state of Object.values(S)) counts[state] = 0;
  for (const entity of toList(entities)) {
    if (!entity) continue;
    counts[deadlineInfo(entity, ctx).state] += 1;
  }
  return counts;
}
