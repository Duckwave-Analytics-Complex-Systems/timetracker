// The progress report: a self-contained, light, printable HTML document.
//
// `reportHtml` builds the <article class="rpt"> used both for the preview in
// the Report tab and inside the exported file (`reportDocument`). All styles
// are in report-style.js and scoped under .rpt, so the exported file needs
// nothing else (no fonts, scripts or network).
import { burnupSvg, donutSvg, ganttSvg, weeklyBarsSvg } from '../core/charts.js';
import { addDays, dayKey, daysBetween, escapeHtml, fmtDate, fmtHours, money, pct } from '../core/format.js';
import { bill } from '../core/model.js';
import { burnupLegendHtml, healthPill, kpiTilesHtml, notesHtml, phaseTableHtml, progressBarsHtml } from './blocks.js';
import { burnupSeries, isMilestone, phaseStatusLabel, summarySentence, weeklySeries } from './metrics.js';
import { REPORT_CSS } from './report-style.js';

const UPCOMING_DAYS = 30;

function section(title, body, cls = '') {
  return `<section class="rpt-section ${cls}"><h2>${title}</h2>${body}</section>`;
}

function stat(label, value, sub = '') {
  return `<div class="rpt-stat"><div class="rpt-stat-label">${label}</div><div class="rpt-stat-value">${value}</div>${sub ? `<div class="rpt-stat-sub">${sub}</div>` : ''}</div>`;
}

function scheduleRange(m) {
  const dates = [m.start, m.due, m.today, ...m.phaseRows.flatMap((r) => [r.start, r.end])].filter(Boolean);
  const start = addDays(new Date(Math.min(...dates)), -2);
  const end = addDays(new Date(Math.max(...dates)), 2);
  return { start, end };
}

function forecastHtml(m) {
  const variance = m.eacH != null && m.budgetH ? m.eacH - m.budgetH : null;
  const finishVsDue = m.forecastFinish && m.due ? daysBetween(m.due, m.forecastFinish) : null;
  return `<div class="rpt-stats">
    ${stat('Recent pace', m.weeklyPace > 0 ? `${fmtHours(m.weeklyPace)}/week` : '—', 'average of the last 4 weeks')}
    ${stat('Planned progress today', pct(m.planned), 'if every phase moved linearly')}
    ${stat('Hours efficiency', m.efficiency != null ? `${m.efficiency.toFixed(2)}×` : '—', 'earned ÷ spent hours (1.00 = on budget)')}
    ${stat('Projected total hours', fmtHours(m.eacH), m.eacH != null ? 'spent ÷ completion' : 'needs ≥ 5% progress')}
    ${stat('Projected vs budget', variance == null ? '—' : fmtHours(variance, { sign: true }), variance == null ? '' : variance > 0 ? 'over budget' : 'under budget')}
    ${stat('Projected finish', m.forecastFinish ? fmtDate(m.forecastFinish) : '—',
      finishVsDue == null ? '' : finishVsDue > 0 ? `${finishVsDue} days after the due date` : `${-finishVsDue} days before the due date`)}
  </div>`;
}

function billingHtml(project, m, totalSeconds) {
  const per = (hours) => (hours == null ? null : bill(project, hours * 3600));
  const people = Math.max(1, project.people_count || 1);
  return `<div class="rpt-stats">
    ${stat('Rate', `${money(project.hourly_rate)}/h`, people > 1 ? `× ${people} people` : '1 person')}
    ${stat('Billed to date', money(bill(project, totalSeconds)), fmtHours(m.spentH))}
    ${stat('Budget value', money(per(m.budgetH)), m.budgetH ? fmtHours(m.budgetH) : 'no budget set')}
    ${stat('Remaining budget value', m.remainingH == null ? '—' : money(per(m.remainingH)), m.remainingH < 0 ? 'over budget' : '')}
    ${stat('Projected total', money(per(m.eacH)), m.eacH != null ? 'at current efficiency' : '')}
  </div>`;
}

function upcomingHtml(m) {
  const horizon = addDays(m.today, UPCOMING_DAYS);
  const items = m.phaseRows
    .filter((r) => r.status !== 'done')
    .map((r) => ({ r, date: isMilestone(r) || r.start <= m.today ? r.end : r.start, what: isMilestone(r) ? 'Milestone' : r.start <= m.today ? 'Ends' : 'Starts' }))
    .filter((x) => x.date <= horizon)
    .sort((a, b) => a.date - b.date)
    .slice(0, 8);
  if (!items.length) return `<p class="rpt-muted">Nothing scheduled in the next ${UPCOMING_DAYS} days.</p>`;
  return `<ul class="rpt-upcoming">${items.map(({ r, date, what }) => {
    const st = phaseStatusLabel(r);
    const days = daysBetween(m.today, date);
    const when = days === 0 ? 'today' : days > 0 ? `in ${days} d` : `${-days} d ago`;
    return `<li><span class="rpt-up-date">${fmtDate(date, { month: 'short', day: 'numeric' })}<small>${when}</small></span>
      <span class="dot${isMilestone(r) ? ' ms' : ''}" style="background:var(--cat-${r.color + 1})"></span>
      <span class="rpt-up-name">${what}: <b>${escapeHtml(r.name)}</b></span>
      <span class="pill tone-${st.tone}">${st.text}</span></li>`;
  }).join('')}</ul>`;
}

