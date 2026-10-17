import { describe, it, expect } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { previewFor } from "../preview.js";

describe("previewFor", () => {
  it("builds previews from partial body fetches, grouped by part key", async () => {
    const imap = new FakeImap();
    imap.addMessage("INBOX", await buildRaw({ from: "a@x.com", to: "b@x.com", subject: "1", text: "Grüße aus Wien, anbei das Angebot." }));
    imap.addMessage(
      "INBOX",
      await buildRaw({
        from: "a@x.com",
        to: "b@x.com",
        subject: "2",
        text: "Bitte Rechnung prüfen",
        html: "<p>Bitte Rechnung prüfen</p>",
        attachments: [{ filename: "r.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" }],
      }),
    );
    imap.addMessage(
      "INBOX",
      Buffer.from(
        "From: n@x.com\r\nSubject: 3\r\nContent-Type: text/html; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<html><head><style>p{color:red}</style></head><body><p>Gr=FC=DFe</p></body></html>",
        "latin1",
      ),
    );
    await imap.getMailboxLock("INBOX");

    const previews = await previewFor(imap.asClient(), [1, 2, 3], 200);
    expect(previews.get(1)).toBe("Grüße aus Wien, anbei das Angebot.");
    expect(previews.get(2)).toBe("Bitte Rechnung prüfen");
    expect(previews.get(3)).toBe("Grüße");

    const partFetches = imap.callsTo("fetch").filter(([, query]) => (query as any).bodyParts);
    expect(partFetches.map(([, query]) => (query as any).bodyParts[0].key).sort()).toEqual(["1", "1", "1.1"]);
  });

  it("returns no preview for messages without a text part", async () => {
    const imap = new FakeImap();
    imap.addMessage("INBOX", "From: a@x.com\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=");
    await imap.getMailboxLock("INBOX");
    expect((await previewFor(imap.asClient(), [1], 200)).size).toBe(0);
  });
});
