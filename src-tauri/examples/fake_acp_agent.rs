//! A scripted ACP v1 agent for tests (Rust tests, later the E2E fixtures). It speaks JSON-RPC on
//! stdin/stdout like a real agent; what it does is chosen by the prompt text:
//!
//! - `permission` – a tool call that asks for permission, then reports the decision
//! - `slow`       – streams one chunk and waits for `session/cancel`
//! - `crash`      – writes to stderr and exits with code 3
//! - `garbage`    – prints a non-JSON line on stdout first, then answers normally
//! - `pwd`        – answers with the session's working directory
//! - `tools`      – a plan, tool calls with locations and output, usage and a Markdown answer
//! - `limit`      – ends the turn with `max_tokens`
//! - `fs`         – reads `<session folder>/../poza-projektem.txt` through the client (outside
//!   the folder; an absolute path on every system)
//! - `edit`       – reads README.md through the client, proposes a change (diff) with a
//!   permission request and writes it through the client when allowed
//! - `run`        – runs a command through the client (prints a line, exits with 3) and reports
//!   its output and exit code
//! - `runkill`    – starts a long command, kills it and reports how it ended
//! - `runlimit`   – a command printing 16 characters with an output limit of 10 bytes
//! - `selfedit`   – changes README.md itself (not through the client, like Claude's own Edit
//!   tool) and reports it as a completed edit
//! - `runquery`   – a command asking for the cursor position and waiting for the answer (as
//!   Windows' console does before every command)
//! - anything else – a thought, an echo of the prompt and a plan
//!
//! Flags: `--need-auth` (session/new fails with -32000 until `authenticate`),
//! `--protocol N` (answers `initialize` with version N), `--load` (`session/load`: replays a
//! saved session – `stara-1`, `stara-2` or one this agent started, `fake-…`), `--resume` (`session/resume`), `--sessions` (`session/list` and
//! `session/delete` of the saved sessions `stara-1` and `stara-2`).

use std::io::{BufRead, Write};

use serde_json::{json, Value};

struct Agent {
    input: std::io::Lines<std::io::StdinLock<'static>>,
    next_id: u64,
    need_auth: bool,
    protocol: u64,
    cwd: String,
    mode: String,
    model: String,
    web: bool,
    /// The client offered `fs/read_text_file` and `fs/write_text_file`.
    client_fs: bool,
    /// The client offered `terminal/*`.
    client_terminal: bool,
    load: bool,
    resume: bool,
    sessions: bool,
    /// Saved sessions: id, title.
    saved: Vec<(String, String)>,
}

impl Agent {
    fn config_options(&self) -> Value {
        json!([
            {
                "id": "model", "name": "Model", "category": "model", "type": "select",
                "currentValue": self.model,
                "options": [{ "value": "fast", "name": "Szybki" }, { "value": "smart", "name": "Dokładny" }]
            },
            { "id": "web", "name": "Dostęp do sieci", "type": "boolean", "currentValue": self.web }
        ])
    }

    fn send(&self, msg: Value) {
        let mut out = std::io::stdout().lock();
        writeln!(out, "{msg}").unwrap();
        out.flush().unwrap();
    }

