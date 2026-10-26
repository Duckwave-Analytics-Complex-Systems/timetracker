// Projects tab: the project cards, their ⋯ menu, the add/edit dialog and
// logo upload.
import { api } from '../core/api.js';
import { escapeHtml, fmtHMS, money } from '../core/format.js';
import { bill, liveSeconds } from '../core/model.js';
import { state, act } from './store.js';

const SORT_STORAGE_KEY = 'timetrack:sort';
const RING_RADIUS = 28;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;
const RING_SWEEP_SECONDS = 3600;

const $ = (id) => document.getElementById(id);
const listEl = $('projectList');
const emptyEl = $('emptyState');
const menuEl = $('cardMenu');
const dialogEl = $('projectDialog');
const nameInput = $('projectName');
const rateInput = $('projectRate');
const peopleInput = $('projectPeople');
const sortSelect = $('sortSelect');
const logoInput = $('logoInput');

let sortBy = localStorage.getItem(SORT_STORAGE_KEY) || 'name';
let editingId = null;
let logoTargetId = null;

// ---------------------------------------------------------------- cards

function sortedProjects() {
  const rows = state.projects.map((p) => ({ p, seconds: liveSeconds(p) }));
  rows.sort((a, b) => {
    if (sortBy === 'rate') return (b.p.hourly_rate || 0) - (a.p.hourly_rate || 0);
    if (sortBy === 'bill') return bill(b.p, b.seconds) - bill(a.p, a.seconds);
    return a.p.name.localeCompare(b.p.name);
  });
  return rows;
}

export function logoMarkup(p, cls = 'card-logo') {
  return p.logo_data
    ? `<img class="${cls}" src="${p.logo_data}" alt="" />`
    : `<div class="${cls} logo-placeholder">${escapeHtml((p.name[0] || '?').toUpperCase())}</div>`;
}

function cardHtml(p, seconds) {
  const dashOffset = RING_CIRC * (1 - (seconds % RING_SWEEP_SECONDS) / RING_SWEEP_SECONDS);
  const phase = p.active_phase_name
    ? `<div class="card-phase"><i style="background:var(--cat-${(p.active_phase_color ?? 0) + 1})"></i>${escapeHtml(p.active_phase_name)}</div>`
    : '';
  return `
    <div class="ring-wrap" role="button" tabindex="0" aria-label="${p.is_running ? 'Pause' : 'Start'} ${escapeHtml(p.name)}">
      <svg viewBox="0 0 64 64">
        <circle class="ring-track" cx="32" cy="32" r="${RING_RADIUS}"></circle>
        <circle class="ring-progress" cx="32" cy="32" r="${RING_RADIUS}"
                stroke-dasharray="${RING_CIRC}" stroke-dashoffset="${dashOffset}"></circle>
      </svg>
      <div class="ring-time">${fmtHMS(seconds)}</div>
    </div>
    <div class="card-meta" role="button" tabindex="0" title="Open project">
      ${logoMarkup(p)}
      <div class="card-meta-text">
        <div class="card-name">${escapeHtml(p.name)}</div>
        ${phase}
        <div class="card-sub">
          <span class="status-dot"></span>
          <span>${p.is_running ? (p.run_device ? 'Running on phone' : 'Running') : 'Paused'}</span>
          ${p.hourly_rate ? `<span>·</span><span class="earnings">${money(bill(p, seconds))}</span>` : ''}
          ${p.people_count > 1 ? `<span>·</span><span class="people-badge">×${p.people_count}</span>` : ''}
        </div>
      </div>
    </div>
    <button class="card-menu-btn" title="More">
      <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>
    </button>`;
}

export function renderProjects() {
  listEl.innerHTML = '';
  emptyEl.classList.toggle('hidden', state.projects.length > 0);

  for (const { p, seconds } of sortedProjects()) {
    const card = document.createElement('article');
    card.className = `project-card${p.is_running ? ' running' : ''}`;
    card.innerHTML = cardHtml(p, seconds);

    const onKey = (fn) => (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    };
    const ring = card.querySelector('.ring-wrap');
    ring.addEventListener('click', () => toggleTimer(p));
    ring.addEventListener('keydown', onKey(() => toggleTimer(p)));
    const meta = card.querySelector('.card-meta');
    meta.addEventListener('click', () => api.openProjectWindow(p.id));
    meta.addEventListener('keydown', onKey(() => api.openProjectWindow(p.id)));
    card.querySelector('.card-menu-btn').addEventListener('click', (e) => openCardMenu(e, p));

    listEl.appendChild(card);
  }
}

function toggleTimer(p) {
  return act(() => (p.is_running ? api.pause() : api.start(p.id)));
}

