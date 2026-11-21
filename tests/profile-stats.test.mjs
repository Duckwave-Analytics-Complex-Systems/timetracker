// Run with: npm test (node --test). Local-time dates throughout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  busiestWeekday, daysSince, endedProjects, goalWeeks, lifetimeTotals, milestones, streaks,
} from '../src/js/core/profile-stats.js';

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const span = (start, hours, project = 'p') => ({ project_id: project, start_ts: start, end_ts: start + hours * 3_600_000 });
/** days Map from { 'YYYY-MM-DD': hours }. */
const daysOf = (obj) => new Map(Object.entries(obj).map(([k, h]) => [k, h * 3600]));

test('lifetimeTotals splits at local midnight and sums', () => {
  const t = lifetimeTotals([
    span(at(2026, 11, 16, 23), 2, 'a'), // Mon 23:00 -> Tue 01:00
    span(at(2026, 11, 18, 9), 3, 'b'),
    { project_id: 'x', start_ts: 5, end_ts: 5 }, // empty: ignored
  ]);
  assert.equal(t.totalSeconds, 5 * 3600);
  assert.equal(t.days.get('2026-11-16'), 3600);
  assert.equal(t.days.get('2026-11-17'), 3600);
  assert.equal(t.days.get('2026-11-18'), 3 * 3600);
  assert.equal(t.longestSession, 3 * 3600);
  assert.equal(t.firstDay, '2026-11-16');
  assert.equal(t.activeDays, 3);
  assert.equal(t.byProject.get('a'), 2 * 3600);
  assert.equal(busiestWeekday(t.byWeekday), 3); // Wednesday
});

test('lifetimeTotals of nothing', () => {
  const t = lifetimeTotals([]);
  assert.equal(t.totalSeconds, 0);
  assert.equal(t.firstDay, null);
  assert.equal(busiestWeekday(t.byWeekday), null);
});

test('weekends off do not break a streak', () => {
  // Thu 12, Fri 13, (Sat, Sun off), Mon 16, Tue 17; today Wed 18 not tracked yet.
  const days = daysOf({ '2026-11-12': 1, '2026-11-13': 2, '2026-11-16': 1, '2026-11-17': 1 });
  const s = streaks(days, { today: new Date(2026, 10, 18, 10) });
  assert.equal(s.current, 4);
  assert.equal(s.longest, 4);
  assert.equal(s.today, false);
  assert.equal(s.atRisk, true);
});

test('a missed working day breaks it; tracking on a day off counts', () => {
  const days = daysOf({
    '2026-11-02': 1, '2026-11-03': 1, '2026-11-04': 1, // Mon-Wed: 3
    // Thu 5 missed
    '2026-11-06': 1, '2026-11-07': 1, '2026-11-08': 1, '2026-11-09': 1, // Fri, Sat, Sun, Mon
  });
  const s = streaks(days, { today: new Date(2026, 10, 9, 20) });
  assert.equal(s.current, 4);
  assert.equal(s.longest, 4);
  assert.equal(s.today, true);
  assert.equal(s.atRisk, false);
});

test('a streak ends after a missed working day before today', () => {
  const days = daysOf({ '2026-11-16': 1 }); // Mon; Tue missed; today Wed
  const s = streaks(days, { today: new Date(2026, 10, 18) });
  assert.equal(s.current, 0);
  assert.equal(s.longest, 1);
  assert.equal(s.atRisk, false);
});

test('less than a minute is not a day; every day counts with all days working', () => {
  const days = new Map([['2026-11-14', 30], ['2026-11-15', 3600]]); // Sat (30 s), Sun
  assert.equal(streaks(days, { today: new Date(2026, 10, 15), workDays: 127 }).current, 1);
  assert.equal(streaks(new Map(), { today: new Date(2026, 10, 15) }).current, 0);
});

test('goalWeeks counts consecutive weeks at the goal', () => {
  const days = daysOf({
    '2026-10-19': 10, // week of Oct 19: 10 h (miss)
    '2026-10-26': 20, // Oct 26: met
    '2026-11-02': 25, // Nov 2: met
    '2026-11-09': 20, // Nov 9: met
    '2026-11-16': 5, // this week (Nov 16): not yet
  });
  const g = goalWeeks(days, 20, { today: new Date(2026, 10, 18) });
  assert.deepEqual(g, { current: 3, best: 3 });
  assert.deepEqual(goalWeeks(days, 0), { current: 0, best: 0 });
  // Sunday weeks: Nov 15 (Sun) starts a new week.
  const sun = goalWeeks(daysOf({ '2026-11-14': 20, '2026-11-15': 20 }), 20, { today: new Date(2026, 10, 15), weekStart: 0 });
  assert.deepEqual(sun, { current: 2, best: 2 });
});

test('milestones and ended projects', () => {
  const { ended, underBudget } = endedProjects([
    { archived: true, budget_hours: 10, total_seconds: 9 * 3600 },
    { archived: true, budget_hours: 10, total_seconds: 11 * 3600 },
    { archived: true, budget_hours: null, total_seconds: 3600 },
  ]);
  assert.equal(ended, 3);
  assert.equal(underBudget, 1);
  const list = milestones({ totalHours: 120, longestStreak: 8, endedProjects: ended, underBudget, goalWeeksBest: 1 });
  const earned = list.filter((m) => m.earned).map((m) => m.key);
  assert.deepEqual(earned, ['hours10', 'hours100', 'streak7', 'ended1', 'underBudget1']);
  assert.equal(list.find((m) => m.key === 'hours500').value, 120);
});

test('daysSince counts today', () => {
  assert.equal(daysSince('2026-11-18', new Date(2026, 10, 18, 15)), 1);
  assert.equal(daysSince('2026-11-01', new Date(2026, 10, 18)), 18);
  assert.equal(daysSince(null), 0);
});

test('yearSummary clips to the year and finds the top project and month', async () => {
  const { yearSummary } = await import('../src/js/core/profile-stats.js');
  const y = yearSummary([
    span(at(2025, 12, 31, 23), 2, 'a'), // 1 h in 2025, 1 h in 2026
    span(at(2026, 3, 2, 9), 3, 'b'), // Mon
    span(at(2026, 3, 3, 9), 4, 'b'), // Tue
    span(at(2026, 7, 1, 9), 1, 'a'),
    span(at(2027, 1, 1, 9), 5, 'c'), // next year: ignored
  ], 2026, { today: new Date(2026, 10, 20) });
  assert.equal(y.totalSeconds, 9 * 3600);
  assert.equal(y.byMonth[0], 3600);
  assert.equal(y.byMonth[2], 7 * 3600);
  assert.equal(y.busiestMonth, 2);
  assert.deepEqual(y.topProject, { id: 'b', seconds: 7 * 3600 });
  assert.equal(y.activeDays, 4);
  assert.equal(y.longestStreak, 2);
  assert.equal(y.longestSession, 4 * 3600);
  const empty = yearSummary([], 2026);
  assert.equal(empty.busiestMonth, null);
  assert.equal(empty.topProject, null);
  assert.equal(empty.longestStreak, 0);
});
