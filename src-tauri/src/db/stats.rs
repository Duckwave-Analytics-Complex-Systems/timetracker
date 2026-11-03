//! Read-only per-day queries. Time from a timer running right now is not in
//! these tables until its session closes; the frontend adds it on top
//! (`liveAdditions()` in js/core/model.js).

use super::days::split_by_local_day;
use super::Db;
use rusqlite::{params, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Your tracked seconds for one project on one local day ("YYYY-MM-DD").
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct DailyRow {
    pub day: String,
    pub project_id: String,
    pub seconds: i64,
}

/// Tracked seconds on one local day, for a single project.
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct DayTotal {
    pub day: String,
    pub seconds: i64,
}

impl Db {
    /// Per-day, per-project seconds for `from_day..=to_day` across active
    /// (not archived) projects. Drives the Today strip and the Stats tab.
    pub fn daily_range(&self, from_day: &str, to_day: &str) -> SqlResult<Vec<DailyRow>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT d.day, d.project_id, d.seconds
             FROM daily_totals d JOIN projects p ON p.id = d.project_id
             WHERE p.archived = 0 AND d.day >= ?1 AND d.day <= ?2 AND d.seconds > 0
             ORDER BY d.day ASC, p.created_at ASC",
        )?;
        let rows = stmt.query_map(params![from_day, to_day], |r| {
            Ok(DailyRow { day: r.get(0)?, project_id: r.get(1)?, seconds: r.get(2)? })
        })?;
        rows.collect()
    }

    /// Whole per-day history of one project (archived or not), oldest first.
    /// Counts everyone: `daily_totals` holds only your time, so teammates' is
    /// added from their entries.
    pub fn project_daily(&self, project_id: &str) -> SqlResult<Vec<DayTotal>> {
        let conn = self.conn();
        let mut days: BTreeMap<String, i64> = conn
            .prepare("SELECT day, seconds FROM daily_totals WHERE project_id = ?1 AND seconds > 0")?
            .query_map(params![project_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<SqlResult<_>>()?;
        let others: Vec<(i64, i64)> = conn
            .prepare("SELECT start_ts, seconds FROM time_entries WHERE project_id = ?1 AND user_id IS NOT NULL")?
            .query_map(params![project_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<SqlResult<_>>()?;
        for (start_ts, seconds) in others {
            for (day, secs) in split_by_local_day(start_ts / 1000, seconds) {
                *days.entry(day).or_insert(0) += secs;
            }
        }
        Ok(days.into_iter().map(|(day, seconds)| DayTotal { day, seconds }).collect())
    }
}
