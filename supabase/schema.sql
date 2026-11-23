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
--
-- Organizations: a studio's people (`org_members`, roles owner / admin / member)
-- and its projects (`projects.org_id`; null = a personal project). The org's
-- owner and admins can do everything a project's owner can on every project in
-- the org, without a project_members row; members still see only the projects
-- they're added to. `organizations` and `org_members` are reached only through
-- the functions in "organizations" below.
--
-- Shared sessions: one person's timer shared with others in the project (a
-- meeting, pairing). Everyone in it tracks the same time, each under their own
-- name: the project gets the whole, each account its part. Reached only
-- through the functions in "shared sessions" below.

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

-- A studio. Its defaults are filled into new projects created in it.
create table if not exists public.organizations (
  id               text primary key,
  name             text not null,
  logo_data        text,              -- small data: URL
  currency         text,              -- 3-letter code; null = each person's own
  default_rate     double precision,
  week_start       integer,           -- 1 = Monday, 0 = Sunday; null = each person's own
  join_code        text not null unique,  -- anyone with it can join as a member
  created_by       uuid references auth.users on delete set null,
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp()
);

-- Who is in each organization. Exactly one owner per organization.
create table if not exists public.org_members (
  org_id           text not null references public.organizations on delete cascade,
  user_id          uuid not null references auth.users on delete cascade,
  role             text not null check (role in ('owner', 'admin', 'member')),
  created_at       timestamptz not null default clock_timestamp(),
  primary key (org_id, user_id)
);

-- A shared session: started by `host_id` on their own timer (started_at = its
-- start). Ends when the host's timer stops or moves to another project.
create table if not exists public.shared_sessions (
  id               text primary key,
  project_id       text not null references public.projects on delete cascade,
  host_id          uuid not null references auth.users on delete cascade,
  started_at       bigint not null,   -- unix ms, the host's timer start
  ended_at         bigint,            -- unix ms; null while it runs
  created_at       timestamptz not null default clock_timestamp()
);