    fn respond(&self, id: &Value, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    fn error(&self, id: &Value, code: i64, message: &str) {
        self.send(
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
        );
    }

    fn update(&self, session: &str, update: Value) {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": session, "update": update }
        }));
    }

    fn chunk(&self, session: &str, kind: &str, text: &str) {
        self.update(
            session,
            json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } }),
        );
    }

    /// Sends a request to the client and waits for its answer. `Err(())` = cancelled meanwhile.
    fn call(&mut self, method: &str, params: Value) -> Result<Value, ()> {
        self.next_id += 1;
        let id = format!("agent-{}", self.next_id);
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        loop {
            let msg = self.read().ok_or(())?;
            if msg.get("id").and_then(Value::as_str) == Some(&id) && msg.get("method").is_none() {
                return Ok(msg);
            }
            if msg.get("method").and_then(Value::as_str) == Some("session/cancel") {
                // The client must still answer the pending request (with "cancelled").
                continue;
            }
        }
    }

    fn read(&mut self) -> Option<Value> {
        loop {
            let line = self.input.next()?.ok()?;
            if line.trim().is_empty() {
                continue;
            }
            return Some(serde_json::from_str(&line).expect("client sent valid JSON"));
        }
    }

    fn prompt(&mut self, id: &Value, params: &Value) {
        let session = params["sessionId"].as_str().unwrap_or_default().to_string();
        let text = params["prompt"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let stop = match text.as_str() {
            "crash" => {
                eprintln!("fake agent: awaria podczas pracy");
                std::process::exit(3);
            }
            "slow" => {
                self.chunk(&session, "agent_message_chunk", "pracuję…");
                loop {
                    match self.read() {
                        Some(m) if m["method"] == "session/cancel" => break "cancelled",
                        Some(_) => continue,
                        None => std::process::exit(0),
                    }
                }
            }
            "permission" => {
                self.update(
                    &session,
                    json!({
                        "sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edytuj README.md",
                        "kind": "edit", "status": "pending",
                        "locations": [{ "path": format!("{}/README.md", self.cwd), "line": 1 }]
                    }),
                );
                let answer = self.call(
                    "session/request_permission",
                    json!({
                        "sessionId": session,
                        "toolCall": { "toolCallId": "t1", "title": "Edytuj README.md", "kind": "edit" },
                        "options": [
                            { "optionId": "allow", "name": "Zezwól", "kind": "allow_once" },
                            { "optionId": "deny", "name": "Odmów", "kind": "reject_once" }
                        ]
                    }),
                );
                let outcome = answer
                    .map(|a| a["result"]["outcome"].clone())
                    .unwrap_or(Value::Null);
                let decision = match outcome["outcome"].as_str() {
                    Some("selected") => outcome["optionId"].as_str().unwrap_or("?").to_string(),
                    _ => "cancelled".to_string(),
                };
                let status = if decision == "allow" {
                    "completed"
                } else {
                    "failed"
                };
                self.update(
                    &session,
                    json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": status }),
                );
                self.chunk(
                    &session,
                    "agent_message_chunk",
                    &format!("zgoda: {decision}"),
                );
                if decision == "cancelled" {
                    "cancelled"
                } else {
                    "end_turn"
                }
            }
            "fs" => {
                let answer = self
                    .call(
                        "fs/read_text_file",
                        json!({ "sessionId": session, "path": format!("{}/../poza-projektem.txt", self.cwd) }),
                    )
                    .unwrap_or(Value::Null);
                let result = match answer["error"]["code"].as_i64() {
                    Some(code) => format!("fs: {code}"),
                    None => format!(
                        "fs: ok {}",
                        answer["result"]["content"].as_str().unwrap_or("").trim()
                    ),
                };
                self.chunk(&session, "agent_message_chunk", &result);
                "end_turn"
            }
            "run" | "runkill" | "runlimit" | "runquery" if !self.client_terminal => {
                self.chunk(
                    &session,
                    "agent_message_chunk",
                    "polecenie: klient nie udostępnia terminali",
                );
                "end_turn"
            }
            "run" | "runkill" | "runlimit" | "runquery" => {
                let (command, args, limit): (&str, Vec<&str>, Option<u64>) =
                    match (text.as_str(), cfg!(windows)) {
                        ("run", false) => ("sh", vec!["-c", "echo hello-from-agent; exit 3"], None),
                        ("run", true) => {
                            ("cmd", vec!["/c", "echo hello-from-agent& exit /b 3"], None)
                        }
                        ("runquery", false) => (
                            "sh",
                            vec!["-c", "stty -icanon -echo min 1; printf '\\033[6n'; head -c 6 >/dev/null; echo answered"],
                            None,
                        ),
                        // Here the console itself asks before the command starts.
                        ("runquery", true) => ("cmd", vec!["/c", "echo answered"], None),
                        ("runkill", false) => ("sleep", vec!["30"], None),
                        ("runkill", true) => ("ping", vec!["-n", "30", "127.0.0.1"], None),
                        (_, false) => ("printf", vec!["0123456789ABCDEF"], Some(10)),
                        (_, true) => ("cmd", vec!["/c", "<nul set /p =0123456789ABCDEF"], Some(10)),
                    };
                self.next_id += 1;
                let tool = format!("run-{}", self.next_id);
                self.update(
                    &session,
                    json!({ "sessionUpdate": "tool_call", "toolCallId": tool, "title": format!("Uruchamiam {command}"),
                            "kind": "execute", "status": "in_progress" }),
                );
                let created = self
                    .call(
                        "terminal/create",
                        json!({ "sessionId": session, "command": command, "args": args, "cwd": self.cwd,
                                "env": [{ "name": "LF_FROM_AGENT", "value": "1" }], "outputByteLimit": limit }),
                    )
                    .unwrap_or(Value::Null);
                let Some(terminal) = created["result"]["terminalId"].as_str().map(String::from)
                else {
                    self.update(&session, json!({ "sessionUpdate": "tool_call_update", "toolCallId": tool, "status": "failed" }));
                    self.chunk(
                        &session,
                        "agent_message_chunk",
                        &format!(
                            "polecenie: odmowa ({})",
                            created["error"]["message"].as_str().unwrap_or("?")
                        ),
                    );
                    return self.respond(id, json!({ "stopReason": "end_turn" }));
                };
                self.update(
                    &session,
                    json!({ "sessionUpdate": "tool_call_update", "toolCallId": tool,
                            "content": [{ "type": "terminal", "terminalId": terminal }] }),
                );
                if text == "runkill" {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    let _ = self.call(
                        "terminal/kill",
                        json!({ "sessionId": session, "terminalId": terminal }),
                    );
                }
                let exit = self
                    .call(
                        "terminal/wait_for_exit",
                        json!({ "sessionId": session, "terminalId": terminal }),
                    )
                    .unwrap_or(Value::Null);
                let output = self
                    .call(
                        "terminal/output",
                        json!({ "sessionId": session, "terminalId": terminal }),
                    )
                    .unwrap_or(Value::Null);
                let _ = self.call(
                    "terminal/release",
                    json!({ "sessionId": session, "terminalId": terminal }),
                );
                let after_release = self
                    .call(
                        "terminal/output",
                        json!({ "sessionId": session, "terminalId": terminal }),
                    )
                    .unwrap_or(Value::Null);
                self.update(&session, json!({ "sessionUpdate": "tool_call_update", "toolCallId": tool, "status": "completed" }));
                self.chunk(
                    &session,
                    "agent_message_chunk",
                    &format!(
                        "wynik: kod {} sygnał {} obcięte {} wyjście [{}] po zwolnieniu {}",
                        exit["result"]["exitCode"],
                        exit["result"]["signal"],
                        output["result"]["truncated"],
                        output["result"]["output"].as_str().unwrap_or("").trim(),
                        after_release["error"]["code"]
                    ),
                );
                "end_turn"
            }
            "edit" if !self.client_fs => {
                self.chunk(
                    &session,
                    "agent_message_chunk",
                    "edit: klient nie udostępnia plików",
                );
                "end_turn"
            }
            "edit" => {
                let path = format!("{}/README.md", self.cwd);
                let read = self
                    .call(
                        "fs/read_text_file",
                        json!({ "sessionId": session, "path": path }),
                    )
                    .unwrap_or(Value::Null);
                let Some(old) = read["result"]["content"].as_str().map(String::from) else {
                    self.chunk(
                        &session,
                        "agent_message_chunk",
                        &format!("odczyt: błąd {}", read["error"]["message"]),
                    );
                    return self.respond(id, json!({ "stopReason": "end_turn" }));
                };
                let new = format!("{}\nDopisane przez agenta.\n", old.trim_end());
                self.next_id += 1;
                let tool = format!("edit-{}", self.next_id);
                let diff =
                    json!([{ "type": "diff", "path": path, "oldText": old, "newText": new }]);
                self.update(
                    &session,
                    json!({
                        "sessionUpdate": "tool_call", "toolCallId": tool, "title": "Edytuj README.md",
                        "kind": "edit", "status": "pending", "content": diff,
                        "locations": [{ "path": path }]
                    }),
                );
                let answer = self.call(
                    "session/request_permission",
                    json!({
                        "sessionId": session,
                        "toolCall": { "toolCallId": tool, "title": "Edytuj README.md", "kind": "edit", "content": diff },
                        "options": [
                            { "optionId": "allow", "name": "Zezwól", "kind": "allow_once" },
                            { "optionId": "deny", "name": "Odmów", "kind": "reject_once" }
                        ]
                    }),
                );
                let allowed = answer
                    .map(|a| a["result"]["outcome"]["optionId"] == "allow")
                    .unwrap_or(false);
                let (status, text) = if !allowed {
                    ("failed", "odmowa".to_string())
                } else {
                    let write = self
                        .call(
                            "fs/write_text_file",
                            json!({ "sessionId": session, "path": path, "content": new }),
                        )
                        .unwrap_or(Value::Null);
                    match write.get("error") {
                        Some(e) => (
                            "failed",
                            format!("błąd zapisu: {}", e["message"].as_str().unwrap_or("?")),
                        ),
                        None => ("completed", "zapisano".to_string()),
                    }
                };
                self.update(
                    &session,
                    json!({ "sessionUpdate": "tool_call_update", "toolCallId": tool, "status": status }),
                );
                self.chunk(&session, "agent_message_chunk", &text);
                "end_turn"
            }
            "limit" => {
                self.chunk(
                    &session,
                    "agent_message_chunk",
                    "To będzie długa odpowiedź…",
                );
                "max_tokens"
            }
            "tools" => {
                let readme = format!("{}/README.md", self.cwd);
                // Tool call ids are unique within a session (as with real agents).
                self.next_id += 1;
                let (read, test) = (
                    format!("read-{}", self.next_id),
                    format!("test-{}", self.next_id),
                );
                self.update(
                    &session,
                    json!({ "sessionUpdate": "plan", "entries": [
                        { "content": "Przeczytać README", "priority": "high", "status": "in_progress" },
                        { "content": "Uruchomić testy", "priority": "medium", "status": "pending" }
                    ]}),
                );
                self.update(
                    &session,
                    json!({
                        "sessionUpdate": "tool_call", "toolCallId": read, "title": "Czytam README.md",
                        "kind": "read", "status": "in_progress", "locations": [{ "path": readme, "line": 3 }]
                    }),
                );
                self.update(
                    &session,
                    json!({
                        "sessionUpdate": "tool_call_update", "toolCallId": read, "status": "completed",
                        "content": [{ "type": "content", "content": { "type": "text", "text": "# Sklep\nOpis" } }]
                    }),
                );
                self.update(
                    &session,
                    json!({
                        "sessionUpdate": "tool_call", "toolCallId": test, "title": "npm test",
                        "kind": "execute", "status": "failed",
                        "content": [{ "type": "content", "content": { "type": "text", "text": "1 test nie przeszedł" } }]
                    }),
                );
                self.update(
                    &session,
                    json!({ "sessionUpdate": "plan", "entries": [
                        { "content": "Przeczytać README", "priority": "high", "status": "completed" },
                        { "content": "Uruchomić testy", "priority": "medium", "status": "completed" }
                    ]}),
                );
                self.update(
                    &session,
                    json!({ "sessionUpdate": "usage_update", "used": 12300, "size": 200000,
                            "cost": { "amount": 0.42, "currency": "USD" } }),
                );
                self.chunk(
                    &session,
                    "agent_message_chunk",
                    "Gotowe: **1 test** nie przeszedł. Zobacz [dokumentację](https://example.com/docs).",
                );
                "end_turn"
            }
            "selfedit" => {
                let path = format!("{}/README.md", self.cwd);
                self.next_id += 1;
                let tool = format!("selfedit-{}", self.next_id);
                self.update(
                    &session,
                    json!({ "sessionUpdate": "tool_call", "toolCallId": tool, "title": "Edit README.md",
                            "kind": "edit", "status": "in_progress", "locations": [{ "path": path }] }),
                );
                let old = std::fs::read_to_string(&path).unwrap_or_default();
                let _ = std::fs::write(
                    &path,
                    format!("{}\nZmienione bezpośrednio przez agenta.\n", old.trim_end()),
                );
                self.update(
                    &session,
                    json!({ "sessionUpdate": "tool_call_update", "toolCallId": tool, "status": "completed" }),
                );
                self.chunk(&session, "agent_message_chunk", "zmieniono bezpośrednio");
                "end_turn"
            }
            "pwd" => {
                self.chunk(
                    &session,
                    "agent_message_chunk",
                    &format!("cwd={}", self.cwd),
                );
                "end_turn"
            }
            other => {
                if other == "garbage" {
                    println!("to nie jest JSON");
                }
                self.chunk(&session, "agent_thought_chunk", "myślę");
                self.chunk(&session, "agent_message_chunk", "Echo: ");
                self.chunk(&session, "agent_message_chunk", other);
                self.update(
                    &session,
                    json!({ "sessionUpdate": "plan", "entries": [
                        { "content": "Przeczytać prompt", "priority": "high", "status": "completed" }
                    ]}),
                );
                "end_turn"
            }
        };
        self.respond(id, json!({ "stopReason": stop }));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let protocol = args
        .iter()
        .position(|a| a == "--protocol")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    let mut agent = Agent {
        input: std::io::stdin().lock().lines(),
        next_id: 0,
        need_auth: args.iter().any(|a| a == "--need-auth"),
        protocol,
        cwd: String::new(),
        mode: "code".into(),
        model: "fast".into(),
        web: false,
        client_fs: false,
        client_terminal: false,
        load: args.iter().any(|a| a == "--load"),
        resume: args.iter().any(|a| a == "--resume"),
        sessions: args.iter().any(|a| a == "--sessions"),
        saved: vec![
            ("stara-1".into(), "Wczorajsza rozmowa".into()),
            ("stara-2".into(), "Starsza rozmowa".into()),
        ],
    };
    eprintln!("fake agent: start");
    while let Some(msg) = agent.read() {
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        match msg.get("method").and_then(Value::as_str) {
            Some("initialize") => {
                agent.client_fs = params["clientCapabilities"]["fs"]["readTextFile"] == true;
                agent.client_terminal = params["clientCapabilities"]["terminal"] == true;
                agent.respond(
                    &id,
                    json!({
                        "protocolVersion": agent.protocol,
                        "agentCapabilities": {
                            "loadSession": agent.load,
                            "promptCapabilities": { "image": false },
                            "sessionCapabilities": {
                                "resume": if agent.resume { json!({}) } else { Value::Null },
                                "list": if agent.sessions { json!({}) } else { Value::Null },
                                "delete": if agent.sessions { json!({}) } else { Value::Null }
                            }
                        },
                        "authMethods": [{ "id": "fake-login", "name": "Zaloguj w atrapie" }],
                        "agentInfo": { "name": "fake-acp-agent", "version": "1.0.0" }
                    }),
                );
            }
            Some("authenticate") => {
                agent.need_auth = params["methodId"] != "fake-login";
                agent.respond(&id, json!({}));
            }
            Some("session/new") => {
                let cwd = params["cwd"].as_str().unwrap_or_default();
                if agent.need_auth {
                    agent.error(&id, -32000, "Najpierw się zaloguj");
                } else if !(cwd.starts_with('/') || cwd.get(1..3) == Some(":\\")) {
                    agent.error(&id, -32602, "cwd musi być ścieżką bezwzględną");
                } else {
                    agent.cwd = cwd.to_string();
                    agent.respond(
                        &id,
                        json!({
                            "sessionId": "fake-1",
                            "modes": { "currentModeId": agent.mode, "availableModes": [
                                { "id": "code", "name": "Kod" }, { "id": "ask", "name": "Pytania" }
                            ]},
                            "configOptions": agent.config_options()
                        }),
                    );
                    agent.update(
                        "fake-1",
                        json!({ "sessionUpdate": "available_commands_update", "availableCommands": [
                            { "name": "review", "description": "Przejrzyj zmiany", "input": { "hint": "co przejrzeć" } },
                            { "name": "init", "description": "Utwórz plik AGENTS.md" }
                        ]}),
                    );
                }
            }
            Some("session/set_mode") => {
                agent.mode = params["modeId"].as_str().unwrap_or("code").to_string();
                agent.respond(&id, json!({}));
                let mode = agent.mode.clone();
                agent.update(
                    "fake-1",
                    json!({ "sessionUpdate": "current_mode_update", "currentModeId": mode }),
                );
            }
            Some("session/set_config_option") => {
                match params["configId"].as_str() {
                    Some("model") => {
                        agent.model = params["value"].as_str().unwrap_or("fast").to_string()
                    }
                    Some("web") => agent.web = params["value"].as_bool().unwrap_or(false),
                    _ => {}
                }
                let options = agent.config_options();
                agent.respond(&id, json!({ "configOptions": options }));
            }
            Some(method @ ("session/load" | "session/resume")) => {
                let sid = params["sessionId"].as_str().unwrap_or_default().to_string();
                let allowed = if method == "session/load" {
                    agent.load
                } else {
                    agent.resume
                };
                if !allowed {
                    agent.error(&id, -32601, "Nieznana metoda");
                } else if !sid.starts_with("fake-") && !agent.saved.iter().any(|(s, _)| *s == sid) {
                    agent.error(&id, -32602, "Nie ma takiej sesji");
                } else {
                    agent.cwd = params["cwd"].as_str().unwrap_or_default().to_string();
                    if method == "session/load" {
                        // The whole conversation again, before the answer.
                        agent.chunk(&sid, "user_message_chunk", "Napraw testy");
                        agent.chunk(&sid, "agent_message_chunk", "Naprawiłem testy w sklepie.");
                    }
                    agent.respond(&id, json!({ "modes": null }));
                    agent.update(
                        &sid,
                        json!({ "sessionUpdate": "available_commands_update", "availableCommands": [
                            { "name": "review", "description": "Przejrzyj zmiany" }
                        ]}),
                    );
                }
            }
            Some("session/list") if agent.sessions => {
                let cwd = params["cwd"].clone();
                let list: Vec<Value> = agent
                    .saved
                    .iter()
                    .map(|(s, t)| json!({ "sessionId": s, "cwd": cwd, "title": t, "updatedAt": "2026-11-11T10:00:00Z" }))
                    .collect();
                agent.respond(&id, json!({ "sessions": list }));
            }
            Some("session/delete") if agent.sessions => {
                let sid = params["sessionId"].as_str().unwrap_or_default().to_string();
                agent.saved.retain(|(s, _)| *s != sid);
                agent.respond(&id, json!({}));
            }
            Some("session/prompt") => agent.prompt(&id, &params),
            Some(_) if !id.is_null() => agent.error(&id, -32601, "Nieznana metoda"),
            _ => {}
        }
    }
}
