import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../args.js";

describe("parseCliArgs", () => {
  it.each([
    [[], { command: "setup" }],
    [["setup"], { command: "setup" }],
    [["doctor"], { command: "doctor" }],
    [["accounts", "list"], { command: "accounts-list" }],
    [["--help"], { command: "help" }],
    [["help"], { command: "help" }],
  ])("%j", (argv, expected) => {
    expect(parseCliArgs(argv)).toEqual(expected);
  });

  it("parses accounts login in its three modes", () => {
    expect(parseCliArgs(["accounts", "login", "work"])).toEqual({ command: "accounts-login", accountId: "work", mode: "browser" });
    expect(parseCliArgs(["accounts", "login", "work", "--device-code"])).toEqual({ command: "accounts-login", accountId: "work", mode: "device-code" });
    expect(parseCliArgs(["accounts", "login", "work", "--no-browser", "--listen-host", "0.0.0.0", "--port", "53682"])).toEqual({
      command: "accounts-login",
      accountId: "work",
      mode: "no-browser",
      listenHost: "0.0.0.0",
      port: 53682,
    });
  });

  it.each([
    [["accounts", "login"], /needs the mailbox id/],
    [["accounts", "login", "--no-browser"], /needs the mailbox id/],
    [["accounts", "login", "work", "--device-code", "--no-browser"], /cannot be combined/],
    [["accounts", "login", "work", "--port", "53682"], /only work together with --no-browser/],
    [["accounts", "login", "work", "--no-browser", "--port", "99999"], /between 1 and 65535/],
    [["accounts", "login", "work", "--no-browser", "--listen-host"], /needs a value/],
    [["accounts", "login", "work", "--verbose"], /Unknown option: --verbose/],
    [["accounts"], /expects "list" or "login <id>"/],
    [["doctor", "--fix"], /Unknown option for doctor/],
    [["frobnicate"], /Unknown command: frobnicate/],
  ])("rejects %j", (argv, message) => {
    const cmd = parseCliArgs(argv);
    expect(cmd.command).toBe("invalid");
    if (cmd.command === "invalid") {
      expect(cmd.message.en).toMatch(message);
      expect(cmd.message.de.length).toBeGreaterThan(0);
    }
  });
});
