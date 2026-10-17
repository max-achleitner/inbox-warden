import { describe, it, expect } from "vitest";
import { getHeader, removeHeaders, rfc5322Date, setHeader } from "../headers.js";

const raw = Buffer.from(
  [
    "From: Max <max@example.com>",
    "To: kunde@example.com",
    "Bcc: chef@example.com,",
    " buchhaltung@example.com",
    "Subject: =?UTF-8?Q?Gr=C3=B6=C3=9Fe?=",
    "X-Mozilla-Draft-Info: internal/draft; vcard=0",
    "",
    "Body line",
    "Bcc: this is body text, not a header",
  ].join("\r\n"),
);

describe("header utilities", () => {
  it("removes a folded Bcc header completely and leaves the body untouched", () => {
    const out = removeHeaders(raw, ["bcc", "X-Mozilla-Draft-Info"]).toString();
    expect(out).not.toMatch(/chef@example\.com/);
    expect(out).not.toMatch(/buchhaltung@example\.com/);
    expect(out).not.toMatch(/X-Mozilla/);
    expect(out).toContain("\r\n\r\nBody line\r\nBcc: this is body text, not a header");
  });

  it("reads an unfolded header value", () => {
    expect(getHeader(raw, "bcc")).toBe("chef@example.com, buchhaltung@example.com");
    expect(getHeader(raw, "Message-ID")).toBeUndefined();
  });

  it("sets a header and strips CR/LF from the value", () => {
    const out = setHeader(raw, "Date", "Wed, 14 Oct 2026 19:00:00 +0000\r\nBcc: evil@x.com");
    expect(getHeader(out, "date")).toBe("Wed, 14 Oct 2026 19:00:00 +0000 Bcc: evil@x.com");
    expect(out.toString().match(/^Bcc:/gm)).toHaveLength(2); // original folded Bcc + the one in the body
  });

  it("handles LF-only messages", () => {
    const lf = Buffer.from("From: a@b.c\nBcc: x@y.z\n\nbody\n");
    expect(removeHeaders(lf, ["bcc"]).toString()).toBe("From: a@b.c\n\nbody\n");
  });

  it("preserves 8-bit bytes byte-for-byte", () => {
    const eight = Buffer.concat([Buffer.from("Subject: "), Buffer.from("Größe", "utf8"), Buffer.from("\r\nBcc: x@y.z\r\n\r\nbody")]);
    const out = removeHeaders(eight, ["bcc"]);
    expect(out.toString("utf8")).toBe("Subject: Größe\r\n\r\nbody");
  });

  it("formats RFC 5322 dates", () => {
    expect(rfc5322Date(new Date("2026-10-14T19:00:00Z"))).toBe("Wed, 14 Oct 2026 19:00:00 +0000");
  });
});
