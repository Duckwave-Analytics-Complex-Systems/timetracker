// Prevents an extra console window from popping up on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod db;

use db::{Db, Project};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::atomic::{AtomicI64, Ordering};
use tauri::{Manager, State};

/// Timestamp of the last heartbeat received from the frontend's autosave
/// tick. The frontend calls `checkpoint` every 5-10s. If the gap between
/// two calls is much larger than that, the OS almost certainly suspended
/// the process (sleep/hibernate) rather than the tick genuinely taking
/// that long -- there is no single cross-platform "on resume" event
/// available without pulling in per-OS power APIs (Win32
/// WM_POWERBROADCAST / logind DBus signals), so this heartbeat-gap
/// heuristic is the lightweight, dependency-free equivalent and is what
/// actually drives the auto-pause-on-sleep requirement.
static LAST_HEARTBEAT_MS: Lazy<AtomicI64> = Lazy::new(|| AtomicI64::new(now_ms()));
const SLEEP_GAP_THRESHOLD_MS: i64 = 30_000; // > 30s gap between 5-10s ticks => was asleep

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

#[derive(Serialize)]
struct CheckpointResult {
    projects: Vec<Project>,
    resumed_from_sleep: bool,
}

#[tauri::command]
fn get_projects(db: State<Db>) -> Result<Vec<Project>, String> {
    db.list_projects().map_err(|e| e.to_string())
}

#[tauri::command]
fn add_project(db: State<Db>, name: String, hourly_rate: f64) -> Result<Project, String> {
    let id = uuid::Uuid::new_v4().to_string();
    db.create_project(&id, &name, hourly_rate, now_ms())
        .map_err(|e| e.to_string())?;
    db.list_projects()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| "project vanished after insert".into())
}

#[tauri::command]
fn update_project(db: State<Db>, id: String, name: String, hourly_rate: f64) -> Result<(), String> {
    db.rename_project(&id, &name, hourly_rate).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_project(db: State<Db>, id: String) -> Result<(), String> {
    db.delete_project(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn reset_project(db: State<Db>, id: String) -> Result<(), String> {
    db.reset_project(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_project_logo(db: State<Db>, id: String, data_url: Option<String>) -> Result<(), String> {
    db.set_logo(&id, data_url).map_err(|e| e.to_string())
}

/// Starts `id`, first pausing whatever else is running -- this is the one
/// place that enforces "only one active project at a time".
#[tauri::command]
fn start_project(db: State<Db>, id: String) -> Result<Vec<Project>, String> {
    let now = now_ms();
    db.pause_all_running(now).map_err(|e| e.to_string())?;
    db.start_project(&id, now).map_err(|e| e.to_string())?;
    db.list_projects().map_err(|e| e.to_string())
}

#[tauri::command]
fn pause_project(db: State<Db>, id: String) -> Result<Vec<Project>, String> {
    let now = now_ms();
    // pause_all_running pauses everything currently running; since only one
    // project can ever be running this also correctly pauses just `id`.
    let _ = id;
    db.pause_all_running(now).map_err(|e| e.to_string())?;
    db.list_projects().map_err(|e| e.to_string())
}

/// Called by the frontend every 5-10s while any timer is running. Persists
/// elapsed time so a crash never loses more than one tick's worth of work,
/// and detects sleep/hibernate via the heartbeat-gap heuristic above.
#[tauri::command]
fn checkpoint(db: State<Db>, running_id: Option<String>) -> Result<CheckpointResult, String> {
    let now = now_ms();
    let last = LAST_HEARTBEAT_MS.swap(now, Ordering::SeqCst);
    let gap = now - last;
    let mut resumed_from_sleep = false;

    if gap > SLEEP_GAP_THRESHOLD_MS {
        // System was almost certainly suspended. Pause everything so the
        // sleep duration is never counted as billable time.
        db.pause_all_running(last + 1000).map_err(|e| e.to_string())?;
        resumed_from_sleep = true;
    } else if let Some(id) = running_id {
        db.checkpoint_running(&id, now).map_err(|e| e.to_string())?;
    }

    Ok(CheckpointResult {
        projects: db.list_projects().map_err(|e| e.to_string())?,
        resumed_from_sleep,
    })
}

/// Exports one row per project: name, total time, total bill, hourly rate.
/// If a project is currently running, its elapsed time is checkpointed
/// first so the export reflects work up to this exact second without
/// pausing (and therefore without disrupting) the active timer.
#[tauri::command]
fn export_csv(db: State<Db>) -> Result<String, String> {
    let now = now_ms();
    for p in db.list_projects().map_err(|e| e.to_string())? {
        if p.is_running {
            db.checkpoint_running(&p.id, now).map_err(|e| e.to_string())?;
        }
    }
    let projects = db.list_projects().map_err(|e| e.to_string())?;

    let mut csv = String::from("Project Name,Total Time,Total Bill,Hourly Rate\n");
    for p in projects {
        let h = p.total_seconds / 3600;
        let m = (p.total_seconds % 3600) / 60;
        let s = p.total_seconds % 60;
        let time_str = format!("{:02}:{:02}:{:02}", h, m, s);
        let (bill_str, rate_str) = if p.hourly_rate > 0.0 {
            let bill = (p.total_seconds as f64 / 3600.0) * p.hourly_rate;
            (format!("{:.2}", bill), format!("{:.2}", p.hourly_rate))
        } else {
            (String::new(), String::new())
        };
        csv.push_str(&format!(
            "\"{}\",{},{},{}\n",
            p.name.replace('"', "\"\""),
            time_str,
            bill_str,
            rate_str
        ));
    }
    Ok(csv)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("no app data dir");
            let db = db::init(app_data_dir).expect("failed to init database");
            app.manage(db);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Flush any running timer to disk immediately on close so
            // quitting the app is never a source of lost time.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let db: State<Db> = window.state();
                let _ = db.pause_all_running(now_ms());
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_projects,
            add_project,
            update_project,
            delete_project,
            reset_project,
            set_project_logo,
            start_project,
            pause_project,
            checkpoint,
            export_csv,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
