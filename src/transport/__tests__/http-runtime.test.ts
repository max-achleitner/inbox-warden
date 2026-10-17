import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import type { AppConfig } from "../../config/schema.js";
import { HttpAuthSchema } from "../../config/http-schema.js";
import { createSecretStore } from "../../secrets/store.js";
import { buildHttpRuntime, resolveHttpConfig } from "../http-runtime.js";
import { fakeApp } from "./fake-app.js";

const accounts = [{ id: "main", email: "max@firma.example", permissions: { read: true, write: true, send: false, delete: false } }];
const asConfig = (value: Record<string, unknown>) => value as unknown as AppConfig;

function deps(created: string[]) {
  return {
    secrets: createSecretStore({}, { keychain: false }),
    createAppContext: (config: AppConfig) => {
      created.push("app");
      return Object.assign(fakeApp(["main"]), { config });
    },
    createServer: () => new McpServer({ name: "t", version: "0" }),
  };
}

describe("resolveHttpConfig", () => {
  it("applies config < env < flags", () => {
    const config = asConfig({ accounts, http: { host: "127.0.0.1", port: 9000 } });
    expect(resolveHttpConfig(config, {}, {})).toMatchObject({ host: "127.0.0.1", port: 9000 });
    expect(resolveHttpConfig(config, { IMAP_MCP_HTTP_PORT: "9100", IMAP_MCP_HTTP_HOST: "0.0.0.0" }, {})).toMatchObject({ host: "0.0.0.0", port: 9100 });
    expect(resolveHttpConfig(config, { IMAP_MCP_HTTP_PORT: "9100" }, { port: 9200 }).port).toBe(9200);
  });
});

describe("buildHttpRuntime", () => {
  it("does not create account runtimes when the deployment is invalid", () => {
    const created: string[] = [];
    const config = asConfig({ accounts });
    const runtime = buildHttpRuntime(config, resolveHttpConfig(config, {}, {}), deps(created));
    expect(runtime.ok).toBe(false);
    expect(runtime.check.errors[0]).toMatch(/httpAuth/);
    expect(created).toEqual([]);
  });

  it("builds an OAuth runtime advertising scopesSupported in the metadata", async () => {
    const created: string[] = [];
    const config = asConfig({
      accounts,
      http: { publicUrl: "http://127.0.0.1" },
      httpAuth: HttpAuthSchema.parse({
        mode: "oauth",
        issuer: "https://login.microsoftonline.com/tid/v2.0",
        audience: "cid",
        requiredScopes: ["mail.access"],
        scopesSupported: ["api://cid/mail.access", "offline_access"],
        principals: [{ match: { group: "g" }, accounts: ["main"] }],
      }),
    });
    const runtime = buildHttpRuntime(config, resolveHttpConfig(config, {}, {}), deps(created));
    expect(runtime.ok).toBe(true);
    if (!runtime.ok) return;
    expect(created).toEqual(["app"]);
    const res = await runtime.httpApp.fetch(
      new Request("http://127.0.0.1:8787/.well-known/oauth-protected-resource", { headers: { host: "127.0.0.1:8787" } }),
      "127.0.0.1",
    );
    expect(await res.json()).toMatchObject({ scopes_supported: ["api://cid/mail.access", "offline_access"] });
    await runtime.httpApp.close();
  });
});
