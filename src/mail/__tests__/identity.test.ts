import { describe, it, expect } from "vitest";
import { fromHeader, withSignature } from "../identity.js";

describe("identity helpers", () => {
  it("formats the sender with a display name when configured", () => {
    expect(fromHeader({ email: "max@firma.example", name: "Maximilian Achleitner" })).toEqual({
      name: "Maximilian Achleitner",
      address: "max@firma.example",
    });
    expect(fromHeader({ email: "max@firma.example" })).toBe("max@firma.example");
  });

  it("appends the plain signature after the standard separator and converts it for HTML", () => {
    const identity = { email: "max@firma.example", signature: "Max Achleitner\nTel. 0123 456789" };
    const out = withSignature({ text: "Hallo Hans,\n\nanbei.\n", html: "<p>Hallo Hans,</p>" }, identity, true);
    expect(out.text).toBe("Hallo Hans,\n\nanbei.\n\n-- \nMax Achleitner\nTel. 0123 456789");
    expect(out.html).toBe("<p>Hallo Hans,</p><br><br>-- <br>Max Achleitner<br>Tel. 0123 456789");
  });

  it("derives the text signature from an HTML-only signature", () => {
    const out = withSignature({ text: "Hi" }, { email: "a@b.at", signatureHtml: "<b>Firma</b> GmbH" }, true);
    expect(out.text).toBe("Hi\n\n-- \nFirma GmbH");
  });

  it("leaves the body untouched when disabled or when no signature exists", () => {
    const body = { text: "Hi" };
    expect(withSignature(body, { email: "a@b.at", signature: "S" }, false)).toBe(body);
    expect(withSignature(body, { email: "a@b.at" }, true)).toBe(body);
  });
});
