// Add / edit dialog for a phase or milestone (markup in project.html).
import { api } from '../core/api.js';
import { addDays, dayKey, daysBetween, fmtHours, parseDay, startOfToday } from '../core/format.js';

const PALETTE_SLOTS = 8;
const DEFAULT_PHASE_DAYS = 14;

const $ = (id) => document.getElementById(id);
const dialog = $('phaseDialog');
const form = $('phaseForm');
const nameInput = $('phaseName');
const startInput = $('phaseStart');
const endInput = $('phaseEnd');
const estimateInput = $('phaseEstimate');
const progressInput = $('phaseProgress');
const reachedInput = $('phaseReached');
const errorEl = $('phaseError');

let editing = null; // { phase (or null for new), projectId }
let kind = 'phase';
let color = 0;

$('phaseColors').innerHTML = Array.from({ length: PALETTE_SLOTS }, (_, i) =>
  `<button type="button" class="swatch" data-color="${i}" style="background:var(--cat-${i + 1})" aria-label="Color ${i + 1}"></button>`).join('');

function setKind(k) {
  kind = k;
  const ms = k === 'milestone';
  $('phaseKind').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === k)));
  $('phaseStartLabel').textContent = ms ? 'Date' : 'Start';
  $('phaseEndField').classList.toggle('hidden', ms);
  $('phaseWorkFields').classList.toggle('hidden', ms);
  $('phaseProgressField').classList.toggle('hidden', ms);
  $('phaseReachedField').classList.toggle('hidden', !ms);
  updateHints();
}

function setColor(c) {
  color = c;
  $('phaseColors').querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.color) === c)));
}

function updateHints() {
  $('phaseProgressOut').textContent = `${progressInput.value}%`;
  const s = parseDay(startInput.value), e = parseDay(endInput.value);
  $('phaseDuration').textContent = kind === 'phase' && s && e && e >= s ? `${daysBetween(s, e) + 1} days` : '';
}

$('phaseKind').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-kind]');
  if (b) setKind(b.dataset.kind);
});
$('phaseColors').addEventListener('click', (e) => {
  const b = e.target.closest('.swatch');
  if (b) setColor(Number(b.dataset.color));
});
progressInput.addEventListener('input', updateHints);
startInput.addEventListener('change', () => {
  // Keep the end on or after the start.
  if (endInput.value && startInput.value > endInput.value) endInput.value = startInput.value;
  updateHints();
});
endInput.addEventListener('change', updateHints);
$('phaseCancel').addEventListener('click', () => dialog.close());

/** Sensible defaults for a new item: right after the last phase, next color. */
function newPhaseDefaults(project, phases, k) {
  const lastEnd = phases.reduce((m, p) => (p.end_day > m ? p.end_day : m), '');
  const start = lastEnd ? addDays(parseDay(lastEnd), 1) : parseDay(project.start_day) || startOfToday();
  const used = new Set(phases.map((p) => p.color));
  const free = Array.from({ length: PALETTE_SLOTS }, (_, i) => i).find((i) => !used.has(i));
  return {
    name: '',
    kind: k,
    color: free ?? phases.length % PALETTE_SLOTS,
    start_day: dayKey(start),
    end_day: dayKey(k === 'milestone' ? start : addDays(start, DEFAULT_PHASE_DAYS - 1)),
    estimated_hours: 0,
    progress: 0,
    spent_seconds: 0,
  };
}

/**
 * Opens the dialog. `phase` = existing phase row to edit, or null to add a
 * new one of kind `newKind`.
 */
export function openPhaseDialog({ project, phases, phase = null, newKind = 'phase' }) {
  const p = phase || newPhaseDefaults(project, phases, newKind);
  editing = { phase, projectId: project.id };
  $('phaseDialogTitle').textContent = phase ? `Edit ${p.kind === 'milestone' ? 'milestone' : 'phase'}` : `New ${newKind}`;
  nameInput.value = p.name;
  startInput.value = p.start_day;
  endInput.value = p.end_day;
  estimateInput.value = p.estimated_hours || '';
  progressInput.value = p.progress;
  reachedInput.checked = p.progress >= 100;
  $('phaseSpent').textContent = fmtHours((p.spent_seconds || 0) / 3600);
  $('phaseDelete').classList.toggle('hidden', !phase);
  errorEl.classList.add('hidden');
  setKind(p.kind);
  setColor(p.color);
  dialog.showModal();
  nameInput.focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ms = kind === 'milestone';
  const input = {
    id: editing.phase?.id ?? null,
    project_id: editing.projectId,
    name: nameInput.value,
    kind,
    color,
    start_day: startInput.value,
    end_day: ms ? startInput.value : endInput.value,
    estimated_hours: ms ? 0 : parseFloat(estimateInput.value) || 0,
    progress: ms ? (reachedInput.checked ? 100 : 0) : parseInt(progressInput.value, 10) || 0,
  };
  try {
    await api.savePhase(input); // the backend validates and normalises
    dialog.close();
  } catch (err) {
    errorEl.textContent = String(err);
    errorEl.classList.remove('hidden');
  }
});

$('phaseDelete').addEventListener('click', async () => {
  const p = editing.phase;
  const keep = p.spent_seconds > 0 ? `\nIts ${fmtHours(p.spent_seconds / 3600)} of tracked time stay on the project as "unassigned".` : '';
  if (!confirm(`Delete "${p.name}"?${keep}`)) return;
  try {
    await api.deletePhase(p.id);
    dialog.close();
  } catch (err) {
    errorEl.textContent = String(err);
    errorEl.classList.remove('hidden');
  }
});
