// How good your estimates are: finished (filed) projects with a budget,
// actual hours / budgeted hours. Pure functions, shared with the desktop.
//
// A ratio of 1.18 means the work took 18% more than budgeted; 0.9 means 10% less.

export const MIN_PROJECTS = 3; // finished budgeted projects before anything is shown
export const MIN_PHASE_SAMPLES = 2; // phases with the same name before a phase line is shown
export const TREND_SIZE = 6; // the most recent projects in the trend
export const ON_TARGET = 0.05; // within ±5% reads as "on target"

export function median(xs) {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Distance from a perfect estimate; 2× over and 2× under are equally far. */
const miss = (ratio) => Math.abs(Math.log(ratio));

/**
 * The samples: filed projects with a budget and tracked time, oldest first.
 * `projects`: [{ id, name, archived, archived_at, budget_hours, total_seconds }].
 */
export function projectSamples(projects) {
  return projects
    .filter((p) => p.archived && p.budget_hours > 0 && p.total_seconds > 0)
    .map((p) => {
      const actual = p.total_seconds / 3600;
      return { id: p.id, name: p.name, budget: p.budget_hours, actual, ratio: actual / p.budget_hours, endedAt: p.archived_at ?? 0 };
    })
    .sort((a, b) => a.endedAt - b.endedAt);
}

/**
 * Phases of the sample projects grouped by name (case and spaces ignored).
 * Milestones, phases without an estimate and phases no time was booked to
 * are left out. `phases`: [{ project_id, name, kind, estimated_hours, spent_seconds }].
 * Returns [{ name, ratio (median), samples }] with at least MIN_PHASE_SAMPLES,
 * the furthest from target first.
 */
export function phaseAccuracy(phases, projectIds) {
  const groups = new Map();
  for (const ph of phases) {
    if (!projectIds.has(ph.project_id) || ph.kind === 'milestone') continue;
    if (!(ph.estimated_hours > 0) || !(ph.spent_seconds > 0)) continue;
    const key = String(ph.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key) continue;
    const g = groups.get(key) ?? { name: String(ph.name).trim(), ratios: [] };
    g.ratios.push(ph.spent_seconds / 3600 / ph.estimated_hours);
    groups.set(key, g);
  }
  return [...groups.values()]
    .filter((g) => g.ratios.length >= MIN_PHASE_SAMPLES)
    .map((g) => ({ name: g.name, ratio: median(g.ratios), samples: g.ratios.length }))
    .sort((a, b) => miss(b.ratio) - miss(a.ratio));
}

/**
 * Everything the Estimates view shows. `needed` > 0 means not enough
 * finished projects yet (and the rest is empty).
 */
export function estimationSummary(projects, phases = []) {
  const samples = projectSamples(projects);
  const needed = Math.max(0, MIN_PROJECTS - samples.length);
  if (needed > 0) return { count: samples.length, needed, ratio: null, trend: [], best: null, worst: null, phases: [] };
  const byMiss = [...samples].sort((a, b) => miss(a.ratio) - miss(b.ratio));
  const ratio = median(samples.map((s) => s.ratio));
  return {
    count: samples.length,
    needed: 0,
    ratio,
    onTarget: samples.filter((s) => Math.abs(s.ratio - 1) <= ON_TARGET).length,
    trend: samples.slice(-TREND_SIZE),
    best: byMiss[0],
    worst: byMiss[byMiss.length - 1],
    phases: phaseAccuracy(phases, new Set(samples.map((s) => s.id))),
  };
}

/** What a budget of `hours` usually turns into, from the median ratio (null without one). */
export function likelyHours(hours, ratio) {
  if (!(hours > 0) || !(ratio > 0)) return null;
  return hours * ratio;
}

/** 'over' | 'under' | 'onTarget' for a ratio. */
export function direction(ratio) {
  if (Math.abs(ratio - 1) <= ON_TARGET) return 'onTarget';
  return ratio > 1 ? 'over' : 'under';
}
