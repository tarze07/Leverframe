use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// How long output is accumulated before it is sent to the UI.
/// Keeps the webview from being flooded by thousands of tiny messages (e.g. `cat bigfile`).
pub const BATCH_INTERVAL: Duration = Duration::from_millis(8);
/// Flush early once this many bytes are buffered.
pub const BATCH_MAX_BYTES: usize = 64 * 1024;

/// Collects chunks from `rx` and calls `emit` with batches of at most ~`BATCH_MAX_BYTES`,
/// at most every `BATCH_INTERVAL`. Returns when the sender side is dropped (after a final flush).
pub fn spawn_batcher<F>(rx: Receiver<Vec<u8>>, mut emit: F) -> JoinHandle<()>
where
    F: FnMut(Vec<u8>) + Send + 'static,
{
    std::thread::Builder::new()
        .name("pty-batcher".into())
        .spawn(move || {
            // Block for the first chunk of each batch.
            while let Ok(first) = rx.recv() {
                let mut buf = first;
                let deadline = Instant::now() + BATCH_INTERVAL;
                let mut disconnected = false;
                while buf.len() < BATCH_MAX_BYTES {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    match rx.recv_timeout(deadline - now) {
                        Ok(chunk) => buf.extend_from_slice(&chunk),
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => {
                            disconnected = true;
                            break;
                        }
                    }
                }
                emit(buf);
                if disconnected {
                    return;
                }
            }
        })
        .expect("failed to spawn pty batcher thread")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};

    #[test]
    fn merges_chunks_sent_within_one_interval() {
        let (tx, rx) = mpsc::channel();
        let batches = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let sink = batches.clone();
        let handle = spawn_batcher(rx, move |b| sink.lock().unwrap().push(b));
        for part in [b"ab".to_vec(), b"cd".to_vec(), b"ef".to_vec()] {
            tx.send(part).unwrap();
        }
        drop(tx);
        handle.join().unwrap();
        let batches = batches.lock().unwrap();
        assert_eq!(batches.concat(), b"abcdef");
        assert_eq!(
            batches.len(),
            1,
            "chunks sent together should form one batch"
        );
    }

    #[test]
    fn flushes_early_when_batch_is_full() {
        let (tx, rx) = mpsc::channel();
        let batches = Arc::new(Mutex::new(Vec::<usize>::new()));
        let sink = batches.clone();
        let handle = spawn_batcher(rx, move |b| sink.lock().unwrap().push(b.len()));
        for _ in 0..4 {
            tx.send(vec![0u8; BATCH_MAX_BYTES / 2]).unwrap();
        }
        drop(tx);
        handle.join().unwrap();
        let sizes = batches.lock().unwrap();
        assert_eq!(sizes.iter().sum::<usize>(), 2 * BATCH_MAX_BYTES);
        assert!(sizes.len() >= 2);
        assert!(sizes.iter().all(|&s| s <= BATCH_MAX_BYTES));
    }

    #[test]
    fn emits_nothing_without_input() {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let count = Arc::new(Mutex::new(0));
        let sink = count.clone();
        let handle = spawn_batcher(rx, move |_| *sink.lock().unwrap() += 1);
        drop(tx);
        handle.join().unwrap();
        assert_eq!(*count.lock().unwrap(), 0);
    }
}
