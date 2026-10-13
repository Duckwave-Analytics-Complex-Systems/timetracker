// Entry point of a project window (project.html).
//
// Loads one project's detail (project + phases + per-day hours) from the
// backend, folds in the running timer, computes metrics once, and hands them
// to whichever tab is visible. Reloads on every `data-changed` event, so
// edits made here, in the widget, or in another window all show up.
import { api, onDataChanged } from '../core/api.js';
import { escapeHtml, fmtDate, fmtHMS, fmtTime, money } from '../core/format.js';
import { bill, liveSeconds } from '../core/model.js';
import { appWindow, getAppVersion, saveDialog, writeTextFile } from '../core/tauri.js';
import { setupTitlebar } from '../core/titlebar.js';
import { useSharedTheme } from '../core/theme.js';
import { pill } from './blocks.js';
import { isDragging, renderGantt, scrollToToday, ZOOMS } from './gantt.js';
import { computeMetrics, HEALTH, isMilestone, withLiveTime } from './metrics.js';
import { renderOverview } from './overview.js';
import { openPhaseDialog } from './phase-dialog.js';
import { reportDocument, reportFileName, reportHtml } from './report.js';
import { REPORT_CSS } from './report-style.js';

const PROJECT_ID = appWindow.label.replace(/^project-/, '');
const ZOOM_KEY = 'timetrack:gantt-zoom';
const AUTHOR_KEY = 'timetrack:report-author';
const LIVE_REDRAW_MS = 30_000; // while running, refresh the heavier tabs this often
const WAKE_GAP_MS = 5000;

const $ = (id) => document.getElementById(id);

let detail = null; // { project, phases, daily } from the backend
let tab = 'overview';
let zoom = ZOOMS[localStorage.getItem(ZOOM_KEY)] ? localStorage.getItem(ZOOM_KEY) : 'week';
let appVersion = '';

// ---------------------------------------------------------------- loading

async function load() {
  try {
    detail = await api.projectDetail(PROJECT_ID);
  } catch (err) {
    console.error(err);
    appWindow.close(); // the project was deleted
    return;
  }
  render();
}

let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 120); // several events often arrive together
}

function snapshot() {
  const live = withLiveTime(detail);
  return { live, m: computeMetrics(live) };
}

function render() {
  if (!detail) return;
  const { live, m } = snapshot();
  renderHeader(live, m);
  if (tab === 'overview') renderOverview($('tabOverview'), { live, m });
  if (tab === 'schedule') renderSchedule(live, m);
  if (tab === 'report') renderReportPreview(live, m);
}

// ---------------------------------------------------------------- header + timer

