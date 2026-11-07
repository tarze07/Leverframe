//! asciicast v2 writer (https://docs.asciinema.org/manual/asciicast/v2/):
//! a JSON header line, then one `[seconds, "o" | "r", data]` line per event.

use std::io::Write;
use std::time::Instant;

use serde_json::json;

pub struct CastWriter<W: Write> {
    out: W,
    start: Instant,
    /// Bytes of an incomplete UTF-8 sequence carried over to the next chunk.
    pending: Vec<u8>,
}

/// Splits `bytes` into the longest valid UTF-8 text (invalid bytes replaced) and an incomplete tail.
pub fn decode_utf8(bytes: &[u8]) -> (String, Vec<u8>) {
    let mut text = String::new();
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                text.push_str(s);
                return (text, Vec::new());
            }
            Err(e) => {
                let (valid, after) = rest.split_at(e.valid_up_to());
                text.push_str(std::str::from_utf8(valid).unwrap_or_default());
                match e.error_len() {
                    None => return (text, after.to_vec()), // incomplete at the end
                    Some(n) => {
                        text.push('\u{FFFD}');
                        rest = &after[n..];
                    }
                }
            }
        }
    }
}

impl<W: Write> CastWriter<W> {
    pub fn new(
        mut out: W,
        cols: u16,
        rows: u16,
        timestamp_secs: u64,
        title: &str,
    ) -> std::io::Result<Self> {
        let header = json!({
            "version": 2,
            "width": cols,
            "height": rows,
            "timestamp": timestamp_secs,
            "title": title,
            "env": { "TERM": "xterm-256color" },
        });
        writeln!(out, "{header}")?;
        Ok(Self {
            out,
            start: Instant::now(),
            pending: Vec::new(),
        })
    }

    fn event(&mut self, kind: &str, data: &str) -> std::io::Result<()> {
        let t = self.start.elapsed().as_secs_f64();
        let line = json!([(t * 1_000_000.0).round() / 1_000_000.0, kind, data]);
        writeln!(self.out, "{line}")
    }

    pub fn output(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        let mut all = std::mem::take(&mut self.pending);
        all.extend_from_slice(bytes);
        let (text, pending) = decode_utf8(&all);
        self.pending = pending;
        if text.is_empty() {
            return Ok(());
        }
        self.event("o", &text)?;
        self.out.flush()
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> std::io::Result<()> {
        self.event("r", &format!("{cols}x{rows}"))?;
        self.out.flush()
    }

    pub fn finish(mut self) -> std::io::Result<W> {
        if !self.pending.is_empty() {
            let rest = String::from_utf8_lossy(&std::mem::take(&mut self.pending)).into_owned();
            self.event("o", &rest)?;
        }
        self.out.flush()?;
        Ok(self.out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn lines(buf: &[u8]) -> Vec<Value> {
        String::from_utf8(buf.to_vec())
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn writes_header_output_and_resize_events() {
        let mut w =
            CastWriter::new(Vec::new(), 80, 24, 1_700_000_000, "Claude Code · bash").unwrap();
        w.output(b"hello \x1b[31mred\x1b[0m\r\n").unwrap();
        w.resize(120, 40).unwrap();
        let l = lines(&w.finish().unwrap());
        assert_eq!(l[0]["version"], 2);
        assert_eq!(
            (l[0]["width"].as_u64(), l[0]["height"].as_u64()),
            (Some(80), Some(24))
        );
        assert_eq!(l[0]["title"], "Claude Code · bash");
        assert_eq!(l[1][1], "o");
        assert_eq!(l[1][2], "hello \u{1b}[31mred\u{1b}[0m\r\n");
        assert_eq!(l[2][1], "r");
        assert_eq!(l[2][2], "120x40");
        assert!(l[2][0].as_f64().unwrap() >= l[1][0].as_f64().unwrap());
    }

    #[test]
    fn keeps_utf8_sequences_split_across_chunks_intact() {
        let mut w = CastWriter::new(Vec::new(), 80, 24, 0, "").unwrap();
        let bytes = "zażółć".as_bytes();
        w.output(&bytes[..3]).unwrap(); // "za" + first byte of "ż"
        w.output(&bytes[3..]).unwrap();
        let l = lines(&w.finish().unwrap());
        let text: String = l[1..].iter().map(|e| e[2].as_str().unwrap()).collect();
        assert_eq!(text, "zażółć");
    }

    #[test]
    fn replaces_invalid_bytes() {
        let (text, rest) = decode_utf8(b"a\xffb\xc5");
        assert_eq!(text, "a\u{FFFD}b");
        assert_eq!(rest, b"\xc5");
    }
}
