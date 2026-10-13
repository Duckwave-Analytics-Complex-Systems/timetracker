# TimeTrack — billable project time widget
## Developed By

Duckwave Physics Inspired, Modeling and Analytics

Co-authors: @pplalo (GitHub)

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
├── src/                          # frontend: plain HTML/CSS + native ES modules, no build step
│   ├── index.html                # the widget
│   ├── project.html              # one window per project (Overview / Schedule / Report)
│   ├── css/                      # base.css (shared), widget.css, project.css
│   └── js/
│       ├── core/                 # Tauri bridge, API, formatting, time model, charts, theme
│       ├── widget/               # projects list, Stats, Archive, settings
│       └── project/              # metrics, Gantt, phase editor, overview, report
└── src-tauri/                    # Rust backend
    ├── Cargo.toml
    ├── tauri.conf.json           # window, bundle, and security config
    ├── capabilities/default.json # Tauri v2 permission grants
    ├── icons/
    └── src/
        ├── main.rs               # app setup, window/exit events
        ├── commands.rs           # everything the frontend can call
        ├── events.rs             # "data-changed" event that keeps windows in sync
        ├── watchdog.rs           # sleep detection + liveness stamp
        ├── shutdown.rs           # pausing the timer however the app ends
        └── db/                   # SQLite schema, migrations, queries, tests
```

## How the core requirements are implemented

- **Single active timer**: `Db::start_project` pauses whatever is running and
  starts the new project in one transaction, so it's enforced server-side.
- **Saving**: a running timer is just a start timestamp. Its time is written
  once, when the session closes (pause, switch, sleep, exit). While it runs, a
  background thread writes one small "still alive" timestamp every 30 s. There
  are no per-tick rows any more.
- **Never billing time the app was closed**: closing the widget, quitting, and
  (on Linux) logout/shutdown/`kill` signals all pause the timer. If the app
  dies some other way (crash, power loss, Windows shutdown), the next launch
  stops the timer at the last "still alive" stamp and tells you so.
- **Idle/sleep handling**: the backend thread compares wall-clock time between
  its 5 s ticks. A gap over 30 s means the machine was suspended, so the timer
  is paused as of the last tick and the sleep isn't billed. Real OS events
  (Win32 `WM_POWERBROADCAST`, logind `PrepareForSleep`) can be plugged into
  `watchdog.rs`.
- **Export**: `export_csv` builds the per-project CSV, and the project window
  exports a self-contained HTML progress report. Both use the native save dialog.

## v5.0.0: projects, schedules and reports

- **Filing (archive).** "File (archive)" in a project's ⋯ menu removes it from
  the list and Stats but keeps all its history. The new **Archive** tab lists
  filed projects: open, restore or delete them.
- **Project window.** Click a project's name (or ⋯ → Open project) to open
  its own window:
  - **Overview**: health (On track / At risk / Behind / Completed) with the
    reasons, key figures, work-vs-time-vs-budget bars, hours per phase,
    hours per week, and cumulative hours against the plan.
  - **Schedule**: start/due dates, hour budget, description, and a colored
    Gantt chart (days/weeks/months zoom) of phases and milestones. Drag bars
    to move them, drag edges to change dates, click to edit name, color,
    dates, estimated hours and progress %.
  - **Report**: a light, printable progress report (summary, key figures,
    progress, schedule, hours by phase, charts, forecast, billing, next 30
    days, your notes) exported as a single HTML file you can open anywhere
    or print to PDF.
- **Hours per phase.** Pick the phase you're working on ("Booking to" in the
  project window). Tracked time is booked to that phase, and switching phase
  mid-session splits it cleanly. The widget card shows the active phase.
- **Fix: timer kept counting after the app was shut down.** See "Never
  billing time the app was closed" above.
- **Fix: 7-second autosave.** Replaced by session-based saving plus a 30 s
  liveness stamp. Upgrading merges the old per-tick rows into one row per
  session (totals unchanged).
- **Fix: false sleep pauses.** Sleep detection now runs in the backend, not
  in a WebView timer that is throttled when the window is minimized.

## v4.0.0: daily hours and Stats

- **Per-day ledger.** Every autosave tick and every pause also adds the
  tracked seconds to a `daily_totals` table (one row per local day per
  project). A session that crosses midnight is split at local midnight, so
  23:50 -> 00:20 counts 10 minutes to the first day and 20 to the next.
  Databases from v1-v3 are backfilled once from their existing session rows
  on first launch (`PRAGMA user_version` guards against doing it twice).
- **Today strip** (top of the Projects tab): hours so far today, split by
  project. Clicking it opens Stats.
- **Stats tab**: 7 days / 30 days / 12 weeks, summary tiles (total, average
  per active day, best day, billed), a stacked chart per day (per week for
  12 weeks), a detail panel for the selected day, and a per-project
  breakdown. Hover for a tooltip; click or press Enter on a column to select it.
- **Colors.** Each project keeps a fixed color slot (8 validated categorical
  colors); a 9th+ project is shown as "Other".
- **Billed** in Stats uses each project's *current* rate and people count.
- **Reset time** on a project also clears that project's daily history.
- **Autosave fix.** Checkpoints used to advance the run start to "now",
  dropping the sub-second remainder every ~7s (a few percent under-count on
  long sessions). They now advance by exactly the whole seconds banked.

Run the backend tests with `cd src-tauri && cargo test`.

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
| Linux | `bundle/appimage/timetrack-widget_5.0.0_amd64.AppImage` |
| Linux | `bundle/deb/timetrack-widget_5.0.0_amd64.deb` |
| Windows | `bundle/msi/TimeTrack_5.0.0_x64_en-US.msi` |
| Windows | `bundle/nsis/TimeTrack_5.0.0_x64-setup.exe` |

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
