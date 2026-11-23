// An organization's dashboard, at the top of the Stats tab while its workspace
// is shown: who's tracking now, hours and bill over a period by person
// (against their weekly goals) and by project, and the period's report as
// CSV. Built from the sessions on this computer, which for the owner and
// admins means every project in the organization, and for a member the
// projects they're in. The Android app has the same (src/app/org-stats.js);
// the sums are core/org-metrics.js.
import { api } from '../core/api.js';
import { escapeHtml, fmtDate, fmtHM, fmtHours, moneyIn } from '../core/format.js';
import { orgReportCsv, orgSummary, periodRange } from '../core/org-metrics.js';
import { PERSONAL, isOrgAdmin } from '../core/orgs.js';
import { saveDialog, writeTextFile } from '../core/tauri.js';
import { state } from './store.js';

const $ = (id) => document.getElementById(id);
const host = $('orgStats');
const PERIOD_KEY = 'timetrack:org-period';
const PERIODS = { week: 'This week', month: 'This month', lastMonth: 'Last month' };
const ROLE = { owner: 'Owner', admin: 'Admin', member: 'Member', former: 'Former member' };
const PRESENCE_EVERY_MS = 60_000;

let period = PERIODS[localStorage.getItem(PERIOD_KEY)] ? localStorage.getItem(PERIOD_KEY) : 'week';
let presence = { orgId: null, rows: null, offline: false, at: 0 };
let lastSummary = null;
let drawing = 0;

async function loadPresence(orgId) {
  try {
    presence = { orgId, rows: await api.orgPresence(orgId), offline: false, at: Date.now() };
  } catch {
    presence = { orgId, rows: [], offline: true, at: Date.now() };
  }
}

const bar = (fraction, cls = '') =>
  `<div class="os-track"><i class="${cls}" style="width:${Math.round(Math.max(0, Math.min(1, fraction || 0)) * 100)}%"></i></div>`;

