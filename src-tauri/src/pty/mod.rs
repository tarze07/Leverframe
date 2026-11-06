//! PtyManager: creates pseudo-terminals (ConPTY on Windows, openpty on Unix via `portable-pty`),
//! streams their output in batches and cleans up processes. Recording (asciicast) comes in stage 4 (#6).

mod batcher;
pub mod commands;
mod manager;
mod shell;

pub use batcher::{spawn_batcher, BATCH_INTERVAL, BATCH_MAX_BYTES};
pub use manager::{PtyEvents, PtyId, PtyManager, SpawnOptions, SpawnedPty};
pub use shell::{default_shell, home_dir, ShellCommand};
