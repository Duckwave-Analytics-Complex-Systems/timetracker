import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';

const appWindow = getCurrentWindow();

const listEl = document.getElementById('projectList');
const emptyEl = document.getElementById('emptyState');
const sleepBanner = document.getElementById('sleepBanner');
const menuEl = document.getElementById('cardMenu');
const dialogEl = document.getElementById('projectDialog');
const dialogForm = document.getElementById('projectForm');
const dialogTitle = document.getElementById('dialogTitle');
const nameInput = document.getElementById('projectName');
const rateInput = document.getElementById('projectRate');

const HEARTBEAT_MS = 7000; // within the required 5-10s autosave window
const RING_RADIUS = 28;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;
// A full ring sweep represents this many seconds of the *current* running
// session (visual only) so the ring animates smoothly instead of forever
// creeping toward one static "full" state on long-running projects.
const RING_SWEEP_SECONDS = 3600;

let projects = [];
let editingId = null;
let menuTargetId = null;
let tickHandle = null;
let heartbeatHandle = null;

function fmtHMS(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function liveSeconds(p) {
  if (!p.is_running || !p.run_started_at) return p.total_seconds;
  const elapsed = Math.floor((Date.now() - p.run_started_at) / 1000);
  return p.total_seconds + Math.max(0, elapsed);
}

function money(p, seconds) {
  if (!p.hourly_rate) return null;
  const amount = (seconds / 3600) * p.hourly_rate;
  return `$${amount.toFixed(2)}`;
}

function render() {
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', projects.length > 0);

  for (const p of projects) {
    const seconds = liveSeconds(p);
    const sweepFrac = (seconds % RING_SWEEP_SECONDS) / RING_SWEEP_SECONDS;
    const dashOffset = RING_CIRC * (1 - sweepFrac);

    const card = document.createElement('article');
    card.className = `project-card${p.is_running ? ' running' : ''}`;
    card.dataset.id = p.id;

    const earnings = money(p, seconds);

    card.innerHTML = `
      <div class="ring-wrap" role="button" tabindex="0"
           aria-label="${p.is_running ? 'Pause' : 'Start'} ${escapeHtml(p.name)}">
        <svg viewBox="0 0 64 64">
          <circle class="ring-track" cx="32" cy="32" r="${RING_RADIUS}"></circle>
          <circle class="ring-progress" cx="32" cy="32" r="${RING_RADIUS}"
                   stroke-dasharray="${RING_CIRC}" stroke-dashoffset="${dashOffset}"></circle>
        </svg>
        <div class="ring-time">${fmtHMS(seconds)}</div>
      </div>
      <div class="card-meta">
        <div class="card-name">${escapeHtml(p.name)}</div>
        <div class="card-sub">
          <span class="status-dot"></span>
          <span>${p.is_running ? 'Running' : 'Paused'}</span>
          ${earnings ? `<span>·</span><span class="earnings">${earnings}</span>` : ''}
        </div>
      </div>
      <button class="card-menu-btn" title="More">
        <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>
      </button>
    `;

    card.querySelector('.ring-wrap').addEventListener('click', () => toggleProject(p));
    card.querySelector('.ring-wrap').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleProject(p); }
    });
    card.querySelector('.card-menu-btn').addEventListener('click', (e) => openCardMenu(e, p.id));

    listEl.appendChild(card);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------- Timer ticking (visual only; server holds truth) ----------------
function startTicking() {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    if (projects.some((p) => p.is_running)) render();
  }, 1000);
}

// ---------------- Actions ----------------
async function toggleProject(p) {
  try {
    projects = p.is_running
      ? await invoke('pause_project', { id: p.id })
      : await invoke('start_project', { id: p.id });
    render();
  } catch (err) {
    console.error('toggleProject failed', err);
  }
}

async function refresh() {
  projects = await invoke('get_projects');
  render();
}

async function heartbeat() {
  const running = projects.find((p) => p.is_running);
  try {
    const result = await invoke('checkpoint', { runningId: running ? running.id : null });
    projects = result.projects;
    sleepBanner.classList.toggle('hidden', !result.resumed_from_sleep);
    if (result.resumed_from_sleep) {
      setTimeout(() => sleepBanner.classList.add('hidden'), 6000);
    }
    render();
  } catch (err) {
    console.error('heartbeat failed', err);
  }
}

// ---------------- Add / Edit dialog ----------------
document.getElementById('addProjectBtn').addEventListener('click', () => openDialog());
document.getElementById('dialogCancel').addEventListener('click', () => dialogEl.close());

function openDialog(project) {
  editingId = project ? project.id : null;
  dialogTitle.textContent = project ? 'Edit Project' : 'New Project';
  nameInput.value = project ? project.name : '';
  rateInput.value = project ? project.hourly_rate || '' : '';
  dialogEl.showModal();
  nameInput.focus();
}

dialogForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const rate = parseFloat(rateInput.value) || 0;
  if (!name) return;

  try {
    if (editingId) {
      await invoke('update_project', { id: editingId, name, hourlyRate: rate });
    } else {
      await invoke('add_project', { name, hourlyRate: rate });
    }
    await refresh();
    dialogEl.close();
  } catch (err) {
    console.error('save project failed', err);
  }
});

// ---------------- Card action menu ----------------
function openCardMenu(evt, id) {
  evt.stopPropagation();
  menuTargetId = id;
  const rect = evt.currentTarget.getBoundingClientRect();
  menuEl.style.top = `${rect.bottom + 4}px`;
  menuEl.style.left = `${Math.max(8, rect.right - 140)}px`;
  menuEl.classList.remove('hidden');
}
document.addEventListener('click', () => menuEl.classList.add('hidden'));

menuEl.addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (!action || !menuTargetId) return;
  const project = projects.find((p) => p.id === menuTargetId);
  menuEl.classList.add('hidden');

  if (action === 'edit') {
    openDialog(project);
  } else if (action === 'reset') {
    if (confirm(`Reset all tracked time for "${project.name}"?`)) {
      await invoke('reset_project', { id: project.id });
      await refresh();
    }
  } else if (action === 'delete') {
    if (confirm(`Delete "${project.name}"? This removes its tracked time permanently.`)) {
      await invoke('delete_project', { id: project.id });
      await refresh();
    }
  }
});

// ---------------- Titlebar controls ----------------
document.getElementById('closeBtn').addEventListener('click', () => appWindow.close());

const pinBtn = document.getElementById('pinBtn');
let pinned = false;
pinBtn.addEventListener('click', async () => {
  pinned = !pinned;
  await appWindow.setAlwaysOnTop(pinned);
  pinBtn.setAttribute('aria-pressed', String(pinned));
});

document.getElementById('exportBtn').addEventListener('click', async () => {
  const format = confirm('Export as CSV? Cancel for JSON instead.') ? 'csv' : 'json';
  try {
    const contents = await invoke(format === 'csv' ? 'export_csv' : 'export_json');
    const path = await save({
      defaultPath: `timetrack-export.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (path) {
      await writeTextFile(path, contents);
    }
  } catch (err) {
    console.error('export failed', err);
  }
});

// ---------------- Boot ----------------
(async function init() {
  await refresh();
  startTicking();
  heartbeatHandle = setInterval(heartbeat, HEARTBEAT_MS);
  // Also checkpoint immediately if something is already running (e.g. app
  // was relaunched right after a crash) so the UI reflects reality fast.
  if (projects.some((p) => p.is_running)) heartbeat();
})();

window.addEventListener('beforeunload', () => {
  clearInterval(tickHandle);
  clearInterval(heartbeatHandle);
});
