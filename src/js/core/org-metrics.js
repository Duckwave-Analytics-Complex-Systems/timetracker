// An organization's dashboard and report, from the sessions this device can
// see: hours and bill by project and by person over a period, how much of
// each person's weekly goal that is, and the report as CSV. Pure (no DOM, no
// backend), shared with the Android app through its src/lib/shared.js.
//
// What "can see" means is the server's: the owner and admins have every
// project of the organization; a member only the projects they're in.

import { addDays, startOfWeek } from './format.js';
import { bill } from './model.js';

/**
 * A period ending now: 'week' (this week so far), 'month' (this month so far)
 * or 'lastMonth' (all of last month). { from, to } in unix ms, and `weeks`,
 * its length in weeks (for goals, which are weekly). `firstDay`: the week's
 * first day (1 = Monday, 0 = Sunday), e.g. the organization's; null = yours.
 */
export function periodRange(kind, now = Date.now(), firstDay) {
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let from;
  let to = now;
  if (kind === 'month') {
    from = new Date(today.getFullYear(), today.getMonth(), 1);
  } else if (kind === 'lastMonth') {
    from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    to = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  } else {
    from = firstDay == null ? startOfWeek(midnight) : startOfWeek(midnight, firstDay);
  }
  // Goals count whole days: a week so far on its first day is a seventh of a week.
  const days = Math.max(1, Math.round((addDays(new Date(to - 1), 1).setHours(0, 0, 0, 0) - from.getTime()) / 86_400_000));
  return { from: from.getTime(), to, weeks: days / 7 };
}

/**
 * Sums sessions over a period.
 * - entries: [{ project_id, user_id, start_ts, seconds }]; user_id null = you.
 *   A session counts in the period it started in.
 * - projects: the organization's projects you can see (with hourly_rate,
 *   people_count, shared, and is_running / run_started_at / run_device for
 *   your open session).
 * - people: the organization's members [{ user_id, display_name, role, is_me }].
 * - running: others' open sessions [{ user_id, project_id, started_at }]
 *   (org_presence()), counted up to `now`.
 * - goals: { user_id: weekly hours } (only those you may see).
 * Returns { seconds, billed, byProject, byPerson, cells }, each list sorted by
 * time, most first; byPerson has everyone in `people`, with no time too.
 */
export function orgSummary({ entries, projects, people, running = [], goals = {}, me, from, to, now = Date.now(), weeks = 1 }) {
  const project = new Map(projects.map((p) => [p.id, p]));
  const cells = new Map(); // "user\0project" -> seconds
  const add = (userId, projectId, secs) => {
    if (!(secs > 0) || !project.has(projectId)) return;
    const key = `${userId}\u0000${projectId}`;
    cells.set(key, (cells.get(key) || 0) + secs);
  };
  for (const e of entries) {
    if (e.start_ts >= from && e.start_ts < to) add(e.user_id || me, e.project_id, e.seconds);
  }
  const openSeconds = (startedAt) => Math.max(0, Math.floor((Math.min(now, to) - Math.max(startedAt, from)) / 1000));
  // Your open session, once: from this device's project if it runs here, else
  // from `running` (it runs on another of your devices).
  let mineHere = false;
  for (const p of projects) {
    if (p.is_running && p.run_started_at != null && !p.run_device) {
      add(me, p.id, openSeconds(p.run_started_at));
      mineHere = true;
    }
  }
  for (const r of running) {
    if (r.user_id === me && mineHere) continue;
    if (r.project_id && r.started_at != null) add(r.user_id, r.project_id, openSeconds(r.started_at));
  }

  const list = [...cells].map(([key, seconds]) => {
    const [userId, projectId] = key.split('\u0000');
    const p = project.get(projectId);
    // A shared project bills each person's hours once (bill() ignores people_count there).
    return { user_id: userId, project_id: projectId, seconds, billed: p.hourly_rate > 0 ? bill(p, seconds) : 0 };
  });

  const byProject = new Map();
  const byPerson = new Map(people.map((m) => [m.user_id, {
    user_id: m.user_id, display_name: m.display_name, role: m.role, is_me: !!m.is_me, seconds: 0, billed: 0,
  }]));
  for (const c of list) {
    const p = project.get(c.project_id);
    const row = byProject.get(c.project_id) || { id: p.id, name: p.name, seconds: 0, billed: 0 };
    row.seconds += c.seconds;
    row.billed += c.billed;
    byProject.set(c.project_id, row);
    // Someone who has left the organization still counts in the totals.
    const person = byPerson.get(c.user_id)
      || { user_id: c.user_id, display_name: null, role: 'former', is_me: false, seconds: 0, billed: 0 };
    person.seconds += c.seconds;
    person.billed += c.billed;
    byPerson.set(c.user_id, person);
  }
  for (const person of byPerson.values()) {
    const goal = goals[person.user_id];
    person.goalHours = goal > 0 ? goal * weeks : null;
    person.utilization = person.goalHours ? person.seconds / 3600 / person.goalHours : null;
  }

  const most = (a, b) => b.seconds - a.seconds || String(a.name ?? a.display_name ?? '').localeCompare(String(b.name ?? b.display_name ?? ''));
  const projectsOut = [...byProject.values()].sort(most);
  return {
    seconds: projectsOut.reduce((a, r) => a + r.seconds, 0),
    billed: projectsOut.reduce((a, r) => a + r.billed, 0),
    byProject: projectsOut,
    byPerson: [...byPerson.values()].sort(most),
    cells: list.sort((a, b) => b.seconds - a.seconds),
  };
}

const csvField = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The report as CSV: one row per person and project, then a total per
 * project and the grand total. Hours to two decimals; bill as a plain number
 * in `currency` (named in the header, so a spreadsheet can read it). Time
 * by people who have left is under `formerName`.
 */
export function orgReportCsv(summary, { orgName, fromLabel, toLabel, currency, formerName = 'Former member' }) {
  const project = new Map(summary.byProject.map((p) => [p.id, p.name]));
  const person = new Map(summary.byPerson.map((m) => [m.user_id, m.display_name || formerName]));
  const hours = (s) => (s / 3600).toFixed(2);
  const amount = (n) => (n > 0 ? n.toFixed(2) : '');
  const bill = `Billed${currency ? ` (${currency})` : ''}`;
  const lines = [
    [`${orgName}: ${fromLabel} to ${toLabel}`],
    [],
    ['Person', 'Project', 'Hours', bill],
    ...summary.cells
      .slice()
      .sort((a, b) => String(person.get(a.user_id)).localeCompare(String(person.get(b.user_id))) || b.seconds - a.seconds)
      .map((c) => [person.get(c.user_id) ?? formerName, project.get(c.project_id), hours(c.seconds), amount(c.billed)]),
    [],
    ['Project', '', 'Hours', bill],
    ...summary.byProject.map((p) => [p.name, '', hours(p.seconds), amount(p.billed)]),
    ['Total', '', hours(summary.seconds), amount(summary.billed)],
  ];
  return lines.map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}
