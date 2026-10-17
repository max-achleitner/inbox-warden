import { describe, it, expect } from "vitest";
import { authFromEnv } from "../env-auth.js";
import { AuthSchema } from "../schema.js";

describe("authFromEnv", () => {
  it("defaults to password and keeps the username", () => {
    expect(authFromEnv({})).toEqual({ type: "password" });
    expect(authFromEnv({ IMAP_MCP_AUTH: "" }, "max")).toEqual({ type: "password", username: "max" });
  });

  it("maps Microsoft settings", () => {
    const auth = authFromEnv({
      IMAP_MCP_AUTH: "Microsoft",
      IMAP_MCP_OAUTH_CLIENT_ID: " 11111111-2222-3333-4444-555555555555 ",
      IMAP_MCP_OAUTH_TENANT: "firma.at",
      IMAP_MCP_OAUTH_CLIENT_SECRET: "ignored-for-microsoft",
    });
    expect(auth).toEqual({ type: "oauth2", provider: "microsoft", clientId: "11111111-2222-3333-4444-555555555555", tenant: "firma.at" });
    expect(AuthSchema.safeParse(auth).success).toBe(true);
  });

  it("maps Google settings including the client secret", () => {
    expect(authFromEnv({ IMAP_MCP_AUTH: "google", IMAP_MCP_OAUTH_CLIENT_ID: "x.apps.googleusercontent.com", IMAP_MCP_OAUTH_CLIENT_SECRET: "s" })).toEqual({
      type: "oauth2",
      provider: "google",
      clientId: "x.apps.googleusercontent.com",
      clientSecret: "s",
    });
  });

  it("leaves a missing client id to the first use (clear message there)", () => {
    expect(authFromEnv({ IMAP_MCP_AUTH: "microsoft" })).toEqual({ type: "oauth2", provider: "microsoft" });
  });

  it("rejects unknown methods", () => {
    expect(() => authFromEnv({ IMAP_MCP_AUTH: "kerberos" })).toThrow(/IMAP_MCP_AUTH must be/);
  });
});
