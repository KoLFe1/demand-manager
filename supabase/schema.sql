-- =============================================================================
--  Demand Manager — banco de dados no Supabase                (esquema versão 3)
-- =============================================================================
--
--  COMO USAR
--    1. No painel do Supabase abra "SQL Editor" → "New query".
--    2. Cole este arquivo INTEIRO e clique em "Run".
--    3. O resultado deve mostrar: "Demand Manager: banco pronto (versão 3)".
--
--  O editor pode avisar que a consulta tem operações "destrutivas" (drop policy /
--  drop trigger). É esperado: o script apenas recria as regras de acesso e os
--  gatilhos. NENHUM DADO É APAGADO.
--
--  O script é IDEMPOTENTE: pode ser executado de novo a qualquer momento (por
--  exemplo depois de atualizar o aplicativo). Ele cria o que falta, acrescenta as
--  colunas novas e mantém todos os dados. Compatível com PostgreSQL 15 ou superior.
--
--  O QUE ELE CRIA
--    • As tabelas dm_* — espelho exato de js/data/schema.js (mesmos nomes de coluna).
--      Toda linha pertence a um usuário (user_id) e só ele a enxerga e altera (RLS).
--    • Exclusão é sempre LÓGICA (deleted_at): ninguém recebe permissão de DELETE.
--    • Sincronização entre dispositivos:
--        - server_seq  número de ordem global, renovado a cada gravação; cada aparelho
--                      baixa apenas as linhas com server_seq maior que o último visto;
--        - field_ts    mapa "coluna → carimbo de tempo (ms)" da última alteração de
--                      cada coluna. Quando dois aparelhos alteram a mesma linha, o
--                      gatilho dm_before_write resolve COLUNA A COLUNA: vence o
--                      carimbo mais novo (empate mantém o que já estava gravado).
--    • dm_demands e dm_tasks recebem um número legível por usuário (seq: D-12, T-123).
--    • dm_activity_log é o histórico: só aceita inclusão (nunca alteração/exclusão).
--    • dm_schema_version() informa ao aplicativo a versão instalada deste esquema.
--
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Contador global de alterações
-- -----------------------------------------------------------------------------
create sequence if not exists public.dm_server_seq as bigint;


-- -----------------------------------------------------------------------------
-- 2. Tabelas
--    Cada tabela nasce só com a chave primária; as colunas vêm em seguida por
--    "add column if not exists". Assim a MESMA lista cria uma instalação nova e
--    atualiza uma instalação antiga (colunas que já existem são ignoradas).
--
--    Colunas de controle (não são dados do usuário):
--      user_id     dono da linha (preenchido pelo servidor com o usuário logado)
--      field_ts    carimbos por coluna (tabelas mutáveis)
--      server_seq  número de ordem atribuído pelo servidor
-- -----------------------------------------------------------------------------

-- Configurações do usuário (chave → valor JSON). Chave primária: (user_id, key).
create table if not exists public.dm_settings (
  user_id uuid not null default auth.uid(),
  key     text not null,
  constraint dm_settings_pkey primary key (user_id, key)
);
alter table public.dm_settings
  add column if not exists user_id    uuid        not null default auth.uid(),
  add column if not exists key        text        not null,
  add column if not exists value      jsonb,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists field_ts   jsonb       not null default '{}'::jsonb,
  add column if not exists server_seq bigint      not null default 0;

-- Projetos.
create table if not exists public.dm_projects (
  id uuid not null default gen_random_uuid(),
  constraint dm_projects_pkey primary key (id)
);
alter table public.dm_projects
  add column if not exists id          uuid             not null default gen_random_uuid(),
  add column if not exists user_id     uuid             not null default auth.uid(),
  add column if not exists name        text,
  add column if not exists code        text,
  add column if not exists color       text             default 'blue',
  add column if not exists description text,
  add column if not exists sort_order  double precision default 0,
  add column if not exists archived_at timestamptz,
  add column if not exists created_at  timestamptz      default now(),
  add column if not exists updated_at  timestamptz      default now(),
  add column if not exists deleted_at  timestamptz,
  add column if not exists field_ts    jsonb            not null default '{}'::jsonb,
  add column if not exists server_seq  bigint           not null default 0;

