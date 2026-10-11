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
const peopleInput = document.getElementById('projectPeople');
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
  return (seconds / 3600) * (p.hourly_rate || 0) * (p.people_count || 1);
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
            ${p.people_count > 1 ? `<span>·</span><span class="people-badge">×${p.people_count}</span>` : ''}
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
let statsTicks = 0;
function startTicking() {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    if (!projects.some((p) => p.is_running)) return;
    render();
    renderToday();
    // Stats are heavier and have hover state, so they refresh every 5s and
    // never while the pointer is over the chart (it would drop the tooltip).
    if (currentView === 'stats' && !chartHover && ++statsTicks % 5 === 0) renderStats();
  }, 1000);
}

// Redraws everything that depends on projects / daily rows.
function renderAll() {
  render();
  renderToday();
  if (currentView === 'stats' && !chartHover) renderStats();
}

// ---------------- Actions ----------------
// Projects and daily rows are always fetched together and assigned in the
// same synchronous step, so a redraw can never pair fresh project state with
// stale per-day totals (which would briefly double- or under-count today).
async function toggleProject(p) {
  try {
    const next = p.is_running
      ? await invoke('pause_project', { id: p.id })
      : await invoke('start_project', { id: p.id });
    const rows = await fetchDaily();
    projects = next;
    dailyRows = rows;
    renderAll();
  } catch (err) {
    console.error('toggleProject failed', err);
  }
}

async function refresh() {
  const [list, rows] = await Promise.all([invoke('get_projects'), fetchDaily()]);
  projects = list;
  dailyRows = rows;
  ensureColorSlots();
  renderAll();
}

async function heartbeat() {
  const running = projects.find((p) => p.is_running);
  try {
    const result = await invoke('checkpoint', { runningId: running ? running.id : null });
    const rows = await fetchDaily();
    projects = result.projects;
    dailyRows = rows;
    sleepBanner.classList.toggle('hidden', !result.resumed_from_sleep);
    if (result.resumed_from_sleep) {
      setTimeout(() => sleepBanner.classList.add('hidden'), 6000);
    }
    renderAll();
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
  peopleInput.value = project ? project.people_count || 1 : 1;
  dialogEl.showModal();
  nameInput.focus();
}

dialogForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const rate = parseFloat(rateInput.value) || 0;
  const peopleCount = Math.max(1, parseInt(peopleInput.value, 10) || 1);
  if (!name) return;

  try {
    if (editingId) {
      await invoke('update_project', { id: editingId, name, hourlyRate: rate, peopleCount });
    } else {
      await invoke('add_project', { name, hourlyRate: rate, peopleCount });
    }
    await refresh();
    dialogEl.close();
  } catch (err) {
    console.error('save project failed', err);
  }
});

