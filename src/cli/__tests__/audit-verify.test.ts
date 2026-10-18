import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuditLog, listAuditFiles } from "../../audit/audit-log.js";
import { MemorySecretStore } from "../../secrets/memory-store.js";
import { parseCliArgs } from "../args.js";
import { runCli, type CliDeps } from "../run.js";

describe("parseCliArgs: audit", () => {
  it("parses audit verify with and without a path", () => {
    expect(parseCliArgs(["audit", "verify"])).toEqual({ command: "audit-verify" });
    expect(parseCliArgs(["audit", "verify", "/backup/audit"])).toEqual({ command: "audit-verify", path: "/backup/audit" });
  });

  it.each([[["audit"]], [["audit", "purge"]], [["audit", "verify", "a", "b"]]])("rejects %j", (argv) => {
    const cmd = parseCliArgs(argv);
    expect(cmd.command).toBe("invalid");
    if (cmd.command === "invalid") expect(cmd.message.en).toMatch(/"audit" expects "verify/);
  });
});

describe("inbox-warden audit verify", () => {
  let home: string;
  let lines: string[];
  let deps: CliDeps;

  const record = (audit: AuditLog) =>
    audit.onToolCall({ tool: "move_email", accountId: "main", tier: "write", outcome: "success", durationMs: 1, details: { folder: "INBOX" } });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-cli-"));
    lines = [];
    deps = {
      env: { IMAP_MCP_HOME: home, IMAP_MCP_NO_AUTOCONFIG: "1" },
      locale: "en",
      print: (line) => lines.push(line),
      createSecrets: () => new MemorySecretStore(),
    };
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reports an empty log on a fresh machine (exit 0)", async () => {
    expect(await runCli(["audit", "verify"], deps)).toBe(0);
    expect(lines[0]).toBe(`No audit records found in ${path.join(home, "audit")}.`);
  });

  it("confirms an intact log and prints the head hash (exit 0)", async () => {
    await record(new AuditLog({ dir: path.join(home, "audit"), level: "standard", retentionDays: 365, includeReads: false }));
    expect(await runCli(["audit", "verify"], deps)).toBe(0);
    expect(lines.join("\n")).toMatch(/OK: the audit log is complete and unmodified/);
    expect(lines.join("\n")).toMatch(/Head hash: [0-9a-f]{64}/);
  });

  it("uses audit.path from the configuration", async () => {
    const custom = path.join(home, "elsewhere");
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        version: 2,
        accounts: [{ id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } }],
        audit: { path: custom },
      }),
    );
    await record(new AuditLog({ dir: custom, level: "standard", retentionDays: 365, includeReads: false }));
    expect(await runCli(["audit", "verify"], deps)).toBe(0);
    expect(lines.join("\n")).toMatch(/Checked 1 records/);
  });

  it("judges records removed by retention against the configured retention period", async () => {
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({
        version: 2,
        accounts: [{ id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } }],
        audit: { retentionDays: 30 },
      }),
    );
    let now = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const audit = new AuditLog({ dir: path.join(home, "audit"), level: "standard", retentionDays: 30, includeReads: false, now: () => now });
    await record(audit);
    now = new Date();
    await record(audit);
    expect(audit.cleanup()).toHaveLength(1);
    expect(await runCli(["audit", "verify"], deps)).toBe(0);
    expect(lines.join("\n")).toMatch(/retention policy \(30 days\)/);
  });

  it("returns 1 and lists the problem for a tampered log, in German when asked", async () => {
    const dir = path.join(home, "audit");
    await record(new AuditLog({ dir, level: "standard", retentionDays: 365, includeReads: false }));
    const file = path.join(dir, listAuditFiles(dir)[0]);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"INBOX"', '"Archive"'));
    expect(await runCli(["audit", "verify"], { ...deps, locale: "de" })).toBe(1);
    expect(lines.join("\n")).toMatch(/FEHLER: 1 Problem\(e\) gefunden/);
    expect(lines.join("\n")).toMatch(/hash mismatch/);
  });

  it("returns 2 for an explicit path that cannot be read", async () => {
    expect(await runCli(["audit", "verify", path.join(home, "missing")], deps)).toBe(2);
    expect(lines[0]).toMatch(/^Cannot read the audit log at/);
  });

  it("lists audit verify in the usage text", async () => {
    expect(await runCli(["help"], deps)).toBe(0);
    expect(lines.join("\n")).toContain("inbox-warden audit verify [<folder|file>]");
  });
});
