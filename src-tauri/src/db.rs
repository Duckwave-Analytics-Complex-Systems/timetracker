use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

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
            archived        INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS time_entries (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            start_ts    INTEGER NOT NULL,
            end_ts      INTEGER NOT NULL,
            seconds     INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_entries_project ON time_entries(project_id);
        ",
    )?;

    // Migration for DBs created by v1.0.0, which predates the logo feature.
    // ALTER TABLE ADD COLUMN errors if the column already exists, so this
    // is best-effort and the error (already-there) is intentionally ignored.
    let _ = conn.execute("ALTER TABLE projects ADD COLUMN logo_data TEXT", []);

    Ok(Db(Mutex::new(conn)))
}

impl Db {
    pub fn list_projects(&self) -> SqlResult<Vec<Project>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, hourly_rate, total_seconds, is_running, run_started_at, created_at, archived, logo_data
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
            })
        })?;
        rows.collect()
    }

    pub fn create_project(&self, id: &str, name: &str, hourly_rate: f64, now: i64) -> SqlResult<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, hourly_rate, total_seconds, is_running, run_started_at, created_at, archived)
             VALUES (?1, ?2, ?3, 0, 0, NULL, ?4, 0)",
            params![id, name, hourly_rate, now],
        )?;
        Ok(())
    }

    pub fn rename_project(&self, id: &str, name: &str, hourly_rate: f64) -> SqlResult<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "UPDATE projects SET name = ?1, hourly_rate = ?2 WHERE id = ?3",
            params![name, hourly_rate, id],
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
        conn.execute(
            "UPDATE projects SET total_seconds = ?1, run_started_at = ?2 WHERE id = ?3",
            params![new_total, now, id],
        )?;
        if elapsed > 0 {
            conn.execute(
                "INSERT INTO time_entries (id, project_id, start_ts, end_ts, seconds) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![uuid::Uuid::new_v4().to_string(), id, started_at, now, elapsed],
            )?;
        }
        Ok(new_total)
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
