// HTML building blocks shared by the Overview tab and the report, so both
// always show the same numbers the same way. They return markup strings and
// are styled by css/project.css (app, dark) and report-style.js (report, light).
import { escapeHtml, fmtDate, fmtDay, fmtHours, money, pct } from '../core/format.js';
import { bill } from '../core/model.js';
import { HEALTH, isMilestone, phaseStatusLabel } from './metrics.js';

export const pill = (tone, text) => `<span class="pill tone-${tone}">${escapeHtml(text)}</span>`;

export function healthPill(m) {
  const h = HEALTH[m.health];
  return pill(h.tone, h.label);
}

export function notesHtml(notes) {
  if (!notes.length) return '';
  return `<ul class="notes">${notes.map((n) => `<li class="tone-${n.tone}">${escapeHtml(n.text)}</li>`).join('')}</ul>`;
}

function dueText(m) {
  if (m.daysLeft == null) return 'no due date';
  if (m.daysLeft === 0) return 'due today';
  return m.daysLeft > 0 ? `in ${m.daysLeft} day${m.daysLeft === 1 ? '' : 's'}` : `${-m.daysLeft} day${m.daysLeft === -1 ? '' : 's'} overdue`;
}

function tile(label, value, sub, tone = '') {
  return `<div class="kpi${tone ? ` tone-${tone}` : ''}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
}

/** Headline numbers. */
export function kpiTilesHtml(m, project, totalSeconds) {
  const budgetSource = project.budget_hours > 0 ? 'project budget' : m.budgetH ? 'sum of phase estimates' : 'not set';
  const over = m.remainingH != null && m.remainingH < 0;
  const tiles = [
    tile('Hours spent', fmtHours(m.spentH), m.weeklyPace > 0 ? `${fmtHours(m.weeklyPace)}/week recently` : 'no recent activity'),
    tile('Budget', fmtHours(m.budgetH), budgetSource),
    tile(over ? 'Over budget by' : 'Hours remaining', m.remainingH == null ? '—' : fmtHours(Math.abs(m.remainingH)),
      m.budgetUsed == null ? 'set a budget to track' : `${pct(m.budgetUsed)} of budget used`, over ? 'bad' : ''),
    tile('Due date', m.due ? fmtDate(m.due, { month: 'short', day: 'numeric', year: 'numeric' }) : '—', dueText(m),
      m.daysLeft != null && m.daysLeft < 0 && m.health !== 'done' ? 'bad' : ''),
    tile('Forecast finish', m.forecastFinish ? fmtDate(m.forecastFinish, { month: 'short', day: 'numeric', year: 'numeric' }) : '—',
      m.forecastFinish ? 'at the recent pace' : m.health === 'done' ? 'completed' : 'needs recent activity',
      m.forecastFinish && m.due && m.forecastFinish > m.due ? 'warn' : ''),
  ];
  if (project.hourly_rate > 0) {
    const people = project.people_count > 1 ? ` × ${project.people_count} people` : '';
    tiles.push(tile('Billed to date', money(bill(project, totalSeconds)), `${money(project.hourly_rate)}/h${people}`, 'money'));
  }
  return `<div class="kpis">${tiles.join('')}</div>`;
}

function bar(label, fraction, { tone = 'accent', marker = null, markerLabel = '', detail = '' } = {}) {
  const w = fraction == null ? 0 : Math.min(100, Math.max(0, fraction * 100));
  const mk = marker == null ? '' : `<span class="pbar-marker" style="left:${Math.min(100, marker * 100).toFixed(1)}%" title="${escapeHtml(markerLabel)}"></span>`;
  return `
    <div class="pbar">
      <div class="pbar-top"><span>${label}</span><b>${pct(fraction)}</b></div>
      <div class="pbar-track"><div class="pbar-fill tone-${tone}" style="width:${w.toFixed(1)}%"></div>${mk}</div>
      ${detail ? `<div class="pbar-detail">${detail}</div>` : ''}
    </div>`;
}

/** Work done vs time elapsed vs budget spent: the three numbers that tell the story. */
export function progressBarsHtml(m) {
  const workDetail = m.completion == null
    ? 'Add phases with a progress % in the Schedule tab.'
    : `Plan for today: ${pct(m.planned)} <span class="pbar-key"></span>`;
  const timeDetail = m.timelineElapsed == null
    ? 'Set start and due dates.'
    : `${fmtDate(m.start, { month: 'short', day: 'numeric' })} → ${fmtDate(m.due)}`;
  const budgetDetail = m.budgetH == null ? 'Set a budget or phase estimates.' : `${fmtHours(m.spentH)} of ${fmtHours(m.budgetH)}`;
  return `
    <div class="pbars">
      ${bar('Work completed', m.completion, { tone: 'accent', marker: m.completion == null ? null : m.planned, markerLabel: 'Planned by today', detail: workDetail })}
      ${bar('Timeline elapsed', m.timelineElapsed, { tone: 'info', detail: timeDetail })}
      ${bar('Budget used', m.budgetUsed, { tone: m.budgetUsed > 1 ? 'bad' : m.budgetUsed > (m.completion ?? 1) + 0.1 ? 'warn' : 'money', detail: budgetDetail })}
    </div>`;
}

/** Per-phase hours: tracked vs estimate, progress and status. */
export function phaseTableHtml(m) {
  if (!m.phaseRows.length && m.unassignedH < 0.01) {
    return '<div class="empty-note">No phases yet. Build the schedule in the Schedule tab to split hours by phase.</div>';
  }
  const rows = m.phaseRows.map((r) => {
    const st = phaseStatusLabel(r);
    const ms = isMilestone(r);
    const dates = ms ? fmtDay(r.start_day, true) : `${fmtDay(r.start_day)} → ${fmtDay(r.end_day, true)}`;
    return `
      <tr>
        <td><span class="dot${ms ? ' ms' : ''}" style="background:var(--cat-${r.color + 1})"></span>${escapeHtml(r.name)}</td>
        <td class="nowrap">${dates}</td>
        <td>${pill(st.tone, st.text)}</td>
        <td class="num"><span class="mini"><span style="width:${r.progress}%;background:var(--cat-${r.color + 1})"></span></span>${r.progress}%</td>
        <td class="num">${ms ? '—' : fmtHours(r.spentH)}</td>
        <td class="num">${ms || !r.estimated_hours ? '—' : fmtHours(r.estimated_hours)}</td>
        <td class="num${r.overBudget ? ' over' : ''}">${r.remainingH == null ? '—' : fmtHours(r.remainingH)}</td>
      </tr>`;
  });
  if (m.unassignedH >= 0.01) {
    rows.push(`
      <tr class="muted-row">
        <td><span class="dot" style="background:var(--cat-other)"></span>Unassigned</td>
        <td></td><td></td><td></td>
        <td class="num">${fmtHours(m.unassignedH)}</td><td class="num">—</td><td class="num">—</td>
      </tr>`);
  }
  const totalRemaining = m.estimatedH > 0 ? m.estimatedH - m.spentH : null;
  return `
    <div class="table-wrap">
      <table class="ptable">
        <thead><tr><th>Phase</th><th>Dates</th><th>Status</th><th class="num">Progress</th><th class="num">Tracked</th><th class="num">Estimate</th><th class="num">Remaining</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
        <tfoot><tr>
          <td>Total</td><td></td><td></td>
          <td class="num">${pct(m.completion)}</td>
          <td class="num">${fmtHours(m.spentH)}</td>
          <td class="num">${m.estimatedH > 0 ? fmtHours(m.estimatedH) : '—'}</td>
          <td class="num${totalRemaining < 0 ? ' over' : ''}">${totalRemaining == null ? '—' : fmtHours(totalRemaining)}</td>
        </tr></tfoot>
      </table>
    </div>`;
}

/** Legend for the cumulative-hours chart. */
export const burnupLegendHtml = `
  <div class="ch-legend">
    <span><i class="lg-actual"></i>Tracked</span>
    <span><i class="lg-plan"></i>Plan</span>
    <span><i class="lg-budget"></i>Budget</span>
    <span><i class="lg-today"></i>Today</span>
  </div>`;
