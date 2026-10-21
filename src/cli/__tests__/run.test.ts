import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MemorySecretStore } from "../../secrets/memory-store.js";
import { runCli, loadEffectiveConfig, type CliDeps } from "../run.js";

describe("runCli", () => {
  let home: string;
  let lines: string[];
  let deps: CliDeps;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-cli-"));
    lines = [];
    deps = {
      env: { IMAP_MCP_HOME: home, IMAP_MCP_NO_AUTOCONFIG: "1" },
      locale: "en",
      print: (l) => lines.push(l),
      createSecrets: () => new MemorySecretStore(),
    };
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ version: 2, accounts: [{ id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } }] }),
    );
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("prints the usage for help (exit 0) and for unknown input (exit 2)", async () => {
    expect(await runCli(["--help"], deps)).toBe(0);
    expect(lines.join("\n")).toContain("accounts login <id> [--device-code | --no-browser [--listen-host <host>] [--port <n>]]");
    lines.length = 0;
    expect(await runCli(["accounts", "login", "main", "--port", "1"], deps)).toBe(2);
    expect(lines[0]).toBe("--listen-host and --port only work together with --no-browser.");
    expect(lines[1]).toMatch(/^Usage:/);
  });

  it("dispatches accounts login and refuses a password mailbox without opening anything", async () => {
    expect(await runCli(["accounts", "login", "main"], deps)).toBe(1);
    expect(lines.at(-1)).toMatch(/signs in with a password/);
  });

  it("edits an account in the config file", async () => {
    expect(await runCli(["accounts", "edit", "main", "--allow", "send", "--max-messages", "1000"], deps)).toBe(0);
    const saved = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    expect(saved.accounts[0].permissions.send).toBe(true);
    expect(saved.accounts[0].policy.bulk.maxMessages).toBe(1000);
    expect(lines.join("\n")).toMatch(/send: off → on/);
    expect(await runCli(["--help"], deps)).toBe(0);
    expect(lines.join("\n")).toContain("accounts edit <id>");
  });

  it("lists the accounts of the config file", async () => {
    expect(await runCli(["accounts", "list"], deps)).toBe(0);
    expect(lines[0]).toMatch(/main\s+max@firma.example\s+mail\.firma.example\s+password\s+read\+write/);
  });

  it("locks and unlocks folders in the config file and lists them", async () => {
    expect(await runCli(["accounts", "edit", "main", "--lock-folder", "_NDA_Inbox", "--lock-folder", "_NDA_*"], deps)).toBe(0);
    const saved = () => JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    expect(saved().accounts[0].policy.folders.deny).toEqual(["_NDA_Inbox", "_NDA_*"]);
    lines.length = 0;
    expect(await runCli(["accounts", "list"], deps)).toBe(0);
    expect(lines[0]).toMatch(/locked folders: _NDA_Inbox, _NDA_\*$/);

    const before = fs.readFileSync(path.join(home, "config.json"), "utf8");
    expect(await runCli(["accounts", "edit", "main", "--unlock-folder", "Projekt"], deps)).toBe(1);
    expect(fs.readFileSync(path.join(home, "config.json"), "utf8")).toBe(before);
    expect(await runCli(["accounts", "edit", "main", "--unlock-folder", "_NDA_*"], deps)).toBe(0);
    expect(saved().accounts[0].policy.folders.deny).toEqual(["_NDA_Inbox"]);
  });

  it("lists the folders locked through IMAP_MCP_DENY_FOLDERS in environment-only mode", async () => {
    const envDeps = {
      ...deps,
      env: { ...deps.env, IMAP_MCP_EMAIL: "office@firma.at", IMAP_MCP_IMAP_HOST: "imap.firma.at", IMAP_MCP_DENY_FOLDERS: "_NDA_Inbox" },
    };
    expect(await runCli(["accounts", "list"], envDeps)).toBe(0);
    expect(lines[0]).toMatch(/office@firma\.at.*locked folders: _NDA_Inbox$/);
  });

  it("speaks German when asked", async () => {
    expect(await runCli(["frobnicate"], { ...deps, locale: "de" })).toBe(2);
    expect(lines[0]).toBe("Unbekannter Befehl: frobnicate");
    expect(lines[1]).toMatch(/^Verwendung:/);
  });

  it("keeps the built-in provider table for doctor and login when lookups are off", async () => {
    fs.rmSync(path.join(home, "config.json"));
    const config = await loadEffectiveConfig(
      { IMAP_MCP_HOME: home, IMAP_MCP_EMAIL: "a@gmail.com", IMAP_MCP_PASSWORD: "x", IMAP_MCP_NO_AUTOCONFIG: "1" },
      new MemorySecretStore(),
    );
    expect(config.accounts[0]!.imap.host).toBe("imap.gmail.com");
  });
});
