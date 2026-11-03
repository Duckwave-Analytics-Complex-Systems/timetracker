//! The local side of cloud sync: what to push, and applying what was pulled.
//! The network side (Supabase over HTTP, the background thread) is in
//! `src/sync.rs`; the server schema is in `supabase/schema.sql`.
//!
//! **Outbox.** SQLite triggers record the id of every project, feature, phase and
//! time entry that is inserted, updated or deleted into `sync_outbox`, so
//! none of the other db code needs to know about sync. A row that is missing
//! locally when pushed goes up as a tombstone (`deleted = true`). `seq` lets
//! the pusher acknowledge exactly what it sent: a row changed again while the
//! push was in flight keeps its outbox entry.
//!
//! **Mute.** While remote rows are applied, a row in `sync_mute` silences the
//! triggers, so pulled changes aren't echoed back.
//!
//! **Derived data.** `total_seconds` and `daily_totals` are never synced.
//! Applying a remote entry adjusts both by the difference it makes, exactly
//! like `pause_one` does when it books a session.
//!
//! **Sharing.** `time_entries.user_id` is NULL for your own time and otherwise
//! names the teammate. Their entries count in `total_seconds` but not in
//! `daily_totals`, which drives your Today and Stats, and never enter the
//! outbox. The active phase and feature are per person: they sync as
//! `member_state`, not on the project row. `project_members` is refreshed from
//! the server every cycle (`apply_members`).
//!
//! **Timer.** Not a row: see `reconcile_timer` and `push_timer()` in the
//! server schema.
//!
//! The companion Android app (a separate repository) implements these same
//! rules against the same server. Any change to what syncs, or how sessions
//! and timers are reconciled, must be made there too.

use super::days::{record_daily, unrecord_daily};
use super::timer::{entry_id, pause_one};
use super::Db;
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::Deserialize;
use serde_json::{json, Value};

