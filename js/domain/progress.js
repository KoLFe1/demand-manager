// Percentual de conclusão (regra 14 do pedido: "Regras de cálculo"). Puro e determinístico.
//
// Resumo das regras:
//   1. Só entram no cálculo as tarefas de NÍVEL SUPERIOR da demanda que sejam CONTÁVEIS: obrigatórias
//      (`required !== false`), não arquivadas, não excluídas e não canceladas. Opcionais, canceladas e
//      arquivadas ficam de fora e são devolvidas à parte (contagens), só para informação.
//   2. Fração de uma tarefa: concluída → 1; senão, se tem subtarefas contáveis → soma dos pesos efetivos das
//      subtarefas concluídas; senão 0. Subtarefas contam SOMENTE através do pai (nunca duas vezes).
//   3. Pesos (`weight`, em %) valem entre irmãos contáveis — ver effectiveWeights().
//   4. Progresso da demanda = Σ (peso efetivo × fração). O cálculo segue a hierarquia; não é a simples
//      quantidade de registros concluídos.
//
// Hierarquia inconsistente (dados vindos de outro dispositivo): tarefa cujo pai não existe, foi excluído,
// é de outra demanda, é ela mesma ou faz parte de um ciclo é tratada como tarefa de nível superior.

import { categoryOf, isCancelled, isDone, isInFlightCategory } from './statuses.js';

/** Avisos sobre os pesos informados (o cálculo continua valendo; o aviso só explica o ajuste feito). */
export const WEIGHT_WARNINGS = Object.freeze({
  /** Todos os itens têm peso, mas a soma não é 100: os pesos foram usados proporcionalmente. */
  SUM_NOT_100: 'sum_not_100',
  /** Só parte dos itens tem peso e esses pesos já somam 100 ou mais: os itens sem peso receberam a média. */
  MIXED_OVER_100: 'mixed_over_100',
});

/** Motivos pelos quais uma tarefa fica fora do cálculo de progresso. */
export const EXCLUSION_REASONS = Object.freeze({
  DELETED: 'deleted',
  ARCHIVED: 'archived',
  CANCELLED: 'cancelled',
  OPTIONAL: 'optional',
});

/** Tolerância (em pontos percentuais) ao comparar a soma dos pesos com 100. */
const WEIGHT_TOLERANCE = 0.01;

/** Folga numérica ao decidir se uma fração chegou a 1 (erros de ponto flutuante). */
const EPSILON = 1e-9;

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Aceita array ou qualquer iterável de objetos; qualquer outra coisa vira lista vazia. */
function toList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && typeof value[Symbol.iterator] === 'function') return [...value];
  return [];
}

