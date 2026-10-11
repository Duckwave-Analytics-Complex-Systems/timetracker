use chrono::{Local, TimeZone};
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// Tracked seconds for one project on one local calendar day.
/// `day` is "YYYY-MM-DD" in the machine's local time zone.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct DailyRow {
    pub day: String,
    pub project_id: String,
    pub seconds: i64,
}

/// Splits a span of `seconds` starting at unix second `start_s` into
/// per-local-day chunks, cutting at every local midnight. A session that
/// runs from 23:50 to 00:20 therefore counts 10 minutes to the first day
/// and 20 to the next. The chunks always sum to exactly `seconds`.
pub fn split_by_local_day(start_s: i64, seconds: i64) -> Vec<(String, i64)> {
    let mut out = Vec::new();
    let end = start_s + seconds.max(0);
    let mut cur = start_s;
    while cur < end {
        let Some(dt) = Local.timestamp_opt(cur, 0).earliest() else { break };
        let day = dt.date_naive();
        let next_midnight = day
            .succ_opt()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .and_then(|n| Local.from_local_datetime(&n).earliest())
            .map(|d| d.timestamp())
            .filter(|&t| t > cur)
            // DST oddities / out-of-range: fall back to a plain 24h step.
            .unwrap_or(cur + 86_400);
        let chunk_end = end.min(next_midnight);
        out.push((day.format("%Y-%m-%d").to_string(), chunk_end - cur));
        cur = chunk_end;
    }
    out
}

