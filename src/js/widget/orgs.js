// Organizations in the widget: the workspace switcher in the titlebar
// (Personal or one of your organizations), the bars above the project list,
// the Create / Join dialog and the organization dialog (name, invite code,
// people). The Android app has the same pieces (src/ui/workspace.js,
// src/app/org/[id].js); the rules both follow are in core/orgs.js.
import { api } from '../core/api.js';
import { escapeHtml } from '../core/format.js';
import { PERSONAL, defaultRate, inWorkspace, isOrgAdmin, moveTargets } from '../core/orgs.js';
import { resizeImageToDataUrl } from './image.js';
import { refresh, setWorkspace, state } from './store.js';

const $ = (id) => document.getElementById(id);
const menuEl = $('workspaceMenu');
const ROLE = { owner: 'Owner', admin: 'Admin', member: 'Member' };
const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;

export const workspaceName = (id) =>
  (id === PERSONAL ? 'Personal' : state.orgs.find((o) => o.id === id)?.name ?? 'Personal');

/** An organization's logo, or its first letter on a rounded square. */
function badge(org, cls = 'org-badge') {
  if (!org) return `<span class="${cls} personal" aria-hidden="true"></span>`;
  return org.logo_data
    ? `<img class="${cls}" src="${org.logo_data}" alt="" />`
    : `<span class="${cls}" aria-hidden="true">${escapeHtml(([...org.name.trim()][0] || '?').toUpperCase())}</span>`;
}

// ---------------------------------------------------------------- titlebar + bars

/** Redraws the switcher, the organization bar and the "running elsewhere" bar. */
export function renderWorkspace() {
  const org = state.orgs.find((o) => o.id === state.workspace);
  $('workspaceName').textContent = workspaceName(state.workspace);
  const mark = $('workspaceBadge');
  mark.className = org ? 'ws-mark' : 'brand-mark';
  mark.innerHTML = org ? badge(org, 'ws-mark-img') : '';
  $('workspaceBtn').title = `Workspace: ${workspaceName(state.workspace)}. Click to change.`;

  const bar = $('orgBar');
  bar.classList.toggle('hidden', !org);
  if (org) {
    bar.innerHTML = `${badge(org)}<span class="ws-bar-text">${ROLE[org.role]} · ${people(org.people)}</span><span class="ws-bar-link">Manage ›</span>`;
    bar.onclick = () => openOrgDialog(org.id);
  }

  const away = state.projects.find((p) => p.is_running && !inWorkspace(p, state.workspace));
  const awayEl = $('awayTimer');
  awayEl.classList.toggle('hidden', !away);
  if (away) {
    const where = workspaceName(away.org_id || PERSONAL);
    awayEl.innerHTML = `<span class="status-dot"></span><span class="ws-bar-text"><b>${escapeHtml(away.name)}</b> is running · ${escapeHtml(where)}</span><span class="ws-bar-link">Show</span>`;
    awayEl.onclick = () => setWorkspace(away.org_id || PERSONAL);
  }
}

// ---------------------------------------------------------------- switcher menu

function closeMenu() {
  menuEl.classList.add('hidden');
  $('workspaceBtn').setAttribute('aria-expanded', 'false');
}

async function openMenu() {
  const signedIn = await api.cloudStatus().then((s) => s.signed_in).catch(() => false);
  const row = (id, org, detail) => `
    <button data-ws="${escapeHtml(id)}" role="menuitemradio" aria-checked="${id === state.workspace}"
            class="ws-row${id === state.workspace ? ' on' : ''}">
      ${badge(org)}
      <span class="ws-row-text"><span class="ws-row-name">${escapeHtml(workspaceName(id))}</span><span class="ws-row-detail">${escapeHtml(detail)}</span></span>
      ${id === state.workspace ? '<span class="ws-check">✓</span>' : ''}
    </button>`;
  let html = row(PERSONAL, null, 'Your own projects');
  html += state.orgs.map((o) => row(o.id, o, `${ROLE[o.role]} · ${people(o.people)}`)).join('');
  html += '<div class="ws-divider"></div>';
  if (!signedIn) {
    html += '<p class="ws-hint">Organizations are shared through your account. Sign in to Cloud sync to create or join one.</p>';
    html += '<button data-action="signin">Cloud sync…</button>';
  } else {
    if (!state.orgs.length) {
      html += "<p class=\"ws-hint\">You don't have an organization yet. Create one for your studio, or join one with the invite code an owner or admin gives you.</p>";
    }
    html += '<button data-action="create">+ Create organization</button>';
    html += '<button data-action="join">⤵ Join with a code</button>';
  }
  menuEl.innerHTML = html;

  const btn = $('workspaceBtn').getBoundingClientRect();
  menuEl.style.top = `${btn.bottom + 4}px`;
  menuEl.style.left = `${Math.max(8, btn.left)}px`;
  menuEl.classList.remove('hidden');
  $('workspaceBtn').setAttribute('aria-expanded', 'true');
}