-- Demandas (seq = número legível D-12, único por usuário).
create table if not exists public.dm_demands (
  id uuid not null default gen_random_uuid(),
  constraint dm_demands_pkey primary key (id)
);
alter table public.dm_demands
  add column if not exists id               uuid             not null default gen_random_uuid(),
  add column if not exists user_id          uuid             not null default auth.uid(),
  add column if not exists seq              integer,
  add column if not exists project_id       uuid,
  add column if not exists name             text,
  add column if not exists description      text,
  add column if not exists status           text             default 'backlog',
  add column if not exists priority         text             default 'P3',
  add column if not exists planned_start    date,
  add column if not exists actual_start     timestamptz,
  add column if not exists due_date         date,
  add column if not exists completed_at     timestamptz,
  add column if not exists estimate_minutes integer,
  add column if not exists owner            text,
  add column if not exists tags             text[]           default '{}'::text[],
  add column if not exists blocked_reason   text,
  add column if not exists waiting_on       text,
  add column if not exists sort_order       double precision default 0,
  add column if not exists archived_at      timestamptz,
  add column if not exists follow_up_date   date,
  add column if not exists objective        text,
  add column if not exists deliverables     text,
  add column if not exists next_action      text,
  add column if not exists category         text,
  add column if not exists created_at       timestamptz      default now(),
  add column if not exists updated_at       timestamptz      default now(),
  add column if not exists deleted_at       timestamptz,
  add column if not exists field_ts         jsonb            not null default '{}'::jsonb,
  add column if not exists server_seq       bigint           not null default 0;

-- Tarefas e subtarefas (parent_id preenchido = subtarefa; seq = número legível T-123).
create table if not exists public.dm_tasks (
  id uuid not null default gen_random_uuid(),
  constraint dm_tasks_pkey primary key (id)
);
alter table public.dm_tasks
  add column if not exists id               uuid             not null default gen_random_uuid(),
  add column if not exists user_id          uuid             not null default auth.uid(),
  add column if not exists seq              integer,
  add column if not exists demand_id        uuid,
  add column if not exists parent_id        uuid,
  add column if not exists name             text,
  add column if not exists description      text,
  add column if not exists status           text             default 'backlog',
  add column if not exists priority         text             default 'P3',
  add column if not exists planned_start    date,
  add column if not exists actual_start     timestamptz,
  add column if not exists due_date         date,
  add column if not exists completed_at     timestamptz,
  add column if not exists estimate_minutes integer,
  add column if not exists owner            text,
  add column if not exists tags             text[]           default '{}'::text[],
  add column if not exists blocked_reason   text,
  add column if not exists waiting_on       text,
  add column if not exists sort_order       double precision default 0,
  add column if not exists archived_at      timestamptz,
  add column if not exists weight           double precision,
  add column if not exists required         boolean          default true,
  add column if not exists follow_up_date   date,
  add column if not exists recurrence       jsonb,
  add column if not exists created_at       timestamptz      default now(),
  add column if not exists updated_at       timestamptz      default now(),
  add column if not exists deleted_at       timestamptz,
  add column if not exists field_ts         jsonb            not null default '{}'::jsonb,
  add column if not exists server_seq       bigint           not null default 0;

-- Dependências: task_id depende de depends_on_id.
create table if not exists public.dm_task_dependencies (
  id uuid not null default gen_random_uuid(),
  constraint dm_task_dependencies_pkey primary key (id)
);
alter table public.dm_task_dependencies
  add column if not exists id            uuid        not null default gen_random_uuid(),
  add column if not exists user_id       uuid        not null default auth.uid(),
  add column if not exists task_id       uuid,
  add column if not exists depends_on_id uuid,
  add column if not exists created_at    timestamptz default now(),
  add column if not exists updated_at    timestamptz default now(),
  add column if not exists deleted_at    timestamptz,
  add column if not exists field_ts      jsonb       not null default '{}'::jsonb,
  add column if not exists server_seq    bigint      not null default 0;

-- Apontamentos de tempo e cronômetros.
create table if not exists public.dm_time_entries (
  id uuid not null default gen_random_uuid(),
  constraint dm_time_entries_pkey primary key (id)
);
alter table public.dm_time_entries
  add column if not exists id                  uuid        not null default gen_random_uuid(),
  add column if not exists user_id             uuid        not null default auth.uid(),
  add column if not exists task_id             uuid,
  add column if not exists entry_date          date,
  add column if not exists started_at          timestamptz,
  add column if not exists ended_at            timestamptz,
  add column if not exists duration_seconds    integer     default 0,
  add column if not exists description         text,
  add column if not exists state               text        default 'done',
  add column if not exists segment_started_at  timestamptz,
  add column if not exists accumulated_seconds integer     default 0,
  add column if not exists source              text        default 'manual',
  add column if not exists created_at          timestamptz default now(),
  add column if not exists updated_at          timestamptz default now(),
  add column if not exists deleted_at          timestamptz,
  add column if not exists field_ts            jsonb       not null default '{}'::jsonb,
  add column if not exists server_seq          bigint      not null default 0;

