//! Commands an ACP agent runs through Leverframe (`terminal/*`): a PTY in the session's profile
//! (local or WSL), live output for the UI, and plain text (no escape sequences) for the agent,
//! cut from the beginning to the agent's `outputByteLimit`.

use std::path::PathBuf;
use std::sync::{Condvar, Mutex};

use super::fs::{to_local, FsKind};
use super::launch::sh_quote;
use crate::agents::LOGIN_PATH_PRELUDE;
use crate::pty::SpawnOptions;
use crate::sessions::text::TextExtractor;

/// Output kept for the agent when it sets no limit.
pub const DEFAULT_OUTPUT_LIMIT: usize = 1024 * 1024;

/// How a command ended: exit code, or the signal that stopped it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitStatus {
    pub code: Option<u32>,
    pub signal: Option<String>,
}

/// Text output for the agent: escape sequences removed, at most `limit` bytes (the oldest part
/// is dropped, at a character boundary).
pub struct TextOutput {
    text: String,
    truncated: bool,
    limit: usize,
    extractor: TextExtractor,
}

impl TextOutput {
    pub fn new(limit: Option<u64>) -> Self {
        Self {
            text: String::new(),
            truncated: false,
            limit: limit.map(|l| l as usize).unwrap_or(DEFAULT_OUTPUT_LIMIT),
            extractor: TextExtractor::default(),
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.text.push_str(&self.extractor.feed(bytes));
        if self.text.len() > self.limit {
            let mut cut = self.text.len() - self.limit;
            while !self.text.is_char_boundary(cut) {
                cut += 1;
            }
            self.text.drain(..cut);
            self.truncated = true;
        }
    }

    pub fn snapshot(&self) -> (String, bool) {
        (self.text.clone(), self.truncated)
    }
}

/// Bytes → text for the UI, keeping a UTF-8 sequence split between chunks for the next one.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn decode(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(), // incomplete at the end
            Err(_) => self.pending.len(),                         // invalid: replaced below
        };
        let out = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
        self.pending.drain(..valid);
        out
    }
}

/// Finds cursor position queries (`ESC [ 6 n`) in a terminal's output, also when split between
/// chunks. Windows' console (ConPTY) sends one when a command starts and waits for the answer
/// before the command runs; the user's terminal (xterm.js) answers it, the agent's terminals have
/// no view that could, so Leverframe answers itself (`CURSOR_POSITION`).
#[derive(Default)]
pub struct CursorQueries {
    tail: Vec<u8>,
}

/// The answer to a cursor position query: the top left corner.
pub const CURSOR_POSITION: &[u8] = b"\x1b[1;1R";

impl CursorQueries {
    const QUERY: &'static [u8] = b"\x1b[6n";

    /// How many queries end in `bytes`.
    pub fn scan(&mut self, bytes: &[u8]) -> usize {
        self.tail.extend_from_slice(bytes);
        let count = self
            .tail
            .windows(Self::QUERY.len())
            .filter(|w| *w == Self::QUERY)
            .count();
        // Keep only what could be the start of a query split off by the next chunk.
        let keep = (1..Self::QUERY.len())
            .rev()
            .find(|&n| self.tail.ends_with(&Self::QUERY[..n]))
            .unwrap_or(0);
        self.tail.drain(..self.tail.len() - keep);
        count
    }
}

/// One command of the agent.
pub struct AgentTerminal {
    /// The PTY once started; `pending_answers` holds cursor queries that came before.
    pub pty_id: Mutex<Option<crate::pty::PtyId>>,
    pub pending_answers: Mutex<usize>,
    pub cursor_queries: Mutex<CursorQueries>,
    pub output: Mutex<TextOutput>,
    pub exit: Mutex<Option<ExitStatus>>,
    pub exited: Condvar,
    pub killed: std::sync::atomic::AtomicBool,
    pub ui_text: Mutex<Utf8Stream>,
}

impl AgentTerminal {
    pub fn new(limit: Option<u64>) -> Self {
        Self {
            pty_id: Mutex::new(None),
            pending_answers: Mutex::new(0),
            cursor_queries: Mutex::new(CursorQueries::default()),
            output: Mutex::new(TextOutput::new(limit)),
            exit: Mutex::new(None),
            exited: Condvar::new(),
            killed: std::sync::atomic::AtomicBool::new(false),
            ui_text: Mutex::new(Utf8Stream::default()),
        }
    }