/** Draws the dashboard for the organization shown, or hides it in Personal. */
export async function renderOrgStats() {
  const org = state.orgs.find((o) => o.id === state.workspace);
  host.classList.toggle('hidden', !org || state.workspace === PERSONAL);
  if (!org) return;
  const request = ++drawing;
  if (presence.orgId !== org.id || Date.now() - presence.at > PRESENCE_EVERY_MS) await loadPresence(org.id);

  const now = Date.now();
  const range = periodRange(period, now);
  const [entries, people] = await Promise.all([api.orgEntries(org.id, range.from), api.orgMembers(org.id)]);
  if (request !== drawing) return; // a newer draw is on its way
  const me = people.find((m) => m.is_me)?.user_id ?? null;
  const rows = presence.rows ?? [];
  const running = rows.filter((r) => r.running);
  const goals = Object.fromEntries(rows.filter((r) => r.weekly_goal_hours > 0).map((r) => [r.user_id, r.weekly_goal_hours]));
  const projects = [...state.projects, ...state.archived].filter((p) => p.org_id === org.id);
  const s = orgSummary({ entries, projects, people, running, goals, me, from: range.from, to: range.to, now, weeks: range.weeks });
  lastSummary = { s, org, range };

  const money = (n) => moneyIn(n, org.currency);
  const date = (ms) => fmtDate(new Date(ms), { month: 'short', day: 'numeric' });
  const name = (m) => escapeHtml(m.display_name || 'Former member') + (m.is_me || m.user_id === me ? ' <span class="muted">(you)</span>' : '');
  const maxProject = Math.max(1, ...s.byProject.map((p) => p.seconds));

  const working = presence.offline
    ? '<p class="os-empty">Connect to Cloud sync to see who is working now.</p>'
    : running.length
      ? running.map((r) => `
        <div class="os-row"><span class="status-dot live"></span>
          <span class="os-name">${name(r)}<small>${escapeHtml(r.project_name || "One of the organization's projects")}</small></span>
          <span class="os-fig">${fmtHM(Math.max(0, Math.floor((now - r.started_at) / 1000)))}</span></div>`).join('')
      : '<p class="os-empty">No one is tracking one of its projects right now.</p>';

  const persons = s.byPerson.map((m) => `
    <div class="os-person">
      <div class="os-row"><span class="os-name">${name(m)}<small>${ROLE[m.role] ?? ''}</small></span>
        <span class="os-fig">${m.goalHours ? `${fmtHours(m.seconds / 3600)} of ${fmtHours(m.goalHours)}` : fmtHM(m.seconds)}${m.billed > 0 ? `<small class="earnings">${money(m.billed)}</small>` : ''}</span></div>
      ${m.goalHours ? `<div class="os-row">${bar(m.utilization, m.utilization >= 1 ? 'full' : '')}<span class="os-pct">${Math.round(m.utilization * 100)}%</span></div>` : ''}
    </div>`).join('');

  const byProject = s.byProject.length
    ? s.byProject.map((p) => `
      <div class="os-person">
        <div class="os-row"><span class="os-name">${escapeHtml(p.name)}</span>
          <span class="os-fig">${fmtHM(p.seconds)}${p.billed > 0 ? `<small class="earnings">${money(p.billed)}</small>` : ''}</span></div>
        ${bar(p.seconds / maxProject)}
      </div>`).join('')
    : '<p class="os-empty">Nothing tracked in this period.</p>';

  host.innerHTML = `
    <div class="os-head">
      <h2>${escapeHtml(org.name)}</h2>
      <div class="seg" role="group" aria-label="Period">
        ${Object.entries(PERIODS).map(([k, label]) => `<button data-period="${k}" aria-pressed="${k === period}">${label}</button>`).join('')}
      </div>
    </div>
    <p class="os-sub">${date(range.from)} – ${date(Math.max(range.from, range.to - 1))}${isOrgAdmin(org) ? '' : ' · projects you\'re in'}</p>
    <div class="tiles os-tiles">
      <div class="tile"><div class="tile-label">Hours</div><div class="tile-value">${fmtHM(s.seconds)}</div></div>
      <div class="tile"><div class="tile-label">Billed</div><div class="tile-value earnings">${money(s.billed)}</div></div>
    </div>
    <div class="panel"><div class="panel-head"><h2>Working now</h2><span class="panel-hint">Updates every minute</span></div>${working}</div>
    <div class="panel"><div class="panel-head"><h2>By person</h2>${isOrgAdmin(org) ? '<span class="panel-hint">Against weekly goals</span>' : ''}</div>${persons}</div>
    <div class="panel"><div class="panel-head"><h2>By project</h2></div>${byProject}</div>
    <button type="button" class="btn-ghost os-export" id="orgExport">Export report (CSV)</button>
    <div class="os-divider"><span>Your stats</span></div>`;
}

host.addEventListener('click', async (e) => {
  const pick = e.target.closest('button[data-period]')?.dataset.period;
  if (pick) {
    period = pick;
    localStorage.setItem(PERIOD_KEY, period);
    renderOrgStats();
    return;
  }
  if (e.target.closest('#orgExport') && lastSummary) {
    const { s, org, range } = lastSummary;
    const date = (ms) => fmtDate(new Date(ms), { month: 'short', day: 'numeric', year: 'numeric' });
    const csv = orgReportCsv(s, {
      orgName: org.name, fromLabel: date(range.from), toLabel: date(Math.max(range.from, range.to - 1)), currency: org.currency,
    });
    const stamp = new Date(range.from).toISOString().slice(0, 10);
    try {
      const path = await saveDialog({
        defaultPath: `${org.name.replace(/[^\w-]+/g, '_')}_${period}_${stamp}.csv`,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (path) await writeTextFile(path, csv);
    } catch (err) {
      alert(String(err));
    }
  }
});
