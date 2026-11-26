// Prioridades (P1–P4). Puro, sem dependências.

export const PRIORITIES = Object.freeze([
  Object.freeze({ id: 'P1', label: 'Crítica', rank: 1, tone: 'p1', description: 'Não pode esperar: impacto alto e prazo curto' }),
  Object.freeze({ id: 'P2', label: 'Alta', rank: 2, tone: 'p2', description: 'Importante: fazer logo depois das críticas' }),
  Object.freeze({ id: 'P3', label: 'Média', rank: 3, tone: 'p3', description: 'Trabalho normal planejado' }),
  Object.freeze({ id: 'P4', label: 'Baixa', rank: 4, tone: 'p4', description: 'Pode esperar; fazer quando houver folga' }),
]);

export const DEFAULT_PRIORITY = 'P3';

const BY_ID = new Map(PRIORITIES.map((p) => [p.id, p]));

/** Definição da prioridade (id desconhecido cai na padrão). */
export function priorityById(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_PRIORITY);
}

/** 1 (mais urgente) … 4. */
export function priorityRank(id) {
  return priorityById(id).rank;
}

/** Comparador: P1 primeiro. Aceita ids ou objetos com .priority. */
export function comparePriority(a, b) {
  const pa = typeof a === 'string' || a == null ? a : a.priority;
  const pb = typeof b === 'string' || b == null ? b : b.priority;
  return priorityRank(pa) - priorityRank(pb);
}

/** Um nível acima (P3 -> P2); P1 continua P1. */
export function raisePriority(id) {
  const r = priorityRank(id);
  return PRIORITIES[Math.max(0, r - 2)].id;
}

/** Um nível abaixo (P3 -> P4); P4 continua P4. */
export function lowerPriority(id) {
  const r = priorityRank(id);
  return PRIORITIES[Math.min(PRIORITIES.length - 1, r)].id;
}
