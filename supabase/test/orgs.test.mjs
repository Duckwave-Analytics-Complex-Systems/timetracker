import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fresh, as, fails, U } from './pglite-harness.mjs';

// a = org owner, b = member, c = admin, d = outsider
async function setup() {
  const db = await fresh({ users: 'abcd' });
  for (const c of 'abcd') await as(db, c, 'select ensure_profile()');
  const [{ create_org: org }] = await as(db, 'a', `select create_org('Duckwave')`);
  const [{ join_code: code }] = await as(db, 'a', 'select join_code from my_orgs()');
  await as(db, 'b', 'select join_org($1)', [code.toLowerCase()]);
  await as(db, 'c', 'select join_org($1)', [code]);
  await as(db, 'a', `select set_org_role($1, $2, 'admin')`, [org, U('c')]);
  return { db, org, code };
}
const shareCode = async (db, c) => (await as(db, c, 'select share_code from ensure_profile()'))[0].share_code;
const projectIds = async (db, c) => (await as(db, c, 'select id from projects order by id')).map((r) => r.id);
const orgOf = async (db, id) => (await db.query('select org_id, user_id from projects where id = $1', [id])).rows[0];

test('create, join, my_orgs', async () => {
  const { db, org } = await setup();
  const mine = await as(db, 'a', 'select * from my_orgs()');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].role, 'owner');
  assert.match(mine[0].join_code, /^ORG-[2-9A-HJ-NP-Z]{6}$/);
  const bs = await as(db, 'b', 'select * from my_orgs()');
  assert.equal(bs[0].role, 'member');
  assert.equal(bs[0].join_code, null, 'members do not see the join code');
  assert.equal((await as(db, 'c', 'select * from my_orgs()'))[0].role, 'admin');
  assert.equal((await as(db, 'd', 'select * from my_orgs()')).length, 0);
  assert.equal((await as(db, 'b', 'select * from my_org_members()')).length, 3);
  assert.equal((await as(db, 'd', 'select * from my_org_members()')).length, 0);
  assert.match(await fails(db, 'd', `select join_org('ORG-XXXXXX')`), /No organization/);
  // Direct table access is closed.
  // Supabase grants tables to authenticated by default (then RLS with no policy
  // returns nothing); the local stub doesn't (refused). Either way: no access.
  for (const t of ['organizations', 'org_members']) {
    const rows = await as(db, 'a', `select * from ${t}`).catch((e) => (assert.match(e.message, /permission denied/), []));
    assert.equal(rows.length, 0);
  }
  await db.exec('grant select on organizations, org_members to authenticated');
  assert.equal((await as(db, 'a', 'select * from organizations')).length, 0, 'RLS, no policy');
  assert.equal(org.length, 36);
});

test('admins see every org project; members only their own', async () => {
  const { db, org } = await setup();
  await as(db, 'a', `insert into projects (id, name, org_id) values ('p1', 'P1', $1)`, [org]);
  await as(db, 'a', `insert into time_entries (id, project_id, seconds) values ('e1', 'p1', 60)`);
  assert.deepEqual(await projectIds(db, 'b'), []);
  assert.deepEqual(await projectIds(db, 'c'), ['p1']);
  assert.deepEqual(await projectIds(db, 'd'), []);
  assert.equal((await as(db, 'c', 'select * from time_entries')).length, 1);
  assert.equal((await as(db, 'c', 'select * from my_memberships()')).length, 1, 'admin gets the members of org projects');
  // An admin can change the project and track time on it.
  await as(db, 'c', `update projects set name = 'Renamed' where id = 'p1'`);
  assert.equal((await db.query(`select name from projects where id = 'p1'`)).rows[0].name, 'Renamed');
  await as(db, 'c', `insert into time_entries (id, project_id, seconds) values ('e2', 'p1', 30)`);
  // ...but a member can't.
  await as(db, 'b', `update projects set name = 'Nope' where id = 'p1'`);
  assert.equal((await db.query(`select name from projects where id = 'p1'`)).rows[0].name, 'Renamed');
});

