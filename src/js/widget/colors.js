// Stable per-project colors for the widget's charts.
//
// A project keeps its palette slot for life (color follows the entity, not
// its rank). Slots of deleted or filed projects are recycled; with more than
// 8 projects the extras share the neutral "Other" color.
const COLOR_STORAGE_KEY = 'timetrack:project-colors';
const CAT_SLOTS = 8;

let colorSlots = {};
try { colorSlots = JSON.parse(localStorage.getItem(COLOR_STORAGE_KEY) || '{}') || {}; } catch { colorSlots = {}; }

export function ensureColorSlots(projects) {
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

/** Palette slot (0..7) or null for "Other". */
export function slotOf(projectId) {
  return colorSlots[projectId] ?? null;
}

export function colorVar(projectId) {
  const s = slotOf(projectId);
  return s == null ? 'var(--cat-other)' : `var(--cat-${s + 1})`;
}
