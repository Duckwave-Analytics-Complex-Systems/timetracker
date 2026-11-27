//! "A new version is available": the update notice.
//!
//! TimeTrack doesn't update itself. It reads a small public manifest
//! (`version.json` at the root of the repository, see README "Releasing a
//! new version"), compares it with its own version, and the widget shows a
//! bar that opens the download page. Running the new installer upgrades in
//! place; the data folder is never touched.
//!
//! The manifest can also set `min_supported`: older versions stop cloud sync
//! (see `sync::run_cycle`) so they can't write data in a shape the server no
//! longer expects. Local tracking keeps working.

use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// Baked into every build: changing it only reaches installs made after the
/// change, so keep this file published here even if the website hosts its own.
const MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/Duckwave-Analytics-Complex-Systems/timetracker/main/version.json";

/// version.json as published.
#[derive(Deserialize)]
struct Manifest {
    latest: String,
    #[serde(default)]
    min_supported: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    download_url: String,
}

/// What the widget shows.
#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    /// A newer version exists.
    pub available: bool,
    /// This version is below `min_supported`: cloud sync is off until updated.
    pub required: bool,
    pub notes: Option<String>,
    pub download_url: String,
}

/// The last successful check, for `open_download` and the sync gate.
#[derive(Default)]
pub struct UpdateState(Mutex<Option<UpdateInfo>>);

/// Compares dotted versions numerically ("6.10.0" > "6.9.2"). A leading "v"
/// and anything after "-" or "+" are ignored; missing parts count as 0.
pub fn compare(a: &str, b: &str) -> Ordering {
    fn parts(v: &str) -> Vec<u64> {
        let core = v.trim().trim_start_matches(['v', 'V']);
        let core = core.split(['-', '+']).next().unwrap_or("");
        core.split('.').map(|p| p.trim().parse().unwrap_or(0)).collect()
    }
    let (a, b) = (parts(a), parts(b));
    for i in 0..a.len().max(b.len()) {
        let ord = a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0));
        if ord != Ordering::Equal {
            return ord;
        }
    }
    Ordering::Equal
}

fn evaluate(current: &str, m: Manifest) -> Result<UpdateInfo, String> {
    // Only ever hand an https page to the browser.
    if !m.download_url.starts_with("https://") {
        return Err("The update manifest has no valid download link.".into());
    }
    Ok(UpdateInfo {
        current: current.to_string(),
        available: compare(&m.latest, current) == Ordering::Greater,
        required: m
            .min_supported
            .as_deref()
            .is_some_and(|min| compare(current, min) == Ordering::Less),
        latest: m.latest,
        notes: m.notes.filter(|n| !n.trim().is_empty()),
        download_url: m.download_url,
    })
}

/// Fetches the manifest and remembers the result. Blocking.
pub fn check(app: &AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let text = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build()
        .get(MANIFEST_URL)
        .set("Cache-Control", "no-cache")
        .call()
        .map_err(|e| format!("Couldn't check for updates: {e}"))?
        .into_string()
        .map_err(|e| format!("Couldn't check for updates: {e}"))?;
    let manifest: Manifest =
        serde_json::from_str(&text).map_err(|e| format!("Couldn't read the update manifest: {e}"))?;
    let info = evaluate(&current, manifest)?;
    *app.state::<UpdateState>().0.lock().unwrap() = Some(info.clone());
    Ok(info)
}

/// Cloud sync stays off on a version the manifest no longer supports.
pub fn sync_blocked(app: &AppHandle) -> bool {
    app.state::<UpdateState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|i| i.required)
}

/// Opens the download page from the last check in the default browser.
/// The URL never comes from the frontend.
pub fn open_download(app: &AppHandle) -> Result<(), String> {
    let url = app
        .state::<UpdateState>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|i| i.download_url.clone())
        .ok_or("Check for updates first.")?;
    open_in_browser(&url).map_err(|e| format!("Couldn't open the browser: {e}"))
}

fn open_in_browser(url: &str) -> std::io::Result<()> {
    // No shell in between: the URL is a single argument, never parsed.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(url);
        c
    };
    cmd.spawn().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(latest: &str, min: Option<&str>, url: &str) -> Manifest {
        Manifest {
            latest: latest.into(),
            min_supported: min.map(Into::into),
            notes: Some("  ".into()),
            download_url: url.into(),
        }
    }

    #[test]
    fn compares_numerically() {
        assert_eq!(compare("6.10.0", "6.9.9"), Ordering::Greater);
        assert_eq!(compare("v6.2.0", "6.2"), Ordering::Equal);
        assert_eq!(compare("6.2.0-beta.1", "6.2.0"), Ordering::Equal);
        assert_eq!(compare("6.2.0", "6.2.1"), Ordering::Less);
        assert_eq!(compare("7", "6.99.99"), Ordering::Greater);
    }

    #[test]
    fn newer_version_is_available() {
        let i = evaluate("6.2.0", manifest("6.3.0", None, "https://x.test/d")).unwrap();
        assert!(i.available && !i.required);
        assert_eq!(i.notes, None); // blank notes dropped
    }

    #[test]
    fn same_or_older_is_not() {
        assert!(!evaluate("6.2.0", manifest("6.2.0", None, "https://x.test/d")).unwrap().available);
        assert!(!evaluate("6.3.0", manifest("6.2.0", None, "https://x.test/d")).unwrap().available);
    }

    #[test]
    fn below_min_supported_is_required() {
        assert!(evaluate("6.1.0", manifest("6.3.0", Some("6.2.0"), "https://x.test/d")).unwrap().required);
        assert!(!evaluate("6.2.0", manifest("6.3.0", Some("6.2.0"), "https://x.test/d")).unwrap().required);
    }

    #[test]
    fn rejects_non_https_links() {
        assert!(evaluate("6.2.0", manifest("6.3.0", None, "http://x.test/d")).is_err());
        assert!(evaluate("6.2.0", manifest("6.3.0", None, "file:///C:/evil.exe")).is_err());
    }
}
