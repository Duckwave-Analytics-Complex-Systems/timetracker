use super::days::split_by_local_day;
use super::*;
use chrono::{Local, TimeZone};
use rusqlite::params;

const H: i64 = 3600;
const T0: i64 = 1_800_000_000_000; // ms

fn temp_dir(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("timetrack_test_{}_{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    p
}

fn fresh(tag: &str) -> Db {
    init(temp_dir(tag)).unwrap()
}

fn daily_sum(db: &Db) -> i64 {
    db.daily_range("0000", "9999").unwrap().iter().map(|r| r.seconds).sum()
}

fn entry_count(db: &Db) -> i64 {
    db.conn().query_row("SELECT COUNT(*) FROM time_entries", [], |r| r.get(0)).unwrap()
}

fn project(db: &Db, id: &str) -> Project {
    db.get_project(id).unwrap().unwrap()
}

fn phase_input(project_id: &str, name: &str) -> PhaseInput {
    PhaseInput {
        id: None,
        project_id: project_id.into(),
        name: name.into(),
        kind: "phase".into(),
        color: 0,
        start_day: "2026-10-01".into(),
        end_day: "2026-10-10".into(),
        estimated_hours: 10.0,
        progress: 0,
    }
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
fn a_session_is_booked_once_when_it_closes() {
    let db = fresh("session");
    db.create_project("a", "A", 10.0, 1, 0).unwrap();
    db.start_project("a", T0).unwrap();
    db.touch_alive(T0 + 10_000).unwrap();
    db.touch_alive(T0 + 20_000).unwrap();
    // nothing is booked while the timer runs
    assert_eq!(project(&db, "a").total_seconds, 0);
    assert_eq!(entry_count(&db), 0);

    db.pause_all_running(T0 + 30_700).unwrap();
    let p = project(&db, "a");
    assert!(!p.is_running);
    assert_eq!(p.total_seconds, 30);
    assert_eq!(entry_count(&db), 1);
    assert_eq!(daily_sum(&db), 30);
}

#[test]
fn starting_a_project_pauses_the_other() {
    let db = fresh("single");
    db.create_project("a", "A", 0.0, 1, 0).unwrap();
    db.create_project("b", "B", 0.0, 1, 1).unwrap();
    db.start_project("a", T0).unwrap();
    db.start_project("b", T0 + 5_000).unwrap();
    assert!(!project(&db, "a").is_running);
    assert_eq!(project(&db, "a").total_seconds, 5);
    assert!(project(&db, "b").is_running);
}

#[test]
fn live_seconds_and_bill() {
    let db = fresh("live");
    db.create_project("a", "A", 50.0, 2, 0).unwrap();
    db.start_project("a", T0).unwrap();
    let p = project(&db, "a");
    assert_eq!(p.live_seconds(T0 + 3_600_900), 3600);
    assert_eq!(p.bill(3600), 100.0);
}

#[test]
fn an_interrupted_run_is_closed_at_the_last_alive_stamp() {
    let dir = temp_dir("recover");
    {
        let db = init(dir.clone()).unwrap();
        db.create_project("a", "A", 0.0, 1, 0).unwrap();
        db.start_project("a", T0).unwrap();
        db.touch_alive(T0 + 60_000).unwrap();
        // the app dies here: no pause, the row still says is_running = 1
    }
    let db = init(dir).unwrap();
    let recovered = db.recover_interrupted_runs().unwrap();
    assert_eq!(recovered.len(), 1);
    assert_eq!(recovered[0].seconds, 60);
    assert_eq!(recovered[0].stopped_at, T0 + 60_000);
    let p = project(&db, "a");
    assert!(!p.is_running);
    assert_eq!(p.total_seconds, 60);
    // a second launch has nothing left to recover
    assert!(db.recover_interrupted_runs().unwrap().is_empty());
}

#[test]
fn switching_phase_while_running_splits_the_session() {
    let db = fresh("phase_switch");
    db.create_project("a", "A", 0.0, 1, 0).unwrap();
    let design = db.save_phase(&phase_input("a", "Design"), 0).unwrap();
    let build = db.save_phase(&phase_input("a", "Build"), 1).unwrap();

    db.set_active_phase("a", Some(&design), T0).unwrap();
    db.start_project("a", T0).unwrap();
    db.set_active_phase("a", Some(&build), T0 + 10_000).unwrap();
    assert!(project(&db, "a").is_running);
    db.pause_all_running(T0 + 25_000).unwrap();

    let spent: Vec<(String, i64)> =
        db.list_phases("a").unwrap().into_iter().map(|p| (p.name, p.spent_seconds)).collect();
    assert!(spent.contains(&("Design".into(), 10)));
    assert!(spent.contains(&("Build".into(), 15)));
    assert_eq!(project(&db, "a").total_seconds, 25);
}

#[test]
fn deleting_a_phase_keeps_its_time_on_the_project() {
    let db = fresh("phase_delete");
    db.create_project("a", "A", 0.0, 1, 0).unwrap();
    let id = db.save_phase(&phase_input("a", "Design"), 0).unwrap();
    db.set_active_phase("a", Some(&id), T0).unwrap();
    db.start_project("a", T0).unwrap();
    db.pause_all_running(T0 + 9_000).unwrap();

    db.delete_phase(&id).unwrap();
    assert!(db.list_phases("a").unwrap().is_empty());
    let p = project(&db, "a");
    assert_eq!(p.total_seconds, 9);
    assert_eq!(p.active_phase_id, None);
}

#[test]
fn phase_input_is_validated_and_normalised() {
    let mut m = phase_input("a", "  Launch ");
    m.kind = "milestone".into();
    m.progress = 140;
    m.color = 11;
    let m = m.normalized().unwrap();
    assert_eq!(m.name, "Launch");
    assert_eq!(m.end_day, m.start_day);
    assert_eq!(m.progress, 100);
    assert_eq!(m.color, 3);

    let mut bad = phase_input("a", "X");
    bad.end_day = "2026-09-01".into();
    assert!(bad.normalized().is_err());
    let mut bad = phase_input("a", "X");
    bad.start_day = "01/10/2026".into();
    assert!(bad.normalized().is_err());
    assert!(phase_input("a", "   ").normalized().is_err());
}

#[test]
fn filing_a_running_project_stops_and_hides_it() {
    let db = fresh("archive");
    db.create_project("a", "A", 0.0, 1, 0).unwrap();
    db.start_project("a", T0).unwrap();
    db.set_archived("a", true, T0 + 5_000).unwrap();

    let p = project(&db, "a");
    assert!(p.archived && !p.is_running);
    assert_eq!(p.total_seconds, 5);
    assert_eq!(p.archived_at, Some(T0 + 5_000));
    assert!(db.list_projects(false).unwrap().is_empty());
    assert_eq!(db.list_projects(true).unwrap().len(), 1);
    // its history stays readable
    assert_eq!(db.project_daily("a").unwrap().iter().map(|d| d.seconds).sum::<i64>(), 5);

    // a filed project can't be started until it is restored
    db.start_project("a", T0 + 10_000).unwrap();
    assert!(!project(&db, "a").is_running);
    db.set_archived("a", false, T0 + 20_000).unwrap();
    assert_eq!(db.list_projects(false).unwrap().len(), 1);
}

#[test]
fn range_query_reset_and_cascade() {
    let db = fresh("range");
    db.create_project("a", "A", 0.0, 1, 0).unwrap();
    db.create_project("b", "B", 0.0, 1, 1).unwrap();
    {
        let conn = db.conn();
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
    let dir = temp_dir("bf");
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
    let db = init(dir.clone()).unwrap();
    assert_eq!(daily_sum(&db), 900);
    assert!(project(&db, "x").start_day.is_none()); // v5 columns were added
    drop(db);
    let db = init(dir).unwrap(); // a second launch must not double-count
    assert_eq!(daily_sum(&db), 900);
}

#[test]
fn upgrade_from_v4_merges_autosave_rows_into_sessions() {
    let dir = temp_dir("compact");
    {
        let db = init(dir.clone()).unwrap();
        db.create_project("x", "X", 0.0, 1, 0).unwrap();
        let conn = db.conn();
        // three back-to-back 7s autosave rows, a gap, then one more row
        for (id, s, e, secs) in [("e1", 0, 7_000, 7), ("e2", 7_000, 14_000, 7), ("e3", 14_000, 21_000, 7), ("e4", 60_000, 67_000, 7)] {
            conn.execute(
                "INSERT INTO time_entries (id, project_id, start_ts, end_ts, seconds) VALUES (?1, 'x', ?2, ?3, ?4)",
                params![id, T0 + s, T0 + e, secs],
            )
            .unwrap();
        }
        conn.pragma_update(None, "user_version", 4).unwrap();
    }
    let db = init(dir).unwrap();
    let rows: Vec<(i64, i64, i64)> = db
        .conn()
        .prepare("SELECT start_ts, end_ts, seconds FROM time_entries ORDER BY start_ts")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(rows, vec![(T0, T0 + 21_000, 21), (T0 + 60_000, T0 + 67_000, 7)]);
}

// ---------------------------------------------------------------- cloud sync
//
// Two devices against an in-memory stand-in for Supabase: rows keyed by
// (table, id) with an increasing `updated_at`, and the `push_timer()` rules
// from supabase/schema.sql.

mod cloud {
    use super::*;
    use crate::db::{Entity, RemoteTimer, TimerPush};
    use serde_json::Value;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Server {
        rows: HashMap<(&'static str, String), (u64, Value)>,
        clock: u64,
        timer: RemoteTimer,
    }

    impl Server {
        fn push_timer(&mut self, op: &TimerPush, device: &str) -> RemoteTimer {
            let t = &mut self.timer;
            match op {
                TimerPush::Start { project_id, phase_id, started_at } => {
                    if t.started_at.map_or(true, |s| *started_at > s) {
                        *t = RemoteTimer {
                            project_id: Some(project_id.clone()),
                            phase_id: phase_id.clone(),
                            started_at: Some(*started_at),
                            ended_at: None,
                            running: true,
                            device_id: Some(device.into()),
                        };
                    }
                }
                TimerPush::Stop { project_id, started_at, ended_at } => {
                    if t.running && t.is_session(project_id, *started_at) {
                        t.running = false;
                        t.ended_at = Some((*ended_at).max(*started_at));
                    }
                }
            }
            t.clone()
        }
    }

    struct Device {
        db: Db,
        name: &'static str,
        cursor: HashMap<&'static str, u64>,
        known: Option<RemoteTimer>,
    }

    impl Device {
        fn new(tag: &str, name: &'static str) -> Self {
            Device { db: fresh(tag), name, cursor: HashMap::new(), known: None }
        }

        fn push(&self, server: &mut Server) {
            for e in Entity::ALL {
                let batch = self.db.pending(e, 1000).unwrap();
                for p in &batch {
                    server.clock += 1;
                    let key = (e.table(), p.id.clone());
                    let row = p.row.clone().unwrap_or_else(|| {
                        // a tombstone keeps the other columns
                        let mut old = server.rows.get(&key).map(|r| r.1.clone()).unwrap_or(serde_json::json!({ "id": p.id }));
                        old["deleted"] = Value::Bool(true);
                        old
                    });
                    server.rows.insert(key, (server.clock, row));
                }
                self.db.ack(e, &batch).unwrap();
            }
        }

        /// One full cycle, in the same order as `sync::cycle`.
        fn sync(&mut self, server: &mut Server, now: i64) {
            self.push(server);
            for e in Entity::ALL {
                let since = *self.cursor.get(e.table()).unwrap_or(&0);
                let mut rows: Vec<(u64, Value)> = server
                    .rows
                    .iter()
                    .filter(|((t, _), (at, _))| *t == e.table() && *at > since)
                    .map(|(_, r)| r.clone())
                    .collect();
                rows.sort_by_key(|r| r.0);
                if let Some(last) = rows.last() {
                    self.cursor.insert(e.table(), last.0);
                }
                let values: Vec<Value> = rows.into_iter().map(|r| r.1).collect();
                self.db.apply_remote(e, &values).unwrap();
            }
            let remote = match self.db.timer_push(self.known.as_ref(), now).unwrap() {
                Some(op) => server.push_timer(&op, self.name),
                None => server.timer.clone(),
            };
            self.db.reconcile_timer(&remote, self.name, now).unwrap();
            self.known = Some(remote);
            self.push(server);
        }
    }

    fn running(db: &Db) -> Option<(String, i64)> {
        db.list_projects(false)
            .unwrap()
            .into_iter()
            .find(|p| p.is_running)
            .map(|p| (p.id, p.run_started_at.unwrap()))
    }

    fn totals(db: &Db) -> Vec<(String, i64)> {
        let mut v: Vec<_> = db.list_projects(false).unwrap().into_iter().map(|p| (p.id, p.total_seconds)).collect();
        v.sort();
        v
    }

    #[test]
    fn local_changes_are_queued_and_acknowledged() {
        let db = fresh("sync_outbox");
        db.create_project("a", "A", 10.0, 1, T0).unwrap();
        let p = db.pending(Entity::Project, 10).unwrap();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].row.as_ref().unwrap()["name"], "A");
        db.ack(Entity::Project, &p).unwrap();
        assert!(db.pending(Entity::Project, 10).unwrap().is_empty());

        // starting the timer and the liveness stamp are not row changes
        db.start_project("a", T0).unwrap();
        db.touch_alive(T0 + 30_000).unwrap();
        assert!(db.pending(Entity::Project, 10).unwrap().is_empty());

        // closing the session books one entry with the session id
        db.pause_all_running(T0 + 60_000).unwrap();
        let e = db.pending(Entity::Entry, 10).unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].id, format!("a@{T0}"));

        // a change made while a push is in flight is kept for the next push
        db.update_project("a", "A2", 10.0, 1).unwrap();
        let stale = db.pending(Entity::Project, 10).unwrap();
        db.update_project("a", "A3", 10.0, 1).unwrap();
        db.ack(Entity::Project, &stale).unwrap();
        assert_eq!(db.pending(Entity::Project, 10).unwrap()[0].row.as_ref().unwrap()["name"], "A3");

        // a delete goes up as a tombstone, its entries too
        db.delete_project("a").unwrap();
        assert!(db.pending(Entity::Project, 10).unwrap()[0].row.is_none());
        assert!(db.pending(Entity::Entry, 10).unwrap()[0].row.is_none());
    }

    #[test]
    fn switching_accounts_wipes_without_sending_deletes() {
        let db = fresh("sync_wipe");
        db.create_project("a", "A", 0.0, 1, T0).unwrap();
        db.start_project("a", T0).unwrap();
        db.pause_all_running(T0 + 60_000).unwrap();
        assert!(db.unsynced_changes().unwrap() > 0);

        db.wipe_local_data().unwrap();
        assert!(db.list_projects(false).unwrap().is_empty());
        assert_eq!(entry_count(&db), 0);
        assert_eq!(daily_sum(&db), 0);
        // nothing queued: the old account's server copy is left alone
        assert_eq!(db.unsynced_changes().unwrap(), 0);
    }

    #[test]
    fn rows_and_derived_totals_converge() {
        let mut server = Server::default();
        let mut desk = Device::new("sync_rows_desk", "desk");
        let mut phone = Device::new("sync_rows_phone", "phone");

        desk.db.create_project("a", "A", 50.0, 1, T0).unwrap();
        desk.db.start_project("a", T0).unwrap();
        desk.db.pause_all_running(T0 + 90 * 60_000).unwrap();
        desk.sync(&mut server, T0 + 91 * 60_000);
        phone.sync(&mut server, T0 + 92 * 60_000);

        assert_eq!(totals(&phone.db), vec![("a".into(), 5400)]);
        assert_eq!(daily_sum(&phone.db), 5400);

        // pulling the same rows again changes nothing
        phone.cursor.clear();
        phone.sync(&mut server, T0 + 93 * 60_000);
        assert_eq!(totals(&phone.db), vec![("a".into(), 5400)]);
        assert_eq!(daily_sum(&phone.db), 5400);

        // reset on the phone: its entry tombstones clear the desktop's totals
        phone.db.reset_project("a").unwrap();
        phone.sync(&mut server, T0 + 94 * 60_000);
        desk.sync(&mut server, T0 + 95 * 60_000);
        assert_eq!(totals(&desk.db), vec![("a".into(), 0)]);
        assert_eq!(daily_sum(&desk.db), 0);

        // a rename on one side reaches the other
        desk.db.update_project("a", "Renamed", 50.0, 2).unwrap();
        desk.sync(&mut server, T0 + 96 * 60_000);
        phone.sync(&mut server, T0 + 97 * 60_000);
        let p = project(&phone.db, "a");
        assert_eq!((p.name.as_str(), p.people_count), ("Renamed", 2));

        // deleting reaches the other side
        phone.db.delete_project("a").unwrap();
        phone.sync(&mut server, T0 + 98 * 60_000);
        desk.sync(&mut server, T0 + 99 * 60_000);
        assert!(desk.db.get_project("a").unwrap().is_none());
    }

    #[test]
    fn one_timer_across_devices() {
        let mut server = Server::default();
        let mut desk = Device::new("sync_timer_desk", "desk");
        let mut phone = Device::new("sync_timer_phone", "phone");
        desk.db.create_project("a", "A", 0.0, 1, T0).unwrap();
        desk.db.create_project("b", "B", 0.0, 1, T0).unwrap();
        desk.sync(&mut server, T0);
        phone.sync(&mut server, T0);

        // started on the desktop: the phone shows it running from the same moment
        desk.db.start_project("a", T0 + 1_000).unwrap();
        desk.sync(&mut server, T0 + 2_000);
        phone.sync(&mut server, T0 + 3_000);
        assert_eq!(running(&phone.db), Some(("a".into(), T0 + 1_000)));

        // the desktop closes: a session started there stops, ...
        desk.db.pause_own_running(T0 + 61_000).unwrap();
        desk.sync(&mut server, T0 + 62_000);
        phone.sync(&mut server, T0 + 63_000);
        assert_eq!(running(&phone.db), None);
        assert_eq!(totals(&phone.db), vec![("a".into(), 60), ("b".into(), 0)]);

        // ... but one started on the phone keeps running
        phone.db.start_project("b", T0 + 100_000).unwrap();
        phone.sync(&mut server, T0 + 101_000);
        desk.sync(&mut server, T0 + 102_000);
        assert_eq!(running(&desk.db), Some(("b".into(), T0 + 100_000)));
        desk.db.pause_own_running(T0 + 110_000).unwrap(); // desktop exit
        assert_eq!(running(&desk.db), Some(("b".into(), T0 + 100_000)));
        assert!(desk.db.recover_interrupted_runs().unwrap().is_empty());

        // stopped on the desktop: both devices book the same single entry
        desk.db.pause_all_running(T0 + 160_000).unwrap();
        desk.sync(&mut server, T0 + 161_000);
        phone.sync(&mut server, T0 + 162_000);
        desk.sync(&mut server, T0 + 163_000);
        assert_eq!(running(&phone.db), None);
        assert_eq!(totals(&phone.db), vec![("a".into(), 60), ("b".into(), 60)]);
        assert_eq!(totals(&desk.db), totals(&phone.db));
        assert_eq!(entry_count(&phone.db), 2);

        // both start offline: the later start wins, the other is booked up to it
        desk.db.start_project("a", T0 + 200_000).unwrap();
        phone.db.start_project("b", T0 + 230_000).unwrap();
        desk.sync(&mut server, T0 + 240_000);
        phone.sync(&mut server, T0 + 241_000);
        desk.sync(&mut server, T0 + 242_000);
        phone.sync(&mut server, T0 + 243_000);
        assert_eq!(running(&desk.db), Some(("b".into(), T0 + 230_000)));
        assert_eq!(running(&phone.db), Some(("b".into(), T0 + 230_000)));
        assert_eq!(totals(&desk.db), vec![("a".into(), 90), ("b".into(), 60)]);
        assert_eq!(totals(&desk.db), totals(&phone.db));
        assert_eq!(daily_sum(&desk.db), daily_sum(&phone.db));
    }
}