-- Planejamento semanal (tarefa × semana).
create table if not exists public.dm_week_items (
  id uuid not null default gen_random_uuid(),
  constraint dm_week_items_pkey primary key (id)
);
alter table public.dm_week_items
  add column if not exists id              uuid        not null default gen_random_uuid(),
  add column if not exists user_id         uuid        not null default auth.uid(),
  add column if not exists week_start      date,
  add column if not exists task_id         uuid,
  add column if not exists kind            text        default 'planned',
  add column if not exists added_at        timestamptz,
  add column if not exists removed_at      timestamptz,
  add column if not exists carried_from_id uuid,
  add column if not exists carried_to_week date,
  add column if not exists created_at      timestamptz default now(),
  add column if not exists updated_at      timestamptz default now(),
  add column if not exists deleted_at      timestamptz,
  add column if not exists field_ts        jsonb       not null default '{}'::jsonb,
  add column if not exists server_seq      bigint      not null default 0;

-- Observações datadas de projeto/demanda/tarefa (entity_type + entity_id).
create table if not exists public.dm_notes (
  id uuid not null default gen_random_uuid(),
  constraint dm_notes_pkey primary key (id)
);
alter table public.dm_notes
  add column if not exists id          uuid        not null default gen_random_uuid(),
  add column if not exists user_id     uuid        not null default auth.uid(),
  add column if not exists entity_type text,
  add column if not exists entity_id   uuid,
  add column if not exists body        text,
  add column if not exists created_at  timestamptz default now(),
  add column if not exists updated_at  timestamptz default now(),
  add column if not exists deleted_at  timestamptz,
  add column if not exists field_ts    jsonb       not null default '{}'::jsonb,
  add column if not exists server_seq  bigint      not null default 0;

-- Links (URL ou caminho de arquivo/pasta) de projeto/demanda/tarefa (entity_type + entity_id). Versão 3.
create table if not exists public.dm_links (
  id uuid not null default gen_random_uuid(),
  constraint dm_links_pkey primary key (id)
);
alter table public.dm_links
  add column if not exists id          uuid             not null default gen_random_uuid(),
  add column if not exists user_id     uuid             not null default auth.uid(),
  add column if not exists entity_type text,
  add column if not exists entity_id   uuid,
  add column if not exists label       text,
  add column if not exists target      text,
  add column if not exists kind        text,
  add column if not exists sort_order  double precision default 0,
  add column if not exists created_at  timestamptz      default now(),
  add column if not exists updated_at  timestamptz      default now(),
  add column if not exists deleted_at  timestamptz,
  add column if not exists field_ts    jsonb            not null default '{}'::jsonb,
  add column if not exists server_seq  bigint           not null default 0;

-- Histórico imutável (auditoria): só recebe inclusões; não tem field_ts.
create table if not exists public.dm_activity_log (
  id uuid not null default gen_random_uuid(),
  constraint dm_activity_log_pkey primary key (id)
);
alter table public.dm_activity_log
  add column if not exists id          uuid        not null default gen_random_uuid(),
  add column if not exists user_id     uuid        not null default auth.uid(),
  add column if not exists entity_type text,
  add column if not exists entity_id   uuid,
  add column if not exists action      text,
  add column if not exists field       text,
  add column if not exists old_value   jsonb,
  add column if not exists new_value   jsonb,
  add column if not exists meta        jsonb,
  add column if not exists "at"        timestamptz,
  add column if not exists device_id   text,
  add column if not exists server_seq  bigint      not null default 0;

comment on table public.dm_settings          is 'Demand Manager: configurações do usuário (chave → valor JSON)';
comment on table public.dm_projects          is 'Demand Manager: projetos';
comment on table public.dm_demands           is 'Demand Manager: demandas';
comment on table public.dm_tasks             is 'Demand Manager: tarefas e subtarefas';
comment on table public.dm_task_dependencies is 'Demand Manager: dependências entre tarefas';
comment on table public.dm_time_entries      is 'Demand Manager: apontamentos de tempo';
comment on table public.dm_week_items        is 'Demand Manager: planejamento semanal';
comment on table public.dm_notes             is 'Demand Manager: observações';
comment on table public.dm_links             is 'Demand Manager: links (URL ou caminho)';
comment on table public.dm_activity_log      is 'Demand Manager: histórico imutável (somente inclusão)';


