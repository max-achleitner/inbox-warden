import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import type { Harness } from "../../__tests__/helpers/mcp-harness.js";
import type { CaptureTransport } from "../../__tests__/helpers/capture-transport.js";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw, header } from "../../__tests__/helpers/messages.js";
import * as sendEmail from "../send-email.js";
import * as sendDraft from "../send-draft.js";

const ME = "max@firma.example";

describe("send_email and send_draft", () => {
  let imap: FakeImap;
  let capture: CaptureTransport;
  let h: Harness;

  beforeEach(async () => {
    const t = createTestApp();
    imap = t.imap();
    capture = t.capture();
    h = await t.connect(sendEmail.register, sendDraft.register);
  });

  afterEach(async () => {
    await h.close();
  });

  it("send_email files a copy in Sent and never transmits the Bcc header", async () => {
    const res = await h.call("send_email", { to: "kunde@example.com", bcc: "chef@example.com", subject: "Hallo", body: "Text" });
    expect(res.isError).toBe(false);
    expect(res.json.sentCopy).toMatchObject({ saved: true, folder: "Sent" });
    expect(header(capture.sent[0].raw, "bcc")).toBeUndefined();
    expect(capture.sent[0].envelope.to).toContain("chef@example.com");
    expect(header(imap.message("Sent", 1)!.raw, "bcc")).toBe("chef@example.com");
  });

  it("send_draft sends the stored draft as reviewed (minus Bcc and client headers) and deletes it", async () => {
    const draftRaw = await buildRaw({
      from: { name: "Maximilian Achleitner", address: ME },
      to: '"Müller, Hans" <hans@example.com>',
      bcc: "archiv@firma.example",
      subject: "Angebot",
      text: "Bitte prüfen.",
      headers: { "X-Mozilla-Draft-Info": "internal/draft; vcard=0" },
    });
    imap.addMessage("Drafts", draftRaw, { flags: ["\\Draft"] });

    const res = await h.call("send_draft", { uid: 1 });
    expect(res.isError).toBe(false);
    const sent = capture.sent[0].raw;
    expect(header(sent, "from")).toBe("Maximilian Achleitner <max@firma.example>");
    expect(header(sent, "bcc")).toBeUndefined();
    expect(header(sent, "x-mozilla-draft-info")).toBeUndefined();
    expect(capture.sent[0].envelope.to.sort()).toEqual(["archiv@firma.example", "hans@example.com"]);
    expect(header(sent, "message-id")).toBe(header(draftRaw, "message-id"));
    expect(res.json.draftDeleted).toBe(true);
    expect(imap.uidsIn("Drafts")).toEqual([]);
    expect(imap.uidsIn("Sent")).toHaveLength(1);
  });

  it("send_draft refuses a draft whose From is not this account", async () => {
    imap.addMessage("Drafts", await buildRaw({ from: "ceo@other.example", to: "x@example.com", subject: "s", text: "t" }));
    const res = await h.call("send_draft", { uid: 1 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Refusing to send/);
    expect(capture.sent).toHaveLength(0);
  });

  it.each([
    ["two From headers (mail clients show the first)", `From: CEO <ceo@bank.example>\r\nFrom: ${ME}\r\n`],
    ["two addresses in one From", `From: ceo@bank.example, ${ME}\r\n`],
  ])("send_draft refuses a draft with %s", async (_name, from) => {
    imap.addMessage("Drafts", `${from}To: x@example.com\r\nSubject: s\r\nMessage-ID: <d1@firma.example>\r\n\r\nt`);
    const res = await h.call("send_draft", { uid: 1 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/one sender.*Refusing to send/);
    expect(capture.sent).toHaveLength(0);
  });

  it("send_draft keeps the draft when the server lacks UIDPLUS and other drafts are marked deleted", async () => {
    imap.capabilities.delete("UIDPLUS");
    imap.addMessage("Drafts", "Subject: old\r\n\r\n", { flags: ["\\Deleted"] });
    imap.addMessage("Drafts", await buildRaw({ from: ME, to: "x@example.com", subject: "s", text: "t" }));
    const res = await h.call("send_draft", { uid: 2 });
    expect(res.isError).toBe(false);
    expect(res.json.draftDeleted).toBe(false);
    expect(res.json.draftNote).toMatch(/was sent/);
    expect(imap.uidsIn("Drafts")).toEqual([1, 2]);
  });

  it("send_draft moves the draft to Trash instead of deleting it when Sent holds no copy", async () => {
    imap.failOn("append", "throw");
    imap.addMessage("Drafts", await buildRaw({ from: ME, to: "x@example.com", subject: "s", text: "t" }));
    const res = await h.call("send_draft", { uid: 1 });
    expect(res.isError).toBe(false);
    expect(res.json.sentCopy).toMatchObject({ saved: false });
    expect(res.json.draftDeleted).toBe(false);
    expect(res.json.draftMovedTo).toBe("Trash");
    expect(imap.uidsIn("Drafts")).toEqual([]);
    expect(imap.uidsIn("Trash")).toHaveLength(1);
  });

  it("send_draft keeps the draft when Sent holds no copy and there is no Trash folder", async () => {
    const bare = new FakeImap();
    bare.addFolder("Drafts", { specialUse: "\\Drafts" });
    bare.addFolder("Sent", { specialUse: "\\Sent" });
    bare.failOn("append", "throw");
    bare.addMessage("Drafts", await buildRaw({ from: ME, to: "x@example.com", subject: "s", text: "t" }));
    const t = createTestApp([{ imap: bare }]);
    const bareHarness = await t.connect(sendDraft.register);
    try {
      const res = await bareHarness.call("send_draft", { uid: 1 });
      expect(res.isError).toBe(false);
      expect(res.json.draftDeleted).toBe(false);
      expect(res.json.draftNote).toMatch(/draft was kept/);
      expect(bare.uidsIn("Drafts")).toEqual([1]);
    } finally {
      await bareHarness.close();
    }
  });

  it("send tools are annotated as destructive and open-world so clients ask before sending", async () => {
    for (const name of ["send_email", "send_draft"]) {
      expect(await h.annotations(name)).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    }
  });
});
