import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigSchema } from "../../config/schema.js";
import { AuditLog } from "../audit-log.js";
import { setupAudit } from "../setup.js";

const account = { id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } };

describe("setupAudit", () => {
  it("registers an AuditLog observer writing to the configured folder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-audit-"));
    const app = { config: ConfigSchema.parse({ version: 2, accounts: [account], audit: { path: dir } }), observers: [] as never[] };
    const log = setupAudit(app);
    expect(log).toBeInstanceOf(AuditLog);
    expect(app.observers).toContain(log);
    expect(log!.dir).toBe(dir);
  });

  it("does nothing when auditing is disabled", () => {
    const app = { config: ConfigSchema.parse({ version: 2, accounts: [account], audit: { enabled: false } }), observers: [] as never[] };
    expect(setupAudit(app)).toBeNull();
    expect(app.observers).toHaveLength(0);
  });
});
