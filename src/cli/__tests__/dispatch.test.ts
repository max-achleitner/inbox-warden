import { describe, it, expect } from "vitest";
import { UnknownCommandError, helpText, legacyInvocation, parseCommand } from "../dispatch.js";

describe("parseCommand", () => {
  it("starts the server when called without arguments (how MCP clients launch it)", () => {
    expect(parseCommand([])).toEqual({ command: "serve", args: [] });
  });

  it.each(["serve", "setup", "doctor", "accounts", "audit"])("routes %s with its arguments", (command) => {
    expect(parseCommand([command, "--json"])).toEqual({ command, args: ["--json"] });
  });

  it("hands bare flags to serve", () => {
    expect(parseCommand(["--http", "8080"])).toEqual({ command: "serve", args: ["--http", "8080"] });
  });

  it.each([["--version"], ["-v"], ["version"]])("treats %s as version", (flag) => {
    expect(parseCommand([flag]).command).toBe("version");
  });

  it.each([["--help"], ["-h"], ["help"]])("treats %s as help", (flag) => {
    expect(parseCommand([flag]).command).toBe("help");
  });

  it("rejects a typo with a pointer to help", () => {
    expect(() => parseCommand(["sertup"])).toThrow(UnknownCommandError);
    expect(() => parseCommand(["sertup"])).toThrow(/Unknown command "sertup".*inbox-warden help/);
  });
});

describe("helpText", () => {
  it("lists every subcommand", () => {
    for (const command of ["serve", "setup", "doctor", "accounts", "audit verify", "help", "version"]) {
      expect(helpText()).toContain(`  ${command}`);
    }
  });
});

describe("legacyInvocation", () => {
  it("pre-1.0 start commands map to serve/setup and warn", () => {
    const server = legacyInvocation("serve", ["--x"]);
    expect(server.parsed).toEqual({ command: "serve", args: ["--x"] });
    expect(server.warning).toMatch(/deprecated.*2\.0.*"inbox-warden serve"/);
    expect(legacyInvocation("setup", []).parsed).toEqual({ command: "setup", args: [] });
  });

  it("keeps the documented forms of the old setup command", () => {
    expect(legacyInvocation("setup", ["doctor"]).parsed).toEqual({ command: "doctor", args: [] });
    expect(legacyInvocation("setup", ["doctor"]).warning).toContain('"inbox-warden doctor"');
    expect(legacyInvocation("setup", ["accounts", "list"]).parsed).toEqual({ command: "accounts", args: ["list"] });
    expect(legacyInvocation("setup", ["--help"]).parsed).toEqual({ command: "help", args: [] });
    // never turns the old setup command into a server
    expect(legacyInvocation("setup", ["serve"]).parsed).toEqual({ command: "setup", args: ["serve"] });
  });
});
