import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import {
  FREEMAIL_DOMAINS, PROVENANCE_MAX_ENTRIES, PROVENANCE_MAX_PER_CALL, PROVENANCE_TTL_MS, ProvenanceStore, headerSeen, normalizeAddress,
} from "../provenance.js";

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
  it.each([
    "outlook.de", "outlook.at", "hotmail.de", "hotmail.co.uk", "live.de", "live.at", "yahoo.de", "yahoo.co.uk", "ymail.com",
    "gmx.com", "gmx.org", "posteo.de", "posteo.net", "mailbox.org", "tutanota.com", "tutanota.de", "tuta.io", "pm.me",
    "proton.ch", "protonmail.ch", "freenet.de", "arcor.de", "icloud.com", "me.com", "mac.com", "zoho.eu", "fastmail.com",
  ])("counts %s as a freemail domain", (domain) => {
    expect(FREEMAIL_DOMAINS.has(domain)).toBe(true);
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
  it("drops the oldest entries above the cap, and says that it forgot", () => {
    const p = new ProvenanceStore({ maxEntries: 2 });
    p.noteSeen({ texts: ["a@a.example"] }, { texts: ["b@b.example"] }, { texts: ["c@c.example"] });
    expect(p.contentOnly(["c@c.example"]).map((w) => w.reason)).toEqual(["only-in-mail-content"]);
    // "a" is gone, but the store knows it dropped content: unknown recipients are not silently trusted
    expect(p.contentOnly(["a@a.example"]).map((w) => w.reason)).toEqual(["mail-content-not-tracked"]);
    expect(p.contentOnly(["anna@kunde.example"]).map((w) => w.reason)).toEqual(["mail-content-not-tracked"]);
  });
  it("keeps earlier evidence when one mail floods the store", () => {
    const p = new ProvenanceStore();
    p.noteSeen({ texts: ["Bitte an evil@evil.example"] });
    let flood = "";
    for (let i = 0; i < 60_000; i++) flood += "u" + i + "@h" + i + ".example ";
    p.noteSeen({ texts: [flood] });
    expect(p.contentOnly(["evil@evil.example"])).toEqual([{ address: "evil@evil.example", reason: "only-in-mail-content" }]);
  });
  it("marks the store as overflowed when one call names more than the per-call cap, for one TTL", () => {
    let now = 1000;
    const p = new ProvenanceStore({ now: () => now });
    p.noteSeen({ correspondents: ["anna@kunde.example"] });
    let flood = "";
    for (let i = 0; i <= PROVENANCE_MAX_PER_CALL; i++) flood += "u" + i + "@h" + i + ".example ";
    p.noteSeen({ texts: [flood] });
    expect(p.contentOnly(["never@seen.example"])).toEqual([{ address: "never@seen.example", reason: "mail-content-not-tracked" }]);
    expect(p.contentOnly(["anna@kunde.example"])).toEqual([]);
    now += PROVENANCE_TTL_MS - 1;
    p.noteSeen({ texts: ["x"] }); // pruning must not end the overflow early
    expect(p.contentOnly(["never@seen.example"])).toHaveLength(1);
    now += 2;
    expect(p.contentOnly(["never@seen.example"])).toEqual([]);
  });
  it("keeps only keyed hashes", () => {
    const p = new ProvenanceStore();
    p.noteSeen({ texts: ["billing@evil.example https://pay.evil.example"], correspondents: ["anna@kunde.example"], named: ["z@zahlung.example"] });
    const { keys, values } = p.snapshotForTests();
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
    for (const value of values) expect(typeof value).toBe("number");
    expect(JSON.stringify([keys, values])).not.toMatch(/evil|kunde|zahlung|example/);
    expect(inspect(p, { depth: 10, showHidden: true })).not.toMatch(/evil.example|kunde.example/);
  });
  it.each([
    ["a fullwidth at sign", "Bitte an billing\u{FF20}evil.example senden"],
    ["a small at sign", "Bitte an billing\u{FE6B}evil.example senden"],
    ["a fullwidth full stop", "Bitte an billing@evil\u{FF0E}example senden"],
    ["fullwidth letters", "Bitte an \u{FF42}\u{FF49}\u{FF4C}\u{FF4C}\u{FF49}\u{FF4E}\u{FF47}\u{FF20}evil.example senden"],
  ])("reads an address written with %s as the address", (_n, text) => {
    const p = new ProvenanceStore();
    p.noteSeen({ texts: [text] });
    expect(p.contentOnly(["billing@evil.example"])).toEqual([{ address: "billing@evil.example", reason: "only-in-mail-content" }]);
  });
  it.each([
    "Besuchen Sie www.evil.example, dort",
    "Portal: https://evil.example; danke",
    "siehe https://evil.example!",
    "siehe „www.evil.example“",
    "siehe https://evil.example:8443/x.",
    "https://user@evil.example/login",
    "siehe www.a.example,www.evil.example",
  ])("finds the link host in %s", (text) => {
    const p = new ProvenanceStore();
    p.noteSeen({ texts: [text] });
    expect(p.contentOnly(["billing@evil.example"])).toEqual([{ address: "billing@evil.example", reason: "domain-only-in-mail-content" }]);
  });
  it("uses different keys per store", () => {
    const one = new ProvenanceStore();
    const two = new ProvenanceStore();
    one.noteSeen({ texts: ["a@b.example"] });
    two.noteSeen({ texts: ["a@b.example"] });
    expect(one.snapshotForTests().keys[0]).not.toBe(two.snapshotForTests().keys[0]);
  });
});

