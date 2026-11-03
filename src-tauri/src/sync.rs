//! Cloud sync with Supabase (optional; does nothing until an account is
//! linked from Settings). Other computers, and the companion Android app,
//! sync through the same Supabase project. Server schema:
//! supabase/schema.sql. Local side: db/sync.rs.
//!
//! A background thread runs one sync cycle every `INTERVAL`, and soon after
//! any local change (`poke()`, called from `events::notify`):
//!
//! 1. push queued rows (projects, features, phases, member state, entries; deletes
//!    as tombstones). A change the server refuses is dropped, not retried forever.
//! 2. members: refresh who is in each project. A project you just joined has all
//!    its rows fetched, since they're older than the cursors. One you're no longer
//!    in is forgotten.
//! 3. pull rows changed on the server since the last cursor
//! 4. timer: push this device's start/stop through `push_timer()`, then
//!    reconcile the local timer with the row the server returns
//! 5. push again (reconciling may have booked a session)
//!
//! All HTTP is blocking (`ureq`) and happens outside the `Db` lock.

use crate::db::{self, Db, Entity, Member, Pending, RemoteTimer, TimerPush};
use crate::events::{notify, Change};
use crate::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const INTERVAL: Duration = Duration::from_secs(20);
const DEBOUNCE: Duration = Duration::from_millis(800);
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const PUSH_BATCH: usize = 200;
const PULL_PAGE: usize = 500;
const EPOCH: &str = "1970-01-01T00:00:00Z";

// sync_meta keys
const K_CONFIG: &str = "config";
const K_SESSION: &str = "session";
const K_DEVICE: &str = "device_id";
const K_TIMER: &str = "timer_known";
const K_USER_ID: &str = "user_id"; // the account this device's data belongs to
const K_USER_EMAIL: &str = "user_email";
const K_PROFILE: &str = "profile";
const K_REFUSED: &str = "refused_changes";

fn cursor_key(e: Entity) -> String {
    format!("cursor:{}", e.table())
}

type SyncResult<T> = Result<T, String>;

fn msg(e: impl ToString) -> String {
    e.to_string()
}

/// Which Supabase project to talk to.
#[derive(Serialize, Deserialize, Clone)]
struct Config {
    url: String,
    anon_key: String,
}

/// A signed-in Supabase user. The password is never stored.
#[derive(Serialize, Deserialize, Clone)]
struct Session {
    access_token: String,
    refresh_token: String,
    expires_at: i64, // unix seconds
    user_id: String,
    email: String,
}

/// Your name and the code others use to add you to a project.
#[derive(Serialize, Deserialize, Clone)]
pub struct Profile {
    pub display_name: String,
    pub share_code: String,
}

/// What the Settings panel shows.
#[derive(Serialize, Clone, Default)]
pub struct SyncStatus {
    pub url: Option<String>,
    pub email: Option<String>,
    pub signed_in: bool,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    /// The account this device's data belongs to, kept after signing out.
    /// Signing in as anyone else replaces the data here (see `sign_in`).
    pub linked_email: Option<String>,
    pub linked: bool,
    /// Local changes not yet uploaded (lost if another account signs in).
    pub unsynced_changes: i64,
    pub profile: Option<Profile>,
    /// Local changes the server refused, undone here (see `push_rows`).
    pub refused_changes: i64,
}

#[derive(Default)]
pub struct SyncState {
    status: Mutex<SyncStatus>,
    /// One cycle (or sign-in) at a time.
    running: Mutex<()>,
}

static POKE: OnceLock<Sender<()>> = OnceLock::new();

/// Asks for a sync soon. Cheap; safe to call when sync is off.
pub fn poke() {
    if let Some(tx) = POKE.get() {
        let _ = tx.send(());
    }
}

