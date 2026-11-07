import { describe, expect, it } from "vitest";
import { CastPlayer, compressIdle, formatClock, parseCast, type PlayerSink } from "./cast";

const castText = [
  JSON.stringify({ version: 2, width: 80, height: 24, title: "Claude Code · bash" }),
  JSON.stringify([0.5, "o", "$ claude\r\n"]),
  JSON.stringify([1.0, "o", "Thinking…\r\n"]),
  JSON.stringify([1.2, "r", "100x30"]),
  JSON.stringify([11.0, "o", "Done\r\n"]),
  '[12.0, "o", "trunc', // truncated last line
].join("\n");

class FakeSink implements PlayerSink {
  screen = "";
  size = "";
  log: string[] = [];
  reset() {
    this.screen = "";
    this.log.push("reset");
  }
  write(data: string) {
    this.screen += data;
    this.log.push(`write:${data.length}`);
  }
  resize(cols: number, rows: number) {
    this.size = `${cols}x${rows}`;
  }
}

describe("parseCast", () => {
  it("reads header and events, skipping a truncated line", () => {
    const cast = parseCast(castText);
    expect(cast.header).toMatchObject({ width: 80, height: 24, title: "Claude Code · bash" });
    expect(cast.events).toHaveLength(4);
    expect(cast.duration).toBe(11);
  });

  it("rejects other versions and empty files", () => {
    expect(() => parseCast('{"version":1}')).toThrow(/wersja/);
    expect(() => parseCast("")).toThrow();
  });

  it("compresses long pauses", () => {
    const cast = compressIdle(parseCast(castText), 2);
    expect(cast.events.map((e) => Math.round(e.time * 1000) / 1000)).toEqual([0.5, 1.0, 1.2, 3.2]);
    expect(cast.duration).toBeCloseTo(3.2);
  });
});

describe("CastPlayer", () => {
  it("plays events in time, applies resizes and stops at the end", () => {
    const sink = new FakeSink();
    const p = new CastPlayer(parseCast(castText), sink);
    expect(sink.size).toBe("80x24");
    p.play();
    p.tick(0.6);
    expect(sink.screen).toBe("$ claude\r\n");
    p.tick(0.7);
    expect(sink.screen).toContain("Thinking");
    expect(sink.size).toBe("100x30");
    p.speed = 10;
    p.tick(1);
    expect(sink.screen).toContain("Done");
    expect(p.playing).toBe(false);
    expect(p.position).toBe(11);
    p.play(); // from the end restarts
    expect(p.position).toBe(0);
    expect(sink.screen).toBe("");
  });

  it("seeks by replaying output in batches", () => {
    const sink = new FakeSink();
    const p = new CastPlayer(parseCast(castText), sink);
    sink.log = [];
    p.seek(1.1);
    expect(sink.screen).toBe("$ claude\r\nThinking…\r\n");
    expect(sink.log.filter((l) => l.startsWith("write"))).toHaveLength(1);
    p.seek(5);
    expect(sink.size).toBe("100x30");
    p.seek(-3);
    expect(p.position).toBe(0);
    p.seek(99);
    expect(p.position).toBe(11);
    expect(p.ended).toBe(true);
  });

  it("does not advance while paused", () => {
    const sink = new FakeSink();
    const p = new CastPlayer(parseCast(castText), sink);
    p.tick(5);
    expect(sink.screen).toBe("");
  });
});

describe("formatClock", () => {
  it("formats minutes and hours", () => {
    expect(formatClock(5.7)).toBe("0:05");
    expect(formatClock(125)).toBe("2:05");
    expect(formatClock(3725)).toBe("1:02:05");
  });
});
