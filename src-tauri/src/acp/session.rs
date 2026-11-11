//! One ACP agent process and its session: `initialize` → `session/new` → `session/prompt`,
//! permission requests answered by the UI, authentication, and the process lifecycle.
//! Everything the agent reports goes to the UI as [`AcpEvent`]s.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use super::launch::{AcpLaunch, CWD_MARKER};
use super::rpc::{CallError, Connection, Incoming, RpcError};

/// The ACP version Leverframe speaks (stable v1).
pub const PROTOCOL_VERSION: u64 = 1;
/// First start of an adapter may install packages (npx), so the handshake gets time.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(90);
/// Logging in may open a browser and wait for the user.
pub const AUTH_TIMEOUT: Duration = Duration::from_secs(600);
/// How long `session/new` waits for the working directory line of the launch script.
const CWD_WAIT: Duration = Duration::from_secs(15);
const STDERR_TAIL_LINES: usize = 20;

/// What the UI hears about an ACP session.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AcpEvent {
    /// `initialize` succeeded.
    Initialized {
        agent_info: Option<Value>,
        agent_capabilities: Value,
        auth_methods: Vec<Value>,
    },
    /// `session/new` needs a login first: call `authenticate` with one of the methods.
    AuthRequired {
        auth_methods: Vec<Value>,
        message: String,
    },
    /// The session exists; prompts can be sent.
    SessionReady {
        session_id: String,
        cwd: String,
        modes: Option<Value>,
        config_options: Option<Value>,
    },
    /// A `session/update` notification (message chunks, tool calls, plan, …), passed through.
    Update {
        update: Value,
    },
    /// The agent asks for permission; answer with `reply_permission`.
    Permission {
        request_id: u64,
        tool_call: Value,
        options: Vec<Value>,
    },
    /// A permission request was answered or cancelled (the UI removes it).
    PermissionClosed {
        request_id: u64,
    },
    /// A line from the agent's stderr (or non-protocol output).
    Log {
        line: String,
    },
    Error {
        message: String,
    },
    /// The agent process ended.
    Exited {
        code: Option<i32>,
        message: Option<String>,
    },
}

pub trait AcpEvents: Send + Sync + 'static {
    fn emit(&self, event: AcpEvent);
}

#[derive(Default)]
struct State {
    session_id: Option<String>,
    session_cwd: Option<String>,
    /// Permission requests waiting for the user: our id → the agent's JSON-RPC id.
    permissions: HashMap<u64, Value>,
    next_permission: u64,
    auth_methods: Vec<Value>,
}

/// State shared with the reader and stderr threads.
struct Shared {
    events: Arc<dyn AcpEvents>,
    state: Mutex<State>,
    /// Working directory reported by the launch script (see `launch`).
    reported_cwd: (Mutex<Option<String>>, Condvar),
    stderr_tail: Mutex<VecDeque<String>>,
    stopped: AtomicBool,
}

impl Shared {
    fn emit(&self, event: AcpEvent) {
        self.events.emit(event);
    }

    fn stderr_summary(&self) -> Option<String> {
        let tail = self.stderr_tail.lock().unwrap();
        (!tail.is_empty()).then(|| tail.iter().cloned().collect::<Vec<_>>().join("\n"))
    }
}

struct Handler(Arc<Shared>);

impl Incoming for Handler {
    fn request(&self, conn: &Connection, id: Value, method: &str, params: Value) {
        if method == "session/request_permission" {
            let mut st = self.0.state.lock().unwrap();
            st.next_permission += 1;
            let request_id = st.next_permission;
            st.permissions.insert(request_id, id);
            drop(st);
            self.0.emit(AcpEvent::Permission {
                request_id,
                tool_call: params.get("toolCall").cloned().unwrap_or(Value::Null),
                options: params
                    .get("options")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            });
        } else {
            // File system and terminal access are not offered yet (initialize says so).
            let _ = conn.respond(
                id,
                Err(RpcError::new(
                    RpcError::METHOD_NOT_FOUND,
                    format!("Leverframe nie obsługuje metody {method}"),
                )),
            );
        }
    }

    fn notification(&self, method: &str, mut params: Value) {
        if method != "session/update" {
            return;
        }
        let ours = self.0.state.lock().unwrap().session_id.clone();
        let theirs = params.get("sessionId").and_then(Value::as_str);
        if ours.is_some() && theirs.is_some() && ours.as_deref() != theirs {
            return;
        }
        if let Some(update) = params.get_mut("update").map(Value::take) {
            self.0.emit(AcpEvent::Update { update });
        }
    }

