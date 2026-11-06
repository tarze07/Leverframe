import { Channel, invoke } from "@tauri-apps/api/core";

export interface PtySpawnRequest {
  /** Program to run; omitted = default shell (PowerShell on Windows, login $SHELL elsewhere). */
  program?: string;
  args?: string[];
  cwd?: string;
  env?: [string, string][];
  cols: number;
  rows: number;
}

export interface PtyHandle {
  id: number;
  program: string;
  pid: number | null;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  kill(): Promise<void>;
}

export interface PtyCallbacks {
  onData(data: Uint8Array): void;
  onExit(exitCode: number | null): void;
}

interface SpawnedPty {
  id: number;
  program: string;
  pid: number | null;
}

/** Raw channel payloads arrive as ArrayBuffer; tolerate a plain byte array too. */
export function toBytes(payload: ArrayBuffer | ArrayLike<number>): Uint8Array {
  return payload instanceof ArrayBuffer ? new Uint8Array(payload) : Uint8Array.from(payload);
}

/** Starts a process in a new pseudo-terminal in the Rust backend. */
export async function spawnPty(request: PtySpawnRequest, callbacks: PtyCallbacks): Promise<PtyHandle> {
  const onData = new Channel<ArrayBuffer>((payload) => callbacks.onData(toBytes(payload)));
  const onExit = new Channel<{ exitCode: number | null }>((msg) => callbacks.onExit(msg.exitCode));
  const spawned = await invoke<SpawnedPty>("pty_spawn", { request, onData, onExit });
  const { id } = spawned;
  return {
    ...spawned,
    write: (data) => invoke("pty_write", { id, data }),
    resize: (cols, rows) => invoke("pty_resize", { id, cols, rows }),
    kill: () => invoke("pty_kill", { id }),
  };
}

/** Tab title for a program path: `/usr/bin/zsh` → `zsh`, `pwsh.exe` → `pwsh`. */
export function programTitle(program: string): string {
  const base = program.split(/[\\/]/).pop() || program;
  return base.replace(/\.exe$/i, "");
}
