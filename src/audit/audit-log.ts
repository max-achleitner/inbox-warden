import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ToolCallEvent, ToolObserver } from "../context.js";
import { errorMessage } from "../errors.js";
import { withFileLock } from "../file-lock.js";
import * as log from "../logging/logger.js";
import { redactString } from "../logging/redact.js";
import { canonicalJson } from "./canonical.js";
import { sanitizeDetails, withoutLocalParts, type AuditLevel } from "./redact.js";
import { DEFAULT_RETENTION_DAYS } from "./schema.js";

export const GENESIS_HASH = "0".repeat(64);
const FILE_PATTERN = /^audit-(\d{4})-(\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AuditRecord {
  ts: string;
  seq: number;
  prevHash: string;
  /**
   * Time of the previous record. Hashed with this one, so after retention the oldest remaining
   * record proves how old the removed ones were. Missing in records written before 0.6.1.
   */
  prevTs?: string;
  hash: string;
  account: string;
  tool: string;
  tier: string;
  outcome: string;
  durationMs?: number;
  details: Record<string, unknown>;
  error?: string;
}

export type AuditEntry = Omit<AuditRecord, "ts" | "seq" | "prevHash" | "hash">;

export interface AuditLogOptions {
  dir: string;
  level: AuditLevel;
  retentionDays: number;
  includeReads: boolean;
  now?: () => Date;
  lockTimeoutMs?: number;
}

export function hashRecord(record: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}

export function auditFileName(date: Date): string {
  return `audit-${date.toISOString().slice(0, 7)}.jsonl`;
}

export function listAuditFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => FILE_PATTERN.test(f)).sort();
}

interface FileTail {
  /** The newest intact record. */
  head: AuditRecord | null;
  /** Something that is not a record follows it: a write cut off by a crash or power loss. */
  damaged: boolean;
  /** The file does not end with a newline, so the next record must start on a new line. */
  unterminated: boolean;
}

function parseRecord(line: string): AuditRecord | null {
  try {
    const record = JSON.parse(line) as AuditRecord;
    return typeof record?.hash === "string" && typeof record.seq === "number" ? record : null;
  } catch {
    return null;
  }
}

