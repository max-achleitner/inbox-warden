import { describe, it, expect } from "vitest";
import { FakeImap } from "./fake-imap.js";
import { buildRaw } from "./messages.js";

describe("FakeImap MIME support", () => {
  it("serves a real BODYSTRUCTURE and partial body parts keyed like imapflow", async () => {
    const imap = new FakeImap();
    imap.addMessage("INBOX", await buildRaw({ from: "a@x.com", to: "b@x.com", subject: "s", text: "Hallo Welt", html: "<p>Hallo Welt</p>" }));
    await imap.getMailboxLock("INBOX");
    const msg = (await imap.fetchOne("1", { uid: true, bodyStructure: true, bodyParts: [{ key: "1", start: 0, maxLength: 5 }] })) as any;
    expect(msg.bodyStructure.type).toBe("multipart/alternative");
    expect(msg.bodyStructure.childNodes.map((n: any) => n.part)).toEqual(["1", "2"]);
    expect(msg.bodyParts.get("1").toString()).toBe("Hallo");
  });

  it("supports Gmail-style thread ids in fetch and search", async () => {
    const imap = new FakeImap();
    imap.addMessage("INBOX", "Subject: a\r\n\r\nx", { threadId: "t1" });
    imap.addMessage("INBOX", "Subject: b\r\n\r\ny", { threadId: "t2" });
    await imap.getMailboxLock("INBOX");
    expect(await imap.search({ threadId: "t1" })).toEqual([1]);
    expect(((await imap.fetchOne("2", { uid: true, threadId: true })) as any).threadId).toBe("t2");
    expect(await imap.fetchOne("9", { uid: true })).toBe(false);
  });
});
