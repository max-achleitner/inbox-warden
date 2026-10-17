import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RateLimitStateError, SendCounter } from "../rate-limit.js";

describe("SendCounter", () => {
  let dir: string;
  let file: string;
  let now: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-rate-"));
    file = path.join(dir, "send-counter-main.json");
    now = Date.UTC(2026, 9, 14, 12, 0, 0);
  });

  it("counts sends per hour and per day and persists them across instances", () => {
    const counter = new SendCounter(file, () => now);
    counter.reserve({ maxPerHour: 100, maxPerDay: 100 });
    now += 30 * 60 * 1000;
    counter.reserve({ maxPerHour: 100, maxPerDay: 100 });
    now += 45 * 60 * 1000; // first send is now 75 minutes old
    const fresh = new SendCounter(file, () => now);
    expect(fresh.counts()).toEqual({ lastHour: 1, lastDay: 2 });
  });

  it("drops entries older than a day when recording", () => {
    const counter = new SendCounter(file, () => now);
    counter.reserve({ maxPerHour: 100, maxPerDay: 100 });
    now += 25 * 60 * 60 * 1000;
    counter.reserve({ maxPerHour: 100, maxPerDay: 100 });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).sends).toHaveLength(1);
  });

  it("fails closed on a damaged counter file", () => {
    fs.writeFileSync(file, "{not json");
    expect(() => new SendCounter(file, () => now).counts()).toThrow(RateLimitStateError);
    fs.writeFileSync(file, JSON.stringify({ version: 1, sends: ["x"] }));
    expect(() => new SendCounter(file, () => now).counts()).toThrow(/damaged/);
  });

  it("still counts timestamps from the future (clock moved back)", () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, sends: [now + 10 * 60 * 1000] }));
    expect(new SendCounter(file, () => now).counts().lastHour).toBe(1);
  });

  it("reserves only while the limits allow and persists the reservation", () => {
    const counter = new SendCounter(file, () => now);
    expect(counter.reserve({ maxPerHour: 2, maxPerDay: 10 })).toMatchObject({ ok: true });
    expect(counter.reserve({ maxPerHour: 2, maxPerDay: 10 })).toMatchObject({ ok: true });
    expect(new SendCounter(file, () => now).reserve({ maxPerHour: 2, maxPerDay: 10 })).toEqual({ ok: false, exceeded: "hour" });
    expect(counter.reserve({ maxPerHour: 10, maxPerDay: 2 })).toEqual({ ok: false, exceeded: "day" });
  });

  it("release() frees exactly one reserved slot", () => {
    const counter = new SendCounter(file, () => now);
    const first = counter.reserve({ maxPerHour: 2, maxPerDay: 10 });
    counter.reserve({ maxPerHour: 2, maxPerDay: 10 });
    if (!first.ok) throw new Error("expected a reservation");
    counter.release(first.at);
    expect(counter.counts().lastHour).toBe(1);
  });

  it("waits for another process holding the lock and fails closed when it never lets go", () => {
    fs.writeFileSync(`${file}.lock`, "");
    expect(() => new SendCounter(file, () => now, 50).reserve({ maxPerHour: 100, maxPerDay: 100 })).toThrow(/Timed out waiting for the send counter lock/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("leaves no temp files behind", () => {
    new SendCounter(file, () => now).reserve({ maxPerHour: 100, maxPerDay: 100 });
    expect(fs.readdirSync(dir)).toEqual(["send-counter-main.json"]);
  });
});