    /// Blocks until the command ends.
    pub fn wait(&self) -> ExitStatus {
        let mut exit = self.exit.lock().unwrap();
        while exit.is_none() {
            exit = self.exited.wait(exit).unwrap();
        }
        exit.clone().unwrap()
    }
}

/// A command as the agent sent it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandRequest {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Working directory in the agent's file system (absolute).
    pub cwd: Option<String>,
    pub output_byte_limit: Option<u64>,
}

impl CommandRequest {
    /// The command line shown to the user.
    pub fn display(&self) -> String {
        std::iter::once(self.command.as_str())
            .chain(self.args.iter().map(String::as_str))
            .map(|w| {
                if w.is_empty()
                    || w.contains(|c: char| c.is_whitespace() || "'\"$`\\;&|<>()".contains(c))
                {
                    sh_quote(w)
                } else {
                    w.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn valid_env_name(n: &str) -> bool {
    let mut chars = n.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The `sh` script running a command: the login shell's `PATH`, the agent's variables, `exec`.
pub fn command_script(req: &CommandRequest) -> String {
    let mut s = String::from(LOGIN_PATH_PRELUDE);
    for (name, value) in &req.env {
        s.push_str(&format!("export {name}={}\n", sh_quote(value)));
    }
    let words: Vec<String> = std::iter::once(&req.command)
        .chain(req.args.iter())
        .map(|w| sh_quote(w))
        .collect();
    s.push_str(&format!("exec {}\n", words.join(" ")));
    s
}

/// How to start the agent's command in a PTY: in the session's WSL distribution, through cmd.exe
/// on Windows, or through `sh` with the login `PATH` elsewhere. `session_cwd` is the session's
/// folder in the agent's file system (used when the agent gives none).
pub fn spawn_options(
    kind: &FsKind,
    req: &CommandRequest,
    session_cwd: Option<&str>,
    windows: bool,
) -> Result<SpawnOptions, String> {
    if req.command.trim().is_empty() {
        return Err("Brak polecenia".into());
    }
    if let Some((bad, _)) = req.env.iter().find(|(n, _)| !valid_env_name(n)) {
        return Err(format!("Nieprawidłowa nazwa zmiennej środowiskowej: {bad}"));
    }
    let agent_cwd = req.cwd.as_deref().or(session_cwd);
    let mut opts = SpawnOptions {
        cols: 120,
        rows: 30,
        ..Default::default()
    };
    match kind {
        FsKind::Wsl(distro) => {
            let mut args = vec!["-d".to_string(), distro.clone()];
            if let Some(dir) = agent_cwd {
                args.extend(["--cd".to_string(), dir.to_string()]);
            }
            args.extend(["-e", "sh", "-c"].map(String::from));
            args.push(command_script(req));
            opts.program = Some("wsl.exe".into());
            opts.args = args;
        }
        FsKind::Local if windows => {
            // cmd.exe finds npm's .cmd shims; the agent's words are passed one by one.
            let mut args = vec!["/d".to_string(), "/c".to_string(), req.command.clone()];
            args.extend(req.args.iter().cloned());
            opts.program = Some("cmd.exe".into());
            opts.args = args;
            opts.env = req.env.clone();
            opts.cwd = agent_cwd.map(|d| to_local(kind, d)).transpose()?;
        }
        FsKind::Local => {
            opts.program = Some("/bin/sh".into());
            opts.args = vec!["-c".into(), command_script(req)];
            opts.cwd = agent_cwd.map(|d| to_local(kind, d)).transpose()?;
        }
    }
    if let Some(dir) = &opts.cwd {
        if !PathBuf::from(dir).is_dir() {
            return Err(format!("Katalog nie istnieje: {}", dir.display()));
        }
    }
    Ok(opts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(command: &str, args: &[&str]) -> CommandRequest {
        CommandRequest {
            command: command.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            env: vec![],
            cwd: None,
            output_byte_limit: None,
        }
    }

    #[test]
    fn output_for_the_agent_is_plain_text_cut_from_the_beginning() {
        let mut out = TextOutput::new(Some(10));
        out.push(b"\x1b[32mzielony\x1b[0m\r\n");
        assert_eq!(out.snapshot(), ("zielony\n".into(), false));
        out.push(b"0123456789");
        let (text, truncated) = out.snapshot();
        assert!(truncated);
        assert_eq!(text, "0123456789");
        // Never in the middle of a character.
        let mut out = TextOutput::new(Some(5));
        out.push("ąąąą".as_bytes()); // 8 bytes
        assert_eq!(out.snapshot(), ("ąą".into(), true));
    }

    #[test]
    fn cursor_queries_are_found_also_when_split() {
        let mut q = CursorQueries::default();
        assert_eq!(q.scan(b"abc\x1b[6nde\x1b[6n"), 2);
        assert_eq!(q.scan(b"x\x1b["), 0);
        assert_eq!(q.scan(b"6"), 0);
        assert_eq!(q.scan(b"n\x1b[6"), 1);
        assert_eq!(q.scan(b"m"), 0); // a different sequence
        assert_eq!(q.scan(b"\x1b[6n"), 1);
        assert_eq!(q.scan(b"\x1b[0m plain"), 0);
    }

    #[test]
    fn ui_text_keeps_split_characters() {
        let mut s = Utf8Stream::default();
        let bytes = "zażółć".as_bytes();
        let a = s.decode(&bytes[..3]); // "za" + half of "ż"
        let b = s.decode(&bytes[3..]);
        assert_eq!(format!("{a}{b}"), "zażółć");
        assert_eq!(a, "za");
        assert_eq!(
            s.decode(&[0xff, b'x']),
            "\u{fffd}x",
            "invalid bytes do not stall the stream"
        );
    }

    #[test]
    fn commands_are_quoted_and_shown_readably() {
        let mut r = req("npm", &["run", "test:unit", "--", "--grep", "my test"]);
        r.env = vec![("CI".into(), "1".into()), ("MSG".into(), "it's".into())];
        let s = command_script(&r);
        assert!(s.starts_with(LOGIN_PATH_PRELUDE));
        assert!(s.contains("export CI='1'\nexport MSG='it'\\''s'\n"));
        assert!(s.ends_with("exec 'npm' 'run' 'test:unit' '--' '--grep' 'my test'\n"));
        assert_eq!(r.display(), "npm run test:unit -- --grep 'my test'");
        assert_eq!(
            req("sh", &["-c", "echo $HOME; ls"]).display(),
            "sh -c 'echo $HOME; ls'"
        );
    }

    #[test]
    fn spawn_options_per_profile() {
        let dir = std::env::temp_dir();
        let dir_s = dir.to_string_lossy().into_owned();
        let local = spawn_options(
            &FsKind::Local,
            &req("cargo", &["test"]),
            Some(&dir_s),
            false,
        )
        .unwrap();
        assert_eq!(local.program.as_deref(), Some("/bin/sh"));
        assert_eq!(local.args[0], "-c");
        assert!(local.args[1].ends_with("exec 'cargo' 'test'\n"));
        assert_eq!(
            local.cwd,
            Some(dir.clone()),
            "the session folder by default"
        );

        let mut r = req("npm", &["test"]);
        r.cwd = Some("/home/me/app".into());
        let wsl = spawn_options(&FsKind::Wsl("Ubuntu".into()), &r, Some("/home/me"), true).unwrap();
        assert_eq!(wsl.program.as_deref(), Some("wsl.exe"));
        assert_eq!(
            &wsl.args[..7],
            ["-d", "Ubuntu", "--cd", "/home/me/app", "-e", "sh", "-c"]
        );
        assert_eq!(wsl.cwd, None, "WSL changes the directory itself");

        let win =
            spawn_options(&FsKind::Local, &req("npm", &["run", "build"]), None, true).unwrap();
        assert_eq!(win.program.as_deref(), Some("cmd.exe"));
        assert_eq!(win.args, ["/d", "/c", "npm", "run", "build"]);

        assert!(spawn_options(&FsKind::Local, &req(" ", &[]), None, false).is_err());
        let mut bad = req("x", &[]);
        bad.env = vec![("A;rm -rf ~".into(), "1".into())];
        assert!(spawn_options(&FsKind::Local, &bad, None, false).is_err());
        let mut missing = req("x", &[]);
        missing.cwd = Some("/definitely/not/here".into());
        assert!(spawn_options(&FsKind::Local, &missing, None, false).is_err());
        let mut relative = req("x", &[]);
        relative.cwd = Some("relative".into());
        assert!(spawn_options(&FsKind::Local, &relative, None, false).is_err());
    }
}
