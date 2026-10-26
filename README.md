# TimeTrack — billable project time widget

Developed by **Duckwave Physics Inspired, Modeling and Analytics**.
Co-author: [@pplalo](https://github.com/pplalo).

A frameless, dark-mode desktop widget for tracking billable time per project,
with a window per project for its schedule (Gantt), hours per phase and a
printable progress report. Optional cloud sync keeps several computers, and
the companion Android app, in step.

Built with **Tauri 2 (Rust) + vanilla HTML/CSS/JS**. We chose it over Electron
because a Tauri build ships a ~3–8 MB binary that uses the OS's own WebView
instead of bundling Chromium. Idle memory use is around 30–50 MB, against
150–300 MB+ for an equivalent Electron app. Data lives in a bundled SQLite
database (via `rusqlite`, no system libsqlite3 needed), in WAL mode for crash
safety.

## Features

- **One-click timers** per project, with live time and earnings (hours ×
  rate × people). Only one timer runs at a time.
- **Today strip and Stats**: hours today, then 7 days / 30 days / 12 weeks
  with totals, averages, best day, billed amount and a per-project breakdown.
- **Project window**: Overview (health, key figures, hours per phase and
  week), Schedule (Gantt of phases and milestones), and Report (a printable,
  self-contained HTML progress report).
- **Hours per phase**: time is booked to the phase you pick.
- **Archive**: file finished projects without losing their history.
- **Honest time**: sleep and time while the app is closed are never billed.
- **CSV export** of every project's time and bill.
- **Cloud sync (optional)** through your own Supabase project. See
  [Cloud sync](#cloud-sync).

## Prerequisites

Both platforms need:
- [Node.js](https://nodejs.org) 18+
- [Rust](https://rustup.rs) (stable toolchain)

**Linux** also needs the WebKitGTK development packages:
```bash
# Debian/Ubuntu
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install -y webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel
```

**Windows** also needs:
- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  (the "Desktop development with C++" workload)
- WebView2 Runtime: preinstalled on Windows 11 and most Windows 10 updates,
  otherwise install it with the [Evergreen bootstrapper](https://developer.microsoft.com/microsoft-edge/webview2/)

## Install & run (dev)

```bash
npm install
npm run dev
```

This launches the widget, reloads `src/` on change and recompiles Rust when
the backend changes.

To use your own icon, run `npm run tauri icon path/to/a-1024x1024-source.png`.

Backend tests: `cd src-tauri && cargo test`.

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

Tauri doesn't reliably cross-compile Windows installers from Linux (or the
other way around). Build each target on its own OS, or use a CI matrix
(GitHub Actions `windows-latest` + `ubuntu-latest`).

### Linux notes
- The `.deb` installs to `/usr/bin` and adds TimeTrack to the app menu.
- The `.AppImage` is portable: `chmod +x` it and run it. It works under X11
  and Wayland. If you hit Wayland-specific rendering problems, launch with
  `GDK_BACKEND=x11`.

### Windows notes
- The `.msi` suits managed deployment (silent install:
  `msiexec /i TimeTrack.msi /quiet`).
- The NSIS `.exe` is a one-click installer that installs per user, with no
  admin prompt (`nsis.installMode: currentUser` in `tauri.conf.json`).

## Data location

- Linux: `~/.local/share/com.timetrack.widget/timetrack.sqlite3`
- Windows: `%APPDATA%\com.timetrack.widget\timetrack.sqlite3`

Everything is local unless you turn on cloud sync. When sync is on, the same
file also holds the sync session token (never your password).

## Cloud sync

Sync is optional. Until you sign in, TimeTrack works entirely offline, exactly
as before. Once signed in, every computer, and the companion Android app,
using the same account shares the same projects.

- **What syncs.** Projects (name, rate, people, filed state, plan fields),
  phases, and every tracked session. Each device rebuilds its totals and
  per-day hours from the sessions, so all devices agree.
- **One timer across devices.** Starting a project on one device stops the
  timer running on any other. If two devices start a timer while offline,
  the later start wins. The earlier session is saved up to the moment the
  later one began.
- **Each device stops only its own timer.** Closing the desktop app (or the
  computer sleeping) stops only a timer started on that computer. A timer
  started elsewhere keeps running, and its card says so.
- **Offline first.** Changes made without a connection are queued and sent
  when it returns. Sync runs every 20 s and shortly after each change.
- **Private by design.** You host the data in your own Supabase project.
  Every table has row-level security, so each account sees only its own rows.

### Setting up sync

1. Create a free project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run [supabase/schema.sql](supabase/schema.sql).
3. In **Authentication → Users**, add a user (email + password) for each
   person. If nobody else should be able to create an account, turn off
   "Allow new users to sign up" under **Authentication → Sign In / Providers**.
4. In **Project Settings → API**, copy the project URL and the `anon` public
   key. Both are safe to share. Never use the `service_role` key in an app.
5. In TimeTrack, open **Settings ☰ → Cloud sync** and enter the URL, the key,
   your email and your password.

### Accounts and devices

All data belongs to an account, not to a computer:

- **First sign-in on a device**: what's already on it is uploaded.
- **Same account again**: sync resumes, and changes made while signed out
  are sent.
- **A different account**: TimeTrack asks first, then replaces the projects
  on that device with the new account's. Nothing is deleted from the cloud,
  and the previous account's projects come back when you sign in with it
  again.
- **Signing out** syncs one last time and keeps the data on the device.

## How it works

- **Single active timer**: `Db::start_project` pauses whatever is running and
  starts the new project in one transaction. With sync, the server's
  `push_timer()` function enforces the same rule across devices.
- **Saving**: a running timer is just a start timestamp. Its time is written
  once, when the session closes (pause, switch, sleep, exit). While it runs, a
  background thread writes a small "still alive" timestamp every 30 s.
- **Never billing time the app was closed**: closing the widget, quitting, and
  (on Linux) logout, shutdown and `kill` signals all pause the timer. If the
  app dies some other way (crash, power loss, Windows shutdown), the next
  launch stops the timer at the last "still alive" stamp and tells you so.
- **Idle/sleep handling**: the backend thread compares wall-clock time between
  its 5 s ticks. A gap over 30 s means the machine was suspended, so the timer
  is paused as of the last tick and the sleep isn't billed. Real OS events
  (Win32 `WM_POWERBROADCAST`, logind `PrepareForSleep`) can be plugged into
  `watchdog.rs`.
- **Sync**: database triggers record every local change in an outbox, and a
  background thread pushes it to Supabase and pulls changes from other
  devices. Each tracked session has the same id on every device, so a
  session closed on two devices is still saved once.
- **Export**: `export_csv` builds the per-project CSV, and the project window
  exports a self-contained HTML progress report. Both use the native save
  dialog.

## Project structure

```
timetrack/
├── package.json                  # frontend tooling (Tauri CLI)
├── supabase/schema.sql           # cloud sync: tables, security rules, timer function
├── src/                          # frontend: plain HTML/CSS + native ES modules, no build step
│   ├── index.html                # the widget
│   ├── project.html              # one window per project (Overview / Schedule / Report)
│   ├── css/                      # base.css (shared), widget.css, project.css
│   └── js/
│       ├── core/                 # Tauri bridge, API, formatting, time model, charts, theme
│       ├── widget/               # projects list, Stats, Archive, settings, cloud sync
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
        ├── sync.rs               # optional cloud sync (Supabase over HTTPS)
        └── db/                   # SQLite schema, migrations, queries, sync outbox, tests
```

## Extending

- **System tray**: the `tray-icon` feature is already enabled in `Cargo.toml`
  and `tauri.conf.json`. Add a `TrayIconBuilder` in `setup()` in `main.rs`
  to minimize to the tray instead of quitting on ×.
- **Notifications**: add `tauri-plugin-notification` to warn when a timer
  has been running unusually long.

## Release notes

### Unreleased: cloud sync

- Optional sync through your own Supabase project, between computers and
  with the companion Android app. See [Cloud sync](#cloud-sync).
- The widget shows when a timer is running on another device.

### v5.0.0: projects, schedules and reports

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
  billing time the app was closed" under [How it works](#how-it-works).
- **Fix: 7-second autosave.** Replaced by session-based saving plus a 30 s
  liveness stamp. Upgrading merges the old per-tick rows into one row per
  session (totals unchanged).
- **Fix: false sleep pauses.** Sleep detection now runs in the backend, not
  in a WebView timer that is throttled when the window is minimized.

### v4.0.0: daily hours and Stats

- **Per-day ledger.** Tracked time is also added to a `daily_totals` table
  (one row per local day per project). A session that crosses midnight is
  split at local midnight, so 23:50 → 00:20 counts 10 minutes to the first
  day and 20 to the next. Databases from v1–v3 are backfilled once on first
  launch (`PRAGMA user_version` guards against doing it twice).
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
  dropping the sub-second remainder every ~7 s (a few percent under-count on
  long sessions). They now advance by exactly the whole seconds banked.