/// Run on every launch (from `schema::migrate`). Idempotent.
/// The Android app creates identical tables and triggers.
pub(super) const SYNC_TABLES: &str = "
    CREATE TABLE IF NOT EXISTS sync_outbox (
        entity  TEXT NOT NULL,                   -- 'project' | 'feature' | 'phase' | 'member_state' | 'entry'
        id      TEXT NOT NULL,
        seq     INTEGER NOT NULL,
        PRIMARY KEY (entity, id)
    );
    CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sync_mute (muted INTEGER);

    CREATE TRIGGER IF NOT EXISTS sync_project_ins AFTER INSERT ON projects
    WHEN NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('project', NEW.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;
    -- Only synced columns: timer state, totals and the liveness stamp are not rows to push.
    -- Dropped first so existing databases pick up new columns in this list.
    DROP TRIGGER IF EXISTS sync_project_upd;
    CREATE TRIGGER sync_project_upd AFTER UPDATE OF
        name, hourly_rate, archived, archived_at, logo_data, people_count,
        description, start_day, due_day, budget_hours ON projects
    WHEN NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('project', NEW.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;
    -- Per person, so not on the project row. The outbox id is the project's.
    CREATE TRIGGER IF NOT EXISTS sync_member_state_upd AFTER UPDATE OF active_phase_id, active_feature_id ON projects
    WHEN NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('member_state', NEW.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;
    CREATE TRIGGER IF NOT EXISTS sync_project_del AFTER DELETE ON projects
    WHEN NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('project', OLD.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;

    CREATE TRIGGER IF NOT EXISTS sync_phase_ins AFTER INSERT ON phases
    WHEN NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('phase', NEW.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;
    CREATE TRIGGER IF NOT EXISTS sync_phase_upd AFTER UPDATE ON phases
    WHEN NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('phase', NEW.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;
    CREATE TRIGGER IF NOT EXISTS sync_phase_del AFTER DELETE ON phases
    WHEN NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('phase', OLD.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;

    CREATE TRIGGER IF NOT EXISTS sync_feature_ins AFTER INSERT ON features
    WHEN NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('feature', NEW.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;
    CREATE TRIGGER IF NOT EXISTS sync_feature_upd AFTER UPDATE ON features
    WHEN NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('feature', NEW.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;
    CREATE TRIGGER IF NOT EXISTS sync_feature_del AFTER DELETE ON features
    WHEN NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('feature', OLD.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;

    -- Only your own entries: a teammate's can't be changed from here. Dropped
    -- first so existing databases pick up the condition.
    DROP TRIGGER IF EXISTS sync_entry_ins;
    DROP TRIGGER IF EXISTS sync_entry_upd;
    DROP TRIGGER IF EXISTS sync_entry_del;
    CREATE TRIGGER sync_entry_ins AFTER INSERT ON time_entries
    WHEN NEW.user_id IS NULL AND NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('entry', NEW.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;
    CREATE TRIGGER sync_entry_upd AFTER UPDATE ON time_entries
    WHEN NEW.user_id IS NULL AND NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('entry', NEW.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;
    CREATE TRIGGER sync_entry_del AFTER DELETE ON time_entries
    WHEN OLD.user_id IS NULL AND NOT EXISTS (SELECT 1 FROM sync_mute) BEGIN
        INSERT OR REPLACE INTO sync_outbox VALUES ('entry', OLD.id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM sync_outbox));
    END;
";

/// A synced table: the outbox entity name and the server table name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Entity {
    Project,
    Feature,
    Phase,
    MemberState,
    Entry,
}

impl Entity {
    /// Push and pull order: parents first.
    pub const ALL: [Entity; 5] = [Entity::Project, Entity::Feature, Entity::Phase, Entity::MemberState, Entity::Entry];

    pub fn key(self) -> &'static str {
        match self {
            Entity::Project => "project",
            Entity::Feature => "feature",
            Entity::Phase => "phase",
            Entity::MemberState => "member_state",
            Entity::Entry => "entry",
        }
    }

    pub fn table(self) -> &'static str {
        match self {
            Entity::Project => "projects",
            Entity::Feature => "features",
            Entity::Phase => "phases",
            Entity::MemberState => "member_state",
            Entity::Entry => "time_entries",
        }
    }
}

/// One person in a project, from the server's `my_memberships()`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Member {
    pub project_id: String,
    pub user_id: String,
    pub role: String,
    pub display_name: String,
}

/// A row of the "Hours by person" table. `user_id` is `None` for time tracked
/// by people who have since left the project, added up as one row.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MemberHours {
    pub user_id: Option<String>,
    pub display_name: String,
    pub role: String,
    pub is_me: bool,
    pub seconds: i64,
}

/// One outbox entry ready to push. `row` is `None` for a tombstone.
#[derive(Debug)]
pub struct Pending {
    pub id: String,
    pub seq: i64,
    pub row: Option<Value>,
}

/// The server's `timers` row (see `push_timer()` in supabase/schema.sql).
#[derive(Debug, Clone, Default, PartialEq, Deserialize, serde::Serialize)]
pub struct RemoteTimer {
    pub project_id: Option<String>,
    pub phase_id: Option<String>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub running: bool,
    pub device_id: Option<String>,
}

impl RemoteTimer {
    /// True if this row describes `project_id`'s session that started at `started_at`.
    pub fn is_session(&self, project_id: &str, started_at: i64) -> bool {
        self.project_id.as_deref() == Some(project_id) && self.started_at == Some(started_at)
    }
}

/// The session running on this machine's copy of the data.
#[derive(Debug, Clone, PartialEq)]
pub struct LocalTimer {
    pub project_id: String,
    pub started_at: i64,
    pub phase_id: Option<String>,
}

/// What this device must tell the server about its timer.
#[derive(Debug, Clone, PartialEq)]
pub enum TimerPush {
    Start { project_id: String, phase_id: Option<String>, started_at: i64 },
    Stop { project_id: String, started_at: i64, ended_at: i64 },
}

// ---------------------------------------------------------------- JSON helpers

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}
fn i(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)))
}
fn f(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}
fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

fn is_pending(conn: &Connection, entity: Entity, id: &str) -> SqlResult<bool> {
    conn.query_row(
        "SELECT 1 FROM sync_outbox WHERE entity = ?1 AND id = ?2",
        params![entity.key(), id],
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
}

/// The account this device's data belongs to.
fn linked_user(conn: &Connection) -> SqlResult<Option<String>> {
    conn.query_row("SELECT value FROM sync_meta WHERE key = 'user_id'", [], |r| r.get(0)).optional()
}

fn project_exists(conn: &Connection, id: &str) -> SqlResult<bool> {
    conn.query_row("SELECT 1 FROM projects WHERE id = ?1", params![id], |_| Ok(()))
        .optional()
        .map(|r| r.is_some())
}

/// Runs `f` in a transaction with the outbox triggers silenced.
fn muted<T>(conn: &mut Connection, f: impl FnOnce(&Connection) -> SqlResult<T>) -> SqlResult<T> {
    let tx = conn.transaction()?;
    tx.execute("INSERT INTO sync_mute (muted) VALUES (1)", [])?;
    let out = f(&tx)?;
    tx.execute("DELETE FROM sync_mute", [])?;
    tx.commit()?;
    Ok(out)
}

// ---------------------------------------------------------------- local rows as JSON

fn row_json(conn: &Connection, entity: Entity, id: &str) -> SqlResult<Option<Value>> {
    match entity {
        Entity::Project => conn
            .query_row(
                "SELECT id, name, hourly_rate, created_at, archived, archived_at, logo_data, people_count,
                        description, start_day, due_day, budget_hours
                 FROM projects WHERE id = ?1",
                params![id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "name": r.get::<_, String>(1)?,
                        "hourly_rate": r.get::<_, f64>(2)?,
                        "created_at": r.get::<_, i64>(3)?,
                        "archived": r.get::<_, i64>(4)? != 0,
                        "archived_at": r.get::<_, Option<i64>>(5)?,
                        "logo_data": r.get::<_, Option<String>>(6)?,
                        "people_count": r.get::<_, i64>(7)?,
                        "description": r.get::<_, Option<String>>(8)?,
                        "start_day": r.get::<_, Option<String>>(9)?,
                        "due_day": r.get::<_, Option<String>>(10)?,
                        "budget_hours": r.get::<_, Option<f64>>(11)?,
                        "deleted": false,
                    }))
                },
            )
            .optional(),
        Entity::Feature => conn
            .query_row(
                "SELECT id, project_id, name, color, sort_order, created_at
                 FROM features WHERE id = ?1",
                params![id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "project_id": r.get::<_, String>(1)?,
                        "name": r.get::<_, String>(2)?,
                        "color": r.get::<_, i64>(3)?,
                        "sort_order": r.get::<_, i64>(4)?,
                        "created_at": r.get::<_, i64>(5)?,
                        "deleted": false,
                    }))
                },
            )
            .optional(),
        Entity::Phase => conn
            .query_row(
                "SELECT id, project_id, name, kind, color, start_day, end_day, estimated_hours,
                        progress, sort_order, created_at
                 FROM phases WHERE id = ?1",
                params![id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "project_id": r.get::<_, String>(1)?,
                        "name": r.get::<_, String>(2)?,
                        "kind": r.get::<_, String>(3)?,
                        "color": r.get::<_, i64>(4)?,
                        "start_day": r.get::<_, String>(5)?,
                        "end_day": r.get::<_, String>(6)?,
                        "estimated_hours": r.get::<_, f64>(7)?,
                        "progress": r.get::<_, i64>(8)?,
                        "sort_order": r.get::<_, i64>(9)?,
                        "created_at": r.get::<_, i64>(10)?,
                        "deleted": false,
                    }))
                },
            )
            .optional(),
        // A project that's gone has no state to send: `row` is None, and the
        // pusher sends no tombstone for this entity.
        Entity::MemberState => {
            let user = linked_user(conn)?.unwrap_or_default();
            conn.query_row(
                "SELECT id, active_phase_id, active_feature_id FROM projects WHERE id = ?1",
                params![id],
                |r| {
                    let project_id: String = r.get(0)?;
                    Ok(json!({
                        "id": format!("{project_id}:{user}"),
                        "project_id": project_id,
                        "active_phase_id": r.get::<_, Option<String>>(1)?,
                        "active_feature_id": r.get::<_, Option<String>>(2)?,
                        "deleted": false,
                    }))
                },
            )
            .optional()
        }
        Entity::Entry => conn
            .query_row(
                "SELECT id, project_id, start_ts, end_ts, seconds, phase_id, feature_id, note FROM time_entries WHERE id = ?1",
                params![id],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "project_id": r.get::<_, String>(1)?,
                        "start_ts": r.get::<_, i64>(2)?,
                        "end_ts": r.get::<_, i64>(3)?,
                        "seconds": r.get::<_, i64>(4)?,
                        "phase_id": r.get::<_, Option<String>>(5)?,
                        "feature_id": r.get::<_, Option<String>>(6)?,
                        "note": r.get::<_, Option<String>>(7)?,
                        "deleted": false,
                    }))
                },
            )
            .optional(),
    }
}

