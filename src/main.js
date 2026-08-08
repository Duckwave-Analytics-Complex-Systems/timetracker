// NOTE: this file intentionally avoids `import '@tauri-apps/api/...'` bare
// specifiers. There is no bundler (Vite/webpack) in this project, and a
// WebView cannot resolve npm package names on its own -- that silently
// breaks the whole script (and therefore every button) if you re-add them.
// `withGlobalTauri: true` in tauri.conf.json exposes the same API on
// `window.__TAURI__` instead, which works with a plain <script> tag.
const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { save } = window.__TAURI__.dialog;
const { writeTextFile } = window.__TAURI__.fs;

const appWindow = getCurrentWindow();

const titlebar = document.getElementById('titlebar');
const listEl = document.getElementById('projectList');
const emptyEl = document.getElementById('emptyState');
const sleepBanner = document.getElementById('sleepBanner');
const menuEl = document.getElementById('cardMenu');
const dialogEl = document.getElementById('projectDialog');
const dialogForm = document.getElementById('projectForm');
const dialogTitle = document.getElementById('dialogTitle');
const nameInput = document.getElementById('projectName');
const rateInput = document.getElementById('projectRate');
const settingsPanel = document.getElementById('settingsPanel');
const sortSelect = document.getElementById('sortSelect');
const logoInput = document.getElementById('logoInput');

const HEARTBEAT_MS = 7000; // within the required 5-10s autosave window
const RING_RADIUS = 28;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;
const RING_SWEEP_SECONDS = 3600;
const THEME_STORAGE_KEY = 'timetrack:theme';
const SORT_STORAGE_KEY = 'timetrack:sort';
const DEFAULT_PRIMARY = '#5ee6c4';
const DEFAULT_SECONDARY = '#e8b34d';

let projects = [];
let editingId = null;
let menuTargetId = null;
let logoTargetId = null;
let tickHandle = null;
let heartbeatHandle = null;
let sortBy = localStorage.getItem(SORT_STORAGE_KEY) || 'name';

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

function currentBill(p, seconds) {
  return (seconds / 3600) * (p.hourly_rate || 0);
}

