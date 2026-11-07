/** asciicast v2 parsing and a playback engine independent of the terminal widget (unit-testable). */

export interface CastHeader {
  version: number;
  width: number;
  height: number;
  timestamp?: number;
  title?: string;
}

export interface CastEvent {
  /** Seconds from the start (after idle compression, if applied). */
  time: number;
  type: "o" | "r" | "i" | "m" | string;
  data: string;
}

export interface Cast {
  header: CastHeader;
  events: CastEvent[];
  duration: number;
}

export function parseCast(text: string): Cast {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) throw new Error("Puste nagranie");
  const header = JSON.parse(lines[0]) as CastHeader;
  if (header.version !== 2) throw new Error(`Nieobsługiwana wersja nagrania: ${header.version}`);
  const events: CastEvent[] = [];
  for (const line of lines.slice(1)) {
    try {
      const [time, type, data] = JSON.parse(line) as [number, string, string];
      if (typeof time === "number" && typeof data === "string") events.push({ time, type, data });
    } catch {
      // A truncated last line (app closed mid-write) is skipped.
    }
  }
  return { header, events, duration: events.length ? events[events.length - 1].time : 0 };
}

/** Caps pauses longer than `maxIdle` seconds (like `asciinema play -i`). */
export function compressIdle(cast: Cast, maxIdle: number): Cast {
  let shift = 0;
  let prev = 0;
  const events = cast.events.map((e) => {
    const gap = e.time - prev;
    if (gap > maxIdle) shift += gap - maxIdle;
    prev = e.time;
    return { ...e, time: e.time - shift };
  });
  return { ...cast, events, duration: events.length ? events[events.length - 1].time : 0 };
}

/** What the player needs from a terminal. */
export interface PlayerSink {
  reset(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

function parseSize(data: string): [number, number] | null {
  const m = /^(\d+)x(\d+)$/.exec(data);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/**
 * Drives a sink through a cast: play / pause / seek / speed. Time advances via `tick(dtSeconds)`
 * (the UI calls it from requestAnimationFrame), which keeps the logic deterministic in tests.
 */
export class CastPlayer {
  position = 0;
  playing = false;
  speed = 1;
  private next = 0; // index of the next event to apply

  constructor(
    private cast: Cast,
    private sink: PlayerSink,
  ) {
    this.seek(0);
  }

  get duration(): number {
    return this.cast.duration;
  }

  get ended(): boolean {
    return this.next >= this.cast.events.length;
  }

  private apply(e: CastEvent) {
    if (e.type === "o") this.sink.write(e.data);
    else if (e.type === "r") {
      const size = parseSize(e.data);
      if (size) this.sink.resize(size[0], size[1]);
    }
  }

  /** Jumps to `time` by replaying everything up to it (output batched into one write). */
  seek(time: number) {
    this.position = Math.max(0, Math.min(time, this.duration));
    this.sink.reset();
    this.sink.resize(this.cast.header.width, this.cast.header.height);
    let batch = "";
    let i = 0;
    for (; i < this.cast.events.length && this.cast.events[i].time <= this.position; i++) {
      const e = this.cast.events[i];
      if (e.type === "o") batch += e.data;
      else if (e.type === "r") {
        if (batch) this.sink.write(batch);
        batch = "";
        this.apply(e);
      }
    }
    if (batch) this.sink.write(batch);
    this.next = i;
  }

  play() {
    if (this.ended) this.seek(0);
    this.playing = true;
  }

  pause() {
    this.playing = false;
  }

  /** Advances playback by `dt` real seconds. */
  tick(dt: number) {
    if (!this.playing) return;
    this.position = Math.min(this.duration, this.position + dt * this.speed);
    while (!this.ended && this.cast.events[this.next].time <= this.position) {
      this.apply(this.cast.events[this.next++]);
    }
    if (this.ended) {
      this.position = this.duration;
      this.playing = false;
    }
  }
}

export function formatClock(seconds: number): string {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
