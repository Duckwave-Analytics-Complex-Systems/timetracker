// Session notes: the optional "what did you do?" dialog, used by both windows.
//
// The timer changes first and the dialog comes after, so the time is already
// booked and cancelling can't lose it. The dialog is built here because both
// pages need the same one.
import { api } from './api.js';
import { fmtDate, fmtHM, fmtTime } from './format.js';

const PROMPT_KEY = 'timetrack:note-prompt';
const NOTE_MAX_LENGTH = 2000;

/** When to ask: 'off' | 'stop' | 'both'. */
export function notePrompt() {
  try {
    return localStorage.getItem(PROMPT_KEY) || 'off';
  } catch {
    return 'off';
  }
}

export function setNotePrompt(value) {
  try { localStorage.setItem(PROMPT_KEY, value); } catch { /* ignore */ }
}

let dialog = null;

function noteDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'dialog';
  dialog.innerHTML = `
    <form method="dialog">
      <h2 data-title></h2>
      <p class="field-hint" data-hint></p>
      <label class="field"><span data-label></span><textarea rows="4" maxlength="${NOTE_MAX_LENGTH}"></textarea></label>
      <div class="dialog-actions">
        <button type="button" class="btn-secondary" data-skip></button>
        <button type="submit" class="btn-primary" value="save">Save</button>
      </div>
    </form>`;
  dialog.querySelector('[data-skip]').addEventListener('click', () => dialog.close(''));
  document.body.append(dialog);
  return dialog;
}

/** Resolves to the text, or null if the user didn't save. */
function askNote({ title, hint, note, label = 'What was done', skipLabel = 'Skip' }) {
  const d = noteDialog();
  const text = d.querySelector('textarea');
  d.querySelector('[data-title]').textContent = title;
  d.querySelector('[data-hint]').textContent = hint;
  d.querySelector('[data-label]').textContent = label;
  d.querySelector('[data-skip]').textContent = skipLabel;
  text.value = note ?? '';
  d.returnValue = '';
  d.showModal();
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'save' ? text.value : null), { once: true });
  });
}

/**
 * Starts or pauses `p`, then asks for notes if the setting says so. `run` wraps
 * the timer action, so each window handles errors and refreshing in its own way.
 */
export async function toggleTimer(p, run) {
  const starting = !p.is_running;
  let closed = null; // stays null if the action failed
  await run(async () => {
    closed = await (starting ? api.start(p.id) : api.pause());
  });
  const mode = notePrompt();
  if (!closed || mode === 'off') return;
  try {
    for (const s of closed) {
      const note = await askNote({ title: 'Session stopped', hint: `${s.project_name} · ${fmtHM(s.seconds)} booked`, note: s.note });
      if (note !== null) await api.setEntryNote(s.entry_id, note);
    }
    if (starting && mode === 'both') {
      const note = await askNote({ title: 'Session started', label: 'What are you working on', hint: `${p.name} · the timer is running. You can change this note when it stops.` });
      if (note !== null) await api.setRunNote(p.id, note);
    }
  } catch (err) {
    alert(`The note wasn't saved: ${err}`);
  }
}

/** Adds or edits the note of a closed session, from the History tab. */
export async function editNote(session) {
  const note = await askNote({
    title: session.note ? 'Edit note' : 'Add note',
    hint: `${fmtDate(new Date(session.start_ts))}, ${fmtTime(session.start_ts)} · ${fmtHM(session.seconds)}`,
    note: session.note,
    skipLabel: 'Cancel',
  });
  if (note !== null) await api.setEntryNote(session.id, note);
}