// ---------------------------------------------------------------- applying remote rows

/// Adds (`sign = 1`) or removes (`sign = -1`) a booked span from the derived
/// totals. `daily_totals` counts only your own time.
fn adjust_totals(conn: &Connection, project_id: &str, start_ts: i64, seconds: i64, sign: i64, mine: bool) -> SqlResult<()> {
    conn.execute(
        "UPDATE projects SET total_seconds = MAX(0, total_seconds + ?1) WHERE id = ?2",
        params![sign * seconds, project_id],
    )?;
    if !mine {
        Ok(())
    } else if sign > 0 {
        record_daily(conn, project_id, start_ts / 1000, seconds)
    } else {
        unrecord_daily(conn, project_id, start_ts / 1000, seconds)
    }
}

fn apply_project(conn: &Connection, v: &Value) -> SqlResult<bool> {
    let Some(id) = s(v, "id") else { return Ok(false) };
    if is_pending(conn, Entity::Project, &id)? {
        return Ok(false); // ours is newer and goes up next
    }
    if b(v, "deleted") {
        // Entries, daily rows, phases and features go with it (ON DELETE CASCADE).
        return Ok(conn.execute("DELETE FROM projects WHERE id = ?1", params![id])? > 0);
    }
    conn.execute(
        "INSERT INTO projects (id, name, hourly_rate, created_at, archived, archived_at, logo_data,
                               people_count, description, start_day, due_day, budget_hours)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name, hourly_rate = excluded.hourly_rate, created_at = excluded.created_at,
            archived = excluded.archived, archived_at = excluded.archived_at, logo_data = excluded.logo_data,
            people_count = excluded.people_count, description = excluded.description,
            start_day = excluded.start_day, due_day = excluded.due_day,
            budget_hours = excluded.budget_hours",
        params![
            id,
            s(v, "name").unwrap_or_default(),
            f(v, "hourly_rate").unwrap_or(0.0),
            i(v, "created_at").unwrap_or(0),
            b(v, "archived") as i64,
            i(v, "archived_at"),
            s(v, "logo_data"),
            i(v, "people_count").unwrap_or(1).max(1),
            s(v, "description"),
            s(v, "start_day"),
            s(v, "due_day"),
            f(v, "budget_hours"),
        ],
    )?;
    Ok(true)
}

