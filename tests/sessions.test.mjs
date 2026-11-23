import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addableToSession, companions, isSharedRun, namesText, pendingInvites, sessionOf } from '../src/js/core/sessions.js';

const session = {
  id: 's1', project_id: 'p', host_id: 'pepe', host_name: 'Pepe', started_at: 0, my_status: 'joined',
  people: [
    { user_id: 'ana', name: 'Ana', status: 'joined' },
    { user_id: 'bren', name: 'Bren', status: 'asked' },
    { user_id: 'me', name: 'Me', status: 'joined' },
  ],
};

test('isSharedRun', () => {
  assert.equal(isSharedRun({ run_device: 'shared:s1' }), true);
  assert.equal(isSharedRun({ run_device: 'desktop-1' }), false);
  assert.equal(isSharedRun({ run_device: null }), false);
  assert.equal(isSharedRun(undefined), false);
});

test('sessionOf: started or joined, not asked', () => {
  assert.equal(sessionOf('p', [session]), session);
  assert.equal(sessionOf('p', [{ ...session, my_status: 'host' }]).id, 's1');
  assert.equal(sessionOf('p', [{ ...session, my_status: 'asked' }]), null);
  assert.equal(sessionOf('other', [session]), null);
});

test('companions: the host and who joined, not you, not who is only asked', () => {
  assert.deepEqual(companions(session, 'me'), ['Pepe', 'Ana']);
  assert.deepEqual(companions({ ...session, host_id: 'me' }, 'me'), ['Ana']);
  assert.deepEqual(companions(null, 'me'), []);
});

test('namesText', () => {
  assert.equal(namesText([]), '');
  assert.equal(namesText(['Ana']), 'Ana');
  assert.equal(namesText(['Ana', 'Bren']), 'Ana and Bren');
  assert.equal(namesText(['Ana', 'Bren', 'Carla'], 'y'), 'Ana, Bren y Carla');
});

test('pendingInvites', () => {
  const asked = { ...session, id: 's2', my_status: 'asked' };
  assert.deepEqual(pendingInvites([session, asked]).map((s) => s.id), ['s2']);
  assert.deepEqual(pendingInvites([asked], new Set(['s2'])), []);
});

test('addableToSession: the project but you, the host and anyone in or asked', () => {
  const members = [
    { user_id: 'me', display_name: 'Me' }, { user_id: 'pepe', display_name: 'Pepe' },
    { user_id: 'ana', display_name: 'Ana' }, { user_id: 'bren', display_name: 'Bren' },
    { user_id: 'zoe', display_name: 'zoe' }, { user_id: 'carla', display_name: 'Carla' },
    { user_id: null, display_name: 'Former members' },
  ];
  assert.deepEqual(addableToSession(members, session, 'me').map((m) => m.user_id), ['carla', 'zoe']);
  assert.deepEqual(addableToSession(members, null, 'me').map((m) => m.user_id),
    ['ana', 'bren', 'carla', 'pepe', 'zoe'], 'not shared yet: everyone but you');
});
