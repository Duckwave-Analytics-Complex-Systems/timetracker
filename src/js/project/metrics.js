// Project progress metrics. Pure functions: data in, numbers out. The
// Overview tab and the report both read from `computeMetrics`, so they
// always agree.
//
// Vocabulary:
//   budget     planned hours: project.budget_hours, else the sum of phase estimates
//   completion work done, 0..1: each phase's progress %, weighted by its estimate
//              (by its length in days when no phase has an estimate)
//   planned    completion the schedule expects by today, same weighting,
//              assuming each phase progresses linearly from its start to its end
//   efficiency earned hours / spent hours, where earned = completion x budget
//              (> 1: progress costs fewer hours than planned)
import { addDays, clamp, dayKey, daysBetween, fmtDate, fmtHours, parseDay, pct, startOfToday, startOfWeek } from '../core/format.js';
import { liveAdditions, liveSeconds, openSessionSeconds } from '../core/model.js';

export const isMilestone = (ph) => ph.kind === 'milestone';

export const HEALTH = {
  done: { label: 'Completed', tone: 'ok' },
  ok: { label: 'On track', tone: 'ok' },
  risk: { label: 'At risk', tone: 'warn' },
  behind: { label: 'Behind', tone: 'bad' },
  upcoming: { label: 'Not started', tone: 'info' },
  unplanned: { label: 'No plan yet', tone: 'idle' },
};

const PHASE_STATUS = {
  done: { label: 'Done', milestone: 'Reached', tone: 'ok' },
  active: { label: 'In progress', milestone: 'Due today', tone: 'info' },
  upcoming: { label: 'Upcoming', milestone: 'Upcoming', tone: 'idle' },
  overdue: { label: 'Overdue', milestone: 'Missed', tone: 'bad' },
};

export function phaseStatusLabel(row) {
  const s = PHASE_STATUS[row.status];
  return { text: isMilestone(row) ? s.milestone : s.label, tone: s.tone };
}

const sum = (items, f) => items.reduce((a, x) => a + f(x), 0);
const minDate = (ds) => (ds.length ? new Date(Math.min(...ds)) : null);
const maxDate = (ds) => (ds.length ? new Date(Math.max(...ds)) : null);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Folds the open session (if the project is running) into the backend
 * detail: phase hours, per-day hours and the total.
 */
export function withLiveTime({ project, phases, daily }, now = Date.now()) {
  const open = openSessionSeconds(project, now);
  const livePhases = phases.map((ph) =>
    open && ph.id === project.active_phase_id ? { ...ph, spent_seconds: ph.spent_seconds + open } : ph);
  const byDay = new Map(daily.map((d) => [d.day, d.seconds]));
  for (const [day, , s] of liveAdditions([project], now)) byDay.set(day, (byDay.get(day) || 0) + s);
  const liveDaily = [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, seconds]) => ({ day, seconds }));
  return { project, phases: livePhases, daily: liveDaily, totalSeconds: liveSeconds(project, now) };
}

/** Share of a phase the schedule expects done at the *start* of `day` (0..1). */
function plannedAt(ph, day) {
  const s = parseDay(ph.start_day);
  const e = parseDay(ph.end_day);
  return clamp(daysBetween(s, day) / (daysBetween(s, e) + 1), 0, 1);
}