// Card action menu. Rebuilt per-project on open (so "Remove logo" only
// shows up when there's a logo to remove) and measured before it's
// positioned, so it can flip above the button instead of running off the
// bottom of the window — this is what was broken for the last card(s) in
// the list, where "below the button" had no room left.
function openCardMenu(evt, id) {
  evt.stopPropagation();
  menuTargetId = id;
  const project = projects.find((p) => p.id === id);

  menuEl.innerHTML = `
    <button data-action="edit">Edit</button>
    <button data-action="logo">Change logo</button>
    ${project.logo_data ? '<button data-action="remove-logo">Remove logo</button>' : ''}
    <button data-action="reset">Reset time</button>
    <button data-action="delete" class="danger">Delete</button>
  `;

  // Measure with the menu laid out but invisible, so getBoundingClientRect
  // reflects its real size before it's ever shown in the wrong place.
  menuEl.classList.remove('hidden');
  menuEl.style.visibility = 'hidden';
  menuEl.style.top = '0px';
  menuEl.style.left = '0px';

  const btnRect = evt.currentTarget.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const margin = 8;

  let top = btnRect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - margin) {
    // Not enough room below (e.g. this is the last card in the list) —
    // open upward from the button instead.
    top = btnRect.top - menuRect.height - 4;
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - menuRect.height - margin));

  let left = btnRect.right - menuRect.width;
  left = Math.max(margin, Math.min(left, window.innerWidth - menuRect.width - margin));

  menuEl.style.top = `${top}px`;
  menuEl.style.left = `${left}px`;
  menuEl.style.visibility = 'visible';
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
  } else if (action === 'remove-logo') {
    await invoke('set_project_logo', { id: targetId, dataUrl: null });
    await refresh();
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

// ================= v4: daily hours, Today strip and Stats =================
const DAILY_FETCH_DAYS = 90; // covers the longest range (12 weeks = 84 days)
const RANGE_STORAGE_KEY = 'timetrack:stats-range';
const COLOR_STORAGE_KEY = 'timetrack:project-colors';
const CAT_SLOTS = 8;
const GAP = 2; // px of surface between stacked segments
const RANGES = {
  '7d': { n: 7, span: 1, label: 'last 7 days', title: 'Hours per day' },
  '30d': { n: 30, span: 1, label: 'last 30 days', title: 'Hours per day' },
  '12w': { n: 12, span: 7, label: 'last 12 weeks', title: 'Hours per week' },
};

const todayStrip = document.getElementById('todayStrip');
const todayTotalEl = document.getElementById('todayTotal');
const todayBarEl = document.getElementById('todayBar');
const todayLegendEl = document.getElementById('todayLegend');
const chartHost = document.getElementById('chartHost');
const chartWrap = document.getElementById('chartWrap');
const tipEl = document.getElementById('chartTip');
const rangeSeg = document.getElementById('rangeSeg');

let dailyRows = []; // [{ day: 'YYYY-MM-DD', project_id, seconds }] for the last 90 days
let statsRange = localStorage.getItem(RANGE_STORAGE_KEY);
if (!RANGES[statsRange]) statsRange = '7d';
let selectedKey = null; // selected chart column (null = the newest one)
let currentView = 'projects';
let chartHover = false;
let currentBuckets = [];
let colorSlots = {};
try { colorSlots = JSON.parse(localStorage.getItem(COLOR_STORAGE_KEY) || '{}') || {}; } catch { colorSlots = {}; }

async function fetchDaily() {
  const today = new Date();
  return invoke('get_daily', {
    fromDay: dayKey(addDays(today, -(DAILY_FETCH_DAYS - 1))),
    toDay: dayKey(today),
  });
}

// ---- dates (local time zone, same one the backend uses to bucket days) ----
function pad2(n) { return String(n).padStart(2, '0'); }
function dayKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function startOfToday() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function fmtDate(d, opts) { return d.toLocaleDateString(undefined, opts); }

function fmtHM(sec) {
  if (!(sec > 0)) return '0m';
  const mins = Math.round(sec / 60);
  if (mins === 0) return '<1m';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${pad2(m)}m` : `${m}m`;
}

// ---- stable per-project colors ----
// A project keeps its palette slot for life (color follows the entity, not
// its rank). Slots of deleted projects are recycled; with more than 8
// projects the extras share the neutral "Other" color.
function ensureColorSlots() {
  const live = new Set(projects.map((p) => p.id));
  for (const id of Object.keys(colorSlots)) if (!live.has(id)) delete colorSlots[id];
  const used = new Set(Object.values(colorSlots).filter((s) => s != null));
  for (const p of projects) {
    if (colorSlots[p.id] != null) continue;
    let slot = null;
    for (let i = 0; i < CAT_SLOTS; i++) if (!used.has(i)) { slot = i; break; }
    colorSlots[p.id] = slot;
    if (slot != null) used.add(slot);
  }
  try { localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify(colorSlots)); } catch { /* ignore */ }
}
function colorVar(pid) {
  const s = colorSlots[pid];
  return s == null ? 'var(--cat-other)' : `var(--cat-${s + 1})`;
}

// ---- data assembly ----
// Time from a timer running right now is not in the DB yet (it is at most one
// autosave tick behind), so it is added on top, split at local midnight.
function liveAdditions() {
  const p = projects.find((x) => x.is_running && x.run_started_at);
  if (!p) return [];
  const out = [];
  let cur = Math.floor(p.run_started_at / 1000);
  const end = Math.floor(Date.now() / 1000);
  while (cur < end) {
    const d = new Date(cur * 1000);
    const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() / 1000;
    const chunkEnd = Math.min(end, nextMidnight);
    out.push([dayKey(d), p.id, chunkEnd - cur]);
    cur = chunkEnd;
  }
  return out;
}

function dayMap() {
  const map = new Map(); // day -> Map(project_id -> seconds)
  const add = (day, pid, s) => {
    if (!(s > 0)) return;
    let m = map.get(day);
    if (!m) { m = new Map(); map.set(day, m); }
    m.set(pid, (m.get(pid) || 0) + s);
  };
  for (const r of dailyRows) add(r.day, r.project_id, r.seconds);
  for (const [d, pid, s] of liveAdditions()) add(d, pid, s);
  return map;
}

// Per-project entries sorted by time desc (each with its project record).
function rowsFor(per) {
  const rows = [];
  for (const [pid, secs] of per) {
    const p = projects.find((x) => x.id === pid);
    if (p && secs > 0) rows.push({ pid, p, secs });
  }
  return rows.sort((a, b) => b.secs - a.secs);
}

// Chart segments in fixed slot order; projects without a slot fold into "Other".
function segmentsFor(per) {
  const known = [];
  const other = { pid: 'other', name: 'Other', secs: 0, color: 'var(--cat-other)', slot: 99 };
  for (const { pid, p, secs } of rowsFor(per)) {
    const slot = colorSlots[pid];
    if (slot == null) other.secs += secs;
    else known.push({ pid, name: p.name, secs, color: `var(--cat-${slot + 1})`, slot });
  }
  known.sort((a, b) => a.slot - b.slot);
  if (other.secs > 0) known.push(other);
  return known;
}

// ---- Today strip ----
function renderToday() {
  const per = dayMap().get(dayKey(new Date())) || new Map();
  const rows = rowsFor(per);
  const total = rows.reduce((a, r) => a + r.secs, 0);
  todayTotalEl.textContent = fmtHM(total);

  const segs = segmentsFor(per);
  todayBarEl.innerHTML = segs.length
    ? segs.map((g) => `<span class="today-seg" style="flex:${g.secs};background:${g.color}" title="${escapeHtml(g.name)} · ${fmtHM(g.secs)}"></span>`).join('')
    : '<span class="today-seg empty" style="flex:1"></span>';

  if (!rows.length) {
    todayLegendEl.innerHTML = '<span>Nothing tracked yet today</span>';
    return;
  }
  const chip = (r) => `<span class="chip"><i style="background:${colorVar(r.pid)}"></i><span class="chip-name">${escapeHtml(r.p.name)}</span><span class="chip-time">${fmtHM(r.secs)}</span></span>`;
  const shown = rows.slice(0, 4).map(chip).join('');
  const more = rows.length > 4 ? `<span class="chip"><span class="chip-time">+${rows.length - 4} more</span></span>` : '';
  todayLegendEl.innerHTML = shown + more;
}

// ---- Stats ----
function buildBuckets(map, cfg) {
  const t0 = startOfToday();
  const buckets = [];
  for (let i = 0; i < cfg.n; i++) {
    const end = addDays(t0, -(cfg.n - 1 - i) * cfg.span);
    const start = addDays(end, -(cfg.span - 1));
    const per = new Map();
    let total = 0;
    for (let k = 0; k < cfg.span; k++) {
      const m = map.get(dayKey(addDays(start, k)));
      if (!m) continue;
      for (const [pid, s] of m) { per.set(pid, (per.get(pid) || 0) + s); total += s; }
    }
    buckets.push({ key: dayKey(start), start, end, span: cfg.span, per, total });
  }
  return buckets;
}

function computeStats(map, cfg) {
  const t0 = startOfToday();
  const first = addDays(t0, -(cfg.n * cfg.span - 1));
  const perProject = new Map();
  let total = 0, active = 0, best = { secs: 0, day: null };
  for (let i = 0; i < cfg.n * cfg.span; i++) {
    const d = addDays(first, i);
    const m = map.get(dayKey(d));
    if (!m) continue;
    let dayTotal = 0;
    for (const [pid, s] of m) { dayTotal += s; perProject.set(pid, (perProject.get(pid) || 0) + s); }
    if (dayTotal > 0) {
      active++; total += dayTotal;
      if (dayTotal > best.secs) best = { secs: dayTotal, day: d };
    }
  }
  let billed = 0, anyRate = false;
  for (const { p, secs } of rowsFor(perProject)) {
    if (p.hourly_rate > 0) { billed += currentBill(p, secs); anyRate = true; }
  }
  return { total, active, best, perProject, billed, anyRate };
}

function bucketTitle(b, forDetail) {
  if (b.span === 1) {
    const today = startOfToday();
    if (forDetail && b.key === dayKey(today)) return 'Today';
    if (forDetail && b.key === dayKey(addDays(today, -1))) return 'Yesterday';
    return fmtDate(b.start, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const o = { month: 'short', day: 'numeric' };
  return `${fmtDate(b.start, o)} – ${fmtDate(b.end, o)}`;
}

function niceScale(maxH) {
  const steps = [0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 20, 24, 40, 50, 100];
  const want = Math.max(maxH, 0.25);
  const step = steps.find((s) => Math.ceil(want / s) <= 4) || 100;
  return { step, top: Math.ceil(want / step) * step };
}

function chartSvg(buckets, cfg) {
  const W = 340, H = 176, L = 30, R = 6, T = 16, B = 22;
  const plotW = W - L - R, plotH = H - T - B;
  const maxH = Math.max(0, ...buckets.map((b) => b.total)) / 3600;
  if (maxH === 0) return '<div class="chart-empty">No time tracked in this period yet.</div>';

  const { step, top } = niceScale(maxH);
  const yOf = (h) => T + plotH - (h / top) * plotH;
  const n = buckets.length;
  const slot = plotW / n;
  const bw = Math.min(24, Math.max(4, slot * 0.68));
  const nTicks = Math.round(top / step);
  const n1 = (v) => Math.round(v * 100) / 100;

  let s = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(cfg.title)}, ${cfg.label}">`;
  for (let k = 0; k <= nTicks; k++) {
    const v = k * step, y = yOf(v);
    s += `<line class="${k === 0 ? 'axis' : 'grid'}" x1="${L}" x2="${W - R}" y1="${n1(y)}" y2="${n1(y)}"/>`;
    s += `<text x="${L - 5}" y="${n1(y + 3)}" text-anchor="end">${v}h</text>`;
  }

  buckets.forEach((b, i) => {
    const cx = L + slot * (i + 0.5);
    const x = cx - bw / 2;
    const sel = b.key === selectedKey;
    if (sel) s += `<rect class="sel-plate" x="${n1(cx - slot / 2)}" y="${T - 4}" width="${n1(slot)}" height="${plotH + 4}" rx="6"/>`;

    const segs = segmentsFor(b.per);
    let yBase = yOf(0);
    segs.forEach((g, k) => {
      const h = Math.max(1.5, (g.secs / 3600 / top) * plotH);
      const yTop = yBase - h;
      const visH = k === 0 ? h : Math.max(1, h - GAP); // surface gap under every non-bottom segment
      if (k === segs.length - 1) {
        const r = Math.min(4, bw / 2, visH); // rounded data-end, square at the baseline
        s += `<path style="fill:${g.color}" d="M${n1(x)},${n1(yTop + visH)} V${n1(yTop + r)} Q${n1(x)},${n1(yTop)} ${n1(x + r)},${n1(yTop)} H${n1(x + bw - r)} Q${n1(x + bw)},${n1(yTop)} ${n1(x + bw)},${n1(yTop + r)} V${n1(yTop + visH)} Z"/>`;
      } else {
        s += `<rect style="fill:${g.color}" x="${n1(x)}" y="${n1(yTop)}" width="${n1(bw)}" height="${n1(visH)}"/>`;
      }
      yBase = yTop;
    });

    if (sel && b.total > 0) {
      const lx = Math.max(L + 22, Math.min(cx, W - R - 22));
      s += `<text class="cap-label" x="${n1(lx)}" y="${n1(yBase - 4)}" text-anchor="middle">${fmtHM(b.total)}</text>`;
    }

    const labelled = cfg.span === 7 ? (n - 1 - i) % 3 === 0 : cfg.n === 30 ? (n - 1 - i) % 7 === 0 : true;
    if (labelled) {
      const txt = cfg.span === 7 ? fmtDate(b.start, { month: 'short', day: 'numeric' })
        : cfg.n === 30 ? fmtDate(b.start, { month: 'short', day: 'numeric' })
        : i === n - 1 ? 'Today' : fmtDate(b.start, { weekday: 'short' });
      s += `<text class="xtick${sel ? ' sel' : ''}" x="${n1(cx)}" y="${H - 6}" text-anchor="middle">${escapeHtml(txt)}</text>`;
    }
  });

  // Hit targets last so they sit on top; wider than the bars themselves.
  buckets.forEach((b, i) => {
    const cx = L + slot * (i + 0.5);
    s += `<rect class="hit" data-i="${i}" tabindex="0" role="button" aria-label="${escapeHtml(bucketTitle(b))}: ${fmtHM(b.total)}" x="${n1(cx - slot / 2)}" y="${T - 4}" width="${n1(slot)}" height="${plotH + B + 4}"/>`;
  });
  return s + '</svg>';
}

function meterRows(host, rows, emptyMsg) {
  if (!rows.length) { host.innerHTML = `<div class="meter-empty">${emptyMsg}</div>`; return; }
  const max = rows[0].secs;
  host.innerHTML = rows.map((r) => {
    const bill = r.p.hourly_rate > 0 ? ` · <span class="bill">${money(currentBill(r.p, r.secs))}</span>` : '';
    return `<div class="meter"><div class="meter-top"><i style="background:${colorVar(r.pid)}"></i><span class="meter-name">${escapeHtml(r.p.name)}</span><span class="meter-val">${fmtHM(r.secs)}${bill}</span></div><div class="meter-track"><div class="meter-fill" style="width:${((r.secs / max) * 100).toFixed(1)}%;background:${colorVar(r.pid)}"></div></div></div>`;
  }).join('');
}

function renderStats() {
  const cfg = RANGES[statsRange];
  const map = dayMap();
  const buckets = buildBuckets(map, cfg);
  currentBuckets = buckets;
  if (!buckets.some((b) => b.key === selectedKey)) selectedKey = buckets[buckets.length - 1].key;
  const sel = buckets.find((b) => b.key === selectedKey);
  const st = computeStats(map, cfg);

  rangeSeg.querySelectorAll('button').forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.range === statsRange)));

  // tiles
  document.getElementById('tileTotal').textContent = fmtHM(st.total);
  document.getElementById('tileTotalSub').textContent = cfg.label;
  document.getElementById('tileAvg').textContent = st.active ? fmtHM(st.total / st.active) : '—';
  document.getElementById('tileAvgSub').textContent = st.active ? `${st.active} active day${st.active === 1 ? '' : 's'}` : 'no activity';
  document.getElementById('tileBest').textContent = st.best.day ? fmtHM(st.best.secs) : '—';
  document.getElementById('tileBestSub').textContent = st.best.day ? fmtDate(st.best.day, { weekday: 'short', month: 'short', day: 'numeric' }) : '';
  document.getElementById('tileBill').textContent = st.anyRate ? money(st.billed) : '—';
  document.getElementById('tileBillSub').textContent = st.anyRate ? 'at current rates' : 'no hourly rates set';

  // chart + legend (a legend only when there are 2+ series)
  document.getElementById('chartTitle').textContent = cfg.title;
  const legendSegs = segmentsFor(st.perProject);
  document.getElementById('chartLegend').innerHTML = legendSegs.length > 1
    ? legendSegs.map((g) => `<span class="chip"><i style="background:${g.color}"></i><span class="chip-name">${escapeHtml(g.name)}</span></span>`).join('')
    : '';
  chartHost.innerHTML = chartSvg(buckets, cfg);
  tipEl.classList.add('hidden');

  // selected day / week
  document.getElementById('dayTitle').textContent = bucketTitle(sel, true);
  document.getElementById('dayTotal').textContent = sel.total > 0 ? fmtHM(sel.total) : '';
  meterRows(document.getElementById('dayRows'), rowsFor(sel.per), 'No time tracked in this period.');

  // per-project breakdown over the whole range
  document.getElementById('projTotal').textContent = st.total > 0 ? fmtHM(st.total) : '';
  meterRows(document.getElementById('projRows'), rowsFor(st.perProject), `No time tracked in the ${cfg.label}.`);

  // screen-reader table view
  document.getElementById('statsTable').innerHTML =
    `<caption>${escapeHtml(cfg.title)}, ${cfg.label}</caption><thead><tr><th>Period</th><th>Total</th><th>By project</th></tr></thead><tbody>` +
    buckets.map((b) => `<tr><td>${escapeHtml(bucketTitle(b))}</td><td>${fmtHM(b.total)}</td><td>${rowsFor(b.per).map((r) => `${escapeHtml(r.p.name)} ${fmtHM(r.secs)}`).join(', ')}</td></tr>`).join('') +
    '</tbody>';
}

