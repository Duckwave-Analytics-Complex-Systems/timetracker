// Shared sessions: one timer shared with others in the project. Run like
// orgs.test.mjs (see README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, as, fails, U } from './pglite-harness.mjs';

const MIN = 60_000;

// a, b, c are in project p (owned by a); d is not. a also owns q, c owns r.
async function setup() {
  const db = await fresh({ users: 'abcd' });
  for (const c of 'abcd') await as(db, c, 'select ensure_profile()');
  await as(db, 'a', `insert into projects (id, name) values ('p', 'Client app'), ('q', 'Other')`);
  await as(db, 'c', `insert into projects (id, name) values ('r', 'Own')`);
  for (const c of 'bc') {
    const [{ share_code: code }] = await as(db, c, 'select share_code from ensure_profile()');
    await as(db, 'a', 'select add_member($1, $2)', ['p', code]);
  }
  return db;
}
const start = (db, c, project, at) =>
  as(db, c, `select push_timer('start', $1, null, $2, null, $3)`, [project, at, `dev-${c}`]);
const stop = (db, c, project, startedAt, at) =>
  as(db, c, `select push_timer('stop', $1, null, $2, $3, $4)`, [project, startedAt, at, `dev-${c}`]);
const timer = async (db, c) => (await db.query('select * from timers where user_id = $1', [U(c)])).rows[0];
const sessions = (db, c) => as(db, c, 'select * from my_shared_sessions()');
const entries = async (db, c) => (await db.query('select * from time_entries where user_id = $1 order by id', [U(c)])).rows;
const people = async (db, id) => Object.fromEntries(
  (await db.query('select user_id, status from shared_session_people where session_id = $1', [id])).rows
    .map((r) => [r.user_id, r.status]));
const share = async (db, c, project, users) =>
  (await as(db, c, 'select share_session($1, $2) as id', [project, users.map(U)]))[0].id;

test('someone with nothing running is in straight away', async () => {
  const db = await setup();
  await start(db, 'a', 'p', Date.now() - 30 * MIN);
  const id = await share(db, 'a', 'p', ['b']);
  const tb = await timer(db, 'b');
  assert.equal(tb.running, true);
  assert.equal(tb.project_id, 'p');
  assert.equal(tb.device_id, `shared:${id}`);
  assert.ok(Math.abs(Number(tb.started_at) - Date.now()) < 5000, 'from now');

  const [forA] = await sessions(db, 'a');
  assert.equal(forA.my_status, 'host');
  assert.equal(forA.project_name, 'Client app');
  assert.deepEqual(forA.people.map((x) => [x.user_id, x.status]), [[U('b'), 'joined']]);
  const [forB] = await sessions(db, 'b');
  assert.equal(forB.my_status, 'joined');
  assert.equal(forB.host_name, 'a');
});

test('someone tracking something else is asked; declining leaves them alone', async () => {
  const db = await setup();
  await start(db, 'a', 'p', Date.now() - MIN);
  await start(db, 'c', 'r', Date.now() - 10 * MIN);
  const id = await share(db, 'a', 'p', ['c']);
  assert.equal((await timer(db, 'c')).project_id, 'r', 'their timer is untouched');
  assert.equal((await sessions(db, 'c'))[0].my_status, 'asked');
  await as(db, 'c', 'select decline_session($1)', [id]);
  assert.equal((await sessions(db, 'c')).length, 0);
  assert.equal((await people(db, id))[U('c')], 'declined');
});

