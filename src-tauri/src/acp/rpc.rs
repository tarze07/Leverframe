//! JSON-RPC 2.0 over a byte stream, as ACP uses it on stdio: one JSON message per line.
//!
//! Plain threads (like the rest of the backend): a reader thread routes responses to the
//! waiting caller and hands requests / notifications from the peer to an [`Incoming`] handler.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

/// Error object of a JSON-RPC response.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub const PARSE_ERROR: i64 = -32700;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL_ERROR: i64 = -32603;
    /// ACP: the agent needs `authenticate` first.
    pub const AUTH_REQUIRED: i64 = -32000;

    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    fn from_value(v: &Value) -> Self {
        Self {
            code: v.get("code").and_then(Value::as_i64).unwrap_or(-32603),
            message: v
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Nieznany błąd agenta")
                .to_string(),
            data: v.get("data").cloned(),
        }
    }

    fn to_value(&self) -> Value {
        let mut v = json!({ "code": self.code, "message": self.message });
        if let Some(d) = &self.data {
            v["data"] = d.clone();
        }
        v
    }
}

/// Why a call did not return a result.
#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    /// The peer answered with an error.
    Rpc(RpcError),
    /// The connection ended (process exited, pipe closed) before the answer.
    Closed,
    /// No answer within the time limit.
    Timeout,
    /// Writing the message failed.
    Io(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Rpc(e) => write!(f, "{} (kod {})", e.message, e.code),
            CallError::Closed => write!(f, "Agent zakończył działanie"),
            CallError::Timeout => write!(f, "Agent nie odpowiedział w wyznaczonym czasie"),
            CallError::Io(e) => write!(f, "Błąd komunikacji z agentem: {e}"),
        }
    }
}

/// Messages the peer sends us. Called on the reader thread: must not block for long
/// (a request that waits for the user is stored and answered later with [`Connection::respond`]).
pub trait Incoming: Send + Sync + 'static {
    fn request(&self, conn: &Connection, id: Value, method: &str, params: Value);
    fn notification(&self, method: &str, params: Value);
    /// A line that is not a JSON-RPC message (logged, never fatal).
    fn invalid(&self, line: &str);
    /// The stream ended; every pending call has already failed with [`CallError::Closed`].
    fn closed(&self);
}

type Pending = Mutex<HashMap<u64, mpsc::Sender<Result<Value, CallError>>>>;

pub struct Connection {
    writer: Mutex<Box<dyn Write + Send>>,
    pending: Pending,
    next_id: AtomicU64,
    closed: AtomicBool,
}

