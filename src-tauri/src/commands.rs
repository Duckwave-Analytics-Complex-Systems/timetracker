//! Tauri commands: the whole API the frontend can call.
//!
//! Each command is a thin wrapper: call `Db`, turn errors into strings, and
//! `notify` the windows when data changed. JS calls these through
//! js/core/api.js, which is the only place `invoke` names appear.

use crate::db::{self, DailyRow, DayTotal, Db, Phase, PhaseInput, PlanInput, Project, RecoveredRun};
use crate::events::{notify, Change};
use crate::sync::{self as cloud, SyncStatus};
use crate::{now_ms, watchdog};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

type CmdResult<T> = Result<T, String>;

fn msg(e: impl ToString) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- projects

#[tauri::command]
pub fn get_projects(db: State<Db>) -> CmdResult<Vec<Project>> {
    db.list_projects(false).map_err(msg)
}

#[tauri::command]
pub fn get_archived_projects(db: State<Db>) -> CmdResult<Vec<Project>> {
    db.list_projects(true).map_err(msg)
}

#[tauri::command]
pub fn add_project(app: AppHandle, db: State<Db>, name: String, hourly_rate: f64, people_count: i64) -> CmdResult<()> {
    db.create_project(&db::new_id(), name.trim(), hourly_rate, people_count, now_ms()).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

#[tauri::command]
pub fn update_project(app: AppHandle, db: State<Db>, id: String, name: String, hourly_rate: f64, people_count: i64) -> CmdResult<()> {
    db.update_project(&id, name.trim(), hourly_rate, people_count).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

#[tauri::command]
pub fn set_project_logo(app: AppHandle, db: State<Db>, id: String, data_url: Option<String>) -> CmdResult<()> {
    db.set_logo(&id, data_url).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

/// "File" a project: it leaves the main list but keeps all its history.
#[tauri::command]
pub fn archive_project(app: AppHandle, db: State<Db>, id: String) -> CmdResult<()> {
    db.set_archived(&id, true, now_ms()).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

#[tauri::command]
pub fn restore_project(app: AppHandle, db: State<Db>, id: String) -> CmdResult<()> {
    db.set_archived(&id, false, now_ms()).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

#[tauri::command]
pub fn delete_project(app: AppHandle, db: State<Db>, id: String) -> CmdResult<()> {
    db.delete_project(&id).map_err(msg)?;
    if let Some(w) = app.get_webview_window(&project_window_label(&id)) {
        let _ = w.close();
    }
    notify(&app, Change::Projects);
    Ok(())
}

#[tauri::command]
pub fn reset_project(app: AppHandle, db: State<Db>, id: String) -> CmdResult<()> {
    db.reset_project(&id).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

// ---------------------------------------------------------------- timer

#[tauri::command]
pub fn start_project(app: AppHandle, db: State<Db>, id: String) -> CmdResult<()> {
    db.start_project(&id, now_ms()).map_err(msg)?;
    notify(&app, Change::Timer);
    Ok(())
}

/// Only one timer can run, so this pauses whatever is running.
#[tauri::command]
pub fn pause_timer(app: AppHandle, db: State<Db>) -> CmdResult<()> {
    db.pause_all_running(now_ms()).map_err(msg)?;
    notify(&app, Change::Timer);
    Ok(())
}

/// Runs a watchdog check right now. The frontend calls this when its own
/// clock jumps (it was just woken up), instead of waiting for the next tick.
#[tauri::command]
pub fn sync(app: AppHandle) {
    watchdog::run_check(&app);
}

/// Sessions that were closed at launch because the app had died with a
/// timer running. Returned once; the widget shows them in a notice.
pub struct Recovered(pub Mutex<Vec<RecoveredRun>>);

#[tauri::command]
pub fn take_recovered_runs(recovered: State<Recovered>) -> Vec<RecoveredRun> {
    std::mem::take(&mut *recovered.0.lock().unwrap())
}

// ---------------------------------------------------------------- schedule

/// Everything the project window shows, read in one go.
#[derive(Serialize)]
pub struct ProjectDetail {
    project: Project,
    phases: Vec<Phase>,
    daily: Vec<DayTotal>,
}

#[tauri::command]
pub fn get_project_detail(db: State<Db>, id: String) -> CmdResult<ProjectDetail> {
    let project = db.get_project(&id).map_err(msg)?.ok_or("This project no longer exists.")?;
    Ok(ProjectDetail {
        project,
        phases: db.list_phases(&id).map_err(msg)?,
        daily: db.project_daily(&id).map_err(msg)?,
    })
}

#[tauri::command]
pub fn update_project_plan(app: AppHandle, db: State<Db>, id: String, plan: PlanInput) -> CmdResult<()> {
    db.update_plan(&id, &plan).map_err(msg)?;
    notify(&app, Change::Schedule);
    Ok(())
}

#[tauri::command]
pub fn save_phase(app: AppHandle, db: State<Db>, phase: PhaseInput) -> CmdResult<String> {
    let phase = phase.normalized()?;
    let id = db.save_phase(&phase, now_ms()).map_err(msg)?;
    notify(&app, Change::Schedule);
    Ok(id)
}

#[tauri::command]
pub fn delete_phase(app: AppHandle, db: State<Db>, id: String) -> CmdResult<()> {
    db.delete_phase(&id).map_err(msg)?;
    notify(&app, Change::Schedule);
    Ok(())
}

/// Which phase new time is booked to (`None` = unassigned).
#[tauri::command]
pub fn set_active_phase(app: AppHandle, db: State<Db>, project_id: String, phase_id: Option<String>) -> CmdResult<()> {
    db.set_active_phase(&project_id, phase_id.as_deref(), now_ms()).map_err(msg)?;
    notify(&app, Change::Timer);
    Ok(())
}

// ---------------------------------------------------------------- stats & export

/// Tracked seconds per local day per active project, for an inclusive day
/// range ("YYYY-MM-DD", computed by the frontend in the same time zone).
#[tauri::command]
pub fn get_daily(db: State<Db>, from_day: String, to_day: String) -> CmdResult<Vec<DailyRow>> {
    db.daily_range(&from_day, &to_day).map_err(msg)
}

/// One row per active project: name, total time, total bill, hourly rate.
/// A running timer is included up to this second without being paused.
#[tauri::command]
pub fn export_csv(db: State<Db>) -> CmdResult<String> {
    let now = now_ms();
    let mut csv = String::from("Project Name,Total Time,Total Bill,Hourly Rate\n");
    for p in db.list_projects(false).map_err(msg)? {
        let secs = p.live_seconds(now);
        let time = format!("{:02}:{:02}:{:02}", secs / 3600, (secs % 3600) / 60, secs % 60);
        let (bill, rate) = if p.hourly_rate > 0.0 {
            (format!("{:.2}", p.bill(secs)), format!("{:.2}", p.hourly_rate))
        } else {
            (String::new(), String::new())
        };
        csv.push_str(&format!("\"{}\",{},{},{}\n", p.name.replace('"', "\"\""), time, bill, rate));
    }
    Ok(csv)
}

// ---------------------------------------------------------------- cloud sync
//
// Network calls block, so these run on a worker thread (`async` + spawn_blocking)
// instead of the main thread.

#[tauri::command]
pub fn cloud_status(app: AppHandle) -> SyncStatus {
    cloud::status(&app)
}

#[tauri::command]
pub async fn cloud_sign_in(app: AppHandle, url: String, anon_key: String, email: String, password: String) -> CmdResult<SyncStatus> {
    tauri::async_runtime::spawn_blocking(move || cloud::sign_in(&app, &url, &anon_key, &email, &password))
        .await
        .map_err(msg)?
}

#[tauri::command]
pub async fn cloud_sign_out(app: AppHandle) -> CmdResult<SyncStatus> {
    tauri::async_runtime::spawn_blocking(move || cloud::sign_out(&app)).await.map_err(msg)?
}

/// Syncs right now and returns the resulting status.
#[tauri::command]
pub async fn cloud_sync_now(app: AppHandle) -> CmdResult<SyncStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        cloud::run_cycle(&app);
        cloud::status(&app)
    })
    .await
    .map_err(msg)
}

// ---------------------------------------------------------------- windows

pub const PROJECT_WINDOW_PREFIX: &str = "project-";

fn project_window_label(id: &str) -> String {
    format!("{PROJECT_WINDOW_PREFIX}{id}")
}

/// Opens (or focuses) the detail window of a project. The project id is in
/// the window label; project.html reads it from there.
///
/// Must be `async`: creating a window from a sync command deadlocks on Windows.
#[tauri::command]
pub async fn open_project_window(app: AppHandle, id: String) -> CmdResult<()> {
    let label = project_window_label(&id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.unminimize();
        existing.set_focus().map_err(msg)?;
        return Ok(());
    }
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("project.html".into()))
        .title("TimeTrack · Project")
        .inner_size(1000.0, 720.0)
        .min_inner_size(720.0, 520.0)
        .decorations(false)
        .transparent(true)
        .center()
        .build()
        .map_err(msg)?;
    Ok(())
}
