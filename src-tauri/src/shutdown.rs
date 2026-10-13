//! Making sure a running timer stops when the app stops.
//!
//! Layered, because no single hook sees every way an app can end:
//!
//! | how the app ends                          | what pauses the timer                   |
//! |-------------------------------------------|-----------------------------------------|
//! | × button, Alt+F4, taskbar "Close"         | `CloseRequested` on the main window     |
//! | any orderly exit (`app.exit`, last window)| `RunEvent::Exit`                        |
//! | Linux logout/shutdown, `kill`, Ctrl+C     | SIGTERM/SIGINT/SIGHUP handler below     |
//! | crash, SIGKILL, power loss, Windows       | next launch: `recover_interrupted_runs` |
//! | shutdown                                  | closes it at the last liveness stamp    |
//!
//! Pausing is idempotent, so several layers firing for one exit is fine.

use crate::db::Db;
use crate::now_ms;
use tauri::{AppHandle, Manager};

/// Closes the open session (if any) as of now.
pub fn pause_timers(app: &AppHandle) {
    if let Err(e) = app.state::<Db>().pause_all_running(now_ms()) {
        eprintln!("pause on exit failed: {e}");
    }
}

/// Pauses the timer and exits on SIGTERM / SIGINT / SIGHUP. No-op on Windows.
pub fn install_signal_handlers(app: AppHandle) {
    #[cfg(unix)]
    unix::install(move || {
        pause_timers(&app);
        app.exit(0);
        // If the event loop is already gone, don't hang the shutdown.
        std::thread::sleep(std::time::Duration::from_secs(3));
        std::process::exit(0);
    });
    #[cfg(not(unix))]
    let _ = app;
}

#[cfg(unix)]
mod unix {
    //! The classic self-pipe: the signal handler only writes one byte (the
    //! only kind of work that is safe inside a handler), and an ordinary
    //! thread blocked on the pipe does the real work.
    use std::sync::atomic::{AtomicI32, Ordering};

    static WRITE_FD: AtomicI32 = AtomicI32::new(-1);

    extern "C" fn on_signal(_sig: libc::c_int) {
        let fd = WRITE_FD.load(Ordering::Relaxed);
        if fd >= 0 {
            let byte = 1u8;
            unsafe { libc::write(fd, &byte as *const u8 as *const libc::c_void, 1) };
        }
    }

    pub fn install(on_terminate: impl FnOnce() + Send + 'static) {
        let mut fds = [0 as libc::c_int; 2];
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            eprintln!("signal pipe unavailable; relying on crash recovery");
            return;
        }
        let [read_fd, write_fd] = fds;
        WRITE_FD.store(write_fd, Ordering::Relaxed);

        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            unsafe {
                let mut action: libc::sigaction = std::mem::zeroed();
                action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
                action.sa_flags = libc::SA_RESTART;
                libc::sigemptyset(&mut action.sa_mask);
                libc::sigaction(sig, &action, std::ptr::null_mut());
            }
        }

        std::thread::spawn(move || {
            let mut byte = 0u8;
            loop {
                let n = unsafe { libc::read(read_fd, &mut byte as *mut u8 as *mut libc::c_void, 1) };
                if n == 1 {
                    break;
                }
                if n < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return; // pipe closed or broken: nothing more to listen for
            }
            on_terminate();
        });
    }
}
