// Pessoas e cobranças ("Aguardando"). Puro: sem DOM, sem banco e sem relógio implícito.
//
// Conceitos:
//   • pessoa      = texto livre de `owner` (responsável) ou `waiting_on` (de quem se espera). Duas grafias são a
//                   mesma pessoa quando coincidem sem acentos, sem maiúsculas e sem espaços repetidos (personKey);
//   • aguardando  = item aberto na categoria 'waiting' (de quem: waiting_on) — aba "Aguardando terceiros";
//                   item aberto cujo responsável é outra pessoa (owner ≠ configuração 'owner.default')
//                   — aba "Com outras pessoas";
//   • cobrança    = evento 'followed_up' do histórico (ACTIONS.FOLLOW_UP); `follow_up_date` ("Cobrar em") é o
//                   dia em que se deve cobrar de novo.

import { addWorkdays, diffDays, isValidDateStr, isoToDateStr } from '../core/dates.js';
import { ACTIONS, statusIntervals } from './timeline.js';
import { firstOfCategory, statusById } from './statuses.js';

/** Dias úteis padrão até a próxima cobrança (configuração 'followup.defaultDays'). */
export const DEFAULT_FOLLOWUP_DAYS = 3;

/** Estados de "Cobrar em". */
export const FOLLOWUP_STATE = Object.freeze({ OVERDUE: 'overdue', TODAY: 'today', SCHEDULED: 'scheduled', NONE: 'none' });