// ---- chart interaction: hover tooltip, click/Enter to select a column ----
function showTip(i, hit) {
  const b = currentBuckets[i];
  if (!b) return;
  const rows = rowsFor(b.per);
  tipEl.innerHTML =
    `<div class="tip-title">${escapeHtml(bucketTitle(b))}</div>` +
    `<div class="tip-total">${b.total > 0 ? fmtHM(b.total) : 'No time tracked'}</div>` +
    rows.slice(0, 5).map((r) => `<div class="tip-row"><i style="background:${colorVar(r.pid)}"></i><span class="n">${escapeHtml(r.p.name)}</span><span class="t">${fmtHM(r.secs)}</span></div>`).join('') +
    (rows.length > 5 ? `<div class="tip-row"><span class="n">+${rows.length - 5} more</span></div>` : '');
  tipEl.classList.remove('hidden');
  const wr = chartWrap.getBoundingClientRect();
  const hr = hit.getBoundingClientRect();
  const tw = tipEl.offsetWidth;
  let left = hr.left - wr.left + hr.width + 6;
  if (left + tw > wr.width) left = hr.left - wr.left - tw - 6;
  tipEl.style.left = `${Math.max(0, Math.min(left, wr.width - tw))}px`;
}
function hideTip() { tipEl.classList.add('hidden'); }
function selectBucket(i) {
  const b = currentBuckets[i];
  if (!b) return;
  selectedKey = b.key;
  renderStats();
}