test('org_id rules', async () => {
  const { db, org } = await setup();
  // An outsider can't put a project in the org.
  await as(db, 'd', `insert into projects (id, name, org_id) values ('pd', 'D', $1)`, [org]);
  assert.equal((await orgOf(db, 'pd')).org_id, null);
  // A member moves their own project in...
  await as(db, 'b', `insert into projects (id, name) values ('pb', 'B')`);
  await as(db, 'b', `update projects set org_id = $1 where id = 'pb'`, [org]);
  assert.equal((await orgOf(db, 'pb')).org_id, org);
  // ...but can't take it out again (an upsert, as the apps send it).
  await as(db, 'b', `insert into projects (id, name, org_id) values ('pb', 'B2', null)
                     on conflict (id) do update set name = excluded.name, org_id = excluded.org_id`);
  const pb = await orgOf(db, 'pb');
  assert.equal(pb.org_id, org, 'kept in the org');
  assert.equal((await db.query(`select name from projects where id = 'pb'`)).rows[0].name, 'B2', 'the rest of the change applies');
  // An admin takes it out.
  await as(db, 'c', `update projects set org_id = null where id = 'pb'`);
  assert.equal((await orgOf(db, 'pb')).org_id, null);
  // Nobody changes the owner directly.
  await as(db, 'b', `update projects set user_id = $1 where id = 'pb'`, [U('d')]);
  assert.equal((await orgOf(db, 'pb')).user_id, U('b'));
});

test('admin takes a project out with RETURNING (PostgREST representation)', async () => {
  const { db, org } = await setup();
  await as(db, 'b', `insert into projects (id, name, org_id) values ('pb', 'B', $1)`, [org]);
  const rows = await as(db, 'c', `update projects set org_id = null where id = 'pb' returning id`);
  assert.deepEqual(rows, [{ id: 'pb' }]);
  assert.equal((await orgOf(db, 'pb')).org_id, null);
});

test('adding people to org projects', async () => {
  const { db, org } = await setup();
  await as(db, 'a', `insert into projects (id, name, org_id) values ('p1', 'P1', $1)`, [org]);
  assert.match(await fails(db, 'a', 'select add_member($1, $2)', ['p1', await shareCode(db, 'd')]), /organization first/);
  assert.equal((await as(db, 'c', 'select add_member_by_id($1, $2) as n', ['p1', U('b')]))[0].n, 'b', 'admin adds');
  assert.deepEqual(await projectIds(db, 'b'), ['p1']);
  assert.match(await fails(db, 'b', 'select add_member_by_id($1, $2)', ['p1', U('c')]), /owner/);
  // Personal projects still take anyone by share code.
  await as(db, 'a', `insert into projects (id, name) values ('p2', 'P2')`);
  await as(db, 'a', 'select add_member($1, $2)', ['p2', await shareCode(db, 'd')]);
  assert.deepEqual(await projectIds(db, 'd'), ['p2']);
});

