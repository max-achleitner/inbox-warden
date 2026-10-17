import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createSecretStore } from "../store.js";
import {
  ContainerSecretStore,
  EncryptedFileSecretStore,
  applyFileSecrets,
  createContainerSecretStore,
  createRuntimeSecretStore,
  isContainerMode,
} from "../container.js";

describe("applyFileSecrets", () => {
  it("fills IMAP_MCP_* from *_FILE and keeps explicit values", () => {
    const env: NodeJS.ProcessEnv = {
      IMAP_MCP_STATE_KEY_FILE: "/run/secrets/state_key",
      IMAP_MCP_SMTP_HOST_FILE: "/run/secrets/ignored",
      IMAP_MCP_SMTP_HOST: "smtp.example.com",
      OTHER_FILE: "/etc/passwd",
    };
    const files: Record<string, string> = { "/run/secrets/state_key": "a2V5\n", "/run/secrets/ignored": "x" };
    expect(applyFileSecrets(env, (f) => files[f])).toEqual(["IMAP_MCP_STATE_KEY"]);
    expect(env.IMAP_MCP_STATE_KEY).toBe("a2V5");
    expect(env.IMAP_MCP_SMTP_HOST).toBe("smtp.example.com");
    expect(env.OTHER).toBeUndefined();
  });

  it("detects container mode only from the image flag", () => {
    expect(isContainerMode({ IMAP_MCP_CONTAINER: "1" })).toBe(true);
    expect(isContainerMode({})).toBe(false);
  });
});

describe("container secret stores", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "imcp-home-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("round-trips through AES-GCM and never writes plaintext", async () => {
    const file = path.join(home, "secrets.enc.json");
    const store = new EncryptedFileSecretStore(file, randomBytes(32));
    await store.set("main", "oauthRefreshToken", "rt-123");
    expect(await store.get("main", "oauthRefreshToken")).toBe("rt-123");
    expect(fs.readFileSync(file, "utf8")).not.toContain("rt-123");
  });

  it("fails loudly with the wrong key (tampering or mix-up)", async () => {
    const file = path.join(home, "secrets.enc.json");
    await new EncryptedFileSecretStore(file, randomBytes(32)).set("main", "password", "pw");
    await expect(new EncryptedFileSecretStore(file, randomBytes(32)).get("main", "password")).rejects.toThrow();
  });

  it("prefers a rotated token from the state file over the initial env value", async () => {
    const env: NodeJS.ProcessEnv = {
      IMAP_MCP_HOME: home,
      IMAP_MCP_OAUTH_REFRESH_TOKEN_BUERO_GMX: "initial",
      IMAP_MCP_STATE_KEY: randomBytes(32).toString("base64"),
    };
    const store = createContainerSecretStore(env);
    expect(await store.get("buero-gmx", "oauthRefreshToken")).toBe("initial");
    await store.set("buero-gmx", "oauthRefreshToken", "rotated");
    expect(await createContainerSecretStore(env).get("buero-gmx", "oauthRefreshToken")).toBe("rotated");
  });

  it("reads passwords from the environment and explains how to persist without a state key", async () => {
    const store = new ContainerSecretStore(createSecretStore({ IMAP_MCP_PASSWORD_MAIN: "pw" }, { keychain: false }));
    expect(await store.get("main", "password")).toBe("pw");
    await expect(store.set("main", "oauthRefreshToken", "x")).rejects.toThrow(/IMAP_MCP_STATE_KEY/);
  });

  it("never builds a keychain-backed store in container mode", async () => {
    const store = createRuntimeSecretStore({ IMAP_MCP_CONTAINER: "1", IMAP_MCP_HOME: home, IMAP_MCP_PASSWORD_MAIN: "pw" });
    expect(store).toBeInstanceOf(ContainerSecretStore);
    expect(await store.get("main", "password")).toBe("pw");
  });

  it("keeps env-only secrets working when the state file cannot be read, and names the state key otherwise", async () => {
    const file = path.join(home, "secrets.enc.json");
    await new EncryptedFileSecretStore(file, randomBytes(32)).set("main", "oauthRefreshToken", "rt");
    const rotatedKey = new EncryptedFileSecretStore(file, randomBytes(32));
    const store = new ContainerSecretStore(createSecretStore({ IMAP_MCP_PASSWORD_MAIN: "pw" }, { keychain: false }), rotatedKey);
    expect(await store.get("main", "password")).toBe("pw");
    await expect(store.get("main", "oauthRefreshToken")).rejects.toThrow(/IMAP_MCP_STATE_KEY/);
  });

  it("explains a damaged state file", async () => {
    const file = path.join(home, "secrets.enc.json");
    fs.writeFileSync(file, '{"v":1,"iv":"');
    await expect(new EncryptedFileSecretStore(file, randomBytes(32)).get("main", "password")).rejects.toThrow(/damaged/);
  });

  it("rejects a state key of the wrong length", () => {
    expect(() => new EncryptedFileSecretStore(path.join(home, "x"), Buffer.alloc(16))).toThrow(/32 random bytes/);
  });
});
