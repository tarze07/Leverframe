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

use super::fs::{is_inside, lexical, slice_lines, to_local, FsKind};
use super::launch::{AcpLaunch, CWD_MARKER};
use super::rpc::{CallError, Connection, Incoming, RpcError};
use super::terminal::{spawn_options, AgentTerminal, CommandRequest, ExitStatus, CURSOR_POSITION};
use crate::pty::{PtyEvents, PtyManager};

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
    /// The agent reads (`read`) or writes (`write`) a file; answer with `reply_fs`. The UI
    /// reads open editors (unsaved changes included) and asks the user when `inside` is false.
    FsRequest {
        request_id: u64,
        op: String,
        /// The file on this machine.
        path: String,
        /// Inside the session folder (`..` and symbolic links resolved).
        inside: bool,
        /// New content (`write`).
        content: Option<String>,
    },
    /// A file request was answered or dropped (turn cancelled).
    FsClosed {
        request_id: u64,
    },
    /// The agent wants to run a command; answer with `reply_terminal` (the UI asks the user,
    /// unless commands are allowed without asking).
    TerminalRequest {
        request_id: u64,
        /// The command line, quoted for display.
        command: String,
        /// Working directory (the agent's path; the session folder when it gives none).
        cwd: Option<String>,
    },
    /// A command request was answered or dropped (turn cancelled).
    TerminalRequestClosed {
        request_id: u64,
    },
    /// A command started; its output and end follow.
    TerminalStarted {
        terminal_id: String,
        command: String,
        cwd: Option<String>,
    },
    TerminalOutput {
        terminal_id: String,
        data: String,
    },
    TerminalExit {
        terminal_id: String,
        exit_code: Option<u32>,
        signal: Option<String>,
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
    /// File requests waiting for the UI.
    fs_requests: HashMap<u64, PendingFs>,
    /// Commands waiting for the user: our id → (the agent's JSON-RPC id, the command).
    terminal_requests: HashMap<u64, (Value, CommandRequest)>,
    /// Running or finished commands the agent has not released.
    terminals: HashMap<String, Arc<AgentTerminal>>,
    next_terminal: u64,
    next_permission: u64,
    auth_methods: Vec<Value>,
    /// `agentCapabilities` from `initialize`.
    capabilities: Value,
    /// `session/load` is replaying a conversation the UI already shows: its messages are dropped.
    hide_replay: bool,
    /// The session being opened by `session/load` (its replay arrives before the answer).
    opening: Option<String>,
}

/// Updates that make up a conversation (replayed by `session/load`), as opposed to session
/// state such as modes or commands.
fn is_conversation_update(update: &Value) -> bool {
    matches!(
        update.get("sessionUpdate").and_then(Value::as_str),
        Some(
            "agent_message_chunk"
                | "agent_thought_chunk"
                | "user_message_chunk"
                | "tool_call"
                | "tool_call_update"
                | "plan"
        )
    )
}

struct PendingFs {
    id: Value,
    write: bool,
    line: Option<u64>,
    limit: Option<u64>,
}

