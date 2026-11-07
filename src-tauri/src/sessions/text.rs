//! Plain text from terminal output for full-text search: colours, cursor movement and other
//! escape sequences are dropped. Streaming – sequences split across chunks are handled.

use vte::{Parser, Perform};

#[derive(Default)]
struct Collector {
    out: String,
}

impl Perform for Collector {
    fn print(&mut self, c: char) {
        self.out.push(c);
    }

    fn execute(&mut self, byte: u8) {
        match byte {
            b'\n' => self.out.push('\n'),
            b'\t' => self.out.push('\t'),
            _ => {} // \r, bell, backspace, …
        }
    }
}

pub struct TextExtractor {
    parser: Parser,
    collector: Collector,
}

impl Default for TextExtractor {
    fn default() -> Self {
        Self {
            parser: Parser::new(),
            collector: Collector::default(),
        }
    }
}

impl TextExtractor {
    /// Feeds raw PTY bytes; returns the text that became available.
    pub fn feed(&mut self, bytes: &[u8]) -> String {
        self.parser.advance(&mut self.collector, bytes);
        std::mem::take(&mut self.collector.out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_escape_sequences() {
        let mut t = TextExtractor::default();
        let out = t.feed(b"\x1b[1;31mred\x1b[0m plain\r\n\x1b]0;title\x07next\x1b[2K\tend");
        assert_eq!(out, "red plain\nnext\tend");
    }

    #[test]
    fn handles_sequences_and_utf8_split_across_chunks() {
        let mut t = TextExtractor::default();
        let bytes = "\x1b[32mzażółć\x1b[0m".as_bytes();
        let mut text = String::new();
        for chunk in bytes.chunks(3) {
            text.push_str(&t.feed(chunk));
        }
        assert_eq!(text, "zażółć");
    }
}
