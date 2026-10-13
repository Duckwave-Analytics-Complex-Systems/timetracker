// Widget state. Everything here is a copy of backend data; `refresh()`
// replaces it in one step, so a redraw never mixes fresh projects with stale
// per-day rows (which would briefly double- or under-count today).
import { api } from '../core/api.js';
import { addDays, dayKey } from '../core/format.js';

export const DAILY_FETCH_DAYS = 90; // covers the longest Stats range (12 weeks)

export const state = {
  projects: [], // active projects
  archived: [], // filed projects
  dailyRows: [], // [{ day, project_id, seconds }] for the last DAILY_FETCH_DAYS days
};

const listeners = new Set();
let latestRequest = 0;

/** `fn()` runs after every refresh. */
export function onRefresh(fn) {
  listeners.add(fn);
}

export async function refresh() {
  const request = ++latestRequest;
  const today = new Date();
  const [projects, archived, dailyRows] = await Promise.all([
    api.projects(),
    api.archivedProjects(),
    api.daily(dayKey(addDays(today, -(DAILY_FETCH_DAYS - 1))), dayKey(today)),
  ]);
  if (request !== latestRequest) return; // a newer refresh already landed
  Object.assign(state, { projects, archived, dailyRows });
  listeners.forEach((fn) => fn());
}

/** Runs a backend action, then refreshes. Errors are logged, not thrown. */
export async function act(action) {
  try {
    await action();
  } catch (err) {
    console.error(err);
    alert(String(err));
  }
  await refresh().catch((err) => console.error('refresh failed', err));
}
