//! Backend -> frontend notifications.
//!
//! Any command that changes data calls `notify`, which emits one
//! `data-changed` event to every window. Windows refetch what they show, so
//! the widget and any open project windows stay in sync without knowing
//! about each other. JS side: `onDataChanged()` in js/core/api.js.
//!
//! `notify` also wakes cloud sync (`sync::poke`), so a local change reaches
//! other devices within a second or two.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const DATA_CHANGED: &str = "data-changed";

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum Change {
    /// A timer started or stopped.
    Timer,
    /// Projects were added, edited, filed, restored or deleted.
    Projects,
    /// A project's plan or phases changed.
    Schedule,
    /// The watchdog paused the timer because the machine had been asleep.
    PausedForSleep,
    /// Cloud sync brought changes from another device (or its status changed).
    Synced,
}

#[derive(Serialize, Clone)]
struct Payload {
    reason: Change,
}

pub fn notify(app: &AppHandle, reason: Change) {
    // Local changes go to the cloud soon; changes that came from it don't go back.
    if !matches!(reason, Change::Synced) {
        crate::sync::poke();
    }
    if let Err(e) = app.emit(DATA_CHANGED, Payload { reason }) {
        eprintln!("emit {DATA_CHANGED}: {e}");
    }
}
