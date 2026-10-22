import { describe, it, expect } from "vitest";
import { domainMatches, domainSuffixes, evaluateRecipients, normalizeDomainPattern, relatedDomains } from "../recipients.js";

const base = { blockedDomains: [], maxRecipients: 20, ownDomains: ["firma.example"] };

describe("recipient rules", () => {
  it("normalises domain patterns (case, trailing dot, IDN)", () => {
    expect(normalizeDomainPattern("Example.COM.")).toBe("example.com");
    expect(normalizeDomainPattern("*.Müller.de")).toBe("*.xn--mller-kva.de");
    expect(normalizeDomainPattern("not a domain")).toBeNull();
  });

  it("*.example.com covers the domain and subdomains but not lookalikes", () => {
    expect(domainMatches("example.com", "*.example.com")).toBe(true);
    expect(domainMatches("mail.example.com", "*.example.com")).toBe(true);
    expect(domainMatches("evil-example.com", "*.example.com")).toBe(false);
    expect(domainMatches("example.com.evil.io", "*.example.com")).toBe(false);
    expect(domainMatches("mail.example.com", "example.com")).toBe(false);
  });

  it("blocks a blocked domain regardless of address case", () => {
    const verdict = evaluateRecipients(["Boss@GMAIL.com"], { ...base, blockedDomains: ["gmail.com"] });
    expect(verdict).toMatchObject({ ok: false, rule: "send.blockedRecipientDomains" });
  });

  it("allows only listed domains plus the account's own domains", () => {
    const rules = { ...base, allowedDomains: ["*.kunde.at"] };
    expect(evaluateRecipients(["a@shop.kunde.at", "kollege@firma.example"], rules)).toMatchObject({ ok: true });
    expect(evaluateRecipients(["a@kunde.at.evil.io"], rules)).toMatchObject({ ok: false, rule: "send.allowedRecipientDomains" });
  });

  it("matches IDN recipients against punycode patterns", () => {
    const rules = { ...base, blockedDomains: ["xn--mller-kva.de"] };
    expect(evaluateRecipients(["hans@müller.de"], rules)).toMatchObject({ ok: false });
  });

  it("counts unique recipients against maxRecipients", () => {
    const rules = { ...base, maxRecipients: 2 };
    expect(evaluateRecipients(["a@x.com", "A@X.com", "b@x.com"], rules)).toMatchObject({ ok: true });
    expect(evaluateRecipients(["a@x.com", "b@x.com", "c@x.com"], rules)).toMatchObject({ ok: false, rule: "send.maxRecipients" });
  });

  it("rejects addresses without a domain", () => {
    expect(evaluateRecipients(["undisclosed-recipients:"], base)).toMatchObject({ ok: false, rule: "send.recipients" });
  });
});

describe("related domains", () => {
  it("relates a domain to its parents and children only", () => {
    expect(relatedDomains("mail.shop.example", "shop.example")).toBe(true);
    expect(relatedDomains("shop.example", "mail.shop.example")).toBe(true);
    expect(relatedDomains("shop.example", "shop-pay.example")).toBe(false);
  });
  it("lists a domain and its parents with at least two labels", () => {
    expect(domainSuffixes("a.b.example")).toEqual(["a.b.example", "b.example"]);
    expect(domainSuffixes("example")).toEqual([]);
  });
});