fn apply_feature(conn: &Connection, v: &Value) -> SqlResult<bool> {
    let Some(id) = s(v, "id") else { return Ok(false) };
    if is_pending(conn, Entity::Feature, &id)? {
        return Ok(false);
    }
    if b(v, "deleted") {
        // Same as `Db::delete_feature`: its time becomes unassigned.
        conn.execute("UPDATE projects SET active_feature_id = NULL WHERE active_feature_id = ?1", params![id])?;
        conn.execute("UPDATE time_entries SET feature_id = NULL WHERE feature_id = ?1", params![id])?;
        return Ok(conn.execute("DELETE FROM features WHERE id = ?1", params![id])? > 0);
    }
    let Some(project_id) = s(v, "project_id") else { return Ok(false) };
    if !project_exists(conn, &project_id)? {
        return Ok(false); // its project was deleted here
    }
    conn.execute(
        "INSERT INTO features (id, project_id, name, color, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id, name = excluded.name, color = excluded.color,
            sort_order = excluded.sort_order, created_at = excluded.created_at",
        params![
            id,
            project_id,
            s(v, "name").unwrap_or_default(),
            i(v, "color").unwrap_or(0),
            i(v, "sort_order").unwrap_or(0),
            i(v, "created_at").unwrap_or(0),
        ],
    )?;
    Ok(true)
}

fn apply_phase(conn: &Connection, v: &Value) -> SqlResult<bool> {
    let Some(id) = s(v, "id") else { return Ok(false) };
    if is_pending(conn, Entity::Phase, &id)? {
        return Ok(false);
    }
    if b(v, "deleted") {
        // Same as `Db::delete_phase`: its time becomes unassigned.
        conn.execute("UPDATE projects SET active_phase_id = NULL WHERE active_phase_id = ?1", params![id])?;
        conn.execute("UPDATE time_entries SET phase_id = NULL WHERE phase_id = ?1", params![id])?;
        return Ok(conn.execute("DELETE FROM phases WHERE id = ?1", params![id])? > 0);
    }
    let Some(project_id) = s(v, "project_id") else { return Ok(false) };
    if !project_exists(conn, &project_id)? {
        return Ok(false); // its project was deleted here
    }
    conn.execute(
        "INSERT INTO phases (id, project_id, name, kind, color, start_day, end_day,
                             estimated_hours, progress, sort_order, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id, name = excluded.name, kind = excluded.kind,
            color = excluded.color, start_day = excluded.start_day, end_day = excluded.end_day,
            estimated_hours = excluded.estimated_hours, progress = excluded.progress,
            sort_order = excluded.sort_order, created_at = excluded.created_at",
        params![
            id,
            project_id,
            s(v, "name").unwrap_or_default(),
            s(v, "kind").unwrap_or_else(|| "phase".into()),
            i(v, "color").unwrap_or(0),
            s(v, "start_day").unwrap_or_default(),
            s(v, "end_day").unwrap_or_default(),
            f(v, "estimated_hours").unwrap_or(0.0),
            i(v, "progress").unwrap_or(0),
            i(v, "sort_order").unwrap_or(0),
            i(v, "created_at").unwrap_or(0),
        ],
    )?;
    Ok(true)
}

