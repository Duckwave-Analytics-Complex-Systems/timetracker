//! SQLite persistence.
//!
//! One file per area keeps each part small enough to read in one sitting:
//!
//! | file          | owns                                                        |
//! |---------------|-------------------------------------------------------------|
//! | `schema.rs`   | table definitions and every migration                       |
//! | `days.rs`     | splitting a span at local midnight + the per-day ledger     |
//! | `projects.rs` | project CRUD, plan fields (dates, budget), archive/restore  |
//! | `timer.rs`    | start / pause / crash recovery / liveness stamp             |
//! | `phases.rs`   | the schedule (phases + milestones) and hours per phase      |
//! | `stats.rs`    | read-only per-day queries for Stats and the project window  |
//!
//! Every public method locks the connection once. Helpers that need to run
//! inside another method's lock take `&Connection` instead of `&self`,
//! because the mutex is not reentrant.

mod days;
mod phases;
mod projects;
mod schema;
mod stats;
mod timer;

#[cfg(test)]
mod tests;

use rusqlite::{Connection, Result as SqlResult};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

pub use phases::{Phase, PhaseInput};
pub use projects::{PlanInput, Project};
pub use stats::{DailyRow, DayTotal};
pub use timer::RecoveredRun;

pub struct Db(Mutex<Connection>);

impl Db {
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.0.lock().unwrap()
    }
}

pub fn init(app_data_dir: PathBuf) -> SqlResult<Db> {
    std::fs::create_dir_all(&app_data_dir).ok();
    let mut conn = Connection::open(app_data_dir.join("timetrack.sqlite3"))?;

    // WAL survives crashes and power loss far better than the default
    // rollback journal.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;

    schema::migrate(&mut conn)?;
    Ok(Db(Mutex::new(conn)))
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
