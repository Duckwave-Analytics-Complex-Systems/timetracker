-- TimeTrack cloud sync: run once in the Supabase SQL editor (safe to re-run).
--
-- The desktop app (src-tauri/src/sync.rs, src-tauri/src/db/sync.rs) and the
-- companion Android app both talk to these tables. Only source data is
-- synced: projects, features, phases, and closed sessions (time_entries). Totals and
-- per-day rows are derived on each device from time_entries.
--
-- Rows are never hard-deleted by the apps: a delete is pushed as
-- `deleted = true` (a tombstone) so other devices can see it.
-- `updated_at` is set by the server and is the pull cursor.
--
-- The running timer is one row per user in `timers`, changed only through
-- `push_timer()`, which enforces "one timer at a time" across devices.
--
-- Sharing: `project_members` says who is in a project, and it's what gives access
-- to a project's rows. Only the owner (`projects.user_id`) can change the project
-- row or its members. Any member can change phases and features, but only their
-- own time entries. `profiles` and `project_members` can only be reached through
-- the functions at the end, so nobody can browse the list of users.

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
  final_payment    double precision,  -- total paid, entered when the project is ended
  active_phase_id  text,
  active_feature_id text,
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

-- Named pieces of work, tracked independently of phases.
create table if not exists public.features (
  id               text primary key,
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  project_id       text,
  name             text,
  color            integer,
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
  feature_id       text,
  note             text,              -- what was done in this session
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

-- A person's name and the code others use to add them to a project.
create table if not exists public.profiles (
  id               uuid primary key references auth.users on delete cascade,
  display_name     text not null,
  share_code       text not null unique
);

-- Who is in each project. The owner has a row too.
create table if not exists public.project_members (
  project_id       text not null references public.projects on delete cascade,
  user_id          uuid not null references auth.users on delete cascade,
  role             text not null check (role in ('owner', 'member')),
  created_at       timestamptz not null default clock_timestamp(),
  primary key (project_id, user_id)
);

-- Which phase and feature a person's new time is booked to. One row per person
-- per project, with the id "<project_id>:<user_id>". Private to that person.
create table if not exists public.member_state (
  id                text primary key,
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  project_id        text,
  active_phase_id   text,
  active_feature_id text,
  deleted           boolean not null default false,
  updated_at        timestamptz not null default clock_timestamp()
);

-- "Did you leave anything pending?": a person's checklist per project, from the
-- dialog shown when a session stops. Private to that person, even on a shared project.
create table if not exists public.pending_items (
  id               text primary key,
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  project_id       text,
  entry_id         text,              -- the session it was written after, if any
  text             text,
  done             boolean not null default false,
  created_at       bigint,            -- unix ms
  done_at          bigint,            -- unix ms
  deleted          boolean not null default false,
  updated_at       timestamptz not null default clock_timestamp()
);

-- The devices a person uses, refreshed on each sync. Only for the Profile's
-- device list; nothing else depends on it.
create table if not exists public.devices (
  id               text not null,     -- the app's own install id (sync_meta device_id)
  user_id          uuid not null default auth.uid() references auth.users on delete cascade,
  name             text,
  platform         text,              -- 'android' | 'windows' | 'macos' | 'linux'
  app_version      text,
  last_seen_at     bigint,            -- unix ms
  updated_at       timestamptz not null default clock_timestamp(),
  primary key (user_id, id)
);

-- Columns added after these tables first shipped (databases that already exist).
alter table public.projects add column if not exists active_feature_id text;
alter table public.time_entries add column if not exists feature_id text;
alter table public.time_entries add column if not exists note text;
alter table public.projects add column if not exists final_payment double precision;

-- Profile v2 (Android 2.4). The desktop reads only display_name and share_code.
alter table public.profiles add column if not exists avatar_kind text not null default 'initials';
alter table public.profiles add column if not exists avatar_preset text;     -- '01', '02', ... (bundled image)
alter table public.profiles add column if not exists avatar_color integer;   -- palette slot 0..7, for initials
alter table public.profiles add column if not exists avatar_data text;       -- photo: small JPEG data: URL
alter table public.profiles add column if not exists currency text not null default 'USD';
alter table public.profiles add column if not exists week_start integer not null default 1;  -- 1 = Monday, 0 = Sunday
alter table public.profiles add column if not exists weekly_goal_hours double precision;
alter table public.profiles add column if not exists work_days integer not null default 31;  -- bit 0 = Monday .. bit 6 = Sunday
alter table public.profiles add column if not exists work_start text not null default '09:00';
alter table public.profiles add column if not exists work_end text not null default '18:00';
alter table public.profiles add column if not exists default_rate double precision;
alter table public.profiles add column if not exists updated_at timestamptz not null default clock_timestamp();

-- Time someone tracked stays on a shared project after they delete their
-- account (see delete_my_account), so it must not go with their user row. The
-- apps show it under "Former members".
alter table public.time_entries drop constraint if exists time_entries_user_id_fkey;

create index if not exists project_members_user       on public.project_members (user_id);
create index if not exists phases_project             on public.phases (project_id);
create index if not exists features_project           on public.features (project_id);
create index if not exists time_entries_project       on public.time_entries (project_id);
create index if not exists member_state_user_updated  on public.member_state (user_id, updated_at);
create index if not exists features_user_updated     on public.features (user_id, updated_at);
create index if not exists projects_user_updated     on public.projects (user_id, updated_at);
create index if not exists phases_user_updated       on public.phases (user_id, updated_at);
create index if not exists time_entries_user_updated on public.time_entries (user_id, updated_at);
create index if not exists pending_items_user_updated on public.pending_items (user_id, updated_at);

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
  foreach t in array array[
    'projects', 'features', 'phases', 'time_entries', 'timers', 'member_state', 'profiles', 'pending_items', 'devices'
  ] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', t);
    execute format(
      'create trigger touch_updated_at before insert or update on public.%I
       for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- row level security

-- Every project has its owner as a member, including those from before sharing.
insert into public.project_members (project_id, user_id, role)
select id, user_id, 'owner' from public.projects where not deleted
on conflict do nothing;

-- Runs without row level security, so the policies below can use it on
-- project_members without looping back into themselves.
create or replace function public.is_project_member(p_project_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_members
    where project_id = p_project_id and user_id = auth.uid()
  )
$$;

create or replace function public.add_project_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.user_id, 'owner')
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists add_project_owner on public.projects;
create trigger add_project_owner after insert on public.projects
for each row when (not new.deleted) execute function public.add_project_owner();

-- Deleting a phase or feature unassigns everyone's time, which its deleter
-- couldn't do through their own access.
create or replace function public.unassign_deleted_phase() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.time_entries set phase_id = null where phase_id = new.id;
  update public.member_state set active_phase_id = null where active_phase_id = new.id;
  return new;
end $$;

create or replace function public.unassign_deleted_feature() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.time_entries set feature_id = null where feature_id = new.id;
  update public.member_state set active_feature_id = null where active_feature_id = new.id;
  return new;
end $$;

drop trigger if exists unassign_deleted on public.phases;
create trigger unassign_deleted after update of deleted on public.phases
for each row when (new.deleted and not old.deleted) execute function public.unassign_deleted_phase();

drop trigger if exists unassign_deleted on public.features;
create trigger unassign_deleted after update of deleted on public.features
for each row when (new.deleted and not old.deleted) execute function public.unassign_deleted_feature();

-- The apps read and upsert these. No delete: a delete is a tombstone. A row
-- with no project is a tombstone for a row the server never had.
do $$
declare t text;
begin
  foreach t in array array[
    'projects', 'features', 'phases', 'time_entries', 'timers', 'member_state', 'pending_items', 'devices'
  ] loop
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
  end loop;

  -- Only ever your own.
  foreach t in array array['timers', 'member_state', 'pending_items', 'devices'] loop
    execute format(
      'create policy own_rows on public.%I for all to authenticated
       using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;

  -- The schedule belongs to every member of the project.
  foreach t in array array['phases', 'features'] loop
    execute format('drop policy if exists member_read on public.%I', t);
    execute format('drop policy if exists member_insert on public.%I', t);
    execute format('drop policy if exists member_update on public.%I', t);
    execute format(
      'create policy member_read on public.%I for select to authenticated
       using (public.is_project_member(project_id) or (project_id is null and user_id = (select auth.uid())))', t);
    execute format(
      'create policy member_insert on public.%I for insert to authenticated
       with check (user_id = (select auth.uid()) and (project_id is null or public.is_project_member(project_id)))', t);
    execute format(
      'create policy member_update on public.%I for update to authenticated
       using (public.is_project_member(project_id) or (project_id is null and user_id = (select auth.uid())))
       with check (public.is_project_member(project_id) or (project_id is null and user_id = (select auth.uid())))', t);
  end loop;
end $$;

-- A device can be removed from the Profile's list.
grant delete on public.devices to authenticated;

-- No policies on purpose: these are reached only through the functions below.
-- (Supabase's advisor flags "RLS enabled, no policy"; here that means "no direct
-- access", which is the intent.) Policies someone added by hand are removed, or
-- they'd let people edit their share code directly.
alter table public.profiles enable row level security;
alter table public.project_members enable row level security;
drop policy if exists own_rows on public.profiles;
drop policy if exists own_membership_read on public.project_members;

-- Everyone in a project reads it. Only its owner changes it.
drop policy if exists member_read on public.projects;
drop policy if exists owner_insert on public.projects;
drop policy if exists owner_update on public.projects;
create policy member_read on public.projects for select to authenticated
  using (user_id = (select auth.uid()) or public.is_project_member(id));
create policy owner_insert on public.projects for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy owner_update on public.projects for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Everyone in a project reads its time. People change only their own.
drop policy if exists member_read on public.time_entries;
drop policy if exists own_insert on public.time_entries;
drop policy if exists own_update on public.time_entries;
create policy member_read on public.time_entries for select to authenticated
  using (public.is_project_member(project_id) or (project_id is null and user_id = (select auth.uid())));
create policy own_insert on public.time_entries for insert to authenticated
  with check (user_id = (select auth.uid()) and (project_id is null or public.is_project_member(project_id)));
create policy own_update on public.time_entries for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (project_id is null or public.is_project_member(project_id)));

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

-- ---------------------------------------------------------------- sharing

-- Your profile, created the first time it's asked for.
create or replace function public.ensure_profile() returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  p public.profiles;
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; -- no 0, O, 1 or I
  code text;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;
  select * into p from public.profiles where id = uid;
  if found then
    return p;
  end if;
  loop
    code := 'TT-';
    for i in 1..6 loop
      -- From gen_random_uuid(): random() can be predicted.
      code := code || substr(alphabet, 1 + (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4))::bit(16)::int % 32), 1);
    end loop;
    begin
      insert into public.profiles (id, display_name, share_code)
      values (uid, coalesce(nullif(split_part(auth.jwt() ->> 'email', '@', 1), ''), 'Me'), code)
      returning * into p;
      return p;
    exception when unique_violation then
      null; -- that code is taken: try another
    end;
  end loop;
end $$;

create or replace function public.set_display_name(p_name text) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  clean text := trim(p_name);
  p public.profiles;
begin
  if clean is null or clean = '' or length(clean) > 60 then
    raise exception 'A name needs 1 to 60 characters.';
  end if;
  perform public.ensure_profile();
  update public.profiles set display_name = clean where id = auth.uid() returning * into p;
  return p;
end $$;

-- Every member of every project you're in, with their names.
create or replace function public.my_memberships()
returns table (project_id text, user_id uuid, role text, display_name text)
language sql stable security definer set search_path = '' as $$
  select m.project_id, m.user_id, m.role, coalesce(pr.display_name, '')
  from public.project_members m
  join public.projects p on p.id = m.project_id and not p.deleted
  left join public.profiles pr on pr.id = m.user_id
  where public.is_project_member(m.project_id)
$$;

-- The owner adds someone by their share code. Returns their name.
create or replace function public.add_member(p_project_id text, p_share_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  target public.profiles;
begin
  if not exists (select 1 from public.projects where id = p_project_id and user_id = auth.uid() and not deleted) then
    raise exception 'Only the project owner can add people.';
  end if;
  select * into target from public.profiles where share_code = upper(trim(p_share_code));
  if not found then
    raise exception 'No one has that share code.';
  end if;
  insert into public.project_members (project_id, user_id, role)
  values (p_project_id, target.id, 'member')
  on conflict do nothing;
  return target.display_name;
end $$;

-- The owner removes a member, or a member leaves. The owner can't be removed.
-- The time they tracked stays on the project.
create or replace function public.remove_member(p_project_id text, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  is_owner boolean := exists (select 1 from public.projects where id = p_project_id and user_id = auth.uid());
begin
  if not is_owner and p_user_id is distinct from auth.uid() then
    raise exception 'Only the project owner can remove people.';
  end if;
  delete from public.project_members
  where project_id = p_project_id and user_id = p_user_id and role <> 'owner';
end $$;

-- ---------------------------------------------------------------- profile (Android 2.4)

-- Changes your profile. Only the keys present in p_changes change; each is
-- checked. Returns the whole profile (ensure_profile() reads it too).
create or replace function public.update_profile(p_changes jsonb) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  p public.profiles;
  v jsonb;
  k text;
  allowed constant text[] := array[
    'display_name', 'avatar_kind', 'avatar_preset', 'avatar_color', 'avatar_data', 'currency', 'week_start',
    'weekly_goal_hours', 'work_days', 'work_start', 'work_end', 'default_rate'];
  hhmm constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
begin
  if jsonb_typeof(p_changes) is distinct from 'object' then
    raise exception 'Expected an object of profile changes.';
  end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not k = any(allowed) then
      raise exception 'Unknown profile field: %', k;
    end if;
  end loop;
  p := public.ensure_profile();

  if p_changes ? 'display_name' then
    p.display_name := trim(p_changes ->> 'display_name');
    if p.display_name is null or p.display_name = '' or length(p.display_name) > 60 then
      raise exception 'A name needs 1 to 60 characters.';
    end if;
  end if;
  if p_changes ? 'avatar_kind' then
    p.avatar_kind := p_changes ->> 'avatar_kind';
    if p.avatar_kind is null or p.avatar_kind not in ('initials', 'preset', 'photo') then
      raise exception 'Unknown avatar kind.';
    end if;
  end if;
  if p_changes ? 'avatar_preset' then
    p.avatar_preset := p_changes ->> 'avatar_preset';
    if p.avatar_preset is not null and p.avatar_preset !~ '^[0-9]{2}$' then
      raise exception 'Unknown avatar.';
    end if;
  end if;
  if p_changes ? 'avatar_color' then
    v := p_changes -> 'avatar_color';
    p.avatar_color := case when jsonb_typeof(v) = 'null' then null else (v #>> '{}')::integer end;
    if p.avatar_color is not null and p.avatar_color not between 0 and 7 then
      raise exception 'Unknown avatar color.';
    end if;
  end if;
  if p_changes ? 'avatar_data' then
    p.avatar_data := p_changes ->> 'avatar_data';
    -- A 256 px JPEG is about 20 KB; base64 makes it a third bigger.
    if p.avatar_data is not null
       and (p.avatar_data !~ '^data:image/(jpeg|png);base64,' or length(p.avatar_data) > 81920) then
      raise exception 'The photo must be a JPEG or PNG of 60 KB or less.';
    end if;
  end if;
  if p_changes ? 'currency' then
    p.currency := upper(p_changes ->> 'currency');
    if p.currency is null or p.currency !~ '^[A-Z]{3}$' then
      raise exception 'A currency is a 3-letter code, like USD.';
    end if;
  end if;
  if p_changes ? 'week_start' then
    p.week_start := (p_changes ->> 'week_start')::integer;
    if p.week_start is null or p.week_start not in (0, 1) then
      raise exception 'The week starts on Monday (1) or Sunday (0).';
    end if;
  end if;
  if p_changes ? 'weekly_goal_hours' then
    p.weekly_goal_hours := (p_changes ->> 'weekly_goal_hours')::double precision;
    if p.weekly_goal_hours is not null and (p.weekly_goal_hours <= 0 or p.weekly_goal_hours > 168) then
      raise exception 'A weekly goal is more than 0 and at most 168 hours.';
    end if;
  end if;
  if p_changes ? 'work_days' then
    p.work_days := (p_changes ->> 'work_days')::integer;
    if p.work_days is null or p.work_days not between 0 and 127 then
      raise exception 'Unknown working days.';
    end if;
  end if;
  if p_changes ? 'work_start' then
    p.work_start := p_changes ->> 'work_start';
    if p.work_start is null or p.work_start !~ hhmm then
      raise exception 'A time is HH:MM, like 09:00.';
    end if;
  end if;
  if p_changes ? 'work_end' then
    p.work_end := p_changes ->> 'work_end';
    if p.work_end is null or p.work_end !~ hhmm then
      raise exception 'A time is HH:MM, like 18:00.';
    end if;
  end if;
  if p_changes ? 'default_rate' then
    p.default_rate := (p_changes ->> 'default_rate')::double precision;
    if p.default_rate is not null and p.default_rate < 0 then
      raise exception 'A rate can''t be negative.';
    end if;
  end if;

  update public.profiles set
    display_name = p.display_name, avatar_kind = p.avatar_kind, avatar_preset = p.avatar_preset,
    avatar_color = p.avatar_color, avatar_data = p.avatar_data, currency = p.currency,
    week_start = p.week_start, weekly_goal_hours = p.weekly_goal_hours, work_days = p.work_days,
    work_start = p.work_start, work_end = p.work_end, default_rate = p.default_rate
  where id = p.id
  returning * into p;
  return p;
end $$;

-- The avatars of everyone who shares a project with you, you included.
create or replace function public.member_avatars()
returns table (user_id uuid, avatar_kind text, avatar_preset text, avatar_color integer, avatar_data text)
language sql stable security definer set search_path = '' as $$
  select distinct pr.id, pr.avatar_kind, pr.avatar_preset, pr.avatar_color, pr.avatar_data
  from public.project_members m
  join public.projects p on p.id = m.project_id and not p.deleted
  join public.profiles pr on pr.id = m.user_id
  where public.is_project_member(m.project_id)
$$;

-- Deletes your account and everything only you can see. Shared projects live
-- on: each one you own goes to its longest-standing other member, and the time
-- you tracked on shared projects stays there (shown as "Former members").
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  r record;
  heir uuid;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;

  -- Hand each shared project you own to the member who joined it first.
  for r in
    select p.id from public.projects p
    where p.user_id = uid and not p.deleted
      and exists (select 1 from public.project_members m where m.project_id = p.id and m.user_id <> uid)
  loop
    select m.user_id into heir from public.project_members m
    where m.project_id = r.id and m.user_id <> uid
    order by m.created_at, m.user_id
    limit 1;
    update public.projects set user_id = heir where id = r.id;
    update public.project_members set role = 'owner' where project_id = r.id and user_id = heir;
  end loop;

  -- Phases and features you created on projects someone else now owns would go
  -- with your user row: they belong to the project's owner from now on.
  update public.phases ph set user_id = p.user_id
  from public.projects p
  where ph.user_id = uid and ph.project_id = p.id and p.user_id <> uid;
  update public.features f set user_id = p.user_id
  from public.projects p
  where f.user_id = uid and f.project_id = p.id and p.user_id <> uid;

  -- Your time stays only where someone else can still see it.
  delete from public.time_entries te
  where te.user_id = uid
    and not exists (
      select 1 from public.project_members m
      join public.projects p on p.id = m.project_id and p.user_id <> uid
      where m.project_id = te.project_id and m.user_id <> uid);

  -- The rest (your own projects, profile, timer, memberships, pending items,
  -- devices) goes with the user row.
  delete from auth.users where id = uid;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'is_project_member(text)', 'ensure_profile()', 'set_display_name(text)', 'my_memberships()',
    'add_member(text, text)', 'remove_member(text, uuid)', 'update_profile(jsonb)', 'member_avatars()',
    'delete_my_account()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Make the API see any new tables and columns straight away.
notify pgrst, 'reload schema';
