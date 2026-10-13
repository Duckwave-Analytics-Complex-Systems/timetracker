//! Background thread that replaces v4's 7-second frontend autosave.
//!
//! Every `TICK` it does two cheap things, with no IPC and no WebView timer
//! (WebView timers are throttled when the window is hidden):
//!
//! 1. **Sleep detection.** The thread sleeps on a monotonic clock, which
//!    stops while the machine is suspended, but wall-clock time keeps going.
//!    A wall-clock gap much larger than `TICK` therefore means the machine
//!    was asleep. The running timer is closed at the last tick before the gap,
//!    so sleep is never billed. This is the single place to plug in real OS
//!    suspend events (logind `PrepareForSleep`, Win32 `WM_POWERBROADCAST`).
//! 2. **Liveness stamp.** Every `ALIVE_STAMP_EVERY_MS` while a timer runs, it
//!    writes `last_alive_at` (one small UPDATE). If the app dies without
//!    pausing, the next launch closes the session at that stamp
//!    (`Db::recover_interrupted_runs`), so at most that much time is lost and
//!    time while the app was closed is never billed.

use crate::db::Db;
use crate::events::{notify, Change};
use crate::now_ms;
use rusqlite::Result as SqlResult;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

const TICK: Duration = Duration::from_secs(5);
const SLEEP_GAP_THRESHOLD_MS: i64 = 30_000;
const ALIVE_STAMP_EVERY_MS: i64 = 30_000;

pub struct Watchdog {
    last_tick_ms: AtomicI64,
    last_stamp_ms: AtomicI64,
}

impl Watchdog {
    pub fn new(now: i64) -> Self {
        Self { last_tick_ms: AtomicI64::new(now), last_stamp_ms: AtomicI64::new(now) }
    }

    /// One watchdog step as of `now`. Returns true if it paused timers
    /// because the machine had been asleep.
    pub fn check(&self, db: &Db, now: i64) -> SqlResult<bool> {
        let last = self.last_tick_ms.swap(now, Ordering::SeqCst);
        if now - last > SLEEP_GAP_THRESHOLD_MS {
            let paused = db.pause_all_running(last)?;
            return Ok(!paused.is_empty());
        }
        if now - self.last_stamp_ms.load(Ordering::SeqCst) >= ALIVE_STAMP_EVERY_MS {
            db.touch_alive(now)?;
            self.last_stamp_ms.store(now, Ordering::SeqCst);
        }
        Ok(false)
    }
}

/// Runs one step now and tells the windows if timers were paused. Called by
/// the background thread and by the `sync` command (the frontend calls it
/// when its own clock jumps, so the UI corrects itself right after wake-up).
pub fn run_check(app: &AppHandle) {
    let db = app.state::<Db>();
    match app.state::<Watchdog>().check(&db, now_ms()) {
        Ok(true) => notify(app, Change::PausedForSleep),
        Ok(false) => {}
        Err(e) => eprintln!("watchdog: {e}"),
    }
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        run_check(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_800_000_000_000;

    #[test]
    fn a_wall_clock_gap_pauses_at_the_last_tick() {
        let dir = std::env::temp_dir().join(format!("timetrack_test_wd_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let db = crate::db::init(dir).unwrap();
        db.create_project("a", "A", 0.0, 1, 0).unwrap();
        db.start_project("a", T0).unwrap();

        let wd = Watchdog::new(T0);
        assert!(!wd.check(&db, T0 + 5_000).unwrap());
        assert!(!wd.check(&db, T0 + 10_000).unwrap());
        // the machine sleeps for an hour
        assert!(wd.check(&db, T0 + 10_000 + 3_600_000).unwrap());

        let p = db.get_project("a").unwrap().unwrap();
        assert!(!p.is_running);
        assert_eq!(p.total_seconds, 10);
        // nothing left to pause on the next gap
        assert!(!wd.check(&db, T0 + 2 * 3_600_000).unwrap());
    }
}
