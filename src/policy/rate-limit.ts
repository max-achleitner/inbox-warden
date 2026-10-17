import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { withFileLock } from "../file-lock.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export class RateLimitStateError extends Error {
  constructor(file: string) {
    super(
      `The send counter file "${file}" is damaged, so sending is paused for safety. ` +
        "Delete the file to reset the counter (an administrator should check why it was damaged).",
    );
    this.name = "RateLimitStateError";
  }
}

/** Write via temp file + rename so a crash never leaves a half-written file. */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface SendLimits {
  maxPerHour: number;
  maxPerDay: number;
}

export type SendReservation = { ok: true; at: number } | { ok: false; exceeded: "hour" | "day" };

/**
 * Send timestamps of the last 24 hours, persisted per account so limits survive restarts
 * and are shared by every server process using the same config directory. Updates run under
 * a cross-process lock, so parallel sends cannot both take the last free slot.
 */
export class SendCounter {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
    private readonly lockTimeoutMs = 2_000,
  ) {}

  private locked<T>(fn: () => T): T {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    return withFileLock(`${this.file}.lock`, this.lockTimeoutMs, fn, `the send counter lock "${this.file}.lock"`);
  }

  private read(): number[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RateLimitStateError(this.file);
    }
    const sends = (parsed as { sends?: unknown } | null)?.sends;
    if (!Array.isArray(sends) || !sends.every((t) => typeof t === "number" && Number.isFinite(t))) {
      throw new RateLimitStateError(this.file);
    }
    return sends as number[];
  }

  /** Timestamps in the future (clock moved back) still count — fail closed. */
  private countsOf(sends: number[], now: number): { lastHour: number; lastDay: number } {
    return {
      lastHour: sends.filter((t) => t > now - HOUR_MS).length,
      lastDay: sends.filter((t) => t > now - DAY_MS).length,
    };
  }

  counts(): { lastHour: number; lastDay: number } {
    return this.countsOf(this.read(), this.now());
  }

  /** Check the limits and count one send in a single locked step. Call release() if the send then fails. */
  reserve(limits: SendLimits): SendReservation {
    return this.locked(() => {
      const now = this.now();
      const sends = this.read().filter((t) => t > now - DAY_MS);
      const counts = this.countsOf(sends, now);
      if (counts.lastHour >= limits.maxPerHour) return { ok: false, exceeded: "hour" };
      if (counts.lastDay >= limits.maxPerDay) return { ok: false, exceeded: "day" };
      sends.push(now);
      writeFileAtomic(this.file, JSON.stringify({ version: 1, sends }));
      return { ok: true, at: now };
    });
  }

  /** Undo one reservation (the send did not happen). */
  release(at: number): void {
    this.locked(() => {
      const sends = this.read();
      const index = sends.indexOf(at);
      if (index < 0) return;
      sends.splice(index, 1);
      writeFileAtomic(this.file, JSON.stringify({ version: 1, sends }));
    });
  }
}
