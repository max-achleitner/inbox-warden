import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { errorMessage } from "../errors.js";
import * as log from "../logging/logger.js";
import { createSecretStore, type SecretKey, type SecretStore } from "./store.js";

/** Set by the Docker image. Container mode never touches an OS keychain. */
export function isContainerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.IMAP_MCP_CONTAINER === "1";
}

/**
 * Docker-secrets convention for settings outside the secret store (e.g. IMAP_MCP_STATE_KEY_FILE):
 * `IMAP_MCP_X_FILE=/run/secrets/x` becomes `IMAP_MCP_X` (one trailing newline removed).
 * An explicitly set `IMAP_MCP_X` wins. Returns the names that were filled.
 */
export function applyFileSecrets(
  env: NodeJS.ProcessEnv,
  readFile: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): string[] {
  const applied: string[] = [];
  for (const [name, file] of Object.entries(env)) {
    const match = /^(IMAP_MCP_[A-Z0-9_]+)_FILE$/.exec(name);
    if (!match || !file || env[match[1]]) continue;
    env[match[1]] = readFile(file).replace(/\r?\n$/, "");
    applied.push(match[1]);
  }
  return applied;
}

interface EncryptedFile {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

/** AES-256-GCM encrypted JSON map on the data volume — keeps rotated OAuth refresh tokens across restarts. */
export class EncryptedFileSecretStore implements SecretStore {
  constructor(private readonly file: string, private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("IMAP_MCP_STATE_KEY must be 32 random bytes, base64-encoded.");
  }

  private read(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    try {
      const doc = JSON.parse(fs.readFileSync(this.file, "utf8")) as EncryptedFile;
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(doc.iv, "base64"));
      decipher.setAuthTag(Buffer.from(doc.tag, "base64"));
      const plain = Buffer.concat([decipher.update(Buffer.from(doc.data, "base64")), decipher.final()]);
      return JSON.parse(plain.toString("utf8")) as Record<string, string>;
    } catch (err) {
      throw new Error(
        `Cannot read the encrypted secrets file ${this.file}: IMAP_MCP_STATE_KEY is not the key it was written with, or the file is damaged (${errorMessage(err)}).`,
      );
    }
  }

  private write(values: Record<string, string>): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(values), "utf8"), cipher.final()]);
    const doc: EncryptedFile = { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    return this.read()[`${accountId}:${key}`] ?? null;
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    const values = this.read();
    values[`${accountId}:${key}`] = value;
    this.write(values);
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    const values = this.read();
    delete values[`${accountId}:${key}`];
    this.write(values);
  }
}

/**
 * Newest value from the encrypted state file, else the environment (Plan 2 env store). Never a keychain.
 * An unreadable state file (rotated key, damage) does not break secrets that come from the environment.
 */
export class ContainerSecretStore implements SecretStore {
  private warnedUnreadable = false;

  constructor(private readonly envStore: SecretStore, private readonly state?: EncryptedFileSecretStore) {}

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    let stateError: unknown;
    try {
      const stored = this.state ? await this.state.get(accountId, key) : null;
      if (stored !== null) return stored;
    } catch (err) {
      stateError = err;
    }
    const fromEnv = await this.envStore.get(accountId, key);
    if (stateError !== undefined) {
      if (fromEnv === null) throw stateError;
      if (!this.warnedUnreadable) log.warn("secrets.state_unreadable", { error: errorMessage(stateError) });
      this.warnedUnreadable = true;
    }
    return fromEnv;
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    if (!this.state) {
      throw new Error(
        "Cannot store secrets in container mode without a state key: set IMAP_MCP_STATE_KEY or IMAP_MCP_STATE_KEY_FILE (32 random bytes, base64).",
      );
    }
    await this.state.set(accountId, key, value);
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    await this.state?.delete(accountId, key);
  }
}

/** State lives in $IMAP_MCP_HOME (the /data volume in the image), default ~/.imap-mcp. */
export function createContainerSecretStore(env: NodeJS.ProcessEnv = process.env): ContainerSecretStore {
  applyFileSecrets(env);
  const home = env.IMAP_MCP_HOME ?? path.join(os.homedir(), ".imap-mcp");
  const key = env.IMAP_MCP_STATE_KEY;
  const state = key ? new EncryptedFileSecretStore(path.join(home, "secrets.enc.json"), Buffer.from(key, "base64")) : undefined;
  return new ContainerSecretStore(createSecretStore(env, { keychain: false }), state);
}

/** The store every CLI entry point uses: container → env + encrypted state file; desktop → Plan 2/4 chain (env, keychain). */
export function createRuntimeSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  return isContainerMode(env) ? createContainerSecretStore(env) : createSecretStore(env);
}