function renderHeader(live, m) {
  const p = live.project;
  document.title = `${p.name} · TimeTrack`;
  $('windowTitle').textContent = p.name;
  $('projName').textContent = p.name;
  $('projLogo').innerHTML = p.logo_data
    ? `<img class="proj-logo" src="${p.logo_data}" alt="" />`
    : `<div class="proj-logo logo-placeholder">${escapeHtml((p.name[0] || '?').toUpperCase())}</div>`;

  const meta = [pill(HEALTH[m.health].tone, HEALTH[m.health].label)];
  if (p.hourly_rate > 0) meta.push(`<span class="earnings">${money(p.hourly_rate)}/h${p.people_count > 1 ? ` × ${p.people_count}` : ''}</span>`);
  meta.push(`<span>Created ${fmtDate(new Date(p.created_at))}</span>`);
  if (p.archived && p.archived_at) meta.push(`<span>Filed ${fmtDate(new Date(p.archived_at))}</span>`);
  $('projMeta').innerHTML = meta.join('<span class="sep">·</span>');

  const select = $('phaseSelect');
  if (document.activeElement !== select) {
    const options = [{ id: '', name: 'No phase (unassigned)' }, ...live.phases.filter((ph) => !isMilestone(ph))];
    select.innerHTML = options.map((o) => `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('');
    select.value = p.active_phase_id || '';
  }
  select.disabled = p.archived;
  $('timerBtn').disabled = p.archived;
  $('archivedBanner').classList.toggle('hidden', !p.archived);
  renderTimer();
}

function renderTimer() {
  const p = detail.project;
  const secs = liveSeconds(p);
  $('timerTime').textContent = fmtHMS(secs);
  $('projTimer').classList.toggle('running', p.is_running);
  $('timerBtn').textContent = p.is_running ? 'Pause' : 'Start';
  const parts = [p.is_running ? `Running since ${fmtTime(p.run_started_at)}` : 'Paused'];
  if (p.hourly_rate > 0) parts.push(money(bill(p, secs)));
  $('timerSub').textContent = parts.join(' · ');
}

$('timerBtn').addEventListener('click', () => {
  const p = detail.project;
  (p.is_running ? api.pause() : api.start(p.id)).catch((err) => alert(String(err)));
});
$('phaseSelect').addEventListener('change', (e) => {
  api.setActivePhase(PROJECT_ID, e.target.value || null).catch((err) => alert(String(err)));
});
$('restoreBtn').addEventListener('click', () => api.restoreProject(PROJECT_ID));

// ---------------------------------------------------------------- tabs

function setTab(name) {
  tab = name;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  for (const t of ['overview', 'schedule', 'report']) {
    $(`tab${t[0].toUpperCase()}${t.slice(1)}`).classList.toggle('hidden', t !== name);
  }
  render();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setTab(t.dataset.tab)));

// ---------------------------------------------------------------- schedule tab

const plan = { start: $('planStart'), due: $('planDue'), budget: $('planBudget'), desc: $('planDesc') };

function renderSchedule(live, m) {
  const p = live.project;
  // Don't overwrite a field the user is typing in.
  if (!$('planForm').contains(document.activeElement)) {
    plan.start.value = p.start_day || '';
    plan.due.value = p.due_day || '';
    plan.budget.value = p.budget_hours || '';
    plan.desc.value = p.description || '';
  }
  plan.budget.placeholder = m.estimatedH > 0 ? `Sum of phases: ${Math.round(m.estimatedH)}` : 'Sum of phases';
  $('zoomSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.zoom === zoom)));
  const readOnly = p.archived;
  $('addPhaseBtn').disabled = readOnly;
  $('addMilestoneBtn').disabled = readOnly;

  if (isDragging()) return; // never redraw under the user's pointer
  renderGantt($('ganttHost'), {
    project: p,
    metrics: m,
    zoom,
    onEdit: (row) => !readOnly && openPhaseDialog({ project: p, phases: live.phases, phase: row }),
    onMove: (row, startDay, endDay) => {
      if (readOnly) return render();
      api.savePhase({ ...phaseInput(row), start_day: startDay, end_day: endDay }).catch((err) => {
        alert(String(err));
        render();
      });
    },
  });
}

function phaseInput(row) {
  const { id, project_id, name, kind, color, start_day, end_day, estimated_hours, progress } = row;
  return { id, project_id, name, kind, color, start_day, end_day, estimated_hours, progress };
}

async function savePlan() {
  const status = $('planStatus');
  if (plan.start.value && plan.due.value && plan.due.value < plan.start.value) {
    status.textContent = 'The due date is before the start date.';
    status.className = 'panel-hint error';
    return;
  }
  try {
    await api.updatePlan(PROJECT_ID, {
      description: plan.desc.value,
      start_day: plan.start.value || null,
      due_day: plan.due.value || null,
      budget_hours: parseFloat(plan.budget.value) || null,
    });
    status.textContent = 'Saved ✓';
    status.className = 'panel-hint ok';
    setTimeout(() => { status.textContent = ''; }, 2000);
  } catch (err) {
    status.textContent = String(err);
    status.className = 'panel-hint error';
  }
}
$('planForm').addEventListener('change', savePlan);
$('planForm').addEventListener('submit', (e) => e.preventDefault());

$('zoomSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-zoom]');
  if (!b) return;
  zoom = b.dataset.zoom;
  try { localStorage.setItem(ZOOM_KEY, zoom); } catch { /* ignore */ }
  render();
});
$('todayBtn').addEventListener('click', () => scrollToToday($('ganttHost')));
$('addPhaseBtn').addEventListener('click', () => openPhaseDialog({ project: detail.project, phases: detail.phases, newKind: 'phase' }));
$('addMilestoneBtn').addEventListener('click', () => openPhaseDialog({ project: detail.project, phases: detail.phases, newKind: 'milestone' }));

// ---------------------------------------------------------------- report tab

const reportAuthor = $('reportAuthor');
try { reportAuthor.value = localStorage.getItem(AUTHOR_KEY) || ''; } catch { /* ignore */ }
let billingTouched = false;

function reportOptions() {
  return {
    author: reportAuthor.value.trim(),
    notes: $('reportNotes').value,
    includePhases: $('optPhases').checked,
    includeCharts: $('optCharts').checked,
    includeBilling: $('optBilling').checked,
    version: appVersion,
  };
}

function renderReportPreview(live, m) {
  if (!billingTouched) $('optBilling').checked = live.project.hourly_rate > 0;
  $('optBilling').disabled = !(live.project.hourly_rate > 0);
  $('reportPreview').innerHTML = `<style>${REPORT_CSS}</style>${reportHtml(live, m, reportOptions())}`;
}

let previewTimer = null;
$('tabReport').querySelector('.report-options').addEventListener('input', (e) => {
  if (e.target.id === 'optBilling') billingTouched = true;
  if (e.target === reportAuthor) {
    try { localStorage.setItem(AUTHOR_KEY, reportAuthor.value.trim()); } catch { /* ignore */ }
  }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(render, 250);
});

$('exportReportBtn').addEventListener('click', async () => {
  const { live, m } = snapshot();
  const p = live.project;
  try {
    const path = await saveDialog({
      defaultPath: reportFileName(p),
      filters: [{ name: 'HTML report', extensions: ['html'] }],
    });
    if (!path) return;
    await writeTextFile(path, reportDocument(reportHtml(live, m, reportOptions()), `${p.name} · Progress report`));
    $('reportStatus').textContent = `Saved to ${path}`;
  } catch (err) {
    $('reportStatus').textContent = `Export failed: ${err}`;
  }
});
$('printReportBtn').addEventListener('click', () => {
  render(); // print the latest numbers
  window.print(); // print CSS shows only the report (css/project.css)
});

// ---------------------------------------------------------------- live updates + boot

onDataChanged(scheduleReload);

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastTick > WAKE_GAP_MS) api.sync().finally(load);
  lastTick = now;
  if (!detail?.project.is_running) return;
  renderTimer();
  if (now % LIVE_REDRAW_MS < 1000 && tab !== 'report') render();
}, 1000);

setupTitlebar($('titlebar'));
useSharedTheme();
getAppVersion().then((v) => { appVersion = v; });
load();
