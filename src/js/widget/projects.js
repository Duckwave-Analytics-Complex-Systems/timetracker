// Projects tab: the project cards of the workspace shown (Personal or an
// organization, see orgs.js), their ⋯ menu, the add/edit dialog and logo upload.
import { api } from '../core/api.js';
import { escapeHtml, fmtHMS } from '../core/format.js';
import { moneyOf } from '../core/money.js';
import { bill, billedPeople, liveSeconds } from '../core/model.js';
import { PERSONAL, inWorkspace } from '../core/orgs.js';
import { isSharedRun } from '../core/sessions.js';
import { toggleTimer } from '../core/session-notes.js';
import { openEndDialog } from './end-project.js';
import { applyWorkspaceChange, chosenOrg, fillProjectWorkspace, startingRate, workspaceName } from './orgs.js';
import { resizeImageToDataUrl } from './image.js';
import { openSessionPicker, sessionAction, sessionLine } from './sessions.js';
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

/** The projects of the workspace shown. */
export const workspaceProjects = () => state.projects.filter((p) => inWorkspace(p, state.workspace));

function sortedProjects() {
  const rows = workspaceProjects().map((p) => ({ p, seconds: liveSeconds(p) }));
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
  const feature = p.active_feature_name
    ? `<div class="card-phase"><i style="background:var(--cat-${(p.active_feature_color ?? 0) + 1})"></i>${escapeHtml(p.active_feature_name)}</div>`
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
        ${feature}
        ${p.is_running && sessionLine(p.id) ? `<div class="card-with">${escapeHtml(sessionLine(p.id))}</div>` : ''}
        <div class="card-sub">
          <span class="status-dot"></span>
          <span>${p.is_running ? (isSharedRun(p) ? 'Shared session' : p.run_device ? 'Running on phone' : 'Running') : 'Paused'}</span>
          ${p.hourly_rate ? `<span>·</span><span class="earnings">${moneyOf(p, bill(p, seconds))}</span>` : ''}
          ${billedPeople(p) > 1 ? `<span>·</span><span class="people-badge">×${billedPeople(p)}</span>` : ''}
          ${p.shared ? '<span>·</span><span class="people-badge">Shared</span>' : ''}
        </div>
      </div>
    </div>
    <button class="card-menu-btn" title="More">
      <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>
    </button>`;
}

export function renderProjects() {
  listEl.innerHTML = '';
  const shown = workspaceProjects();
  emptyEl.classList.toggle('hidden', shown.length > 0);
  if (!shown.length) {
    const org = state.workspace !== PERSONAL;
    $('emptyTitle').textContent = org ? `No projects in ${workspaceName(state.workspace)} yet.` : 'No projects yet.';
    $('emptyHint').textContent = org
      ? 'Add one here, or move one of yours in from its Edit dialog.'
      : 'Add one to start tracking billable time.';
  }

  for (const { p, seconds } of sortedProjects()) {
    const card = document.createElement('article');
    card.className = `project-card${p.is_running ? ' running' : ''}`;
    card.innerHTML = cardHtml(p, seconds);

    const onKey = (fn) => (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    };
    const ring = card.querySelector('.ring-wrap');
    ring.addEventListener('click', () => toggleTimer(p, act));
    ring.addEventListener('keydown', onKey(() => toggleTimer(p, act)));
    const meta = card.querySelector('.card-meta');
    meta.addEventListener('click', () => api.openProjectWindow(p.id));
    meta.addEventListener('keydown', onKey(() => api.openProjectWindow(p.id)));
    card.querySelector('.card-menu-btn').addEventListener('click', (e) => openCardMenu(e, p));

    listEl.appendChild(card);
  }
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
    const question = p.shared
      ? `Reset your tracked time on "${p.name}"?\nTeammates' time and the schedule are kept.`
      : `Reset all tracked time for "${p.name}"?\nIts schedule is kept.`;
    if (confirm(question)) act(() => api.resetProject(p.id));
  },
  end: (p) => openEndDialog(p),
  session: (p) => openSessionPicker(p).catch((err) => alert(String(err))),
  delete: (p) => {
    const everyone = p.shared ? ` for everyone on it, including their tracked time` : '';
    if (confirm(`Delete "${p.name}"? This removes its tracked time and schedule permanently${everyone}.`)) act(() => api.deleteProject(p.id));
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
  // Someone else's project: leaving it is in its Team tab.
  const shared = sessionAction(p);
  const items = p.is_owner ? [
    { action: 'open', label: 'Open project' },
    ...(shared ? [shared] : []),
    { action: 'edit', label: 'Edit' },
    { action: 'logo', label: 'Change logo' },
    ...(p.logo_data ? [{ action: 'remove-logo', label: 'Remove logo' }] : []),
    { action: 'reset', label: p.shared ? 'Reset my time' : 'Reset time' },
    { action: 'end', label: 'End project' },
    { action: 'delete', label: 'Delete', danger: true },
  ] : [
    { action: 'open', label: 'Open project' },
    ...(shared ? [shared] : []),
    { action: 'reset', label: 'Reset my time' },
  ];
  openMenu(evt.currentTarget, items, (action) => MENU_ACTIONS[action](p));
}

// ---------------------------------------------------------------- add / edit dialog

export function openProjectDialog(project) {
  editingId = project ? project.id : null;
  $('dialogTitle').textContent = project ? 'Edit Project' : 'New Project';
  nameInput.value = project ? project.name : '';
  fillProjectWorkspace(project);
  // A new project in an organization starts from its default rate.
  rateInput.value = project ? project.hourly_rate || '' : startingRate() || '';
  peopleInput.value = project ? project.people_count || 1 : 1;
  dialogEl.showModal();
  nameInput.focus();
}

// A new project's rate follows the workspace picked, unless one was typed in.
let rateShown = '';
$('projectOrg').addEventListener('focus', () => { rateShown = rateInput.value; });
$('projectOrg').addEventListener('change', () => {
  if (!editingId && String(rateInput.value) === String(rateShown)) rateInput.value = startingRate() || '';
});

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
  const editing = editingId ? state.projects.find((p) => p.id === editingId) : null;
  await act(async () => {
    if (!editing) return api.addProject({ ...fields, orgId: chosenOrg() });
    await api.updateProject(editing.id, fields);
    return applyWorkspaceChange(editing);
  });
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