test('removing and leaving', async () => {
  const { db, org } = await setup();
  await as(db, 'b', `insert into projects (id, name, org_id) values ('pb', 'B', $1)`, [org]);
  await as(db, 'a', `insert into projects (id, name, org_id) values ('p1', 'P1', $1)`, [org]);
  await as(db, 'a', 'select add_member_by_id($1, $2)', ['p1', U('b')]);
  assert.match(await fails(db, 'b', 'select remove_org_member($1, $2)', [org, U('c')]), /owner and admins/);
  assert.match(await fails(db, 'c', 'select remove_org_member($1, $2)', [org, U('a')]), /owner can't leave/);
  assert.match(await fails(db, 'a', 'select remove_org_member($1, $2)', [org, U('a')]), /owner can't leave/);
  await as(db, 'c', 'select remove_org_member($1, $2)', [org, U('b')]);
  assert.deepEqual(await projectIds(db, 'b'), [], 'b is out of the org projects');
  assert.equal((await orgOf(db, 'pb')).user_id, U('a'), "b's org project went to the org owner");
  const pm = (await db.query(`select user_id, role from project_members where project_id = 'pb'`)).rows;
  assert.deepEqual(pm, [{ user_id: U('a'), role: 'owner' }]);
  assert.equal((await as(db, 'b', 'select * from my_orgs()')).length, 0);
  // c leaves by themselves.
  await as(db, 'c', 'select remove_org_member($1, $2)', [org, U('c')]);
  assert.deepEqual(await projectIds(db, 'c'), []);
});

test('roles and handing over', async () => {
  const { db, org } = await setup();
  assert.match(await fails(db, 'c', `select set_org_role($1, $2, 'admin')`, [org, U('b')]), /owner can change/);
  await as(db, 'a', `select set_org_role($1, $2, 'owner')`, [org, U('c')]);
  const roles = Object.fromEntries((await as(db, 'b', 'select user_id, role from my_org_members()')).map((r) => [r.user_id, r.role]));
  assert.deepEqual(roles, { [U('a')]: 'admin', [U('b')]: 'member', [U('c')]: 'owner' });
});

test('update_org, join code reset', async () => {
  const { db, org, code } = await setup();
  await as(db, 'c', `select update_org($1, '{"name":" Studio ","currency":"eur","default_rate":50,"week_start":0}')`, [org]);
  const o = (await as(db, 'b', 'select * from my_orgs()'))[0];
  assert.equal(o.name, 'Studio');
  assert.equal(o.currency, 'EUR');
  assert.equal(o.default_rate, 50);
  assert.equal(o.week_start, 0);
  await as(db, 'c', `select update_org($1, '{"default_rate":null}')`, [org]);
  assert.equal((await as(db, 'b', 'select * from my_orgs()'))[0].default_rate, null);
  assert.match(await fails(db, 'b', `select update_org($1, '{"name":"X"}')`, [org]), /owner and admins/);
  assert.match(await fails(db, 'a', `select update_org($1, '{"currency":"EURO"}')`, [org]), /3-letter/);
  assert.match(await fails(db, 'a', `select update_org($1, '{"id":"x"}')`, [org]), /Unknown organization field/);
  assert.match(await fails(db, 'a', `select update_org($1, '{"name":""}')`, [org]), /1 to 60/);
  const [{ reset_org_join_code: fresh }] = await as(db, 'c', 'select reset_org_join_code($1)', [org]);
  assert.notEqual(fresh, code);
  assert.match(await fails(db, 'd', 'select join_org($1)', [code]), /No organization/);
  await as(db, 'd', 'select join_org($1)', [fresh]);
});

test('avatars of org members', async () => {
  const { db } = await setup();
  const ids = (await as(db, 'b', 'select user_id from member_avatars()')).map((r) => r.user_id).sort();
  assert.deepEqual(ids, [U('a'), U('b'), U('c')]);
  assert.equal((await as(db, 'd', 'select user_id from member_avatars()')).length, 0);
});

test('delete_org makes projects personal', async () => {
  const { db, org } = await setup();
  await as(db, 'b', `insert into projects (id, name, org_id) values ('pb', 'B', $1)`, [org]);
  assert.match(await fails(db, 'c', 'select delete_org($1)', [org]), /owner can delete/);
  await as(db, 'a', 'select delete_org($1)', [org]);
  assert.deepEqual(await orgOf(db, 'pb'), { org_id: null, user_id: U('b') });
  assert.deepEqual(await projectIds(db, 'c'), [], 'admin access ends');
  assert.deepEqual(await projectIds(db, 'b'), ['pb']);
  assert.equal((await as(db, 'b', 'select * from my_orgs()')).length, 0);
});

test('delete_my_account hands the org and its projects on', async () => {
  const { db, org } = await setup();
  await as(db, 'a', `insert into projects (id, name, org_id) values ('p1', 'P1', $1)`, [org]);
  await as(db, 'a', `insert into time_entries (id, project_id, seconds) values ('e1', 'p1', 60)`);
  await as(db, 'a', `insert into projects (id, name) values ('mine', 'Mine')`);
  await as(db, 'a', 'select delete_my_account()');
  assert.equal((await as(db, 'c', 'select role from my_orgs()'))[0].role, 'owner', 'the admin inherits the org');
  assert.equal((await orgOf(db, 'p1')).user_id, U('c'), 'the org project goes to the new owner');
  assert.equal((await as(db, 'c', 'select * from time_entries')).length, 1, "a's time stays");
  assert.equal((await db.query(`select * from projects where id = 'mine'`)).rows.length, 0);
});

test('delete_my_account: a lone owner takes the org with them', async () => {
  const db = await fresh({ users: 'ab' });
  await as(db, 'a', 'select ensure_profile()');
  const [{ create_org: org }] = await as(db, 'a', `select create_org('Solo')`);
  await as(db, 'a', `insert into projects (id, name, org_id) values ('p1', 'P1', $1)`, [org]);
  await as(db, 'a', 'select delete_my_account()');
  assert.equal((await db.query('select count(*)::int n from organizations')).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int n from projects')).rows[0].n, 0);
});

test('personal shared projects keep working as before', async () => {
  const db = await fresh({ users: 'ab' });
  for (const c of 'ab') await as(db, c, 'select ensure_profile()');
  await as(db, 'a', `insert into projects (id, name) values ('p', 'P')`);
  await as(db, 'a', 'select add_member($1, $2)', ['p', await shareCode(db, 'b')]);
  assert.deepEqual(await projectIds(db, 'b'), ['p']);
  await as(db, 'b', `update projects set name = 'x' where id = 'p'`);
  assert.equal((await db.query(`select name from projects`)).rows[0].name, 'P', 'members still cannot change the project');
  await as(db, 'b', 'select remove_member($1, $2)', ['p', U('b')]);
  assert.deepEqual(await projectIds(db, 'b'), []);
  await as(db, 'a', 'select add_member($1, $2)', ['p', await shareCode(db, 'b')]);
  await as(db, 'a', 'select delete_my_account()');
  assert.equal((await orgOf(db, 'p')).user_id, U('b'), 'old heir logic still works');
});

// ---------------------------------------------------------------- presence (Phase 3)

const timer = (db, c, projectId) => as(db, c,
  `select push_timer('start', $1, null, ${Date.now()}, null, 'dev')`, [projectId]);
const presence = async (db, c, org) =>
  Object.fromEntries((await as(db, c, 'select * from org_presence($1)', [org])).map((r) => [r.user_id, r]));

test('org_presence: who is tracking an org project, and what you may see of it', async () => {
  const { db, org } = await setup();
  await as(db, 'a', `insert into projects (id, name, org_id) values ('p1', 'Secret', $1)`, [org]);
  await as(db, 'b', `insert into projects (id, name) values ('mine', 'Personal')`);
  await as(db, 'a', `select update_profile('{"weekly_goal_hours": 30}')`);
  await as(db, 'b', `select update_profile('{"weekly_goal_hours": 20}')`);
  await timer(db, 'a', 'p1');      // an org project
  await timer(db, 'b', 'mine');    // a personal one: never shown

  const forB = await presence(db, 'b', org);
  assert.equal(Object.keys(forB).length, 3);
  assert.equal(forB[U('a')].running, true, 'a is tracking an org project');
  assert.equal(forB[U('a')].project_name, null, "b isn't in p1: no name");
  assert.ok(forB[U('a')].started_at > 0);
  assert.equal(forB[U('b')].running, false, 'personal projects stay private');
  assert.equal(forB[U('a')].weekly_goal_hours, null, "a member doesn't see others' goals");
  assert.equal(forB[U('b')].weekly_goal_hours, 20, 'but sees their own');

  const forC = await presence(db, 'c', org); // admin
  assert.equal(forC[U('a')].project_name, 'Secret', 'admins see org projects');
  assert.equal(forC[U('b')].weekly_goal_hours, 20);
  assert.equal(forC[U('a')].weekly_goal_hours, 30);

  assert.equal((await as(db, 'd', 'select * from org_presence($1)', [org])).length, 0, 'outsiders get nothing');
});

test('org_presence: share_activity off hides you', async () => {
  const { db, org } = await setup();
  await as(db, 'a', `insert into projects (id, name, org_id) values ('p1', 'P1', $1)`, [org]);
  await timer(db, 'a', 'p1');
  await as(db, 'a', `select update_profile('{"share_activity": false}')`);
  const forC = await presence(db, 'c', org);
  assert.equal(forC[U('a')].running, false);
  assert.equal(forC[U('a')].started_at, null);
  assert.equal(forC[U('a')].project_id, null);
  // The phones send it as 1/0 (SQLite has no booleans).
  await as(db, 'a', `select update_profile('{"share_activity": 1}')`);
  assert.equal((await presence(db, 'c', org))[U('a')].running, true);
  const [{ share_activity }] = await as(db, 'a', 'select share_activity from ensure_profile()');
  assert.equal(share_activity, true);
});