chartHost.addEventListener('pointerenter', () => { chartHover = true; });
chartHost.addEventListener('pointerleave', () => { chartHover = false; hideTip(); });
chartHost.addEventListener('pointermove', (e) => {
  const hit = e.target.closest && e.target.closest('.hit');
  if (hit) showTip(Number(hit.dataset.i), hit); else hideTip();
});
chartHost.addEventListener('click', (e) => {
  const hit = e.target.closest && e.target.closest('.hit');
  if (hit) selectBucket(Number(hit.dataset.i));
});
chartHost.addEventListener('keydown', (e) => {
  const hit = e.target.closest && e.target.closest('.hit');
  if (hit && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectBucket(Number(hit.dataset.i)); }
});
chartHost.addEventListener('focusin', (e) => {
  const hit = e.target.closest && e.target.closest('.hit');
  if (hit) showTip(Number(hit.dataset.i), hit);
});
chartHost.addEventListener('focusout', hideTip);

rangeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  statsRange = btn.dataset.range;
  try { localStorage.setItem(RANGE_STORAGE_KEY, statsRange); } catch { /* ignore */ }
  selectedKey = null;
  renderStats();
});

// ---- tabs ----
function setView(name) {
  currentView = name;
  chartHover = false; // pointerleave doesn't fire when the chart is hidden underneath the pointer
  document.getElementById('viewProjects').classList.toggle('hidden', name !== 'projects');
  document.getElementById('viewStats').classList.toggle('hidden', name !== 'stats');
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === name)));
  if (name === 'stats') {
    selectedKey = null; // open on today
    renderStats();
    fetchDaily().then((rows) => { dailyRows = rows; if (currentView === 'stats' && !chartHover) renderStats(); }).catch((err) => console.error('daily refresh failed', err));
  }
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
todayStrip.addEventListener('click', () => setView('stats'));
todayStrip.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView('stats'); }
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
