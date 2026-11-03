// Add / edit dialog for a feature (markup in project.html).
import { api } from '../core/api.js';
import { fmtHours } from '../core/format.js';

const PALETTE_SLOTS = 8;

const $ = (id) => document.getElementById(id);
const dialog = $('featureDialog');
const nameInput = $('featureName');
const errorEl = $('featureError');

let editing = null; // { feature (or null for new), projectId }
let color = 0;

$('featureColors').innerHTML = Array.from({ length: PALETTE_SLOTS }, (_, i) =>
  `<button type="button" class="swatch" data-color="${i}" style="background:var(--cat-${i + 1})" aria-label="Color ${i + 1}"></button>`).join('');

function setColor(c) {
  color = c;
  $('featureColors').querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.color) === c)));
}

function showError(err) {
  errorEl.textContent = String(err);
  errorEl.classList.remove('hidden');
}

$('featureColors').addEventListener('click', (e) => {
  const b = e.target.closest('.swatch');
  if (b) setColor(Number(b.dataset.color));
});
$('featureCancel').addEventListener('click', () => dialog.close());

/** The first unused color, or the next one around the palette. */
function nextColor(features) {
  const used = new Set(features.map((f) => f.color));
  const free = Array.from({ length: PALETTE_SLOTS }, (_, i) => i).find((i) => !used.has(i));
  return free ?? features.length % PALETTE_SLOTS;
}

/** Opens the dialog. `feature` = existing row to edit, or null to add a new one. */
export function openFeatureDialog({ project, features, feature = null }) {
  editing = { feature, projectId: project.id };
  $('featureDialogTitle').textContent = feature ? 'Edit feature' : 'New feature';
  nameInput.value = feature?.name ?? '';
  $('featureSpent').textContent = fmtHours((feature?.spent_seconds || 0) / 3600);
  $('featureDelete').classList.toggle('hidden', !feature);
  errorEl.classList.add('hidden');
  setColor(feature ? feature.color : nextColor(features));
  dialog.showModal();
  nameInput.focus();
}

$('featureForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api.saveFeature({ // the backend validates and normalises
      id: editing.feature?.id ?? null,
      project_id: editing.projectId,
      name: nameInput.value,
      color,
    });
    dialog.close();
  } catch (err) {
    showError(err);
  }
});

$('featureDelete').addEventListener('click', async () => {
  const f = editing.feature;
  const keep = f.spent_seconds > 0 ? `\nIts ${fmtHours(f.spent_seconds / 3600)} of tracked time stay on the project as "unassigned".` : '';
  if (!confirm(`Delete "${f.name}"?${keep}`)) return;
  try {
    await api.deleteFeature(f.id);
    dialog.close();
  } catch (err) {
    showError(err);
  }
});