/** Itens válidos (objetos com id), sem repetir id — a primeira ocorrência vence. */
function uniqueById(items) {
  const seen = new Set();
  const out = [];
  for (const item of toList(items)) {
    if (!item || item.id == null || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** Percentual inteiro; só chega a 100 quando está tudo completo (0,996 não pode virar "100%"). */
function toPercent(value, complete) {
  if (complete) return 100;
  return Math.min(99, Math.max(0, Math.round(value * 100)));
}

/**
 * Um peso está "definido" quando é um número finito maior que zero.
 * null, undefined, 0, negativo, NaN ou texto contam como "sem peso".
 *
 * @param {*} weight
 * @returns {boolean}
 */
export function isWeightDefined(weight) {
  return typeof weight === 'number' && Number.isFinite(weight) && weight > 0;
}

/**
 * Por que a tarefa fica fora do cálculo de progresso (um único motivo, nesta ordem de precedência).
 *
 * @param {object|null} task
 * @param {Array} [statuses] lista efetiva de status
 * @returns {null|'deleted'|'archived'|'cancelled'|'optional'} null = a tarefa é contável.
 *   Tarefa inexistente (null/undefined) devolve 'deleted'.
 */
export function exclusionReason(task, statuses) {
  if (!task || task.deleted_at) return EXCLUSION_REASONS.DELETED;
  if (task.archived_at) return EXCLUSION_REASONS.ARCHIVED;
  if (isCancelled(task, statuses)) return EXCLUSION_REASONS.CANCELLED;
  if (task.required === false) return EXCLUSION_REASONS.OPTIONAL;
  return null;
}

/**
 * A tarefa entra no cálculo de progresso? (obrigatória, não arquivada, não excluída e não cancelada)
 *
 * @param {object|null} task
 * @param {Array} [statuses] lista efetiva de status
 * @returns {boolean}
 */
export function isCountable(task, statuses) {
  return exclusionReason(task, statuses) === null;
}

/**
 * Pesos efetivos entre irmãos contáveis.
 *
 * Regras (peso "definido" = número finito > 0; ver isWeightDefined):
 *   • ninguém tem peso      → distribuição igualitária (`total` = 100);
 *   • todos têm peso        → cada um vale peso ÷ soma (`total` = soma); aviso `sum_not_100` se a soma ≠ 100
 *                             (com soma 100, o progresso é exatamente a soma dos pesos concluídos);
 *   • só parte tem peso:
 *       soma < 100          → os sem peso dividem igualmente o que falta para 100 (`total` = 100);
 *       soma ≥ 100          → os sem peso recebem a média dos pesos definidos e tudo é normalizado
 *                             (`total` = soma + média × quantidade sem peso); aviso `mixed_over_100`.
 * A comparação com 100 tolera 0,01 ponto percentual.
 *
 * @param {Iterable<{ id: *, weight?: number|null }>} items irmãos contáveis (itens nulos, sem id ou de id repetido são ignorados)
 * @returns {{ weights: Map<*, number>, warning: null|'sum_not_100'|'mixed_over_100', total: number }}
 *   `weights` id → fração (0..1); as frações sempre somam 1 (lista vazia → mapa vazio).
 *   `total`   soma dos pesos efetivos em pontos percentuais, antes de normalizar (lista vazia → 0).
 */
export function effectiveWeights(items) {
  const list = uniqueById(items);
  const weights = new Map();
  const count = list.length;
  if (count === 0) return { weights, warning: null, total: 0 };

  let definedSum = 0;
  let definedCount = 0;
  for (const item of list) {
    if (isWeightDefined(item.weight)) {
      definedSum += item.weight;
      definedCount += 1;
    }
  }
  const missingCount = count - definedCount;

  if (definedCount === 0) {
    for (const item of list) weights.set(item.id, 1 / count);
    return { weights, warning: null, total: 100 };
  }

  if (missingCount === 0) {
    for (const item of list) weights.set(item.id, item.weight / definedSum);
    const warning = Math.abs(definedSum - 100) > WEIGHT_TOLERANCE ? WEIGHT_WARNINGS.SUM_NOT_100 : null;
    return { weights, warning, total: definedSum };
  }

  if (definedSum < 100 - WEIGHT_TOLERANCE) {
    const share = (100 - definedSum) / missingCount;
    for (const item of list) weights.set(item.id, (isWeightDefined(item.weight) ? item.weight : share) / 100);
    return { weights, warning: null, total: 100 };
  }

  const mean = definedSum / definedCount;
  const total = definedSum + mean * missingCount;
  for (const item of list) weights.set(item.id, (isWeightDefined(item.weight) ? item.weight : mean) / total);
  return { weights, warning: WEIGHT_WARNINGS.MIXED_OVER_100, total };
}

/**
 * Texto (pt-BR) que explica um aviso de pesos para o usuário.
 *
 * @param {null|'sum_not_100'|'mixed_over_100'} warning código devolvido por effectiveWeights/demandProgress
 * @param {number} [total] `total` devolvido por effectiveWeights (usado na mensagem de `sum_not_100`)
 * @returns {string} '' quando não há aviso.
 */
export function weightWarningText(warning, total) {
  if (warning === WEIGHT_WARNINGS.SUM_NOT_100) {
    if (Number.isFinite(total)) {
      const sum = Number(total.toFixed(2)).toLocaleString('pt-BR');
      return `Os pesos somam ${sum}% em vez de 100%: o progresso considera os pesos proporcionalmente.`;
    }
    return 'Os pesos não somam 100%: o progresso considera os pesos proporcionalmente.';
  }
  if (warning === WEIGHT_WARNINGS.MIXED_OVER_100) {
    return 'Os pesos definidos já somam 100% ou mais: as tarefas sem peso receberam a média dos pesos definidos e o total foi ajustado proporcionalmente.';
  }
  return '';
}

/**
 * Separa as tarefas em nível superior e subtarefas, tolerando hierarquia inconsistente.
 *
 * Uma tarefa só é SUBTAREFA quando o pai (`parent_id`) existe na lista, não está excluído, não é ela mesma,
 * não é de outra demanda (`demand_id` diferente, quando os dois estão preenchidos) e é de nível superior (não
 * aponta para outro pai existente). Em qualquer outro caso — pai inexistente/excluído/de outra demanda,
 * autorreferência, ciclo, "subtarefa de subtarefa" — a tarefa é tratada como de NÍVEL SUPERIOR.
 * Assim nenhuma tarefa viva some e a hierarquia tem sempre um nível só.
 *
 * @param {Iterable<object>} tasks tarefas e subtarefas (excluídas, nulas, sem id e ids repetidos são ignorados)
 * @returns {{ roots: object[], childrenOf: Map<*, object[]> }}
 *   `roots` tarefas de nível superior, na ordem recebida; `childrenOf` id do pai → subtarefas, na ordem recebida.
 */
export function buildTaskTree(tasks) {
  const alive = uniqueById(tasks).filter((task) => !task.deleted_at);
  const byId = new Map(alive.map((task) => [task.id, task]));

  const parentOf = (task) => {
    if (task.parent_id == null || task.parent_id === task.id) return null;
    const parent = byId.get(task.parent_id);
    if (!parent) return null;
    const foreign = parent.demand_id != null && task.demand_id != null && parent.demand_id !== task.demand_id;
    return foreign ? null : parent;
  };

  const roots = [];
  const childrenOf = new Map();
  for (const task of alive) {
    const parent = parentOf(task);
    if (parent && !parentOf(parent)) {
      const siblings = childrenOf.get(parent.id);
      if (siblings) siblings.push(task);
      else childrenOf.set(parent.id, [task]);
    } else {
      roots.push(task);
    }
  }
  return { roots, childrenOf };
}

/**
 * Fração concluída (0..1) de UMA tarefa.
 *
 *   • tarefa concluída                 → 1 (não importa o estado das subtarefas)       `source: 'status'`
 *   • senão, com subtarefas contáveis  → soma dos pesos efetivos das subtarefas CONCLUÍDAS `source: 'subtasks'`
 *                                        (effectiveWeights entre as subtarefas contáveis)
 *   • senão                            → 0                                              `source: 'none'`
 *
 * @param {object|null} task a tarefa (inexistente → fração 0, `source: 'none'`)
 * @param {Iterable<object>} subtasks subtarefas dessa tarefa, em qualquer estado (as não contáveis são ignoradas)
 * @param {{ statuses?: Array }} [ctx]
 * @returns {{ value: number, done: boolean, source: 'status'|'subtasks'|'none', counted: number, completed: number }}
 *   `done` a própria tarefa está concluída; `counted` quantidade de subtarefas contáveis;
 *   `completed` quantas delas estão concluídas (informado também quando a tarefa já está concluída).
 */
export function taskFraction(task, subtasks, { statuses } = {}) {
  if (!task) return { value: 0, done: false, source: 'none', counted: 0, completed: 0 };
  const countable = uniqueById(subtasks).filter((sub) => sub.id !== task.id && isCountable(sub, statuses));
  const finished = countable.filter((sub) => isDone(sub, statuses));
  const counted = countable.length;
  const completed = finished.length;

  if (isDone(task, statuses)) return { value: 1, done: true, source: 'status', counted, completed };
  if (counted === 0) return { value: 0, done: false, source: 'none', counted: 0, completed: 0 };

  let value;
  if (completed === counted) value = 1;
  else if (completed === 0) value = 0;
  else {
    const { weights } = effectiveWeights(countable);
    value = clamp01(finished.reduce((sum, sub) => sum + weights.get(sub.id), 0));
  }
  return { value, done: false, source: 'subtasks', counted, completed };
}

/**
 * Progresso de uma demanda a partir das suas tarefas.
 *
 * Só as tarefas de NÍVEL SUPERIOR contáveis recebem peso (effectiveWeights); cada uma contribui com
 * peso × fração (taskFraction). Subtarefas entram apenas pela fração do pai. Subtarefas de um pai que
 * ficou fora do cálculo (opcional, cancelado, arquivado) também ficam fora.
 *
 * @param {object|null} demand a demanda (usa `id` e `status`)
 * @param {Iterable<object>} tasks TODAS as tarefas não excluídas da demanda, subtarefas inclusive, em qualquer
 *        estado. Por segurança, tarefas excluídas e tarefas de outra demanda (quando os dois ids são conhecidos)
 *        são ignoradas.
 * @param {{ statuses?: Array }} [ctx]
 * @returns {{ value: number|null, percent: number|null, counted: number, completed: number, inProgress: number,
 *             optional: number, cancelled: number, archived: number,
 *             warning: null|'sum_not_100'|'mixed_over_100', items: Array<{ id: *, weight: number, fraction: number }> }}
 *   `value`      Σ peso × fração (0..1). Sem tarefas contáveis: 1 se a demanda está concluída, senão null
 *                (a interface mostra "—").
 *   `percent`    Math.round(value × 100), mas só chega a 100 quando todas as tarefas contadas estão CONCLUÍDAS
 *                pelo próprio status (enquanto faltar algo — inclusive uma tarefa aberta cujas subtarefas já
 *                terminaram — no máximo 99); null quando `value` é null.
 *   `counted`    tarefas de nível superior contáveis; `completed` quantas delas estão concluídas;
 *   `inProgress` quantas não estão concluídas mas já têm algo feito (fração > 0) ou estão num status "em voo".
 *   `optional` / `cancelled` / `archived` tarefas de nível superior deixadas de fora, cada uma contada uma única
 *                vez (precedência: arquivada, cancelada, opcional).
 *   `warning`    aviso de effectiveWeights sobre os pesos das tarefas de nível superior.
 *   `items`      uma entrada por tarefa contada: `weight` = peso efetivo (0..1), `fraction` = fração concluída (0..1).
 */
export function demandProgress(demand, tasks, { statuses } = {}) {
  const demandId = demand && demand.id != null ? demand.id : null;
  const own = toList(tasks).filter((task) => task && (demandId === null || task.demand_id == null || task.demand_id === demandId));
  const { roots, childrenOf } = buildTaskTree(own);

  const countable = [];
  let optional = 0;
  let cancelled = 0;
  let archived = 0;
  for (const task of roots) {
    const reason = exclusionReason(task, statuses);
    if (reason === null) countable.push(task);
    else if (reason === EXCLUSION_REASONS.ARCHIVED) archived += 1;
    else if (reason === EXCLUSION_REASONS.CANCELLED) cancelled += 1;
    else if (reason === EXCLUSION_REASONS.OPTIONAL) optional += 1;
  }

  if (countable.length === 0) {
    const done = isDone(demand, statuses);
    return {
      value: done ? 1 : null,
      percent: done ? 100 : null,
      counted: 0,
      completed: 0,
      inProgress: 0,
      optional,
      cancelled,
      archived,
      warning: null,
      items: [],
    };
  }

  const { weights, warning } = effectiveWeights(countable);
  const items = [];
  let sum = 0;
  let completed = 0;
  let inProgress = 0;
  let complete = true;
  for (const task of countable) {
    const fraction = taskFraction(task, childrenOf.get(task.id), { statuses });
    const weight = weights.get(task.id);
    items.push({ id: task.id, weight, fraction: fraction.value });
    sum += weight * fraction.value;
    if (fraction.done) completed += 1;
    else if (fraction.value > 0 || isInFlightCategory(categoryOf(statuses, task.status))) inProgress += 1;
    // Completa só com a PRÓPRIA tarefa concluída: subtarefas todas feitas não encerram a tarefa obrigatória.
    if (!fraction.done) complete = false;
  }

  const value = complete ? 1 : clamp01(sum);
  return {
    value,
    percent: toPercent(value, complete),
    counted: countable.length,
    completed,
    inProgress,
    optional,
    cancelled,
    archived,
    warning,
    items,
  };
}

/**
 * Progresso de um projeto: média simples do progresso das suas demandas.
 *
 * @param {Iterable<{ value: number|null }>} list uma entrada por demanda NÃO arquivada e NÃO cancelada do projeto
 *        (pode ser o próprio resultado de demandProgress). Entradas nulas ou com `value` nulo/inválido — demanda
 *        sem tarefas contáveis — não entram na média.
 * @returns {{ value: number|null, percent: number|null, counted: number }}
 *   `value` média (0..1) ou null quando nenhuma demanda tem progresso; `percent` inteiro, que só chega a 100
 *   quando todas as demandas contadas estão em 100%; `counted` quantas demandas entraram na média.
 */
export function projectProgress(list) {
  let sum = 0;
  let counted = 0;
  let complete = true;
  for (const entry of toList(list)) {
    const raw = entry ? entry.value : null;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const value = clamp01(raw);
    sum += value;
    counted += 1;
    if (value < 1 - EPSILON) complete = false;
  }
  if (counted === 0) return { value: null, percent: null, counted: 0 };
  const value = complete ? 1 : clamp01(sum / counted);
  return { value, percent: toPercent(value, complete), counted };
}
