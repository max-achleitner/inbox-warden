import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChainSecretStore, EnvSecretStore, createSecretStore, secretEnvName, type SecretStore } from "../store.js";

describe("secret stores", () => {
  it("derives environment variable names from the account id", () => {
    expect(secretEnvName("buero-gmx", "password")).toBe("IMAP_MCP_PASSWORD_BUERO_GMX");
    expect(secretEnvName("main", "oauthRefreshToken")).toBe("IMAP_MCP_OAUTH_REFRESH_TOKEN_MAIN");
  });

  it("reads per-account variables, *_FILE secrets and the legacy single-account names", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-")), "pw");
    fs.writeFileSync(file, "from-file\n");
    const store = new EnvSecretStore({
      IMAP_MCP_PASSWORD_OFFICE: "office-pw",
      IMAP_MCP_PASSWORD_SHOP_FILE: file,
      IMAP_PASSWORD: "legacy",
    });
    expect(await store.get("office", "password")).toBe("office-pw");
    expect(await store.get("shop", "password")).toBe("from-file");
    expect(await store.get("main", "password")).toBe("legacy");
    expect(await store.get("other", "password")).toBeNull();
  });

  it("treats empty variables as unset", async () => {
    expect(await new EnvSecretStore({ IMAP_MCP_PASSWORD: "" }).get("main", "password")).toBeNull();
  });

  it("chain reads in order and writes only to the writable store", async () => {
    const written: string[] = [];
    const keychain: SecretStore = {
      get: async () => "from-keychain",
      set: async (id, key, value) => { written.push(`${id}:${key}=${value}`); },
      delete: async () => {},
    };
    const chain = new ChainSecretStore([new EnvSecretStore({ IMAP_MCP_PASSWORD_MAIN: "from-env" }), keychain], keychain);
    expect(await chain.get("main", "password")).toBe("from-env");
    expect(await chain.get("other", "password")).toBe("from-keychain");
    await chain.set("main", "password", "new");
    expect(written).toEqual(["main:password=new"]);
  });

  it("prefers the stored (rotated or newly signed-in) refresh token over the environment's initial one", async () => {
    const stored = new Map<string, string>();
    const keychain: SecretStore = {
      get: async (id, key) => stored.get(`${id}:${key}`) ?? null,
      set: async (id, key, value) => { stored.set(`${id}:${key}`, value); },
      delete: async () => {},
    };
    const env = new EnvSecretStore({ IMAP_MCP_OAUTH_REFRESH_TOKEN_MAIN: "initial", IMAP_MCP_PASSWORD_MAIN: "env-pw" });
    const chain = new ChainSecretStore([env, keychain], keychain);
    expect(await chain.get("main", "oauthRefreshToken")).toBe("initial");
    await chain.set("main", "oauthRefreshToken", "rotated");
    expect(await chain.get("main", "oauthRefreshToken")).toBe("rotated");
    await chain.set("main", "password", "keychain-pw");
    expect(await chain.get("main", "password")).toBe("env-pw"); // an env password still overrides
  });

  it("without keychain, writing explains which variable to set", async () => {
    const store = createSecretStore({}, { keychain: false });
    await expect(store.set("office", "password", "x")).rejects.toThrow(/IMAP_MCP_PASSWORD_OFFICE/);
    expect(await store.get("office", "password")).toBeNull();
  });
});
