// Status das atividades (demandas e tarefas). Puro, sem dependências.
//
// A lógica do sistema NUNCA depende do nome do status, e sim da sua CATEGORIA.
// Isso permite personalizar os status no futuro (renomear, recolorir, acrescentar)
// sem quebrar cálculos, métricas ou histórico.

/** Categorias (fixas) e o que cada uma significa para os cálculos. */
export const CATEGORIES = Object.freeze({
  backlog: Object.freeze({ id: 'backlog', label: 'Backlog', closed: false, started: false }),
  planned: Object.freeze({ id: 'planned', label: 'Planejada', closed: false, started: false }),
  active: Object.freeze({ id: 'active', label: 'Em andamento', closed: false, started: true }),
  waiting: Object.freeze({ id: 'waiting', label: 'Aguardando terceiros', closed: false, started: true }),
  blocked: Object.freeze({ id: 'blocked', label: 'Bloqueada', closed: false, started: true }),
  review: Object.freeze({ id: 'review', label: 'Em revisão', closed: false, started: true }),
  done: Object.freeze({ id: 'done', label: 'Concluída', closed: true, started: true }),
  cancelled: Object.freeze({ id: 'cancelled', label: 'Cancelada', closed: true, started: false }),
});

export const CATEGORY_IDS = Object.freeze(Object.keys(CATEGORIES));

/** Os 7 status pedidos + "Cancelada" (tratada à parte nos cálculos e escondida do Kanban). */
export const DEFAULT_STATUSES = Object.freeze([
  Object.freeze({ id: 'backlog', label: 'Backlog', category: 'backlog', color: 'gray', order: 10, description: 'Registrada, ainda não planejada' }),
  Object.freeze({ id: 'todo', label: 'Não iniciada', category: 'planned', color: 'slate', order: 20, description: 'Planejada, mas ainda não iniciada' }),
  Object.freeze({ id: 'doing', label: 'Em andamento', category: 'active', color: 'blue', order: 30, description: 'Em execução' }),
  Object.freeze({ id: 'waiting', label: 'Aguardando terceiros', category: 'waiting', color: 'amber', order: 40, description: 'Depende de informação ou ação externa' }),
  Object.freeze({ id: 'blocked', label: 'Bloqueada', category: 'blocked', color: 'red', order: 50, description: 'Não pode avançar por causa de um impedimento' }),
  Object.freeze({ id: 'review', label: 'Em revisão', category: 'review', color: 'violet', order: 60, description: 'Execução concluída, aguardando validação' }),
  Object.freeze({ id: 'done', label: 'Concluída', category: 'done', color: 'green', order: 70, description: 'Finalizada' }),
  Object.freeze({ id: 'cancelled', label: 'Cancelada', category: 'cancelled', color: 'neutral', order: 80, description: 'Não será feita', hiddenInBoard: true }),
]);

export const DEFAULT_STATUS_ID = 'backlog';

/** Categorias em que o trabalho já começou e ainda não terminou (item "em voo"). */
export const IN_FLIGHT_CATEGORIES = Object.freeze(['active', 'waiting', 'blocked', 'review']);

/**
 * Lista efetiva de status: padrões + personalização opcional (valor da configuração "statuses").
 * `custom` é um array de { id, label?, color?, order?, description?, category?, hidden? }:
 *   • id de um status padrão -> sobrescreve rótulo/cor/ordem/descrição (a categoria dos padrões não muda);
 *   • id novo com categoria válida e rótulo -> acrescenta um status (marcado com `custom: true`).
 * `hidden` (booleano) é repassado como está: indica à interface que o status não deve ser oferecido/mostrado.
 * Entradas inválidas são ignoradas. Sempre devolve uma lista nova, ordenada por `order` (e por rótulo no empate).
 */
