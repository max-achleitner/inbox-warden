import { describe, it, expect } from "vitest";
import { decodePartialBody, findPreviewPart, previewText } from "../preview.js";

describe("findPreviewPart", () => {
  it("uses part 1 of a single-part message", () => {
    expect(findPreviewPart({ type: "text/plain", encoding: "7bit", parameters: { charset: "utf-8" } })).toEqual({
      key: "1",
      isHtml: false,
      encoding: "7bit",
      charset: "utf-8",
    });
  });

  it("prefers text/plain inside multipart/alternative and skips attachments", () => {
    const structure = {
      type: "multipart/mixed",
      childNodes: [
        { part: "1", type: "text/plain", disposition: "attachment" },
        {
          part: "2",
          type: "multipart/alternative",
          childNodes: [
            { part: "2.1", type: "text/html", encoding: "base64" },
            { part: "2.2", type: "text/plain", encoding: "quoted-printable", parameters: { charset: "iso-8859-1" } },
          ],
        },
      ],
    };
    expect(findPreviewPart(structure)).toMatchObject({ key: "2.2", isHtml: false, charset: "iso-8859-1" });
  });

  it("falls back to text/html", () => {
    const structure = { type: "multipart/alternative", childNodes: [{ part: "1", type: "text/html" }] };
    expect(findPreviewPart(structure)).toMatchObject({ key: "1", isHtml: true });
  });

  it("returns null when there is no text part", () => {
    expect(findPreviewPart({ type: "multipart/mixed", childNodes: [{ part: "1", type: "image/png" }] })).toBeNull();
  });
});

describe("decodePartialBody", () => {
  it("decodes truncated base64 without throwing", () => {
    const full = Buffer.from("Grüße aus Wien", "utf8").toString("base64");
    expect(decodePartialBody(Buffer.from(full.slice(0, 13)), "base64", "utf-8")).toBe("Grüße a");
    // 4 base64 chars = 3 bytes: "G", "r" and the first byte of "ü" — the broken character is dropped
    expect(decodePartialBody(Buffer.from(full.slice(0, 4)), "base64", "utf-8")).toBe("Gr");
  });

  it("decodes quoted-printable with soft breaks and a cut-off escape", () => {
    expect(decodePartialBody(Buffer.from("Gr=C3=BC=C3=9Fe =\r\naus Wien =C3"), "quoted-printable", "utf-8")).toBe("Grüße aus Wien ");
  });

  it("decodes legacy charsets", () => {
    expect(decodePartialBody(Buffer.from("Gr=FC=DFe", "latin1"), "quoted-printable", "iso-8859-1")).toBe("Grüße");
  });

  it("falls back to utf-8 for unknown charsets", () => {
    expect(decodePartialBody(Buffer.from("Hallo"), "7bit", "x-unknown-charset")).toBe("Hallo");
  });
});

describe("previewText", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(previewText("Hallo\r\n\r\n  Welt, wie geht es?", false, 12)).toBe("Hallo Welt,…");
  });

  it("never shows CSS from a newsletter <head>", () => {
    const html = `<html><head><style>.a{color:red}${".b{margin:0}".repeat(200)}</style></head><body><p>Neue Angebote</p></body></html>`;
    const preview = previewText(html, true, 200);
    expect(preview).toBe("Neue Angebote");
    expect(preview).not.toContain("{");
  });
});
