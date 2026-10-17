import { describe, it, expect } from "vitest";
import {
  KEYCHAIN_SERVICE,
  KeyringSecretStore,
  loadKeyringFactory,
  SecretStoreUnavailableError,
  type KeyringEntryFactory,
} from "../keyring-store.js";

function fakeKeyring(): { factory: KeyringEntryFactory; data: Map<string, string>; failNext: () => void } {
  const data = new Map<string, string>();
  let fail = false;
  const factory: KeyringEntryFactory = (service, account) => {
    const key = `${service}|${account}`;
    const guard = () => {
      if (fail) {
        fail = false;
        throw new Error("Platform secure storage failure: keychain is locked");
      }
    };
    return {
      async getPassword() {
        guard();
        return data.get(key) ?? null;
      },
      async setPassword(password: string) {
        guard();
        data.set(key, password);
      },
      async deleteCredential() {
        guard();
        return data.delete(key);
      },
    };
  };
  return { factory, data, failNext: () => { fail = true; } };
}

describe("KeyringSecretStore", () => {
  it("stores secrets under service imap-mcp and account <id>:<key>", async () => {
    const kr = fakeKeyring();
    const store = new KeyringSecretStore(async () => kr.factory);
    await store.set("work", "password", "s3cret");
    expect(kr.data.get(`${KEYCHAIN_SERVICE}|work:password`)).toBe("s3cret");
    expect(await store.get("work", "password")).toBe("s3cret");
    expect(await store.get("work", "oauthRefreshToken")).toBeNull();
  });

  it("deletes secrets", async () => {
    const kr = fakeKeyring();
    const store = new KeyringSecretStore(async () => kr.factory);
    await store.set("work", "password", "x");
    await store.delete("work", "password");
    expect(await store.get("work", "password")).toBeNull();
  });

  it("maps a locked keychain to a plain-language SecretStoreUnavailableError", async () => {
    const kr = fakeKeyring();
    const store = new KeyringSecretStore(async () => kr.factory);
    kr.failNext();
    await expect(store.get("work", "password")).rejects.toBeInstanceOf(SecretStoreUnavailableError);
  });

  it("reports a missing native module as SecretStoreUnavailableError", async () => {
    const store = new KeyringSecretStore(async () => {
      throw new SecretStoreUnavailableError("native module could not be loaded: not found");
    });
    await expect(store.get("work", "password")).rejects.toThrow(/credential store could not be used/);
  });

  it("pins Linux to the Secret Service so secrets survive a reboot", async () => {
    const seen: unknown[] = [];
    class FakeAsyncEntry {
      constructor(_service: string, _account: string, options?: unknown) {
        seen.push(options);
      }
    }
    const importer = async () => ({ AsyncEntry: FakeAsyncEntry }) as never;
    (await loadKeyringFactory("linux", importer))("imap-mcp", "main:password");
    (await loadKeyringFactory("win32", importer))("imap-mcp", "main:password");
    expect(seen).toEqual([{ linux: { store: "secret-service" } }, undefined]);
  });

  it("turns a missing native binary into SecretStoreUnavailableError", async () => {
    await expect(
      loadKeyringFactory("linux", async () => {
        throw new Error("Cannot find native binding");
      }),
    ).rejects.toBeInstanceOf(SecretStoreUnavailableError);
  });

  it.skipIf(process.env.IMAP_MCP_KEYCHAIN_IT !== "1")("round-trips through the real OS keychain", async () => {
    const store = new KeyringSecretStore();
    const id = `it-${Date.now()}`;
    await store.set(id, "password", "integration-secret");
    expect(await store.get(id, "password")).toBe("integration-secret");
    await store.delete(id, "password");
    expect(await store.get(id, "password")).toBeNull();
  });
});
