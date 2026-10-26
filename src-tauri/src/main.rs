// Prevents an extra console window from popping up on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! TimeTrack backend. Module map:
//!
//! - `commands`  every function the frontend can `invoke`
//! - `db/`       SQLite: schema, migrations, queries, tests
//! - `events`    the `data-changed` event that keeps windows in sync
//! - `watchdog`  sleep detection + liveness stamp (background thread)
//! - `shutdown`  pausing the timer on every way the app can end
//! - `sync`      optional cloud sync with Supabase (background thread)

mod commands;
mod db;
mod events;
mod shutdown;
mod sync;
mod watchdog;

use std::sync::Mutex;
use tauri::{Manager, RunEvent, WindowEvent};

pub const MAIN_WINDOW: &str = "main";

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let db = db::init(app.path().app_data_dir()?)?;
            // Before any window shows a timer: close sessions that a crash,
            // kill or OS shutdown left open last time.
            let recovered = db.recover_interrupted_runs()?;
            app.manage(db);
            app.manage(commands::Recovered(Mutex::new(recovered)));
            app.manage(watchdog::Watchdog::new(now_ms()));
            watchdog::spawn(app.handle().clone());
            app.manage(sync::SyncState::default());
            sync::spawn(app.handle().clone());
            shutdown::install_signal_handlers(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the widget quits the app (project windows included).
            // Closing a project window only closes that window.
            if window.label() == MAIN_WINDOW {
                if let WindowEvent::CloseRequested { .. } = event {
                    shutdown::pause_timers(window.app_handle());
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_projects,
            commands::get_archived_projects,
            commands::add_project,
            commands::update_project,
            commands::set_project_logo,
            commands::archive_project,
            commands::restore_project,
            commands::delete_project,
            commands::reset_project,
            commands::start_project,
            commands::pause_timer,
            commands::sync,
            commands::take_recovered_runs,
            commands::get_project_detail,
            commands::update_project_plan,
            commands::save_phase,
            commands::delete_phase,
            commands::set_active_phase,
            commands::get_daily,
            commands::export_csv,
            commands::open_project_window,
            commands::cloud_status,
            commands::cloud_sign_in,
            commands::cloud_sign_out,
            commands::cloud_sync_now,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            shutdown::pause_timers(handle);
        }
    });
}
