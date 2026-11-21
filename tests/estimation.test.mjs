import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  direction, estimationSummary, likelyHours, median, phaseAccuracy, projectSamples,
} from '../src/js/project/estimation.js';

const proj = (id, budget, hours, endedAt, extra = {}) => ({
  id, name: id.toUpperCase(), archived: true, archived_at: endedAt, budget_hours: budget, total_seconds: hours * 3600, ...extra,
});

test('median', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('samples skip active, unbudgeted and untracked projects', () => {
  const s = projectSamples([
    proj('a', 10, 12, 2),
    proj('b', 10, 8, 1),
    proj('c', 0, 5, 3),
    proj('d', 10, 0, 4),
    proj('e', 10, 5, 5, { archived: false }),
  ]);
  assert.deepEqual(s.map((x) => x.id), ['b', 'a']);
  assert.equal(s[1].ratio, 1.2);
});

test('nothing is shown before 3 finished projects', () => {
  const r = estimationSummary([proj('a', 10, 12, 1), proj('b', 10, 8, 2)]);
  assert.equal(r.needed, 1);
  assert.equal(r.ratio, null);
});

test('summary: median, best, worst, trend', () => {
  const list = [
    proj('a', 10, 12, 1), // 1.2
    proj('b', 10, 10.2, 2), // 1.02
    proj('c', 10, 20, 3), // 2.0
    proj('d', 20, 10, 4), // 0.5
    proj('e', 10, 13, 5), // 1.3
    proj('f', 10, 11, 6), // 1.1
    proj('g', 10, 14, 7), // 1.4
  ];
  const r = estimationSummary(list);
  assert.equal(r.count, 7);
  assert.equal(r.ratio, 1.2);
  assert.equal(r.best.id, 'b');
  assert.equal(r.onTarget, 1);
  // 2× over and 2× under are equally far: the first in the list wins.
  assert.ok(['c', 'd'].includes(r.worst.id));
  assert.deepEqual(r.trend.map((x) => x.id), ['b', 'c', 'd', 'e', 'f', 'g']);
});

test('phases grouped by name, needing 2 samples', () => {
  const ph = (project_id, name, est, spentH, kind = 'phase') => ({ project_id, name, kind, estimated_hours: est, spent_seconds: spentH * 3600 });
  const rows = phaseAccuracy([
    ph('a', 'Design', 10, 13),
    ph('b', '  design ', 10, 13.4),
    ph('a', 'Build', 20, 20),
    ph('b', 'build', 20, 21),
    ph('a', 'Launch', 0, 2, 'milestone'),
    ph('b', 'Launch', 0, 2, 'milestone'),
    ph('a', 'QA', 5, 0), // no time booked: skipped
    ph('b', 'QA', 5, 4),
    ph('z', 'Design', 10, 50), // not a sample project
  ], new Set(['a', 'b']));
  assert.deepEqual(rows.map((r) => r.name), ['Design', 'Build']);
  assert.ok(Math.abs(rows[0].ratio - 1.32) < 1e-9);
  assert.equal(rows[0].samples, 2);
});

test('likely hours and direction', () => {
  assert.ok(Math.abs(likelyHours(40, 1.18) - 47.2) < 1e-9);
  assert.equal(likelyHours(0, 1.2), null);
  assert.equal(likelyHours(10, null), null);
  assert.equal(direction(1.03), 'onTarget');
  assert.equal(direction(1.2), 'over');
  assert.equal(direction(0.8), 'under');
});
