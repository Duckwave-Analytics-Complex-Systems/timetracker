// Live time and billing, computed from what the backend returns.
//
// The backend owns the truth: a running project has `run_started_at`, and
// the open session is only written to the DB when it closes. Everything
// "live" on screen is derived here from that one timestamp.
import { dayKey } from './format.js';

/** Seconds of the open session (0 if not running). */
export function openSessionSeconds(p, now = Date.now()) {
  if (!p.is_running || !p.run_started_at) return 0;
  return Math.max(0, Math.floor((now - p.run_started_at) / 1000));
}

/** Total tracked seconds including the open session. */
export function liveSeconds(p, now = Date.now()) {
  return p.total_seconds + openSessionSeconds(p, now);
}

/** Bill = hours x hourly_rate x people_count. Mirrors `Project::bill` in db/projects.rs. */
export function bill(p, seconds) {
  return (seconds / 3600) * (p.hourly_rate || 0) * Math.max(1, p.people_count || 1);
}

/**
 * The open session split at local midnight, as [day, projectId, seconds]
 * tuples, to add on top of the per-day rows from the DB. Must bucket days
 * exactly like `split_by_local_day` in db/days.rs.
 */
export function liveAdditions(projects, now = Date.now()) {
  const p = projects.find((x) => x.is_running && x.run_started_at);
  if (!p) return [];
  const out = [];
  let cur = Math.floor(p.run_started_at / 1000);
  const end = cur + openSessionSeconds(p, now);
  while (cur < end) {
    const d = new Date(cur * 1000);
    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() / 1000;
    const chunkEnd = Math.min(end, nextMidnight);
    out.push([dayKey(d), p.id, chunkEnd - cur]);
    cur = chunkEnd;
  }
  return out;
}
