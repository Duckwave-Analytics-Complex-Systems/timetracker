import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planToday, workingDaysBetween } from '../src/js/project/today-plan.js';

const today = new Date(2026, 10, 18, 9); // Wednesday

test('working days between two dates', () => {
  assert.equal(workingDaysBetween(new Date(2026, 10, 18), new Date(2026, 10, 24), 31), 5); // Wed..Tue
  assert.equal(workingDaysBetween(new Date(2026, 10, 18), new Date(2026, 10, 17), 31), 0);
  assert.equal(workingDaysBetween(new Date(2026, 10, 21), new Date(2026, 10, 22), 0), 2); // no days set: all count
});

test('ranks overdue, then due soon, then pending; idle projects are left out', () => {
  const plan = planToday([
    { id: 'idle', name: 'Idle', total_seconds: 0 },
    { id: 'soon', name: 'Soon', due_day: '2026-11-20', budget_hours: 20, total_seconds: 14 * 3600 },
    { id: 'late', name: 'Late', due_day: '2026-11-16', total_seconds: 0 },
    { id: 'todo', name: 'Todo', total_seconds: 0 },
  ], { today, pending: new Map([['todo', 2]]) });
  assert.deepEqual(plan.map((p) => p.id), ['late', 'soon', 'todo']);
  assert.deepEqual(plan[0].reasons, [{ code: 'overdue', days: 2 }]);
  // 6 h left over Wed, Thu, Fri: 2 h a day.
  const soon = plan[1];
  assert.equal(soon.hours, 2);
  assert.deepEqual(soon.reasons, [{ code: 'dueSoon', days: 2 }, { code: 'perDay', hours: 2 }]);
  assert.deepEqual(plan[2].reasons, [{ code: 'pending', count: 2 }]);
});

test('falls back to phase dates and estimates, caps hours at the working day', () => {
  const [p] = planToday([
    { id: 'a', name: 'A', last_end_day: '2026-11-18', estimated_hours: 30, total_seconds: 0 },
  ], { today, dayHours: 9 });
  assert.equal(p.reasons[0].code, 'dueToday');
  assert.equal(p.hours, 9);
});

test('recent work counts a little; at most 3 projects', () => {
  const plan = planToday([
    { id: 'a', name: 'A', last_worked_day: '2026-11-17', total_seconds: 0 },
    { id: 'b', name: 'B', last_worked_day: '2026-11-10', total_seconds: 0 },
    { id: 'c', name: 'C', due_day: '2026-11-30', total_seconds: 0 },
    { id: 'd', name: 'D', due_day: '2026-11-25', total_seconds: 0 },
    { id: 'e', name: 'E', due_day: '2026-11-19', total_seconds: 0 },
  ], { today });
  assert.deepEqual(plan.map((p) => p.id), ['e', 'd', 'c']);
  const onlyRecent = planToday([{ id: 'a', name: 'A', last_worked_day: '2026-11-18' }], { today });
  assert.deepEqual(onlyRecent[0].reasons, [{ code: 'recent' }]);
});
