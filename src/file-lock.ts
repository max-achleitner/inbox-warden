import * as fs from "node:fs";

/** A lock file older than this belongs to a crashed process and is taken over. */
const STALE_LOCK_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Cross-process lock via an exclusively created lock file (Claude Desktop and Claude Code may run
 * the server at the same time). Synchronous, so it also serialises callers within one process.
 */
export function withFileLock<T>(lockFile: string, timeoutMs: number, fn: () => T, description = `the lock "${lockFile}"`): T {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lockFile, "wx", 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}.`);
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}
