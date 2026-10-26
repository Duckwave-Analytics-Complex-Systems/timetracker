-- TimeTrack cloud sync: run once in the Supabase SQL editor (safe to re-run).
--
-- The desktop app (src-tauri/src/sync.rs, src-tauri/src/db/sync.rs) and the
-- companion Android app both talk to these tables. Only source data is
-- synced: projects, phases, and closed sessions (time_entries). Totals and
-- per-day rows are derived on each device from time_entries.
--
-- Rows are never hard-deleted by the apps: a delete is pushed as
-- `deleted = true` (a tombstone) so other devices can see it.
-- `updated_at` is set by the server and is the pull cursor.
--
-- The running timer is one row per user in `timers`, changed only through
-- `push_timer()`, which enforces "one timer at a time" across devices.

-- ---------------------------------------------------------------- tables

create table if not exists public.projects (
  id               text primary key,
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  name             text,
  hourly_rate      double precision,
  created_at       bigint,            -- unix ms
  archived         boolean,
  archived_at      bigint,            -- unix ms
  logo_data        text,              -- small data: URL
  people_count     integer,
  description      text,
  start_day        text,              -- YYYY-MM-DD
  due_day          text,              -- YYYY-MM-DD
  budget_hours     double precision,
  active_phase_id  text,
  deleted          boolean not null default false,
  updated_at       timestamptz not null default clock_timestamp()
);

create table if not exists public.phases (
  id               text primary key,
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  project_id       text,
  name             text,
  kind             text,
  color            integer,
  start_day        text,
  end_day          text,
  estimated_hours  double precision,
  progress         integer,
  sort_order       integer,
  created_at       bigint,
  deleted          boolean not null default false,
  updated_at       timestamptz not null default clock_timestamp()
);

-- One row per closed session. Sessions closed after sync was added have the
-- id "<project_id>@<start_ms>", so two devices booking the same session
-- write the same row.
create table if not exists public.time_entries (
  id               text primary key,
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  project_id       text,
  start_ts         bigint,            -- unix ms
  end_ts           bigint,            -- unix ms
  seconds          bigint,
  phase_id         text,
  deleted          boolean not null default false,
  updated_at       timestamptz not null default clock_timestamp()
);

-- The current (or last) timer session of a user.
create table if not exists public.timers (
  user_id          uuid primary key default auth.uid() references auth.users on delete cascade,
  project_id       text,
  phase_id         text,
  started_at       bigint,            -- unix ms
  ended_at         bigint,            -- unix ms, set when stopped
  running          boolean not null default false,
  device_id        text,              -- device that started the session
  updated_at       timestamptz not null default clock_timestamp()
);

create index if not exists projects_user_updated     on public.projects (user_id, updated_at);
create index if not exists phases_user_updated       on public.phases (user_id, updated_at);
create index if not exists time_entries_user_updated on public.time_entries (user_id, updated_at);

-- ---------------------------------------------------------------- updated_at

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['projects', 'phases', 'time_entries', 'timers'] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format(
      'create trigger touch_updated_at before insert or update on public.%I
       for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- row level security

do $$
declare t text;
begin
  foreach t in array array['projects', 'phases', 'time_entries', 'timers'] loop
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format(
      'create policy own_rows on public.%I for all to authenticated
       using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- timer

-- op = 'start': becomes the current session if it started after the current
--               one (a newer start always wins).
-- op = 'stop':  stops the current session, but only if it is the session
--               named here (a stale stop never stops a newer session).
-- Returns the resulting row, which the caller reconciles against.
create or replace function public.push_timer(
  p_op text, p_project_id text, p_phase_id text,
  p_started_at bigint, p_ended_at bigint, p_device_id text
) returns public.timers
language plpgsql security invoker as $$
declare
  uid uuid := auth.uid();
  t public.timers;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;
  insert into public.timers (user_id) values (uid) on conflict (user_id) do nothing;
  select * into t from public.timers where user_id = uid for update;

  if p_op = 'start' then
    if t.started_at is null or p_started_at > t.started_at then
      update public.timers
         set project_id = p_project_id, phase_id = p_phase_id, started_at = p_started_at,
             ended_at = null, running = true, device_id = p_device_id
       where user_id = uid
      returning * into t;
    end if;
  elsif p_op = 'stop' then
    if t.running and t.project_id = p_project_id and t.started_at = p_started_at then
      update public.timers
         set running = false, ended_at = greatest(p_ended_at, p_started_at)
       where user_id = uid
      returning * into t;
    end if;
  else
    raise exception 'unknown op %', p_op;
  end if;
  return t;
end $$;

grant execute on function public.push_timer(text, text, text, bigint, bigint, text) to authenticated;
