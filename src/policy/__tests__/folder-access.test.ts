import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { FolderNotFoundError, listFolderInfo } from "../../imap/folders.js";
import { PolicyDeniedError, PolicyEngine } from "../engine.js";
import { isSystemFolder, resolvePolicyFolder, visibleFolders } from "../folder-access.js";
import { PolicySchema } from "../schema.js";

function account(folders: Record<string, unknown>) {
  const policy = PolicySchema.parse({ folders });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-state-"));
  return { policy: new PolicyEngine("main", policy, ["max@firma.example"], { stateDir }) };
}

describe("folder access", () => {
  const imap = new FakeImap();
  imap.addFolder("INBOX/HR");
  imap.addFolder("INBOX/HR/Gehälter");
  imap.addFolder("Archive");
  imap.addFolder("Gesendet");
  const client = imap.asClient();
  const hr = account({ deny: ["**/HR/**"] });

  it.each(["INBOX/HR", "inbox/hr", "INBOX.HR", "hr", "Gehälter", "INBOX/HR/Gehälter"])("denies %s whatever the spelling", async (name) => {
    await expect(resolvePolicyFolder(hr, client, name)).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it("resolves allowed folders normally", async () => {
    expect(await resolvePolicyFolder(hr, client, "archive")).toBe("Archive");
  });

  it("keeps not-found errors for unknown names and never suggests hidden folders", async () => {
    try {
      await resolvePolicyFolder(hr, client, "H");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FolderNotFoundError);
      expect((err as Error).message).not.toMatch(/HR/);
    }
  });

  it("refuses a name that exactly matches a hidden folder instead of mapping it to a visible one", async () => {
    const fake = new FakeImap();
    fake.addFolder("Archive");
    fake.addFolder("Projects");
    fake.addFolder("Projects/Archive");
    const denyArchive = account({ deny: ["Archive"] });
    await expect(resolvePolicyFolder(denyArchive, fake.asClient(), "Archive")).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(await resolvePolicyFolder(denyArchive, fake.asClient(), "Projects/Archive")).toBe("Projects/Archive");
  });

  it("matches among visible folders when a name is ambiguous only because of hidden ones", async () => {
    const fake = new FakeImap();
    fake.addFolder("Old");
    fake.addFolder("Old/Archive");
    fake.addFolder("Projects");
    fake.addFolder("Projects/Archive");
    expect(await resolvePolicyFolder(account({ deny: ["Old/**"] }), fake.asClient(), "Archive")).toBe("Projects/Archive");
  });

  it("uses a folder list it is given instead of listing again", async () => {
    const fake = new FakeImap();
    fake.addFolder("Archive");
    const folders = await listFolderInfo(fake.asClient());
    expect(await resolvePolicyFolder(hr, fake.asClient(), "archive", folders)).toBe("Archive");
    expect(fake.callsTo("list")).toHaveLength(1);
  });

  it("filters listings", async () => {
    const visible = visibleFolders(hr, await listFolderInfo(client)).map((f) => f.path);
    expect(visible).toEqual(["INBOX", "Archive", "Gesendet"]);
  });

  it("recognises system folders by SPECIAL-USE or well-known name", async () => {
    const folders = await listFolderInfo(client);
    expect(isSystemFolder(folders, "INBOX")).toBe(true);
    expect(isSystemFolder(folders, "Gesendet")).toBe(true);
    expect(isSystemFolder(folders, "Archive")).toBe(false);
  });
});