/** Reads the last 64 KiB, or the whole file when no intact record ends in that window. */
function readTail(file: string): FileTail {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { head: null, damaged: false, unterminated: false };
    for (let length = Math.min(size, 65_536); ; length = size) {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      const unterminated = buf[length - 1] !== 0x0a;
      const lines = buf.toString("utf8").split("\n").filter((l) => l.trim() !== "");
      for (let i = lines.length - 1; i >= 0; i--) {
        const head = parseRecord(lines[i]);
        if (head) return { head, damaged: i < lines.length - 1, unterminated };
      }
      if (length === size) return { head: null, damaged: lines.length > 0, unterminated };
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Cross-process lock (Claude Desktop and Claude Code may run the server at the same time). */
function withLock<T>(dir: string, timeoutMs: number, fn: () => T): T {
  const lock = path.join(dir, ".audit.lock");
  return withFileLock(lock, timeoutMs, fn, `the audit log lock "${lock}"`);
}

/**
 * Append-only, hash-chained JSONL audit log (one file per month).
 * Each record carries the SHA-256 of its predecessor, so deleting or editing a record
 * breaks the chain and is reported by verifyAuditLog().
 */
export class AuditLog implements ToolObserver {
  readonly dir: string;
  private readonly level: AuditLevel;
  private readonly retentionDays: number;
  private readonly includeReads: boolean;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;
  lastError: string | null = null;

  constructor(options: AuditLogOptions) {
    this.dir = options.dir;
    this.level = options.level;
    this.retentionDays = options.retentionDays;
    this.includeReads = options.includeReads;
    this.now = options.now ?? (() => new Date());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
  }

  /** Fail closed at startup: a server that cannot audit must not start. */
  ensureWritable(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      withLock(this.dir, this.lockTimeoutMs, () => undefined);
    } catch (err) {
      throw new Error(`The audit log folder "${this.dir}" is not writable: ${errorMessage(err)}`);
    }
  }

  append(entry: AuditEntry): AuditRecord {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    return withLock(this.dir, this.lockTimeoutMs, () => {
      const files = listAuditFiles(this.dir);
      const lastFile = files[files.length - 1];
      const tail = lastFile ? readTail(path.join(this.dir, lastFile)) : undefined;
      let head = tail?.head ?? null;
      // A month file that holds only a cut-off record: the chain continues from an older file
      for (let i = files.length - 2; i >= 0 && !head; i--) head = readTail(path.join(this.dir, files[i])).head;

      const now = this.now();
      // Never write into an older file than the newest one (clock skew would reorder the chain)
      const target = lastFile && lastFile > auditFileName(now) ? lastFile : auditFileName(now);
      if (tail?.unterminated) fs.appendFileSync(path.join(this.dir, lastFile!), "\n");
      if (tail?.damaged) {
        // The cut-off line stays as evidence (audit verify reports it); the chain continues from the last intact record
        log.warn("audit.recovered_cut_off_record", { file: lastFile });
        head = this.write(target, now, head, {
          account: "-",
          tool: "audit.recovery",
          tier: "always",
          outcome: "success",
          details: { reason: "The previous record was cut off (crash or power loss while writing).", file: lastFile },
        });
      }
      return this.write(target, now, head, entry);
    });
  }

  private write(file: string, now: Date, prev: AuditRecord | null, entry: AuditEntry): AuditRecord {
    const unsigned: Omit<AuditRecord, "hash"> = {
      ts: now.toISOString(),
      seq: (prev?.seq ?? 0) + 1,
      prevHash: prev?.hash ?? GENESIS_HASH,
      ...(prev ? { prevTs: prev.ts } : {}),
      account: entry.account,
      tool: entry.tool,
      tier: entry.tier,
      outcome: entry.outcome,
      ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
      details: entry.details,
      ...(entry.error ? { error: entry.error } : {}),
    };
    const record: AuditRecord = { ...unsigned, hash: hashRecord(unsigned) };
    fs.appendFileSync(path.join(this.dir, file), JSON.stringify(record) + "\n", { mode: 0o600 });
    return record;
  }

  private shouldRecord(event: ToolCallEvent): boolean {
    if (event.tier === "write" || event.tier === "send" || event.tier === "delete") return true;
    if (event.outcome === "denied") return true;
    const risk = event.details.injectionRisk;
    if (risk === "medium" || risk === "high" || risk === "critical") return true;
    return this.includeReads;
  }

  /** Credentials removed; at level minimal also every local part (refusals name recipients). Cut after reducing. */
  private errorText(error: string): string {
    const redacted = redactString(error);
    return (this.level === "minimal" ? withoutLocalParts(redacted) : redacted).slice(0, 500);
  }

  async onToolCall(event: ToolCallEvent): Promise<void> {
    if (!this.shouldRecord(event)) return;
    try {
      this.append({
        account: event.accountId,
        tool: event.tool,
        tier: event.tier,
        outcome: event.outcome,
        durationMs: event.durationMs,
        details: sanitizeDetails(event.details, this.level),
        ...(event.error ? { error: this.errorText(event.error) } : {}),
      });
      this.lastError = null;
    } catch (err) {
      this.lastError = errorMessage(err);
      log.error("audit.write_failed", { tool: event.tool }, err);
    }
  }

  /** Delete month files older than the retention period; the chain head is never deleted. */
  cleanup(): string[] {
    const cutoff = this.now().getTime() - this.retentionDays * DAY_MS;
    const removed: string[] = [];
    for (const file of listAuditFiles(this.dir)) {
      const files = listAuditFiles(this.dir);
      if (file === files[files.length - 1]) break;
      const [, year, month] = FILE_PATTERN.exec(file)!;
      const monthEnd = Date.UTC(Number(year), Number(month), 1);
      if (monthEnd >= cutoff) continue;
      const last = readTail(path.join(this.dir, file)).head ?? undefined;
      this.append({
        account: "-",
        tool: "audit.retention",
        tier: "always",
        outcome: "success",
        details: { removedFile: file, removedLastSeq: last?.seq, removedLastHash: last?.hash },
      });
      fs.rmSync(path.join(this.dir, file));
      removed.push(file);
    }
    return removed;
  }
}

export interface AuditProblem {
  file: string;
  line: number;
  problem: string;
}

export interface AuditVerification {
  ok: boolean;
  files: string[];
  records: number;
  firstSeq?: number;
  lastSeq?: number;
  headHash?: string;
  /**
   * True when the oldest record does not start at the genesis hash because retention removed older
   * files. For a folder this is only accepted when an audit.retention record in the chain names
   * exactly the removed predecessor; otherwise the missing start is reported as a problem.
   */
  anchored: boolean;
  problems: AuditProblem[];
}

export interface VerifyOptions {
  /** audit.retentionDays of the configuration that wrote the log. */
  retentionDays?: number;
  now?: () => Date;
}

/**
 * Why the records before `first` cannot have been removed by retention, if they cannot. A
 * retention record must name the removed predecessor; since anyone who can write the folder can
 * chain such a record, the predecessor's time hashed into `first` must also lie beyond the
 * retention period.
 */
function missingStartProblem(first: AuditRecord, retentions: AuditRecord[], options: VerifyOptions): string | undefined {
  const named = retentions.some((r) => r.details.removedLastSeq === first.seq - 1 && r.details.removedLastHash === first.prevHash);
  if (!named) return `the log starts at record ${first.seq}, but no retention record explains the missing older records (deleted by hand?)`;
  if (first.prevTs === undefined) return undefined; // written before 0.6.1, which did not record it
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoff = (options.now ?? (() => new Date()))().getTime() - retentionDays * DAY_MS;
  if (Date.parse(first.prevTs) <= cutoff) return undefined;
  return (
    `the records before record ${first.seq} are missing, but the newest of them (${first.prevTs}) is newer than ` +
    `the retention period of ${retentionDays} days, so retention did not remove them (deleted by hand?)`
  );
}

/** Verify a single audit file or a whole audit folder. */
export function verifyAuditLog(target: string, options: VerifyOptions = {}): AuditVerification {
  const isDir = fs.statSync(target).isDirectory();
  const dir = isDir ? target : path.dirname(target);
  const files = isDir ? listAuditFiles(target) : [path.basename(target)];
  const problems: AuditProblem[] = [];
  let prev: AuditRecord | undefined;
  let first: { record: AuditRecord; file: string; line: number } | undefined;
  const retentions: AuditRecord[] = [];
  let records = 0;
  let firstSeq: number | undefined;
  let anchored = false;

  for (const file of files) {
    const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
    lines.forEach((text, index) => {
      if (text.trim() === "") return;
      const line = index + 1;
      let record: AuditRecord;
      try {
        record = JSON.parse(text) as AuditRecord;
      } catch {
        problems.push({ file, line, problem: "not valid JSON" });
        return;
      }
      const { hash, ...unsigned } = record;
      if (hashRecord(unsigned) !== hash) problems.push({ file, line, problem: "record was modified (hash mismatch)" });
      if (prev) {
        if (record.prevHash !== prev.hash) problems.push({ file, line, problem: "chain broken: prevHash does not match the previous record" });
        if (record.seq !== prev.seq + 1) {
          problems.push({ file, line, problem: `sequence jumps from ${prev.seq} to ${record.seq} (records missing or reordered)` });
        }
      } else {
        firstSeq = record.seq;
        anchored = record.prevHash !== GENESIS_HASH;
        first = { record, file, line };
      }
      if (record.tool === "audit.retention") retentions.push(record);
      prev = record;
      records++;
    });
  }
  // A single month file legitimately continues an older one; a whole folder must start at genesis
  // or at a predecessor that retention removed and recorded.
  const startProblem = isDir && first && anchored ? missingStartProblem(first.record, retentions, options) : undefined;
  if (first && startProblem) {
    anchored = false;
    problems.push({ file: first.file, line: first.line, problem: startProblem });
  }
  return {
    ok: problems.length === 0,
    files,
    records,
    firstSeq,
    lastSeq: prev?.seq,
    headHash: prev?.hash,
    anchored,
    problems,
  };
}
