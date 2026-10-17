import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as listAccounts from "../list-accounts.js";
import * as searchEmails from "../search-emails.js";

describe("multiple accounts", () => {
  it("list_accounts shows ids, senders and permissions without secrets", async () => {
    const t = createTestApp([
      { id: "office", email: "office@firma.at", identities: [{ email: "info@firma.at", name: "Firma" }], permissions: { send: true } },
      { id: "private", email: "max@gmx.at", permissions: { write: false, send: false, delete: false } },
    ]);
    const h = await t.connect(listAccounts.register);
    const res = await h.call("list_accounts");
    expect(res.json).toEqual([
      {
        id: "office",
        email: "office@firma.at",
        default: true,
        senders: ["info@firma.at", "office@firma.at"],
        permissions: { read: true, write: true, send: true, delete: true },
        canSend: true,
      },
      {
        id: "private",
        email: "max@gmx.at",
        default: false,
        senders: ["max@gmx.at"],
        permissions: { read: true, write: false, send: false, delete: false },
        canSend: false,
      },
    ]);
    expect(res.text).not.toMatch(/secret/);
    await h.close();
  });

  it("search_emails searches the mailbox of the selected account", async () => {
    const t = createTestApp([{ id: "office" }, { id: "private" }]);
    t.imap("office").addMessage("INBOX", await buildRaw({ from: "kunde@example.com", to: "office@x.at", subject: "Auftrag" }));
    t.imap("private").addMessage("INBOX", await buildRaw({ from: "oma@example.com", to: "max@x.at", subject: "Geburtstag" }));
    const h = await t.connect(searchEmails.register);
    const res = await h.call("search_emails", { account: "private" });
    expect(res.json.account).toBe("private");
    expect(res.json.messages.map((m: any) => m.subject)).toEqual(["Geburtstag"]);
    await h.close();
  });
});
