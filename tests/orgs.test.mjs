import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSONAL, defaultRate, inWorkspace, isOrgAdmin, moveTargets, validWorkspace } from '../src/js/core/orgs.js';

const orgs = [
  { id: 'studio', role: 'admin', default_rate: 40 },
  { id: 'club', role: 'member', default_rate: null },
  { id: 'mine', role: 'owner' },
];

test('inWorkspace', () => {
  assert.equal(inWorkspace({ org_id: null }, PERSONAL), true);
  assert.equal(inWorkspace({ org_id: undefined }, PERSONAL), true);
  assert.equal(inWorkspace({ org_id: 'studio' }, PERSONAL), false);
  assert.equal(inWorkspace({ org_id: 'studio' }, 'studio'), true);
  assert.equal(inWorkspace({ org_id: 'studio' }, 'club'), false);
});

test('isOrgAdmin and validWorkspace', () => {
  assert.deepEqual(orgs.map(isOrgAdmin), [true, false, true]);
  assert.equal(isOrgAdmin(undefined), false);
  assert.equal(validWorkspace('club', orgs), 'club');
  assert.equal(validWorkspace('gone', orgs), PERSONAL);
  assert.equal(validWorkspace(PERSONAL, orgs), PERSONAL);
});

test('moveTargets: your personal project goes anywhere', () => {
  assert.deepEqual(moveTargets({ org_id: null, is_owner: true }, orgs), [PERSONAL, 'studio', 'club', 'mine']);
});

test("moveTargets: someone else's personal project stays", () => {
  assert.deepEqual(moveTargets({ org_id: null, is_owner: false }, orgs), [PERSONAL]);
});

test('moveTargets: out of an org only as its admin', () => {
  assert.deepEqual(moveTargets({ org_id: 'club', is_owner: true }, orgs), ['club'], 'member of club');
  assert.deepEqual(moveTargets({ org_id: 'studio', is_owner: true }, orgs), ['studio', PERSONAL, 'club', 'mine']);
});

test('moveTargets: an admin who only manages it can take it out, not elsewhere', () => {
  assert.deepEqual(moveTargets({ org_id: 'studio', is_owner: true, managed_only: true }, orgs), ['studio', PERSONAL]);
});

test('defaultRate', () => {
  assert.equal(defaultRate('studio', orgs, 25), 40);
  assert.equal(defaultRate('club', orgs, 25), 25, 'no org default: yours');
  assert.equal(defaultRate(PERSONAL, orgs, 25), 25);
  assert.equal(defaultRate(PERSONAL, orgs, undefined), null);
});

test('addableMembers', async () => {
  const { addableMembers } = await import('../src/js/core/orgs.js');
  const org = [
    { user_id: 'a', display_name: 'Pepe' },
    { user_id: 'b', display_name: 'ana' },
    { user_id: 'c', display_name: 'Bren' },
  ];
  assert.deepEqual(addableMembers(org, [{ user_id: 'a' }]).map((m) => m.user_id), ['b', 'c'], 'by name, case aside');
  assert.deepEqual(addableMembers(org, org), []);
  assert.deepEqual(addableMembers([], [{ user_id: 'a' }]), []);
});

test('canManageMembers', async () => {
  const { canManageMembers } = await import('../src/js/core/orgs.js');
  assert.equal(canManageMembers({ is_owner: true }), true);
  assert.equal(canManageMembers({ is_owner: true, managed_only: true }), true, 'org admin');
  assert.equal(canManageMembers({ is_owner: false }), false);
  assert.equal(canManageMembers(null), false);
});