pub fn spawn(app: AppHandle) {
    let (tx, rx) = channel();
    let _ = POKE.set(tx);
    std::thread::spawn(move || loop {
        run_cycle(&app);
        match rx.recv_timeout(INTERVAL) {
            Ok(()) => {
                // Let a burst of changes settle into one cycle.
                std::thread::sleep(DEBOUNCE);
                while rx.try_recv().is_ok() {}
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    });
}

// ---------------------------------------------------------------- stored settings

fn load<T: for<'de> Deserialize<'de>>(db: &Db, key: &str) -> Option<T> {
    db.sync_meta(key).ok().flatten().and_then(|s| serde_json::from_str(&s).ok())
}

fn store<T: Serialize>(db: &Db, key: &str, value: Option<&T>) -> SyncResult<()> {
    let json = value.map(serde_json::to_string).transpose().map_err(msg)?;
    db.set_sync_meta(key, json.as_deref()).map_err(msg)
}

fn device_id(db: &Db) -> SyncResult<String> {
    if let Some(id) = db.sync_meta(K_DEVICE).map_err(msg)? {
        return Ok(id);
    }
    let id = format!("desktop-{}", db::new_id());
    db.set_sync_meta(K_DEVICE, Some(&id)).map_err(msg)?;
    Ok(id)
}

pub fn status(app: &AppHandle) -> SyncStatus {
    let db = app.state::<Db>();
    let mut s = app.state::<SyncState>().status.lock().unwrap().clone();
    let config: Option<Config> = load(&db, K_CONFIG);
    let session: Option<Session> = load(&db, K_SESSION);
    s.url = config.map(|c| c.url);
    s.signed_in = session.is_some();
    s.email = session.map(|s| s.email);
    s.linked = db.sync_meta(K_USER_ID).ok().flatten().is_some();
    s.linked_email = db.sync_meta(K_USER_EMAIL).ok().flatten();
    s.unsynced_changes = db.unsynced_changes().unwrap_or(0);
    s.profile = load(&db, K_PROFILE);
    s.refused_changes = db.sync_meta(K_REFUSED).ok().flatten().and_then(|n| n.parse().ok()).unwrap_or(0);
    s
}

// ---------------------------------------------------------------- HTTP

fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build())
}

/// Sends a request and returns its JSON body (`Null` when empty). Error
/// messages from Supabase are passed through so the user can read them.
fn send(req: ureq::Request, body: Option<&Value>) -> SyncResult<Value> {
    let res = match body {
        Some(b) => req.set("Content-Type", "application/json").send_string(&b.to_string()),
        None => req.call(),
    };
    let text = match res {
        Ok(r) => r.into_string().map_err(msg)?,
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            let detail = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| {
                    ["msg", "message", "error_description", "error"]
                        .iter()
                        .find_map(|k| v.get(*k).and_then(Value::as_str).map(str::to_string))
                })
                .unwrap_or(text);
            return Err(format!("Server error {code}: {detail}"));
        }
        Err(e) => return Err(format!("Network error: {e}")),
    };
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(msg)
}

/// Signs in (`grant = "password"`) or refreshes (`grant = "refresh_token"`).
fn auth(cfg: &Config, grant: &str, body: Value) -> SyncResult<Session> {
    let req = agent()
        .post(&format!("{}/auth/v1/token", cfg.url))
        .query("grant_type", grant)
        .set("apikey", &cfg.anon_key);
    let v = send(req, Some(&body))?;
    let field = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    let user = v.get("user").cloned().unwrap_or(Value::Null);
    let expires_in = v.get("expires_in").and_then(Value::as_i64).unwrap_or(3600);
    Ok(Session {
        access_token: field("access_token").ok_or("No access token in the sign-in response.")?,
        refresh_token: field("refresh_token").ok_or("No refresh token in the sign-in response.")?,
        expires_at: now_ms() / 1000 + expires_in,
        user_id: user.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
        email: user.get("email").and_then(Value::as_str).unwrap_or_default().to_string(),
    })
}

/// The PostgREST API as one signed-in user.
struct Rest<'a> {
    cfg: &'a Config,
    token: &'a str,
}

