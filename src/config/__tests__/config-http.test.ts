import { describe, it, expect } from "vitest";
import { ConfigSchema } from "../schema.js";

const account = { id: "main", email: "max@firma.example", imap: { host: "mail.firma.example", port: 993 } };

describe("ConfigSchema with HTTP settings", () => {
  it("keeps http and httpAuth optional", () => {
    const parsed = ConfigSchema.parse({ version: 2, accounts: [account] });
    expect(parsed.http).toBeUndefined();
    expect(parsed.httpAuth).toBeUndefined();
  });

  it("parses and defaults the http and httpAuth sections", () => {
    const parsed = ConfigSchema.parse({
      version: 2,
      accounts: [account],
      http: { port: 9000 },
      httpAuth: { mode: "bearer", tokens: [{ id: "laptop", sha256: "a".repeat(64) }] },
    });
    expect(parsed.http).toMatchObject({ host: "127.0.0.1", port: 9000 });
    expect(parsed.httpAuth).toEqual({ mode: "bearer", tokens: [{ id: "laptop", sha256: "a".repeat(64) }], principals: [] });
  });

  it("rejects a plaintext token in the config", () => {
    const result = ConfigSchema.safeParse({ version: 2, accounts: [account], httpAuth: { mode: "bearer", tokens: [{ id: "x", token: "imcp_x" }] } });
    expect(result.success).toBe(false);
  });
});
