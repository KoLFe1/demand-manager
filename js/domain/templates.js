// Modelos de demanda (funções puras): validação, modelo embutido e planejamento de datas.
//
// Formato de um modelo:
//   { id, name, description?, tasks: [{ key, name, offsetDays, durationDays, estimate_minutes?,
//     subtasks?: [{ name }], dependsOn: [keys] }] }
// • offsetDays  = dias ÚTEIS entre o início da demanda e o início da tarefa;
// • durationDays = duração em dias úteis (0 = marco: começa e termina no mesmo dia).
// Os modelos salvos ficam na configuração sincronizada 'templates' (lista); o embutido não é gravado.

import { addWorkdays, isValidDateStr } from '../core/dates.js';

export const MAX_TEMPLATES = 50;
export const MAX_TEMPLATE_TASKS = 100;
export const MAX_TEMPLATE_SUBTASKS = 50;
const MAX_DAYS = 3650;
const MAX_ESTIMATE_MINUTES = 10 * 365 * 24 * 60;
const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;

/** Erro de validação de modelo (code estável + mensagem em pt-BR). */
export class TemplateError extends Error {
  constructor(code, message, data = null) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
    this.data = data;
  }
}

const fail = (code, message, data) => {
  throw new TemplateError(code, message, data);
};

const RESOURCE_STEPS = [
  ['base', 'Base de dados', 3, 960],
  ['dominios', 'Domínios', 3, 960],
  ['variografia', 'Variografia', 2, 600],
  ['estimativa', 'Estimativa', 3, 960],
  ['validacao', 'Validação', 2, 600],
  ['classificacao', 'Classificação', 1, 360],
  ['relatorio', 'Relatório', 3, 960],
];

function chainedTasks(steps) {
  let offset = 0;
  return steps.map(([key, name, durationDays, estimate], i) => {
    const task = { key, name, offsetDays: offset, durationDays, estimate_minutes: estimate, subtasks: [], dependsOn: i ? [steps[i - 1][0]] : [] };
    offset += durationDays;
    return task;
  });
}

/** Modelos embutidos (somente leitura). */
export const BUILTIN_TEMPLATES = Object.freeze(
  [
    {
      id: 'builtin:recursos',
      name: 'Modelo de recursos',
      description: 'Estimativa de recursos minerais: da base de dados ao relatório, em sequência.',
      builtin: true,
      tasks: chainedTasks(RESOURCE_STEPS),
    },
  ].map((t) => deepFreeze(t)),
);

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

export const isBuiltinTemplate = (id) => typeof id === 'string' && BUILTIN_TEMPLATES.some((t) => t.id === id);

function text(value, field, { required = false, max = MAX_NAME } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) fail('invalid_template', `Informe ${field}.`, { field });
    return null;
  }
  if (typeof value !== 'string') fail('invalid_template', `${field[0].toUpperCase()}${field.slice(1)} precisa ser um texto.`, { field });
  const out = value.trim();
  if (!out && required) fail('invalid_template', `Informe ${field}.`, { field });
  if (out.length > max) fail('invalid_template', `${field[0].toUpperCase()}${field.slice(1)} pode ter no máximo ${max} caracteres.`, { field });
  return out || null;
}

function days(value, field, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (!Number.isInteger(value) || value < 0 || value > MAX_DAYS) fail('invalid_template', `${field} precisa ser um número inteiro de dias úteis, de 0 a ${MAX_DAYS}.`, { field, value });
  return value;
}

/**
 * Valida e normaliza um modelo. Rejeita chaves repetidas, dependências desconhecidas, ciclos e mais de
 * MAX_TEMPLATE_TASKS tarefas.
 * @param {object} t
 * @returns {object} modelo normalizado (novo objeto; sem `builtin`)
 * @throws {TemplateError} code: invalid_template | duplicate_key | unknown_dependency | cycle | too_many_tasks
 */
