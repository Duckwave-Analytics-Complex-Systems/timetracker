// "A new version is available" bar, and Settings → Check for updates.
//
// The backend reads the public version.json (src-tauri/src/updates.rs). We
// check at start and every few hours. "Later" hides the bar for that version
// for a day; a required update (cloud sync stopped) comes back on every start.
// Offline or a broken manifest: stay quiet, except when the user asked.
import { api } from '../core/api.js';
import { escapeHtml } from '../core/format.js';
import { getAppVersion } from '../core/tauri.js';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const SNOOZE_MS = 24 * 60 * 60 * 1000;
const SNOOZE_KEY = 'timetrack.updateSnooze'; // { version, until }

const $ = (id) => document.getElementById(id);
const bar = $('updateBar');
let latest = null; // last result with available || required

function snoozed(info) {
  if (info.required) return false;
  try {
    const s = JSON.parse(localStorage.getItem(SNOOZE_KEY) || 'null');
    return s && s.version === info.latest && Date.now() < s.until;
  } catch {
    return false;
  }
}

function render(info) {
  latest = info;
  const text = info.required
    ? `Update required: cloud sync is paused until you install <b>TimeTrack ${escapeHtml(info.latest)}</b>.`
    : `<b>TimeTrack ${escapeHtml(info.latest)}</b> is available. You have ${escapeHtml(info.current)}.`;
  $('updateText').innerHTML = text;
  bar.classList.toggle('required', info.required);
  $('updateNotes').textContent = info.notes || '';
  $('updateNotesBtn').classList.toggle('hidden', !info.notes);
  $('updateNotes').classList.add('hidden');
  $('updateNotesBtn').setAttribute('aria-expanded', 'false');
  bar.classList.toggle('hidden', snoozed(info));
}

function setStatus(text) {
  const el = $('updateCheckStatus');
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}

/** manual: the user pressed "Check for updates", so report every outcome. */
async function check(manual = false) {
  if (manual) setStatus('Checking…');
  try {
    const info = await api.checkForUpdate();
    if (info.available || info.required) {
      if (manual) localStorage.removeItem(SNOOZE_KEY); // they asked: show it
      render(info);
      if (manual) setStatus(`Version ${info.latest} is available.`);
    } else {
      bar.classList.add('hidden');
      if (manual) setStatus("You're on the latest version.");
    }
  } catch (err) {
    console.warn('update check failed', err);
    if (manual) setStatus(String(err));
  }
}

$('updateDownloadBtn').addEventListener('click', () =>
  api.openUpdateDownload().catch((err) => setStatus(String(err))));

$('updateLaterBtn').addEventListener('click', () => {
  bar.classList.add('hidden');
  if (latest && !latest.required) {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify({ version: latest.latest, until: Date.now() + SNOOZE_MS }));
  }
});

$('updateNotesBtn').addEventListener('click', () => {
  const open = $('updateNotes').classList.toggle('hidden') === false;
  $('updateNotesBtn').setAttribute('aria-expanded', String(open));
});

$('checkUpdateBtn').addEventListener('click', () => check(true));

export function initUpdates() {
  getAppVersion().then((v) => { $('appVersion').textContent = v; });
  check();
  setInterval(check, CHECK_EVERY_MS);
}
