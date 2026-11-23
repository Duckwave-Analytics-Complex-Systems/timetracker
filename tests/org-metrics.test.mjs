import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setWeekStart } from '../src/js/core/format.js';
import { orgReportCsv, orgSummary, periodRange } from '../src/js/core/org-metrics.js';

const H = 3600;
const day = (y, m, d, h = 0) => new Date(y, m - 1, d, h).getTime();

test('periodRange: week so far, from the first day of the week', () => {
  const now = day(2026, 11, 25, 10); // a Wednesday
  const mon = periodRange('week', now, 1);
  assert.equal(mon.from, day(2026, 11, 23));
  assert.equal(mon.to, now);
  assert.ok(Math.abs(mon.weeks - 3 / 7) < 1e-9, 'Mon..Wed = 3 days');
  assert.equal(periodRange('week', now, 0).from, day(2026, 11, 22), 'Sunday start');
});

test('periodRange: this month so far, and all of last month', () => {
  const now = day(2026, 3, 10, 9);
  assert.equal(periodRange('month', now).from, day(2026, 3, 1));
  const last = periodRange('lastMonth', now);
  assert.equal(last.from, day(2026, 2, 1));
  assert.equal(last.to, day(2026, 3, 1));
  assert.ok(Math.abs(last.weeks - 28 / 7) < 1e-9, 'February 2026 has 28 days');
});

const projects = [
  { id: 'web', name: 'Website', hourly_rate: 50, people_count: 1, shared: true },
  { id: 'brand', name: 'Brand', hourly_rate: 0, people_count: 1, shared: false },
];
const people = [
  { user_id: 'me', display_name: 'Pepe', role: 'owner', is_me: true },
  { user_id: 'ana', display_name: 'Ana', role: 'member' },
  { user_id: 'bren', display_name: 'Bren', role: 'admin' },
];
const from = day(2026, 11, 23);
const to = day(2026, 11, 26);

test('orgSummary: totals by project and person, sessions counted where they start', () => {
  const s = orgSummary({
    me: 'me', projects, people, from, to, now: to,
    entries: [
      { project_id: 'web', user_id: null, start_ts: from + H * 1000, seconds: 2 * H },  // mine (null = me)
      { project_id: 'web', user_id: 'ana', start_ts: from + H * 2000, seconds: H },
      { project_id: 'brand', user_id: 'ana', start_ts: from + 10, seconds: 3 * H },
      { project_id: 'web', user_id: 'ana', start_ts: from - 1, seconds: 9 * H },       // before the period
      { project_id: 'web', user_id: 'ana', start_ts: to, seconds: 9 * H },             // after it
      { project_id: 'hidden', user_id: 'ana', start_ts: from + 10, seconds: 9 * H },   // not one of the projects
    ],
  });
  assert.equal(s.seconds, 6 * H);
  assert.equal(s.billed, 150, '3 h on Website at 50; Brand has no rate');
  assert.deepEqual(s.byProject.map((p) => [p.id, p.seconds / H, p.billed]), [['brand', 3, 0], ['web', 3, 150]]);
  assert.deepEqual(s.byPerson.map((p) => [p.user_id, p.seconds / H]), [['ana', 4], ['me', 2], ['bren', 0]]);
  assert.equal(s.cells.length, 3);
});

test('orgSummary: open sessions, yours and others, count up to now', () => {
  const now = from + 2 * H * 1000;
  const s = orgSummary({
    me: 'me', people, from, to, now,
    projects: [{ ...projects[0], is_running: true, run_started_at: now - H * 1000 }, projects[1]],
    entries: [],
    running: [
      { user_id: 'ana', project_id: 'brand', started_at: from - H * 1000 }, // started before the period: only the part in it
      { user_id: 'me', project_id: 'web', started_at: now - H * 1000 },      // you: already counted from the project
      { user_id: 'bren', project_id: null, started_at: now - H * 1000 },     // a project you can't see
    ],
  });
  const by = Object.fromEntries(s.byPerson.map((p) => [p.user_id, p.seconds]));
  assert.equal(by.me, H);
  assert.equal(by.ana, 2 * H);
  assert.equal(by.bren, 0);
});

test("orgSummary: your session on another device counts once, from `running`", () => {
  const now = from + H * 1000;
  const s = orgSummary({
    me: 'me', people, from, to, now, entries: [],
    projects: [{ ...projects[0], is_running: true, run_started_at: from, run_device: 'phone' }],
    running: [{ user_id: 'me', project_id: 'web', started_at: from }],
  });
  assert.equal(s.seconds, H);
});

test('orgSummary: utilization against weekly goals, scaled to the period', () => {
  const s = orgSummary({
    me: 'me', projects, people, from, to, now: to, weeks: 0.5,
    goals: { me: 40, ana: 0 },
    entries: [{ project_id: 'web', user_id: null, start_ts: from, seconds: 10 * H }],
  });
  const me = s.byPerson.find((p) => p.user_id === 'me');
  assert.equal(me.goalHours, 20);
  assert.equal(me.utilization, 0.5);
  assert.equal(s.byPerson.find((p) => p.user_id === 'ana').utilization, null, 'no goal: no figure');
});

test('orgSummary: someone who left still counts', () => {
  const s = orgSummary({
    me: 'me', projects, people, from, to, now: to,
    entries: [{ project_id: 'web', user_id: 'gone', start_ts: from, seconds: H }],
  });
  const gone = s.byPerson.find((p) => p.user_id === 'gone');
  assert.equal(gone.role, 'former');
  assert.equal(gone.seconds, H);
});

test('orgReportCsv', () => {
  const s = orgSummary({
    me: 'me', projects, people, from, to, now: to,
    entries: [
      { project_id: 'web', user_id: null, start_ts: from, seconds: 1.5 * H },
      { project_id: 'brand', user_id: 'gone', start_ts: from, seconds: H },
    ],
  });
  const csv = orgReportCsv(s, { orgName: 'Duck, Inc.', fromLabel: 'Nov 23', toLabel: 'Nov 25', currency: 'EUR' });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], '"Duck, Inc.: Nov 23 to Nov 25"');
  assert.equal(lines[2], 'Person,Project,Hours,Billed (EUR)');
  assert.ok(lines.includes('Pepe,Website,1.50,75.00'));
  assert.ok(lines.includes('Former member,Brand,1.00,'));
  assert.equal(lines.at(-1), 'Total,,2.50,75.00');
});

test("periodRange: no organization week start means yours", () => {
  const now = day(2026, 11, 25, 10); // a Wednesday
  setWeekStart(0);
  assert.equal(periodRange('week', now, null).from, day(2026, 11, 22), 'yours: Sunday');
  assert.equal(periodRange('week', now, undefined).from, day(2026, 11, 22));
  assert.equal(periodRange('week', now, 1).from, day(2026, 11, 23), "the organization's Monday wins");
  setWeekStart(1);
});
