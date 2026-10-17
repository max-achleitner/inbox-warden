import { errorMessage } from "../errors.js";
import type { SecretKey, SecretStore } from "./store.js";

/** Service name under which every secret is stored in the OS credential store. */
export const KEYCHAIN_SERVICE = "imap-mcp";

/** The subset of @napi-rs/keyring's AsyncEntry this module uses (injectable for tests). */
export interface KeyringEntry {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

export class SecretStoreUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `The operating system's credential store could not be used (${detail}). ` +
        "On Linux, install and unlock a Secret Service keyring (for example gnome-keyring or KWallet); " +
        "in containers, pass secrets as environment variables instead.",
    );
    this.name = "SecretStoreUnavailableError";
  }
}

type KeyringModule = Pick<typeof import("@napi-rs/keyring"), "AsyncEntry">;

/** Load @napi-rs/keyring lazily so env-only deployments never touch the native module. */
export async function loadKeyringFactory(
  platform: NodeJS.Platform = process.platform,
  importer: () => Promise<KeyringModule> = () => import("@napi-rs/keyring"),
): Promise<KeyringEntryFactory> {
  let mod: KeyringModule;
  try {
    mod = await importer();
  } catch (err) {
    throw new SecretStoreUnavailableError(`native module could not be loaded: ${errorMessage(err)}`);
  }
  // Without this pin the library silently falls back to the kernel keyring, which forgets secrets on reboot.
  const options = platform === "linux" ? { linux: { store: "secret-service" as const } } : undefined;
  return (service, account) => new mod.AsyncEntry(service, account, options);
}

export function keychainAccount(accountId: string, key: SecretKey): string {
  return `${accountId}:${key}`;
}

export class KeyringSecretStore implements SecretStore {
  private factory?: Promise<KeyringEntryFactory>;

  constructor(private readonly loadFactory: () => Promise<KeyringEntryFactory> = () => loadKeyringFactory()) {}

  private async entry(accountId: string, key: SecretKey): Promise<KeyringEntry> {
    this.factory ??= this.loadFactory();
    const create = await this.factory;
    return create(KEYCHAIN_SERVICE, keychainAccount(accountId, key));
  }

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    const entry = await this.entry(accountId, key);
    try {
      return (await entry.getPassword()) ?? null;
    } catch (err) {
      throw new SecretStoreUnavailableError(errorMessage(err));
    }
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    const entry = await this.entry(accountId, key);
    try {
      await entry.setPassword(value);
    } catch (err) {
      throw new SecretStoreUnavailableError(errorMessage(err));
    }
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    const entry = await this.entry(accountId, key);
    try {
      await entry.deleteCredential();
    } catch (err) {
      throw new SecretStoreUnavailableError(errorMessage(err));
    }
  }
}
