# TimeTrack — billable project time widget

A frameless, dark-mode desktop widget for tracking billable time per project.
Built with **Tauri 2 (Rust) + vanilla HTML/CSS/JS** — chosen over Electron
because a Tauri build ships a ~3-8 MB binary using the OS's native
WebView instead of bundling Chromium, so idle RAM usage sits around
30-50 MB versus 150-300 MB+ for an equivalent Electron app. Data is
stored in a bundled SQLite database (via `rusqlite`, no system libsqlite3
required), in WAL mode for crash safety.

## Project structure

```
timetrack/
├── package.json                  # frontend tooling (Tauri CLI)
├── src/                          # frontend (plain HTML/CSS/JS, no framework)
│   ├── index.html
│   ├── style.css
│   └── main.js
└── src-tauri/                    # Rust backend
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json           # window, bundle, and security config
    ├── capabilities/default.json # Tauri v2 permission grants
    ├── icons/                    # app icons (placeholders — see below)
    └── src/
        ├── main.rs               # commands, single-timer enforcement, sleep detection
        └── db.rs                 # SQLite schema + queries
```

## How the core requirements are implemented

- **Single active timer**: `start_project` in `main.rs` always calls
  `pause_all_running` before starting the requested project, so exactly one
  project can be `is_running` at a time — enforced server-side, not just in
  the UI.
- **Auto-save every 5-10s**: `main.js` calls the `checkpoint` command on a
  7s interval. The backend folds elapsed running time into `total_seconds`
  and writes a `time_entries` row, so a hard crash loses at most ~7s of work.
- **Idle/sleep handling**: there's no single cross-platform "system is
  sleeping" event without pulling in per-OS APIs (Win32
  `WM_POWERBROADCAST`, Linux `logind` D-Bus signals). Instead, `checkpoint`
  compares the wall-clock gap between heartbeats; a gap far larger than the
  7s tick (>30s) means the process was suspended, so the backend pauses the
  timer and excludes the sleep interval from billable time. If you need
  exact suspend/resume events, swap this heuristic for `windows-rs`'
  `RegisterPowerSettingNotification` on Windows and a `zbus` listener on
  `org.freedesktop.login1.Manager.PrepareForSleep` on Linux — the
  `checkpoint` command is the single integration point.
- **Crash/reboot persistence**: SQLite in WAL mode plus the closing-window
  handler in `main.rs` (`on_window_event` → `CloseRequested`) flush the
  running timer before the process exits.
- **Export**: `export_csv` / `export_json` commands build the report
  server-side; the frontend uses the `dialog` plugin's native save picker.

## Prerequisites

Both platforms need:
- [Node.js](https://nodejs.org) 18+
- [Rust](https://rustup.rs) (stable toolchain)

**Linux** additionally needs the WebView2-equivalent system packages:
```bash
# Debian/Ubuntu
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel
```

**Windows** additionally needs:
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  (Desktop development with C++ workload)
- WebView2 Runtime — preinstalled on Windows 11 and most Windows 10 updates;
  otherwise the [Evergreen bootstrapper](https://developer.microsoft.com/microsoft-edge/webview2/)

## Install & run (dev)

```bash
npm install
npm run tauri icon path/to/a-1024x1024-source.png   # replaces the placeholder icons
npm run dev
```

This launches the widget with hot-reload for `src/` and recompiles Rust on
backend changes.

## Building release packages

```bash
npm run build
```

This produces platform-native installers under `src-tauri/target/release/bundle/`:

| Platform | Output |
|---|---|
| Linux | `bundle/appimage/timetrack-widget_1.0.0_amd64.AppImage` |
| Linux | `bundle/deb/timetrack-widget_1.0.0_amd64.deb` |
| Windows | `bundle/msi/TimeTrack_1.0.0_x64_en-US.msi` |
| Windows | `bundle/nsis/TimeTrack_1.0.0_x64-setup.exe` |

Cross-compiling Windows installers from Linux (or vice versa) isn't
reliably supported by Tauri — build each target on its native OS, or use a
CI matrix (GitHub Actions `windows-latest` + `ubuntu-latest` runners) if you
need both from one pipeline.

### Linux notes
- `.deb` installs to `/usr/bin` and integrates with the system app menu.
- `.AppImage` is portable — no install step, just `chmod +x` and run. Works
  under both X11 and Wayland since the WebView backend (WebKitGTK) supports
  both; if you hit Wayland-specific rendering quirks, set
  `GDK_BACKEND=x11` as a fallback launch env var.

### Windows notes
- The `.msi` is best for enterprise/managed deployment (silent install via
  `msiexec /i TimeTrack.msi /quiet`).
- The NSIS `.exe` is a friendlier one-click installer for individual users
  and supports per-user (no admin prompt) installs via the
  `nsis.installMode: currentUser` setting already in `tauri.conf.json`.

## Data location

- Linux: `~/.local/share/com.timetrack.widget/timetrack.sqlite3`
- Windows: `%APPDATA%\com.timetrack.widget\timetrack.sqlite3`

## Extending

- **System tray**: `tray-icon` feature is already enabled in `Cargo.toml`
  and `tauri.conf.json`; add a `TrayIconBuilder` in `main.rs`'s `setup()` if
  you want minimize-to-tray instead of closing the app on the × button.
- **Notifications**: add `tauri-plugin-notification` to remind the user a
  timer's been running unusually long.
