import type { SecretKey, SecretStore } from "./store.js";
import { KEYCHAIN_SERVICE, keychainAccount } from "./keyring-store.js";

/** Service name used by v0.1/v0.2, where the account was the login (email address). */
export const LEGACY_V01_SERVICE = "imap-mcp-server";

export interface KeytarLocation {
  service: string;
  account: string;
}

export interface KeytarReader {
  read(location: KeytarLocation): Promise<string | null>;
  remove(location: KeytarLocation): Promise<void>;
}

/**
 * keytar stays an optionalDependency for one release so existing secrets can be moved.
 * The specifier is a variable so TypeScript does not need keytar's types at build time.
 */
export async function loadKeytarReader(): Promise<KeytarReader | null> {
  const specifier = "keytar";
  let keytar: {
    getPassword(service: string, account: string): Promise<string | null>;
    deletePassword(service: string, account: string): Promise<boolean>;
  };
  try {
    const mod = await import(specifier);
    keytar = mod.default ?? mod;
  } catch {
    return null;
  }
  return {
    read: async (location) => (await keytar.getPassword(location.service, location.account)) ?? null,
    remove: async (location) => {
      await keytar.deletePassword(location.service, location.account);
    },
  };
}

/** Where v0.3/v0.4 (KeytarSecretStore) kept a secret — the same names the keyring uses now. */
export function keytarLocation(accountId: string, key: SecretKey): KeytarLocation {
  return { service: KEYCHAIN_SERVICE, account: keychainAccount(accountId, key) };
}

/**
 * Wraps the keychain. A secret missing there is looked up once in keytar's store, copied over and
 * deleted from keytar. @napi-rs/keyring cannot read entries written by keytar on Windows and Linux.
 */
export class MigratingSecretStore implements SecretStore {
  private reader?: Promise<KeytarReader | null>;

  constructor(
    private readonly inner: SecretStore,
    private readonly loadReader: () => Promise<KeytarReader | null>,
  ) {}

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    const value = await this.inner.get(accountId, key);
    if (value !== null) return value;

    this.reader ??= this.loadReader().catch(() => null);
    const reader = await this.reader;
    if (!reader) return null;

    const location = keytarLocation(accountId, key);
    const secret = await reader.read(location).catch(() => null);
    if (!secret) return null;

    await this.inner.set(accountId, key, secret);
    try {
      await reader.remove(location);
    } catch {
      // The copy in the keychain is authoritative; a leftover keytar entry is harmless.
    }
    return secret;
  }

  set(accountId: string, key: SecretKey, value: string): Promise<void> {
    return this.inner.set(accountId, key, value);
  }

  delete(accountId: string, key: SecretKey): Promise<void> {
    return this.inner.delete(accountId, key);
  }
}

export type LegacyPasswordLookup = { status: "found"; password: string } | { status: "absent" } | { status: "unknown" };

/**
 * v1 → v2 config migration (loadConfig): the v0.1/v0.2 password stored under the login.
 * "unknown" means keytar cannot be loaded or read here, so an entry may still exist.
 */
export async function lookupLegacyKeytarPassword(
  user: string,
  loadReader: () => Promise<KeytarReader | null> = loadKeytarReader,
): Promise<LegacyPasswordLookup> {
  const reader = await loadReader().catch(() => null);
  if (!reader) return { status: "unknown" };
  try {
    const password = await reader.read({ service: LEGACY_V01_SERVICE, account: user });
    return password ? { status: "found", password } : { status: "absent" };
  } catch {
    return { status: "unknown" };
  }
}

export async function deleteLegacyKeytarPassword(
  user: string,
  loadReader: () => Promise<KeytarReader | null> = loadKeytarReader,
): Promise<void> {
  const reader = await loadReader().catch(() => null);
  await reader?.remove({ service: LEGACY_V01_SERVICE, account: user }).catch(() => {});
}
