//! Project features: named pieces of work, such as "Sharing" or "Session
//! notes", used to see how much time each one took. Independent of phases: a
//! session can be booked to a phase, a feature, both or neither.

use super::{new_id, Db};
use rusqlite::{params, Result as SqlResult};
use serde::{Deserialize, Serialize};

const PALETTE_SLOTS: i64 = 8; // --cat-1 .. --cat-8

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Feature {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub color: i64,
    pub sort_order: i64,
    /// Closed sessions booked to this feature. The frontend adds the open
    /// session when this is the running project's active feature.
    pub spent_seconds: i64,
}

/// Create (`id: None`) or update a feature. Sent from JS with snake_case keys.
#[derive(Debug, Deserialize, Clone)]
pub struct FeatureInput {
    pub id: Option<String>,
    pub project_id: String,
    pub name: String,
    pub color: i64,
}

impl FeatureInput {
    /// Checks and normalises user input: trimmed name and a palette slot in range.
    pub fn normalized(mut self) -> Result<Self, String> {
        self.name = self.name.trim().to_string();
        if self.name.is_empty() {
            return Err("A feature needs a name.".into());
        }
        self.color = self.color.rem_euclid(PALETTE_SLOTS);
        Ok(self)
    }
}

impl Db {
    /// Features of a project in creation order, each with its tracked seconds.
    pub fn list_features(&self, project_id: &str) -> SqlResult<Vec<Feature>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT f.id, f.project_id, f.name, f.color, f.sort_order,
                    COALESCE((SELECT SUM(e.seconds) FROM time_entries e WHERE e.feature_id = f.id), 0)
             FROM features f
             WHERE f.project_id = ?1
             ORDER BY f.sort_order, f.created_at",
        )?;
        let rows = stmt.query_map(params![project_id], |r| {
            Ok(Feature {
                id: r.get(0)?,
                project_id: r.get(1)?,
                name: r.get(2)?,
                color: r.get(3)?,
                sort_order: r.get(4)?,
                spent_seconds: r.get(5)?,
            })
        })?;
        rows.collect()
    }

    /// Inserts or updates a feature (call `FeatureInput::normalized` first).
    /// Returns its id.
    pub fn save_feature(&self, f: &FeatureInput, now: i64) -> SqlResult<String> {
        let conn = self.conn();
        if let Some(id) = &f.id {
            conn.execute(
                "UPDATE features SET name = ?1, color = ?2 WHERE id = ?3",
                params![f.name, f.color, id],
            )?;
            return Ok(id.clone());
        }
        let id = new_id();
        let next_order: i64 = conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM features WHERE project_id = ?1",
            params![f.project_id],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT INTO features (id, project_id, name, color, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, f.project_id, f.name, f.color, next_order, now],
        )?;
        Ok(id)
    }

    /// Deletes a feature. Time booked to it stays on the project as
    /// "unassigned". If it was the active feature, the active feature is
    /// cleared, so an open session is also booked as unassigned when it closes.
    pub fn delete_feature(&self, id: &str) -> SqlResult<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("UPDATE projects SET active_feature_id = NULL WHERE active_feature_id = ?1", params![id])?;
        tx.execute("UPDATE time_entries SET feature_id = NULL WHERE feature_id = ?1", params![id])?;
        tx.execute("DELETE FROM features WHERE id = ?1", params![id])?;
        tx.commit()
    }
}
