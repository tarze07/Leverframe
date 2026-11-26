//! Start of the app (#115). The window shows the start screen of `index.html` in the theme's
//! colors until the interface has drawn itself; nothing slow runs on the window's thread (the
//! profiles are detected in the background, commands that may wait are async).
//! `LEVERFRAME_TRACE_STARTUP=1` prints the times of the steps to stderr.

use std::sync::OnceLock;
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();

/// The moment the process started (the first call).
pub fn begin() {
    START.get_or_init(Instant::now);
}

/// Milliseconds since `begin`.
pub fn elapsed_ms() -> u128 {
    START.get_or_init(Instant::now).elapsed().as_millis()
}

fn tracing() -> bool {
    std::env::var_os("LEVERFRAME_TRACE_STARTUP").is_some_and(|v| v != "0" && !v.is_empty())
}

/// Notes a step of the start (printed with `LEVERFRAME_TRACE_STARTUP=1`).
pub fn mark(step: &str) {
    if tracing() {
        eprintln!("[leverframe start] {:>6} ms  {step}", elapsed_ms());
    }
}

/// A step of the interface's start (`step`), for the times printed by `mark`.
#[tauri::command]
pub fn app_ready(step: Option<String>) {
    mark(&format!(
        "interfejs: {}",
        step.as_deref().unwrap_or("gotowy")
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn counts_from_the_first_call() {
        begin();
        let a = elapsed_ms();
        std::thread::sleep(Duration::from_millis(5));
        assert!(elapsed_ms() >= a + 5);
        // Silent without the variable.
        mark("test");
    }
}