test('joining moves your timer to the session, from when you stopped', async () => {
  const db = await setup();
  await start(db, 'a', 'p', Date.now() - MIN);
  const cStart = Date.now() - 10 * MIN;
  await start(db, 'c', 'r', cStart);
  const id = await share(db, 'a', 'p', ['c']);
  const at = Date.now() - 1000;
  // Their device stops and books r first, then joins.
  await stop(db, 'c', 'r', cStart, at);
  await as(db, 'c', 'select join_session($1, $2, $3)', [id, at, 'dev-c']);
  const tc = await timer(db, 'c');
  assert.deepEqual([tc.project_id, Number(tc.started_at), tc.device_id, tc.running], ['p', at, 'dev-c', true]);
  assert.equal((await people(db, id))[U('c')], 'joined');
  assert.match(await fails(db, 'd', 'select join_session($1, null, null)', [id]), /aren't asked/);
});

test('the session ends with its host: everyone stops and gets their part booked', async () => {
  const db = await setup();
  const t0 = Date.now() - 60 * MIN;
  await start(db, 'a', 'p', t0);
  const id = await share(db, 'a', 'p', ['b']);
  const joined = Number((await timer(db, 'b')).started_at);
  const end = joined + 25 * MIN + 999;
  await stop(db, 'a', 'p', t0, end);

  const tb = await timer(db, 'b');
  assert.equal(tb.running, false);
  assert.equal(Number(tb.ended_at), end);
  const [e] = await entries(db, 'b');
  assert.equal(e.id, `p@${joined}@${U('b')}`, 'the id their device would use');
  assert.equal(Number(e.seconds), 25 * 60);
  assert.equal(Number(e.end_ts), joined + 25 * MIN);
  assert.equal((await sessions(db, 'a')).length, 0);
  assert.equal((await sessions(db, 'b')).length, 0);
  assert.equal((await people(db, id))[U('b')], 'left');
});

test("booking is a no-op if the participant's device booked first", async () => {
  const db = await setup();
  const t0 = Date.now() - 60 * MIN;
  await start(db, 'a', 'p', t0);
  await share(db, 'a', 'p', ['b']);
  const joined = Number((await timer(db, 'b')).started_at);
  await as(db, 'b', `insert into time_entries (id, project_id, start_ts, end_ts, seconds, note)
                     values ($1, 'p', $2, $3, 60, 'from the phone')`, [`p@${joined}@${U('b')}`, joined, joined + MIN]);
  await stop(db, 'a', 'p', t0, joined + 30 * MIN);
  const list = await entries(db, 'b');
  assert.equal(list.length, 1);
  assert.equal(list[0].note, 'from the phone', 'left as their device booked it');
});

test('leaving early is stopping your own timer; the host stopping later books nothing for you', async () => {
  const db = await setup();
  const t0 = Date.now() - 60 * MIN;
  await start(db, 'a', 'p', t0);
  const id = await share(db, 'a', 'p', ['b']);
  const joined = Number((await timer(db, 'b')).started_at);
  await stop(db, 'b', 'p', joined, joined + 5 * MIN);
  assert.equal((await people(db, id))[U('b')], 'left');
  assert.equal((await sessions(db, 'b')).length, 0);
  await stop(db, 'a', 'p', t0, joined + 30 * MIN);
  assert.equal((await entries(db, 'b')).length, 0, "b's own device books b's part");
});

test('the host moving to another project ends it at that moment', async () => {
  const db = await setup();
  await start(db, 'a', 'p', Date.now() - 60 * MIN);
  await share(db, 'a', 'p', ['b']);
  const joined = Number((await timer(db, 'b')).started_at);
  await start(db, 'a', 'q', joined + 10 * MIN);
  assert.equal(Number((await timer(db, 'b')).ended_at), joined + 10 * MIN);
  assert.equal(Number((await entries(db, 'b'))[0].seconds), 600);
});

test('adding people to a session you joined; someone already on the project is in from their start', async () => {
  const db = await setup();
  await start(db, 'a', 'p', Date.now() - 60 * MIN);
  const id = await share(db, 'a', 'p', ['b']);
  const cStart = Date.now() - 5 * MIN;
  await start(db, 'c', 'p', cStart);
  const again = await share(db, 'b', 'p', ['c']);
  assert.equal(again, id, 'b adds to the session b is in, not a new one');
  assert.equal(Number((await timer(db, 'c')).started_at), cStart);
  assert.equal((await people(db, id))[U('c')], 'joined');
});

test('who may share, and with whom', async () => {
  const db = await setup();
  assert.match(await fails(db, 'a', 'select share_session($1, $2)', ['p', [U('b')]]), /Start the timer/);
  await start(db, 'a', 'p', Date.now() - MIN);
  assert.match(await fails(db, 'a', 'select share_session($1, $2)', ['p', [U('d')]]), /project's members can be/);
  await start(db, 'd', 'p', Date.now() - MIN);
  assert.match(await fails(db, 'd', 'select share_session($1, $2)', ['p', [U('a')]]), /project's members can share/);
  for (const t of ['shared_sessions', 'shared_session_people']) {
    const rows = await as(db, 'a', `select * from ${t}`).catch(() => []);
    assert.equal(rows.length, 0, `no direct access to ${t}`);
  }
});

test("push notifications through pg_net, in each device's language", async () => {
  const db = await setup();
  await db.exec(`
    create schema net;
    create table net.sent (url text, body jsonb);
    create function net.http_post(url text, body jsonb, headers jsonb) returns bigint
    language sql as $f$ insert into net.sent values (url, body) returning 1 $f$;`);
  await as(db, 'b', `insert into devices (id, user_id, push_token, language) values ('phone', $1, 'ExponentPushToken[b]', 'es-MX')`, [U('b')]);
  await as(db, 'c', `insert into devices (id, user_id, push_token, language) values ('phone', $1, 'ExponentPushToken[c]', 'en')`, [U('c')]);
  await as(db, 'c', `insert into devices (id, user_id) values ('desktop', $1)`, [U('c')]); // no token: skipped
  await as(db, 'a', `select update_profile('{"display_name": "Pepe"}')`);
  await start(db, 'a', 'p', Date.now() - MIN);
  await start(db, 'c', 'r', Date.now() - MIN);
  const id = await share(db, 'a', 'p', ['b', 'c']);
  const sent = (await db.query('select body from net.sent')).rows.map((r) => r.body);
  assert.equal(sent.length, 2);
  const toB = sent.find((x) => x.to === 'ExponentPushToken[b]');
  const toC = sent.find((x) => x.to === 'ExponentPushToken[c]');
  assert.equal(toB.title, 'Pepe te agregó a una sesión', 'straight in, in Spanish');
  assert.equal(toC.title, 'Pepe invited you to a session', 'asked, in English');
  assert.equal(toC.data.url, `/session-invite?id=${id}`);
  // Answering isn't news: no more pushes.
  await as(db, 'c', 'select join_session($1, null, null)', [id]);
  assert.equal((await db.query('select count(*)::int n from net.sent')).rows[0].n, 2);
});
