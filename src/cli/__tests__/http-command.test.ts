import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AppConfig } from "../../config/schema.js";
import { hashToken } from "../../transport/auth/bearer.js";
import { runHttpCli, runHttpCommand, type HttpCommandDeps } from "../http-command.js";

function harness(initial: Record<string, unknown> = {}) {
  let config = {
    accounts: [{ id: "main", email: "max@firma.example", permissions: { read: true, write: true, send: false, delete: false } }],
    ...initial,
  } as unknown as AppConfig;
  const out: string[] = [];
  const err: string[] = [];
  let saves = 0;
  const deps: HttpCommandDeps = {
    loadConfig: async () => structuredClone(config),
    saveConfig: async (c) => {
      config = c;
      saves++;
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, out, err, get config() { return config; }, get saves() { return saves; } };
}

describe("http token create", () => {
  it("stores only the hash and prints the token once with a Claude Code command", async () => {
    const h = harness({ http: { publicUrl: "https://mail.example.com" } });
    expect(await runHttpCommand(["token", "create", "--id", "laptop"], h.deps)).toBe(0);
    const token = h.out.find((l) => l.trim().startsWith("imcp_"))!.trim();
    expect(h.config.httpAuth).toEqual({ mode: "bearer", tokens: [{ id: "laptop", sha256: hashToken(token) }], principals: [] });
    expect(JSON.stringify(h.config)).not.toContain(token);
    expect(h.out.join("\n")).toContain(`claude mcp add --transport http mail https://mail.example.com/mcp --header "Authorization: Bearer ${token}"`);
  });

  it("--print-only leaves a read-only config untouched and prints the entry", async () => {
    const h = harness();
    expect(await runHttpCommand(["token", "create", "--id", "routine", "--print-only"], h.deps)).toBe(0);
    expect(h.saves).toBe(0);
    expect(h.out.join("\n")).toMatch(/"id":"routine","sha256":"[0-9a-f]{64}"/);
  });

  it("rejects duplicate and invalid ids", async () => {
    const h = harness();
    await runHttpCommand(["token", "create", "--id", "laptop"], h.deps);
    expect(await runHttpCommand(["token", "create", "--id", "laptop"], h.deps)).toBe(1);
    expect(await runHttpCommand(["token", "create", "--id", "Bad Id"], h.deps)).toBe(2);
  });

  it("refuses to save into the environment-only configuration, so config.json is not overwritten", async () => {
    const h = harness();
    h.deps.envOnly = true;
    expect(await runHttpCommand(["token", "create", "--id", "laptop"], h.deps)).toBe(2);
    expect(h.saves).toBe(0);
    expect(h.err.join(" ")).toMatch(/IMAP_MCP_EMAIL.*Nothing was saved/s);
    expect(await runHttpCommand(["token", "create", "--id", "laptop", "--print-only"], h.deps)).toBe(0);
    expect(h.saves).toBe(0);
  });

  it("refuses to mix bearer tokens into an OAuth configuration", async () => {
    const h = harness({ httpAuth: { mode: "oauth" } });
    expect(await runHttpCommand(["token", "create", "--id", "x"], h.deps)).toBe(2);
    expect(h.err[0]).toMatch(/oauth/);
  });
});

describe("http token list / revoke", () => {
  it("lists ids with a hash prefix and revokes by id, keeping principals", async () => {
    const h = harness({
      httpAuth: {
        mode: "bearer",
        tokens: [{ id: "a", sha256: "1".repeat(64) }, { id: "b", sha256: "2".repeat(64) }],
        principals: [{ match: { tokenId: "b" }, accounts: ["main"] }],
      },
    });
    await runHttpCommand(["token", "list"], h.deps);
    expect(h.out).toEqual(["a  sha256:111111111111…", "b  sha256:222222222222…"]);
    expect(await runHttpCommand(["token", "revoke", "--id", "a"], h.deps)).toBe(0);
    expect(h.out.at(-1)).toMatch(/Restart the server.*still works/);
    expect(h.out.at(-1)).not.toMatch(/reload/);
    expect(h.config.httpAuth).toEqual({ mode: "bearer", tokens: [{ id: "b", sha256: "2".repeat(64) }], principals: [{ match: { tokenId: "b" }, accounts: ["main"] }] });
    expect(await runHttpCommand(["token", "revoke", "--id", "zzz"], h.deps)).toBe(1);
  });

  it("prints usage for unknown subcommands", async () => {
    const h = harness();
    expect(await runHttpCommand(["tokens"], h.deps)).toBe(2);
    expect(h.err[0]).toMatch(/Usage/);
  });
});

describe("runHttpCli", () => {
  it("leaves a multi-account config.json untouched while IMAP_MCP_EMAIL selects the environment-only configuration", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-home-"));
    const file = path.join(home, "config.json");
    const accounts = ["a", "b"].map((id) => ({ id, email: `${id}@example.com`, imap: { host: "imap.example.com", port: 993 } }));
    fs.writeFileSync(file, JSON.stringify({ version: 2, accounts }));
    const before = fs.readFileSync(file, "utf8");
    const env = {
      IMAP_MCP_HOME: home,
      IMAP_MCP_CONTAINER: "1",
      IMAP_MCP_EMAIL: "env@example.com",
      IMAP_MCP_IMAP_HOST: "imap.example.com",
    };
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await runHttpCli(["token", "create", "--id", "laptop"], env)).toBe(2);
    } finally {
      process.stderr.write = stderr;
    }
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