sortSelect.value = sortBy;
sortSelect.addEventListener('change', () => {
  sortBy = sortSelect.value;
  localStorage.setItem(SORT_STORAGE_KEY, sortBy);
  renderProjects();
});

// ---------------------------------------------------------------- ⋯ menu

const MENU_ACTIONS = {
  open: (p) => api.openProjectWindow(p.id),
  edit: (p) => openProjectDialog(p),
  logo: (p) => {
    logoTargetId = p.id;
    logoInput.value = '';
    logoInput.click();
  },
  'remove-logo': (p) => act(() => api.setLogo(p.id, null)),
  reset: (p) => {
    if (confirm(`Reset all tracked time for "${p.name}"?\nIts schedule is kept.`)) act(() => api.resetProject(p.id));
  },
  archive: (p) => {
    if (confirm(`File "${p.name}"?\nIt leaves this list but keeps all its history. You can restore it from the Archive tab.`)) {
      act(() => api.archiveProject(p.id));
    }
  },
  delete: (p) => {
    if (confirm(`Delete "${p.name}"? This removes its tracked time and schedule permanently.`)) act(() => api.deleteProject(p.id));
  },
};

/**
 * Generic floating menu under `anchor`. `items` is [{ action, label, danger? }].
 * Callers stop the click's propagation (a document click closes it). The menu is
 * measured before it is shown, so it can flip above the button instead of
 * running off the bottom of the window (e.g. for the last card).
 */
export function openMenu(anchor, items, onPick) {
  menuEl.innerHTML = items
    .map((it) => `<button data-action="${it.action}"${it.danger ? ' class="danger"' : ''}>${escapeHtml(it.label)}</button>`)
    .join('');
  menuEl.onclick = (e) => {
    const action = e.target.closest('button')?.dataset.action;
    menuEl.classList.add('hidden');
    if (action) onPick(action);
  };

  menuEl.classList.remove('hidden');
  menuEl.style.visibility = 'hidden';
  menuEl.style.top = '0px';
  menuEl.style.left = '0px';
  const btnRect = anchor.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const margin = 8;
  let top = btnRect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - margin) top = btnRect.top - menuRect.height - 4;
  top = Math.max(margin, Math.min(top, window.innerHeight - menuRect.height - margin));
  const left = Math.max(margin, Math.min(btnRect.right - menuRect.width, window.innerWidth - menuRect.width - margin));
  menuEl.style.top = `${top}px`;
  menuEl.style.left = `${left}px`;
  menuEl.style.visibility = 'visible';
}
document.addEventListener('click', () => menuEl.classList.add('hidden'));

function openCardMenu(evt, p) {
  evt.stopPropagation();
  const items = [
    { action: 'open', label: 'Open project' },
    { action: 'edit', label: 'Edit' },
    { action: 'logo', label: 'Change logo' },
    ...(p.logo_data ? [{ action: 'remove-logo', label: 'Remove logo' }] : []),
    { action: 'reset', label: 'Reset time' },
    { action: 'archive', label: 'File (archive)' },
    { action: 'delete', label: 'Delete', danger: true },
  ];
  openMenu(evt.currentTarget, items, (action) => MENU_ACTIONS[action](p));
}

// ---------------------------------------------------------------- add / edit dialog

export function openProjectDialog(project) {
  editingId = project ? project.id : null;
  $('dialogTitle').textContent = project ? 'Edit Project' : 'New Project';
  nameInput.value = project ? project.name : '';
  rateInput.value = project ? project.hourly_rate || '' : '';
  peopleInput.value = project ? project.people_count || 1 : 1;
  dialogEl.showModal();
  nameInput.focus();
}

$('addProjectBtn').addEventListener('click', () => openProjectDialog());
$('dialogCancel').addEventListener('click', () => dialogEl.close());
$('projectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fields = {
    name: nameInput.value.trim(),
    hourlyRate: parseFloat(rateInput.value) || 0,
    peopleCount: Math.max(1, parseInt(peopleInput.value, 10) || 1),
  };
  if (!fields.name) return;
  await act(() => (editingId ? api.updateProject(editingId, fields) : api.addProject(fields)));
  dialogEl.close();
});

// ---------------------------------------------------------------- logo upload
// A plain <input type="file"> + FileReader needs no native permissions. The
// image is downscaled client-side so SQLite never holds a full-size photo.

logoInput.addEventListener('change', async () => {
  const file = logoInput.files[0];
  const id = logoTargetId;
  logoTargetId = null;
  if (!file || !id) return;
  try {
    const dataUrl = await resizeImageToDataUrl(file, 128);
    await act(() => api.setLogo(id, dataUrl));
  } catch (err) {
    console.error('logo upload failed', err);
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
