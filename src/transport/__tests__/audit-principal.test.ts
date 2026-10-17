import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuditLog } from "../../audit/audit-log.js";
import { fakeApp } from "./fake-app.js";
import { scopeAppContext, type Principal } from "../auth/principals.js";

const principal: Principal = { kind: "bearer", id: "token:routine", tokenId: "routine", groups: [], scopes: [] };

function records(dir: string): Array<{ tool: string; details: Record<string, unknown> }> {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n"))
    .map((line) => JSON.parse(line));
}

describe("audit trail in HTTP mode", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "imcp-audit-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(["standard", "minimal"] as const)("Plan 5's AuditLog keeps the caller (%s level)", async (level) => {
    const app = fakeApp(["office"]);
    const log = new AuditLog({ dir, level, retentionDays: 365, includeReads: false });
    log.ensureWritable();
    app.observers.push(log);

    const view = scopeAppContext(app, principal, ["office"]);
    for (const observer of view.observers) {
      await observer.onToolCall({ tool: "move_email", accountId: "office", tier: "write", outcome: "success", durationMs: 4, details: { folder: "INBOX", uids: [1] } });
    }

    const [record] = records(dir);
    expect(record.tool).toBe("move_email");
    expect(record.details).toMatchObject({ folder: "INBOX", principal: "token:routine", principalKind: "bearer" });
  });
});