/// Adds a tracked span to the per-day ledger (upsert per day+project).
fn record_daily(conn: &Connection, project_id: &str, start_s: i64, seconds: i64) -> SqlResult<()> {
    for (day, secs) in split_by_local_day(start_s, seconds) {
        conn.execute(
            "INSERT INTO daily_totals (day, project_id, seconds) VALUES (?1, ?2, ?3)
             ON CONFLICT(day, project_id) DO UPDATE SET seconds = seconds + excluded.seconds",
            params![day, project_id, secs],
        )?;
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub hourly_rate: f64,
    pub total_seconds: i64,
    pub is_running: bool,
    // Unix millis timestamp of when the current run started, if running.
    // Persisted so a crash/kill mid-run can still be reconciled on next boot.
    pub run_started_at: Option<i64>,
    pub created_at: i64,
    pub archived: bool,
    // Small base64 data: URL for the project's logo/avatar. Resized
    // client-side before it ever reaches this column, so it stays cheap
    // to store as TEXT.
    pub logo_data: Option<String>,
    // Number of people simultaneously billing this project's tracked
    // time (e.g. 2 people pairing on it doubles the bill for the same
    // wall-clock duration). Always >= 1.
    pub people_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TimeEntry {
    pub id: String,
    pub project_id: String,
    pub start_ts: i64,
    pub end_ts: i64,
    pub seconds: i64,
}

pub struct Db(pub Mutex<Connection>);

fn db_path(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join("timetrack.sqlite3")
}

pub fn init(app_data_dir: PathBuf) -> SqlResult<Db> {
    std::fs::create_dir_all(&app_data_dir).ok();
    let conn = Connection::open(db_path(&app_data_dir))?;

    // WAL mode: survives crashes/power loss far better than the default
    // rollback journal, and lets reads happen without blocking the writer
    // used by the periodic autosave.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            hourly_rate     REAL NOT NULL DEFAULT 0,
            total_seconds   INTEGER NOT NULL DEFAULT 0,
            is_running      INTEGER NOT NULL DEFAULT 0,
            run_started_at  INTEGER,
            created_at      INTEGER NOT NULL,
            archived        INTEGER NOT NULL DEFAULT 0,
            people_count    INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS time_entries (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            start_ts    INTEGER NOT NULL,
            end_ts      INTEGER NOT NULL,
            seconds     INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_entries_project ON time_entries(project_id);

        -- v4.0.0: tracked seconds per local day per project (drives Today + Stats).
        CREATE TABLE IF NOT EXISTS daily_totals (
            day         TEXT NOT NULL,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            seconds     INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, project_id)
        );
        ",
    )?;

    // Migration for DBs created by v1.0.0, which predates the logo feature.
    // ALTER TABLE ADD COLUMN errors if the column already exists, so this
    // is best-effort and the error (already-there) is intentionally ignored.
    let _ = conn.execute("ALTER TABLE projects ADD COLUMN logo_data TEXT", []);
    // Migration for DBs created before v3.0.0, which predates the
    // multi-person billing multiplier.
    let _ = conn.execute(
        "ALTER TABLE projects ADD COLUMN people_count INTEGER NOT NULL DEFAULT 1",
        [],
    );

    // v4.0.0 backfill: DBs from v1-v3 already hold per-session rows in
    // time_entries, so replay them into daily_totals once. `user_version`
    // makes this run exactly one time per database.
    let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version < 4 {
        let mut stmt = conn.prepare("SELECT project_id, start_ts, seconds FROM time_entries")?;
        let entries: Vec<(String, i64, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<SqlResult<_>>()?;
        drop(stmt);
        for (project_id, start_ts, seconds) in entries {
            record_daily(&conn, &project_id, start_ts / 1000, seconds)?;
        }
        conn.pragma_update(None, "user_version", 4)?;
    }

    Ok(Db(Mutex::new(conn)))
}

impl Db {
    pub fn list_projects(&self) -> SqlResult<Vec<Project>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, hourly_rate, total_seconds, is_running, run_started_at, created_at, archived, logo_data, people_count
             FROM projects WHERE archived = 0 ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                hourly_rate: r.get(2)?,
                total_seconds: r.get(3)?,
                is_running: r.get::<_, i64>(4)? != 0,
                run_started_at: r.get(5)?,
                created_at: r.get(6)?,
                archived: r.get::<_, i64>(7)? != 0,
                logo_data: r.get(8)?,
                people_count: r.get(9)?,
            })
        })?;
        rows.collect()
    }

    pub fn create_project(&self, id: &str, name: &str, hourly_rate: f64, people_count: i64, now: i64) -> SqlResult<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, hourly_rate, total_seconds, is_running, run_started_at, created_at, archived, people_count)
             VALUES (?1, ?2, ?3, 0, 0, NULL, ?4, 0, ?5)",
            params![id, name, hourly_rate, now, people_count.max(1)],
        )?;
        Ok(())
    }

    pub fn rename_project(&self, id: &str, name: &str, hourly_rate: f64, people_count: i64) -> SqlResult<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "UPDATE projects SET name = ?1, hourly_rate = ?2, people_count = ?3 WHERE id = ?4",
            params![name, hourly_rate, people_count.max(1), id],
        )?;
        Ok(())
    }

    pub fn set_logo(&self, id: &str, logo_data: Option<String>) -> SqlResult<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "UPDATE projects SET logo_data = ?1 WHERE id = ?2",
            params![logo_data, id],
        )?;
        Ok(())
    }

    pub fn delete_project(&self, id: &str) -> SqlResult<()> {
        let conn = self.0.lock().unwrap();
        conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn reset_project(&self, id: &str) -> SqlResult<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "UPDATE projects SET total_seconds = 0, is_running = 0, run_started_at = NULL WHERE id = ?1",
            params![id],
        )?;
        conn.execute("DELETE FROM time_entries WHERE project_id = ?1", params![id])?;
        // Reset means "forget all tracked time", so the per-day history for
        // this project goes too (keeps Stats consistent with the card total).
        conn.execute("DELETE FROM daily_totals WHERE project_id = ?1", params![id])?;
        Ok(())
    }

    /// Pauses every currently-running project (enforces the "only one
    /// active timer" rule) and returns the ids that were stopped.
    pub fn pause_all_running(&self, now: i64) -> SqlResult<Vec<String>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, run_started_at, total_seconds FROM projects WHERE is_running = 1",
        )?;
        let running: Vec<(String, Option<i64>, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<SqlResult<_>>()?;
        drop(stmt);

        let mut stopped = Vec::new();
        for (id, started_at, total) in running {
            let elapsed = started_at.map(|s| ((now - s) / 1000).max(0)).unwrap_or(0);
            conn.execute(
                "UPDATE projects SET is_running = 0, run_started_at = NULL, total_seconds = ?1 WHERE id = ?2",
                params![total + elapsed, id],
            )?;
            if let Some(s) = started_at {
                if elapsed > 0 {
                    conn.execute(
                        "INSERT INTO time_entries (id, project_id, start_ts, end_ts, seconds) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![uuid::Uuid::new_v4().to_string(), id, s, now, elapsed],
                    )?;
                    record_daily(&conn, &id, s / 1000, elapsed)?;
                }
            }
            stopped.push(id);
        }
        Ok(stopped)
    }

    pub fn start_project(&self, id: &str, now: i64) -> SqlResult<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "UPDATE projects SET is_running = 1, run_started_at = ?1 WHERE id = ?2",
            params![now, id],
        )?;
        Ok(())
    }

    /// Folds elapsed running time into total_seconds without stopping the
    /// timer. Called every 5-10s by the frontend autosave tick so a crash
    /// never loses more than that window of work.
    pub fn checkpoint_running(&self, id: &str, now: i64) -> SqlResult<i64> {
        let conn = self.0.lock().unwrap();
        let (started_at, total): (Option<i64>, i64) = conn.query_row(
            "SELECT run_started_at, total_seconds FROM projects WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let Some(started_at) = started_at else { return Ok(total) };
        let elapsed = ((now - started_at) / 1000).max(0);
        let new_total = total + elapsed;
        // Advance the run start by exactly the whole seconds we just banked
        // (not to `now`): the sub-second remainder stays in the running
        // window instead of being dropped on every 7s tick, which used to
        // under-count a long session by a few percent.
        let new_start = started_at + elapsed * 1000;
        conn.execute(
            "UPDATE projects SET total_seconds = ?1, run_started_at = ?2 WHERE id = ?3",
            params![new_total, new_start, id],
        )?;
        if elapsed > 0 {
            conn.execute(
                "INSERT INTO time_entries (id, project_id, start_ts, end_ts, seconds) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![uuid::Uuid::new_v4().to_string(), id, started_at, new_start, elapsed],
            )?;
            record_daily(&conn, id, started_at / 1000, elapsed)?;
        }
        Ok(new_total)
    }

    /// Per-day, per-project tracked seconds for `from_day..=to_day`
    /// (inclusive, "YYYY-MM-DD" strings compare correctly as text).
    pub fn daily_range(&self, from_day: &str, to_day: &str) -> SqlResult<Vec<DailyRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT d.day, d.project_id, d.seconds
             FROM daily_totals d JOIN projects p ON p.id = d.project_id
             WHERE p.archived = 0 AND d.day >= ?1 AND d.day <= ?2 AND d.seconds > 0
             ORDER BY d.day ASC, p.created_at ASC",
        )?;
        let rows = stmt.query_map(params![from_day, to_day], |r| {
            Ok(DailyRow {
                day: r.get(0)?,
                project_id: r.get(1)?,
                seconds: r.get(2)?,
            })
        })?;
        rows.collect()
    }

    #[allow(dead_code)]
    pub fn entries_for_export(&self) -> SqlResult<Vec<(String, TimeEntry)>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT p.name, e.id, e.project_id, e.start_ts, e.end_ts, e.seconds
             FROM time_entries e JOIN projects p ON p.id = e.project_id
             ORDER BY e.start_ts ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                TimeEntry {
                    id: r.get(1)?,
                    project_id: r.get(2)?,
                    start_ts: r.get(3)?,
                    end_ts: r.get(4)?,
                    seconds: r.get(5)?,
                },
            ))
        })?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: i64 = 3600;

    fn fresh(tag: &str) -> Db {
        let p = std::env::temp_dir().join(format!("timetrack_test_{}_{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        init(p).unwrap()
    }

    #[test]
    fn split_crosses_local_midnight() {
        let mid = Local.with_ymd_and_hms(2026, 10, 6, 0, 0, 0).unwrap().timestamp();
        // 23:50 -> 00:20 the next day
        assert_eq!(
            split_by_local_day(mid - 600, 1800),
            vec![("2026-10-05".to_string(), 600), ("2026-10-06".to_string(), 1200)]
        );
        // a 30h span starting at noon covers three calendar days and sums exactly
        let parts = split_by_local_day(mid + 12 * H, 30 * H);
        assert_eq!(parts.iter().map(|p| p.1).sum::<i64>(), 30 * H);
        assert_eq!(parts[0], ("2026-10-06".to_string(), 12 * H));
        assert_eq!(parts[1], ("2026-10-07".to_string(), 18 * H));
        assert!(split_by_local_day(mid, 0).is_empty());
    }

    #[test]
    fn checkpoints_do_not_drift_and_feed_the_daily_ledger() {
        let db = fresh("ckpt");
        db.create_project("a", "A", 10.0, 1, 0).unwrap();
        let t0 = 1_800_000_000_000i64; // ms
        db.start_project("a", t0).unwrap();
        // checkpoints land at odd sub-second offsets; no time may be lost between them
        db.checkpoint_running("a", t0 + 7_400).unwrap();
        db.checkpoint_running("a", t0 + 14_900).unwrap();
        db.checkpoint_running("a", t0 + 22_100).unwrap();
        db.pause_all_running(t0 + 30_000).unwrap();
        let p = db.list_projects().unwrap().remove(0);
        assert_eq!(p.total_seconds, 30);
        let daily: i64 = db.daily_range("0000-00-00", "9999-99-99").unwrap().iter().map(|r| r.seconds).sum();
        assert_eq!(daily, p.total_seconds);
    }

    #[test]
    fn range_query_reset_and_cascade() {
        let db = fresh("range");
        db.create_project("a", "A", 0.0, 1, 0).unwrap();
        db.create_project("b", "B", 0.0, 1, 1).unwrap();
        {
            let conn = db.0.lock().unwrap();
            for (d, p, s) in [("2026-10-04", "a", 100), ("2026-10-05", "a", 200), ("2026-10-05", "b", 300), ("2026-10-06", "b", 400)] {
                conn.execute("INSERT INTO daily_totals (day, project_id, seconds) VALUES (?1, ?2, ?3)", params![d, p, s]).unwrap();
            }
        }
        let r = db.daily_range("2026-10-05", "2026-10-06").unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[0], DailyRow { day: "2026-10-05".into(), project_id: "a".into(), seconds: 200 });
        db.reset_project("a").unwrap();
        assert_eq!(db.daily_range("2000-01-01", "2100-01-01").unwrap().len(), 2);
        db.delete_project("b").unwrap();
        assert_eq!(db.daily_range("2000-01-01", "2100-01-01").unwrap().len(), 0);
    }

    #[test]
    fn upgrade_from_v3_backfills_history_exactly_once() {
        let dir = std::env::temp_dir().join(format!("timetrack_test_bf_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        {
            // a v3-shaped database: no daily_totals table, user_version 0
            let c = Connection::open(dir.join("timetrack.sqlite3")).unwrap();
            c.execute_batch(
                "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, hourly_rate REAL NOT NULL DEFAULT 0,
                   total_seconds INTEGER NOT NULL DEFAULT 0, is_running INTEGER NOT NULL DEFAULT 0, run_started_at INTEGER,
                   created_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, people_count INTEGER NOT NULL DEFAULT 1, logo_data TEXT);
                 CREATE TABLE time_entries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                   start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL, seconds INTEGER NOT NULL);
                 INSERT INTO projects (id, name, created_at) VALUES ('x', 'X', 0);
                 INSERT INTO time_entries VALUES ('e1', 'x', 1800000000000, 1800000600000, 600);
                 INSERT INTO time_entries VALUES ('e2', 'x', 1800000700000, 1800001000000, 300);",
            )
            .unwrap();
        }
        let sum = |db: &Db| db.daily_range("0000", "9999").unwrap().iter().map(|r| r.seconds).sum::<i64>();
        let db = init(dir.clone()).unwrap();
        assert_eq!(sum(&db), 900);
        drop(db);
        let db = init(dir).unwrap(); // a second launch must not double-count
        assert_eq!(sum(&db), 900);
    }
}
