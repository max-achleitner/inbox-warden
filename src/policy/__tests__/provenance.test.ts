import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { FREEMAIL_DOMAINS, PROVENANCE_TTL_MS, ProvenanceStore, headerSeen, normalizeAddress } from "../provenance.js";

describe("ProvenanceStore", () => {
  it("flags an address named only in mail text", () => {
    const p = new ProvenanceStore();
    p.noteSeen({ texts: ["Bitte die Rechnung an billing@evil.example senden"] });
    expect(p.contentOnly(["Billing@Evil.Example"])).toEqual([{ address: "billing@evil.example", reason: "only-in-mail-content" }]);
  });
  it("never flags a correspondent, even when the text names it too", () => {
    const p = new ProvenanceStore();
    p.noteSeen({ correspondents: ["anna@kunde.example"], texts: ["anna@kunde.example"] });
    expect(p.contentOnly(["anna@kunde.example"])).toEqual([]);
  });
  it("flags an address on a domain that only a link named", () => {
    const p = new ProvenanceStore();
    p.noteSeen({ texts: ["Portal: https://pay.evil.example/login"] });
    expect(p.contentOnly(["billing@evil.example"])).toEqual([{ address: "billing@evil.example", reason: "domain-only-in-mail-content" }]);
  });
  it("finds hosts after www. and ignores ports and paths", () => {
    const p = new ProvenanceStore();
    p.noteSeen({ texts: ["siehe www.portal.evil.example:8080/x?y=1 und fertig"] });
    expect(p.contentOnly(["a@evil.example"])).toHaveLength(1);
  });
  it("does not flag a domain a correspondent writes from", () => {
    const p = new ProvenanceStore();
    p.noteSeen({ correspondents: ["news@mail.shop.example"], texts: ["https://shop.example/angebot"] });
    expect(p.contentOnly(["support@shop.example"])).toEqual([]);
  });
  it("uses the domain rule never for freemail domains", () => {
    const p = new ProvenanceStore();
    p.noteSeen({ texts: ["anna@gmail.com"] });
    expect(p.contentOnly(["bob@gmail.com"])).toEqual([]);
    expect(p.contentOnly(["anna@gmail.com"])).toHaveLength(1);
    expect(FREEMAIL_DOMAINS.has("gmx.at")).toBe(true);
  });
  it("treats a Reply-To on an unrelated domain as mail content", () => {
    const p = new ProvenanceStore();
    p.noteSeen(headerSeen({ from: [{ address: "rechnung@lieferant.example" }], replyTo: [{ address: "zahlung@lieferant-pay.example" }] }));
    expect(p.contentOnly(["zahlung@lieferant-pay.example"])).toHaveLength(1);
    p.noteSeen(headerSeen({ from: [{ address: "rechnung@lieferant.example" }], replyTo: [{ address: "buchhaltung@zahlung.lieferant.example" }] }));
    expect(p.contentOnly(["buchhaltung@zahlung.lieferant.example"])).toEqual([]);
  });
  it("treats different spellings as one address", () => {
    const p = new ProvenanceStore();
    p.noteSeen({ texts: ["mailto:Billing@Evil.Example?subject=Rechnung", "Schreiben Sie an <kasse@evil.example>.", "rechnung@müller.example"] });
    expect(p.contentOnly(["billing@evil.example", "KASSE@evil.example", "rechnung@xn--mller-kva.example"]).map((w) => w.address))
      .toEqual(["billing@evil.example", "kasse@evil.example", "rechnung@xn--mller-kva.example"]);
  });
  it("forgets after 24 hours", () => {
    let now = 0;
    const p = new ProvenanceStore({ now: () => now });
    p.noteSeen({ texts: ["billing@evil.example"] });
    now = PROVENANCE_TTL_MS + 1;
    expect(p.contentOnly(["billing@evil.example"])).toEqual([]);
  });
  it("drops the oldest entries above the cap", () => {
    const p = new ProvenanceStore({ maxEntries: 2 });
    p.noteSeen({ texts: ["a@a.example"] }, { texts: ["b@b.example"] }, { texts: ["c@c.example"] });
    expect(p.contentOnly(["a@a.example", "c@c.example"]).map((w) => w.address)).toEqual(["c@c.example"]);
  });
  it("keeps no address or domain in clear text", () => {
    const p = new ProvenanceStore();
    p.noteSeen({ texts: ["billing@evil.example https://pay.evil.example"], correspondents: ["anna@kunde.example"] });
    expect(inspect(p, { depth: 10, showHidden: true })).not.toMatch(/evil\.example|kunde\.example/);
  });
  it("handles megabytes of text without blowing up", () => {
    const p = new ProvenanceStore();
    const start = Date.now();
    p.noteSeen({ texts: ["@".repeat(2_000_000), "a".repeat(2_000_000), "http://".repeat(300_000), "x@".repeat(500_000)] });
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe("normalizeAddress", () => {
  it("strips decoration and rejects non-addresses", () => {
    expect(normalizeAddress('"<Anna@Kunde.Example>),')).toBe("anna@kunde.example");
    expect(normalizeAddress("mailto:a@b.example?subject=x")).toBe("a@b.example");
    expect(normalizeAddress("not an address")).toBeNull();
  });
});
