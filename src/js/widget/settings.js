// Settings panel (top-left ☰): keep on top, CSV export, accent colors.
import { api } from '../core/api.js';
import { appWindow, saveDialog, writeTextFile } from '../core/tauri.js';
import { applyTheme, DEFAULT_THEME, readTheme, saveTheme } from '../core/theme.js';

const $ = (id) => document.getElementById(id);
const panel = $('settingsPanel');
const primaryInput = $('primaryColorInput');
const secondaryInput = $('secondaryColorInput');

$('settingsBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  panel.classList.toggle('hidden');
});
panel.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => panel.classList.add('hidden'));

$('pinToggle').addEventListener('change', (e) => appWindow.setAlwaysOnTop(e.target.checked));

function setTheme(theme, persist = true) {
  applyTheme(theme);
  primaryInput.value = theme.primary;
  secondaryInput.value = theme.secondary;
  if (persist) saveTheme(theme);
}
const fromInputs = () => ({ primary: primaryInput.value, secondary: secondaryInput.value });
primaryInput.addEventListener('input', () => setTheme(fromInputs()));
secondaryInput.addEventListener('input', () => setTheme(fromInputs()));
$('resetColorsBtn').addEventListener('click', () => setTheme({ ...DEFAULT_THEME }));

export function initSettings() {
  setTheme(readTheme(), false);
}

$('exportBtn').addEventListener('click', async () => {
  try {
    const contents = await api.exportCsv();
    const path = await saveDialog({
      defaultPath: 'timetrack-export.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (path) await writeTextFile(path, contents);
  } catch (err) {
    console.error('export failed', err);
  }
});