$('workspaceBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  if (menuEl.classList.contains('hidden')) openMenu();
  else closeMenu();
});
menuEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const target = e.target.closest('button');
  if (!target) return;
  closeMenu();
  if (target.dataset.ws) setWorkspace(target.dataset.ws);
  else if (target.dataset.action === 'create') openOrgNew(false);
  else if (target.dataset.action === 'join') openOrgNew(true);
  else if (target.dataset.action === 'signin') $('cloudBtn').click();
});
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ---------------------------------------------------------------- create / join

const newDialog = $('orgNewDialog');
let joining = false;

function showNewError(text) {
  $('orgNewError').textContent = text || '';
  $('orgNewError').classList.toggle('hidden', !text);
}

function openOrgNew(join) {
  joining = join;
  $('orgNewTitle').textContent = join ? 'Join an organization' : 'New organization';
  $('orgNewIntro').textContent = join
    ? 'Ask an owner or admin of the organization for its invite code.'
    : "You'll be its owner. Invite people with its code, then create projects in it or move yours in.";
  $('orgNewLabel').textContent = join ? 'Invite code' : 'Name';
  const input = $('orgNewInput');
  input.value = '';
  input.placeholder = join ? 'ORG-XXXXXX' : 'e.g. Duckwave Studio';
  input.style.textTransform = join ? 'uppercase' : '';
  $('orgNewSubmit').textContent = join ? 'Join' : 'Create';
  showNewError('');
  newDialog.showModal();
  input.focus();
}

$('orgNewCancel').addEventListener('click', () => newDialog.close());
$('orgNewForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('orgNewInput').value.trim();
  if (!text) return showNewError(joining ? 'Type the invite code.' : 'An organization needs a name.');
  const submit = $('orgNewSubmit');
  submit.disabled = true;
  showNewError('');
  try {
    const id = joining ? await api.joinOrg(text) : await api.createOrg(text);
    await refresh();
    setWorkspace(id);
    newDialog.close();
  } catch (err) {
    showNewError(String(err));
  } finally {
    submit.disabled = false;
  }
});

// ---------------------------------------------------------------- organization dialog

const orgDialog = $('orgDialog');
let openOrgId = null;

function note(text) {
  $('orgNote').textContent = text || '';
}

/** Runs a server change from the dialog; a refusal is shown in it. */
async function orgAction(fn) {
  note('');
  try {
    await fn();
    await refresh();
    return true;
  } catch (err) {
    note(String(err));
    return false;
  }
}

/** What you may do to `m`, mirroring remove_org_member() and set_org_role() on the server. */
function canChangeRole(org, m) {
  return org.role === 'owner' && !m.is_me && m.role !== 'owner';
}
function canRemove(org, m) {
  if (m.is_me || m.role === 'owner') return false;
  return org.role === 'owner' || (org.role === 'admin' && m.role === 'member');
}

