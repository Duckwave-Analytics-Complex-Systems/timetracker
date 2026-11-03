# Testing sharing against real row-level security

`cargo test` runs `src-tauri/src/sync/e2e.rs` as a no-op unless `TT_E2E_URL` is
set. To run it for real you need a throwaway Postgres (never point this at a real
database: `schema.sql` is loaded with a fake `auth` schema).

```bash
PG=/usr/lib/postgresql/14/bin; D=$(mktemp -d)
$PG/initdb -D $D/data -A trust -U postgres
$PG/pg_ctl -D $D/data -o "-p 54399 -k '' -c listen_addresses=127.0.0.1" -l $D/log -w start
psql -h 127.0.0.1 -p 54399 -U postgres -c 'create database e2e'
psql -h 127.0.0.1 -p 54399 -U postgres -d e2e -f supabase/test/auth_stub.sql -f supabase/schema.sql
python3 supabase/test/postgrest_stub.py 54398 54399 e2e &
cd src-tauri && TT_E2E_URL=http://127.0.0.1:54398 cargo test e2e -- --nocapture
```

`postgrest_stub.py` isn't PostgREST: it covers only the requests the app makes,
in the same form, so a real Supabase project is still worth trying.
