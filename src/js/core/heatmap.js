// Hour-of-day activity: which hours of the day you track time in, from your
// own sessions (time_entries) plus the open one. Pure, no DOM, so the phone
// app can use the same code (timetrack-mobile/src/lib/heatmap.js mirrors it).
//
// 1, 3 and 7 days: one row per day, so you see when you worked on each day.
// A cell is the share of that hour you tracked, so a full hour is darkest.
// 30 days and 12 weeks: one row per weekday (Mon..Sun), summed over the
// period. Cells are relative to the busiest one.
import { addDays, dayKey, fmtDate, pad2, startOfToday } from './format.js';

export const HEATMAP_RANGES = {
  '1d': { days: 1, label: '1 day', title: 'today', by: 'day' },
  '3d': { days: 3, label: '3 days', title: 'last 3 days', by: 'day' },
  '7d': { days: 7, label: '7 days', title: 'last 7 days', by: 'day' },
  '30d': { days: 30, label: '30 days', title: 'last 30 days', by: 'weekday' },
  '12w': { days: 84, label: '12 weeks', title: 'last 12 weeks', by: 'weekday' },
};
/** How many days of sessions to load to cover the longest range. */
export const HEATMAP_FETCH_DAYS = 84;
/**
 * Opacity of the accent colour at each step, from a little to the most.
 * Index 0 is unused: an empty cell takes the theme's empty colour.
 */
export const HEAT_OPACITY = [0, 0.25, 0.45, 0.7, 1];
/** Colour steps: 0 = nothing tracked, 1..LEVELS = more and more. */
export const LEVELS = HEAT_OPACITY.length - 1;

const HOUR_MS = 3_600_000;
const MONDAY = new Date(2026, 0, 5); // any Monday, for weekday names

/** "09:00". */
export const hourLabel = (h) => `${pad2(h)}:00`;

/**
 * Splits [start, end) (ms) at local hour boundaries and calls
 * `fn(chunkStartDate, hour, seconds)` for each piece. DST-safe.
 */
export function eachHour(start, end, fn) {
  let cur = start;
  while (cur < end) {
    const d = new Date(cur);
    let next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
    if (next <= cur) next = cur + HOUR_MS;
    const stop = Math.min(end, next);
    fn(d, d.getHours(), (stop - cur) / 1000);
    cur = stop;
  }
}

/** Sessions plus the open one (running on any device), as { project_id, start_ts, end_ts }. */
export function withOpenSession(spans, projects, now = Date.now()) {
  const p = projects.find((x) => x.is_running && x.run_started_at);
  return p ? [...spans, { project_id: p.id, start_ts: p.run_started_at, end_ts: now }] : spans;
}

function dayLabel(d, today) {
  const diff = Math.round((today - d) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return fmtDate(d, { weekday: 'short', day: 'numeric' });
}

/**
 * The histogram's y axis: a round top in hours at or above `maxHours`, so the
 * axis reads 0 / top/2 / top.
 */
export function histogramTop(maxHours) {
  const steps = [0.5, 1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 500];
  const want = Math.max(maxHours, 0.5);
  return steps.find((s) => s >= want) ?? Math.ceil(want / 100) * 100;
}

/** Colour step of a cell: 0 when empty, else 1..LEVELS. */
export function level(seconds, scale) {
  if (!(seconds > 0) || !(scale > 0)) return 0;
  return Math.min(LEVELS, Math.max(1, Math.ceil((seconds / scale) * LEVELS)));
}

/**
 * The heatmap for a range key of HEATMAP_RANGES.
 * `spans`: [{ project_id, start_ts, end_ts }] (ms), already including the open session.
 * `keep(projectId)` limits which projects count (the Stats scope).
 *
 * Returns { cfg, rows: [{ key, label, cells: seconds[24] }], scale, total,
 * perHour: seconds[24] (every row added up, for the histogram),
 * peakHour (null if nothing tracked), sessions: [{ project_id, start, end }] (oldest first) }.
 */
export function hourHeatmap(spans, rangeKey, { now = Date.now(), keep = () => true } = {}) {
  const cfg = HEATMAP_RANGES[rangeKey] ?? HEATMAP_RANGES['7d'];
  const today = startOfToday();
  const first = addDays(today, -(cfg.days - 1));
  const from = first.getTime();
  const byDay = cfg.by === 'day';

  const index = new Map(); // dayKey -> row (per-day ranges)
  const rows = byDay
    ? Array.from({ length: cfg.days }, (_, i) => {
      const d = addDays(first, i);
      index.set(dayKey(d), i);
      return { key: dayKey(d), label: dayLabel(d, today), cells: new Array(24).fill(0) };
    })
    : Array.from({ length: 7 }, (_, i) => ({
      key: `wd${i}`,
      label: fmtDate(addDays(MONDAY, i), { weekday: 'short' }),
      cells: new Array(24).fill(0),
    }));

  const perHour = new Array(24).fill(0);
  const sessions = [];
  let total = 0;
  for (const s of spans) {
    if (!keep(s.project_id)) continue;
    const a = Math.max(s.start_ts, from);
    const b = Math.min(s.end_ts, now);
    if (!(b > a)) continue;
    sessions.push({ project_id: s.project_id, start: a, end: b });
    eachHour(a, b, (d, h, secs) => {
      const r = byDay ? index.get(dayKey(d)) : (d.getDay() + 6) % 7; // Monday first
      if (r == null) return;
      rows[r].cells[h] += secs;
      perHour[h] += secs;
      total += secs;
    });
  }
  sessions.sort((x, y) => x.start - y.start);

  const max = Math.max(0, ...rows.flatMap((r) => r.cells));
  const peak = perHour.reduce((best, v, h) => (v > perHour[best] ? h : best), 0);
  return {
    cfg,
    rows,
    scale: byDay ? 3600 : max, // per day: a full hour is darkest
    total,
    perHour,
    peakHour: total > 0 ? peak : null,
    sessions,
  };
}