/// Your active phase and feature, as chosen on another of your devices.
fn apply_member_state(conn: &Connection, v: &Value) -> SqlResult<bool> {
    let Some(project_id) = s(v, "project_id") else { return Ok(false) };
    if b(v, "deleted") || is_pending(conn, Entity::MemberState, &project_id)? {
        return Ok(false);
    }
    let changed = conn.execute(
        "UPDATE projects SET active_phase_id = ?1, active_feature_id = ?2
         WHERE id = ?3 AND (active_phase_id IS NOT ?1 OR active_feature_id IS NOT ?2)",
        params![s(v, "active_phase_id"), s(v, "active_feature_id"), project_id],
    )?;
    Ok(changed > 0)
}

fn apply_entry(conn: &Connection, v: &Value) -> SqlResult<bool> {
    let Some(id) = s(v, "id") else { return Ok(false) };
    if is_pending(conn, Entity::Entry, &id)? {
        return Ok(false);
    }
    #[allow(clippy::type_complexity)]
    let old: Option<(String, i64, i64, Option<String>, Option<String>, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT project_id, start_ts, seconds, phase_id, feature_id, note, user_id FROM time_entries WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()?;

    if b(v, "deleted") {
        let Some((project_id, start_ts, seconds, _, _, _, user)) = old else { return Ok(false) };
        adjust_totals(conn, &project_id, start_ts, seconds, -1, user.is_none())?;
        conn.execute("DELETE FROM time_entries WHERE id = ?1", params![id])?;
        return Ok(true);
    }

    let (Some(project_id), Some(start_ts), Some(end_ts), Some(seconds)) =
        (s(v, "project_id"), i(v, "start_ts"), i(v, "end_ts"), i(v, "seconds"))
    else {
        return Ok(false);
    };
    if !project_exists(conn, &project_id)? {
        return Ok(false);
    }
    let phase_id = s(v, "phase_id");
    let feature_id = s(v, "feature_id");
    let note = s(v, "note");
    // NULL means it's yours.
    let user = s(v, "user_id").filter(|u| Some(u) != linked_user(conn).ok().flatten().as_ref());
    match old {
        Some(o) if o == (project_id.clone(), start_ts, seconds, phase_id.clone(), feature_id.clone(), note.clone(), user.clone()) => return Ok(false),
        Some((old_project, old_start, old_seconds, _, _, _, old_user)) => {
            if (old_project.as_str(), old_start, old_seconds) != (project_id.as_str(), start_ts, seconds) || old_user != user {
                adjust_totals(conn, &old_project, old_start, old_seconds, -1, old_user.is_none())?;
                adjust_totals(conn, &project_id, start_ts, seconds, 1, user.is_none())?;
            }
            conn.execute(
                "UPDATE time_entries SET project_id = ?1, start_ts = ?2, end_ts = ?3, seconds = ?4, phase_id = ?5,
                                         feature_id = ?6, note = ?7, user_id = ?8
                 WHERE id = ?9",
                params![project_id, start_ts, end_ts, seconds, phase_id, feature_id, note, user, id],
            )?;
        }
        None => {
            conn.execute(
                "INSERT INTO time_entries (id, project_id, start_ts, end_ts, seconds, phase_id, feature_id, note, user_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![id, project_id, start_ts, end_ts, seconds, phase_id, feature_id, note, user],
            )?;
            adjust_totals(conn, &project_id, start_ts, seconds, 1, user.is_none())?;
        }
    }
    Ok(true)
}

// ---------------------------------------------------------------- timer

fn local_timer(conn: &Connection) -> SqlResult<Option<LocalTimer>> {
    conn.query_row(
        "SELECT id, run_started_at, active_phase_id FROM projects
         WHERE is_running = 1 AND run_started_at IS NOT NULL
         ORDER BY run_started_at DESC LIMIT 1",
        [],
        |r| Ok(LocalTimer { project_id: r.get(0)?, started_at: r.get(1)?, phase_id: r.get(2)? }),
    )
    .optional()
}

impl Db {
    // ---- metadata (config, session, cursors, device id)

    pub fn sync_meta(&self, key: &str) -> SqlResult<Option<String>> {
        self.conn()
            .query_row("SELECT value FROM sync_meta WHERE key = ?1", params![key], |r| r.get(0))
            .optional()
    }

    pub fn set_sync_meta(&self, key: &str, value: Option<&str>) -> SqlResult<()> {
        let conn = self.conn();
        match value {
            Some(v) => conn.execute(
                "INSERT INTO sync_meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, v],
            )?,
            None => conn.execute("DELETE FROM sync_meta WHERE key = ?1", params![key])?,
        };
        Ok(())
    }

    /// Forgets every project, feature, phase and tracked session on this device, and
    /// anything queued for upload. Used when a different account signs in:
    /// the old account keeps its copy on the server, and nothing here is
    /// sent as a delete.
    pub fn wipe_local_data(&self) -> SqlResult<()> {
        let mut conn = self.conn();
        muted(&mut conn, |c| {
            c.execute_batch(
                "DELETE FROM time_entries; DELETE FROM daily_totals; DELETE FROM phases; DELETE FROM features;
                 DELETE FROM projects; DELETE FROM sync_outbox;",
            )
        })
    }

    /// Local changes not yet on the server.
    pub fn unsynced_changes(&self) -> SqlResult<i64> {
        self.conn().query_row("SELECT COUNT(*) FROM sync_outbox", [], |r| r.get(0))
    }

    /// Queues every local row for upload. Called when a device is linked to
    /// an account for the first time, so data from before sync goes up too.
    pub fn enqueue_all(&self) -> SqlResult<()> {
        self.conn().execute_batch(
            "INSERT OR IGNORE INTO sync_outbox (entity, id, seq) SELECT 'project', id, 0 FROM projects;
             INSERT OR IGNORE INTO sync_outbox (entity, id, seq) SELECT 'feature', id, 0 FROM features;
             INSERT OR IGNORE INTO sync_outbox (entity, id, seq) SELECT 'phase', id, 0 FROM phases;
             INSERT OR IGNORE INTO sync_outbox (entity, id, seq) SELECT 'member_state', id, 0 FROM projects;
             INSERT OR IGNORE INTO sync_outbox (entity, id, seq) SELECT 'entry', id, 0 FROM time_entries;",
        )
    }

    // ---- push

    /// Up to `limit` queued changes of one entity, oldest first.
    pub fn pending(&self, entity: Entity, limit: usize) -> SqlResult<Vec<Pending>> {
        let conn = self.conn();
        let queued: Vec<(String, i64)> = conn
            .prepare("SELECT id, seq FROM sync_outbox WHERE entity = ?1 ORDER BY seq LIMIT ?2")?
            .query_map(params![entity.key(), limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<SqlResult<_>>()?;
        queued
            .into_iter()
            .map(|(id, seq)| Ok(Pending { row: row_json(&conn, entity, &id)?, id, seq }))
            .collect()
    }

    /// Forgets queued changes that the server now has, unless they changed
    /// again since they were read.
    pub fn ack(&self, entity: Entity, sent: &[Pending]) -> SqlResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for p in sent {
            tx.execute(
                "DELETE FROM sync_outbox WHERE entity = ?1 AND id = ?2 AND seq = ?3",
                params![entity.key(), p.id, p.seq],
            )?;
        }
        tx.commit()
    }

    // ---- pull

    /// Applies rows pulled from the server. Returns true if anything changed.
    pub fn apply_remote(&self, entity: Entity, rows: &[Value]) -> SqlResult<bool> {
        let mut conn = self.conn();
        muted(&mut conn, |c| {
            let mut changed = false;
            for v in rows {
                changed |= match entity {
                    Entity::Project => apply_project(c, v)?,
                    Entity::Feature => apply_feature(c, v)?,
                    Entity::Phase => apply_phase(c, v)?,
                    Entity::MemberState => apply_member_state(c, v)?,
                    Entity::Entry => apply_entry(c, v)?,
                };
            }
            Ok(changed)
        })
    }

    // ---- members

    /// Projects whose members are known here, so a project that's new in
    /// `my_memberships()` can be told apart and its history fetched.
    pub fn member_projects(&self) -> SqlResult<Vec<String>> {
        self.conn()
            .prepare("SELECT DISTINCT project_id FROM project_members")?
            .query_map([], |r| r.get(0))?
            .collect()
    }

    /// Replaces the member lists with the server's. A project you were in and no
    /// longer are (removed, left or deleted) is forgotten here, and nothing about
    /// that goes up: its time stays on the server. Returns true if anything changed.
    pub fn apply_members(&self, members: &[Member]) -> SqlResult<bool> {
        let mut conn = self.conn();
        muted(&mut conn, |c| {
            let known: Vec<String> = c
                .prepare("SELECT DISTINCT project_id FROM project_members")?
                .query_map([], |r| r.get(0))?
                .collect::<SqlResult<_>>()?;
            let mut changed = false;
            for project_id in known.iter().filter(|p| !members.iter().any(|m| &m.project_id == *p)) {
                changed |= c.execute("DELETE FROM projects WHERE id = ?1", params![project_id])? > 0;
                c.execute("DELETE FROM sync_outbox WHERE entity IN ('project', 'member_state') AND id = ?1", params![project_id])?;
            }
            let before: i64 = c.query_row("SELECT COUNT(*) FROM project_members", [], |r| r.get(0))?;
            let mut same = true;
            for m in members {
                same &= c.query_row(
                    "SELECT 1 FROM project_members WHERE project_id = ?1 AND user_id = ?2 AND role = ?3 AND display_name = ?4",
                    params![m.project_id, m.user_id, m.role, m.display_name],
                    |_| Ok(()),
                ).optional()?.is_some() || !project_exists(c, &m.project_id)?;
            }
            c.execute("DELETE FROM project_members", [])?;
            for m in members {
                if project_exists(c, &m.project_id)? {
                    c.execute(
                        "INSERT INTO project_members (project_id, user_id, role, display_name) VALUES (?1, ?2, ?3, ?4)",
                        params![m.project_id, m.user_id, m.role, m.display_name],
                    )?;
                }
            }
            let after: i64 = c.query_row("SELECT COUNT(*) FROM project_members", [], |r| r.get(0))?;
            Ok(changed || !same || before != after)
        })
    }

    /// Who has worked on a project, for the Team tab: every member, plus one row
    /// for anyone who has left. Empty if the project has never synced.
    pub fn member_hours(&self, project_id: &str) -> SqlResult<Vec<MemberHours>> {
        let conn = self.conn();
        let me = linked_user(&conn)?;
        let mut rows: Vec<MemberHours> = conn
            .prepare(
                "SELECT m.user_id, m.display_name, m.role,
                        (SELECT COALESCE(SUM(e.seconds), 0) FROM time_entries e WHERE e.project_id = m.project_id
                         AND COALESCE(e.user_id, ?2) = m.user_id)
                 FROM project_members m WHERE m.project_id = ?1 ORDER BY m.role DESC, m.display_name",
            )?
            .query_map(params![project_id, me], |r| {
                let user_id: String = r.get(0)?;
                Ok(MemberHours {
                    is_me: Some(&user_id) == me.as_ref(),
                    user_id: Some(user_id),
                    display_name: r.get(1)?,
                    role: r.get(2)?,
                    seconds: r.get(3)?,
                })
            })?
            .collect::<SqlResult<_>>()?;
        if !rows.is_empty() {
            let total: i64 = conn.query_row(
                "SELECT COALESCE(SUM(seconds), 0) FROM time_entries WHERE project_id = ?1",
                params![project_id],
                |r| r.get(0),
            )?;
            let former = total - rows.iter().map(|m| m.seconds).sum::<i64>();
            if former > 0 {
                rows.push(MemberHours {
                    user_id: None,
                    display_name: "Former members".into(),
                    role: "former".into(),
                    is_me: false,
                    seconds: former,
                });
            }
        }
        Ok(rows)
    }

    /// Books a session still running on a project filed since it started (by the
    /// owner, on another device), so a timer can't keep counting out of sight.
    /// Not muted: it's a session the server must get. Returns true if one closed.
    pub fn stop_filed_timers(&self, now: i64) -> SqlResult<bool> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let running: Vec<String> = tx
            .prepare("SELECT id FROM projects WHERE is_running = 1 AND archived = 1")?
            .query_map([], |r| r.get(0))?
            .collect::<SqlResult<_>>()?;
        for id in &running {
            pause_one(&tx, id, now)?;
        }
        tx.commit()?;
        Ok(!running.is_empty())
    }

    /// Whether this device's user owns a project. True for one never synced.
    pub fn is_owner(&self, project_id: &str) -> SqlResult<bool> {
        let conn = self.conn();
        let me = linked_user(&conn)?;
        let role: Option<String> = conn
            .query_row(
                "SELECT role FROM project_members WHERE project_id = ?1 AND user_id = ?2",
                params![project_id, me],
                |r| r.get(0),
            )
            .optional()?;
        Ok(role.map_or(true, |r| r == "owner"))
    }

    // ---- timer

    /// What, if anything, the server must hear about this device's timer,
    /// given `known`, the server row as of the last sync.
    pub fn timer_push(&self, known: Option<&RemoteTimer>, now: i64) -> SqlResult<Option<TimerPush>> {
        let conn = self.conn();
        let local = local_timer(&conn)?;
        let known_running = known.filter(|k| k.running);
        Ok(match (local, known_running) {
            (Some(l), k) if !k.is_some_and(|k| k.is_session(&l.project_id, l.started_at)) => Some(TimerPush::Start {
                project_id: l.project_id,
                phase_id: l.phase_id,
                started_at: l.started_at,
            }),
            (None, Some(k)) => {
                // The known session isn't running here any more: it was stopped here.
                let (Some(project_id), Some(started_at)) = (k.project_id.clone(), k.started_at) else {
                    return Ok(None);
                };
                if !project_exists(&conn, &project_id)? {
                    return Ok(None); // never arrived here, or deleted: nothing to stop
                }
                let ended_at: Option<i64> = conn
                    .query_row(
                        "SELECT end_ts FROM time_entries WHERE id = ?1",
                        params![entry_id(&conn, &project_id, started_at)?],
                        |r| r.get(0),
                    )
                    .optional()?;
                Some(TimerPush::Stop { project_id, started_at, ended_at: ended_at.unwrap_or(started_at.min(now)) })
            }
            _ => None,
        })
    }

    /// Makes the local timer agree with the server's row `r`. A newer start
    /// always wins; a session that lost is booked up to the moment the winner
    /// started (or, if it was stopped elsewhere, to when it was stopped).
    /// `own_device` marks sessions this device started. Returns true if
    /// anything changed.
    pub fn reconcile_timer(&self, r: &RemoteTimer, own_device: &str, now: i64) -> SqlResult<bool> {
        let mut conn = self.conn();
        // Not muted: sessions booked here are entries the server must get.
        let tx = conn.transaction()?;
        let local = local_timer(&tx)?;
        let mut changed = false;

        match (r.running, r.project_id.as_deref(), r.started_at, local) {
            (true, Some(rp), Some(rs), local) => {
                if let Some(l) = &local {
                    if l.project_id == rp && l.started_at == rs {
                        return Ok(false); // already agree
                    }
                    if l.started_at > rs {
                        return Ok(false); // ours is newer; it goes up next sync
                    }
                    pause_one(&tx, &l.project_id, rs.max(l.started_at))?;
                    changed = true;
                }
                let device = r.device_id.as_deref().filter(|d| *d != own_device);
                let adopted = tx.execute(
                    "UPDATE projects SET is_running = 1, run_started_at = ?1, last_alive_at = ?2,
                                         run_device = ?3, active_phase_id = ?4
                     WHERE id = ?5 AND is_running = 0",
                    params![rs, now, device, r.phase_id, rp],
                )?;
                changed |= adopted > 0;
            }
            (false, rp, rs, Some(l)) => {
                if rp == Some(l.project_id.as_str()) && rs == Some(l.started_at) {
                    // Stopped on another device.
                    let end = r.ended_at.unwrap_or(now).max(l.started_at);
                    pause_one(&tx, &l.project_id, end)?;
                    changed = true;
                } else if rs.is_some_and(|rs| l.started_at <= rs) {
                    // A newer session has already come and gone elsewhere.
                    let end = rs.unwrap().max(l.started_at);
                    pause_one(&tx, &l.project_id, end)?;
                    changed = true;
                }
                // Otherwise ours is newer; it goes up next sync.
            }
            _ => {}
        }
        tx.commit()?;
        Ok(changed)
    }
}
