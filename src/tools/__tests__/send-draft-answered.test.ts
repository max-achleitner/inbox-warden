import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as sendDraft from "../send-draft.js";

const ME = "max@firma.example";

async function setup(policy: Record<string, unknown> = {}) {
  const t = createTestApp([{ policy }]);
  const imap = t.imap();
  imap.addFolder("Kunden");
  const original = await buildRaw({ from: "kunde@example.com", to: ME, subject: "Frage", text: "?", messageId: "<frage-1@example.com>" });
  const reply = await buildRaw({
    from: ME,
    to: "kunde@example.com",
    subject: "Re: Frage",
    text: "Antwort",
    inReplyTo: "<frage-1@example.com>",
    references: ["<frage-1@example.com>"],
  });
  imap.addMessage("Drafts", reply, { flags: ["\\Draft"] });
  return { t, imap, original, h: await t.connect(sendDraft.register) };
}

describe("send_draft marks the original as answered", () => {
  it("finds the original in INBOX", async () => {
    const { imap, original, h } = await setup();
    imap.addMessage("INBOX", original);
    const res = await h.call("send_draft", { uid: 1 });
    expect(res.isError).toBe(false);
    expect(res.json.originalMarkedAnswered).toEqual({ folder: "INBOX", uid: 1 });
    expect(imap.message("INBOX", 1)!.flags.has("\\Answered")).toBe(true);
    await h.close();
  });

  it("looks in originalFolder first", async () => {
    const { imap, original, h } = await setup();
    imap.addMessage("Kunden", original);
    const res = await h.call("send_draft", { uid: 1, originalFolder: "kunden" });
    expect(res.json.originalMarkedAnswered).toEqual({ folder: "Kunden", uid: 1 });
    await h.close();
  });

  it("never opens or flags a folder the policy hides, INBOX included", async () => {
    const { t, imap, original, h } = await setup({ folders: { deny: ["INBOX", "Kunden"] } });
    imap.addMessage("INBOX", original);
    imap.addMessage("Kunden", original);
    const res = await h.call("send_draft", { uid: 1, originalFolder: "Kunden" });
    expect(res.isError).toBe(false);
    expect(t.capture().sent).toHaveLength(1);
    expect(res.json.originalMarkedAnswered).toBe(false);
    expect(imap.message("INBOX", 1)!.flags.has("\\Answered")).toBe(false);
    expect(imap.message("Kunden", 1)!.flags.has("\\Answered")).toBe(false);
    expect(imap.callsTo("getMailboxLock").map(([path]) => path)).not.toContain("INBOX");
    await h.close();
  });

  it("still succeeds when the original cannot be found or the folder name is wrong", async () => {
    const { t, h } = await setup();
    const res = await h.call("send_draft", { uid: 1, originalFolder: "Gibt es nicht" });
    expect(res.isError).toBe(false);
    expect(res.json.originalMarkedAnswered).toBe(false);
    expect(t.capture().sent).toHaveLength(1);
    await h.close();
  });
});