impl Rest<'_> {
    fn req(&self, method: &str, path: &str) -> ureq::Request {
        agent()
            .request(method, &format!("{}/rest/v1/{path}", self.cfg.url))
            .set("apikey", &self.cfg.anon_key)
            .set("Authorization", &format!("Bearer {}", self.token))
    }

    fn upsert(&self, table: &str, rows: &[Value]) -> SyncResult<()> {
        let req = self
            .req("POST", table)
            .query("on_conflict", "id")
            .set("Prefer", "resolution=merge-duplicates,return=minimal");
        send(req, Some(&Value::Array(rows.to_vec()))).map(|_| ())
    }

    fn changed_since(&self, table: &str, cursor: &str) -> SyncResult<Vec<Value>> {
        let req = self
            .req("GET", table)
            .query("select", "*")
            .query("updated_at", &format!("gt.{cursor}"))
            .query("order", "updated_at.asc")
            .query("limit", &PULL_PAGE.to_string());
        match send(req, None)? {
            Value::Array(rows) => Ok(rows),
            other => Err(format!("Unexpected response: {other}")),
        }
    }

    /// Up to a page of rows where `column` is `value`, oldest first, after `cursor`.
    fn matching(&self, table: &str, column: &str, value: &str, cursor: &str) -> SyncResult<Vec<Value>> {
        let req = self
            .req("GET", table)
            .query("select", "*")
            .query(column, &format!("eq.{value}"))
            .query("updated_at", &format!("gt.{cursor}"))
            .query("order", "updated_at.asc")
            .query("limit", &PULL_PAGE.to_string());
        match send(req, None)? {
            Value::Array(rows) => Ok(rows),
            other => Err(format!("Unexpected response: {other}")),
        }
    }

    fn rpc(&self, function: &str, args: Value) -> SyncResult<Value> {
        send(self.req("POST", &format!("rpc/{function}")), Some(&args))
    }

    fn profile(&self, function: &str, args: Value) -> SyncResult<Profile> {
        let row = match self.rpc(function, args)? {
            Value::Array(mut rows) if !rows.is_empty() => rows.swap_remove(0),
            other => other,
        };
        serde_json::from_value(row).map_err(msg)
    }

    fn timer(&self) -> SyncResult<RemoteTimer> {
        let rows = send(self.req("GET", "timers").query("select", "*"), None)?;
        Ok(first_row(rows))
    }

    fn push_timer(&self, op: &TimerPush, device: &str) -> SyncResult<RemoteTimer> {
        let body = match op {
            TimerPush::Start { project_id, phase_id, started_at } => json!({
                "p_op": "start", "p_project_id": project_id, "p_phase_id": phase_id,
                "p_started_at": started_at, "p_ended_at": null, "p_device_id": device,
            }),
            TimerPush::Stop { project_id, started_at, ended_at } => json!({
                "p_op": "stop", "p_project_id": project_id, "p_phase_id": null,
                "p_started_at": started_at, "p_ended_at": ended_at, "p_device_id": device,
            }),
        };
        Ok(first_row(send(self.req("POST", "rpc/push_timer"), Some(&body))?))
    }
}

/// A row from either `[row]` or `row`; no row means "never started".
fn first_row(v: Value) -> RemoteTimer {
    let row = match v {
        Value::Array(mut rows) if !rows.is_empty() => rows.swap_remove(0),
        Value::Object(_) => v,
        _ => return RemoteTimer::default(),
    };
    serde_json::from_value(row).unwrap_or_default()
}

// ---------------------------------------------------------------- the cycle

/// The server's row-level security said no. Only this means the change itself
/// is the problem: anything else (offline, a bad column) must stay queued.
fn is_refusal(e: &str) -> bool {
    e.starts_with("Server error 403")
}

/// Uploads rows and returns the ids of any the server refused. A refusal fails
/// the whole request, so they're tried one by one to find which.
fn upsert_allowed(rest: &Rest, table: &str, rows: &[Value]) -> SyncResult<Vec<String>> {
    match rest.upsert(table, rows) {
        Ok(()) => Ok(Vec::new()),
        Err(e) if is_refusal(&e) => {
            let mut refused = Vec::new();
            for row in rows {
                match rest.upsert(table, std::slice::from_ref(row)) {
                    Ok(()) => {}
                    Err(e) if is_refusal(&e) => {
                        refused.push(row.get("id").and_then(Value::as_str).unwrap_or_default().to_string());
                    }
                    Err(e) => return Err(e),
                }
            }
            Ok(refused)
        }
        Err(e) => Err(e),
    }
}

