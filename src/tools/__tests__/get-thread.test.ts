import { describe, it, expect } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as getThread from "../get-thread.js";

const ME = "max@firma.example";

async function conversation() {
  const a = await buildRaw({
    from: "Kunde <kunde@example.com>",
    to: ME,
    subject: "Lieferzeit",
    text: "Wann kommt die Ware?",
    messageId: "<a@example.com>",
    date: new Date("2026-01-10T09:00:00Z"),
  });
  const b = await buildRaw({
    from: ME,
    to: "kunde@example.com",
    subject: "Re: Lieferzeit",
    text: "Nächste Woche.\n\nAm 10.01.2026 um 10:00 schrieb Kunde <kunde@example.com>:\n> Wann kommt die Ware?",
    messageId: "<b@firma.example>",
    inReplyTo: "<a@example.com>",
    references: ["<a@example.com>"],
    date: new Date("2026-01-11T09:00:00Z"),
  });
  const c = await buildRaw({
    from: "Kunde <kunde@example.com>",
    to: ME,
    subject: "Re: Lieferzeit",
    text: "Danke!\n\n> Nächste Woche.",
    messageId: "<c@example.com>",
    inReplyTo: "<b@firma.example>",
    references: ["<a@example.com>", "<b@firma.example>"],
    date: new Date("2026-01-12T09:00:00Z"),
  });
  const z = await buildRaw({ from: "x@example.com", to: ME, subject: "Anderes", text: "z", messageId: "<z@example.com>" });
  return { a, b, c, z };
}

describe("get_thread", () => {
  it("collects ancestors and replies across INBOX and Sent, oldest first, without quoted history", async () => {
    const { a, b, c, z } = await conversation();
    const t = createTestApp();
    t.imap().addMessage("INBOX", a);
    t.imap().addMessage("INBOX", z);
    t.imap().addMessage("INBOX", c);
    t.imap().addMessage("Sent", b);
    const h = await t.connect(getThread.register);

    const res = await h.call("get_thread", { uid: 1 }); // start from the first message
    expect(res.isError).toBe(false);
    expect(res.json.messages.map((m: any) => [m.folder, m.messageId])).toEqual([
      ["INBOX", "<a@example.com>"],
      ["Sent", "<b@firma.example>"],
      ["INBOX", "<c@example.com>"],
    ]);
    expect(res.json.messages[1]).toMatchObject({ text: "Nächste Woche.", quotedHistoryRemoved: true });
    expect(res.json.messages[2].text).toBe("Danke!");
    await h.close();
  });

  it("keeps only the newest maxMessages and reports the rest", async () => {
    const { a, b, c } = await conversation();
    const t = createTestApp();
    t.imap().addMessage("INBOX", a);
    t.imap().addMessage("INBOX", c);
    t.imap().addMessage("Sent", b);
    const h = await t.connect(getThread.register);
    const res = await h.call("get_thread", { uid: 2, maxMessages: 2 });
    expect(res.json).toMatchObject({ threadSize: 3, returned: 2, omittedOlder: 1 });
    expect(res.json.messages.map((m: any) => m.messageId)).toEqual(["<b@firma.example>", "<c@example.com>"]);
    await h.close();
  });

  it("uses the Gmail thread id in All Mail and de-duplicates copies", async () => {
    const { a, b, c, z } = await conversation();
    const imap = new FakeImap();
    imap.capabilities.set("X-GM-EXT-1", true);
    imap.addFolder("[Gmail]/All Mail", { specialUse: "\\All" });
    imap.addFolder("[Gmail]/Sent Mail", { specialUse: "\\Sent" });
    imap.addMessage("INBOX", c, { threadId: "t1" });
    imap.addMessage("[Gmail]/All Mail", a, { threadId: "t1" });
    imap.addMessage("[Gmail]/All Mail", b, { threadId: "t1" });
    imap.addMessage("[Gmail]/All Mail", c, { threadId: "t1" });
    imap.addMessage("[Gmail]/All Mail", z, { threadId: "t2" });
    const t = createTestApp([{ imap }]);
    const h = await t.connect(getThread.register);
    const res = await h.call("get_thread", { uid: 1 });
    expect(res.json.messages.map((m: any) => m.messageId)).toEqual(["<a@example.com>", "<b@firma.example>", "<c@example.com>"]);
    expect(imap.callsTo("search").some(([q]) => (q as any).threadId === "t1")).toBe(true);
    await h.close();
  });

  it("returns just the message itself when it has no Message-ID", async () => {
    const t = createTestApp();
    t.imap().addMessage("INBOX", "From: a@example.com\r\nSubject: allein\r\n\r\nhallo");
    const h = await t.connect(getThread.register);
    const res = await h.call("get_thread", { uid: 1 });
    expect(res.json).toMatchObject({ threadSize: 1, returned: 1 });
    expect(res.json.messages[0].text).toBe("hallo");
    await h.close();
  });

  it("reports an unknown extra folder instead of ignoring it", async () => {
    const { a } = await conversation();
    const t = createTestApp();
    t.imap().addMessage("INBOX", a);
    const h = await t.connect(getThread.register);
    const res = await h.call("get_thread", { uid: 1, extraFolders: ["Archiv 2019"] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not exist/);
    await h.close();
  });
});
