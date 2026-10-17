import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { configDir } from "../config/load.js";
import { createKeychainStore } from "./keychain.js";
import { MigratingSecretStore, loadKeytarReader } from "./keytar-migration.js";

export type SecretKey = "password" | "oauthRefreshToken";

export interface SecretStore {
  get(accountId: string, key: SecretKey): Promise<string | null>;
  set(accountId: string, key: SecretKey, value: string): Promise<void>;
  delete(accountId: string, key: SecretKey): Promise<void>;
}

const KEY_SUFFIX: Record<SecretKey, string> = {
  password: "PASSWORD",
  oauthRefreshToken: "OAUTH_REFRESH_TOKEN",
};

/** e.g. account "buero-gmx", key "password" → IMAP_MCP_PASSWORD_BUERO_GMX */
export function secretEnvName(accountId: string, key: SecretKey): string {
  return `IMAP_MCP_${KEY_SUFFIX[key]}_${accountId.toUpperCase().replace(/-/g, "_")}`;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/** Read-only store backed by environment variables and *_FILE variables (Docker secrets). */
export class EnvSecretStore implements SecretStore {
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  private names(accountId: string, key: SecretKey): string[] {
    const names = [secretEnvName(accountId, key)];
    if (accountId === "main" && key === "password") names.push("IMAP_MCP_PASSWORD", "IMAP_PASSWORD");
    return names;
  }

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    for (const name of this.names(accountId, key)) {
      const direct = nonEmpty(this.env[name]);
      if (direct) return direct;
      const file = nonEmpty(this.env[`${name}_FILE`]);
      if (file) return (await readFile(file, "utf8")).replace(/\r?\n$/, "");
    }
    return null;
  }

  async set(accountId: string, key: SecretKey): Promise<void> {
    throw new Error(`Cannot store secrets in environment variables. Set ${secretEnvName(accountId, key)} yourself or enable the OS keychain.`);
  }

  async delete(): Promise<void> {
    // nothing to delete: environment variables are owned by the caller
  }
}

/**
 * Reads from each store in order; writes go to the writable store (the keychain). Refresh tokens
 * are read from the writable store first: rotation and sign-in store newer tokens there, which an
 * environment variable holding the initial token must not shadow.
 */
export class ChainSecretStore implements SecretStore {
  constructor(private readonly stores: SecretStore[], private readonly writable?: SecretStore) {}

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    const writable = this.writable;
    const order =
      key === "oauthRefreshToken" && writable ? [writable, ...this.stores.filter((s) => s !== writable)] : this.stores;
    for (const store of order) {
      const value = await store.get(accountId, key);
      if (value !== null) return value;
    }
    return null;
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    if (!this.writable) {
      throw new Error(`No writable secret store is available. Provide ${secretEnvName(accountId, key)} as an environment variable.`);
    }
    await this.writable.set(accountId, key, value);
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    await this.writable?.delete(accountId, key);
  }
}

/** Environment variables first, then the OS keychain (unless `keychain: false`, e.g. in containers). */
export function createSecretStore(env: NodeJS.ProcessEnv = process.env, opts: { keychain?: boolean } = {}): SecretStore {
  const envStore = new EnvSecretStore(env);
  if (opts.keychain === false) return new ChainSecretStore([envStore]);
  // @napi-rs/keyring, or the OS tools when the native module is missing; keytar-era secrets move over once.
  const keychain = new MigratingSecretStore(createKeychainStore({ secretsDir: path.join(configDir(env), "secrets") }), loadKeytarReader);
  return new ChainSecretStore([envStore, keychain], keychain);
}