-- Who else is in it. 'joined': their timer runs on it from joined_at.
-- 'asked': they were tracking something else and haven't answered yet.
-- 'declined' / 'left': no longer in it (a stopped or moved timer is leaving).
create table if not exists public.shared_session_people (
  session_id       text not null references public.shared_sessions on delete cascade,
  user_id          uuid not null references auth.users on delete cascade,
  status           text not null check (status in ('joined', 'asked', 'declined', 'left')),
  joined_at        bigint,            -- unix ms, their timer start in it
  added_by         uuid references auth.users on delete set null,
  updated_at       timestamptz not null default clock_timestamp(),
  primary key (session_id, user_id)
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
-- Shared sessions: where to send a device its push notifications (Expo), and
-- in which language.
alter table public.devices add column if not exists push_token text;
alter table public.devices add column if not exists language text;

-- The organization the project belongs to; null = personal. Deleting the
-- organization makes its projects personal again (their owners keep them).
alter table public.projects add column if not exists org_id text
  references public.organizations on delete set null;

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
-- Organizations: whether teammates see when you're tracking one of its projects (org_presence()).
alter table public.profiles add column if not exists share_activity boolean not null default true;

-- Time someone tracked stays on a shared project after they delete their
-- account (see delete_my_account), so it must not go with their user row. The
-- apps show it under "Former members".
alter table public.time_entries drop constraint if exists time_entries_user_id_fkey;

create index if not exists project_members_user       on public.project_members (user_id);
create index if not exists org_members_user           on public.org_members (user_id);
create index if not exists projects_org               on public.projects (org_id);
create index if not exists shared_sessions_open       on public.shared_sessions (project_id) where ended_at is null;
create index if not exists shared_session_people_user on public.shared_session_people (user_id);
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
    'projects', 'features', 'phases', 'time_entries', 'timers', 'member_state', 'profiles', 'pending_items', 'devices',
    'organizations'
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

create or replace function public.is_org_member(p_org_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.org_members where org_id = p_org_id and user_id = auth.uid()
  )
$$;

create or replace function public.is_org_admin(p_org_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.org_members
    where org_id = p_org_id and user_id = auth.uid() and role in ('owner', 'admin')
  )
$$;

-- Runs without row level security, so the policies below can use it on
-- project_members without looping back into themselves. An organization's
-- owner and admins count as members of all its projects.
create or replace function public.is_project_member(p_project_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_members
    where project_id = p_project_id and user_id = auth.uid()
  ) or exists (
    select 1 from public.projects p
    join public.org_members om on om.org_id = p.org_id
    where p.id = p_project_id and om.user_id = auth.uid() and om.role in ('owner', 'admin')
  )
$$;

-- Owner or org admin: may change the project row and its members.
create or replace function public.can_manage_project(p_project_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project_id and not p.deleted
      and (p.user_id = auth.uid() or (p.org_id is not null and public.is_org_admin(p.org_id)))
  )
$$;

-- What the apps may change on a project row, beyond the policies:
-- * user_id (the owner) changes only inside the functions below, which set
--   tt.internal.
-- * org_id: into an organization only by the project's owner and only one
--   they're in; out of one only by its owner or an admin.
-- A change that isn't allowed is dropped (the old value is kept) rather than
-- refused, so a device's upload queue never gets stuck on it; the device
-- gets the real value back on its next pull.
create or replace function public.guard_project() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null or current_setting('tt.internal', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.org_id is not null and not public.is_org_member(new.org_id) then
      new.org_id := null;
    end if;
    return new;
  end if;
  new.user_id := old.user_id;
  if new.org_id is distinct from old.org_id then
    if (old.org_id is not null and not public.is_org_admin(old.org_id))
       or (new.org_id is not null and not (old.user_id = uid and public.is_org_member(new.org_id))) then
      new.org_id := old.org_id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists guard_project on public.projects;
create trigger guard_project before insert or update on public.projects
for each row execute function public.guard_project();

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
alter table public.organizations enable row level security;
alter table public.org_members enable row level security;
alter table public.shared_sessions enable row level security;
alter table public.shared_session_people enable row level security;
drop policy if exists own_rows on public.profiles;
drop policy if exists own_membership_read on public.project_members;

-- Everyone in a project reads it. Only its owner, or an admin of its
-- organization, changes it. (guard_project keeps user_id from changing, so the
-- update needs no check of its own: after an admin takes a project out of the
-- organization it's no longer theirs to see.)
drop policy if exists member_read on public.projects;
drop policy if exists owner_insert on public.projects;
drop policy if exists owner_update on public.projects;
create policy member_read on public.projects for select to authenticated
  using (user_id = (select auth.uid()) or public.is_project_member(id));
create policy owner_insert on public.projects for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy owner_update on public.projects for update to authenticated
  using (user_id = (select auth.uid()) or (org_id is not null and public.is_org_admin(org_id)))
  with check (true);

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

-- Adds a person to a project. Only its owner or an admin of its organization;
-- a project in an organization takes only people in that organization.
-- Returns their name.
create or replace function public.add_member_by_id(p_project_id text, p_user_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  org text;
begin
  if not public.can_manage_project(p_project_id) then
    raise exception 'Only the project owner can add people.';
  end if;
  select org_id into org from public.projects where id = p_project_id;
  if org is not null and not exists (
    select 1 from public.org_members where org_id = org and user_id = p_user_id
  ) then
    raise exception 'Add them to the organization first.';
  end if;
  insert into public.project_members (project_id, user_id, role)
  values (p_project_id, p_user_id, 'member')
  on conflict do nothing;
  return coalesce((select display_name from public.profiles where id = p_user_id), '');
end $$;

-- The same, by the person's share code.
create or replace function public.add_member(p_project_id text, p_share_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  target public.profiles;
begin
  if not public.can_manage_project(p_project_id) then
    raise exception 'Only the project owner can add people.';
  end if;
  select * into target from public.profiles where share_code = upper(trim(p_share_code));
  if not found then
    raise exception 'No one has that share code.';
  end if;
  return public.add_member_by_id(p_project_id, target.id);
end $$;

-- The owner (or an org admin) removes a member, or a member leaves. The owner
-- can't be removed. The time they tracked stays on the project.
create or replace function public.remove_member(p_project_id text, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_manage_project(p_project_id) and p_user_id is distinct from auth.uid() then
    raise exception 'Only the project owner can remove people.';
  end if;
  delete from public.project_members
  where project_id = p_project_id and user_id = p_user_id and role <> 'owner';
end $$;

-- ---------------------------------------------------------------- organizations

-- A code like "ORG-7KQ2MX", from gen_random_uuid() (random() can be predicted).
create or replace function public.new_org_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; -- no 0, O, 1 or I
  code text := 'ORG-';
begin
  for i in 1..6 loop
    code := code || substr(alphabet, 1 + (('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4))::bit(16)::int % 32), 1);
  end loop;
  return code;
end $$;

-- Hands a project to another person: they become its owner (and a member).
-- The previous owner stays in it as a member.
create or replace function public.transfer_project(p_project_id text, p_to uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  was text := coalesce(current_setting('tt.internal', true), 'off');
begin
  perform set_config('tt.internal', 'on', true);
  update public.project_members set role = 'member' where project_id = p_project_id and role = 'owner';
  insert into public.project_members (project_id, user_id, role) values (p_project_id, p_to, 'owner')
  on conflict (project_id, user_id) do update set role = 'owner';
  update public.projects set user_id = p_to where id = p_project_id;
  perform set_config('tt.internal', was, true);
end $$;

-- The organizations you're in. join_code only for its owner and admins.
create or replace function public.my_orgs()
returns table (id text, name text, logo_data text, currency text, default_rate double precision,
               week_start integer, join_code text, role text, created_at bigint)
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, o.logo_data, o.currency, o.default_rate, o.week_start,
         case when m.role in ('owner', 'admin') then o.join_code end,
         m.role, (extract(epoch from o.created_at) * 1000)::bigint
  from public.organizations o
  join public.org_members m on m.org_id = o.id and m.user_id = auth.uid()
$$;

-- Everyone in every organization you're in, with their names.
create or replace function public.my_org_members()
returns table (org_id text, user_id uuid, role text, display_name text, joined_at bigint)
language sql stable security definer set search_path = '' as $$
  select m.org_id, m.user_id, m.role, coalesce(pr.display_name, ''),
         (extract(epoch from m.created_at) * 1000)::bigint
  from public.org_members m
  left join public.profiles pr on pr.id = m.user_id
  where public.is_org_member(m.org_id)
$$;

-- Checks an organization's name: 1 to 60 characters.
create or replace function public.clean_org_name(p_name text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  clean text := trim(p_name);
begin
  if clean is null or clean = '' or length(clean) > 60 then
    raise exception 'A name needs 1 to 60 characters.';
  end if;
  return clean;
end $$;

-- Creates an organization with you as its owner. Returns its id.
create or replace function public.create_org(p_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  new_id text := gen_random_uuid()::text;
begin
  if uid is null then
    raise exception 'not signed in';
  end if;
  perform public.ensure_profile();
  loop
    begin
      insert into public.organizations (id, name, join_code, created_by)
      values (new_id, public.clean_org_name(p_name), public.new_org_code(), uid);
      exit;
    exception when unique_violation then
      null; -- that code is taken: try another
    end;
  end loop;
  insert into public.org_members (org_id, user_id, role) values (new_id, uid, 'owner');
  return new_id;
end $$;

-- Joins an organization by its code, as a member. Returns its id.
create or replace function public.join_org(p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  org text;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  select id into org from public.organizations where join_code = upper(trim(p_code));
  if not found then
    raise exception 'No organization has that code.';
  end if;
  perform public.ensure_profile();
  insert into public.org_members (org_id, user_id, role) values (org, auth.uid(), 'member')
  on conflict do nothing;
  return org;
end $$;

-- An owner or admin adds someone by their share code, as a member. Returns their name.
create or replace function public.add_org_member(p_org_id text, p_share_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  target public.profiles;
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'Only the organization''s owner and admins can add people.';
  end if;
  select * into target from public.profiles where share_code = upper(trim(p_share_code));
  if not found then
    raise exception 'No one has that share code.';
  end if;
  insert into public.org_members (org_id, user_id, role) values (p_org_id, target.id, 'member')
  on conflict do nothing;
  return target.display_name;
end $$;

-- Someone leaves an organization, or is removed from it: the owner removes
-- anyone, an admin removes members, anyone can leave (except the owner, who
-- hands the organization on or deletes it). They leave its projects too, and
-- the projects they owned there go to the organization's owner. The time they
-- tracked stays.
create or replace function public.remove_org_member(p_org_id text, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  my_role text;
  their_role text;
  org_owner uuid;
  r record;
begin
  select role into my_role from public.org_members where org_id = p_org_id and user_id = auth.uid();
  select role into their_role from public.org_members where org_id = p_org_id and user_id = p_user_id;
  if their_role is null then
    return;
  end if;
  if their_role = 'owner' then
    raise exception 'The owner can''t leave: make someone else the owner, or delete the organization.';
  end if;
  if p_user_id is distinct from auth.uid()
     and not (my_role = 'owner' or (my_role = 'admin' and their_role = 'member')) then
    raise exception 'Only the organization''s owner and admins can remove people.';
  end if;
  select user_id into org_owner from public.org_members where org_id = p_org_id and role = 'owner';
  for r in select id from public.projects where org_id = p_org_id and user_id = p_user_id loop
    perform public.transfer_project(r.id, org_owner);
  end loop;
  delete from public.project_members pm
  using public.projects p
  where p.id = pm.project_id and p.org_id = p_org_id and pm.user_id = p_user_id;
  delete from public.org_members where org_id = p_org_id and user_id = p_user_id;
end $$;

-- The owner makes someone an admin or a member, or hands the organization
-- over (p_role = 'owner': they become the owner and you an admin).
create or replace function public.set_org_role(p_org_id text, p_user_id uuid, p_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.org_members where org_id = p_org_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Only the organization''s owner can change roles.';
  end if;
  if p_role not in ('owner', 'admin', 'member') then
    raise exception 'Unknown role.';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'Make someone else the owner instead.';
  end if;
  if not exists (select 1 from public.org_members where org_id = p_org_id and user_id = p_user_id) then
    raise exception 'They aren''t in this organization.';
  end if;
  if p_role = 'owner' then
    update public.org_members set role = 'admin' where org_id = p_org_id and user_id = auth.uid();
  end if;
  update public.org_members set role = p_role where org_id = p_org_id and user_id = p_user_id;
end $$;

-- An owner or admin changes the organization. Only the keys present change;
-- each is checked.
create or replace function public.update_org(p_org_id text, p_changes jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.organizations;
  v jsonb;
  k text;
  allowed constant text[] := array['name', 'logo_data', 'currency', 'default_rate', 'week_start'];
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'Only the organization''s owner and admins can change it.';
  end if;
  if jsonb_typeof(p_changes) is distinct from 'object' then
    raise exception 'Expected an object of changes.';
  end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not k = any(allowed) then
      raise exception 'Unknown organization field: %', k;
    end if;
  end loop;
  select * into o from public.organizations where id = p_org_id;

  if p_changes ? 'name' then
    o.name := public.clean_org_name(p_changes ->> 'name');
  end if;
  if p_changes ? 'logo_data' then
    o.logo_data := p_changes ->> 'logo_data';
    if o.logo_data is not null
       and (o.logo_data !~ '^data:image/(jpeg|png);base64,' or length(o.logo_data) > 81920) then
      raise exception 'The logo must be a JPEG or PNG of 60 KB or less.';
    end if;
  end if;
  if p_changes ? 'currency' then
    o.currency := upper(p_changes ->> 'currency');
    if o.currency is not null and o.currency !~ '^[A-Z]{3}$' then
      raise exception 'A currency is a 3-letter code, like USD.';
    end if;
  end if;
  if p_changes ? 'default_rate' then
    v := p_changes -> 'default_rate';
    o.default_rate := case when jsonb_typeof(v) = 'null' then null else (v #>> '{}')::double precision end;
    if o.default_rate is not null and o.default_rate < 0 then
      raise exception 'A rate can''t be negative.';
    end if;
  end if;
  if p_changes ? 'week_start' then
    v := p_changes -> 'week_start';
    o.week_start := case when jsonb_typeof(v) = 'null' then null else (v #>> '{}')::integer end;
    if o.week_start is not null and o.week_start not in (0, 1) then
      raise exception 'The week starts on Monday (1) or Sunday (0).';
    end if;
  end if;

  update public.organizations set
    name = o.name, logo_data = o.logo_data, currency = o.currency,
    default_rate = o.default_rate, week_start = o.week_start
  where id = p_org_id;
end $$;

-- An organization's people right now, for its dashboard. Any member may ask.
-- * running / started_at: tracking one of the organization's projects (never a
--   personal one), unless they turned share_activity off. project_id and
--   project_name only if you can see that project too.
-- * weekly_goal_hours: only for the owner and admins (everyone's), or your own.
create or replace function public.org_presence(p_org_id text)
returns table (user_id uuid, display_name text, role text, weekly_goal_hours double precision,
               running boolean, project_id text, project_name text, started_at bigint)
language sql stable security definer set search_path = '' as $$
  with people as (
    select m.user_id, m.role, pr.display_name, pr.weekly_goal_hours, t.started_at, p.id as pid, p.name as pname,
           coalesce(t.running and pr.share_activity and p.org_id = p_org_id and not p.deleted, false) as busy
    from public.org_members m
    left join public.profiles pr on pr.id = m.user_id
    left join public.timers t on t.user_id = m.user_id
    left join public.projects p on p.id = t.project_id
    where m.org_id = p_org_id and public.is_org_member(p_org_id)
  )
  select x.user_id, coalesce(x.display_name, ''), x.role,
         case when public.is_org_admin(p_org_id) or x.user_id = auth.uid() then x.weekly_goal_hours end,
         x.busy,
         case when x.busy and public.is_project_member(x.pid) then x.pid end,
         case when x.busy and public.is_project_member(x.pid) then x.pname end,
         case when x.busy then x.started_at end
  from people x
$$;

-- An owner or admin replaces the join code, so the old one stops working.
create or replace function public.reset_org_join_code(p_org_id text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  code text;
begin
  if not public.is_org_admin(p_org_id) then
    raise exception 'Only the organization''s owner and admins can change its code.';
  end if;
  loop
    code := public.new_org_code();
    begin
      update public.organizations set join_code = code where id = p_org_id;
      return code;
    exception when unique_violation then
      null;
    end;
  end loop;
end $$;

-- The owner deletes the organization. Its projects become personal projects
-- of their owners, with the same members (org admins lose the access they had
-- only through the organization).
create or replace function public.delete_org(p_org_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.org_members where org_id = p_org_id and user_id = auth.uid() and role = 'owner'
  ) then
    raise exception 'Only the organization''s owner can delete it.';
  end if;
  perform set_config('tt.internal', 'on', true);  -- the projects' org_id goes null
  delete from public.organizations where id = p_org_id;
  perform set_config('tt.internal', 'off', true);
end $$;

-- ---------------------------------------------------------------- shared sessions

create or replace function public.now_ms() returns bigint
language sql volatile set search_path = '' as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint
$$;

-- Books someone's part of a shared session the way their own device would
-- (pause_one / pauseOne): the same id, so whichever books it first wins and
-- the other is a no-op. Booked to the phase and feature they book time to.
create or replace function public.book_session_part(p_project_id text, p_user_id uuid, p_start bigint, p_end bigint)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  secs bigint := greatest(0, floor((p_end - p_start) / 1000.0))::bigint;
  ms public.member_state;
begin
  if secs <= 0 then
    return;
  end if;
  select * into ms from public.member_state where id = p_project_id || ':' || p_user_id::text and not deleted;
  insert into public.time_entries (id, user_id, project_id, start_ts, end_ts, seconds, phase_id, feature_id)
  values (p_project_id || '@' || p_start || '@' || p_user_id::text, p_user_id, p_project_id,
          p_start, p_start + secs * 1000, secs, ms.active_phase_id, ms.active_feature_id)
  on conflict (id) do nothing;
end $$;

-- Starts someone's timer on a project, as if they had (straight into a session).
create or replace function public.start_timer_for(p_user_id uuid, p_project_id text, p_started_at bigint, p_device_id text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.timers (user_id) values (p_user_id) on conflict (user_id) do nothing;
  update public.timers
     set project_id = p_project_id,
         phase_id = (select active_phase_id from public.member_state
                     where id = p_project_id || ':' || p_user_id::text and not deleted),
         started_at = p_started_at, ended_at = null, running = true, device_id = p_device_id
   where user_id = p_user_id;
end $$;

-- Shares your running timer with people in its project, or adds people to the
-- session you're in. Someone with no timer running is in straight away (their
-- timer starts now); someone tracking something else is asked first
-- (join_session / decline_session). Only the project's members. Returns the
-- session's id.
create or replace function public.share_session(p_project_id text, p_user_ids uuid[]) returns text
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  mine public.timers;
  ss public.shared_sessions;
  t public.timers;
  target uuid;
  now_at bigint := public.now_ms();
begin
  if uid is null then
    raise exception 'not signed in';
  end if;
  if not exists (select 1 from public.project_members where project_id = p_project_id and user_id = uid) then
    raise exception 'Only the project''s members can share a session on it.';
  end if;
  select * into mine from public.timers where user_id = uid;
  if not found or not mine.running or mine.project_id is distinct from p_project_id then
    raise exception 'Start the timer on this project first.';
  end if;

  -- The session you're in on this project, yours or one you joined; else a new one.
  select x.* into ss from public.shared_sessions x
  where x.project_id = p_project_id and x.ended_at is null
    and ((x.host_id = uid and x.started_at = mine.started_at)
         or exists (select 1 from public.shared_session_people sp
                    where sp.session_id = x.id and sp.user_id = uid and sp.status = 'joined'
                      and sp.joined_at = mine.started_at))
  limit 1;
  if not found then
    insert into public.shared_sessions (id, project_id, host_id, started_at)
    values (gen_random_uuid()::text, p_project_id, uid, mine.started_at)
    returning * into ss;
  end if;

  foreach target in array coalesce(p_user_ids, '{}'::uuid[]) loop
    continue when target = uid or target = ss.host_id;
    if not exists (select 1 from public.project_members where project_id = p_project_id and user_id = target) then
      raise exception 'Only the project''s members can be in its sessions.';
    end if;
    continue when exists (select 1 from public.shared_session_people
                          where session_id = ss.id and user_id = target and status = 'joined');
    select * into t from public.timers where user_id = target;
    if found and t.running and t.project_id = p_project_id then
      -- Already tracking this project: they're in, from when they started.
      insert into public.shared_session_people (session_id, user_id, status, joined_at, added_by)
      values (ss.id, target, 'joined', t.started_at, uid)
      on conflict (session_id, user_id) do update
        set status = 'joined', joined_at = excluded.joined_at, added_by = uid, updated_at = clock_timestamp();
    elsif found and t.running then
      -- Tracking something else: asked first.
      insert into public.shared_session_people (session_id, user_id, status, added_by)
      values (ss.id, target, 'asked', uid)
      on conflict (session_id, user_id) do update
        set status = 'asked', added_by = uid, updated_at = clock_timestamp();
    else
      -- Nothing running: straight in, from now.
      perform public.start_timer_for(target, p_project_id, now_at, 'shared:' || ss.id);
      insert into public.shared_session_people (session_id, user_id, status, joined_at, added_by)
      values (ss.id, target, 'joined', now_at, uid)
      on conflict (session_id, user_id) do update
        set status = 'joined', joined_at = now_at, added_by = uid, updated_at = clock_timestamp();
    end if;
  end loop;
  return ss.id;
end $$;

-- You were asked to join: your timer moves to the session's project from
-- p_started_at (when your device stopped and booked what you were tracking;
-- now if null). p_device_id: the device you answered on, which then runs it.
create or replace function public.join_session(p_session_id text, p_started_at bigint, p_device_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  ss public.shared_sessions;
  start_at bigint := coalesce(p_started_at, public.now_ms());
begin
  if not exists (select 1 from public.shared_session_people
                 where session_id = p_session_id and user_id = uid and status in ('asked', 'declined', 'left')) then
    raise exception 'You aren''t asked to this session.';
  end if;
  select * into ss from public.shared_sessions where id = p_session_id;
  if ss.ended_at is not null then
    raise exception 'This session has ended.';
  end if;
  if not exists (select 1 from public.project_members where project_id = ss.project_id and user_id = uid) then
    raise exception 'Only the project''s members can be in its sessions.';
  end if;
  perform public.start_timer_for(uid, ss.project_id, start_at, coalesce(p_device_id, 'shared:' || ss.id));
  update public.shared_session_people
     set status = 'joined', joined_at = start_at, updated_at = clock_timestamp()
   where session_id = p_session_id and user_id = uid;
end $$;

-- You were asked to join and said no.
create or replace function public.decline_session(p_session_id text) returns void
language sql security definer set search_path = '' as $$
  update public.shared_session_people
     set status = 'declined', updated_at = clock_timestamp()
   where session_id = p_session_id and user_id = auth.uid() and status = 'asked'
$$;

-- The sessions running now that you started, are in, or are asked to; with
-- who's in each. my_status: 'host' | 'joined' | 'asked'.
create or replace function public.my_shared_sessions()
returns table (id text, project_id text, project_name text, host_id uuid, host_name text, started_at bigint,
               my_status text, people jsonb)
language sql stable security definer set search_path = '' as $$
  select x.id, x.project_id, coalesce(p.name, ''), x.host_id, coalesce(hp.display_name, ''), x.started_at,
         case when x.host_id = auth.uid() then 'host' else me.status end,
         (select coalesce(jsonb_agg(jsonb_build_object(
                   'user_id', sp.user_id, 'name', coalesce(pr.display_name, ''), 'status', sp.status,
                   'joined_at', sp.joined_at) order by sp.updated_at), '[]'::jsonb)
            from public.shared_session_people sp
            left join public.profiles pr on pr.id = sp.user_id
           where sp.session_id = x.id and sp.status in ('joined', 'asked'))
  from public.shared_sessions x
  join public.projects p on p.id = x.project_id
  left join public.shared_session_people me on me.session_id = x.id and me.user_id = auth.uid()
  left join public.profiles hp on hp.id = x.host_id
  where x.ended_at is null and (x.host_id = auth.uid() or me.status in ('joined', 'asked'))
$$;

-- A timer stopped or moved to another session. If it was in someone's shared
-- session, that person has left it (their device books their part). If it
-- started one, the session ends: everyone still in it stops at the same time,
-- and their parts are booked here (their devices may be off).
create or replace function public.timer_moved() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ss record;
  p record;
  stop_at bigint;
begin
  if not old.running or old.started_at is null then
    return new;
  end if;
  if new.running and new.project_id is not distinct from old.project_id
     and new.started_at is not distinct from old.started_at then
    return new;
  end if;
  stop_at := case when new.running then coalesce(new.started_at, public.now_ms())
                  else coalesce(new.ended_at, public.now_ms()) end;

  update public.shared_session_people sp
     set status = 'left', updated_at = clock_timestamp()
   where sp.user_id = old.user_id and sp.status = 'joined' and sp.joined_at = old.started_at
     and sp.session_id in (select x.id from public.shared_sessions x
                           where x.project_id = old.project_id and x.ended_at is null);

  for ss in
    select * from public.shared_sessions x
    where x.host_id = old.user_id and x.project_id = old.project_id
      and x.started_at = old.started_at and x.ended_at is null
  loop
    update public.shared_sessions set ended_at = stop_at where id = ss.id;
    for p in
      select sp.user_id, sp.joined_at from public.shared_session_people sp
      join public.timers t on t.user_id = sp.user_id
      where sp.session_id = ss.id and sp.status = 'joined'
        and t.running and t.project_id = ss.project_id and t.started_at = sp.joined_at
    loop
      update public.timers set running = false, ended_at = greatest(stop_at, p.joined_at) where user_id = p.user_id;
      perform public.book_session_part(ss.project_id, p.user_id, p.joined_at, greatest(stop_at, p.joined_at));
    end loop;
    update public.shared_session_people
       set status = case status when 'joined' then 'left' when 'asked' then 'declined' else status end,
           updated_at = clock_timestamp()
     where session_id = ss.id;
  end loop;
  return new;
end $$;

drop trigger if exists timer_moved on public.timers;
create trigger timer_moved after update on public.timers
for each row execute function public.timer_moved();

-- Tells someone they were added to a session (straight in, or asked), on
-- every device that gave a push token: an Expo push through pg_net. Skipped
-- when the pg_net extension isn't enabled (Database > Extensions).
create or replace function public.notify_session_person() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  info record;
  d record;
  es boolean;
  title text;
  body text;
begin
  if new.status not in ('joined', 'asked') or new.added_by is null or new.added_by = new.user_id then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status not in ('declined', 'left') then
    return new; -- not newly added (e.g. answering, or already in)
  end if;
  if not exists (select 1 from pg_catalog.pg_proc f join pg_catalog.pg_namespace n on n.oid = f.pronamespace
                 where n.nspname = 'net' and f.proname = 'http_post') then
    return new;
  end if;
  select pr.name as project, coalesce(h.display_name, '') as host into info
  from public.shared_sessions x
  join public.projects pr on pr.id = x.project_id
  left join public.profiles h on h.id = new.added_by
  where x.id = new.session_id;

  for d in select push_token, language from public.devices where user_id = new.user_id and push_token is not null loop
    es := coalesce(d.language, '') like 'es%';
    if new.status = 'asked' then
      title := case when es then info.host || ' te invitó a una sesión' else info.host || ' invited you to a session' end;
      body := case when es then info.project || ': ¿dejar lo que estás registrando y unirte?'
                   else info.project || ': stop what you''re tracking and join?' end;
    else
      title := case when es then info.host || ' te agregó a una sesión' else info.host || ' added you to a session' end;
      body := case when es then 'Ya estás registrando ' || info.project || '.'
                   else 'You''re tracking ' || info.project || ' now.' end;
    end if;
    perform net.http_post(
      url := 'https://exp.host/--/api/v2/push/send',
      body := jsonb_build_object(
        'to', d.push_token, 'title', title, 'body', body, 'sound', 'default', 'channelId', 'sessions',
        'priority', 'high', 'data', jsonb_build_object('url', '/session-invite?id=' || new.session_id)),
      headers := '{"Content-Type": "application/json"}'::jsonb);
  end loop;
  return new;
end $$;

drop trigger if exists notify_session_person on public.shared_session_people;
create trigger notify_session_person after insert or update of status on public.shared_session_people
for each row execute function public.notify_session_person();

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
    'weekly_goal_hours', 'work_days', 'work_start', 'work_end', 'default_rate', 'share_activity'];
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

  if p_changes ? 'share_activity' then
    p.share_activity := coalesce((p_changes ->> 'share_activity')::boolean, true);
  end if;

  update public.profiles set
    share_activity = p.share_activity,
    display_name = p.display_name, avatar_kind = p.avatar_kind, avatar_preset = p.avatar_preset,
    avatar_color = p.avatar_color, avatar_data = p.avatar_data, currency = p.currency,
    week_start = p.week_start, weekly_goal_hours = p.weekly_goal_hours, work_days = p.work_days,
    work_start = p.work_start, work_end = p.work_end, default_rate = p.default_rate
  where id = p.id
  returning * into p;
  return p;
end $$;

-- The avatars of everyone who shares a project or an organization with you,
-- you included.
create or replace function public.member_avatars()
returns table (user_id uuid, avatar_kind text, avatar_preset text, avatar_color integer, avatar_data text)
language sql stable security definer set search_path = '' as $$
  select pr.id, pr.avatar_kind, pr.avatar_preset, pr.avatar_color, pr.avatar_data
  from public.profiles pr
  where pr.id in (
    select m.user_id
    from public.project_members m
    join public.projects p on p.id = m.project_id and not p.deleted
    where public.is_project_member(m.project_id)
    union
    select om.user_id from public.org_members om where public.is_org_member(om.org_id)
  )
$$;

-- Deletes your account and everything only you can see. Organizations and
-- shared projects live on: an organization you own goes to its longest-standing
-- admin (or member, if it has no admin), a project you own in an organization
-- goes to the organization's owner, any other shared project you own goes to
-- its longest-standing other member, and the time you tracked on shared
-- projects stays there (shown as "Former members").
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
  perform set_config('tt.internal', 'on', true);  -- projects change owner below

  -- Hand each organization you own on; one with no one else in it goes (its
  -- projects become personal, and go below with the rest of yours).
  for r in select org_id from public.org_members where user_id = uid and role = 'owner' loop
    select m.user_id into heir from public.org_members m
    where m.org_id = r.org_id and m.user_id <> uid
    order by (m.role = 'admin') desc, m.created_at, m.user_id
    limit 1;
    if heir is null then
      delete from public.organizations where id = r.org_id;
    else
      update public.org_members set role = 'owner' where org_id = r.org_id and user_id = heir;
    end if;
  end loop;

  -- Projects you own in an organization go to its owner.
  for r in
    select p.id, om.user_id as org_owner from public.projects p
    join public.org_members om on om.org_id = p.org_id and om.role = 'owner'
    where p.user_id = uid and not p.deleted and om.user_id <> uid
  loop
    perform public.transfer_project(r.id, r.org_owner);
  end loop;

  -- Hand each other shared project you own to the member who joined it first.
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
    'delete_my_account()',
    'is_org_member(text)', 'is_org_admin(text)', 'can_manage_project(text)', 'add_member_by_id(text, uuid)',
    'my_orgs()', 'my_org_members()', 'create_org(text)', 'join_org(text)', 'add_org_member(text, text)',
    'remove_org_member(text, uuid)', 'set_org_role(text, uuid, text)', 'update_org(text, jsonb)',
    'reset_org_join_code(text)', 'delete_org(text)', 'org_presence(text)',
    'share_session(text, uuid[])', 'join_session(text, bigint, text)', 'decline_session(text)', 'my_shared_sessions()'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;

  -- Used only by the functions above, never called by the apps.
  foreach f in array array[
    'transfer_project(text, uuid)', 'new_org_code()', 'clean_org_name(text)', 'guard_project()',
    'book_session_part(text, uuid, bigint, bigint)', 'start_timer_for(uuid, text, bigint, text)',
    'timer_moved()', 'notify_session_person()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- Make the API see any new tables and columns straight away.
notify pgrst, 'reload schema';