    fn invalid(&self, line: &str) {
        self.0.emit(AcpEvent::Log {
            line: format!("[stdout] {line}"),
        });
    }

    fn closed(&self) {}
}

pub struct AcpSession {
    shared: Arc<Shared>,
    conn: Arc<Connection>,
    child: Mutex<Child>,
    busy: AtomicBool,
}

impl AcpSession {
    /// Starts the agent process. The handshake (`initialize`, `session/new`) runs on a
    /// background thread; its outcome arrives as events.
    pub fn start(
        launch: &AcpLaunch,
        events: Arc<dyn AcpEvents>,
    ) -> Result<Arc<AcpSession>, String> {
        let mut command = Command::new(&launch.program);
        command.args(&launch.args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            if let Some(raw) = &launch.raw_args {
                command.raw_arg(raw);
            }
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        for (k, v) in &launch.env {
            command.env(k, v);
        }
        if let Some(dir) = launch.cwd.as_ref().filter(|d| d.is_dir()) {
            command.current_dir(dir);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|e| format!("Nie można uruchomić {}: {e}", launch.program))?;

        let shared = Arc::new(Shared {
            events,
            state: Mutex::new(State::default()),
            reported_cwd: (Mutex::new(launch.session_cwd.clone()), Condvar::new()),
            stderr_tail: Mutex::new(VecDeque::new()),
            stopped: AtomicBool::new(false),
        });
        let stdout = child.stdout.take().expect("piped stdout");
        let stdin = child.stdin.take().expect("piped stdin");
        let stderr = child.stderr.take().expect("piped stderr");
        spawn_stderr_reader(stderr, shared.clone());
        let conn = Connection::start(stdout, stdin, Arc::new(Handler(shared.clone())));
        let session = Arc::new(AcpSession {
            shared,
            conn,
            child: Mutex::new(child),
            busy: AtomicBool::new(false),
        });
        spawn_exit_watcher(&session);
        let s = session.clone();
        std::thread::Builder::new()
            .name("acp-handshake".into())
            .spawn(move || s.handshake())
            .map_err(|e| e.to_string())?;
        Ok(session)
    }

    fn handshake(&self) {
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false },
                "terminal": false
            },
            "clientInfo": { "name": "leverframe", "title": "Leverframe", "version": env!("CARGO_PKG_VERSION") }
        });
        let init = match self
            .conn
            .request("initialize", params, Some(HANDSHAKE_TIMEOUT))
        {
            Ok(r) => r,
            Err(e) => return self.fail(&format!("Agent nie odpowiedział na initialize: {e}")),
        };
        let version = init.get("protocolVersion").and_then(Value::as_u64);
        if version != Some(PROTOCOL_VERSION) {
            let v = version
                .map(|v| v.to_string())
                .unwrap_or_else(|| "nieznaną".into());
            return self.fail(&format!(
                "Agent używa wersji {v} protokołu ACP; Leverframe obsługuje wersję {PROTOCOL_VERSION}"
            ));
        }
        let auth_methods = init
            .get("authMethods")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        self.shared.state.lock().unwrap().auth_methods = auth_methods.clone();
        self.shared.emit(AcpEvent::Initialized {
            agent_info: init.get("agentInfo").cloned().filter(|v| !v.is_null()),
            agent_capabilities: init.get("agentCapabilities").cloned().unwrap_or(json!({})),
            auth_methods,
        });
        self.new_session();
    }

    /// `session/new`; reports `AuthRequired` when the agent wants a login first.
    fn new_session(&self) {
        let Some(cwd) = self.wait_for_cwd() else {
            return self.fail("Nie udało się ustalić katalogu roboczego agenta");
        };
        let params = json!({ "cwd": cwd, "mcpServers": [] });
        match self
            .conn
            .request("session/new", params, Some(HANDSHAKE_TIMEOUT))
        {
            Ok(r) => {
                let Some(session_id) = r.get("sessionId").and_then(Value::as_str).map(String::from)
                else {
                    return self.fail("Agent nie podał identyfikatora sesji");
                };
                let mut st = self.shared.state.lock().unwrap();
                st.session_id = Some(session_id.clone());
                st.session_cwd = Some(cwd.clone());
                drop(st);
                self.shared.emit(AcpEvent::SessionReady {
                    session_id,
                    cwd,
                    modes: r.get("modes").cloned().filter(|v| !v.is_null()),
                    config_options: r.get("configOptions").cloned().filter(|v| !v.is_null()),
                });
            }
            Err(CallError::Rpc(e)) if e.code == RpcError::AUTH_REQUIRED => {
                let auth_methods = self.shared.state.lock().unwrap().auth_methods.clone();
                self.shared.emit(AcpEvent::AuthRequired {
                    auth_methods,
                    message: e.message,
                });
            }
            Err(e) => self.fail(&format!("Nie udało się rozpocząć sesji: {e}")),
        }
    }

    fn wait_for_cwd(&self) -> Option<String> {
        let (lock, cv) = &self.shared.reported_cwd;
        let start = Instant::now();
        let mut cwd = lock.lock().unwrap();
        while cwd.is_none() {
            let left = CWD_WAIT.checked_sub(start.elapsed())?;
            if self.conn.is_closed() {
                return None;
            }
            cwd = cv
                .wait_timeout(cwd, left.min(Duration::from_millis(200)))
                .unwrap()
                .0;
        }
        cwd.clone()
    }

    fn fail(&self, message: &str) {
        // The agent's last stderr lines usually say what went wrong (missing login, bad flag).
        let message = match self.shared.stderr_summary() {
            Some(tail) => format!("{message}\n{tail}"),
            None => message.to_string(),
        };
        self.shared.emit(AcpEvent::Error { message });
    }

    pub fn session_id(&self) -> Option<String> {
        self.shared.state.lock().unwrap().session_id.clone()
    }

    /// Logs in with one of the agent's methods, then starts the session.
    pub fn authenticate(&self, method_id: &str) -> Result<(), String> {
        self.conn
            .request(
                "authenticate",
                json!({ "methodId": method_id }),
                Some(AUTH_TIMEOUT),
            )
            .map_err(|e| format!("Logowanie nie powiodło się: {e}"))?;
        self.new_session();
        Ok(())
    }

    /// Sends a text prompt and waits for the end of the turn; returns the stop reason
    /// (`end_turn`, `cancelled`, `max_tokens`, …). Updates arrive as events meanwhile.
    pub fn prompt(&self, text: &str) -> Result<String, String> {
        let session_id = self
            .session_id()
            .ok_or("Sesja agenta jeszcze się nie rozpoczęła")?;
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err("Agent jeszcze odpowiada na poprzednią wiadomość".into());
        }
        let result = self.conn.request(
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] }),
            None,
        );
        self.busy.store(false, Ordering::SeqCst);
        // A turn never leaves permission requests open.
        self.cancel_permissions();
        let response = result.map_err(|e| e.to_string())?;
        Ok(response
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or("end_turn")
            .to_string())
    }

    /// Stops the current turn. Open permission requests are answered with `cancelled`
    /// (the protocol requires it); the prompt then ends with `cancelled`.
    pub fn cancel(&self) -> Result<(), String> {
        let session_id = self.session_id().ok_or("Brak sesji")?;
        self.cancel_permissions();
        self.conn
            .notify("session/cancel", json!({ "sessionId": session_id }))
            .map_err(|e| e.to_string())
    }

    fn cancel_permissions(&self) {
        let open: Vec<(u64, Value)> = self
            .shared
            .state
            .lock()
            .unwrap()
            .permissions
            .drain()
            .collect();
        for (request_id, id) in open {
            let _ = self
                .conn
                .respond(id, Ok(json!({ "outcome": { "outcome": "cancelled" } })));
            self.shared.emit(AcpEvent::PermissionClosed { request_id });
        }
    }

    /// Answers a permission request: `Some(option id)` from the agent's options, or `None`
    /// to refuse without choosing (`cancelled`).
    pub fn reply_permission(&self, request_id: u64, option_id: Option<&str>) -> Result<(), String> {
        let id = self
            .shared
            .state
            .lock()
            .unwrap()
            .permissions
            .remove(&request_id)
            .ok_or("Ta prośba o zgodę jest już nieaktualna")?;
        let outcome = match option_id {
            Some(option) => json!({ "outcome": "selected", "optionId": option }),
            None => json!({ "outcome": "cancelled" }),
        };
        self.shared.emit(AcpEvent::PermissionClosed { request_id });
        self.conn
            .respond(id, Ok(json!({ "outcome": outcome })))
            .map_err(|e| e.to_string())
    }

    /// `session/set_mode` (e.g. "code" / "ask"). The UI updates on success; agents may also
    /// send `current_mode_update`.
    pub fn set_mode(&self, mode_id: &str) -> Result<(), String> {
        let session_id = self.session_id().ok_or("Brak sesji")?;
        self.conn
            .request(
                "session/set_mode",
                json!({ "sessionId": session_id, "modeId": mode_id }),
                Some(HANDSHAKE_TIMEOUT),
            )
            .map(|_| ())
            .map_err(|e| format!("Nie udało się zmienić trybu: {e}"))
    }

    /// `session/set_config_option`: a select (value id) or a boolean. The agent answers with
    /// all options, which go to the UI as a `config_option_update`.
    pub fn set_config_option(&self, config_id: &str, value: Value) -> Result<(), String> {
        let session_id = self.session_id().ok_or("Brak sesji")?;
        let mut params = json!({ "sessionId": session_id, "configId": config_id, "value": value });
        if value.is_boolean() {
            params["type"] = json!("boolean");
        }
        let response = self
            .conn
            .request("session/set_config_option", params, Some(HANDSHAKE_TIMEOUT))
            .map_err(|e| format!("Nie udało się zmienić ustawienia: {e}"))?;
        if let Some(options) = response.get("configOptions").filter(|o| o.is_array()) {
            self.shared.emit(AcpEvent::Update {
                update: json!({ "sessionUpdate": "config_option_update", "configOptions": options }),
            });
        }
        Ok(())
    }

    /// Ends the agent process.
    pub fn stop(&self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        kill_tree(&mut self.child.lock().unwrap());
    }

    pub fn is_running(&self) -> bool {
        matches!(self.child.lock().unwrap().try_wait(), Ok(None))
    }
}

