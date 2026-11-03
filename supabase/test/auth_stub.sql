-- The parts of a Supabase project that schema.sql relies on. Local tests only.
create role anon nologin;
create role authenticated nologin;
create schema auth;
grant usage on schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
create table auth.users (id uuid primary key, email text);
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
insert into auth.users values
  ('00000000-0000-0000-0000-00000000000a', 'a@x.com'),
  ('00000000-0000-0000-0000-00000000000b', 'b@x.com');
