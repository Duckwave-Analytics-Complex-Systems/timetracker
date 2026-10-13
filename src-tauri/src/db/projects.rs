//! Projects: CRUD, plan fields (dates, budget, description) and archiving.

use super::timer::pause_all;
use super::Db;
use rusqlite::{params, OptionalExtension, Result as SqlResult, Row};
use serde::{Deserialize, Serialize};

/// A project as the frontend sees it. Field names stay snake_case in JS.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub hourly_rate: f64,
    /// Seconds of closed sessions. A running timer adds `now - run_started_at`.
    pub total_seconds: i64,
    pub is_running: bool,
    /// Unix ms when the open session started (only while running).
    pub run_started_at: Option<i64>,
    pub created_at: i64,
    /// "Filed" projects: hidden from the main list, kept with their history.
    pub archived: bool,
    pub archived_at: Option<i64>,
    /// Small base64 `data:` URL, resized client-side before it gets here.
    pub logo_data: Option<String>,
    /// People billing the tracked time at once. Always >= 1.
    pub people_count: i64,
    pub description: Option<String>,
    pub start_day: Option<String>,
    pub due_day: Option<String>,
    /// Explicit budget. When `None`, the budget is the sum of phase estimates.
    pub budget_hours: Option<f64>,
    pub active_phase_id: Option<String>,
    pub active_phase_name: Option<String>,
    pub active_phase_color: Option<i64>,
}

impl Project {
    /// Tracked seconds including the open session, as of `now` (ms).
    pub fn live_seconds(&self, now: i64) -> i64 {
        let open = self.run_started_at.filter(|_| self.is_running).map(|s| ((now - s) / 1000).max(0));
        self.total_seconds + open.unwrap_or(0)
    }

    /// Bill = hours x hourly_rate x people_count. Mirrors `bill()` in js/core/model.js.
    pub fn bill(&self, seconds: i64) -> f64 {
        (seconds as f64 / 3600.0) * self.hourly_rate * self.people_count.max(1) as f64
    }
}

/// Plan fields edited from the project window's Schedule tab.
#[derive(Debug, Deserialize)]
pub struct PlanInput {
    pub description: Option<String>,
    pub start_day: Option<String>,
    pub due_day: Option<String>,
    pub budget_hours: Option<f64>,
}

const SELECT_PROJECT: &str = "
    SELECT p.id, p.name, p.hourly_rate, p.total_seconds, p.is_running, p.run_started_at,
           p.created_at, p.archived, p.archived_at, p.logo_data, p.people_count,
           p.description, p.start_day, p.due_day, p.budget_hours,
           p.active_phase_id, ph.name, ph.color
    FROM projects p LEFT JOIN phases ph ON ph.id = p.active_phase_id";

fn from_row(r: &Row) -> SqlResult<Project> {
    Ok(Project {
        id: r.get(0)?,
        name: r.get(1)?,
        hourly_rate: r.get(2)?,
        total_seconds: r.get(3)?,
        is_running: r.get::<_, i64>(4)? != 0,
        run_started_at: r.get(5)?,
        created_at: r.get(6)?,
        archived: r.get::<_, i64>(7)? != 0,
        archived_at: r.get(8)?,
        logo_data: r.get(9)?,
        people_count: r.get(10)?,
        description: r.get(11)?,
        start_day: r.get(12)?,
        due_day: r.get(13)?,
        budget_hours: r.get(14)?,
        active_phase_id: r.get(15)?,
        active_phase_name: r.get(16)?,
        active_phase_color: r.get(17)?,
    })
}

/// Empty strings from form fields mean "not set".
fn non_empty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

impl Db {
    /// Active projects oldest first, or archived ones most recently filed first.
    pub fn list_projects(&self, archived: bool) -> SqlResult<Vec<Project>> {
        let order = if archived { "p.archived_at DESC" } else { "p.created_at ASC" };
        let sql = format!("{SELECT_PROJECT} WHERE p.archived = ?1 ORDER BY {order}");
        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![archived as i64], from_row)?;
        rows.collect()
    }

    pub fn get_project(&self, id: &str) -> SqlResult<Option<Project>> {
        let conn = self.conn();
        conn.query_row(&format!("{SELECT_PROJECT} WHERE p.id = ?1"), params![id], from_row)
            .optional()
    }

    pub fn create_project(&self, id: &str, name: &str, hourly_rate: f64, people_count: i64, now: i64) -> SqlResult<()> {
        self.conn().execute(
            "INSERT INTO projects (id, name, hourly_rate, created_at, people_count) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, hourly_rate, now, people_count.max(1)],
        )?;
        Ok(())
    }

    pub fn update_project(&self, id: &str, name: &str, hourly_rate: f64, people_count: i64) -> SqlResult<()> {
        self.conn().execute(
            "UPDATE projects SET name = ?1, hourly_rate = ?2, people_count = ?3 WHERE id = ?4",
            params![name, hourly_rate, people_count.max(1), id],
        )?;
        Ok(())
    }

    pub fn update_plan(&self, id: &str, plan: &PlanInput) -> SqlResult<()> {
        self.conn().execute(
            "UPDATE projects SET description = ?1, start_day = ?2, due_day = ?3, budget_hours = ?4 WHERE id = ?5",
            params![
                non_empty(&plan.description),
                non_empty(&plan.start_day),
                non_empty(&plan.due_day),
                plan.budget_hours.filter(|h| *h > 0.0),
                id
            ],
        )?;
        Ok(())
    }

    pub fn set_logo(&self, id: &str, logo_data: Option<String>) -> SqlResult<()> {
        self.conn()
            .execute("UPDATE projects SET logo_data = ?1 WHERE id = ?2", params![logo_data, id])?;
        Ok(())
    }

    /// Files (`archived = true`) or restores a project. Filing a running
    /// project stops its timer first, so its time is saved up to `now`.
    pub fn set_archived(&self, id: &str, archived: bool, now: i64) -> SqlResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if archived {
            let running: bool = tx.query_row(
                "SELECT is_running FROM projects WHERE id = ?1",
                params![id],
                |r| Ok(r.get::<_, i64>(0)? != 0),
            )?;
            if running {
                pause_all(&tx, now)?;
            }
        }
        tx.execute(
            "UPDATE projects SET archived = ?1, archived_at = ?2 WHERE id = ?3",
            params![archived as i64, archived.then_some(now), id],
        )?;
        tx.commit()
    }

    pub fn delete_project(&self, id: &str) -> SqlResult<()> {
        // Entries, daily rows and phases go with it (ON DELETE CASCADE).
        self.conn().execute("DELETE FROM projects WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Forgets all tracked time. The schedule (phases, dates) is kept.
    pub fn reset_project(&self, id: &str) -> SqlResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE projects SET total_seconds = 0, is_running = 0, run_started_at = NULL, last_alive_at = NULL WHERE id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM time_entries WHERE project_id = ?1", params![id])?;
        tx.execute("DELETE FROM daily_totals WHERE project_id = ?1", params![id])?;
        tx.commit()
    }
}