async function renderOrgDialog() {
  const org = state.orgs.find((o) => o.id === openOrgId);
  if (!org) {
    orgDialog.close();
    return;
  }
  const admin = isOrgAdmin(org);
  const members = await api.orgMembers(org.id);
  $('orgBadge').innerHTML = badge(org);
  $('orgTitle').textContent = org.name;
  $('orgSub').textContent = `${ROLE[org.role]} · ${people(members.length)}`;
  for (const id of ['orgNameField', 'orgRateField', 'orgRateHint', 'orgCurrencyField', 'orgCurrencyHint', 'orgWeekField', 'orgWeekHint', 'orgLogoField']) {
    $(id).classList.toggle('hidden', !admin);
  }
  if (admin && document.activeElement !== $('orgCurrency')) $('orgCurrency').value = org.currency || '';
  if (admin) $('orgWeek').value = org.week_start == null ? '' : String(org.week_start);
  if (admin && document.activeElement !== $('orgName')) $('orgName').value = org.name;
  if (admin && document.activeElement !== $('orgRate')) $('orgRate').value = org.default_rate > 0 ? org.default_rate : '';
  $('orgLogoPreview').innerHTML = org.logo_data ? badge(org) : '<span class="muted">None</span>';
  $('orgLogoBtn').textContent = org.logo_data ? 'Change' : 'Add';
  $('orgLogoRemove').classList.toggle('hidden', !org.logo_data);
  const showCode = admin && !!org.join_code;
  $('orgCodeField').classList.toggle('hidden', !showCode);
  $('orgCodeHint').classList.toggle('hidden', !showCode);
  $('orgCode').textContent = org.join_code || '';
  $('orgAddField').classList.toggle('hidden', !admin);
  $('orgLeave').textContent = org.role === 'owner' ? 'Delete organization' : 'Leave';

  $('orgPeople').innerHTML = members.map((m) => {
    const role = canChangeRole(org, m)
      ? `<select data-role="${escapeHtml(m.user_id)}" aria-label="Role of ${escapeHtml(m.display_name)}">
           ${['member', 'admin', 'owner'].map((r) => `<option value="${r}"${r === m.role ? ' selected' : ''}>${ROLE[r]}</option>`).join('')}
         </select>`
      : `<span class="org-role">${ROLE[m.role]}</span>`;
    const remove = canRemove(org, m)
      ? `<button type="button" class="icon-btn" data-remove="${escapeHtml(m.user_id)}" title="Remove ${escapeHtml(m.display_name)}">×</button>`
      : '<span class="org-remove-gap"></span>';
    return `<div class="org-person"><span class="org-person-name">${escapeHtml(m.display_name)}${m.is_me ? ' <span class="muted">(you)</span>' : ''}</span>${role}${remove}</div>`;
  }).join('');
  $('orgPeople').dataset.members = JSON.stringify(members.map((m) => [m.user_id, m.display_name]));
}

export function openOrgDialog(orgId) {
  openOrgId = orgId;
  note('');
  $('orgAddCode').value = '';
  renderOrgDialog().then(() => { if (!orgDialog.open) orgDialog.showModal(); });
}

const memberName = (userId) => new Map(JSON.parse($('orgPeople').dataset.members || '[]')).get(userId) || 'them';

