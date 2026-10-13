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

use super::days::record_daily;
use super::{new_id, Db};
use rusqlite::{params, Connection, Result as SqlResult};
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

/// Closes the open session of one project as of `end` (ms). Returns the
/// seconds booked. Does nothing if the project isn't running.
fn pause_one(conn: &Connection, id: &str, end: i64) -> SqlResult<i64> {
    let (running, started_at, phase_id): (bool, Option<i64>, Option<String>) = conn.query_row(
        "SELECT is_running, run_started_at, active_phase_id FROM projects WHERE id = ?1",
        params![id],
        |r| Ok((r.get::<_, i64>(0)? != 0, r.get(1)?, r.get(2)?)),
    )?;
    if !running {
        return Ok(0);
    }
    let elapsed = started_at.map(|s| ((end - s) / 1000).max(0)).unwrap_or(0);
    conn.execute(
        "UPDATE projects SET is_running = 0, run_started_at = NULL, last_alive_at = NULL,
                             total_seconds = total_seconds + ?1
         WHERE id = ?2",
        params![elapsed, id],
    )?;
    if let (Some(start), true) = (started_at, elapsed > 0) {
        conn.execute(
            "INSERT INTO time_entries (id, project_id, start_ts, end_ts, seconds, phase_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![new_id(), id, start, start + elapsed * 1000, elapsed, phase_id],
        )?;
        record_daily(conn, id, start / 1000, elapsed)?;
    }
    Ok(elapsed)
}

/// Closes every open session as of `now`. Returns the ids that were running.
pub(super) fn pause_all(conn: &Connection, now: i64) -> SqlResult<Vec<String>> {
    let running: Vec<String> = conn
        .prepare("SELECT id FROM projects WHERE is_running = 1")?
        .query_map([], |r| r.get(0))?
        .collect::<SqlResult<_>>()?;
    for id in &running {
        pause_one(conn, id, now)?;
    }
    Ok(running)
}

fn start(conn: &Connection, id: &str, now: i64) -> SqlResult<()> {
    conn.execute(
        "UPDATE projects SET is_running = 1, run_started_at = ?1, last_alive_at = ?1
         WHERE id = ?2 AND archived = 0",
        params![now, id],
    )?;
    Ok(())
}

impl Db {
    /// Starts `id`. Whatever else was running is paused first in the same
    /// transaction: this is the one place "only one timer at a time" is enforced.
    pub fn start_project(&self, id: &str, now: i64) -> SqlResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        pause_all(&tx, now)?;
        start(&tx, id, now)?;
        tx.commit()
    }

    pub fn pause_all_running(&self, now: i64) -> SqlResult<Vec<String>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let ids = pause_all(&tx, now)?;
        tx.commit()?;
        Ok(ids)
    }

    /// Records that the app is still alive with a timer running. One tiny
    /// UPDATE; a no-op when nothing runs.
    pub fn touch_alive(&self, now: i64) -> SqlResult<()> {
        self.conn()
            .execute("UPDATE projects SET last_alive_at = ?1 WHERE is_running = 1", params![now])?;
        Ok(())
    }

    /// Called once at launch, before any window opens. Closes sessions left
    /// open by an app that died without pausing.
    pub fn recover_interrupted_runs(&self) -> SqlResult<Vec<RecoveredRun>> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let open: Vec<(String, String, Option<i64>, Option<i64>)> = tx
            .prepare("SELECT id, name, run_started_at, last_alive_at FROM projects WHERE is_running = 1")?
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
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let was_running: bool = tx.query_row(
            "SELECT is_running FROM projects WHERE id = ?1",
            params![project_id],
            |r| Ok(r.get::<_, i64>(0)? != 0),
        )?;
        if was_running {
            pause_one(&tx, project_id, now)?; // booked to the old phase
        }
        tx.execute(
            "UPDATE projects SET active_phase_id = ?1 WHERE id = ?2",
            params![phase_id, project_id],
        )?;
        if was_running {
            start(&tx, project_id, now)?;
        }
        tx.commit()
    }
}