-- -----------------------------------------------------------------------------
-- 3. Chaves estrangeiras (criadas só se ainda não existirem)
--    Os dados do aplicativo nunca são apagados de verdade (exclusão lógica), então
--    as ações abaixo só acontecem numa limpeza manual ou ao excluir o usuário.
-- -----------------------------------------------------------------------------
do $do$
declare
  fk record;
begin
  for fk in
    select *
      from (values
        -- dono da linha: excluir o usuário apaga tudo que é dele
        ('dm_settings',          'user_id',       'auth.users',         'cascade'),
        ('dm_projects',          'user_id',       'auth.users',         'cascade'),
        ('dm_demands',           'user_id',       'auth.users',         'cascade'),
        ('dm_tasks',             'user_id',       'auth.users',         'cascade'),
        ('dm_task_dependencies', 'user_id',       'auth.users',         'cascade'),
        ('dm_time_entries',      'user_id',       'auth.users',         'cascade'),
        ('dm_week_items',        'user_id',       'auth.users',         'cascade'),
        ('dm_notes',             'user_id',       'auth.users',         'cascade'),
        ('dm_links',             'user_id',       'auth.users',         'cascade'),
        ('dm_activity_log',      'user_id',       'auth.users',         'cascade'),
        -- hierarquia: o vínculo opcional é desfeito; o que não existe sem a tarefa vai junto
        ('dm_demands',           'project_id',    'public.dm_projects', 'set null'),
        ('dm_tasks',             'demand_id',     'public.dm_demands',  'set null'),
        ('dm_tasks',             'parent_id',     'public.dm_tasks',    'set null'),
        ('dm_task_dependencies', 'task_id',       'public.dm_tasks',    'cascade'),
        ('dm_task_dependencies', 'depends_on_id', 'public.dm_tasks',    'cascade'),
        ('dm_time_entries',      'task_id',       'public.dm_tasks',    'cascade'),
        ('dm_week_items',        'task_id',       'public.dm_tasks',    'cascade')
      ) as v (tbl, col, target, on_delete)
  loop
    if not exists (
      select 1
        from pg_catalog.pg_constraint c
       where c.conrelid = format('public.%I', fk.tbl)::regclass
         and c.conname = fk.tbl || '_' || fk.col || '_fkey'
    ) then
      execute format(
        'alter table public.%I add constraint %I foreign key (%I) references %s (id) on delete %s',
        fk.tbl, fk.tbl || '_' || fk.col || '_fkey', fk.col, fk.target, fk.on_delete
      );
    end if;
  end loop;
end
$do$;


-- -----------------------------------------------------------------------------
-- 4. Índices
-- -----------------------------------------------------------------------------
-- A sincronização baixa "linhas do usuário com server_seq maior que X, em ordem".
create index if not exists dm_settings_user_id_server_seq_idx          on public.dm_settings          (user_id, server_seq);
create index if not exists dm_projects_user_id_server_seq_idx          on public.dm_projects          (user_id, server_seq);
create index if not exists dm_demands_user_id_server_seq_idx           on public.dm_demands           (user_id, server_seq);
create index if not exists dm_tasks_user_id_server_seq_idx             on public.dm_tasks             (user_id, server_seq);
create index if not exists dm_task_dependencies_user_id_server_seq_idx on public.dm_task_dependencies (user_id, server_seq);
create index if not exists dm_time_entries_user_id_server_seq_idx      on public.dm_time_entries      (user_id, server_seq);
create index if not exists dm_week_items_user_id_server_seq_idx        on public.dm_week_items        (user_id, server_seq);
create index if not exists dm_notes_user_id_server_seq_idx             on public.dm_notes             (user_id, server_seq);
create index if not exists dm_links_user_id_server_seq_idx             on public.dm_links             (user_id, server_seq);
create index if not exists dm_activity_log_user_id_server_seq_idx      on public.dm_activity_log      (user_id, server_seq);

