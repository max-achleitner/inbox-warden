import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuditLog, GENESIS_HASH, listAuditFiles, verifyAuditLog, type AuditRecord } from "../audit-log.js";
import type { ToolCallEvent } from "../../context.js";

function event(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    tool: "move_email",
    accountId: "main",
    tier: "write",
    outcome: "success",
    durationMs: 12,
    details: { folder: "INBOX", destination: "Archive", uids: [1, 2] },
    ...overrides,
  };
}

function readRecords(dir: string): AuditRecord[] {
  return listAuditFiles(dir).flatMap((f) =>
    fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditRecord),
  );
}

describe("AuditLog", () => {
  let dir: string;
  let now: Date;
  const options = () => ({ dir, level: "standard" as const, retentionDays: 365, includeReads: false, now: () => now });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-audit-"));
    now = new Date("2026-10-14T10:00:00Z");
  });

  it("writes a hash chain starting at the genesis hash", async () => {
    const audit = new AuditLog(options());
    await audit.onToolCall(event());
    await audit.onToolCall(event({ tool: "send_email", tier: "send", details: { recipients: ["a@x.com"], subject: "Hi" } }));
    const [first, second] = readRecords(dir);
    expect(first.prevHash).toBe(GENESIS_HASH);
    expect(second.prevHash).toBe(first.hash);
    expect(second.seq).toBe(2);
    expect(verifyAuditLog(dir)).toMatchObject({ ok: true, records: 2, anchored: false });
  });

  it("detects an edited record and a deleted record", async () => {
    const audit = new AuditLog(options());
    for (let i = 0; i < 3; i++) await audit.onToolCall(event());
    const file = path.join(dir, listAuditFiles(dir)[0]);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

    fs.writeFileSync(file, [lines[0], lines[1].replace('"Archive"', '"Trash"'), lines[2]].join("\n") + "\n");
    expect(verifyAuditLog(dir).problems.map((p) => p.problem)).toContain("record was modified (hash mismatch)");

    fs.writeFileSync(file, [lines[0], lines[2]].join("\n") + "\n");
    const result = verifyAuditLog(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.problem.startsWith("chain broken"))).toBe(true);
  });

  it("keeps one linear chain when two server processes append alternately", async () => {
    const desktop = new AuditLog(options());
    const claudeCode = new AuditLog(options());
    for (let i = 0; i < 5; i++) {
      await desktop.onToolCall(event({ accountId: "desktop" }));
      await claudeCode.onToolCall(event({ accountId: "code" }));
    }
    const result = verifyAuditLog(dir);
    expect(result).toMatchObject({ ok: true, records: 10, lastSeq: 10 });
  });

  it("continues the chain across monthly files", async () => {
    const audit = new AuditLog(options());
    await audit.onToolCall(event());
    now = new Date("2026-11-02T08:00:00Z");
    await audit.onToolCall(event());
    expect(listAuditFiles(dir)).toEqual(["audit-2026-10.jsonl", "audit-2026-11.jsonl"]);
    expect(verifyAuditLog(dir)).toMatchObject({ ok: true, records: 2 });
  });

  it("keeps auditing after a record was cut off by a crash, and leaves the damage visible", async () => {
    const audit = new AuditLog(options());
    await audit.onToolCall(event());
    const file = path.join(dir, listAuditFiles(dir)[0]);
    fs.appendFileSync(file, '{"ts":"2026-10-14T10:00:01.000Z","seq":2,"prevHa'); // power loss mid-write
    await audit.onToolCall(event({ tool: "delete_email", tier: "delete" }));
    expect(audit.lastError).toBeNull();

    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    const [first, , recovery, entry] = [lines[0], lines[1], lines[2], lines[3]].map((l, i) => (i === 1 ? undefined : (JSON.parse(l) as AuditRecord)));
    expect(recovery).toMatchObject({ tool: "audit.recovery", seq: 2, prevHash: first!.hash });
    expect(entry).toMatchObject({ tool: "delete_email", seq: 3, prevHash: recovery!.hash });
    expect(verifyAuditLog(dir).problems).toEqual([{ file: listAuditFiles(dir)[0], line: 2, problem: "not valid JSON" }]);
  });

  it("finds the chain head in the previous month when the new month's file holds only a cut-off record", async () => {
    const audit = new AuditLog(options());
    await audit.onToolCall(event());
    fs.writeFileSync(path.join(dir, "audit-2026-11.jsonl"), '{"ts":"2026-11-01');
    now = new Date("2026-11-02T08:00:00Z");
    await audit.onToolCall(event());
    const head = JSON.parse(fs.readFileSync(path.join(dir, "audit-2026-10.jsonl"), "utf8").trim()) as AuditRecord;
    const tail = fs.readFileSync(path.join(dir, "audit-2026-11.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(JSON.parse(tail[1])).toMatchObject({ tool: "audit.recovery", seq: 2, prevHash: head.hash });
  });

  it("records reads only when they carry an injection finding, a denial or includeReads", async () => {
    const audit = new AuditLog(options());
    await audit.onToolCall(event({ tool: "read_email", tier: "read", details: { injectionRisk: "none" } }));
    await audit.onToolCall(event({ tool: "read_email", tier: "read", details: { injectionRisk: "high" } }));
    await audit.onToolCall(event({ tool: "search_emails", tier: "read", outcome: "denied", details: {} }));
    expect(readRecords(dir).map((r) => r.tool)).toEqual(["read_email", "search_emails"]);
  });

  it("minimal level drops subjects and reduces recipients to count + domains; content never stored", async () => {
    const audit = new AuditLog({ ...options(), level: "minimal" });
    await audit.onToolCall(
      event({
        tool: "send_email",
        tier: "send",
        details: { subject: "Gehaltsliste", recipients: ["a@x.com", "b@y.org"], body: "secret text", password: "pw" },
      }),
    );
    const [record] = readRecords(dir);
    expect(record.details).toEqual({ recipientsCount: 2, recipientsDomains: ["x.com", "y.org"], password: "[REDACTED]" });
  });

  it("retention removes old month files, keeps the head and leaves a verifiable anchored chain", async () => {
    now = new Date("2025-01-10T10:00:00Z");
    const audit = new AuditLog({ ...options(), retentionDays: 30 });
    await audit.onToolCall(event());
    now = new Date("2026-10-14T10:00:00Z");
    await audit.onToolCall(event());
    expect(audit.cleanup()).toEqual(["audit-2025-01.jsonl"]);
    const result = verifyAuditLog(dir);
    expect(result).toMatchObject({ ok: true, anchored: true });
    expect(readRecords(dir).at(-1)!.tool).toBe("audit.retention");
  });

  it("detects the oldest records deleted without a retention record", async () => {
    const audit = new AuditLog(options());
    for (let i = 0; i < 4; i++) await audit.onToolCall(event());
    const file = path.join(dir, listAuditFiles(dir)[0]);
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(file, lines.slice(2).join("\n") + "\n"); // drop seq 1 and 2
    const result = verifyAuditLog(dir);
    expect(result.ok).toBe(false);
    expect(result.anchored).toBe(false);
    expect(result.problems.map((p) => p.problem).join(" ")).toMatch(/starts at record 3.*no retention record/);
  });

  it("detects a whole oldest month file deleted by hand", async () => {
    now = new Date("2026-08-10T10:00:00Z");
    const audit = new AuditLog(options());
    await audit.onToolCall(event());
    now = new Date("2026-10-14T10:00:00Z");
    await audit.onToolCall(event());
    fs.rmSync(path.join(dir, "audit-2026-08.jsonl"));
    expect(verifyAuditLog(dir).ok).toBe(false);
  });

  it("accepts a chain shortened by retention several times", async () => {
    now = new Date("2025-01-10T10:00:00Z");
    const audit = new AuditLog({ ...options(), retentionDays: 30 });
    await audit.onToolCall(event());
    now = new Date("2025-03-10T10:00:00Z");
    await audit.onToolCall(event());
    expect(audit.cleanup()).toEqual(["audit-2025-01.jsonl"]);
    now = new Date("2026-10-14T10:00:00Z");
    await audit.onToolCall(event());
    expect(audit.cleanup()).toEqual(["audit-2025-03.jsonl"]);
    expect(verifyAuditLog(dir)).toMatchObject({ ok: true, anchored: true });
  });

  it("ensureWritable fails with a plain message when the folder cannot be created", () => {
    const blocker = path.join(dir, "file");
    fs.writeFileSync(blocker, "x");
    const audit = new AuditLog({ ...options(), dir: path.join(blocker, "audit") });
    expect(() => audit.ensureWritable()).toThrow(/not writable/);
  });
});
