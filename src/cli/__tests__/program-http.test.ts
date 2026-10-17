import { describe, it, expect, vi, afterEach } from "vitest";
import { run } from "../program.js";

function captured(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => String(call[0])).join("");
}

describe("top-level dispatcher with the http command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes http to the bearer-token CLI", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await run({ command: "http", args: ["tokens"] })).toBe(2);
    expect(captured(err)).toContain("http token create --id <name>");
  });

  it("keeps setup/doctor/accounts/audit on the admin CLI", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await run({ command: "accounts", args: ["bogus"] });
    expect(captured(out) + captured(err)).not.toContain("http token create");
  });
});
