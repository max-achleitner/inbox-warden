import type { SecretKey, SecretStore } from "./store.js";

export interface StoredSecret {
  accountId: string;
  key: SecretKey;
  value: string;
}

/** In-memory SecretStore: stages credentials during setup until the user saves; also used by tests. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, StoredSecret>();

  async get(accountId: string, key: SecretKey): Promise<string | null> {
    return this.values.get(`${accountId}:${key}`)?.value ?? null;
  }

  async set(accountId: string, key: SecretKey, value: string): Promise<void> {
    this.values.set(`${accountId}:${key}`, { accountId, key, value });
  }

  async delete(accountId: string, key: SecretKey): Promise<void> {
    this.values.delete(`${accountId}:${key}`);
  }

  entries(): StoredSecret[] {
    return [...this.values.values()];
  }
}