impl Connection {
    /// Starts reading `reader` on a new thread; messages are written to `writer`.
    pub fn start(
        reader: impl Read + Send + 'static,
        writer: impl Write + Send + 'static,
        incoming: Arc<dyn Incoming>,
    ) -> Arc<Connection> {
        let conn = Arc::new(Connection {
            writer: Mutex::new(Box::new(writer)),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            closed: AtomicBool::new(false),
        });
        let reader_conn = conn.clone();
        std::thread::Builder::new()
            .name("acp-reader".into())
            .spawn(move || reader_conn.read_loop(BufReader::new(reader), incoming))
            .expect("spawn acp reader");
        conn
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn send(&self, message: &Value) -> Result<(), CallError> {
        if self.is_closed() {
            return Err(CallError::Closed);
        }
        let mut line = serde_json::to_string(message).map_err(|e| CallError::Io(e.to_string()))?;
        line.push('\n');
        let mut w = self.writer.lock().unwrap();
        w.write_all(line.as_bytes())
            .and_then(|_| w.flush())
            .map_err(|e| CallError::Io(e.to_string()))
    }

    /// Sends a request and waits for its result (`None` = no time limit, e.g. a prompt turn).
    pub fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, CallError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        // The reader may have closed the connection just before we registered.
        if self.is_closed() {
            self.pending.lock().unwrap().remove(&id);
            return Err(CallError::Closed);
        }
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.send(&msg) {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        let result = match timeout {
            Some(t) => rx.recv_timeout(t).map_err(|e| match e {
                mpsc::RecvTimeoutError::Timeout => CallError::Timeout,
                mpsc::RecvTimeoutError::Disconnected => CallError::Closed,
            }),
            None => rx.recv().map_err(|_| CallError::Closed),
        };
        self.pending.lock().unwrap().remove(&id);
        result?
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), CallError> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    /// Answers a request from the peer.
    pub fn respond(&self, id: Value, result: Result<Value, RpcError>) -> Result<(), CallError> {
        let msg = match result {
            Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
            Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e.to_value() }),
        };
        self.send(&msg)
    }

    fn read_loop(&self, reader: impl BufRead, incoming: Arc<dyn Incoming>) {
        for line in reader.split(b'\n') {
            let Ok(bytes) = line else { break };
            let text = String::from_utf8_lossy(&bytes);
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(text) {
                Ok(msg) if msg.is_object() => self.dispatch(msg, &*incoming),
                _ => incoming.invalid(text),
            }
        }
        self.closed.store(true, Ordering::SeqCst);
        for (_, tx) in self.pending.lock().unwrap().drain() {
            let _ = tx.send(Err(CallError::Closed));
        }
        incoming.closed();
    }

    fn dispatch(&self, mut msg: Value, incoming: &dyn Incoming) {
        let id = msg.get_mut("id").map(Value::take).filter(|v| !v.is_null());
        let method = msg.get("method").and_then(Value::as_str).map(String::from);
        let params = msg
            .get_mut("params")
            .map(Value::take)
            .unwrap_or(Value::Null);
        match (id, method) {
            (Some(id), Some(method)) => incoming.request(self, id, &method, params),
            (None, Some(method)) => incoming.notification(&method, params),
            (Some(id), None) => {
                let result = if let Some(err) = msg.get("error") {
                    Err(CallError::Rpc(RpcError::from_value(err)))
                } else {
                    Ok(msg
                        .get_mut("result")
                        .map(Value::take)
                        .unwrap_or(Value::Null))
                };
                // Our ids are numbers; anything else cannot be ours.
                if let Some(tx) = id
                    .as_u64()
                    .and_then(|n| self.pending.lock().unwrap().remove(&n))
                {
                    let _ = tx.send(result);
                }
            }
            (None, None) => incoming.invalid(&msg.to_string()),
        }
    }
}

#[cfg(test)]
pub(crate) mod test_pipe {
    //! In-memory byte pipe (std::io::pipe needs a newer Rust than our MSRV).
    use std::io::{Read, Write};
    use std::sync::mpsc;

    pub struct PipeWriter(mpsc::Sender<Vec<u8>>);
    pub struct PipeReader {
        rx: mpsc::Receiver<Vec<u8>>,
        buf: Vec<u8>,
    }

    pub fn pipe() -> (PipeReader, PipeWriter) {
        let (tx, rx) = mpsc::channel();
        (
            PipeReader {
                rx,
                buf: Vec::new(),
            },
            PipeWriter(tx),
        )
    }

