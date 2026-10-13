//! The project schedule ("cronogram"): phases and milestones, plus the hours
//! actually tracked against each phase.

use super::{new_id, Db};
use chrono::NaiveDate;
use rusqlite::{params, Result as SqlResult};
use serde::{Deserialize, Serialize};

pub const KIND_PHASE: &str = "phase";
pub const KIND_MILESTONE: &str = "milestone";
const PALETTE_SLOTS: i64 = 8; // --cat-1 .. --cat-8

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Phase {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub kind: String,
    pub color: i64,
    pub start_day: String,
    pub end_day: String,
    pub estimated_hours: f64,
    pub progress: i64,
    pub sort_order: i64,
    /// Closed sessions booked to this phase. The frontend adds the open
    /// session when this phase is the running project's active phase.
    pub spent_seconds: i64,
}

/// Create (`id: None`) or update a phase. Sent from JS with snake_case keys.
#[derive(Debug, Deserialize, Clone)]
pub struct PhaseInput {
    pub id: Option<String>,
    pub project_id: String,
    pub name: String,
    pub kind: String,
    pub color: i64,
    pub start_day: String,
    pub end_day: String,
    pub estimated_hours: f64,
    pub progress: i64,
}

impl PhaseInput {
    /// Checks and normalises user input: trimmed name, valid dates in order,
    /// clamped numbers, and milestones collapsed to a single day.
    pub fn normalized(mut self) -> Result<Self, String> {
        self.name = self.name.trim().to_string();
        if self.name.is_empty() {
            return Err("A phase needs a name.".into());
        }
        let parse = |s: &str| {
            NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| format!("Invalid date: {s:?}"))
        };
        let start = parse(&self.start_day)?;
        let mut end = parse(&self.end_day)?;
        if self.kind != KIND_MILESTONE {
            self.kind = KIND_PHASE.into();
        }
        if self.kind == KIND_MILESTONE {
            end = start;
        }
        if end < start {
            return Err("The end date is before the start date.".into());
        }
        self.end_day = end.format("%Y-%m-%d").to_string();
        self.color = self.color.rem_euclid(PALETTE_SLOTS);
        self.progress = self.progress.clamp(0, 100);
        self.estimated_hours = if self.estimated_hours.is_finite() { self.estimated_hours.max(0.0) } else { 0.0 };
        Ok(self)
    }
}

impl Db {
    /// Phases of a project in timeline order, each with its tracked seconds.
    pub fn list_phases(&self, project_id: &str) -> SqlResult<Vec<Phase>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT ph.id, ph.project_id, ph.name, ph.kind, ph.color, ph.start_day, ph.end_day,
                    ph.estimated_hours, ph.progress, ph.sort_order,
                    COALESCE((SELECT SUM(e.seconds) FROM time_entries e WHERE e.phase_id = ph.id), 0)
             FROM phases ph
             WHERE ph.project_id = ?1
             ORDER BY ph.start_day, ph.sort_order, ph.created_at",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(Phase {
                id: r.get(0)?,
                project_id: r.get(1)?,
                name: r.get(2)?,
                kind: r.get(3)?,
                color: r.get(4)?,
                start_day: r.get(5)?,
                end_day: r.get(6)?,
                estimated_hours: r.get(7)?,
                progress: r.get(8)?,
                sort_order: r.get(9)?,
                spent_seconds: r.get(10)?,
            })
        })?;
        rows.collect()
    }

    /// Inserts or updates a phase (call `PhaseInput::normalized` first).
    /// Returns its id.
    pub fn save_phase(&self, p: &PhaseInput, now: i64) -> SqlResult<String> {
        let conn = self.conn();
        if let Some(id) = &p.id {
            conn.execute(
                "UPDATE phases SET name = ?1, kind = ?2, color = ?3, start_day = ?4, end_day = ?5,
                                   estimated_hours = ?6, progress = ?7
                 WHERE id = ?8",
                params![p.name, p.kind, p.color, p.start_day, p.end_day, p.estimated_hours, p.progress, id],
            )?;
            return Ok(id.clone());
        }
        let id = new_id();
        let next_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM phases WHERE project_id = ?1",
            params![p.project_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO phases (id, project_id, name, kind, color, start_day, end_day,
                                 estimated_hours, progress, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id, p.project_id, p.name, p.kind, p.color, p.start_day, p.end_day,
                p.estimated_hours, p.progress, next_order, now
            ],
        )?;
        Ok(id)
    }

    /// Deletes a phase. Time booked to it stays on the project as
    /// "unassigned". If it was the active phase, the active phase is cleared,
    /// so an open session is also booked as unassigned when it closes.
    pub fn delete_phase(&self, id: &str) -> SqlResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("UPDATE projects SET active_phase_id = NULL WHERE active_phase_id = ?1", params![id])?;
        tx.execute("UPDATE time_entries SET phase_id = NULL WHERE phase_id = ?1", params![id])?;
        tx.execute("DELETE FROM phases WHERE id = ?1", params![id])?;
        tx.commit()
    }
}