/// State shared with the reader and stderr threads.
struct Shared {
    /// File access offered to the agent (`None`: not offered, e.g. on SSH hosts).
    fs: Option<FsKind>,
    events: Arc<dyn AcpEvents>,
    state: Mutex<State>,
    /// Working directory reported by the launch script (see `launch`).
    reported_cwd: (Mutex<Option<String>>, Condvar),
    stderr_tail: Mutex<VecDeque<String>>,
    stopped: AtomicBool,
    /// PTYs of the agent's commands (separate from the user's terminals).
    ptys: Arc<PtyManager>,
    /// For answers sent later from other threads (`terminal/wait_for_exit`).
    conn: std::sync::OnceLock<std::sync::Weak<Connection>>,
    /// This value itself, for PTY events that must not keep the session alive.
    me: std::sync::Weak<Shared>,
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
        } else if let (Some(kind), "fs/read_text_file" | "fs/write_text_file") =
            (&self.0.fs, method)
        {
            let write = method == "fs/write_text_file";
            let agent_path = params
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // `..` resolved: the user sees (and the UI opens) the file that is really meant.
            let local = match to_local(kind, agent_path) {
                Ok(p) => lexical(&p),
                Err(e) => {
                    let _ = conn.respond(id, Err(RpcError::new(RpcError::INVALID_PARAMS, e)));
                    return;
                }
            };
            let content = params
                .get("content")
                .and_then(Value::as_str)
                .map(String::from);
            if write && content.is_none() {
                let _ = conn.respond(
                    id,
                    Err(RpcError::new(RpcError::INVALID_PARAMS, "Brak treści pliku")),
                );
                return;
            }
            let mut st = self.0.state.lock().unwrap();
            let root = st
                .session_cwd
                .as_deref()
                .and_then(|cwd| to_local(kind, cwd).ok());
            let inside = root.is_some_and(|r| is_inside(&local, &[r]));
            st.next_permission += 1;
            let request_id = st.next_permission;
            st.fs_requests.insert(
                request_id,
                PendingFs {
                    id,
                    write,
                    line: params.get("line").and_then(Value::as_u64),
                    limit: params.get("limit").and_then(Value::as_u64),
                },
            );
            drop(st);
            self.0.emit(AcpEvent::FsRequest {
                request_id,
                op: if write { "write" } else { "read" }.into(),
                path: local.to_string_lossy().into_owned(),
                inside,
                content,
            });
        } else if self.0.fs.is_some() && method.starts_with("terminal/") {
            self.0.terminal_request(conn, id, method, &params);
        } else {
            // Not offered (initialize says so), e.g. files and commands on SSH hosts.
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
        let (ours, opening) = {
            let st = self.0.state.lock().unwrap();
            (st.session_id.clone(), st.opening.clone())
        };
        let theirs = params.get("sessionId").and_then(Value::as_str);
        if ours.is_some()
            && theirs.is_some()
            && ours.as_deref() != theirs
            && opening.as_deref() != theirs
        {
            return;
        }
        if let Some(update) = params.get_mut("update").map(Value::take) {
            if self.0.state.lock().unwrap().hide_replay && is_conversation_update(&update) {
                return;
            }
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
    /// The agent's session to continue instead of starting a new one.
    resume: Option<String>,
}

impl AcpSession {
    /// Starts the agent process. The handshake (`initialize`, `session/new`) runs on a
    /// background thread; its outcome arrives as events.
    pub fn start(
        launch: &AcpLaunch,
        events: Arc<dyn AcpEvents>,
        fs: Option<FsKind>,
        ptys: Arc<PtyManager>,
        resume: Option<String>,
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

        let shared = Arc::new_cyclic(|me| Shared {
            me: me.clone(),
            ptys,
            conn: std::sync::OnceLock::new(),
            fs,
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
        let _ = shared.conn.set(Arc::downgrade(&conn));
        let session = Arc::new(AcpSession {
            shared,
            conn,
            child: Mutex::new(child),
            busy: AtomicBool::new(false),
            resume,
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
                "fs": { "readTextFile": self.shared.fs.is_some(), "writeTextFile": self.shared.fs.is_some() },
                "terminal": self.shared.fs.is_some()
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
        let capabilities = init
            .get("agentCapabilities")
            .cloned()
            .filter(Value::is_object)
            .unwrap_or(json!({}));
        {
            let mut st = self.shared.state.lock().unwrap();
            st.auth_methods = auth_methods.clone();
            st.capabilities = capabilities.clone();
        }
        self.shared.emit(AcpEvent::Initialized {
            agent_info: init.get("agentInfo").cloned().filter(|v| !v.is_null()),
            agent_capabilities: capabilities,
            auth_methods,
        });
        self.begin();
    }

    /// The first session: the one to resume, or a new one.
    fn begin(&self) {
        match &self.resume {
            Some(id) => {
                if let Err(e) = self.open_session(id, false) {
                    self.fail(&e);
                }
            }
            None => self.new_session(),
        }
    }

    /// What the agent can do with its saved sessions (`agentCapabilities`).
    fn can(&self, what: &str) -> bool {
        let st = self.shared.state.lock().unwrap();
        let caps = &st.capabilities;
        match what {
            "load" => caps["loadSession"].as_bool() == Some(true),
            _ => caps["sessionCapabilities"][what].is_object(),
        }
    }

    /// Opens a saved session of the agent: `session/resume` (no replay) or `session/load` (the
    /// agent replays the conversation). `show_replay`: the UI has no copy of the conversation
    /// (picked from `session/list`), so `load` is preferred and its replay shown; otherwise the
    /// UI shows the history and a replay would duplicate it.
    fn open_session(&self, session_id: &str, show_replay: bool) -> Result<(), String> {
        let (resume, load) = (self.can("resume"), self.can("load"));
        let method = match (show_replay, resume, load) {
            (true, _, true) | (false, false, true) => "session/load",
            (_, true, _) => "session/resume",
            _ => return Err("Agent nie pozwala wznawiać rozmów".into()),
        };
        let cwd = self
            .wait_for_cwd()
            .ok_or("Nie udało się ustalić katalogu roboczego agenta")?;
        let params = json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] });
        {
            let mut st = self.shared.state.lock().unwrap();
            st.hide_replay = !show_replay && method == "session/load";
            st.opening = Some(session_id.to_string());
        }
        let result = self.conn.request(method, params, Some(HANDSHAKE_TIMEOUT));
        {
            let mut st = self.shared.state.lock().unwrap();
            st.hide_replay = false;
            st.opening = None;
        }
        match result {
            Ok(r) => {
                let mut st = self.shared.state.lock().unwrap();
                st.session_id = Some(session_id.to_string());
                st.session_cwd = Some(cwd.clone());
                drop(st);
                self.shared.emit(AcpEvent::SessionReady {
                    session_id: session_id.to_string(),
                    cwd,
                    modes: r.get("modes").cloned().filter(|v| !v.is_null()),
                    config_options: r.get("configOptions").cloned().filter(|v| !v.is_null()),
                });
                Ok(())
            }
            Err(CallError::Rpc(e)) if e.code == RpcError::AUTH_REQUIRED => {
                let auth_methods = self.shared.state.lock().unwrap().auth_methods.clone();
                self.shared.emit(AcpEvent::AuthRequired {
                    auth_methods,
                    message: e.message,
                });
                Ok(())
            }
            Err(e) => Err(format!("Nie udało się wznowić rozmowy: {e}")),
        }
    }

    /// Opens another saved session of the agent in this panel (from `list_sessions`); the
    /// agent replays it.
    pub fn load_session(&self, session_id: &str) -> Result<(), String> {
        if self.busy.load(Ordering::SeqCst) {
            return Err("Agent jeszcze odpowiada na poprzednią wiadomość".into());
        }
        self.open_session(session_id, true)
    }

    /// `session/list`: the agent's saved sessions in this folder (a page; `cursor` for more).
    pub fn list_sessions(&self, cursor: Option<&str>) -> Result<Value, String> {
        if !self.can("list") {
            return Err("Agent nie udostępnia listy rozmów".into());
        }
        let cwd = self.shared.state.lock().unwrap().session_cwd.clone();
        self.conn
            .request(
                "session/list",
                json!({ "cwd": cwd, "cursor": cursor }),
                Some(HANDSHAKE_TIMEOUT),
            )
            .map_err(|e| format!("Nie udało się pobrać listy rozmów: {e}"))
    }

    /// `session/delete`: removes a saved session at the agent (only on the user's request).
    pub fn delete_session(&self, session_id: &str) -> Result<(), String> {
        if !self.can("delete") {
            return Err("Agent nie pozwala usuwać rozmów".into());
        }
        if self.session_id().as_deref() == Some(session_id) {
            return Err("Nie można usunąć rozmowy, która jest otwarta".into());
        }
        self.conn
            .request(
                "session/delete",
                json!({ "sessionId": session_id }),
                Some(HANDSHAKE_TIMEOUT),
            )
            .map(|_| ())
            .map_err(|e| format!("Nie udało się usunąć rozmowy: {e}"))
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
        self.begin();
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
        let files: Vec<(u64, PendingFs)> = self
            .shared
            .state
            .lock()
            .unwrap()
            .fs_requests
            .drain()
            .collect();
        for (request_id, pending) in files {
            let _ = self.conn.respond(
                pending.id,
                Err(RpcError::new(RpcError::INTERNAL_ERROR, "Przerwano")),
            );
            self.shared.emit(AcpEvent::FsClosed { request_id });
        }
        let commands: Vec<(u64, (Value, CommandRequest))> = self
            .shared
            .state
            .lock()
            .unwrap()
            .terminal_requests
            .drain()
            .collect();
        for (request_id, (id, _)) in commands {
            let _ = self.conn.respond(
                id,
                Err(RpcError::new(RpcError::INTERNAL_ERROR, "Przerwano")),
            );
            self.shared
                .emit(AcpEvent::TerminalRequestClosed { request_id });
        }
    }

    /// Answers a command request: run it (`allow`) or refuse it.
    pub fn reply_terminal(&self, request_id: u64, allow: bool) -> Result<(), String> {
        let (id, req) = self
            .shared
            .state
            .lock()
            .unwrap()
            .terminal_requests
            .remove(&request_id)
            .ok_or("Ta prośba o polecenie jest już nieaktualna")?;
        self.shared
            .emit(AcpEvent::TerminalRequestClosed { request_id });
        let response = if allow {
            self.shared.run_command(&req)
        } else {
            Err(RpcError::new(
                RpcError::INTERNAL_ERROR,
                "Użytkownik nie zezwolił na uruchomienie polecenia",
            ))
        };
        self.conn.respond(id, response).map_err(|e| e.to_string())
    }

    /// Answers a file request: `Ok(Some(text))` for a read (the whole file; the requested lines
    /// are cut here), `Ok(None)` for a successful write, `Err(message)` when it failed or the
    /// user refused.
    pub fn reply_fs(
        &self,
        request_id: u64,
        result: Result<Option<String>, String>,
    ) -> Result<(), String> {
        let pending = self
            .shared
            .state
            .lock()
            .unwrap()
            .fs_requests
            .remove(&request_id)
            .ok_or("Ta prośba o plik jest już nieaktualna")?;
        let response = match result {
            Ok(Some(text)) if !pending.write => {
                Ok(json!({ "content": slice_lines(&text, pending.line, pending.limit) }))
            }
            Ok(None) if pending.write => Ok(json!({})),
            Ok(_) => Err(RpcError::new(
                RpcError::INTERNAL_ERROR,
                "Nieprawidłowa odpowiedź na prośbę o plik",
            )),
            Err(message) => Err(RpcError::new(RpcError::INTERNAL_ERROR, message)),
        };
        self.shared.emit(AcpEvent::FsClosed { request_id });
        self.conn
            .respond(pending.id, response)
            .map_err(|e| e.to_string())
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
        self.shared.kill_terminals();
        kill_tree(&mut self.child.lock().unwrap());
    }

    pub fn is_running(&self) -> bool {
        matches!(self.child.lock().unwrap().try_wait(), Ok(None))
    }
}

impl Drop for AcpSession {
    fn drop(&mut self) {
        self.shared.kill_terminals();
        kill_tree(&mut self.child.lock().unwrap());
    }
}

/// Output and end of one agent command, from the PTY to the agent's buffer and the UI.
struct TerminalEvents {
    id: String,
    term: Arc<AgentTerminal>,
    shared: std::sync::Weak<Shared>,
}

impl PtyEvents for TerminalEvents {
    fn data(&self, bytes: Vec<u8>) {
        let queries = self.term.cursor_queries.lock().unwrap().scan(&bytes);
        if queries > 0 {
            if let Some(shared) = self.shared.upgrade() {
                shared.answer_cursor_queries(&self.term, queries);
            }
        }
        self.term.output.lock().unwrap().push(&bytes);
        let data = self.term.ui_text.lock().unwrap().decode(&bytes);
        if let (Some(shared), false) = (self.shared.upgrade(), data.is_empty()) {
            shared.emit(AcpEvent::TerminalOutput {
                terminal_id: self.id.clone(),
                data,
            });
        }
    }

    fn exit(&self, code: Option<u32>) {
        let killed = self.term.killed.load(Ordering::SeqCst);
        let status = ExitStatus {
            code: if killed { None } else { code },
            signal: killed.then(|| "SIGKILL".to_string()),
        };
        *self.term.exit.lock().unwrap() = Some(status.clone());
        self.term.exited.notify_all();
        if let Some(shared) = self.shared.upgrade() {
            shared.emit(AcpEvent::TerminalExit {
                terminal_id: self.id.clone(),
                exit_code: status.code,
                signal: status.signal,
            });
        }
    }
}

fn exit_json(status: &ExitStatus) -> Value {
    json!({ "exitCode": status.code, "signal": status.signal })
}

impl Shared {
    /// `terminal/*` from the agent. `create` waits for the user (`reply_terminal`); the others
    /// answer at once, except `wait_for_exit`, which answers from its own thread.
    fn terminal_request(&self, conn: &Connection, id: Value, method: &str, params: &Value) {
        let invalid = |m: String| Err(RpcError::new(RpcError::INVALID_PARAMS, m));
        if method == "terminal/create" {
            let req = CommandRequest {
                command: params["command"].as_str().unwrap_or_default().to_string(),
                args: params["args"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
                env: params["env"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| {
                                Some((
                                    v["name"].as_str()?.to_string(),
                                    v["value"].as_str()?.to_string(),
                                ))
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                cwd: params["cwd"].as_str().map(String::from),
                output_byte_limit: params["outputByteLimit"].as_u64(),
            };
            let kind = self.fs.as_ref().expect("terminals only with file access");
            let session_cwd = self.state.lock().unwrap().session_cwd.clone();
            // Checked before asking the user: a command that cannot start is refused at once.
            if let Err(e) = spawn_options(kind, &req, session_cwd.as_deref(), cfg!(windows)) {
                let _ = conn.respond(id, invalid(e));
                return;
            }
            let mut st = self.state.lock().unwrap();
            st.next_permission += 1;
            let request_id = st.next_permission;
            let command = req.display();
            let cwd = req.cwd.clone().or(session_cwd);
            st.terminal_requests.insert(request_id, (id, req));
            drop(st);
            self.emit(AcpEvent::TerminalRequest {
                request_id,
                command,
                cwd,
            });
            return;
        }
        let terminal_id = params["terminalId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let term = self
            .state
            .lock()
            .unwrap()
            .terminals
            .get(&terminal_id)
            .cloned();
        let Some(term) = term else {
            let _ = conn.respond(id, invalid(format!("Nieznany terminal: {terminal_id}")));
            return;
        };
        match method {
            "terminal/output" => {
                let (output, truncated) = term.output.lock().unwrap().snapshot();
                let exit = term.exit.lock().unwrap().clone();
                let _ = conn.respond(
                    id,
                    Ok(json!({ "output": output, "truncated": truncated, "exitStatus": exit.as_ref().map(exit_json) })),
                );
            }
            "terminal/wait_for_exit" => {
                let conn = self.conn.get().cloned();
                let _ = std::thread::Builder::new()
                    .name("acp-terminal-wait".into())
                    .spawn(move || {
                        let status = term.wait();
                        if let Some(conn) = conn.and_then(|c| c.upgrade()) {
                            let _ = conn.respond(id, Ok(exit_json(&status)));
                        }
                    });
            }
            "terminal/kill" => {
                self.kill_terminal(&term);
                let _ = conn.respond(id, Ok(json!({})));
            }
            "terminal/release" => {
                self.kill_terminal(&term);
                self.state.lock().unwrap().terminals.remove(&terminal_id);
                let _ = conn.respond(id, Ok(json!({})));
            }
            _ => {
                let _ = conn.respond(
                    id,
                    Err(RpcError::new(
                        RpcError::METHOD_NOT_FOUND,
                        format!("Nieznana metoda {method}"),
                    )),
                );
            }
        }
    }

    /// Starts an allowed command; the answer to `terminal/create`.
    fn run_command(self: &Shared, req: &CommandRequest) -> Result<Value, RpcError> {
        let fail = |m: String| RpcError::new(RpcError::INTERNAL_ERROR, m);
        let kind = self
            .fs
            .as_ref()
            .ok_or_else(|| fail("Brak dostępu do poleceń".into()))?;
        let session_cwd = self.state.lock().unwrap().session_cwd.clone();
        let opts = spawn_options(kind, req, session_cwd.as_deref(), cfg!(windows)).map_err(fail)?;
        let term = Arc::new(AgentTerminal::new(req.output_byte_limit));
        let terminal_id = {
            let mut st = self.state.lock().unwrap();
            st.next_terminal += 1;
            let id = format!("term-{}", st.next_terminal);
            st.terminals.insert(id.clone(), term.clone());
            id
        };
        // Registered before the PTY starts, so no output is lost.
        self.emit(AcpEvent::TerminalStarted {
            terminal_id: terminal_id.clone(),
            command: req.display(),
            cwd: req.cwd.clone().or(session_cwd),
        });
        let events = TerminalEvents {
            id: terminal_id.clone(),
            term: term.clone(),
            shared: self.me.clone(),
        };
        match self.ptys.spawn(opts, Arc::new(events)) {
            Ok(spawned) => {
                let mut pty_id = term.pty_id.lock().unwrap();
                *pty_id = Some(spawned.id);
                let pending = std::mem::take(&mut *term.pending_answers.lock().unwrap());
                for _ in 0..pending {
                    let _ = self.ptys.write(spawned.id, CURSOR_POSITION);
                }
                drop(pty_id);
                Ok(json!({ "terminalId": terminal_id }))
            }
            Err(e) => {
                self.state.lock().unwrap().terminals.remove(&terminal_id);
                Err(fail(e))
            }
        }
    }

    /// Answers cursor position queries of a command (see `CursorQueries`); those that come
    /// before its PTY id is known are answered once it is.
    fn answer_cursor_queries(&self, term: &AgentTerminal, count: usize) {
        let pty_id = term.pty_id.lock().unwrap();
        match *pty_id {
            Some(id) => {
                for _ in 0..count {
                    let _ = self.ptys.write(id, CURSOR_POSITION);
                }
            }
            None => *term.pending_answers.lock().unwrap() += count,
        }
    }

    fn kill_terminal(&self, term: &AgentTerminal) {
        if term.exit.lock().unwrap().is_some() {
            return;
        }
        term.killed.store(true, Ordering::SeqCst);
        if let Some(pty) = *term.pty_id.lock().unwrap() {
            let _ = self.ptys.kill(pty);
        }
    }

    /// Ends every command of the session (agent stopped, panel closed, app exit).
    fn kill_terminals(&self) {
        let all: Vec<Arc<AgentTerminal>> = self
            .state
            .lock()
            .unwrap()
            .terminals
            .drain()
            .map(|(_, t)| t)
            .collect();
        for t in all {
            self.kill_terminal(&t);
        }
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
