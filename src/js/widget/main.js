// Entry point of the main widget window (index.html).
//
// Data flow: the backend owns all data. `refresh()` (store.js) reloads it and
// redraws. It runs after our own actions and whenever the backend emits
// `data-changed` (e.g. a project window started a timer). The 1 s tick only
// redraws; nothing is saved from here.
import { api, onDataChanged } from '../core/api.js';
import { escapeHtml, fmtHM, fmtTime } from '../core/format.js';
import { setupTitlebar } from '../core/titlebar.js';
import { useSharedTheme } from '../core/theme.js';
import { renderArchive } from './archive.js';
import { ensureColorSlots } from './colors.js';
import { renderProjects } from './projects.js';
import { initSettings } from './settings.js';
import { chartHover, renderStats, renderToday, resetChartHover, resetSelection } from './stats.js';
import { onRefresh, refresh, state } from './store.js';

const TICK_MS = 1000;
const WAKE_GAP_MS = 5000; // our own tick was late by this much: we were probably asleep

const $ = (id) => document.getElementById(id);
let currentView = 'projects';

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderProjects();
  renderToday();
  if (currentView === 'stats' && !chartHover) renderStats();
  if (currentView === 'archive') renderArchive();
}

onRefresh(() => {
  ensureColorSlots(state.projects);
  renderAll();
});

// ---------------------------------------------------------------- tabs

function setView(name) {
  currentView = name;
  resetChartHover(); // pointerleave doesn't fire when the chart is hidden under the pointer
  for (const view of ['projects', 'stats', 'archive']) {
    $(`view${view[0].toUpperCase()}${view.slice(1)}`).classList.toggle('hidden', name !== view);
  }
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === name)));
  if (name === 'stats') {
    resetSelection(); // open on today
    renderStats();
  }
  if (name === 'archive') renderArchive();
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
$('todayStrip').addEventListener('click', () => setView('stats'));
$('todayStrip').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView('stats'); }
});

// ---------------------------------------------------------------- notices

const noticeEl = $('notice');
let noticeTimer = null;

/** Shows a dismissible message above the list. `ms` = auto-hide delay (0 = stay). */
function showNotice(html, ms = 0) {
  clearTimeout(noticeTimer);
  $('noticeText').innerHTML = html;
  noticeEl.classList.remove('hidden');
  if (ms) noticeTimer = setTimeout(() => noticeEl.classList.add('hidden'), ms);
}
$('noticeClose').addEventListener('click', () => noticeEl.classList.add('hidden'));

async function showRecoveredRuns() {
  const runs = await api.takeRecoveredRuns();
  if (!runs.length) return;
  const lines = runs.map((r) =>
    `<b>${escapeHtml(r.project_name)}</b> was still running when TimeTrack last closed. ` +
    `It was stopped at ${fmtTime(r.stopped_at)}, the last time the app was open (${fmtHM(r.seconds)} saved).`);
  showNotice(lines.join('<br>'));
}

// ---------------------------------------------------------------- live updates

onDataChanged((reason) => {
  if (reason === 'paused_for_sleep') showNotice('Timer paused: the computer was asleep.', 8000);
  refresh().catch((err) => console.error('refresh failed', err));
});

let lastTick = Date.now();
function tick() {
  const now = Date.now();
  if (now - lastTick > WAKE_GAP_MS) {
    // Just woke up: let the backend check for sleep now instead of on its next tick.
    api.sync().finally(() => refresh());
  }
  lastTick = now;
  if (!state.projects.some((p) => p.is_running)) return;
  renderProjects();
  renderToday();
  // Stats are heavier and have hover state: refresh every 5 s, never under the pointer.
  if (currentView === 'stats' && !chartHover && Math.floor(now / 1000) % 5 === 0) renderStats();
}

// ---------------------------------------------------------------- boot

setupTitlebar($('titlebar'));
useSharedTheme();
initSettings();
refresh()
  .then(showRecoveredRuns)
  .catch((err) => console.error('boot failed', err));
setInterval(tick, TICK_MS);
