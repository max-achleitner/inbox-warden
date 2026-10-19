import { describe, it, expect } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { gmailFakeImap } from "../../__tests__/helpers/test-app.js";
import { markOriginalAnswered } from "../answered.js";
import { UNSCOPED } from "../../imap/strict.js";
import { LabelLock } from "../../policy/label-lock.js";

describe("markOriginalAnswered", () => {
  it("flags the original found by Message-ID", async () => {
    const imap = new FakeImap();
    imap.addFolder("Kunden");
    imap.addMessage("Kunden", await buildRaw({ from: "k@x.com", to: "me@x.com", subject: "q", text: "?", messageId: "<q-1@x.com>" }));
    expect(await markOriginalAnswered(imap.asClient(), "<q-1@x.com>", ["INBOX", "Kunden"], UNSCOPED)).toEqual({ folder: "Kunden", uid: 1 });
    expect(imap.message("Kunden", 1)!.flags.has("\\Answered")).toBe(true);
  });

  it("returns false when nothing matches or there is no In-Reply-To", async () => {
    const imap = new FakeImap();
    expect(await markOriginalAnswered(imap.asClient(), "<nope@x.com>", ["INBOX", "Missing"], UNSCOPED)).toBe(false);
    expect(await markOriginalAnswered(imap.asClient(), undefined, ["INBOX"], UNSCOPED)).toBe(false);
  });

  it("never touches an original that carries a hidden Gmail label, nor anything when labels cannot be read", async () => {
    const imap = gmailFakeImap(["_NDA_Inbox"]);
    imap.addGmailMessage(await buildRaw({ from: "k@x.com", to: "me@x.com", subject: "q", text: "?", messageId: "<q-1@x.com>" }), ["\\Inbox", "_NDA_Inbox"]);
    const scope = new LabelLock({ deny: ["_NDA_Inbox"] });
    expect(await markOriginalAnswered(imap.asClient(), "<q-1@x.com>", ["INBOX"], scope)).toBe(false);
    imap.message("INBOX", 1)!.labels!.delete("_NDA_Inbox");
    imap.failOn("labels", "false");
    expect(await markOriginalAnswered(imap.asClient(), "<q-1@x.com>", ["INBOX"], scope)).toBe(false);
    expect(imap.message("INBOX", 1)!.flags.has("\\Answered")).toBe(false);
    expect(await markOriginalAnswered(imap.asClient(), "<q-1@x.com>", ["INBOX"], scope)).toEqual({ folder: "INBOX", uid: 1 });
  });
});
