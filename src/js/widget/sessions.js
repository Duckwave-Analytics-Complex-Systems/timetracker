// Shared sessions in the widget: start a project's timer with others in it
// (or share the one running, or add people), and the question when you're
// asked to join one while tracking something else. Each person tracks the
// session under their own name; the server keeps it (supabase/schema.sql,
// "shared sessions"). The Android app has the same (src/ui/session-card.js,
// src/app/session-invite.js); the rules both follow are in core/sessions.js.
import { api } from '../core/api.js';
import { escapeHtml } from '../core/format.js';
import { addableToSession, companions, namesText, pendingInvites, sessionOf } from '../core/sessions.js';
import { appWindow } from '../core/tauri.js';
import { act, refresh, state } from './store.js';

const $ = (id) => document.getElementById(id);
const pickDialog = $('sessionDialog');
const inviteDialog = $('inviteDialog');
const answered = new Set(); // questions shown or answered this run: not asked again
let picking = null; // the project being shared
let asking = null; // the session asked about

/** "With Ana and Bren" for a project's session, or ''. */
export function sessionLine(projectId) {
  const names = companions(sessionOf(projectId, state.sessions), state.me);
  return names.length ? `With ${namesText(names)}` : '';
}

/** What the card menu offers for a project, or null (not shared with anyone). */
export function sessionAction(p) {
  if (!p.shared || p.archived) return null;
  if (!p.is_running) return { action: 'session', label: 'Start with…' };
  return { action: 'session', label: sessionOf(p.id, state.sessions) ? 'Add to session…' : 'Share session…' };
}

function showError(id, text) {
  $(id).textContent = text || '';
  $(id).classList.toggle('hidden', !text);
}

// ---------------------------------------------------------------- picking people

export async function openSessionPicker(p) {
  picking = p;
  showError('sessionError', '');
  $('sessionTitle').textContent = p.is_running ? `Share ${p.name}` : `Start ${p.name} with…`;
  const { members } = await api.projectDetail(p.id);
  const people = addableToSession(members.filter((m) => m.user_id), sessionOf(p.id, state.sessions), state.me);
  $('sessionPeople').innerHTML = people.length
    ? people.map((m) => `
        <label class="check-row"><input type="checkbox" value="${escapeHtml(m.user_id)}" /> ${escapeHtml(m.display_name)}</label>`).join('')
    : '<p class="field-hint">Everyone in this project is already in it.</p>';
  $('sessionSubmit').disabled = !people.length;
  $('sessionSubmit').textContent = p.is_running ? 'Add' : 'Start';
  pickDialog.showModal();
}

$('sessionCancel').addEventListener('click', () => pickDialog.close());
$('sessionForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ids = [...$('sessionPeople').querySelectorAll('input:checked')].map((i) => i.value);
  if (!ids.length || !picking) return showError('sessionError', 'Pick at least one person.');
  const submit = $('sessionSubmit');
  submit.disabled = true;
  showError('sessionError', '');
  try {
    if (!picking.is_running) await api.start(picking.id);
    await api.shareSession(picking.id, ids);
    await refresh();
    pickDialog.close();
  } catch (err) {
    showError('sessionError', String(err));
  } finally {
    submit.disabled = false;
  }
});

// ---------------------------------------------------------------- being asked

/**
 * After every refresh: a question not answered yet opens the dialog, and the
 * window asks for attention (the taskbar button flashes) without taking the
 * focus from what you're doing.
 */
export function checkInvites() {
  if (inviteDialog.open) return;
  const [next] = pendingInvites(state.sessions, answered);
  if (!next) return;
  asking = next;
  answered.add(next.id);
  const running = state.projects.find((p) => p.is_running);
  const others = companions(next, state.me).filter((n) => n !== next.host_name);
  $('inviteText').innerHTML = `<b>${escapeHtml(next.host_name)}</b> started a session on <b>${escapeHtml(next.project_name)}</b>`
    + `${others.length ? ` with ${escapeHtml(namesText(others))}` : ''}. Join it?`;
  $('inviteStops').textContent = running ? `${running.name} stops now and its time is saved.` : '';
  showError('inviteError', '');
  inviteDialog.showModal();
  $('inviteYes').focus();
  appWindow.unminimize?.().catch(() => {});
  appWindow.requestUserAttention?.(2).catch(() => {}); // 2 = informational: flash, don't steal focus
}

async function answer(fn) {
  $('inviteYes').disabled = true;
  $('inviteNo').disabled = true;
  showError('inviteError', '');
  try {
    await fn();
    inviteDialog.close();
  } catch (err) {
    showError('inviteError', String(err));
  } finally {
    $('inviteYes').disabled = false;
    $('inviteNo').disabled = false;
  }
}

$('inviteForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!asking) return;
  const id = asking.id;
  answer(async () => {
    const at = Date.now();
    if (state.projects.some((p) => p.is_running)) await api.pause(); // books what you were tracking
    await api.joinSession(id, at);
    await act(() => Promise.resolve());
  });
});
$('inviteNo').addEventListener('click', () => {
  if (!asking) return;
  const id = asking.id;
  answer(async () => {
    await api.declineSession(id);
    await act(() => Promise.resolve());
  });
});
