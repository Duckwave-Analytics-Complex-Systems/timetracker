// Bakes the cloud server (Supabase project URL + anon key) into the app, so
// nobody has to type it and the UI never shows it. Taken, first found wins,
// from TT_SUPABASE_URL / TT_SUPABASE_ANON_KEY, then the mobile app's
// EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY (environment, then
// its `.env.local` next to this repo). Without them the app builds fine, but
// signing in to Cloud sync says the build has no server.
use std::{env, fs, path::Path};

fn main() {
    let env_file = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env.local");
    println!("cargo:rerun-if-changed={}", env_file.display());
    let file = fs::read_to_string(&env_file).unwrap_or_default();
    let from_file = |key: &str| {
        file.lines()
            .filter_map(|l| l.trim().split_once('='))
            .find(|(k, _)| k.trim() == key)
            .map(|(_, v)| v.trim().trim_matches(['"', '\'']).to_string())
    };
    for (out, keys) in [
        ("TT_SUPABASE_URL", ["TT_SUPABASE_URL", "EXPO_PUBLIC_SUPABASE_URL"]),
        ("TT_SUPABASE_ANON_KEY", ["TT_SUPABASE_ANON_KEY", "EXPO_PUBLIC_SUPABASE_ANON_KEY"]),
    ] {
        for k in keys {
            println!("cargo:rerun-if-env-changed={k}");
        }
        let value = keys
            .iter()
            .find_map(|k| env::var(k).ok().filter(|v| !v.trim().is_empty()))
            .or_else(|| keys.iter().find_map(|k| from_file(k)))
            .unwrap_or_default();
        println!("cargo:rustc-env={out}={}", value.trim());
    }
    tauri_build::build()
}