$('orgClose').addEventListener('click', () => orgDialog.close());
$('orgName').addEventListener('change', async () => {
  const name = $('orgName').value.trim();
  if (!name) return renderOrgDialog();
  if (await orgAction(() => api.updateOrg(openOrgId, { name }))) renderOrgDialog();
});
$('orgRate').addEventListener('change', async () => {
  const v = parseFloat($('orgRate').value);
  const rate = Number.isFinite(v) && v > 0 ? v : null;
  if (await orgAction(() => api.updateOrg(openOrgId, { default_rate: rate }))) renderOrgDialog();
});
$('orgCurrency').addEventListener('change', async () => {
  const code = $('orgCurrency').value.replace(/[^a-z]/gi, '').toUpperCase();
  let known = !code;
  try { known ||= !!new Intl.NumberFormat(undefined, { style: 'currency', currency: code }); } catch { /* unknown code */ }
  if (!known || (code && code.length !== 3)) {
    note('A currency is a 3-letter code, like USD or EUR.');
    return;
  }
  if (await orgAction(() => api.updateOrg(openOrgId, { currency: code || null }))) renderOrgDialog();
});
$('orgWeek').addEventListener('change', async () => {
  const v = $('orgWeek').value;
  if (await orgAction(() => api.updateOrg(openOrgId, { week_start: v === '' ? null : Number(v) }))) renderOrgDialog();
});
$('orgLogoBtn').addEventListener('click', () => {
  $('orgLogoInput').value = '';
  $('orgLogoInput').click();
});
$('orgLogoInput').addEventListener('change', async () => {
  const file = $('orgLogoInput').files[0];
  if (!file) return;
  try {
    // 128 px, like project logos: well under the server's 60 KB limit.
    const data = await resizeImageToDataUrl(file, 128);
    if (await orgAction(() => api.updateOrg(openOrgId, { logo_data: data }))) renderOrgDialog();
  } catch (err) {
    note(String(err));
  }
});
$('orgLogoRemove').addEventListener('click', async () => {
  if (await orgAction(() => api.updateOrg(openOrgId, { logo_data: null }))) renderOrgDialog();
});
$('orgCopyCode').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText($('orgCode').textContent);
    e.target.textContent = 'Copied';
    setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
  } catch {
    window.getSelection().selectAllChildren($('orgCode'));
  }
});
$('orgResetCode').addEventListener('click', async () => {
  if (!confirm('Make a new invite code?\nThe current code stops working. People who already joined stay in.')) return;
  if (await orgAction(() => api.resetOrgJoinCode(openOrgId))) renderOrgDialog();
});
$('orgAddBtn').addEventListener('click', async () => {
  const code = $('orgAddCode').value.trim();
  if (!code) return;
  let name = '';
  if (await orgAction(async () => { name = await api.addOrgMember(openOrgId, code); })) {
    $('orgAddCode').value = '';
    await renderOrgDialog();
    note(`${name} joined.`);
  }
});
$('orgPeople').addEventListener('change', async (e) => {
  const select = e.target.closest('select[data-role]');
  if (!select) return;
  const userId = select.dataset.role;
  const role = select.value;
  if (role === 'owner' && !confirm(`Make ${memberName(userId)} the owner?\nYou'll become an admin. Only the owner can change roles or delete the organization.`)) {
    return renderOrgDialog();
  }
  await orgAction(() => api.setOrgRole(openOrgId, userId, role));
  renderOrgDialog();
});
$('orgPeople').addEventListener('click', async (e) => {
  const userId = e.target.closest('button[data-remove]')?.dataset.remove;
  if (!userId) return;
  if (!confirm(`Remove ${memberName(userId)}?\nThey leave the organization and its projects. The time they tracked stays, and projects they own there go to the organization's owner.`)) return;
  if (await orgAction(() => api.removeOrgMember(openOrgId, userId))) renderOrgDialog();
});
$('orgLeave').addEventListener('click', async () => {
  const org = state.orgs.find((o) => o.id === openOrgId);
  if (!org) return;
  let done;
  if (org.role === 'owner') {
    if (!confirm(`Delete ${org.name}?\nIts projects become personal projects of their owners, with the same members. Nothing is deleted from them.`)) return;
    done = await orgAction(() => api.deleteOrg(org.id));
  } else {
    if (!confirm(`Leave ${org.name}?\nYou'll leave its projects too. The time you tracked stays on them, and projects you own there go to the organization's owner.`)) return;
    const me = (await api.orgMembers(org.id)).find((m) => m.is_me);
    done = !!me && await orgAction(() => api.removeOrgMember(org.id, me.user_id));
  }
  if (done) {
    setWorkspace(PERSONAL);
    orgDialog.close();
  }
});

// ---------------------------------------------------------------- project dialog

/**
 * Fills the project dialog's Workspace field: every workspace for a new
 * project (starting with the one shown), and only the allowed moves for an
 * existing one. Hidden when there's nothing to choose.
 */
export function fillProjectWorkspace(project) {
  const options = project ? moveTargets(project, state.orgs) : [PERSONAL, ...state.orgs.map((o) => o.id)];
  const current = project ? project.org_id || PERSONAL : state.workspace;
  const select = $('projectOrg');
  select.innerHTML = options
    .map((id) => `<option value="${escapeHtml(id)}"${id === current ? ' selected' : ''}>${escapeHtml(workspaceName(id))}</option>`)
    .join('');
  const show = options.length > 1;
  $('projectOrgField').classList.toggle('hidden', !show);
  $('projectOrgHint').classList.toggle('hidden', !show);
  updateWorkspaceHint();
}

function updateWorkspaceHint() {
  $('projectOrgHint').textContent = $('projectOrg').value === PERSONAL
    ? 'Only you, and anyone you add to it.'
    : "The organization's owner and admins see it; members see it once added.";
}
$('projectOrg').addEventListener('change', updateWorkspaceHint);

/** The chosen workspace as an org id (null = personal). */
export function chosenOrg() {
  const v = $('projectOrg').value || PERSONAL;
  return v === PERSONAL ? null : v;
}

/** The rate a new project starts with in the chosen workspace (the organization's default, if it has one). */
export function startingRate() {
  return defaultRate($('projectOrg').value || PERSONAL, state.orgs, null);
}

/** Moves a project if its workspace was changed in the dialog. */
export function applyWorkspaceChange(project) {
  const orgId = chosenOrg();
  if ((project.org_id || null) === orgId) return Promise.resolve();
  return api.setProjectOrg(project.id, orgId);
}