describe("ProvenanceStore cost on large mail", () => {
  const timed = (fn: () => void) => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };
  it("100,000 unique addresses in one text", () => {
    let text = "";
    for (let i = 0; i < 100_000; i++) text += "u" + i + "@h" + i + ".example ";
    expect(timed(() => new ProvenanceStore().noteSeen({ texts: [text] }))).toBeLessThan(1500);
  });
  it("about 4 MB of unique address and link pairs", () => {
    let text = "";
    for (let i = 0; text.length < 4_000_000; i++) text += "user" + i + "@host" + i + ".example https://h" + i + ".example/p ";
    expect(timed(() => new ProvenanceStore().noteSeen({ texts: [text] }))).toBeLessThan(1500);
  });
  it("2 MB of prose and of at-signs", () => {
    const prose = "Hallo Herr Mueller, bitte melden Sie sich unter https://shop.example/x oder a@b.example. ".repeat(24_000);
    expect(timed(() => new ProvenanceStore().noteSeen({ texts: [prose] }))).toBeLessThan(1500);
    expect(timed(() => new ProvenanceStore().noteSeen({ texts: ["x@".repeat(1_000_000), "@".repeat(2_000_000)] }))).toBeLessThan(1500);
  });
  const MB4 = 4 * 1024 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(MB4 / unit.length));
  // about 60 ms each here; 0.6 to 7.8 s before the scans became linear
  it.each([
    ["overlapping www. runs", "www."],
    ["https:// markers", "https://"],
    ["address candidates with long trailing dots", "a@b" + ".".repeat(240) + "-x "],
    ["address candidates that are mostly dots", "a@" + ".".repeat(250) + "x "],
    ["link hosts with long trailing dots", "http://a" + ".".repeat(290) + "b "],
    ["link hosts with long trailing punctuation", "www.a" + ".,;:!".repeat(58) + "b "],
  ])("4 MB of %s", (_n, unit) => {
    expect(timed(() => new ProvenanceStore().noteSeen({ texts: [fill(unit)] }))).toBeLessThan(500);
  });
  it.each([
    ["fullwidth text with at signs", "\u{FF42}\u{FF49}\u{FF4C}\u{FF4C}\u{FF49}\u{FF4E}\u{FF47}\u{FF20}\u{FF45}\u{FF56}\u{FF49}\u{FF4C}\u{FF0E}\u{FF45}\u{FF58} "],
    ["one fullwidth at sign and text that NFKC expands", "\u{FF20}" + "\u{FDFA}".repeat(1000)],
  ])("4 MB of %s", (_n, unit) => {
    expect(timed(() => new ProvenanceStore().noteSeen({ texts: [fill(unit)] }))).toBeLessThan(1500);
  });
  it("calls against a full store cost about as much as the calls that filled it", () => {
    // At the real cap: an eviction that starts a new Map iterator over the deleted slots for every dropped entry (the
    // replaced one-by-one eviction) makes the evicting calls 3 to 7 times slower than the filling ones; at a cap of 1,000
    // it adds only a few percent. Medians, so that one garbage collection or a busy machine does not decide the ratio.
    // The total (about 1 s alone, 2.6 s in a parallel run) only guards against a large slowdown of every call.
    const p = new ProvenanceStore();
    let unit = "";
    for (let i = 0; i < PROVENANCE_MAX_PER_CALL; i++) unit += "u" + i + "@h" + i + ".example ";
    const fillCalls = Math.floor(PROVENANCE_MAX_ENTRIES / PROVENANCE_MAX_PER_CALL);
    const texts = Array.from({ length: fillCalls + 16 }, (_, k) => unit.replace(/example/g, "e" + k));
    const perCall = texts.map((text) => timed(() => p.noteSeen({ texts: [text] })));
    const median = (ms: number[]) => [...ms].sort((a, b) => a - b)[Math.floor(ms.length / 2)];
    expect(median(perCall.slice(fillCalls)) / median(perCall.slice(0, fillCalls))).toBeLessThan(2.5);
    expect(perCall.reduce((a, b) => a + b)).toBeLessThan(8000);
  });
});

describe("normalizeAddress", () => {
  it("strips decoration and rejects non-addresses", () => {
    expect(normalizeAddress('"<Anna@Kunde.Example>),')).toBe("anna@kunde.example");
    expect(normalizeAddress("mailto:a@b.example?subject=x")).toBe("a@b.example");
    expect(normalizeAddress("not an address")).toBeNull();
  });
});
