//! Whole conversations with the scripted agent (`examples/fake_acp_agent.rs`) as a real process,
//! started the way the app starts agents (`launch_for`: `sh` script on Unix, `cmd.exe` on Windows).

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::fs::FsKind;
use super::launch::launch_for;
use super::session::{AcpEvent, AcpEvents, AcpSession};
use crate::pty::PtyManager;

const WAIT: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Collector {
    events: Mutex<Vec<AcpEvent>>,
    changed: Condvar,
}

impl AcpEvents for Collector {
    fn emit(&self, event: AcpEvent) {
        self.events.lock().unwrap().push(event);
        self.changed.notify_all();
    }
}

impl Collector {
    /// Waits until an event matches; returns a copy of it.
    fn wait(&self, what: &str, pred: impl Fn(&AcpEvent) -> bool) -> AcpEvent {
        let mut events = self.events.lock().unwrap();
        let deadline = std::time::Instant::now() + WAIT;
        loop {
            if let Some(e) = events.iter().find(|e| pred(e)) {
                return e.clone();
            }
            let left = deadline
                .checked_duration_since(std::time::Instant::now())
                .unwrap_or_else(|| panic!("no event: {what}; got {:#?}", events));
            events = self.changed.wait_timeout(events, left).unwrap().0;
        }
    }

    /// Text of all `agent_message_chunk` updates so far.
    fn message_text(&self) -> String {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                AcpEvent::Update { update } if update["sessionUpdate"] == "agent_message_chunk" => {
                    update["content"]["text"].as_str().map(String::from)
                }
                _ => None,
            })
            .collect()
    }
}

fn fake_agent() -> PathBuf {
    // target/<profile>/deps/<test binary> → target/<profile>/examples/fake_acp_agent
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().parent().unwrap().join("examples");
    let path = dir.join(format!("fake_acp_agent{}", std::env::consts::EXE_SUFFIX));
    assert!(
        path.exists(),
        "{} is missing: plain `cargo test` builds it; with a test name filter or `--lib`, run `cargo build --example fake_acp_agent` first",
        path.display()
    );
    path
}

