// "Today's plan": which active projects to work on today, and why. Pure
// functions, shared with the desktop. A project earns points for a near or
// passed due date, budget hours still to do before it, pending items, and
// having been worked on lately; the top few make the plan.
import { addDays, dayKey, daysBetween, parseDay } from '../core/format.js';
import { isWorkingDay } from '../core/profile-stats.js';

export const PLAN_SIZE = 3;

/** Working days from `from` to `to`, both included (0 if `to` is before `from`). */
export function workingDaysBetween(from, to, workDays) {
  const mask = workDays & 127 ? workDays : 127;
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkingDay(mask, d)) n += 1;
  return n;
}

/**
 * projects: [{ id, name, due_day, budget_hours, estimated_hours, last_end_day,
 *   total_seconds, last_worked_day }] (active ones). The due date and budget
 * fall back to the phases' (last end, summed estimates), like metrics.js.
 * opts: { today: Date, pending: Map(id -> open items), workDays, dayHours }.
 *
 * Returns up to PLAN_SIZE of { id, name, score, hours (suggested today, or
 * null), reasons: [{ code, ...values }] } , most urgent first. Codes:
 * 'overdue' { days }, 'dueToday', 'dueSoon' { days }, 'perDay' { hours },
 * 'pending' { count }, 'recent'.
 */
export function planToday(projects, { today = new Date(), pending = new Map(), workDays = 31, dayHours = 8 } = {}) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const yesterday = dayKey(addDays(start, -1));
  const out = [];
  for (const p of projects) {
    const reasons = [];
    let score = 0;
    let hours = null;

    const due = parseDay(p.due_day || p.last_end_day);
    const budget = p.budget_hours > 0 ? p.budget_hours : p.estimated_hours > 0 ? p.estimated_hours : null;
    const left = budget != null ? budget - (p.total_seconds || 0) / 3600 : null;
    if (due) {
      const days = daysBetween(start, due);
      if (days < 0) {
        score += 100;
        reasons.push({ code: 'overdue', days: -days });
      } else if (days === 0) {
        score += 80;
        reasons.push({ code: 'dueToday' });
      } else if (days <= 14) {
        score += days <= 3 ? 60 : days <= 7 ? 35 : 15;
        reasons.push({ code: 'dueSoon', days });
      }
      if (left > 0 && days >= 0) {
        const perDay = left / Math.max(1, workingDaysBetween(start, due, workDays));
        score += Math.min(40, perDay * 5);
        hours = Math.min(perDay, dayHours > 0 ? dayHours : 8);
        if (days <= 14) reasons.push({ code: 'perDay', hours: perDay });
      }
    }
    const count = pending.get(p.id) || 0;
    if (count > 0) {
      score += Math.min(25, 10 + 3 * count);
      reasons.push({ code: 'pending', count });
    }
    if (p.last_worked_day && p.last_worked_day >= yesterday) {
      score += 8;
      reasons.push({ code: 'recent' });
    }
    if (score > 0) out.push({ id: p.id, name: p.name, score, hours, reasons });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, PLAN_SIZE);
}
