// User accent colors, shared by every window. Stored in localStorage, which
// all windows share (same origin), and applied as CSS custom properties.
const THEME_STORAGE_KEY = 'timetrack:theme';
export const DEFAULT_THEME = { primary: '#5ee6c4', secondary: '#e8b34d' };

export function readTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) || 'null');
    return { primary: saved?.primary || DEFAULT_THEME.primary, secondary: saved?.secondary || DEFAULT_THEME.secondary };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

export function applyTheme({ primary, secondary }) {
  document.documentElement.style.setProperty('--accent-running', primary);
  document.documentElement.style.setProperty('--accent-earnings', secondary);
}

export function saveTheme(theme) {
  try { localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme)); } catch { /* ignore */ }
}

/** Applies the saved theme now, and again whenever another window changes it. */
export function useSharedTheme() {
  applyTheme(readTheme());
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_STORAGE_KEY) applyTheme(readTheme());
  });
}