export function computeMetrics({ project, phases, daily, totalSeconds }, today = startOfToday()) {
  const work = phases.filter((p) => !isMilestone(p));
  const spentH = totalSeconds / 3600;
  const estimatedH = sum(work, (p) => p.estimated_hours);
  const budgetH = project.budget_hours > 0 ? project.budget_hours : estimatedH > 0 ? estimatedH : null;
  const remainingH = budgetH != null ? budgetH - spentH : null; // negative = over budget
  const budgetUsed = budgetH ? spentH / budgetH : null;
  const assignedH = sum(phases, (p) => p.spent_seconds) / 3600;
  const unassignedH = Math.max(0, spentH - assignedH);

  // ---- timeline
  const start = parseDay(project.start_day)
    || minDate(phases.map((p) => parseDay(p.start_day)))
    || (daily.length ? parseDay(daily[0].day) : null);
  const due = parseDay(project.due_day) || maxDate(phases.map((p) => parseDay(p.end_day)));
  let timelineElapsed = null, daysLeft = null, totalDays = null;
  if (start && due && due >= start) {
    totalDays = daysBetween(start, due) + 1;
    timelineElapsed = clamp(daysBetween(start, today) / totalDays, 0, 1);
    daysLeft = daysBetween(today, due);
  }

  // ---- completion vs plan
  const byEstimate = estimatedH > 0;
  const weightOf = (p) => (byEstimate ? p.estimated_hours : daysBetween(parseDay(p.start_day), parseDay(p.end_day)) + 1);
  const totalWeight = sum(work, weightOf);
  const hasPhases = work.length > 0 && totalWeight > 0;
  const completion = hasPhases ? sum(work, (p) => weightOf(p) * p.progress / 100) / totalWeight : null;
  const planned = hasPhases ? sum(work, (p) => weightOf(p) * plannedAt(p, today)) / totalWeight : timelineElapsed;

  // ---- hours efficiency and forecast
  const earnedH = completion != null && budgetH ? completion * budgetH : null;
  const efficiency = earnedH != null && spentH > 0.25 ? earnedH / spentH : null;
  const eacH = completion != null && completion >= 0.05 ? spentH / completion : null; // projected total hours
  const recentFrom = addDays(today, -27);
  const weeklyPace = sum(daily.filter((d) => parseDay(d.day) >= recentFrom), (d) => d.seconds) / 3600 / 4;
  const workLeftH = completion != null && completion >= 1 ? 0
    : eacH != null ? Math.max(0, eacH - spentH)
    : remainingH != null ? Math.max(0, remainingH) : null;
  const forecastFinish = workLeftH > 0 && weeklyPace >= 0.25 ? addDays(today, Math.ceil((workLeftH / weeklyPace) * 7)) : null;

  // ---- phases
  const phaseRows = phases.map((p) => {
    const s = parseDay(p.start_day);
    const e = parseDay(p.end_day);
    const pSpentH = p.spent_seconds / 3600;
    let status;
    if (p.progress >= 100) status = 'done';
    else if (today > e) status = 'overdue';
    else if (today < s) status = pSpentH > 0 || p.progress > 0 ? 'active' : 'upcoming';
    else status = 'active';
    return {
      ...p,
      start: s,
      end: e,
      spentH: pSpentH,
      remainingH: p.estimated_hours > 0 ? p.estimated_hours - pSpentH : null,
      overBudget: p.estimated_hours > 0 && pSpentH > p.estimated_hours,
      plannedNow: plannedAt(p, today),
      status,
    };
  });

  // ---- health + the reasons behind it
  const notes = []; // { tone: 'ok' | 'warn' | 'bad', text }
  let health;
  if (completion != null && completion >= 0.999) {
    health = 'done';
    notes.push({ tone: 'ok', text: `All phases are complete, using ${fmtHours(spentH)}${budgetH ? ` of ${fmtHours(budgetH)} budgeted` : ''}.` });
  } else if (!hasPhases && !budgetH && !due) {
    health = 'unplanned';
    notes.push({ tone: 'warn', text: 'Add dates, a budget or phases in the Schedule tab to measure progress.' });
  } else if (start && today < start && spentH < 0.01) {
    health = 'upcoming';
    notes.push({ tone: 'ok', text: `Starts ${fmtDate(start)}.` });
  } else {
    let level = 0; // 0 on track, 1 at risk, 2 behind
    const flag = (lvl, text) => {
      level = Math.max(level, lvl);
      notes.push({ tone: lvl === 2 ? 'bad' : 'warn', text });
    };
    if (daysLeft != null && daysLeft < 0) flag(2, `The due date passed ${plural(-daysLeft, 'day')} ago.`);
    if (completion != null && planned != null) {
      const gap = completion - planned;
      if (gap < -0.15) flag(2, `Work done (${pct(completion)}) is well behind the plan (${pct(planned)} expected by today).`);
      else if (gap < -0.05) flag(1, `Work done (${pct(completion)}) is slightly behind the plan (${pct(planned)} expected by today).`);
      else if (gap > 0.05) notes.push({ tone: 'ok', text: `Ahead of plan: ${pct(completion)} done, ${pct(planned)} expected by today.` });
      else notes.push({ tone: 'ok', text: `Progress (${pct(completion)}) matches the plan (${pct(planned)} expected by today).` });
    }
    if (budgetUsed != null) {
      if (budgetUsed > 1) flag(2, `Over budget: ${fmtHours(spentH)} spent of ${fmtHours(budgetH)} (${pct(budgetUsed)}).`);
      else if (efficiency != null && efficiency < 0.8) flag(1, `Hours are running ahead of progress: ${pct(budgetUsed)} of the budget spent for ${pct(completion)} of the work.`);
      else if (efficiency == null && timelineElapsed != null && budgetUsed > timelineElapsed + 0.15) flag(1, `${pct(budgetUsed)} of the budget spent with ${pct(timelineElapsed)} of the timeline elapsed.`);
      else if (efficiency != null && efficiency >= 1.05) notes.push({ tone: 'ok', text: `Efficient: progress is costing fewer hours than planned (${efficiency.toFixed(2)}× earned per hour spent).` });
    }
    if (forecastFinish && due && daysLeft >= 0 && forecastFinish > due) {
      flag(1, `At the recent pace (${fmtHours(weeklyPace)}/week) the remaining work would end around ${fmtDate(forecastFinish)}, after the due date.`);
    }
    const overdue = phaseRows.filter((r) => r.status === 'overdue');
    if (overdue.length) flag(1, `${plural(overdue.length, 'item')} past their date and not finished: ${overdue.map((r) => r.name).join(', ')}.`);
    const overPhases = phaseRows.filter((r) => r.overBudget && r.status !== 'done');
    if (overPhases.length) flag(1, `Over their hour estimate: ${overPhases.map((r) => r.name).join(', ')}.`);
    health = ['ok', 'risk', 'behind'][level];
  }

  return {
    spentH, estimatedH, budgetH, remainingH, budgetUsed, unassignedH,
    start, due, today, totalDays, timelineElapsed, daysLeft,
    completion, planned, earnedH, efficiency, eacH, weeklyPace, workLeftH, forecastFinish,
    phaseRows, health, notes,
  };
}