export function normalizeTemplate(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) fail('invalid_template', 'Modelo inválido.');
  const id = text(t.id, 'o identificador do modelo', { required: true, max: 100 });
  const name = text(t.name, 'o nome do modelo', { required: true });
  const description = text(t.description, 'a descrição do modelo', { max: MAX_DESCRIPTION });
  if (!Array.isArray(t.tasks)) fail('invalid_template', 'O modelo precisa de uma lista de tarefas.', { field: 'tasks' });
  if (t.tasks.length > MAX_TEMPLATE_TASKS) fail('too_many_tasks', `Um modelo pode ter no máximo ${MAX_TEMPLATE_TASKS} tarefas.`, { count: t.tasks.length });
  const keys = new Set();
  const tasks = t.tasks.map((task, i) => {
    if (!task || typeof task !== 'object') fail('invalid_template', `Tarefa ${i + 1} do modelo é inválida.`);
    const key = text(task.key, 'a chave da tarefa', { required: true, max: 100 });
    if (keys.has(key)) fail('duplicate_key', `Chave de tarefa repetida no modelo: ${key}.`, { key });
    keys.add(key);
    const out = {
      key,
      name: text(task.name, 'o nome da tarefa', { required: true }),
      offsetDays: days(task.offsetDays, 'O deslocamento', 0),
      durationDays: days(task.durationDays, 'A duração', 1),
    };
    const est = task.estimate_minutes;
    if (est !== null && est !== undefined && est !== '') {
      if (!Number.isInteger(est) || est < 0 || est > MAX_ESTIMATE_MINUTES) fail('invalid_template', 'A estimativa precisa ser um número inteiro de minutos.', { key });
      out.estimate_minutes = est;
    }
    const subs = task.subtasks === undefined || task.subtasks === null ? [] : task.subtasks;
    if (!Array.isArray(subs)) fail('invalid_template', 'As subtarefas precisam ser uma lista.', { key });
    if (subs.length > MAX_TEMPLATE_SUBTASKS) fail('too_many_tasks', `Uma tarefa de modelo pode ter no máximo ${MAX_TEMPLATE_SUBTASKS} subtarefas.`, { key });
    out.subtasks = subs.map((s) => ({ name: text(s && typeof s === 'object' ? s.name : s, 'o nome da subtarefa', { required: true }) }));
    const deps = task.dependsOn === undefined || task.dependsOn === null ? [] : task.dependsOn;
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || !d.trim())) fail('invalid_template', 'As dependências precisam ser uma lista de chaves.', { key });
    out.dependsOn = [...new Set(deps.map((d) => d.trim()))];
    if (out.dependsOn.includes(key)) fail('cycle', `A tarefa "${out.name}" não pode depender dela mesma.`, { key });
    return out;
  });
  for (const task of tasks) {
    for (const dep of task.dependsOn) if (!keys.has(dep)) fail('unknown_dependency', `A tarefa "${task.name}" depende de uma chave inexistente: ${dep}.`, { key: task.key, dep });
  }
  const cycle = findTemplateCycle(tasks);
  if (cycle) fail('cycle', `Dependências em ciclo no modelo: ${cycle.join(' → ')}.`, { path: cycle });
  const out = { id, name, tasks };
  if (description) out.description = description;
  return out;
}

/** Primeiro ciclo encontrado (lista de chaves, fechando no início) ou null. */
function findTemplateCycle(tasks) {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn]));
  const state = new Map(); // 1 = visitando, 2 = pronto
  const stack = [];
  const visit = (key) => {
    state.set(key, 1);
    stack.push(key);
    for (const dep of deps.get(key) || []) {
      if (state.get(dep) === 1) return [...stack.slice(stack.indexOf(dep)), dep];
      if (!state.get(dep)) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(key, 2);
    return null;
  };
  for (const t of tasks) {
    if (state.get(t.key)) continue;
    const found = visit(t.key);
    if (found) return found;
  }
  return null;
}

/**
 * Valida a lista de modelos salvos (configuração 'templates'): no máximo MAX_TEMPLATES, ids únicos e que não
 * colidem com os embutidos.
 * @returns {object[]} lista normalizada
 * @throws {TemplateError}
 */
export function normalizeTemplateList(list) {
  if (!Array.isArray(list)) fail('invalid_template', 'Os modelos precisam ser uma lista.');
  if (list.length > MAX_TEMPLATES) fail('too_many_templates', `É possível guardar no máximo ${MAX_TEMPLATES} modelos.`, { count: list.length });
  const ids = new Set();
  return list.map((item) => {
    const t = normalizeTemplate(item);
    if (ids.has(t.id) || isBuiltinTemplate(t.id)) fail('duplicate_key', `Identificador de modelo repetido: ${t.id}.`, { id: t.id });
    ids.add(t.id);
    return t;
  });
}

/** Modelos disponíveis: embutidos + salvos válidos (salvos inválidos vindos de sincronização são ignorados). */
export function availableTemplates(saved) {
  const out = [...BUILTIN_TEMPLATES];
  const ids = new Set(out.map((t) => t.id));
  for (const item of Array.isArray(saved) ? saved : []) {
    try {
      const t = normalizeTemplate(item);
      if (ids.has(t.id)) continue;
      ids.add(t.id);
      out.push(t);
    } catch {
      /* ignora modelo inválido */
    }
  }
  return out;
}

/**
 * Planeja as datas de um modelo. Sem `startDate` as tarefas ficam sem datas.
 * planned_start = início + offsetDays dias úteis; due_date = planned_start + (durationDays − 1) dias úteis
 * (fins de semana pulados).
 * @param {object} template
 * @param {{ startDate?: string|null }} [options]
 * @returns {{ start: string|null, end: string|null, tasks: object[] }}
 */
export function planTemplate(template, { startDate = null } = {}) {
  const t = normalizeTemplate(template);
  const start = isValidDateStr(startDate) ? addWorkdays(startDate, 0) : null;
  let end = null;
  const tasks = t.tasks.map((task) => {
    if (!start) return { ...task, planned_start: null, due_date: null };
    const planned = addWorkdays(start, task.offsetDays);
    const due = addWorkdays(planned, Math.max(0, task.durationDays - 1));
    if (!end || due > end) end = due;
    return { ...task, planned_start: planned, due_date: due };
  });
  return { start, end, tasks };
}
