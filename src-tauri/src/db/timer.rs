//! The timer.
//!
//! A running timer is just `is_running = 1` plus `run_started_at`. Nothing is
//! written while it runs except a cheap `last_alive_at` stamp (see
//! `watchdog.rs`). When the session closes (pause, switching project,
//! switching phase, archiving, sleep, app exit) `pause_one` books it in a
//! single step: `total_seconds`, one `time_entries` row, and the per-day
//! ledger.
//!
//! If the app dies without closing the session (crash, kill, power loss,
//! Windows shutdown), `recover_interrupted_runs` closes it on the next
//! launch at `last_alive_at`, the last moment the app was known to be
//! running. Time while the app was closed is never billed.

use super::days::{record_daily, unrecord_daily};
use super::Db;
use rusqlite::{params, Connection, OptionalExtension, Result as SqlResult};
use serde::Serialize;

/// A session that was still open when the app last died, and was closed on
/// this launch.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct RecoveredRun {
    pub project_id: String,
    pub project_name: String,
    pub started_at: i64,
    pub stopped_at: i64,
    pub seconds: i64,
}

/// A session closed by the user, so the frontend can ask what was done in it.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ClosedSession {
    pub entry_id: String,
    pub project_id: String,
    pub project_name: String,
    pub seconds: i64,
    pub note: Option<String>,
}

/// One closed session, as the History tab and the report show it.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Session {
    pub id: String,
    pub start_ts: i64,
    pub end_ts: i64,
    pub seconds: i64,
    pub phase_id: Option<String>,
    pub feature_id: Option<String>,
    pub note: Option<String>,
    /// False for a teammate's session, which can't be edited here.
    pub mine: bool,
    /// Who tracked it, for a project with more than one person.
    pub user_name: Option<String>,
}

/// A note from a form: trimmed, and empty means no note.
fn clean_note(note: Option<&str>) -> Option<&str> {
    note.map(str::trim).filter(|n| !n.is_empty())
}

/// The id of the time entry a session is booked as. Deterministic, so when two
/// synced devices both close the same session they write the same row.
/// The Android app builds ids the same way; the format must never change.
pub fn session_id(project_id: &str, started_at: i64) -> String {
    format!("{project_id}@{started_at}")
}

/// The id your session is booked under. On a shared project the id includes you,
/// so two people who start in the same millisecond don't share a row.
pub(super) fn entry_id(conn: &Connection, project_id: &str, started_at: i64) -> SqlResult<String> {
    let shared_as: Option<String> = conn
        .query_row(
            "SELECT value FROM sync_meta WHERE key = 'user_id'
             AND (SELECT COUNT(*) FROM project_members WHERE project_id = ?1) > 1",
            params![project_id],
            |r| r.get(0),
        )
        .optional()?;
    let id = session_id(project_id, started_at);
    Ok(shared_as.map_or(id.clone(), |user| format!("{id}@{user}")))
}

