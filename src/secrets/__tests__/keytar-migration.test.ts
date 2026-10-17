import { describe, it, expect } from "vitest";
import { MemorySecretStore } from "../memory-store.js";
import {
  MigratingSecretStore,
  deleteLegacyKeytarPassword,
  keytarLocation,
  lookupLegacyKeytarPassword,
  type KeytarLocation,
  type KeytarReader,
} from "../keytar-migration.js";

function keytar(entries: Record<string, string>): KeytarReader & { removed: string[] } {
  const removed: string[] = [];
  const id = (l: KeytarLocation) => `${l.service}|${l.account}`;
  return {
    removed,
    async read(location) {
      return entries[id(location)] ?? null;
    },
    async remove(location) {
      removed.push(id(location));
      delete entries[id(location)];
    },
  };
}

describe("MigratingSecretStore", () => {
  it("uses the same names as Plan 2's KeytarSecretStore", () => {
    expect(keytarLocation("work", "oauthRefreshToken")).toEqual({ service: "imap-mcp", account: "work:oauthRefreshToken" });
  });

  it("moves a keytar secret into the keychain exactly once", async () => {
    const inner = new MemorySecretStore();
    const old = keytar({ "imap-mcp|work:password": "pw" });
    const store = new MigratingSecretStore(inner, async () => old);
    expect(await store.get("work", "password")).toBe("pw");
    expect(await inner.get("work", "password")).toBe("pw");
    expect(old.removed).toEqual(["imap-mcp|work:password"]);
    expect(await store.get("work", "password")).toBe("pw");
  });

  it("prefers the keychain over keytar entries", async () => {
    const inner = new MemorySecretStore();
    await inner.set("work", "password", "new");
    const old = keytar({ "imap-mcp|work:password": "old" });
    expect(await new MigratingSecretStore(inner, async () => old).get("work", "password")).toBe("new");
    expect(old.removed).toEqual([]);
  });

  it("returns null when keytar is not installed or fails", async () => {
    expect(await new MigratingSecretStore(new MemorySecretStore(), async () => null).get("main", "password")).toBeNull();
    const broken = new MigratingSecretStore(new MemorySecretStore(), async () => {
      throw new Error("keytar binary for this Node version missing");
    });
    expect(await broken.get("main", "password")).toBeNull();
  });
});

describe("v0.1 password helpers (used by loadConfig's v1 migration)", () => {
  it("read and delete the entry stored under the login", async () => {
    const old = keytar({ "imap-mcp-server|max@firma.example": "v01-pw" });
    expect(await lookupLegacyKeytarPassword("max@firma.example", async () => old)).toEqual({ status: "found", password: "v01-pw" });
    await deleteLegacyKeytarPassword("max@firma.example", async () => old);
    expect(old.removed).toEqual(["imap-mcp-server|max@firma.example"]);
  });

  it("tell a missing entry apart from a keychain that cannot be read here", async () => {
    expect(await lookupLegacyKeytarPassword("a@b.at", async () => keytar({}))).toEqual({ status: "absent" });
    expect(await lookupLegacyKeytarPassword("a@b.at", async () => null)).toEqual({ status: "unknown" });
    const failing: KeytarReader = { read: async () => { throw new Error("locked"); }, remove: async () => {} };
    expect(await lookupLegacyKeytarPassword("a@b.at", async () => failing)).toEqual({ status: "unknown" });
    await expect(deleteLegacyKeytarPassword("a@b.at", async () => null)).resolves.toBeUndefined();
  });
});