/**
 * opts: { author, notes, includeBilling, includePhases, includeCharts, version }
 */
export function reportHtml(live, m, opts) {
  const { project } = live;
  const generated = new Date();
  const period = m.start || m.due
    ? `${m.start ? fmtDate(m.start) : '—'} → ${m.due ? fmtDate(m.due) : '—'}`
    : 'Not scheduled';
  const logo = project.logo_data ? `<img class="rpt-logo" src="${project.logo_data}" alt="">` : `<div class="rpt-logo rpt-logo-ph">${escapeHtml((project.name[0] || '?').toUpperCase())}</div>`;
  const { start, end } = scheduleRange(m);

  const parts = [];
  parts.push(`
    <header class="rpt-head">
      <div class="rpt-title">
        ${logo}
        <div>
          <div class="rpt-kicker">Project progress report</div>
          <h1>${escapeHtml(project.name)}</h1>
          ${project.description ? `<p class="rpt-desc">${escapeHtml(project.description)}</p>` : ''}
        </div>
      </div>
      <dl class="rpt-meta">
        <div><dt>Report date</dt><dd>${fmtDate(generated)}</dd></div>
        ${opts.author ? `<div><dt>Prepared by</dt><dd>${escapeHtml(opts.author)}</dd></div>` : ''}
        <div><dt>Schedule</dt><dd>${period}</dd></div>
        <div><dt>Status</dt><dd>${healthPill(m)}</dd></div>
      </dl>
    </header>`);

  parts.push(section('Summary', `
    <div class="rpt-summary">
      ${donutSvg(m.completion, 'complete', 116)}
      <div>
        <p class="rpt-lead">${escapeHtml(summarySentence(project.name, m))}</p>
        ${notesHtml(m.notes)}
      </div>
    </div>`));

  parts.push(section('Key figures', kpiTilesHtml(m, opts.includeBilling ? project : { ...project, hourly_rate: 0 }, live.totalSeconds)));
  parts.push(section('Progress', progressBarsHtml(m)));

  if (m.phaseRows.length) {
    parts.push(section('Schedule', `
      ${ganttSvg(m.phaseRows, { start, end, today: m.today, due: m.due })}
      <div class="ch-legend"><span><i class="lg-progress"></i>Progress</span><span><i class="lg-remaining"></i>Remaining</span><span><i class="lg-today"></i>Today</span><span><i class="lg-due"></i>Due date</span></div>`, 'rpt-wide'));
  }
  if (opts.includePhases) parts.push(section('Hours by phase', phaseTableHtml(m)));
  if (opts.includeCharts) {
    parts.push(`<div class="rpt-two">
      ${section('Hours per week', weeklyBarsSvg(weeklySeries(live.daily, m), { W: 420, H: 200 }))}
      ${section('Cumulative hours', burnupLegendHtml + burnupSvg(burnupSeries(live.daily, m, live.phases), { W: 420, H: 200 }))}
    </div>`);
  }
  parts.push(section('Forecast', forecastHtml(m)));
  if (opts.includeBilling && project.hourly_rate > 0) parts.push(section('Billing', billingHtml(project, m, live.totalSeconds)));
  if (m.phaseRows.length) parts.push(section(`Next ${UPCOMING_DAYS} days`, upcomingHtml(m)));
  if (opts.notes?.trim()) {
    const paragraphs = opts.notes.trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
    parts.push(section('Notes', `<div class="rpt-notes">${paragraphs}</div>`));
  }

  parts.push(`<footer class="rpt-foot">
    <span>Generated with TimeTrack${opts.version ? ` ${escapeHtml(opts.version)}` : ''} · ${fmtDate(generated)} ${generated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
    <span>Hours are tracked time; progress % is reported per phase.</span>
  </footer>`);

  return `<article class="rpt">${parts.join('')}</article>`;
}

/** The complete standalone file. */
export function reportDocument(articleHtml, title) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body class="rpt-page">
${articleHtml}
</body>
</html>
`;
}

/** "acme-redesign-progress-2026-10-12.html" */
export function reportFileName(project) {
  const slug = project.name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').slice(0, 50) || 'project';
  return `${slug}-progress-${dayKey(new Date())}.html`;
}
