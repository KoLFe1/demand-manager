// Fonte única da verdade sobre as tabelas do Demand Manager.
// Usado pelo banco local (IndexedDB), pelo motor de sincronização e pelos testes do SQL.
// supabase/schema.sql precisa espelhar exatamente estas definições (há um teste que confere).
//
// Tipos de campo:
//   'uuid' | 'text' | 'int' | 'number' | 'bool' | 'date' (YYYY-MM-DD) | 'timestamp' (ISO UTC) | 'text[]' | 'json'
//
// Modos de tabela:
//   'lww'    -> registro mutável; conflito resolvido campo a campo pelo carimbo mais novo (field_ts)
//   'append' -> registro imutável (somente inserção); usado no histórico/auditoria

export const SCHEMA_VERSION = 2;

/** Nome do banco IndexedDB = DB_PREFIX + sufixo (ex.: "dm-local", "dm-<id do usuário>"). */
export const DB_PREFIX = 'dm-';

const f = (type, extra = {}) => Object.freeze({ type, ...extra });

const ID = f('uuid');
const TS = f('timestamp');

/** Campos presentes em toda tabela 'lww' com id uuid. */
const COMMON = { created_at: TS, updated_at: TS, deleted_at: TS };

/** Campos de execução compartilhados por demandas e tarefas. */
const WORK_ITEM = {
  name: f('text', { required: true }),
  description: f('text'),
  status: f('text', { default: 'backlog' }),
  priority: f('text', { default: 'P3' }),
  planned_start: f('date'),
  actual_start: TS,
  due_date: f('date'),
  completed_at: TS,
  estimate_minutes: f('int'),
  owner: f('text'),
  tags: f('text[]', { default: [] }),
  blocked_reason: f('text'),
  waiting_on: f('text'),
  sort_order: f('number', { default: 0 }),
  archived_at: TS,
};

/**
 * Tabelas na ORDEM DE ENVIO da sincronização (pais antes dos filhos, por causa das chaves estrangeiras).
 * `name` é o nome usado no app; `remote` é a tabela no Supabase.
 */
export const TABLES = Object.freeze([
  {
    name: 'settings',
    remote: 'dm_settings',
    mode: 'lww',
    idField: 'key',
    onConflict: 'user_id,key',
    softDelete: false,
    fields: {
      key: f('text', { required: true }),
      value: f('json'),
      updated_at: TS,
    },
  },
  {
    name: 'projects',
    remote: 'dm_projects',
    mode: 'lww',
    idField: 'id',
    onConflict: 'id',
    softDelete: true,
    fields: {
      id: ID,
      name: f('text', { required: true }),
      code: f('text'),
      color: f('text', { default: 'blue' }),
      description: f('text'),
      sort_order: f('number', { default: 0 }),
      archived_at: TS,
      ...COMMON,
    },
  },
  {
    name: 'demands',
    remote: 'dm_demands',
    mode: 'lww',
    idField: 'id',
    onConflict: 'id',
    softDelete: true,
    fields: {
      id: ID,
      seq: f('int', { server: true }), // número legível (D-12); o servidor garante unicidade
      project_id: f('uuid', { ref: 'projects' }),
      ...WORK_ITEM,
      objective: f('text'),
      deliverables: f('text'),
      next_action: f('text'),
      category: f('text'),
      ...COMMON,
    },
  },
  {
    name: 'tasks',
    remote: 'dm_tasks',
    mode: 'lww',
    idField: 'id',
    onConflict: 'id',
    softDelete: true,
    fields: {
      id: ID,
      seq: f('int', { server: true }), // número legível (T-123)
      demand_id: f('uuid', { ref: 'demands' }),
      parent_id: f('uuid', { ref: 'tasks' }), // preenchido = subtarefa (um nível só)
      ...WORK_ITEM,
      weight: f('number'), // peso (%) no progresso do pai; null = distribuição igualitária
      required: f('bool', { default: true }), // tarefa obrigatória entra no cálculo de progresso
      ...COMMON,
    },
  },
  {
    name: 'task_dependencies',
    remote: 'dm_task_dependencies',
    mode: 'lww',
    idField: 'id',
    onConflict: 'id',
    softDelete: true,
    fields: {
      id: ID,
      task_id: f('uuid', { ref: 'tasks', required: true }), // tarefa que depende
      depends_on_id: f('uuid', { ref: 'tasks', required: true }), // pré-requisito
      ...COMMON,
    },
  },
  {
    name: 'time_entries',
    remote: 'dm_time_entries',
    mode: 'lww',
    idField: 'id',
    onConflict: 'id',
    softDelete: true,
    fields: {
      id: ID,
      task_id: f('uuid', { ref: 'tasks', required: true }),
      entry_date: f('date'), // dia (local) do início
      started_at: TS,
      ended_at: TS,
      duration_seconds: f('int', { default: 0 }), // duração líquida (sem pausas)
      description: f('text'),
      state: f('text', { default: 'done' }), // 'running' | 'paused' | 'done'
      segment_started_at: TS, // início do trecho em curso (só quando running)
      accumulated_seconds: f('int', { default: 0 }), // somatório dos trechos já fechados
      source: f('text', { default: 'manual' }), // 'timer' | 'manual'
      ...COMMON,
    },
  },
  {
    name: 'week_items',
    remote: 'dm_week_items',
    mode: 'lww',
    idField: 'id',
    onConflict: 'id',
    softDelete: true,
    fields: {
      id: ID,
      week_start: f('date', { required: true }), // segunda-feira da semana
      task_id: f('uuid', { ref: 'tasks', required: true }),
      kind: f('text', { default: 'planned' }), // 'planned' (no planejamento) | 'added' (durante a semana)
      added_at: TS,
      removed_at: TS, // retirado do plano (o registro fica para o histórico)
      carried_from_id: f('uuid'), // item da semana anterior que originou este
      carried_to_week: f('date'), // semana para onde foi transferido
      ...COMMON,
    },
  },
  {
    name: 'notes',
    remote: 'dm_notes',
    mode: 'lww',
    idField: 'id',
    onConflict: 'id',
    softDelete: true,
    fields: {
      id: ID,
      entity_type: f('text', { required: true }), // 'demand' | 'task' | 'project'
      entity_id: f('uuid', { required: true }),
      body: f('text'),
      ...COMMON,
    },
  },
  {
    name: 'activity_log',
    remote: 'dm_activity_log',
    mode: 'append',
    idField: 'id',
    onConflict: 'id',
    softDelete: false,
    fields: {
      id: ID,
      entity_type: f('text', { required: true }), // 'project' | 'demand' | 'task'
      entity_id: f('uuid', { required: true }),
      action: f('text', { required: true }), // ver ACTIONS em js/domain/timeline.js
      field: f('text'),
      old_value: f('json'),
      new_value: f('json'),
      meta: f('json'),
      at: TS,
      device_id: f('text'),
    },
  },
].map((t) => Object.freeze({ ...t, fields: Object.freeze(t.fields) })));