/// Closes the open session of one project as of `end` (ms). Returns the
/// seconds booked. Does nothing if the project isn't running, and books
/// nothing if this session is already booked (it arrived from another device).
pub(super) fn pause_one(conn: &Connection, id: &str, end: i64) -> SqlResult<i64> {
    #[allow(clippy::type_complexity)]
    let (running, started_at, phase_id, feature_id, note): (bool, Option<i64>, Option<String>, Option<String>, Option<String>) = conn.query_row(
        "SELECT is_running, run_started_at, active_phase_id, active_feature_id, run_note FROM projects WHERE id = ?1",
        params![id],
        |r| Ok((r.get::<_, i64>(0)? != 0, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
    )?;
    if !running {
        return Ok(0);
    }
    let elapsed = started_at.map(|s| ((end - s) / 1000).max(0)).unwrap_or(0);
    conn.execute(
        "UPDATE projects SET is_running = 0, run_started_at = NULL, last_alive_at = NULL, run_device = NULL, run_note = NULL
         WHERE id = ?1",
        params![id],
    )?;
    if let (Some(start), true) = (started_at, elapsed > 0) {
        let entry = entry_id(conn, id, start)?;
        let booked = conn.execute(
            "INSERT OR IGNORE INTO time_entries (id, project_id, start_ts, end_ts, seconds, phase_id, feature_id, note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![entry, id, start, start + elapsed * 1000, elapsed, phase_id, feature_id, note],
        )?;
        if booked == 1 {
            conn.execute(
                "UPDATE projects SET total_seconds = total_seconds + ?1 WHERE id = ?2",
                params![elapsed, id],
            )?;
            record_daily(conn, id, start / 1000, elapsed)?;
        } else if note.is_some() {
            // Another device booked it first: keep the note written here.
            conn.execute(
                "UPDATE time_entries SET note = ?1 WHERE id = ?2 AND note IS NULL",
                params![note, entry],
            )?;
        }
    }
    Ok(elapsed)
}

/// Closes every open session as of `now`, wherever it was started. Returns
/// the ids that were running.
pub(super) fn pause_all(conn: &Connection, now: i64) -> SqlResult<Vec<String>> {
    pause_where(conn, now, "is_running = 1")
}

/// Closes only sessions started on this device. Exit, sleep and crash
/// recovery use this: a timer started on the phone keeps running when the
/// desktop app closes.
fn pause_own(conn: &Connection, now: i64) -> SqlResult<Vec<String>> {
    pause_where(conn, now, "is_running = 1 AND run_device IS NULL")
}

fn pause_where(conn: &Connection, now: i64, filter: &str) -> SqlResult<Vec<String>> {
    let running: Vec<String> = conn
        .prepare(&format!("SELECT id FROM projects WHERE {filter}"))?
        .query_map([], |r| r.get(0))?
        .collect::<SqlResult<_>>()?;
    for id in &running {
        pause_one(conn, id, now)?;
    }
    Ok(running)
}

/// Closes every open session as of `now`, reporting the ones that booked time.
fn close_all(conn: &Connection, now: i64) -> SqlResult<Vec<ClosedSession>> {
    let open: Vec<(String, String, i64)> = conn
        .prepare("SELECT id, name, run_started_at FROM projects WHERE is_running = 1 AND run_started_at IS NOT NULL")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<SqlResult<_>>()?;
    let mut closed = Vec::new();
    for (project_id, project_name, started_at) in open {
        let seconds = pause_one(conn, &project_id, now)?;
        if seconds > 0 {
            let entry = entry_id(conn, &project_id, started_at)?;
            let note = conn.query_row("SELECT note FROM time_entries WHERE id = ?1", params![entry], |r| r.get(0))?;
            closed.push(ClosedSession { entry_id: entry, project_id, project_name, seconds, note });
        }
    }
    pause_all(conn, now)?; // a running row with no start time books nothing
    Ok(closed)
}

fn start(conn: &Connection, id: &str, now: i64) -> SqlResult<()> {
    conn.execute(
        "UPDATE projects SET is_running = 1, run_started_at = ?1, last_alive_at = ?1, run_device = NULL, run_note = NULL
         WHERE id = ?2 AND archived = 0",
        params![now, id],
    )?;
    Ok(())
}

impl Db {
    /// Starts `id`. Whatever else was running is paused first in the same
    /// transaction: this is the one place "only one timer at a time" is enforced.
    /// Returns the sessions that closed.
    pub fn start_project(&self, id: &str, now: i64) -> SqlResult<Vec<ClosedSession>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let closed = close_all(&tx, now)?;
        start(&tx, id, now)?;
        tx.commit()?;
        Ok(closed)
    }

    /// The Pause button: stops the timer wherever it was started and reports what closed.
    pub fn stop_timer(&self, now: i64) -> SqlResult<Vec<ClosedSession>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let closed = close_all(&tx, now)?;
        tx.commit()?;
        Ok(closed)
    }

    /// Sets the note of the open session. It is booked when the session closes,
    /// however it closes. Does nothing if the project has stopped meanwhile.
    pub fn set_run_note(&self, project_id: &str, note: Option<&str>) -> SqlResult<()> {
        self.conn().execute(
            "UPDATE projects SET run_note = ?1 WHERE id = ?2 AND is_running = 1",
            params![clean_note(note), project_id],
        )?;
        Ok(())
    }

    /// Sets or clears the note of one of your closed sessions.
    pub fn set_entry_note(&self, entry_id: &str, note: Option<&str>) -> SqlResult<()> {
        self.conn().execute(
            "UPDATE time_entries SET note = ?1 WHERE id = ?2 AND user_id IS NULL",
            params![clean_note(note), entry_id],
        )?;
        Ok(())
    }

    /// Deletes one of your closed sessions, e.g. a timer left running by
    /// mistake, and takes its time back out of the project total and the
    /// per-day ledger. A teammate's session can't be deleted here. The delete
    /// syncs as a tombstone (`sync_entry_del`). Returns whether a row went.
    pub fn delete_entry(&self, entry_id: &str) -> SqlResult<bool> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let entry: Option<(String, i64, i64)> = tx
            .query_row(
                "SELECT project_id, start_ts, seconds FROM time_entries WHERE id = ?1 AND user_id IS NULL",
                params![entry_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((project_id, start_ts, seconds)) = entry else { return Ok(false) };
        tx.execute("DELETE FROM time_entries WHERE id = ?1", params![entry_id])?;
        tx.execute(
            "UPDATE projects SET total_seconds = MAX(0, total_seconds - ?1) WHERE id = ?2",
            params![seconds, project_id],
        )?;
        unrecord_daily(&tx, &project_id, start_ts / 1000, seconds)?;
        tx.commit()?;
        Ok(true)
    }

    /// A project's closed sessions, newest first.
    pub fn list_sessions(&self, project_id: &str) -> SqlResult<Vec<Session>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT e.id, e.start_ts, e.end_ts, e.seconds, e.phase_id, e.feature_id, e.note, e.user_id IS NULL,
                    CASE WHEN (SELECT COUNT(*) FROM project_members m WHERE m.project_id = e.project_id) > 1
                           OR EXISTS (SELECT 1 FROM time_entries o WHERE o.project_id = e.project_id AND o.user_id IS NOT NULL)
                    THEN COALESCE((SELECT m.display_name FROM project_members m WHERE m.project_id = e.project_id
                                   AND m.user_id = COALESCE(e.user_id, (SELECT value FROM sync_meta WHERE key = 'user_id'))),
                                  'Former member')
                    END
             FROM time_entries e
             WHERE e.project_id = ?1 ORDER BY e.start_ts DESC",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(Session {
                id: r.get(0)?,
                start_ts: r.get(1)?,
                end_ts: r.get(2)?,
                seconds: r.get(3)?,
                phase_id: r.get(4)?,
                feature_id: r.get(5)?,
                note: r.get(6)?,
                mine: r.get(7)?,
                user_name: r.get(8)?,
            })
        })?;
        rows.collect()
    }

    /// Exit and sleep: stops only a timer started on this device.
    pub fn pause_own_running(&self, now: i64) -> SqlResult<Vec<String>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let ids = pause_own(&tx, now)?;
        tx.commit()?;
        Ok(ids)
    }

    /// Records that the app is still alive with a timer running. One tiny
    /// UPDATE; a no-op when nothing runs.
    pub fn touch_alive(&self, now: i64) -> SqlResult<()> {
        self.conn().execute(
            "UPDATE projects SET last_alive_at = ?1 WHERE is_running = 1 AND run_device IS NULL",
            params![now],
        )?;
        Ok(())
    }

    /// Called once at launch, before any window opens. Closes sessions left
    /// open by an app that died without pausing.
    pub fn recover_interrupted_runs(&self) -> SqlResult<Vec<RecoveredRun>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let open: Vec<(String, String, Option<i64>, Option<i64>)> = tx
            // A session started on another device isn't ours to close: sync reconciles it.
            .prepare(
                "SELECT id, name, run_started_at, last_alive_at FROM projects
                 WHERE is_running = 1 AND run_device IS NULL",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<SqlResult<_>>()?;

        let mut recovered = Vec::new();
        for (id, name, started_at, last_alive) in open {
            let start = started_at.unwrap_or(0);
            let end = last_alive.unwrap_or(start).max(start);
            let seconds = pause_one(&tx, &id, end)?;
            recovered.push(RecoveredRun {
                project_id: id,
                project_name: name,
                started_at: start,
                stopped_at: end,
                seconds,
            });
        }
        tx.commit()?;
        Ok(recovered)
    }

    /// Changes which phase new time is booked to. If the project is running,
    /// its session is closed under the old phase and reopened under the new
    /// one, so every entry belongs to exactly one phase.
    pub fn set_active_phase(&self, project_id: &str, phase_id: Option<&str>, now: i64) -> SqlResult<()> {
        self.rebook(project_id, "active_phase_id", phase_id, now)
    }

    /// The same as `set_active_phase`, for features.
    pub fn set_active_feature(&self, project_id: &str, feature_id: Option<&str>, now: i64) -> SqlResult<()> {
        self.rebook(project_id, "active_feature_id", feature_id, now)
    }

    /// Sets a project's `active_*` column, splitting any open session there.
    fn rebook(&self, project_id: &str, column: &str, value: Option<&str>, now: i64) -> SqlResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let (was_running, note): (bool, Option<String>) = tx.query_row(
            "SELECT is_running, run_note FROM projects WHERE id = ?1",
            params![project_id],
            |r| Ok((r.get::<_, i64>(0)? != 0, r.get(1)?)),
        )?;
        if was_running {
            pause_one(&tx, project_id, now)?; // booked to the old value
        }
        tx.execute(
            &format!("UPDATE projects SET {column} = ?1 WHERE id = ?2"),
            params![value, project_id],
        )?;
        if was_running {
            start(&tx, project_id, now)?;
            // The note describes the whole session, so both parts carry it.
            tx.execute("UPDATE projects SET run_note = ?1 WHERE id = ?2", params![note, project_id])?;
        }
        tx.commit()
    }
}
