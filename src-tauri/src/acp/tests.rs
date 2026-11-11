//! Whole conversations with the scripted agent (`examples/fake_acp_agent.rs`) as a real process,
//! started the way the app starts agents (`launch_for`: `sh` script on Unix, `cmd.exe` on Windows).

use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::fs::FsKind;
use super::launch::launch_for;
use super::session::{AcpEvent, AcpEvents, AcpSession};

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

fn start(name: &str, extra: &[&str]) -> (Arc<AcpSession>, Arc<Collector>, PathBuf) {
    start_with(name, extra, Some(FsKind::Local))
}

fn start_with(
    name: &str,
    extra: &[&str],
    fs: Option<FsKind>,
) -> (Arc<AcpSession>, Arc<Collector>, PathBuf) {
    let dir = temp_dir(name);
    let mut command = vec![fake_agent().to_string_lossy().into_owned()];
    command.extend(extra.iter().map(|s| s.to_string()));
    let launch = launch_for(None, &command, Some(&dir), None, cfg!(windows));
    let events = Arc::new(Collector::default());
    let session = AcpSession::start(&launch, events.clone(), fs).unwrap();
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
    assert_eq!(turn.join().unwrap().unwrap(), "end_turn");
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
    assert_eq!(turn.join().unwrap().unwrap(), "cancelled");

    // Cancelling while a permission request waits: the request is answered with "cancelled".
    let s = session.clone();
    let turn = std::thread::spawn(move || s.prompt("permission"));
    let (request_id, _) = permission(&events);
    session.cancel().unwrap();
    assert_eq!(turn.join().unwrap().unwrap(), "cancelled");
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
    assert_eq!(turn.join().unwrap().unwrap(), "end_turn");
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
    assert_eq!(turn.join().unwrap().unwrap(), "end_turn");
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
    assert_eq!(turn.join().unwrap().unwrap(), "end_turn");
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
    assert_eq!(turn.join().unwrap().unwrap(), "end_turn");
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
