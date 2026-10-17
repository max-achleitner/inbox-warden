import { describe, it, expect } from "vitest";
import { mimeTree } from "./mime-tree.js";
import { buildRaw } from "./messages.js";

describe("mimeTree", () => {
  it("treats a single-part message as part 1", async () => {
    const tree = mimeTree(await buildRaw({ from: "a@x.com", to: "b@x.com", subject: "s", text: "Hallo Welt" }));
    expect(tree.structure).toMatchObject({ part: "1", type: "text/plain", parameters: { charset: "utf-8" } });
    expect(tree.parts.get("1")!.toString()).toContain("Hallo Welt");
  });

  it("numbers nested multipart children like IMAP", async () => {
    const raw = await buildRaw({
      from: "a@x.com",
      to: "b@x.com",
      subject: "s",
      text: "Text",
      html: "<p>Text</p>",
      attachments: [{ filename: "a.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" }],
    });
    const { structure, parts } = mimeTree(raw);
    expect(structure.type).toBe("multipart/mixed");
    expect(structure.part).toBeUndefined();
    const [alternative, attachment] = structure.childNodes!;
    expect(alternative).toMatchObject({ part: "1", type: "multipart/alternative" });
    expect(alternative.childNodes!.map((n) => [n.part, n.type])).toEqual([
      ["1.1", "text/plain"],
      ["1.2", "text/html"],
    ]);
    expect(attachment).toMatchObject({ part: "2", type: "application/pdf", disposition: "attachment", encoding: "base64" });
    expect(Buffer.from(parts.get("2")!.toString(), "base64").toString()).toBe("%PDF");
  });
});
