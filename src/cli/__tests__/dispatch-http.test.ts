import { describe, it, expect } from "vitest";
import { helpText, parseCommand } from "../dispatch.js";

describe("http command and serve --http in the top-level CLI", () => {
  it("routes http with its arguments", () => {
    expect(parseCommand(["http", "token", "create", "--id", "laptop"])).toEqual({
      command: "http",
      args: ["token", "create", "--id", "laptop"],
    });
  });

  it("hands --http to serve", () => {
    expect(parseCommand(["serve", "--http", "--port", "8787"])).toEqual({ command: "serve", args: ["--http", "--port", "8787"] });
  });

  it("documents both, with descriptions aligned to the existing commands", () => {
    const lines = helpText().split("\n");
    // where Plan 6's descriptions start, e.g. "  serve          Start the MCP server …"
    const column = /^( {2}serve +)\S/.exec(lines.find((l) => /^ {2}serve +\S/.test(l))!)![1].length;
    for (const name of ["serve --http", "http token"]) {
      const line = lines.find((l) => l.startsWith(`  ${name} `));
      expect(line?.slice(2, column).trimEnd()).toBe(name);
      expect(line?.charAt(column)).toMatch(/\S/);
    }
  });
});
