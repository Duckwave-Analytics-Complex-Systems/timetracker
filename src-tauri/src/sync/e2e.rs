//! Whole sync cycles for two people, against real row-level security. See
//! supabase/test/README.md for how to run these. Without TT_E2E_URL they pass
//! without doing anything.

use super::*;
use crate::db::PhaseInput;

const ANN: &str = "00000000-0000-0000-0000-00000000000a";
const BOB: &str = "00000000-0000-0000-0000-00000000000b";
const T0: i64 = 1_800_000_000_000;

struct Device {
    db: Db,
    cfg: Config,
    user: &'static str,
}

impl Device {
    fn new(tag: &str, user: &'static str, url: &str) -> Device {
        let dir = std::env::temp_dir().join(format!("timetrack_e2e_{tag}_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let db = db::init(dir).unwrap();
        db.set_sync_meta(K_USER_ID, Some(user)).unwrap();
        Device { db, cfg: Config { url: url.into(), anon_key: String::new() }, user }
    }

    fn rest(&self) -> Rest<'_> {
        Rest { cfg: &self.cfg, token: self.user }
    }

    fn sync(&self) {
        let session = Session {
            access_token: self.user.into(),
            refresh_token: String::new(),
            expires_at: i64::MAX / 2,
            user_id: self.user.into(),
            email: format!("{}@x.com", &self.user[35..]),
        };
        cycle(&self.db, &self.cfg, session).unwrap();
    }

    fn project(&self, id: &str) -> db::Project {
        self.db.get_project(id).unwrap().unwrap()
    }

    fn feature_free_phase(&self, project: &str, name: &str) -> String {
        let input = PhaseInput {
            id: None,
            project_id: project.into(),
            name: name.into(),
            kind: "phase".into(),
            color: 0,
            start_day: "2027-01-01".into(),
            end_day: "2027-01-02".into(),
            estimated_hours: 0.0,
            progress: 0,
        };
        self.db.save_phase(&input, T0).unwrap()
    }

    fn profile(&self) -> Profile {
        load(&self.db, K_PROFILE).unwrap()
    }
}

fn daily(d: &Device) -> i64 {
    d.db.daily_range("2000-01-01", "2100-01-01").unwrap().iter().map(|r| r.seconds).sum()
}

#[test]
fn two_people_share_a_project() {
    let Ok(url) = std::env::var("TT_E2E_URL") else { return };
    let ann = Device::new("ann", ANN, &url);
    let bob = Device::new("bob", BOB, &url);

    // Ann tracks time alone first, so Bob must get history older than his cursors.
    ann.db.create_project("p", "Site", 100.0, 3, T0).unwrap();
    let design = ann.feature_free_phase("p", "Design");
    ann.db.set_active_phase("p", Some(&design), T0).unwrap();
    ann.db.start_project("p", T0).unwrap();
    ann.db.stop_timer(T0 + 60_000).unwrap();
    ann.db.enqueue_all().unwrap();
    ann.sync();
    bob.sync();
    assert!(bob.db.get_project("p").unwrap().is_none(), "not shared yet");
    assert!(!ann.project("p").shared);
    assert_eq!(ann.project("p").bill(3600), 300.0, "alone, people_count applies");

    // Share by code.
    let added = ann.rest().rpc("add_member", json!({ "p_project_id": "p", "p_share_code": bob.profile().share_code })).unwrap();
    assert_eq!(added.as_str(), Some("b"));
    ann.sync();
    bob.sync();
    let p = bob.project("p");
    assert_eq!(p.name, "Site");
    assert_eq!(p.total_seconds, 60, "history arrived");
    assert!(p.shared && !p.is_owner);
    assert_eq!(p.bill(3600), 100.0, "shared: one rate, people_count ignored");
    assert_eq!(p.active_phase_id, None, "Ann's active phase isn't Bob's");
    assert_eq!(daily(&bob), 0, "Ann's hours aren't in Bob's Today and Stats");
    assert_eq!(bob.db.project_daily("p").unwrap().iter().map(|d| d.seconds).sum::<i64>(), 60, "but are in the project's");
    assert_eq!(bob.db.unsynced_changes().unwrap(), 0, "pulling queues nothing");
    assert!(ann.project("p").shared && ann.project("p").is_owner);

    // Bob works under his own phase.
    let build = bob.feature_free_phase("p", "Build");
    bob.db.set_active_phase("p", Some(&build), T0).unwrap();
    bob.db.start_project("p", T0 + 100_000).unwrap();
    bob.db.stop_timer(T0 + 130_000).unwrap();
    bob.sync();
    ann.sync();
    assert_eq!(ann.project("p").total_seconds, 90);
    assert_eq!(daily(&ann), 60, "Bob's hours aren't in Ann's Today and Stats");
    assert_eq!(ann.project("p").active_phase_id.as_deref(), Some(design.as_str()), "Bob's switch didn't move Ann");
    assert_eq!(ann.db.list_phases("p").unwrap().len(), 2);
    let hours = ann.db.member_hours("p").unwrap();
    assert_eq!(hours.iter().map(|m| m.seconds).sum::<i64>(), 90);
    assert_eq!(hours.iter().find(|m| m.is_me).unwrap().seconds, 60);
    let ids: Vec<String> = bob.db.list_sessions("p").unwrap().iter().map(|s| s.id.clone()).collect();
    assert!(ids.iter().any(|i| i.ends_with(BOB)), "shared sessions carry the person: {ids:?}");

    // Another of Bob's devices gets his own choices and his own daily time.
    let bob2 = Device::new("bob2", BOB, &url);
    bob2.sync();
    assert_eq!(bob2.project("p").active_phase_id.as_deref(), Some(build.as_str()));
    assert_eq!(daily(&bob2), 30);
    assert_eq!(bob2.project("p").total_seconds, 90);

    // Notes: your own only.
    let anns = ann.db.list_sessions("p").unwrap();
    let bobs_id = anns.iter().find(|s| !s.mine).unwrap().id.clone();
    ann.db.set_entry_note(&bobs_id, Some("not mine")).unwrap();
    assert!(ann.db.list_sessions("p").unwrap().iter().find(|s| s.id == bobs_id).unwrap().note.is_none());
    bob.db.set_entry_note(&bobs_id, Some("did it")).unwrap();
    bob.sync();
    ann.sync();
    assert_eq!(ann.db.list_sessions("p").unwrap().iter().find(|s| s.id == bobs_id).unwrap().note.as_deref(), Some("did it"));

    // A member's direct change to the project row is refused, undone and doesn't block sync.
    bob.db.update_project("p", "Hacked", 0.0, 1).unwrap();
    let extra = bob.feature_free_phase("p", "After refusal");
    bob.sync();
    assert_eq!(bob.project("p").name, "Site", "undone");
    assert_eq!(bob.db.unsynced_changes().unwrap(), 0, "not stuck");
    assert_eq!(bob.db.sync_meta(K_REFUSED).unwrap().as_deref(), Some("1"));
    ann.sync();
    assert_eq!(ann.project("p").name, "Site");
    assert!(ann.db.list_phases("p").unwrap().iter().any(|ph| ph.id == extra), "other changes still went up");

    // Deleting a phase unassigns everyone's time, and nobody's total moves.
    ann.db.delete_phase(&build).unwrap();
    ann.sync();
    bob.sync();
    assert_eq!(ann.db.unsynced_changes().unwrap(), 0);
    assert_eq!(bob.project("p").active_phase_id, None);
    assert_eq!(bob.db.list_sessions("p").unwrap().iter().find(|s| s.id == bobs_id).unwrap().phase_id, None);
    assert_eq!(bob.project("p").total_seconds, 90);

    // Reset removes only your own time, everywhere.
    bob.db.reset_project("p").unwrap();
    assert_eq!(bob.project("p").total_seconds, 60);
    assert_eq!(daily(&bob), 0);
    bob.sync();
    ann.sync();
    assert_eq!(ann.project("p").total_seconds, 60);
    assert_eq!(daily(&ann), 60);

    // Filing while Bob's timer runs books his session instead of leaving it unseen.
    bob.db.start_project("p", now_ms() - 120_000).unwrap();
    bob.sync();
    ann.db.set_archived("p", true, now_ms()).unwrap();
    ann.sync();
    bob.sync();
    assert!(!bob.project("p").is_running);
    ann.db.set_archived("p", false, now_ms()).unwrap();
    ann.sync();
    bob.sync();
    ann.sync();
    assert!(ann.project("p").total_seconds > 60, "Bob's filed session reached Ann");
    let after_filing = ann.project("p").total_seconds;

    // Removing Bob: gone from his devices, his time stays with Ann.
    ann.rest().rpc("remove_member", json!({ "p_project_id": "p", "p_user_id": BOB })).unwrap();
    ann.sync();
    bob.sync();
    assert!(bob.db.get_project("p").unwrap().is_none());
    assert_eq!(bob.db.unsynced_changes().unwrap(), 0);
    assert_eq!(ann.project("p").total_seconds, after_filing);
    assert!(!ann.project("p").shared);
    assert!(ann.db.member_hours("p").unwrap().iter().any(|m| m.role == "former"));
    assert!(ann.db.list_sessions("p").unwrap().iter().any(|s| s.user_name.as_deref() == Some("Former member")));

    // Added back: the whole history returns.
    ann.rest().rpc("add_member", json!({ "p_project_id": "p", "p_share_code": bob.profile().share_code })).unwrap();
    bob.sync();
    assert_eq!(bob.project("p").total_seconds, after_filing);

    // The owner deletes it: gone everywhere.
    ann.db.delete_project("p").unwrap();
    ann.sync();
    bob.sync();
    assert!(bob.db.get_project("p").unwrap().is_none());
    assert_eq!(bob.db.unsynced_changes().unwrap(), 0);
}
