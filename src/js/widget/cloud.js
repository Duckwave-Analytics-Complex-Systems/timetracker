// Cloud sync settings: the "Cloud sync" entry in the settings panel and its
// dialog, including the warning before another account replaces this
// computer's data. Syncing itself runs in the backend (src-tauri/src/sync.rs); this
// only signs in/out and shows the status. Data that arrives from another
// device triggers a normal `data-changed` refresh (reason 'synced').
import { api } from '../core/api.js';
import { escapeHtml, fmtTime } from '../core/format.js';

const $ = (id) => document.getElementById(id);
const dialog = $('cloudDialog');
let status = null;

function render() {
  const s = status || {};
  const stateEl = $('cloudState');
  stateEl.textContent = !s.signed_in ? 'Off' : s.last_error ? 'Error' : 'On';
  stateEl.className = `cloud-state${s.signed_in ? (s.last_error ? ' error' : ' on') : ''}`;

  $('cloudSignedIn').classList.toggle('hidden', !s.signed_in);
  $('cloudSignedOut').classList.toggle('hidden', !!s.signed_in);
  if (s.signed_in) {
    const last = s.last_sync_at ? `Last synced at ${fmtTime(s.last_sync_at)}.` : 'Not synced yet.';
    $('cloudSummary').innerHTML =
      `Signed in as <b>${escapeHtml(s.email)}</b><br><span class="muted">${escapeHtml(s.url)}<br>${last}</span>`;
  }
  const err = $('cloudError');
  err.textContent = s.last_error || '';
  err.classList.toggle('hidden', !s.last_error);
}

export async function refreshCloud() {
  try {
    status = await api.cloudStatus();
    render();
  } catch (err) {
    console.error('cloud status failed', err);
  }
}

function showFormError(text) {
  const el = $('cloudFormError');
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

async function run(button, action) {
  button.disabled = true;
  try {
    status = await action();
    render();
    return true;
  } catch (err) {
    showFormError(String(err));
    return false;
  } finally {
    button.disabled = false;
  }
}

$('cloudBtn').addEventListener('click', () => {
  $('settingsPanel').classList.add('hidden');
  showFormError('');
  if (status?.url) $('cloudUrl').value ||= status.url;
  if (status?.linked_email) $('cloudEmail').value ||= status.linked_email;
  dialog.showModal();
});
$('cloudCancel').addEventListener('click', () => dialog.close());
$('cloudClose').addEventListener('click', () => dialog.close());

/**
 * Signing in as a different account than the one this computer's data
 * belongs to replaces that data (src-tauri/src/sync.rs `sign_in`), so ask.
 */
function confirmAccountSwitch(email) {
  const s = status || {};
  if (!s.linked) return true; // first link: local data is uploaded, nothing lost
  const same = s.linked_email && s.linked_email.trim().toLowerCase() === email.trim().toLowerCase();
  if (same) return true;
  const owner = s.linked_email ? `the account ${s.linked_email}` : 'the account used before';
  const unsynced = s.unsynced_changes
    ? `\n\n${s.unsynced_changes} change(s) made here were never uploaded and will be lost.`
    : '';
  return confirm(
    `The projects on this computer belong to ${owner}.\n\n` +
    `Signing in as ${email.trim()} removes them from this computer and downloads that account's projects instead. ` +
    `They stay safe in ${owner} and come back if you sign in with it again.${unsynced}\n\nContinue?`);
}

$('cloudForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showFormError('');
  if (!confirmAccountSwitch($('cloudEmail').value)) return;
  const ok = await run($('cloudSignIn'), () =>
    api.cloudSignIn({
      url: $('cloudUrl').value,
      anonKey: $('cloudKey').value,
      email: $('cloudEmail').value,
      password: $('cloudPassword').value,
    }));
  if (ok) $('cloudPassword').value = '';
});

$('cloudSyncNow').addEventListener('click', () => run($('cloudSyncNow'), api.cloudSyncNow));
$('cloudSignOut').addEventListener('click', () => run($('cloudSignOut'), api.cloudSignOut));

export function initCloud() {
  refreshCloud();
}