-- Número legível: único por usuário (garantia final; quem numera é o gatilho dm_assign_seq).
create unique index if not exists dm_demands_user_id_seq_key on public.dm_demands (user_id, seq);
create unique index if not exists dm_tasks_user_id_seq_key   on public.dm_tasks   (user_id, seq);

-- Colunas que apontam para outras tabelas.
create index if not exists dm_demands_project_id_idx              on public.dm_demands           (project_id);
create index if not exists dm_tasks_demand_id_idx                 on public.dm_tasks             (demand_id);
create index if not exists dm_tasks_parent_id_idx                 on public.dm_tasks             (parent_id);
create index if not exists dm_task_dependencies_task_id_idx       on public.dm_task_dependencies (task_id);
create index if not exists dm_task_dependencies_depends_on_id_idx on public.dm_task_dependencies (depends_on_id);
create index if not exists dm_time_entries_task_id_idx            on public.dm_time_entries      (task_id);
create index if not exists dm_week_items_task_id_idx              on public.dm_week_items        (task_id);


-- -----------------------------------------------------------------------------
-- 5. Funções
--    Todas com search_path fixo (vazio) e SEM "security definer": rodam com as
--    permissões de quem grava, portanto continuam sujeitas à segurança por linha.
-- -----------------------------------------------------------------------------