const BY_NAME = new Map(TABLES.map((t) => [t.name, t]));

/** Descritor da tabela (lança erro se o nome não existir — pega erro de digitação cedo). */
export function tableDesc(name) {
  const t = BY_NAME.get(name);
  if (!t) throw new Error(`Tabela desconhecida: ${name}`);
  return t;
}

export const TABLE_NAMES = Object.freeze(TABLES.map((t) => t.name));

/** Campos de controle que não são dados do usuário. */
export const META_FIELDS = Object.freeze(['field_ts', 'server_seq', 'user_id']);

/** Valores padrão de uma tabela (cópia nova a cada chamada). */
export function defaultsFor(name) {
  const out = {};
  for (const [k, def] of Object.entries(tableDesc(name).fields)) {
    if (def.default !== undefined) out[k] = Array.isArray(def.default) ? [...def.default] : def.default;
    else out[k] = null;
  }
  return out;
}

/** Converte um valor vindo do servidor (ou de um backup) para o formato canônico do app. */
export function coerceValue(def, v) {
  if (v === undefined || v === null) {
    if (def.type === 'text[]') return [];
    return null;
  }
  switch (def.type) {
    case 'timestamp': {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    case 'date':
      return String(v).slice(0, 10);
    case 'int': {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    case 'number': {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case 'bool':
      return v === true || v === 'true' || v === 't' || v === 1;
    case 'text[]':
      return Array.isArray(v) ? v.map(String) : [];
    case 'json':
      return v;
    default:
      return String(v);
  }
}

/**
 * Linha do servidor -> linha local canônica (tipos normalizados, sem user_id).
 * Mantém field_ts (mapa campo -> carimbo em ms) e server_seq (número).
 */
export function fromRemoteRow(name, remote) {
  const desc = tableDesc(name);
  const row = {};
  for (const [k, def] of Object.entries(desc.fields)) row[k] = coerceValue(def, remote[k]);
  if (desc.mode === 'lww') {
    const ts = {};
    const src = remote.field_ts && typeof remote.field_ts === 'object' ? remote.field_ts : {};
    for (const [k, v] of Object.entries(src)) {
      const n = Number(v);
      if (Number.isFinite(n)) ts[k] = n;
    }
    row.field_ts = ts;
  }
  row.server_seq = remote.server_seq == null ? null : Number(remote.server_seq);
  return row;
}

/** Linha local -> objeto enviado ao servidor (todas as colunas, sempre na mesma ordem). */
export function toRemoteRow(name, row) {
  const desc = tableDesc(name);
  const out = {};
  for (const [k, def] of Object.entries(desc.fields)) {
    let v = row[k];
    if (v === undefined) v = def.default !== undefined ? def.default : null;
    out[k] = v;
  }
  if (desc.mode === 'lww') out.field_ts = row.field_ts || {};
  return out;
}

/** Rótulos legíveis (pt-BR) dos tipos de entidade. */
export const ENTITY_LABELS = Object.freeze({
  project: 'Projeto',
  demand: 'Demanda',
  task: 'Tarefa',
  subtask: 'Subtarefa',
});

/** Tabela que guarda cada tipo de entidade. */
export const ENTITY_TABLE = Object.freeze({ project: 'projects', demand: 'demands', task: 'tasks' });

/** Prefixo do código legível de cada tipo (D-12, T-123). */
export const SEQ_PREFIX = Object.freeze({ demand: 'D', task: 'T' });

export function entityCode(type, entity) {
  if (!entity || entity.seq == null) return '';
  return `${SEQ_PREFIX[type] || '#'}-${entity.seq}`;
}