export function resolveStatuses(custom) {
  const map = new Map(DEFAULT_STATUSES.map((s) => [s.id, { ...s }]));
  if (Array.isArray(custom)) {
    for (const c of custom) {
      if (!c || typeof c.id !== 'string' || !c.id) continue;
      const base = map.get(c.id);
      if (base) {
        if (typeof c.label === 'string' && c.label.trim()) base.label = c.label.trim();
        if (typeof c.color === 'string' && c.color) base.color = c.color;
        if (Number.isFinite(c.order)) base.order = c.order;
        if (typeof c.description === 'string') base.description = c.description;
        if (typeof c.hidden === 'boolean') base.hidden = c.hidden;
      } else if (typeof c.category === 'string' && Object.hasOwn(CATEGORIES, c.category) && typeof c.label === 'string' && c.label.trim()) {
        // Object.hasOwn: 'constructor', 'toString' etc. existem no protótipo, mas não são categorias.
        map.set(c.id, {
          id: c.id,
          label: c.label.trim(),
          category: c.category,
          color: typeof c.color === 'string' && c.color ? c.color : 'gray',
          order: Number.isFinite(c.order) ? c.order : 1000,
          description: typeof c.description === 'string' ? c.description : '',
          custom: true,
          ...(typeof c.hidden === 'boolean' ? { hidden: c.hidden } : {}),
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'pt-BR'));
}

/** Definição do status; id desconhecido devolve um status sintético "planejado" (dados de outra versão). */
export function statusById(statuses, id) {
  const list = statuses || DEFAULT_STATUSES;
  for (const s of list) if (s.id === id) return s;
  return { id: id || 'desconhecido', label: id ? String(id) : 'Sem status', category: 'planned', color: 'gray', order: 999, unknown: true };
}

export function categoryOf(statuses, id) {
  return statusById(statuses, id).category;
}

export const isDoneCategory = (cat) => cat === 'done';
export const isCancelledCategory = (cat) => cat === 'cancelled';
/** Encerrada = concluída ou cancelada. */
export const isClosedCategory = (cat) => cat === 'done' || cat === 'cancelled';
export const isOpenCategory = (cat) => !isClosedCategory(cat);
export const isInFlightCategory = (cat) => IN_FLIGHT_CATEGORIES.includes(cat);

export const isDone = (entity, statuses) => !!entity && categoryOf(statuses, entity.status) === 'done';
export const isCancelled = (entity, statuses) => !!entity && categoryOf(statuses, entity.status) === 'cancelled';
export const isClosed = (entity, statuses) => !!entity && isClosedCategory(categoryOf(statuses, entity.status));
/** Aberta = nem concluída nem cancelada (não olha arquivamento/exclusão). */
export const isOpen = (entity, statuses) => !!entity && !isClosed(entity, statuses);

/** Primeiro status da lista com a categoria pedida (ex.: firstOfCategory(st, 'done')). */
export function firstOfCategory(statuses, category) {
  const list = statuses || DEFAULT_STATUSES;
  return list.find((s) => s.category === category) || null;
}

/**
 * Calcula o que muda num registro ao trocar de status.
 *
 * Regras:
 *   • status e completed_at SEMPRE vão juntos no patch (mesmo que completed_at não mude):
 *     assim, na sincronização campo a campo, os dois nunca ficam incoerentes.
 *   • entrar em "concluída" grava completed_at = agora; sair de "concluída" (reabrir) zera completed_at.
 *   • a primeira vez que o trabalho começa (categoria em voo ou concluída) grava actual_start = agora.
 *   • `reopened` = saiu de "concluída" para um status ABERTO. Concluída -> cancelada não é reabertura
 *     (é `cancelled`), a mesma definição usada por completionInfo() em timeline.js.
 *
 * @returns {{ patch: object, from: {id, category}, to: {id, category},
 *             changed: boolean, completed: boolean, reopened: boolean, started: boolean, cancelled: boolean }}
 */
export function transitionPatch(entity, toStatusId, { statuses, nowIso }) {
  const from = statusById(statuses, entity.status);
  const to = statusById(statuses, toStatusId);
  const changed = from.id !== to.id;
  const wasDone = from.category === 'done';
  const willBeDone = to.category === 'done';
  const patch = { status: to.id };
  patch.completed_at = willBeDone ? (wasDone && entity.completed_at ? entity.completed_at : nowIso) : null;
  const begins = isInFlightCategory(to.category) || willBeDone;
  const started = begins && !entity.actual_start;
  if (started) patch.actual_start = nowIso;
  return {
    patch,
    from: { id: from.id, category: from.category },
    to: { id: to.id, category: to.category },
    changed,
    completed: changed && willBeDone && !wasDone,
    reopened: changed && wasDone && isOpenCategory(to.category),
    started,
    cancelled: changed && to.category === 'cancelled',
  };
}