-- Gatilho de gravação das tabelas mutáveis (uma única função serve a todas).
--
--   INSERT  define o dono (usuário logado), saneia os carimbos e numera server_seq.
--   UPDATE  junta a linha recebida com a gravada COLUNA A COLUNA (last-writer-wins):
--           o valor recebido só substitui o gravado se o carimbo recebido daquela
--           coluna for ESTRITAMENTE maior que o carimbo gravado (ausente = 0). O
--           field_ts resultante guarda, por coluna, o carimbo do valor que venceu.
--           Identidade (id/key), dono, created_at e seq nunca mudam; updated_at fica
--           com o maior dos dois; server_seq é renovado.
--
--   Carimbos vindos do cliente são limitados a "agora + 5 minutos": um aparelho com
--   o relógio adiantado não consegue travar um campo para os demais.
--
--   server_seq é numerado sob uma trava do USUÁRIO que dura até o fim da transação
--   (pg_advisory_xact_lock em 'dm_sync:<usuário>'). Sem ela, uma transação longa (um lote
--   de 200 linhas) que pegou números MENORES poderia ficar visível DEPOIS de outra, com
--   números maiores, que um aparelho já baixou — e o cursor desse aparelho ("server_seq
--   maior que X") pularia aquelas linhas. Com a trava, as gravações de um mesmo usuário
--   recebem números na ordem em que ficam visíveis. Usuários diferentes não se esperam.
create or replace function public.dm_before_write()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  control_cols constant text[] := array['id', 'key', 'user_id', 'field_ts', 'server_seq', 'created_at', 'updated_at', 'seq'];
  now_ms       constant numeric := floor(extract(epoch from now()) * 1000);
  ts_limit     constant numeric := now_ms + 300000;  -- agora + 5 min, em milissegundos
  incoming     jsonb;                 -- linha recebida, em JSON
  stored       jsonb;                 -- linha gravada, em JSON
  in_stamps    jsonb;                 -- carimbos recebidos (só números inteiros, já limitados)
  old_stamps   jsonb;                 -- carimbos gravados
  stamps       jsonb;                 -- carimbos resultantes
  winners      jsonb := '{}'::jsonb;  -- colunas em que o valor recebido venceu
  col          text;
  in_ts        numeric;
  old_ts       numeric;
  newest       timestamptz;
begin
  -- Carimbos recebidos: descarta o que não for número, arredonda para baixo e limita a [0, agora + 5 min].
  select coalesce(jsonb_object_agg(e.key, least(greatest(floor((e.value #>> '{}')::numeric), 0), ts_limit)), '{}'::jsonb)
    into in_stamps
    from jsonb_each(case when jsonb_typeof(new.field_ts) = 'object' then new.field_ts else '{}'::jsonb end) as e
   where jsonb_typeof(e.value) = 'number';

  if tg_op = 'INSERT' then
    -- Num upsert ("insert ... on conflict do update") este trecho também roda para a linha
    -- proposta de um registro que já existe; o merge de verdade acontece no trecho de UPDATE.
    new.user_id    := coalesce(auth.uid(), new.user_id);
    new.field_ts   := in_stamps;
    if new.user_id is not null then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dm_sync:' || new.user_id::text, 0));
    end if;
    new.server_seq := nextval('public.dm_server_seq');
    return new;
  end if;

  -- Trava do usuário antes de numerar (ver o comentário acima da função).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dm_sync:' || old.user_id::text, 0));

  incoming   := to_jsonb(new);
  stored     := to_jsonb(old);
  old_stamps := case when jsonb_typeof(old.field_ts) = 'object' then old.field_ts else '{}'::jsonb end;
  stamps     := old_stamps;

  if pg_trigger_depth() > 1 then
    -- Alteração feita pelo próprio banco de dados (ex.: chave estrangeira "on delete set null"
    -- quando o registro pai é apagado numa limpeza manual). Aqui o servidor é a autoridade: o
    -- valor é aceito como veio (desfazê-lo quebraria a integridade referencial) e a coluna
    -- recebe um carimbo novo, para que os aplicativos também aceitem a mudança.
    for col in select jsonb_object_keys(incoming) loop
      continue when col = any (control_cols);
      if (incoming -> col) is distinct from (stored -> col) then
        old_ts := case when jsonb_typeof(old_stamps -> col) = 'number' then (old_stamps ->> col)::numeric else 0 end;
        stamps := stamps || jsonb_build_object(col, greatest(now_ms, floor(old_ts) + 1));
        newest := now();
      end if;
    end loop;
    new.field_ts   := stamps;
    new.updated_at := greatest(old.updated_at, new.updated_at, newest);
    new.server_seq := nextval('public.dm_server_seq');
    return new;
  end if;

  for col in select jsonb_object_keys(incoming) loop
    continue when col = any (control_cols);
    in_ts  := coalesce((in_stamps ->> col)::numeric, 0);
    old_ts := case when jsonb_typeof(old_stamps -> col) = 'number' then (old_stamps ->> col)::numeric else 0 end;
    if in_ts > old_ts then
      winners := winners || jsonb_build_object(col, incoming -> col);
      stamps  := stamps  || jsonb_build_object(col, in_stamps -> col);
    end if;
  end loop;

  -- Parte da linha GRAVADA e aplica só as colunas vencedoras: o que não venceu (e as colunas
  -- de identidade, dono, created_at e seq) permanece exatamente como estava.
  newest := greatest(old.updated_at, new.updated_at);
  new := jsonb_populate_record(old, winners);
  new.field_ts   := stamps;
  new.updated_at := newest;
  new.server_seq := nextval('public.dm_server_seq');
  return new;
end
$fn$;

-- Número legível (seq) de demandas e tarefas, único por usuário.
--   INSERT  sem número, ou com número já usado por OUTRO registro do mesmo usuário
--           (dois aparelhos numeraram offline), recebe "maior número do usuário + 1".
--   UPDATE  o número nunca muda.
-- Precisa disparar ANTES de dm_before_write: o Postgres executa gatilhos do mesmo tipo
-- em ordem alfabética do nome (dm_trg_10_seq < dm_trg_20_write).
create or replace function public.dm_assign_seq()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  owner_id uuid;
  taken    boolean := false;
begin
  if tg_op = 'UPDATE' then
    new.seq := old.seq;
    return new;
  end if;

  owner_id := coalesce(auth.uid(), new.user_id);
  if owner_id is null then
    return new;  -- sem dono a gravação é recusada logo adiante (user_id é obrigatório)
  end if;

  -- Primeiro a trava de server_seq do usuário (a mesma de dm_before_write), para as duas
  -- travas serem sempre pegas na mesma ordem.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dm_sync:' || owner_id::text, 0));
  -- Uma numeração por vez para cada usuário/tabela (a trava vale até o fim da transação).
  perform pg_advisory_xact_lock(hashtextextended('dm_seq:' || tg_table_name || ':' || owner_id::text, 0));

  if new.seq is not null and new.seq > 0 then
    execute format('select exists (select 1 from %I.%I where user_id = $1 and seq = $2 and id is distinct from $3)',
                   tg_table_schema, tg_table_name)
       into taken
      using owner_id, new.seq, new.id;
  end if;

  -- Num upsert de registro que já existe o número calculado aqui é descartado: o trecho de
  -- UPDATE acima devolve o número gravado.
  if new.seq is null or new.seq < 1 or taken then
    execute format('select coalesce(max(seq), 0) + 1 from %I.%I where user_id = $1',
                   tg_table_schema, tg_table_name)
       into new.seq
      using owner_id;
  end if;
  return new;
end
$fn$;

-- Histórico: define apenas o dono e o número de ordem.
create or replace function public.dm_before_insert_log()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.user_id    := coalesce(auth.uid(), new.user_id);
  if new.user_id is not null then
    -- Mesma trava de dm_before_write: numeração na ordem em que as gravações ficam visíveis.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dm_sync:' || new.user_id::text, 0));
  end if;
  new.server_seq := nextval('public.dm_server_seq');
  return new;
end
$fn$;

-- Versão deste esquema (igual a SCHEMA_VERSION em js/data/schema.js).
--   1  versão inicial
--   2  server_seq numerado sob a trava do usuário (o cursor de sincronização não pula linhas)
--   3  tarefas: recurrence (repetição) e follow_up_date ("Cobrar em"); demandas: follow_up_date;
--      tabela nova dm_links. Rodar este script num banco versão 2 só acrescenta (dados mantidos).
create or replace function public.dm_schema_version()
returns integer
language sql
immutable
set search_path = ''
as $fn$
  select 3
$fn$;

comment on function public.dm_schema_version() is 'Demand Manager: versão instalada do esquema do banco';


-- -----------------------------------------------------------------------------
-- 6. Gatilhos, segurança por linha (RLS) e permissões — iguais para todas as tabelas
--    (regras e gatilhos são removidos e recriados para o script poder ser repetido)
-- -----------------------------------------------------------------------------
do $do$
declare
  mutable  constant text[] := array['dm_settings', 'dm_projects', 'dm_demands', 'dm_tasks',
                                    'dm_task_dependencies', 'dm_time_entries', 'dm_week_items', 'dm_notes',
                                    'dm_links'];
  numbered constant text[] := array['dm_demands', 'dm_tasks'];
  history  constant text   := 'dm_activity_log';
  t        text;
begin
  foreach t in array mutable || history loop
    -- Gatilhos
    execute format('drop trigger if exists dm_trg_10_seq on public.%I', t);
    execute format('drop trigger if exists dm_trg_20_write on public.%I', t);
    if t = any (numbered) then
      execute format('create trigger dm_trg_10_seq before insert or update on public.%I
                        for each row execute function public.dm_assign_seq()', t);
    end if;
    if t = history then
      execute format('create trigger dm_trg_20_write before insert on public.%I
                        for each row execute function public.dm_before_insert_log()', t);
    else
      execute format('create trigger dm_trg_20_write before insert or update on public.%I
                        for each row execute function public.dm_before_write()', t);
    end if;

    -- Segurança por linha: cada usuário só enxerga e grava as próprias linhas.
    -- Não existe regra de DELETE (a exclusão é lógica) e o histórico não tem regra de UPDATE.
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('create policy %I on public.%I for select to authenticated
                      using (user_id = (select auth.uid()))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated
                      with check (user_id = (select auth.uid()))', t || '_insert', t);
    if t <> history then
      execute format('create policy %I on public.%I for update to authenticated
                        using (user_id = (select auth.uid()))
                        with check (user_id = (select auth.uid()))', t || '_update', t);
    end if;

    -- Permissões: visitante (anon) não acessa nada; usuário logado lê, inclui e altera
    -- (no histórico só lê e inclui). Ninguém recebe DELETE nem TRUNCATE.
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    if t = history then
      execute format('grant select, insert on table public.%I to authenticated', t);
    else
      execute format('grant select, insert, update on table public.%I to authenticated', t);
    end if;
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end
$do$;

revoke all on sequence public.dm_server_seq from public, anon, authenticated;
grant usage on sequence public.dm_server_seq to authenticated;
grant all on sequence public.dm_server_seq to service_role;

-- As funções de gatilho não são chamadas diretamente por ninguém (o banco as dispara).
revoke all on function public.dm_before_write()      from public, anon, authenticated;
revoke all on function public.dm_assign_seq()        from public, anon, authenticated;
revoke all on function public.dm_before_insert_log() from public, anon, authenticated;

-- A versão é uma constante sem dados de usuário: anon pode consultá-la para o botão "Testar conexão"
-- funcionar antes do login.
revoke all on function public.dm_schema_version() from public;
grant execute on function public.dm_schema_version() to anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 7. Confirmação
-- -----------------------------------------------------------------------------
select format('Demand Manager: banco pronto (versão %s)', public.dm_schema_version()) as resultado;