/// Undoes refused changes by taking the server's version again, and counts them
/// for the Settings panel. A row the server no longer shows stays as it is.
fn drop_refused(db: &Db, rest: &Rest, entity: Entity, refused: &[String]) -> SyncResult<()> {
    for id in refused {
        eprintln!("sync: the server refused a change to {} {id}", entity.key());
        let rows = rest.matching(entity.table(), "id", id, EPOCH)?;
        db.apply_remote(entity, &rows).map_err(msg)?;
    }
    if !refused.is_empty() {
        let total = db.sync_meta(K_REFUSED).map_err(msg)?.and_then(|n| n.parse::<usize>().ok()).unwrap_or(0) + refused.len();
        db.set_sync_meta(K_REFUSED, Some(&total.to_string())).map_err(msg)?;
    }
    Ok(())
}

fn push_rows(db: &Db, rest: &Rest) -> SyncResult<()> {
    for entity in Entity::ALL {
        // Bounded, in case rows keep changing while we push.
        for _ in 0..1000 {
            let batch = db.pending(entity, PUSH_BATCH).map_err(msg)?;
            if batch.is_empty() {
                break;
            }
            let (rows, gone): (Vec<&Pending>, Vec<&Pending>) = batch.iter().partition(|p| p.row.is_some());
            let mut refused = Vec::new();
            if !rows.is_empty() {
                let rows: Vec<Value> = rows.iter().filter_map(|p| p.row.clone()).collect();
                refused = upsert_allowed(rest, entity.table(), &rows)?;
            }
            if !gone.is_empty() && entity != Entity::MemberState {
                // Same keys in every object: PostgREST only touches these columns.
                let tombstones: Vec<Value> = gone.iter().map(|p| json!({ "id": p.id, "deleted": true })).collect();
                refused.extend(upsert_allowed(rest, entity.table(), &tombstones)?);
            }
            db.ack(entity, &batch).map_err(msg)?;
            drop_refused(db, rest, entity, &refused)?;
            if batch.len() < PUSH_BATCH {
                break;
            }
        }
    }
    Ok(())
}

/// Every row of a project just joined. They're older than the pull cursors, so
/// a normal pull would never bring them. Safe to repeat: applying is idempotent.
fn fetch_project(db: &Db, rest: &Rest, project_id: &str) -> SyncResult<()> {
    for entity in Entity::ALL {
        let column = if entity == Entity::Project { "id" } else { "project_id" };
        let mut cursor = EPOCH.to_string();
        loop {
            let rows = rest.matching(entity.table(), column, project_id, &cursor)?;
            let Some(last) = rows.last().and_then(|r| r.get("updated_at")).and_then(Value::as_str) else {
                break;
            };
            let last = last.to_string();
            db.apply_remote(entity, &rows).map_err(msg)?;
            if rows.len() < PULL_PAGE || last == cursor {
                break;
            }
            cursor = last;
        }
    }
    Ok(())
}

fn sync_members(db: &Db, rest: &Rest) -> SyncResult<bool> {
    let members: Vec<Member> = serde_json::from_value(rest.rpc("my_memberships", json!({}))?).map_err(msg)?;
    let known = db.member_projects().map_err(msg)?;
    let mut joined: Vec<&str> = members.iter().map(|m| m.project_id.as_str()).filter(|p| !known.iter().any(|k| k == p)).collect();
    joined.sort_unstable();
    joined.dedup();
    for project_id in &joined {
        fetch_project(db, rest, project_id)?;
    }
    Ok(db.apply_members(&members).map_err(msg)? || !joined.is_empty())
}

fn pull_rows(db: &Db, rest: &Rest) -> SyncResult<bool> {
    let mut changed = false;
    for entity in Entity::ALL {
        let key = cursor_key(entity);
        let mut cursor = db.sync_meta(&key).map_err(msg)?.unwrap_or_else(|| EPOCH.into());
        loop {
            let rows = rest.changed_since(entity.table(), &cursor)?;
            let Some(last) = rows.last().and_then(|r| r.get("updated_at")).and_then(Value::as_str) else {
                break;
            };
            let last = last.to_string();
            changed |= db.apply_remote(entity, &rows).map_err(msg)?;
            db.set_sync_meta(&key, Some(&last)).map_err(msg)?;
            if rows.len() < PULL_PAGE || last == cursor {
                break;
            }
            cursor = last;
        }
    }
    Ok(changed)
}

