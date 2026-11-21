// Lifetime stats, streaks and milestones for the profile. Pure functions over
// your own sessions, so the desktop can use them too. Days are local days;
// a session crossing midnight counts on both sides of it.
//
// sessions: [{ project_id, start_ts, end_ts }] in ms, the open one included.
import { addDays, dayKey, parseDay, startOfWeek } from './format.js';

const DAY_MS = 86_400_000;

/** Calls fn(dayKey, jsWeekday, seconds) for each local-day piece of [start, end). */
function eachDay(start, end, fn) {
  let cur = start;
  while (cur < end) {
    const d = new Date(cur);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const stop = Math.min(end, next);
    fn(dayKey(d), d.getDay(), (stop - cur) / 1000);
    cur = stop;
  }
}

/**
 * Totals over all sessions: { totalSeconds, days: Map(dayKey -> seconds),
 * byProject: Map(id -> seconds), byWeekday: seconds[7] (0 = Sunday),
 * longestSession (seconds), firstDay (dayKey or null), activeDays }.
 */
export function lifetimeTotals(sessions) {
  const days = new Map();
  const byProject = new Map();
  const byWeekday = new Array(7).fill(0);
  let totalSeconds = 0;
  let longestSession = 0;
  for (const s of sessions) {
    if (!(s.end_ts > s.start_ts)) continue;
    const secs = (s.end_ts - s.start_ts) / 1000;
    totalSeconds += secs;
    if (secs > longestSession) longestSession = secs;
    byProject.set(s.project_id, (byProject.get(s.project_id) || 0) + secs);
    eachDay(s.start_ts, s.end_ts, (key, wd, part) => {
      days.set(key, (days.get(key) || 0) + part);
      byWeekday[wd] += part;
    });
  }
  const keys = [...days.keys()].sort();
  return { totalSeconds, days, byProject, byWeekday, longestSession, firstDay: keys[0] ?? null, activeDays: keys.length };
}

/** Bit mask of working days: bit 0 = Monday .. bit 6 = Sunday (profiles.work_days). */
export const isWorkingDay = (mask, date) => (mask & (1 << ((date.getDay() + 6) % 7))) !== 0;

/**
 * Streaks of days with tracked time. Days off (not in `workDays`) never break
 * a streak, and count when you did track on them. Today doesn't break the
 * current streak before it's over. `minSeconds`: the least that counts as a day.
 *
 * Returns { current, longest, today: tracked today, atRisk: a working day
 * with nothing yet while a streak is going }.
 */
export function streaks(days, { workDays = 0b0011111, today = new Date(), minSeconds = 60 } = {}) {
  const tracked = (d) => (days.get(dayKey(d)) || 0) >= minSeconds;
  const mask = workDays & 127 ? workDays : 127; // no working days: every day counts
  const keys = [...days.keys()].filter((k) => days.get(k) >= minSeconds).sort();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());

  // Longest: walk from the first tracked day to today.
  let longest = 0;
  let run = 0;
  if (keys.length) {
    for (let d = parseDay(keys[0]); d <= start; d = addDays(d, 1)) {
      if (tracked(d)) run += 1;
      else if (isWorkingDay(mask, d) && d < start) run = 0;
      if (run > longest) longest = run;
    }
  }

  // Current: back from today (today itself only adds, never breaks).
  let current = tracked(start) ? 1 : 0;
  for (let d = addDays(start, -1); ; d = addDays(d, -1)) {
    if (keys.length === 0 || dayKey(d) < keys[0]) break;
    if (tracked(d)) current += 1;
    else if (isWorkingDay(mask, d)) break;
  }

  const didToday = tracked(start);
  return { current, longest, today: didToday, atRisk: !didToday && current > 0 && isWorkingDay(mask, start) };
}

/**
 * The weekly goal met in consecutive weeks: { current, best }. A week counts
 * when its hours reach `goalHours`; this week only counts once it's met.
 * The goal set now is applied to past weeks (no history of goals is kept).
 */
export function goalWeeks(days, goalHours, { today = new Date(), weekStart = 1 } = {}) {
  if (!(goalHours > 0) || days.size === 0) return { current: 0, best: 0 };
  const perWeek = new Map();
  for (const [key, secs] of days) {
    const w = dayKey(startOfWeek(parseDay(key), weekStart));
    perWeek.set(w, (perWeek.get(w) || 0) + secs);
  }
  const met = (w) => (perWeek.get(dayKey(w)) || 0) >= goalHours * 3600;
  const thisWeek = startOfWeek(new Date(today.getFullYear(), today.getMonth(), today.getDate()), weekStart);
  const first = startOfWeek(parseDay([...perWeek.keys()].sort()[0]), weekStart);

  let best = 0;
  let run = 0;
  for (let w = first; w <= thisWeek; w = addDays(w, 7)) {
    if (met(w)) run += 1;
    else if (w < thisWeek) run = 0;
    best = Math.max(best, run);
  }
  let current = met(thisWeek) ? 1 : 0;
  for (let w = addDays(thisWeek, -7); w >= first && met(w); w = addDays(w, -7)) current += 1;
  return { current, best };
}

/** The busiest weekday (0 = Sunday) by tracked time, or null. */
export function busiestWeekday(byWeekday) {
  let best = null;
  byWeekday.forEach((v, i) => { if (v > 0 && (best === null || v > byWeekday[best])) best = i; });
  return best;
}

/**
 * The milestones, in display order. Each: { key, kind, target, value, earned }.
 * `kind` groups them for wording: 'hours', 'streak', 'ended', 'underBudget', 'goalWeeks'.
 * Input: { totalHours, longestStreak, endedProjects, underBudget, goalWeeksBest }.
 */
export const MILESTONES = [
  { key: 'hours10', kind: 'hours', target: 10 },
  { key: 'hours100', kind: 'hours', target: 100 },
  { key: 'hours500', kind: 'hours', target: 500 },
  { key: 'hours1000', kind: 'hours', target: 1000 },
  { key: 'streak7', kind: 'streak', target: 7 },
  { key: 'streak30', kind: 'streak', target: 30 },
  { key: 'streak100', kind: 'streak', target: 100 },
  { key: 'ended1', kind: 'ended', target: 1 },
  { key: 'ended5', kind: 'ended', target: 5 },
  { key: 'underBudget1', kind: 'underBudget', target: 1 },
  { key: 'goalWeeks4', kind: 'goalWeeks', target: 4 },
];

export function milestones({ totalHours = 0, longestStreak = 0, endedProjects = 0, underBudget = 0, goalWeeksBest = 0 }) {
  const values = {
    hours: totalHours, streak: longestStreak, ended: endedProjects, underBudget, goalWeeks: goalWeeksBest,
  };
  return MILESTONES.map((m) => {
    const value = values[m.kind];
    return { ...m, value, earned: value >= m.target };
  });
}

/**
 * Projects you ended (filed) and those that came in at or under budget.
 * `projects`: your own archived projects ({ archived, budget_hours, total_seconds }).
 */
export function endedProjects(projects) {
  const ended = projects.filter((p) => p.archived);
  const underBudget = ended.filter((p) => p.budget_hours > 0 && p.total_seconds / 3600 <= p.budget_hours);
  return { ended: ended.length, underBudget: underBudget.length };
}

/** Whole days since `firstDay` (dayKey), today included: "tracking for N days". */
export function daysSince(firstDay, today = new Date()) {
  const d = parseDay(firstDay);
  if (!d) return 0;
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((t - d) / DAY_MS) + 1;
}
