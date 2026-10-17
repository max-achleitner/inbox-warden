import type { SecretKey, SecretStore } from "./store.js";
import { KeyringSecretStore, loadKeyringFactory, type KeyringEntryFactory } from "./keyring-store.js";
import { createCliSecretStore, type RunCommand } from "./os-cli-store.js";

export interface KeychainOptions {
  platform?: NodeJS.Platform;
  /** Directory for DPAPI files on Windows (CONFIG_DIR/secrets). */
  secretsDir: string;
  loadKeyring?(): Promise<KeyringEntryFactory>;
  run?: RunCommand;
}

/**
 * The OS keychain: @napi-rs/keyring when its native module loads; otherwise (MCPB bundles ship
 * without native modules) the operating system's own command-line tools. Chosen once, on first use.
 */
export function createKeychainStore(opts: KeychainOptions): SecretStore {
  const platform = opts.platform ?? process.platform;
  let selected: Promise<SecretStore> | undefined;
  const store = () =>
    (selected ??= (async () => {
      try {
        const factory = await (opts.loadKeyring ?? (() => loadKeyringFactory(platform)))();
        return new KeyringSecretStore(async () => factory);
      } catch {
        return createCliSecretStore({ platform, secretsDir: opts.secretsDir, run: opts.run });
      }
    })());
  return {
    get: async (accountId: string, key: SecretKey) => (await store()).get(accountId, key),
    set: async (accountId: string, key: SecretKey, value: string) => (await store()).set(accountId, key, value),
    delete: async (accountId: string, key: SecretKey) => (await store()).delete(accountId, key),
  };
}