/** One-paragraph plain-language summary for the overview and the report. */
export function summarySentence(name, m) {
  const parts = [];
  if (m.completion != null) parts.push(`${name} is ${pct(m.completion)} complete`);
  else parts.push(`${fmtHours(m.spentH)} have been tracked on ${name}`);
  if (m.budgetH) parts.push(`${fmtHours(m.spentH)} of the ${fmtHours(m.budgetH)} budget are spent (${pct(m.budgetUsed)})`);
  if (m.timelineElapsed != null) {
    const left = m.daysLeft >= 0 ? `${plural(m.daysLeft, 'day')} left` : `${plural(-m.daysLeft, 'day')} past due`;
    parts.push(`${pct(m.timelineElapsed)} of the timeline has elapsed (${left})`);
  }
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}.` : `${parts[0]}.`;
}

/** Hours per week (weeks start Monday), from the project start up to this week. */
export function weeklySeries(daily, m, { maxWeeks = 26, minWeeks = 8 } = {}) {
  const lastWeek = startOfWeek(m.today);
  let first = startOfWeek(m.start && m.start < m.today ? m.start : lastWeek);
  const earliest = addDays(lastWeek, -7 * (maxWeeks - 1));
  const latestFirst = addDays(lastWeek, -7 * (minWeeks - 1));
  if (first < earliest) first = earliest;
  if (first > latestFirst) first = latestFirst;

  const weeks = [];
  for (let d = first; d <= lastWeek; d = addDays(d, 7)) weeks.push({ start: d, hours: 0 });
  for (const row of daily) {
    const idx = Math.floor(daysBetween(first, parseDay(row.day)) / 7);
    if (idx >= 0 && idx < weeks.length) weeks[idx].hours += row.seconds / 3600;
  }
  return weeks;
}

/**
 * Cumulative hours over the project's timeline: actual (up to today), the
 * plan (budget spread over each phase's dates) and the budget line.
 */
export function burnupSeries(daily, m, phases) {
  const firstDay = daily.length ? parseDay(daily[0].day) : m.today;
  const start = m.start && m.start < firstDay ? m.start : m.start || firstDay;
  const lastPhaseEnd = maxDate(phases.map((p) => parseDay(p.end_day)));
  const end = maxDate([m.due, m.today, lastPhaseEnd].filter(Boolean));
  const days = daysBetween(start, end) + 1;

  const perDay = new Map(daily.map((d) => [d.day, d.seconds / 3600]));
  const base = daily.filter((d) => parseDay(d.day) < start).reduce((a, d) => a + d.seconds / 3600, 0);
  let cum = base;
  const actual = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    if (d > m.today) break;
    cum += perDay.get(dayKey(d)) || 0;
    actual.push({ i, value: cum });
  }

  let planned = null;
  const work = phases.filter((p) => !isMilestone(p));
  if (m.budgetH) {
    planned = [];
    const byEstimate = work.some((p) => p.estimated_hours > 0);
    const weightOf = (p) => (byEstimate ? p.estimated_hours : daysBetween(parseDay(p.start_day), parseDay(p.end_day)) + 1);
    const W = sum(work, weightOf);
    for (let i = 0; i < days; i++) {
      const next = addDays(start, i + 1); // end of day i
      let frac;
      if (W > 0) frac = sum(work, (p) => weightOf(p) * plannedAt(p, next)) / W;
      else if (m.due) frac = clamp((i + 1) / (daysBetween(start, m.due) + 1), 0, 1);
      else { planned = null; break; }
      planned.push({ i, value: frac * m.budgetH });
    }
  }
  return { start, days, base, actual, planned, budgetH: m.budgetH, todayIndex: daysBetween(start, m.today), dueIndex: m.due ? daysBetween(start, m.due) : null };
}