fn sync_timer(db: &Db, rest: &Rest) -> SyncResult<bool> {
    let device = device_id(db)?;
    let known: Option<RemoteTimer> = load(db, K_TIMER);
    let remote = match db.timer_push(known.as_ref(), now_ms()).map_err(msg)? {
        Some(op) => rest.push_timer(&op, &device)?,
        None => rest.timer()?,
    };
    let changed = db.reconcile_timer(&remote, &device, now_ms()).map_err(msg)?;
    store(db, K_TIMER, Some(&remote))?;
    Ok(changed)
}

/// Returns a session whose access token is good for a while, refreshing it
/// if needed. A refresh that the server refuses signs the user out.
fn fresh_session(db: &Db, cfg: &Config, session: Session) -> SyncResult<Session> {
    if session.expires_at - 120 > now_ms() / 1000 {
        return Ok(session);
    }
    match auth(cfg, "refresh_token", json!({ "refresh_token": session.refresh_token })) {
        Ok(mut s) => {
            if s.email.is_empty() {
                s.email = session.email;
            }
            store(db, K_SESSION, Some(&s))?;
            Ok(s)
        }
        Err(e) if e.starts_with("Server error 4") => {
            store::<Session>(db, K_SESSION, None)?;
            Err("Signed out: the session expired. Sign in again.".into())
        }
        Err(e) => Err(e),
    }
}

fn cycle(db: &Db, cfg: &Config, session: Session) -> SyncResult<bool> {
    let session = fresh_session(db, cfg, session)?;
    let rest = Rest { cfg, token: &session.access_token };
    if db.sync_meta(K_PROFILE).map_err(msg)?.is_none() {
        store(db, K_PROFILE, Some(&rest.profile("ensure_profile", json!({}))?))?;
    }
    push_rows(db, &rest)?;
    let mut changed = sync_members(db, &rest)?;
    changed |= pull_rows(db, &rest)?;
    changed |= db.stop_filed_timers(now_ms()).map_err(msg)?;
    changed |= sync_timer(db, &rest)?;
    push_rows(db, &rest)?;
    Ok(changed)
}

/// One sync cycle, if an account is linked. Updates the status and tells the
/// windows if anything arrived.
pub fn run_cycle(app: &AppHandle) {
    let state = app.state::<SyncState>();
    let _one_at_a_time = state.running.lock().unwrap();
    let db = app.state::<Db>();
    let (Some(cfg), Some(session)) = (load::<Config>(&db, K_CONFIG), load::<Session>(&db, K_SESSION)) else {
        return;
    };
    let result = cycle(&db, &cfg, session);
    {
        let mut s = state.status.lock().unwrap();
        match &result {
            Ok(_) => {
                s.last_sync_at = Some(now_ms());
                s.last_error = None;
            }
            Err(e) => s.last_error = Some(e.clone()),
        }
    }
    match result {
        Ok(true) => notify(app, Change::Synced),
        Ok(false) => {}
        Err(e) => {
            eprintln!("sync: {e}");
            notify(app, Change::Synced); // the status line changed
        }
    }
}

// ---------------------------------------------------------------- account

