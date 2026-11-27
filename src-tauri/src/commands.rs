//! Tauri commands: the whole API the frontend can call.
//!
//! Each command is a thin wrapper: call `Db`, turn errors into strings, and
//! `notify` the windows when data changed. JS calls these through
//! js/core/api.js, which is the only place `invoke` names appear.

use crate::db::{self, ClosedSession, DailyRow, DayTotal, Db, Feature, FeatureInput, MemberHours, Org, OrgEntry, OrgMember, Phase, PhaseInput, PlanInput, Project, RecoveredRun, Session, SessionSpan};
use crate::events::{notify, Change};
use crate::sync::{self as cloud, SyncStatus};
use crate::updates::{self, UpdateInfo};
use crate::{now_ms, watchdog};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

type CmdResult<T> = Result<T, String>;

fn msg(e: impl ToString) -> String {
    e.to_string()
}

/// The project row belongs to its owner: the server refuses anyone else's change.
fn owner_only(db: &Db, id: &str) -> CmdResult<()> {
    if db.is_owner(id).map_err(msg)? {
        Ok(())
    } else {
        Err("Only the project owner can change this.".into())
    }
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

/// `org_id`: the organization to create it in; none = a personal project.
#[tauri::command]
pub fn add_project(
    app: AppHandle, db: State<Db>, name: String, hourly_rate: f64, people_count: i64, org_id: Option<String>,
) -> CmdResult<()> {
    let id = db::new_id();
    db.create_project(&id, name.trim(), hourly_rate, people_count, now_ms()).map_err(msg)?;
    if org_id.is_some() {
        db.set_project_org(&id, org_id.as_deref()).map_err(msg)?;
    }
    notify(&app, Change::Projects);
    Ok(())
}

/// Moves a project into an organization, or back to personal (`None`). The
/// frontend offers only the moves the server allows (see `moveTargets` in
/// js/core/orgs.js); the server keeps the old value for any other.
#[tauri::command]
pub fn set_project_org(app: AppHandle, db: State<Db>, id: String, org_id: Option<String>) -> CmdResult<()> {
    db.set_project_org(&id, org_id.as_deref()).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

#[tauri::command]
pub fn update_project(app: AppHandle, db: State<Db>, id: String, name: String, hourly_rate: f64, people_count: i64) -> CmdResult<()> {
    owner_only(&db, &id)?;
    db.update_project(&id, name.trim(), hourly_rate, people_count).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

#[tauri::command]
pub fn set_project_logo(app: AppHandle, db: State<Db>, id: String, data_url: Option<String>) -> CmdResult<()> {
    owner_only(&db, &id)?;
    db.set_logo(&id, data_url).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

/// "File" a project: it leaves the main list but keeps all its history.
#[tauri::command]
pub fn archive_project(app: AppHandle, db: State<Db>, id: String) -> CmdResult<()> {
    owner_only(&db, &id)?;
    db.set_archived(&id, true, now_ms()).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

/// "End" a project: file it and record what it paid in total, if given.
#[tauri::command]
pub fn end_project(app: AppHandle, db: State<Db>, id: String, final_payment: Option<f64>) -> CmdResult<()> {
    owner_only(&db, &id)?;
    db.end_project(&id, final_payment, now_ms()).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

#[tauri::command]
pub fn set_final_payment(app: AppHandle, db: State<Db>, id: String, final_payment: Option<f64>) -> CmdResult<()> {
    owner_only(&db, &id)?;
    db.set_final_payment(&id, final_payment).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

#[tauri::command]
pub fn restore_project(app: AppHandle, db: State<Db>, id: String) -> CmdResult<()> {
    owner_only(&db, &id)?;
    db.set_archived(&id, false, now_ms()).map_err(msg)?;
    notify(&app, Change::Projects);
    Ok(())
}

#[tauri::command]
pub fn delete_project(app: AppHandle, db: State<Db>, id: String) -> CmdResult<()> {
    owner_only(&db, &id)?;
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
pub fn start_project(app: AppHandle, db: State<Db>, id: String) -> CmdResult<Vec<ClosedSession>> {
    let closed = db.start_project(&id, now_ms()).map_err(msg)?;
    notify(&app, Change::Timer);
    Ok(closed)
}

/// Only one timer can run, so this pauses whatever is running.
#[tauri::command]
pub fn pause_timer(app: AppHandle, db: State<Db>) -> CmdResult<Vec<ClosedSession>> {
    let closed = db.stop_timer(now_ms()).map_err(msg)?;
    notify(&app, Change::Timer);
    Ok(closed)
}

/// The note of the open session. Nothing shows it until the session closes.
#[tauri::command]
pub fn set_run_note(db: State<Db>, project_id: String, note: Option<String>) -> CmdResult<()> {
    db.set_run_note(&project_id, note.as_deref()).map_err(msg)
}

#[tauri::command]
pub fn set_entry_note(app: AppHandle, db: State<Db>, entry_id: String, note: Option<String>) -> CmdResult<()> {
    db.set_entry_note(&entry_id, note.as_deref()).map_err(msg)?;
    notify(&app, Change::Timer);
    Ok(())
}

/// Deletes one of your closed sessions (History tab).
#[tauri::command]
pub fn delete_entry(app: AppHandle, db: State<Db>, entry_id: String) -> CmdResult<()> {
    db.delete_entry(&entry_id).map_err(msg)?;
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
    features: Vec<Feature>,
    sessions: Vec<Session>,
    daily: Vec<DayTotal>,
    members: Vec<MemberHours>,
}

#[tauri::command]
pub fn get_project_detail(db: State<Db>, id: String) -> CmdResult<ProjectDetail> {
    let project = db.get_project(&id).map_err(msg)?.ok_or("This project no longer exists.")?;
    Ok(ProjectDetail {
        project,
        phases: db.list_phases(&id).map_err(msg)?,
        features: db.list_features(&id).map_err(msg)?,
        sessions: db.list_sessions(&id).map_err(msg)?,
        daily: db.project_daily(&id).map_err(msg)?,
        members: db.member_hours(&id).map_err(msg)?,
    })
}

#[tauri::command]
pub fn update_project_plan(app: AppHandle, db: State<Db>, id: String, plan: PlanInput) -> CmdResult<()> {
    owner_only(&db, &id)?;
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

// ---------------------------------------------------------------- features

#[tauri::command]
pub fn save_feature(app: AppHandle, db: State<Db>, feature: FeatureInput) -> CmdResult<String> {
    let feature = feature.normalized()?;
    let id = db.save_feature(&feature, now_ms()).map_err(msg)?;
    notify(&app, Change::Schedule);
    Ok(id)
}

#[tauri::command]
pub fn delete_feature(app: AppHandle, db: State<Db>, id: String) -> CmdResult<()> {
    db.delete_feature(&id).map_err(msg)?;
    notify(&app, Change::Schedule);
    Ok(())
}

/// Which feature new time is booked to (`None` = unassigned).
#[tauri::command]
pub fn set_active_feature(app: AppHandle, db: State<Db>, project_id: String, feature_id: Option<String>) -> CmdResult<()> {
    db.set_active_feature(&project_id, feature_id.as_deref(), now_ms()).map_err(msg)?;
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

/// Your sessions on active projects overlapping `from_ms..to_ms` (Unix ms),
/// for the hour-of-day heatmap.
#[tauri::command]
pub fn get_session_spans(db: State<Db>, from_ms: i64, to_ms: i64) -> CmdResult<Vec<SessionSpan>> {
    db.session_spans(from_ms, to_ms).map_err(msg)
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

/// Your name on shared projects.
#[tauri::command]
pub async fn cloud_set_display_name(app: AppHandle, name: String) -> CmdResult<SyncStatus> {
    let status = tauri::async_runtime::spawn_blocking(move || cloud::set_display_name(&app, &name)).await.map_err(msg)??;
    Ok(status)
}

/// Whether org teammates see when you're tracking one of its projects.
#[tauri::command]
pub async fn cloud_set_share_activity(app: AppHandle, on: bool) -> CmdResult<SyncStatus> {
    tauri::async_runtime::spawn_blocking(move || cloud::set_share_activity(&app, on)).await.map_err(msg)?
}

/// Adds someone to a project by their share code. Returns their name.
#[tauri::command]
pub async fn cloud_add_member(app: AppHandle, project_id: String, share_code: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || cloud::add_member(&app, &project_id, &share_code)).await.map_err(msg)?
}

/// Adds someone from the project's organization. Returns their name.
#[tauri::command]
pub async fn cloud_add_member_by_id(app: AppHandle, project_id: String, user_id: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || cloud::add_member_by_id(&app, &project_id, &user_id)).await.map_err(msg)?
}

/// Removes someone from a project. Removing yourself is leaving it.
#[tauri::command]
pub async fn cloud_remove_member(app: AppHandle, project_id: String, user_id: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || cloud::remove_member(&app, &project_id, &user_id)).await.map_err(msg)?
}

// ---------------------------------------------------------------- organizations

/// Your organizations (as of the last sync), by name.
#[tauri::command]
pub fn get_orgs(db: State<Db>) -> CmdResult<Vec<Org>> {
    db.list_orgs().map_err(msg)
}

/// The people in one of your organizations.
#[tauri::command]
pub fn get_org_members(db: State<Db>, org_id: String) -> CmdResult<Vec<OrgMember>> {
    db.org_members(&org_id).map_err(msg)
}

/// Sessions on an organization's projects from `from_ms` on, for its dashboard.
#[tauri::command]
pub fn get_org_entries(db: State<Db>, org_id: String, from_ms: i64) -> CmdResult<Vec<OrgEntry>> {
    db.org_entries(&org_id, from_ms).map_err(msg)
}

/// Who in an organization is tracking one of its projects now (from the server).
#[tauri::command]
pub async fn cloud_org_presence(app: AppHandle, org_id: String) -> CmdResult<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || cloud::org_presence(&app, &org_id)).await.map_err(msg)?
}

/// Creates an organization with you as its owner. Returns its id.
#[tauri::command]
pub async fn cloud_create_org(app: AppHandle, name: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || cloud::create_org(&app, &name)).await.map_err(msg)?
}

/// Joins an organization by its invite code. Returns its id.
#[tauri::command]
pub async fn cloud_join_org(app: AppHandle, code: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || cloud::join_org(&app, &code)).await.map_err(msg)?
}

/// Adds someone to an organization by their share code. Returns their name.
#[tauri::command]
pub async fn cloud_add_org_member(app: AppHandle, org_id: String, share_code: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || cloud::add_org_member(&app, &org_id, &share_code)).await.map_err(msg)?
}

/// Removes someone from an organization. Removing yourself is leaving it.
#[tauri::command]
pub async fn cloud_remove_org_member(app: AppHandle, org_id: String, user_id: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || cloud::remove_org_member(&app, &org_id, &user_id)).await.map_err(msg)?
}

/// "admin" | "member", or "owner" to hand the organization over.
#[tauri::command]
pub async fn cloud_set_org_role(app: AppHandle, org_id: String, user_id: String, role: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || cloud::set_org_role(&app, &org_id, &user_id, &role)).await.map_err(msg)?
}

/// Changes an organization's name, logo or defaults.
#[tauri::command]
pub async fn cloud_update_org(app: AppHandle, org_id: String, changes: serde_json::Value) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || cloud::update_org(&app, &org_id, changes)).await.map_err(msg)?
}

/// A new invite code; the old one stops working. Returns it.
#[tauri::command]
pub async fn cloud_reset_org_join_code(app: AppHandle, org_id: String) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || cloud::reset_org_join_code(&app, &org_id)).await.map_err(msg)?
}

/// Deletes an organization. Its projects become personal projects of their owners.
#[tauri::command]
pub async fn cloud_delete_org(app: AppHandle, org_id: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || cloud::delete_org(&app, &org_id)).await.map_err(msg)?
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

// ---------------------------------------------------------------- updates

/// Reads the public version manifest. Errs when offline: the widget stays quiet.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> CmdResult<UpdateInfo> {
    let info = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || updates::check(&app)
    })
    .await
    .map_err(msg)??;
    if info.required {
        cloud::poke(); // show the "update to keep syncing" status now
    }
    Ok(info)
}

/// Opens the download page in the browser.
#[tauri::command]
pub fn open_update_download(app: AppHandle) -> CmdResult<()> {
    updates::open_download(&app)
}
