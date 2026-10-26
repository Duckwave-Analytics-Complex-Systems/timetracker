//! Tables and migrations. Runs on every launch from `db::init`.
//!
//! Two kinds of migration:
//! - **Columns** added after a table first shipped go through
//!   `ensure_column`, which checks `PRAGMA table_info` first, so it is safe to
//!   run every time. Add the column to the `CREATE TABLE` below as well, so
//!   fresh databases match migrated ones.
//! - **Data** migrations run once, guarded by `PRAGMA user_version`. Add a new
//!   `if version < N` block at the end of `migrate` (currently at 5).

use super::days::record_daily;
use rusqlite::{params, Connection, Result as SqlResult};

const TABLES: &str = "
    CREATE TABLE IF NOT EXISTS projects (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        hourly_rate     REAL NOT NULL DEFAULT 0,
        total_seconds   INTEGER NOT NULL DEFAULT 0,  -- closed sessions only
        is_running      INTEGER NOT NULL DEFAULT 0,
        run_started_at  INTEGER,                     -- ms, start of the open session
        created_at      INTEGER NOT NULL,
        archived        INTEGER NOT NULL DEFAULT 0,
        people_count    INTEGER NOT NULL DEFAULT 1,
        logo_data       TEXT,
        -- v5
        archived_at     INTEGER,                     -- ms
        last_alive_at   INTEGER,                     -- ms, last time the app was seen running this timer
        description     TEXT,
        start_day       TEXT,                        -- YYYY-MM-DD
        due_day         TEXT,                        -- YYYY-MM-DD
        budget_hours    REAL,                        -- NULL = sum of phase estimates
        active_phase_id TEXT,                        -- new time is booked to this phase
        -- v6
        run_device      TEXT                         -- NULL = the open session is this device's; else the cloud device id that started it
    );

    CREATE TABLE IF NOT EXISTS time_entries (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        start_ts    INTEGER NOT NULL,
        end_ts      INTEGER NOT NULL,
        seconds     INTEGER NOT NULL,
        phase_id    TEXT                             -- v5, NULL = unassigned
    );

    -- v4: tracked seconds per local day per project (drives Today + Stats).
    CREATE TABLE IF NOT EXISTS daily_totals (
        day         TEXT NOT NULL,
        project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        seconds     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, project_id)
    );

    -- v5: the project schedule. A milestone is a phase with kind = 'milestone'
    -- and start_day = end_day.
    CREATE TABLE IF NOT EXISTS phases (
        id               TEXT PRIMARY KEY,
        project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name             TEXT NOT NULL,
        kind             TEXT NOT NULL DEFAULT 'phase',
        color            INTEGER NOT NULL DEFAULT 0, -- palette slot 0..7 (--cat-1..--cat-8)
        start_day        TEXT NOT NULL,
        end_day          TEXT NOT NULL,
        estimated_hours  REAL NOT NULL DEFAULT 0,
        progress         INTEGER NOT NULL DEFAULT 0, -- 0..100, set by the user
        sort_order       INTEGER NOT NULL DEFAULT 0,
        created_at       INTEGER NOT NULL
    );
";

/// Indexes are created after `ensure_column`, since some cover v5 columns.
const INDEXES: &str = "
    CREATE INDEX IF NOT EXISTS idx_entries_project ON time_entries(project_id);
    CREATE INDEX IF NOT EXISTS idx_entries_phase   ON time_entries(phase_id);
    CREATE INDEX IF NOT EXISTS idx_phases_project  ON phases(project_id);
";

pub(super) fn migrate(conn: &mut Connection) -> SqlResult<()> {
    conn.execute_batch(TABLES)?;

    ensure_column(conn, "projects", "logo_data", "TEXT")?; // v2
    ensure_column(conn, "projects", "people_count", "INTEGER NOT NULL DEFAULT 1")?; // v3
    for (col, ty) in [
        ("archived_at", "INTEGER"),
        ("last_alive_at", "INTEGER"),
        ("description", "TEXT"),
        ("start_day", "TEXT"),
        ("due_day", "TEXT"),
        ("budget_hours", "REAL"),
        ("active_phase_id", "TEXT"),
    ] {
        ensure_column(conn, "projects", col, ty)?; // v5
    }
    ensure_column(conn, "time_entries", "phase_id", "TEXT")?; // v5
    ensure_column(conn, "projects", "run_device", "TEXT")?; // v6

    conn.execute_batch(INDEXES)?;
    conn.execute_batch(super::sync::SYNC_TABLES)?; // v6

    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 4 {
        let tx = conn.transaction()?;
        backfill_daily_totals(&tx)?;
        tx.pragma_update(None, "user_version", 4)?;
        tx.commit()?;
    }
    if version < 5 {
        let tx = conn.transaction()?;
        compact_time_entries(&tx)?;
        tx.pragma_update(None, "user_version", 5)?;
        tx.commit()?;
    }
    // Next data migration: `if version < 6 { ... user_version = 6 }`.
    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> SqlResult<()> {
    let exists = conn
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<SqlResult<Vec<_>>>()?
        .iter()
        .any(|c| c == column);
    if !exists {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])?;
    }
    Ok(())
}

/// v4: databases from v1-v3 already hold per-session rows in time_entries,
/// so replay them into daily_totals once.
fn backfill_daily_totals(conn: &Connection) -> SqlResult<()> {
    let entries: Vec<(String, i64, i64)> = conn
        .prepare("SELECT project_id, start_ts, seconds FROM time_entries")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<SqlResult<_>>()?;
    for (project_id, start_ts, seconds) in entries {
        record_daily(conn, &project_id, start_ts / 1000, seconds)?;
    }
    Ok(())
}

/// v5: up to v4 the 7-second autosave wrote one time_entries row per tick
/// (thousands per working day). Each tick started exactly where the previous
/// one ended, so back-to-back rows of the same project and phase are merged
/// into one row per real session. Totals and daily_totals are unchanged.
fn compact_time_entries(conn: &Connection) -> SqlResult<()> {
    struct Run {
        id: String,
        project_id: String,
        phase_id: Option<String>,
        end_ts: i64,
        seconds: i64,
        merged: bool,
    }

    let rows: Vec<(String, String, Option<String>, i64, i64, i64)> = conn
        .prepare(
            "SELECT id, project_id, phase_id, start_ts, end_ts, seconds
             FROM time_entries ORDER BY project_id, start_ts, end_ts",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
        .collect::<SqlResult<_>>()?;

    let flush = |run: &Run| -> SqlResult<()> {
        if run.merged {
            conn.execute(
                "UPDATE time_entries SET end_ts = ?1, seconds = ?2 WHERE id = ?3",
                params![run.end_ts, run.seconds, run.id],
            )?;
        }
        Ok(())
    };

    let mut current: Option<Run> = None;
    for (id, project_id, phase_id, start_ts, end_ts, seconds) in rows {
        if let Some(run) = current.as_mut() {
            if run.project_id == project_id && run.phase_id == phase_id && run.end_ts == start_ts {
                run.end_ts = end_ts;
                run.seconds += seconds;
                run.merged = true;
                conn.execute("DELETE FROM time_entries WHERE id = ?1", params![id])?;
                continue;
            }
            flush(run)?;
        }
        current = Some(Run { id, project_id, phase_id, end_ts, seconds, merged: false });
    }
    if let Some(run) = &current {
        flush(run)?;
    }
    Ok(())
}
