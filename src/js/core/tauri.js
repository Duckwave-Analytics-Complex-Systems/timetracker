// The only file that touches window.__TAURI__.
//
// There is no bundler, so bare specifiers like `import '@tauri-apps/api'`
// cannot be resolved by the WebView and would break every module that
// imports them. `withGlobalTauri: true` (tauri.conf.json) exposes the same
// API on window.__TAURI__ instead. Relative imports between our own modules
// (`./api.js`) are plain ES modules and work fine.
const T = window.__TAURI__;

export const invoke = T.core.invoke;
export const listen = T.event.listen;
export const appWindow = T.window.getCurrentWindow();
export const saveDialog = T.dialog.save;
export const writeTextFile = T.fs.writeTextFile;
export const getAppVersion = () => T.app.getVersion().catch(() => '');