fn temp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("lf-acp-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// The stop reason of a turn run on another thread; fails instead of hanging the test run.
fn finish(turn: std::thread::JoinHandle<Result<String, String>>) -> String {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !turn.is_finished() {
        assert!(std::time::Instant::now() < deadline, "the turn never ended");
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    turn.join().unwrap().unwrap()
}

fn start(name: &str, extra: &[&str]) -> (Arc<AcpSession>, Arc<Collector>, PathBuf) {
    start_with(name, extra, Some(FsKind::Local))
}

fn start_with(
    name: &str,
    extra: &[&str],
    fs: Option<FsKind>,
) -> (Arc<AcpSession>, Arc<Collector>, PathBuf) {
    start_resuming(name, extra, fs, None)
}

fn start_resuming(
    name: &str,
    extra: &[&str],
    fs: Option<FsKind>,
    resume: Option<&str>,
) -> (Arc<AcpSession>, Arc<Collector>, PathBuf) {
    let dir = temp_dir(name);
    let mut command = vec![fake_agent().to_string_lossy().into_owned()];
    command.extend(extra.iter().map(|s| s.to_string()));
    let launch = launch_for(None, &command, Some(&dir), None, cfg!(windows));
    let events = Arc::new(Collector::default());
    let session = AcpSession::start(
        &launch,
        events.clone(),
        fs,
        Arc::new(PtyManager::new()),
        resume.map(String::from),
    )
    .unwrap();
    (session, events, dir)
}

/// A file request of the agent newer than `after` (request ids grow): (id, path, inside, content).
fn fs_request(events: &Collector, op: &str, after: u64) -> (u64, String, bool, Option<String>) {
    let op = op.to_string();
    match events.wait("file request", |e| {
        matches!(e, AcpEvent::FsRequest { op: o, request_id, .. } if *o == op && *request_id > after)
    }) {
        AcpEvent::FsRequest {
            request_id,
            path,
            inside,
            content,
            ..
        } => (request_id, path, inside, content),
        _ => unreachable!(),
    }
}

fn ready(events: &Collector) -> String {
    match events.wait("session ready", |e| {
        matches!(e, AcpEvent::SessionReady { .. })
    }) {
        AcpEvent::SessionReady { cwd, .. } => cwd,
        _ => unreachable!(),
    }
}

fn permission(events: &Collector) -> (u64, Vec<Value>) {
    match events.wait("permission", |e| matches!(e, AcpEvent::Permission { .. })) {
        AcpEvent::Permission {
            request_id,
            options,
            ..
        } => (request_id, options),
        _ => unreachable!(),
    }
}

#[test]
fn a_conversation_from_initialize_to_end_turn() {
    let (session, events, dir) = start("chat", &[]);
    match events.wait("initialized", |e| matches!(e, AcpEvent::Initialized { .. })) {
        AcpEvent::Initialized {
            agent_info,
            auth_methods,
            ..
        } => {
            assert_eq!(agent_info.unwrap()["name"], "fake-acp-agent");
            assert_eq!(auth_methods[0]["id"], "fake-login");
        }
        _ => unreachable!(),
    }
    let cwd = ready(&events);
    // The agent got an absolute path of the project folder in its own file system.
    let name = dir.file_name().unwrap().to_string_lossy().into_owned();
    assert!(cwd.ends_with(&name), "{cwd} should be {}", dir.display());

    assert_eq!(session.prompt("Witaj, Leverframe").unwrap(), "end_turn");
    assert_eq!(events.message_text(), "Echo: Witaj, Leverframe");
    let kinds: Vec<String> = events
        .events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            AcpEvent::Update { update } => update["sessionUpdate"].as_str().map(String::from),
            _ => None,
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "available_commands_update", // right after session/new
            "agent_thought_chunk",
            "agent_message_chunk",
            "agent_message_chunk",
            "plan"
        ]
    );
    events.wait(
        "stderr log",
        |e| matches!(e, AcpEvent::Log { line } if line == "fake agent: start"),
    );

    assert_eq!(session.prompt("pwd").unwrap(), "end_turn");
    assert!(events.message_text().ends_with(&format!("cwd={cwd}")));
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn permissions_are_answered_by_the_user() {
    let (session, events, dir) = start("perm", &[]);
    ready(&events);
    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("permission"));
    let (request_id, options) = permission(&events);
    assert_eq!(options.len(), 2);
    assert_eq!(options[0]["kind"], "allow_once");
    session.reply_permission(request_id, Some("allow")).unwrap();
    assert_eq!(finish(turn), "end_turn");
    assert!(events.message_text().ends_with("zgoda: allow"));
    events.wait("closed", |e| {
        *e == AcpEvent::PermissionClosed { request_id }
    });
    events.wait("tool completed", |e| {
        matches!(e, AcpEvent::Update { update } if update["sessionUpdate"] == "tool_call_update" && update["status"] == "completed")
    });
    assert!(
        session.reply_permission(request_id, Some("allow")).is_err(),
        "an answered request cannot be answered again"
    );
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn cancelling_ends_the_turn_and_open_permission_requests() {
    let (session, events, dir) = start("cancel", &[]);
    ready(&events);

    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("slow"));
    events.wait(
        "first chunk",
        |e| matches!(e, AcpEvent::Update { update } if update["content"]["text"] == "pracuję…"),
    );
    assert!(
        session
            .prompt("drugi")
            .unwrap_err()
            .contains("jeszcze odpowiada"),
        "one turn at a time"
    );
    session.cancel().unwrap();
    assert_eq!(finish(turn), "cancelled");

    // Cancelling while a permission request waits: the request is answered with "cancelled".
    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("permission"));
    let (request_id, _) = permission(&events);
    session.cancel().unwrap();
    assert_eq!(finish(turn), "cancelled");
    assert!(events.message_text().ends_with("zgoda: cancelled"));
    events.wait("closed", |e| {
        *e == AcpEvent::PermissionClosed { request_id }
    });
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn bad_output_and_unsupported_requests_do_not_break_the_session() {
    let (session, events, dir) = start("robust", &[]);
    ready(&events);
    assert_eq!(session.prompt("garbage").unwrap(), "end_turn");
    events.wait(
        "logged",
        |e| matches!(e, AcpEvent::Log { line } if line == "[stdout] to nie jest JSON"),
    );
    assert!(events.message_text().ends_with("Echo: garbage"));
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_agent_edits_a_file_through_leverframe() {
    let (session, events, dir) = start("edit", &[]);
    ready(&events);
    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("edit"));

    // Read: inside the session folder; the UI answers (from an open editor or the disk).
    let (read_id, path, inside, _) = fs_request(&events, "read", 0);
    assert!(inside, "{path}");
    assert!(path.ends_with("README.md"), "{path}");
    session
        .reply_fs(
            read_id,
            Ok(Some("# Sklep\nniezapisane w edytorze\n".into())),
        )
        .unwrap();
    events.wait("read closed", |e| {
        *e == AcpEvent::FsClosed {
            request_id: read_id,
        }
    });

    // The change comes as a diff with a permission request.
    let (perm, _) = permission(&events);
    events.wait("diff", |e| {
        matches!(e, AcpEvent::Update { update } if update["sessionUpdate"] == "tool_call"
            && update["content"][0]["type"] == "diff"
            && update["content"][0]["oldText"] == "# Sklep\nniezapisane w edytorze\n")
    });
    session.reply_permission(perm, Some("allow")).unwrap();

    let (write_id, _, inside, content) = fs_request(&events, "write", 0);
    assert!(inside);
    assert_eq!(
        content.as_deref(),
        Some("# Sklep\nniezapisane w edytorze\nDopisane przez agenta.\n")
    );
    session.reply_fs(write_id, Ok(None)).unwrap();
    assert_eq!(finish(turn), "end_turn");
    assert!(events.message_text().ends_with("zapisano"));
    assert!(
        session.reply_fs(write_id, Ok(None)).is_err(),
        "answered once"
    );

    // A failed write reaches the agent as an error.
    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("edit"));
    let (read_id, ..) = fs_request(&events, "read", write_id);
    session.reply_fs(read_id, Ok(Some("x".into()))).unwrap();
    let perm = match events.wait(
        "second permission",
        |e| matches!(e, AcpEvent::Permission { request_id, .. } if *request_id > read_id),
    ) {
        AcpEvent::Permission { request_id, .. } => request_id,
        _ => unreachable!(),
    };
    session.reply_permission(perm, Some("allow")).unwrap();
    let (write_id, ..) = fs_request(&events, "write", perm);
    session
        .reply_fs(write_id, Err("Plik zmienił się na dysku".into()))
        .unwrap();
    assert_eq!(finish(turn), "end_turn");
    assert!(events
        .message_text()
        .ends_with("błąd zapisu: Plik zmienił się na dysku"));
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn files_outside_the_folder_are_flagged_and_can_be_refused() {
    let (session, events, dir) = start("outside", &[]);
    ready(&events);
    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("fs"));
    let (id, path, inside, _) = fs_request(&events, "read", 0);
    assert!(!inside, "{path} is outside the session folder");
    assert!(
        path.ends_with("poza-projektem.txt") && !path.contains(".."),
        "{path}"
    );
    session
        .reply_fs(id, Err("Użytkownik nie zezwolił".into()))
        .unwrap();
    assert_eq!(finish(turn), "end_turn");
    assert!(events.message_text().ends_with("fs: -32603"));
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn without_file_access_the_agent_is_told_so() {
    // SSH profiles: no fs capability; requests are refused with "method not found".
    let (session, events, dir) = start_with("nofs", &[], None);
    ready(&events);
    assert_eq!(session.prompt("edit").unwrap(), "end_turn");
    assert!(events
        .message_text()
        .ends_with("edit: klient nie udostępnia plików"));
    assert_eq!(session.prompt("fs").unwrap(), "end_turn");
    assert!(events.message_text().ends_with("fs: -32601"));
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn cancelling_drops_open_file_requests() {
    let (session, events, dir) = start("fscancel", &[]);
    ready(&events);
    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("fs"));
    let (id, ..) = fs_request(&events, "read", 0);
    session.cancel().unwrap();
    events.wait("closed", |e| *e == AcpEvent::FsClosed { request_id: id });
    assert_eq!(finish(turn), "end_turn");
    assert!(events.message_text().ends_with("fs: -32603"));
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_crash_is_reported_with_the_agents_last_words() {
    let (session, events, dir) = start("crash", &[]);
    ready(&events);
    let err = session.prompt("crash").unwrap_err();
    assert!(err.contains("zakończył"), "{err}");
    match events.wait("exited", |e| matches!(e, AcpEvent::Exited { .. })) {
        AcpEvent::Exited { code, message } => {
            assert_eq!(code, Some(3));
            assert!(message.unwrap().contains("awaria podczas pracy"));
        }
        _ => unreachable!(),
    }
    assert!(!session.is_running());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn login_comes_before_the_session_when_the_agent_asks_for_it() {
    let (session, events, dir) = start("auth", &["--need-auth"]);
    match events.wait("auth required", |e| {
        matches!(e, AcpEvent::AuthRequired { .. })
    }) {
        AcpEvent::AuthRequired {
            auth_methods,
            message,
        } => {
            assert_eq!(auth_methods[0]["id"], "fake-login");
            assert_eq!(message, "Najpierw się zaloguj");
        }
        _ => unreachable!(),
    }
    assert!(session.prompt("x").is_err(), "no session before login");
    session.authenticate("fake-login").unwrap();
    ready(&events);
    assert_eq!(session.prompt("po logowaniu").unwrap(), "end_turn");
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn other_protocol_versions_are_refused() {
    let (session, events, dir) = start("version", &["--protocol", "2"]);
    match events.wait("error", |e| matches!(e, AcpEvent::Error { .. })) {
        AcpEvent::Error { message } => assert!(message.contains("wersji 2"), "{message}"),
        _ => unreachable!(),
    }
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn stopping_ends_the_process_quietly() {
    let (session, events, dir) = start("stop", &[]);
    ready(&events);
    assert!(session.is_running());
    session.stop();
    assert!(!session.is_running());
    match events.wait("exited", |e| matches!(e, AcpEvent::Exited { .. })) {
        AcpEvent::Exited { message, .. } => {
            assert_eq!(message, None, "stopped by the user: no error")
        }
        _ => unreachable!(),
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn modes_options_and_commands_reach_the_ui() {
    let (session, events, dir) = start("modes", &[]);
    match events.wait("session ready", |e| {
        matches!(e, AcpEvent::SessionReady { .. })
    }) {
        AcpEvent::SessionReady {
            modes,
            config_options,
            ..
        } => {
            assert_eq!(modes.unwrap()["currentModeId"], "code");
            assert_eq!(config_options.unwrap()[0]["id"], "model");
        }
        _ => unreachable!(),
    }
    events.wait("commands", |e| {
        matches!(e, AcpEvent::Update { update } if update["sessionUpdate"] == "available_commands_update"
            && update["availableCommands"][0]["name"] == "review")
    });

    session.set_mode("ask").unwrap();
    events.wait("mode", |e| {
        matches!(e, AcpEvent::Update { update } if update["sessionUpdate"] == "current_mode_update" && update["currentModeId"] == "ask")
    });

    // A select takes a value id, a boolean option `true` / `false`; the new state comes back.
    session
        .set_config_option("model", Value::from("smart"))
        .unwrap();
    events.wait("model", |e| {
        matches!(e, AcpEvent::Update { update } if update["sessionUpdate"] == "config_option_update"
            && update["configOptions"][0]["currentValue"] == "smart")
    });
    session.set_config_option("web", Value::from(true)).unwrap();
    events.wait("web", |e| {
        matches!(e, AcpEvent::Update { update } if update["sessionUpdate"] == "config_option_update"
            && update["configOptions"][1]["currentValue"] == true)
    });

    assert_eq!(session.prompt("limit").unwrap(), "max_tokens");
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

/// A command request of the agent newer than `after`: (id, command line, cwd).
fn terminal_request(events: &Collector, after: u64) -> (u64, String, Option<String>) {
    match events.wait(
        "command request",
        |e| matches!(e, AcpEvent::TerminalRequest { request_id, .. } if *request_id > after),
    ) {
        AcpEvent::TerminalRequest {
            request_id,
            command,
            cwd,
        } => (request_id, command, cwd),
        _ => unreachable!(),
    }
}

#[test]
fn commands_run_through_leverframe_after_the_user_allows_them() {
    let (session, events, dir) = start("run", &[]);
    let session_cwd = ready(&events);
    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("run"));
    let (request, command, cwd) = terminal_request(&events, 0);
    assert!(command.contains("hello-from-agent"), "{command}");
    assert_eq!(cwd.as_deref(), Some(session_cwd.as_str()));
    session.reply_terminal(request, true).unwrap();
    assert_eq!(finish(turn), "end_turn");
    let text = events.message_text();
    assert!(
        text.contains("wynik: kod 3 sygnał null obcięte false wyjście ["),
        "{text}"
    );
    assert!(
        text.contains("hello-from-agent] po zwolnieniu -32602"),
        "{text}"
    );
    // The UI saw the command start, its output and its end.
    let terminal_id =
        match events.wait("started", |e| matches!(e, AcpEvent::TerminalStarted { .. })) {
            AcpEvent::TerminalStarted { terminal_id, .. } => terminal_id,
            _ => unreachable!(),
        };
    events.wait("output", |e| {
        matches!(e, AcpEvent::TerminalOutput { terminal_id: t, data } if *t == terminal_id && data.contains("hello-from-agent"))
    });
    events.wait("exit", |e| {
        *e == AcpEvent::TerminalExit {
            terminal_id: terminal_id.clone(),
            exit_code: Some(3),
            signal: None,
        }
    });
    assert!(
        session.reply_terminal(request, true).is_err(),
        "answered once"
    );
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn cursor_position_queries_of_commands_are_answered() {
    // Windows' console asks before every command and waits; without an answer nothing runs.
    let (session, events, dir) = start("runquery", &[]);
    ready(&events);
    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("runquery"));
    let (request, ..) = terminal_request(&events, 0);
    session.reply_terminal(request, true).unwrap();
    assert_eq!(finish(turn), "end_turn");
    let text = events.message_text();
    assert!(text.contains("wynik: kod 0 sygnał null"), "{text}");
    assert!(text.contains("answered"), "{text}");
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_refused_command_does_not_run() {
    let (session, events, dir) = start("runno", &[]);
    ready(&events);
    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("run"));
    let (request, ..) = terminal_request(&events, 0);
    session.reply_terminal(request, false).unwrap();
    assert_eq!(finish(turn), "end_turn");
    assert!(events
        .message_text()
        .ends_with("polecenie: odmowa (Użytkownik nie zezwolił na uruchomienie polecenia)"));
    assert!(!events
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, AcpEvent::TerminalStarted { .. })));
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn commands_can_be_killed_and_their_output_is_limited() {
    let (session, events, dir) = start("runkill", &[]);
    ready(&events);
    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("runkill"));
    let (request, ..) = terminal_request(&events, 0);
    session.reply_terminal(request, true).unwrap();
    assert_eq!(finish(turn), "end_turn");
    let text = events.message_text();
    assert!(
        text.contains("wynik: kod null sygnał \"SIGKILL\""),
        "{text}"
    );

    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("runlimit"));
    let (request, ..) = terminal_request(&events, request);
    session.reply_terminal(request, true).unwrap();
    assert_eq!(finish(turn), "end_turn");
    // The last 10 bytes of the output. A login shell may add a line break of its own to the
    // terminal (it depends on the user's shell setup), so only the end of the text is fixed.
    let text = events.message_text();
    let shown = text
        .rsplit("obcięte true wyjście [")
        .next()
        .and_then(|t| t.split(']').next())
        .unwrap_or_default();
    assert!(
        shown.len() >= 8 && "0123456789ABCDEF".ends_with(shown),
        "{text}"
    );
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn commands_end_with_the_agent_and_wait_for_the_user_no_longer_after_a_cancel() {
    let (session, events, dir) = start("runstop", &[]);
    ready(&events);
    // Cancelling the turn drops a command request the user has not answered.
    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("run"));
    let (request, ..) = terminal_request(&events, 0);
    session.cancel().unwrap();
    events.wait("closed", |e| {
        *e == AcpEvent::TerminalRequestClosed {
            request_id: request,
        }
    });
    assert_eq!(finish(turn), "end_turn");
    assert!(events
        .message_text()
        .ends_with("polecenie: odmowa (Przerwano)"));

    // Stopping the agent ends its running commands.
    let s = session.clone();
    let _turn = std::thread::spawn(move || s.prompt("runkill"));
    let (request, ..) = terminal_request(&events, request);
    session.reply_terminal(request, true).unwrap();
    let id = match events.wait("started", |e| matches!(e, AcpEvent::TerminalStarted { .. })) {
        AcpEvent::TerminalStarted { terminal_id, .. } => terminal_id,
        _ => unreachable!(),
    };
    session.stop();
    events.wait("killed", |e| {
        matches!(e, AcpEvent::TerminalExit { terminal_id, signal: Some(_), .. } if *terminal_id == id)
    });
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn no_commands_without_access_to_the_machine() {
    let (session, events, dir) = start_with("noterm", &[], None);
    ready(&events);
    assert_eq!(session.prompt("run").unwrap(), "end_turn");
    assert!(events
        .message_text()
        .ends_with("polecenie: klient nie udostępnia terminali"));
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

/// Updates with conversation text (messages of both sides) seen so far.
fn conversation(events: &Collector) -> Vec<String> {
    events
        .events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            AcpEvent::Update { update } if update["content"]["type"] == "text" => Some(format!(
                "{}: {}",
                update["sessionUpdate"].as_str().unwrap_or_default(),
                update["content"]["text"].as_str().unwrap_or_default()
            )),
            _ => None,
        })
        .collect()
}

#[test]
fn a_saved_session_is_loaded_without_repeating_what_the_ui_shows() {
    let (session, events, dir) = start_resuming("load", &["--load"], None, Some("stara-1"));
    match events.wait("session ready", |e| {
        matches!(e, AcpEvent::SessionReady { .. })
    }) {
        AcpEvent::SessionReady { session_id, .. } => assert_eq!(session_id, "stara-1"),
        _ => unreachable!(),
    }
    // The replay is dropped (the history is on screen), session state such as commands is not.
    assert!(
        conversation(&events).is_empty(),
        "{:?}",
        conversation(&events)
    );
    events.wait("commands", |e| {
        matches!(e, AcpEvent::Update { update } if update["sessionUpdate"] == "available_commands_update")
    });
    assert_eq!(session.session_id().as_deref(), Some("stara-1"));
    let s = session.clone();
    assert_eq!(
        finish(std::thread::spawn(move || s.prompt("dalej"))),
        "end_turn"
    );
    assert!(events.message_text().ends_with("Echo: dalej"));
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn resume_is_preferred_and_unknown_sessions_are_reported() {
    let (session, events, dir) =
        start_resuming("resume", &["--load", "--resume"], None, Some("stara-2"));
    ready(&events);
    assert!(conversation(&events).is_empty());
    assert_eq!(session.session_id().as_deref(), Some("stara-2"));
    session.stop();
    let _ = std::fs::remove_dir_all(dir);

    let (session, events, dir) = start_resuming("resume-bad", &["--resume"], None, Some("nie-ma"));
    match events.wait("error", |e| matches!(e, AcpEvent::Error { .. })) {
        AcpEvent::Error { message } => {
            assert!(
                message.contains("Nie udało się wznowić rozmowy"),
                "{message}"
            )
        }
        _ => unreachable!(),
    }
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn without_the_capability_a_session_cannot_be_resumed() {
    let (session, events, dir) = start_resuming("noresume", &[], None, Some("stara-1"));
    match events.wait("error", |e| matches!(e, AcpEvent::Error { .. })) {
        AcpEvent::Error { message } => {
            assert!(message.contains("nie pozwala wznawiać"), "{message}")
        }
        _ => unreachable!(),
    }
    assert!(!events
        .events
        .lock()
        .unwrap()
        .iter()
        .any(|e| matches!(e, AcpEvent::SessionReady { .. })));
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_agents_sessions_are_listed_opened_and_deleted() {
    let (session, events, dir) = start_with("list", &["--load", "--sessions"], None);
    let cwd = ready(&events);
    let list = session.list_sessions(None).unwrap();
    let ids: Vec<&str> = list["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["sessionId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["stara-1", "stara-2"]);
    assert_eq!(list["sessions"][0]["cwd"], cwd.as_str());
    assert_eq!(list["sessions"][0]["title"], "Wczorajsza rozmowa");

    // Opened from the list, the agent's replay is the only copy of the conversation: shown.
    session.load_session("stara-1").unwrap();
    assert_eq!(
        conversation(&events),
        [
            "user_message_chunk: Napraw testy",
            "agent_message_chunk: Naprawiłem testy w sklepie."
        ]
    );
    assert_eq!(session.session_id().as_deref(), Some("stara-1"));

    assert!(session
        .delete_session("stara-1")
        .unwrap_err()
        .contains("otwarta"));
    session.delete_session("stara-2").unwrap();
    let left = session.list_sessions(None).unwrap();
    assert_eq!(left["sessions"].as_array().unwrap().len(), 1);
    session.stop();
    let _ = std::fs::remove_dir_all(dir);

    // An agent without these capabilities: no list, no deleting.
    let (session, events, dir) = start_with("nolist", &[], None);
    ready(&events);
    assert!(session
        .list_sessions(None)
        .unwrap_err()
        .contains("nie udostępnia"));
    assert!(session
        .delete_session("stara-1")
        .unwrap_err()
        .contains("nie pozwala"));
    session.stop();
    let _ = std::fs::remove_dir_all(dir);
}

/// Manual check with real agents (they need accounts, so CI does not run it):
///
/// ```text
/// LEVERFRAME_REAL_ACP='claude-agent-acp|codex-acp|gemini --acp' \
/// cargo test --lib real_acp_agents -- --ignored --nocapture
/// ```
///
/// For each command (`|`-separated): `initialize` (agent, capabilities, login methods), then
/// `session/new` – ready or login required. When ready, in a new folder with `notatka.txt`: a
/// task that reads the file, writes it and runs a command through Leverframe (permissions,
/// files and commands are allowed and served like the panel does), then the session is resumed
/// in a new agent process (`session/resume` / `session/load`) and asked about the task, and
/// `session/list` must find it. `LEVERFRAME_REAL_ACP_PROMPT` replaces the task,
/// `LEVERFRAME_REAL_ACP_MODE` chooses a mode first (e.g. `default`: Claude asks for permission).
#[test]
#[ignore]
fn real_acp_agents() {
    let commands = std::env::var("LEVERFRAME_REAL_ACP").expect("set LEVERFRAME_REAL_ACP");
    for command in commands.split('|').map(str::trim).filter(|c| !c.is_empty()) {
        println!("\n=== {command}");
        let words: Vec<String> = command.split_whitespace().map(String::from).collect();
        let cwd = temp_dir(&format!(
            "real-{}",
            words[0].rsplit(['/', '\\']).next().unwrap_or("agent")
        ));
        std::fs::write(cwd.join("notatka.txt"), "Kolor: zielony\n").unwrap();
        let Some((session, events)) = real_start(&words, &cwd, None) else {
            continue;
        };
        let Some(session_id) = session.session_id() else {
            session.stop();
            continue;
        };
        if let Ok(mode) = std::env::var("LEVERFRAME_REAL_ACP_MODE") {
            println!("tryb {mode}: {:?}", session.set_mode(&mode));
        }
        let task = std::env::var("LEVERFRAME_REAL_ACP_PROMPT").unwrap_or_else(|_| {
            "Przeczytaj plik notatka.txt, dopisz na jego końcu linię `Sprawdzone przez agenta`, \
             potem uruchom polecenie `ls` i podaj jednym słowem kolor z notatki."
                .into()
        });
        real_turn(&session, &events, &task);
        let note = std::fs::read_to_string(cwd.join("notatka.txt")).unwrap_or_default();
        println!("notatka.txt po turze: {note:?}");
        session.stop();

        // A new process continues the conversation.
        println!("--- wznowienie {session_id}");
        let Some((resumed, events)) = real_start(&words, &cwd, Some(&session_id)) else {
            continue;
        };
        let replayed = events
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| matches!(e, AcpEvent::Update { update } if update["sessionUpdate"] == "agent_message_chunk"))
            .count();
        println!("odtworzone fragmenty odpowiedzi (powinno być 0 – ukryte): {replayed}");
        real_turn(
            &resumed,
            &events,
            "Jaki kolor podałeś w poprzedniej odpowiedzi? Odpowiedz jednym słowem.",
        );
        match resumed.list_sessions(None) {
            Ok(list) => {
                let ids: Vec<&str> = list["sessions"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|s| s["sessionId"].as_str()).collect())
                    .unwrap_or_default();
                println!(
                    "session/list: {} sesji, ta na liście: {}",
                    ids.len(),
                    ids.contains(&session_id.as_str())
                );
            }
            Err(e) => println!("session/list: {e}"),
        }
        resumed.stop();
    }
}

/// Starts a real agent and prints its handshake; `Some` when the session is ready.
fn real_start(
    words: &[String],
    cwd: &std::path::Path,
    resume: Option<&str>,
) -> Option<(Arc<AcpSession>, Arc<Collector>)> {
    let launch = launch_for(None, words, Some(cwd), None, cfg!(windows));
    let events = Arc::new(Collector::default());
    let session = match AcpSession::start(
        &launch,
        events.clone(),
        Some(FsKind::Local),
        Arc::new(PtyManager::new()),
        resume.map(String::from),
    ) {
        Ok(s) => s,
        Err(e) => {
            println!("start: {e}");
            return None;
        }
    };
    let outcome = events.wait("handshake", |e| {
        matches!(
            e,
            AcpEvent::SessionReady { .. }
                | AcpEvent::AuthRequired { .. }
                | AcpEvent::Error { .. }
                | AcpEvent::Exited { .. }
        )
    });
    if resume.is_none() {
        for e in events.events.lock().unwrap().iter() {
            if let AcpEvent::Initialized {
                agent_info,
                agent_capabilities,
                auth_methods,
            } = e
            {
                println!("agent: {}", agent_info.clone().unwrap_or(Value::Null));
                println!(
                    "loadSession: {}, sessionCapabilities: {}",
                    agent_capabilities["loadSession"], agent_capabilities["sessionCapabilities"]
                );
                let names: Vec<String> = auth_methods
                    .iter()
                    .map(|m| format!("{} ({})", m["name"], m["id"]))
                    .collect();
                println!("logowanie: {}", names.join(", "));
            }
        }
    }
    match outcome {
        AcpEvent::SessionReady {
            session_id,
            modes,
            config_options,
            ..
        } => {
            println!("sesja gotowa: {session_id}");
            if resume.is_none() {
                let mode_ids: Vec<String> = modes
                    .as_ref()
                    .and_then(|m| m["availableModes"].as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|m| m["id"].as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                println!("tryby: {mode_ids:?}");
                let ids: Vec<String> = config_options
                    .as_ref()
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|o| o["id"].as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                println!("opcje: {ids:?}");
            }
            return Some((session, events));
        }
        AcpEvent::AuthRequired { message, .. } => println!("wymaga logowania: {message}"),
        AcpEvent::Error { message } => println!("błąd: {message}"),
        AcpEvent::Exited { code, message } => println!(
            "zakończył się: kod {code:?} {}",
            message.unwrap_or_default()
        ),
        _ => unreachable!(),
    }
    session.stop();
    None
}

/// One turn with a real agent; its requests are allowed and served like the panel does.
fn real_turn(session: &Arc<AcpSession>, events: &Arc<Collector>, text: &str) {
    let start = events.events.lock().unwrap().len();
    let s = session.clone();
    let text = text.to_string();
    let turn = std::thread::spawn(move || s.prompt(&text));
    let mut answered = std::collections::HashSet::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(300);
    while !turn.is_finished() && std::time::Instant::now() < deadline {
        let pending: Vec<AcpEvent> = events.events.lock().unwrap().clone();
        for e in pending {
            match e {
                AcpEvent::Permission {
                    request_id,
                    options,
                    tool_call,
                } if answered.insert(("p", request_id)) => {
                    let content: Vec<String> = tool_call["content"]
                        .as_array()
                        .map(|c| {
                            c.iter()
                                .map(|x| match x["type"].as_str() {
                                    Some("diff") => format!(
                                        "diff {} (+{} znaków)",
                                        x["path"].as_str().unwrap_or("?"),
                                        x["newText"].as_str().map_or(0, str::len)
                                    ),
                                    other => other.unwrap_or("?").to_string(),
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    println!("  prośba o zgodę: {} {content:?}", tool_call["title"]);
                    let allow = options
                        .iter()
                        .find(|o| o["kind"] == "allow_once")
                        .or(options.first())
                        .and_then(|o| o["optionId"].as_str())
                        .map(String::from);
                    println!("  zgoda: {allow:?}");
                    let _ = session.reply_permission(request_id, allow.as_deref());
                }
                AcpEvent::FsRequest {
                    request_id,
                    op,
                    path,
                    inside,
                    content,
                } if answered.insert(("f", request_id)) => {
                    println!("  plik ({op}, w folderze: {inside}): {path}");
                    let result = if op == "read" {
                        std::fs::read_to_string(&path)
                            .map(Some)
                            .map_err(|e| e.to_string())
                    } else {
                        std::fs::write(&path, content.unwrap_or_default())
                            .map(|_| None)
                            .map_err(|e| e.to_string())
                    };
                    let _ = session.reply_fs(request_id, result);
                }
                AcpEvent::TerminalRequest {
                    request_id,
                    command,
                    ..
                } if answered.insert(("t", request_id)) => {
                    println!("  polecenie: {command}");
                    let _ = session.reply_terminal(request_id, true);
                }
                _ => {}
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if turn.is_finished() {
        println!("koniec tury: {:?}", turn.join().unwrap());
    } else {
        println!("brak końca tury po 300 s");
        let _ = session.cancel();
    }
    let all = events.events.lock().unwrap();
    let new = &all[start..];
    let kinds: std::collections::BTreeSet<String> = new
        .iter()
        .filter_map(|e| match e {
            AcpEvent::Update { update } => update["sessionUpdate"].as_str().map(String::from),
            _ => None,
        })
        .collect();
    let tools: Vec<String> = new
        .iter()
        .filter_map(|e| match e {
            AcpEvent::Update { update } if update["sessionUpdate"] == "tool_call" => Some(format!(
                "{} [{}]",
                update["title"].as_str().unwrap_or("?"),
                update["kind"].as_str().unwrap_or("?")
            )),
            _ => None,
        })
        .collect();
    let terminals = new
        .iter()
        .filter(|e| matches!(e, AcpEvent::TerminalExit { .. }))
        .count();
    let answer: String = new
        .iter()
        .filter_map(|e| match e {
            AcpEvent::Update { update } if update["sessionUpdate"] == "agent_message_chunk" => {
                update["content"]["text"].as_str().map(String::from)
            }
            _ => None,
        })
        .collect();
    println!("  aktualizacje: {kinds:?}");
    println!("  narzędzia: {tools:?}");
    println!("  polecenia zakończone w terminalach Leverframe: {terminals}");
    println!("  odpowiedź: {}", answer.trim());
}