/// Links this device to a Supabase account and syncs once. Blocking.
///
/// - First link ever: everything already on this device is uploaded.
/// - Same account as before: just resumes; queued changes go up.
/// - A different account: this device's data is replaced by that account's.
///   The frontend asks for confirmation first (`linked_email` in the status).
pub fn sign_in(app: &AppHandle, url: &str, anon_key: &str, email: &str, password: &str) -> SyncResult<SyncStatus> {
    let url = url.trim().trim_end_matches('/').to_string();
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("The project URL should look like https://xxxx.supabase.co".into());
    }
    let cfg = Config { url, anon_key: anon_key.trim().to_string() };
    let session = auth(&cfg, "password", json!({ "email": email.trim(), "password": password }))?;

    {
        let state = app.state::<SyncState>();
        let _one_at_a_time = state.running.lock().unwrap();
        let db = app.state::<Db>();
        let previous_user = db.sync_meta(K_USER_ID).map_err(msg)?;
        if previous_user.as_deref() != Some(session.user_id.as_str()) {
            match previous_user {
                None => db.enqueue_all().map_err(msg)?,
                Some(_) => db.wipe_local_data().map_err(msg)?,
            }
            // Pull everything the account has.
            for entity in Entity::ALL {
                db.set_sync_meta(&cursor_key(entity), None).map_err(msg)?;
            }
            db.set_sync_meta(K_TIMER, None).map_err(msg)?;
            db.set_sync_meta(K_PROFILE, None).map_err(msg)?;
            db.set_sync_meta(K_REFUSED, None).map_err(msg)?;
            db.set_sync_meta(K_USER_ID, Some(&session.user_id)).map_err(msg)?;
        }
        db.set_sync_meta(K_USER_EMAIL, Some(&session.email)).map_err(msg)?;
        store(&db, K_CONFIG, Some(&cfg))?;
        store(&db, K_SESSION, Some(&session))?;
    }
    run_cycle(app);
    Ok(status(app))
}

/// Signs this device out after one last sync. Local data stays, still
/// belonging to this account: changes made meanwhile are queued and go up
/// when the same account signs in again.
pub fn sign_out(app: &AppHandle) -> SyncResult<SyncStatus> {
    run_cycle(app); // best effort: if offline, changes stay queued
    {
        let state = app.state::<SyncState>();
        let _one_at_a_time = state.running.lock().unwrap();
        store::<Session>(&app.state::<Db>(), K_SESSION, None)?;
        *state.status.lock().unwrap() = SyncStatus::default();
    }
    Ok(status(app))
}

// ---------------------------------------------------------------- sharing

/// Runs one server call as the signed-in user, with its error in plain words.
fn as_signed_in<T>(app: &AppHandle, call: impl FnOnce(&Db, &Rest) -> SyncResult<T>) -> SyncResult<T> {
    let db = app.state::<Db>();
    let (Some(cfg), Some(session)) = (load::<Config>(&db, K_CONFIG), load::<Session>(&db, K_SESSION)) else {
        return Err("Sign in to Cloud sync first (Settings ☰ → Cloud sync).".into());
    };
    let session = fresh_session(&db, &cfg, session)?;
    call(&db, &Rest { cfg: &cfg, token: &session.access_token }).map_err(|e| plain_error(&e))
}

/// Drops the "Server error 400: " in front of a message written for the user.
fn plain_error(e: &str) -> String {
    match e.strip_prefix("Server error ").and_then(|rest| rest.split_once(": ")) {
        Some((_, detail)) => detail.to_string(),
        None => e.to_string(),
    }
}

pub fn set_display_name(app: &AppHandle, name: &str) -> SyncResult<SyncStatus> {
    as_signed_in(app, |db, rest| {
        store(db, K_PROFILE, Some(&rest.profile("set_display_name", json!({ "p_name": name }))?))
    })?;
    run_cycle(app); // so this device's member lists show the new name
    Ok(status(app))
}

pub fn add_member(app: &AppHandle, project_id: &str, share_code: &str) -> SyncResult<String> {
    run_cycle(app); // the server must have the project first
    let name = as_signed_in(app, |_, rest| {
        rest.rpc("add_member", json!({ "p_project_id": project_id, "p_share_code": share_code }))
    })?;
    run_cycle(app);
    Ok(name.as_str().unwrap_or_default().to_string())
}

pub fn remove_member(app: &AppHandle, project_id: &str, user_id: &str) -> SyncResult<()> {
    as_signed_in(app, |_, rest| {
        rest.rpc("remove_member", json!({ "p_project_id": project_id, "p_user_id": user_id }))
    })?;
    run_cycle(app);
    Ok(())
}

// Runs against real Postgres row-level security through the stand-in for
// PostgREST in supabase/test/. Skipped unless TT_E2E_URL is set: see the README there.
#[cfg(test)]
mod e2e;