function money(amount) {
  return `$${amount.toFixed(2)}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function sortedProjects() {
  const withLive = projects.map((p) => ({ p, seconds: liveSeconds(p) }));
  withLive.sort((a, b) => {
    if (sortBy === 'rate') return (b.p.hourly_rate || 0) - (a.p.hourly_rate || 0);
    if (sortBy === 'bill') return currentBill(b.p, b.seconds) - currentBill(a.p, a.seconds);
    return a.p.name.localeCompare(b.p.name);
  });
  return withLive;
}

// ---------------- Rendering ----------------
function render() {
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', projects.length > 0);

  for (const { p, seconds } of sortedProjects()) {
    const sweepFrac = (seconds % RING_SWEEP_SECONDS) / RING_SWEEP_SECONDS;
    const dashOffset = RING_CIRC * (1 - sweepFrac);
    const bill = currentBill(p, seconds);

    const card = document.createElement('article');
    card.className = `project-card${p.is_running ? ' running' : ''}`;
    card.dataset.id = p.id;

    const logoMarkup = p.logo_data
      ? `<img class="card-logo" src="${p.logo_data}" alt="" />`
      : `<div class="card-logo-placeholder">${escapeHtml((p.name[0] || '?').toUpperCase())}</div>`;

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
        ${logoMarkup}
        <div class="card-meta-text">
          <div class="card-name">${escapeHtml(p.name)}</div>
          <div class="card-sub">
            <span class="status-dot"></span>
            <span>${p.is_running ? 'Running' : 'Paused'}</span>
            ${p.hourly_rate ? `<span>·</span><span class="earnings">${money(bill)}</span>` : ''}
          </div>
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

// ---------------- Sort ----------------
sortSelect.value = sortBy;
sortSelect.addEventListener('change', () => {
  sortBy = sortSelect.value;
  localStorage.setItem(SORT_STORAGE_KEY, sortBy);
  render();
});

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
  const targetId = menuTargetId;
  menuEl.classList.add('hidden');

  if (action === 'edit') {
    openDialog(project);
  } else if (action === 'logo') {
    logoTargetId = targetId;
    logoInput.value = '';
    logoInput.click();
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

// ---------------- Logo upload ----------------
// Uses a plain <input type="file"> + FileReader instead of the Tauri fs/
// dialog plugins: it needs no extra native permissions and works
// identically on Windows and Linux. The image is downscaled client-side so
// the SQLite column never has to hold a full-resolution photo.
logoInput.addEventListener('change', async () => {
  const file = logoInput.files[0];
  if (!file || !logoTargetId) return;
  try {
    const dataUrl = await resizeImageToDataUrl(file, 128);
    await invoke('set_project_logo', { id: logoTargetId, dataUrl });
    await refresh();
  } catch (err) {
    console.error('logo upload failed', err);
  } finally {
    logoTargetId = null;
  }
});

function resizeImageToDataUrl(file, maxSize) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('invalid image'));
      img.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------------- Settings tab (pin, export, theme) ----------------
const settingsBtn = document.getElementById('settingsBtn');
const pinToggle = document.getElementById('pinToggle');
const primaryColorInput = document.getElementById('primaryColorInput');
const secondaryColorInput = document.getElementById('secondaryColorInput');

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPanel.classList.toggle('hidden');
});
settingsPanel.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => settingsPanel.classList.add('hidden'));

let pinned = false;
pinToggle.addEventListener('change', async () => {
  pinned = pinToggle.checked;
  await appWindow.setAlwaysOnTop(pinned);
});

function applyTheme(primary, secondary) {
  document.documentElement.style.setProperty('--accent-running', primary);
  document.documentElement.style.setProperty('--accent-earnings', secondary);
  primaryColorInput.value = primary;
  secondaryColorInput.value = secondary;
}

function loadTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) || 'null');
    applyTheme(saved?.primary || DEFAULT_PRIMARY, saved?.secondary || DEFAULT_SECONDARY);
  } catch {
    applyTheme(DEFAULT_PRIMARY, DEFAULT_SECONDARY);
  }
}

function saveTheme() {
  localStorage.setItem(
    THEME_STORAGE_KEY,
    JSON.stringify({ primary: primaryColorInput.value, secondary: secondaryColorInput.value })
  );
}

primaryColorInput.addEventListener('input', () => {
  applyTheme(primaryColorInput.value, secondaryColorInput.value);
  saveTheme();
});
secondaryColorInput.addEventListener('input', () => {
  applyTheme(primaryColorInput.value, secondaryColorInput.value);
  saveTheme();
});
document.getElementById('resetColorsBtn').addEventListener('click', () => {
  applyTheme(DEFAULT_PRIMARY, DEFAULT_SECONDARY);
  saveTheme();
});

document.getElementById('exportBtn').addEventListener('click', async () => {
  try {
    const contents = await invoke('export_csv');
    const path = await save({
      defaultPath: 'timetrack-export.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (path) {
      await writeTextFile(path, contents);
    }
  } catch (err) {
    console.error('export failed', err);
  }
});

// ---------------- Titlebar window controls ----------------
document.getElementById('closeBtn').addEventListener('click', () => appWindow.close());
document.getElementById('minimizeBtn').addEventListener('click', () => appWindow.minimize());
document.getElementById('maximizeBtn').addEventListener('click', () => appWindow.toggleMaximize());

// Fix: on Linux, the declarative `data-tauri-drag-region` attribute is
// unreliable under WebKitGTK (both X11 and Wayland) and titlebar dragging
// often simply does nothing. Triggering the drag explicitly via
// `startDragging()` on mousedown works consistently on Linux and Windows
// alike, so it replaces the attribute-based approach entirely.
titlebar.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; // primary button only
  if (e.target.closest('button, .settings-panel, input, select')) return;
  appWindow.startDragging();
});

// ---------------- Boot ----------------
(async function init() {
  loadTheme();
  await refresh();
  startTicking();
  heartbeatHandle = setInterval(heartbeat, HEARTBEAT_MS);
  if (projects.some((p) => p.is_running)) heartbeat();
})();

window.addEventListener('beforeunload', () => {
  clearInterval(tickHandle);
  clearInterval(heartbeatHandle);
});
