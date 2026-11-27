// Loads auth_stub.sql + ../schema.sql into an in-memory Postgres (PGlite, no
// install of Postgres needed) and runs statements as a user under row-level
// security. See README.md.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const U = (c) => `00000000-0000-0000-0000-00000000000${c}`;

export async function fresh({ users = 'abcd' } = {}) {
  const db = new PGlite();
  let stub = readFileSync(ROOT + 'test/auth_stub.sql', 'utf8');
  await db.exec(stub);
  for (const c of users) {
    await db.query(`insert into auth.users values ($1, $2) on conflict do nothing`, [U(c), `${c}@x.com`]);
  }
  const schema = readFileSync(ROOT + 'schema.sql', 'utf8').replace(/^notify pgrst.*$/m, '');
  await db.exec(schema);
  // Loading twice must work ("safe to re-run").
  await db.exec(schema);
  return db;
}

/** Runs sql as user c (a, b, ...) with RLS, in its own transaction. Returns rows. */
export async function as(db, c, sql, params = []) {
  return db.transaction(async (tx) => {
    const claims = JSON.stringify({ sub: U(c), email: `${c}@x.com`, role: 'authenticated' });
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await tx.query('set local role authenticated');
    const r = await tx.query(sql, params);
    return r.rows;
  });
}

/** Expects sql to fail; returns the error message. */
export async function fails(db, c, sql, params = []) {
  try {
    await as(db, c, sql, params);
  } catch (e) {
    return e.message;
  }
  throw new Error(`expected failure: ${sql}`);
}