/** Grafia de exibição: aparada e com espaços internos simples; '' para vazio/não texto. */
export function personName(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** Chave de comparação: sem acentos (NFD), minúsculas, espaços simples. '' para vazio. */
export function personKey(value) {
  return personName(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** As duas grafias são a mesma pessoa (vazio nunca casa)? */
export function samePerson(a, b) {
  const ka = personKey(a);
  return !!ka && ka === personKey(b);
}

/** O responsável é outra pessoa (preenchido e diferente do responsável padrão)? */
export function isOtherOwner(owner, defaultOwner) {
  const key = personKey(owner);
  return !!key && key !== personKey(defaultOwner);
}

/**
 * Estado do "Cobrar em".
 * @param {string|null} date 'YYYY-MM-DD'
 * @param {string} today
 * @returns {'overdue'|'today'|'scheduled'|'none'}
 */
export function followUpState(date, today) {
  if (!isValidDateStr(date)) return FOLLOWUP_STATE.NONE;
  if (date < today) return FOLLOWUP_STATE.OVERDUE;
  if (date === today) return FOLLOWUP_STATE.TODAY;
  return FOLLOWUP_STATE.SCHEDULED;
}

/** Cobrança vencida ou para hoje (conta no selo da navegação)? */
export const isFollowUpDue = (date, today) => {
  const state = followUpState(date, today);
  return state === FOLLOWUP_STATE.OVERDUE || state === FOLLOWUP_STATE.TODAY;
};

/**
 * Informações de exibição do "Cobrar em".
 * @returns {{ state, date, label, tone: 'danger'|'warn'|'neutral'|'muted', daysLate: number }}
 */
export function followUpInfo(date, today) {
  const state = followUpState(date, today);
  if (state === FOLLOWUP_STATE.NONE) return { state, date: null, label: 'Sem data de cobrança', tone: 'muted', daysLate: 0 };
  if (state === FOLLOWUP_STATE.OVERDUE) {
    const daysLate = diffDays(date, today);
    return { state, date, label: daysLate === 1 ? 'Cobrança atrasada 1 dia' : `Cobrança atrasada ${daysLate} dias`, tone: 'danger', daysLate };
  }
  if (state === FOLLOWUP_STATE.TODAY) return { state, date, label: 'Cobrar hoje', tone: 'warn', daysLate: 0 };
  return { state, date, label: 'Cobrança agendada', tone: 'neutral', daysLate: 0 };
}

/** Próxima data de cobrança: `days` dias úteis depois de hoje (padrão 3). */
export function nextFollowUpDate(today, days = DEFAULT_FOLLOWUP_DAYS) {
  const n = Number.isInteger(days) && days >= 0 ? days : DEFAULT_FOLLOWUP_DAYS;
  return addWorkdays(today, n);
}

/**
 * Instante (ISO) em que o item entrou na situação atual de espera.
 *   mode 'waiting': `from` do intervalo de status vigente (statusIntervals; pode ser sintético);
 *   mode 'owner'  : última troca de responsável (evento 'updated' do campo owner) ou a criação.
 * @param {object} entity demanda ou tarefa
 * @param {object[]} events eventos DESSA entidade, em ordem cronológica
 * @param {{ statuses: Array, nowIso: string, mode?: 'waiting'|'owner' }} ctx
 * @returns {string|null}
 */
export function waitingSince(entity, events, { statuses, nowIso, mode = 'waiting' }) {
  if (!entity) return null;
  const list = events || [];
  if (mode === 'owner') {
    for (let i = list.length - 1; i >= 0; i--) {
      const ev = list[i];
      if (ev.action === ACTIONS.UPDATED && ev.field === 'owner' && personKey(ev.new_value)) return ev.at;
    }
    const created = list.find((e) => e.action === ACTIONS.CREATED);
    return entity.created_at || (created && created.at) || null;
  }
  const intervals = statusIntervals(entity, list, { statuses, nowIso });
  const last = intervals[intervals.length - 1];
  return last ? last.from : null;
}

/** Dias corridos desde o instante (data local) até hoje; 0 sem instante. */
export function daysSince(iso, today) {
  const day = iso ? isoToDateStr(iso) : null;
  if (!day || !isValidDateStr(today)) return 0;
  return Math.max(0, diffDays(day, today));
}

/** Último evento de cobrança (ou null). `events` em ordem cronológica. */
export function lastFollowUp(events) {
  const list = events || [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i].action === ACTIONS.FOLLOW_UP) return list[i];
  return null;
}

/**
 * Status para "Retomar" um item em espera: o status anterior à espera (histórico), se ainda for um status aberto
 * fora da espera; senão o primeiro status da categoria 'active'.
 * @returns {string} id do status
 */
export function resumeStatusId(entity, events, { statuses, nowIso }) {
  const intervals = statusIntervals(entity, events || [], { statuses, nowIso });
  for (let i = intervals.length - 2; i >= 0; i--) {
    const cat = intervals[i].category;
    if (cat === 'waiting') continue;
    const st = statusById(statuses, intervals[i].status);
    if (!st.unknown && cat !== 'done' && cat !== 'cancelled') return st.id;
    break;
  }
  const active = firstOfCategory(statuses, 'active');
  return active ? active.id : 'doing';
}

/**
 * Pessoas conhecidas a partir de valores soltos (responsáveis e "aguardando"), agrupadas por personKey.
 * A grafia exibida é a mais recente (maior `at`).
 * @param {Array<{ name: string, at?: string, role?: 'owner'|'waiting' }>} entries
 * @returns {Array<{ key, name, count, owner, waiting }>} ordenadas por uso (desc) e nome
 */
export function collectPeople(entries) {
  const byKey = new Map();
  for (const entry of entries || []) {
    const name = personName(entry && entry.name);
    const key = personKey(name);
    if (!key) continue;
    let p = byKey.get(key);
    if (!p) byKey.set(key, (p = { key, name, at: '', count: 0, owner: 0, waiting: 0 }));
    const at = String(entry.at || '');
    if (at >= p.at) {
      p.at = at;
      p.name = name;
    }
    p.count += 1;
    if (entry.role === 'owner') p.owner += 1;
    if (entry.role === 'waiting') p.waiting += 1;
  }
  return [...byKey.values()]
    .map(({ at, ...rest }) => rest)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt-BR'));
}
