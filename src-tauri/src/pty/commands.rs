//! Tauri commands for the frontend. Output is streamed over a `Channel` as raw bytes
//! (ArrayBuffer on the JS side), which avoids JSON/base64 overhead and UTF-8 splitting issues.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use super::manager::{PtyEvents, PtyId, PtyManager, SpawnOptions, SpawnedPty};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub exit_code: Option<u32>,
}

struct ChannelEvents {
    data: Channel<InvokeResponseBody>,
    exit: Channel<PtyExit>,
}

impl PtyEvents for ChannelEvents {
    fn data(&self, bytes: Vec<u8>) {
        let _ = self.data.send(InvokeResponseBody::Raw(bytes));
    }
    fn exit(&self, code: Option<u32>) {
        let _ = self.exit.send(PtyExit { exit_code: code });
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySpawnRequest {
    pub program: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

#[tauri::command]
pub fn pty_spawn(
    manager: State<'_, PtyManager>,
    request: PtySpawnRequest,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<PtyExit>,
) -> Result<SpawnedPty, String> {
    let opts = SpawnOptions {
        program: request.program,
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        cols: request.cols,
        rows: request.rows,
    };
    manager.spawn(
        opts,
        Arc::new(ChannelEvents {
            data: on_data,
            exit: on_exit,
        }),
    )
}

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, id: PtyId, data: String) -> Result<(), String> {
    manager.write(id, data.as_bytes())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: PtyId,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(id, cols, rows)
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: PtyId) -> Result<(), String> {
    manager.kill(id)
}
