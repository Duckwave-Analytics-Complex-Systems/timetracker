// Custom titlebar shared by every (frameless) window.
//
// Dragging calls startDragging() on mousedown. The declarative
// `data-tauri-drag-region` attribute is unreliable under WebKitGTK (X11 and
// Wayland), so it is not used. Interactive elements inside the titlebar must
// match NO_DRAG so clicking them doesn't start a drag.
import { appWindow } from './tauri.js';

const NO_DRAG = 'button, input, select, textarea, a, .settings-panel, .no-drag';

export function setupTitlebar(titlebar, { onClose } = {}) {
  const btn = (sel) => titlebar.querySelector(sel);
  btn('[data-window="close"]')?.addEventListener('click', () => (onClose ? onClose() : appWindow.close()));
  btn('[data-window="minimize"]')?.addEventListener('click', () => appWindow.minimize());
  btn('[data-window="maximize"]')?.addEventListener('click', () => appWindow.toggleMaximize());

  titlebar.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(NO_DRAG)) return;
    appWindow.startDragging();
  });
  titlebar.addEventListener('dblclick', (e) => {
    if (!e.target.closest(NO_DRAG)) appWindow.toggleMaximize();
  });
}