impl Drop for AcpSession {
    fn drop(&mut self) {
        kill_tree(&mut self.child.lock().unwrap());
    }
}

/// Ends the agent. On Windows it runs under `cmd.exe`, which `kill` alone would end while the
/// agent kept running: the whole process tree goes. (On Unix the script `exec`s the agent.)
fn kill_tree(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn spawn_stderr_reader(stderr: impl Read + Send + 'static, shared: Arc<Shared>) {
    let _ = std::thread::Builder::new()
        .name("acp-stderr".into())
        .spawn(move || {
            for line in BufReader::new(stderr).split(b'\n') {
                let Ok(bytes) = line else { break };
                let line = String::from_utf8_lossy(&bytes).trim_end().to_string();
                if let Some(dir) = line.strip_prefix(CWD_MARKER) {
                    let (lock, cv) = &shared.reported_cwd;
                    *lock.lock().unwrap() = Some(dir.to_string());
                    cv.notify_all();
                    continue;
                }
                if line.is_empty() {
                    continue;
                }
                let mut tail = shared.stderr_tail.lock().unwrap();
                tail.push_back(line.clone());
                if tail.len() > STDERR_TAIL_LINES {
                    tail.pop_front();
                }
                drop(tail);
                shared.emit(AcpEvent::Log { line });
            }
        });
}

/// Reports the end of the process once (exit code and the last stderr lines).
fn spawn_exit_watcher(session: &Arc<AcpSession>) {
    let weak = Arc::downgrade(session);
    let shared = session.shared.clone();
    let _ = std::thread::Builder::new()
        .name("acp-exit".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(100));
            let Some(session) = weak.upgrade() else {
                return;
            };
            let status = session.child.lock().unwrap().try_wait();
            match status {
                Ok(None) => continue,
                Ok(Some(status)) => {
                    // Let the stderr reader catch the last lines.
                    std::thread::sleep(Duration::from_millis(100));
                    let stopped = shared.stopped.load(Ordering::SeqCst);
                    shared.emit(AcpEvent::Exited {
                        code: status.code(),
                        message: if stopped {
                            None
                        } else {
                            shared.stderr_summary()
                        },
                    });
                    return;
                }
                Err(e) => {
                    shared.emit(AcpEvent::Exited {
                        code: None,
                        message: Some(e.to_string()),
                    });
                    return;
                }
            }
        });
}