    impl Write for PipeWriter {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0
                .send(data.to_vec())
                .map_err(|_| std::io::Error::from(std::io::ErrorKind::BrokenPipe))?;
            Ok(data.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Read for PipeReader {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if self.buf.is_empty() {
                match self.rx.recv() {
                    Ok(chunk) => self.buf = chunk,
                    Err(_) => return Ok(0), // writer dropped: end of stream
                }
            }
            let n = out.len().min(self.buf.len());
            out[..n].copy_from_slice(&self.buf[..n]);
            self.buf.drain(..n);
            Ok(n)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_pipe::pipe;
    use super::*;

    #[derive(Default)]
    struct Recorder {
        log: Mutex<Vec<String>>,
    }

    impl Incoming for Recorder {
        fn request(&self, conn: &Connection, id: Value, method: &str, params: Value) {
            self.log
                .lock()
                .unwrap()
                .push(format!("request {method} {params}"));
            if method == "echo" {
                conn.respond(id, Ok(params)).unwrap();
            } else {
                conn.respond(id, Err(RpcError::new(RpcError::METHOD_NOT_FOUND, "nope")))
                    .unwrap();
            }
        }
        fn notification(&self, method: &str, params: Value) {
            self.log
                .lock()
                .unwrap()
                .push(format!("notify {method} {params}"));
        }
        fn invalid(&self, line: &str) {
            self.log.lock().unwrap().push(format!("invalid {line}"));
        }
        fn closed(&self) {
            self.log.lock().unwrap().push("closed".into());
        }
    }

    /// A connection plus the other end of both pipes, driven line by line by the test.
    fn harness() -> (
        Arc<Connection>,
        Arc<Recorder>,
        BufReader<test_pipe::PipeReader>,
        test_pipe::PipeWriter,
    ) {
        let (our_in, peer_out) = pipe();
        let (peer_in, our_out) = pipe();
        let rec = Arc::new(Recorder::default());
        let conn = Connection::start(our_in, our_out, rec.clone());
        (conn, rec, BufReader::new(peer_in), peer_out)
    }

    fn read_msg(r: &mut BufReader<test_pipe::PipeReader>) -> Value {
        let mut line = String::new();
        r.read_line(&mut line).unwrap();
        assert!(line.ends_with('\n'), "one message per line");
        serde_json::from_str(&line).unwrap()
    }

    fn write_line(w: &mut test_pipe::PipeWriter, v: &str) {
        w.write_all(format!("{v}\n").as_bytes()).unwrap();
    }

    #[test]
    fn requests_get_their_results_and_errors() {
        let (conn, _rec, mut peer_in, mut peer_out) = harness();
        let c = conn.clone();
        let call = std::thread::spawn(move || c.request("initialize", json!({"a": 1}), None));
        let msg = read_msg(&mut peer_in);
        assert_eq!(msg["jsonrpc"], "2.0");
        assert_eq!(msg["method"], "initialize");
        assert_eq!(msg["params"], json!({"a": 1}));
        write_line(
            &mut peer_out,
            &json!({"jsonrpc": "2.0", "id": msg["id"], "result": {"ok": true}}).to_string(),
        );
        assert_eq!(call.join().unwrap().unwrap(), json!({"ok": true}));

        let c = conn.clone();
        let call = std::thread::spawn(move || c.request("session/new", json!({}), None));
        let msg = read_msg(&mut peer_in);
        write_line(
            &mut peer_out,
            &json!({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32000, "message": "Zaloguj się"}})
                .to_string(),
        );
        assert_eq!(
            call.join().unwrap(),
            Err(CallError::Rpc(RpcError::new(
                RpcError::AUTH_REQUIRED,
                "Zaloguj się"
            )))
        );
    }

    #[test]
    fn peer_requests_and_notifications_reach_the_handler() {
        let (_conn, rec, mut peer_in, mut peer_out) = harness();
        write_line(
            &mut peer_out,
            r#"{"jsonrpc":"2.0","id":"x-7","method":"echo","params":{"v":2}}"#,
        );
        assert_eq!(
            read_msg(&mut peer_in),
            json!({"jsonrpc": "2.0", "id": "x-7", "result": {"v": 2}})
        );
        write_line(
            &mut peer_out,
            r#"{"jsonrpc":"2.0","id":3,"method":"fs/read_text_file","params":{}}"#,
        );
        assert_eq!(read_msg(&mut peer_in)["error"]["code"], -32601);
        write_line(
            &mut peer_out,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"u":1}}"#,
        );
        write_line(&mut peer_out, "Debugger listening on ws://…");
        write_line(&mut peer_out, "");
        drop(peer_out);
        for _ in 0..100 {
            if rec.log.lock().unwrap().last().map(String::as_str) == Some("closed") {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let log = rec.log.lock().unwrap().clone();
        assert_eq!(
            log,
            vec![
                r#"request echo {"v":2}"#,
                "request fs/read_text_file {}",
                r#"notify session/update {"u":1}"#,
                "invalid Debugger listening on ws://…",
                "closed",
            ]
        );
    }

    #[test]
    fn pending_calls_fail_when_the_stream_ends_and_later_calls_fail_fast() {
        let (conn, _rec, mut peer_in, peer_out) = harness();
        let c = conn.clone();
        let call = std::thread::spawn(move || c.request("session/prompt", json!({}), None));
        read_msg(&mut peer_in);
        drop(peer_out);
        assert_eq!(call.join().unwrap(), Err(CallError::Closed));
        assert!(conn.is_closed());
        assert_eq!(conn.request("x", json!({}), None), Err(CallError::Closed));
    }

    #[test]
    fn requests_time_out() {
        let (conn, _rec, mut peer_in, _peer_out) = harness();
        let c = conn.clone();
        let call = std::thread::spawn(move || {
            c.request("initialize", json!({}), Some(Duration::from_millis(50)))
        });
        read_msg(&mut peer_in);
        assert_eq!(call.join().unwrap(), Err(CallError::Timeout));
    }
}
