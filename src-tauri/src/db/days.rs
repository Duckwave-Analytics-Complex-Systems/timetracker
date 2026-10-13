//! Local-day bucketing. The frontend's `liveAdditions()` (js/core/model.js)
//! does the same split for the running timer, so both sides must agree.

use chrono::{Local, TimeZone};
use rusqlite::{params, Connection, Result as SqlResult};

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

/// Adds a tracked span to the per-day ledger (upsert per day + project).
pub(super) fn record_daily(conn: &Connection, project_id: &str, start_s: i64, seconds: i64) -> SqlResult<()> {
    for (day, secs) in split_by_local_day(start_s, seconds) {
        conn.execute(
            "INSERT INTO daily_totals (day, project_id, seconds) VALUES (?1, ?2, ?3)
             ON CONFLICT(day, project_id) DO UPDATE SET seconds = seconds + excluded.seconds",
            params![day, project_id, secs],
        )?;
    }
    Ok(())
}
