import { describe, it, expect } from "vitest";
import { detectProvider, parseAutoconfig, withDetectedEndpoints, type TextFetch } from "../autoconfig.js";
import { PROVIDER_PRESETS } from "../presets.js";

const GMX_LIKE = `<clientConfig version="1.1"><emailProvider id="example.org">
  <domain>example.org</domain><displayName>Example Mail</displayName>
  <incomingServer type="pop3"><hostname>pop.example.org</hostname><port>995</port><socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
  <incomingServer type="imap"><hostname>imap.example.org</hostname><port>143</port><socketType>STARTTLS</socketType><username>%EMAILLOCALPART%</username></incomingServer>
  <incomingServer type="imap"><hostname>imap.example.org</hostname><port>993</port><socketType>SSL</socketType><username>%EMAILLOCALPART%</username></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.%EMAILDOMAIN%</hostname><port>587</port><socketType>STARTTLS</socketType><username>%EMAILADDRESS%</username></outgoingServer>
</emailProvider></clientConfig>`;

const noNetwork = { resolveMx: async () => [], fetch: (async () => ({ status: 404, text: async () => "" })) as TextFetch };

describe("parseAutoconfig", () => {
  it("prefers implicit TLS, substitutes placeholders and detects local-part logins", () => {
    expect(parseAutoconfig(GMX_LIKE, "anna@example.org")).toMatchObject({
      name: "Example Mail",
      imap: { host: "imap.example.org", port: 993, security: "implicit" },
      smtp: { host: "smtp.example.org", port: 587, security: "starttls" },
      usernameStyle: "localpart",
    });
  });

  it("never auto-configures plaintext servers", () => {
    const plain = GMX_LIKE.replace(/STARTTLS|SSL/g, "plain");
    expect(parseAutoconfig(plain, "anna@example.org")).toBeUndefined();
  });

  it("rejects hostnames that are not plain DNS names", () => {
    const evil = GMX_LIKE.replace(/imap\.example\.org/g, "imap.example.org/../x");
    expect(parseAutoconfig(evil, "anna@example.org")).toBeUndefined();
  });
});

describe("detectProvider", () => {
  it("knows big providers by domain without any lookup", async () => {
    const found = await detectProvider("max@gmx.at", { network: false });
    expect(found).toMatchObject({ presetId: "gmx", source: "domain", imap: { host: "imap.gmx.net", port: 993 } });
  });

  it("recognises Microsoft 365 custom domains by MX", async () => {
    const found = await detectProvider("office@firma-beispiel.at", {
      resolveMx: async () => [{ exchange: "firma-beispiel-at.mail.protection.outlook.com", priority: 0 }],
      fetch: noNetwork.fetch,
    });
    expect(found).toMatchObject({ presetId: "microsoft365", auth: "oauth2-microsoft", source: "mx", smtp: { port: 587 } });
  });

  it("recognises Google Workspace by MX", async () => {
    const found = await detectProvider("office@firma.at", {
      resolveMx: async () => [{ exchange: "smtp.google.com", priority: 1 }],
      fetch: noNetwork.fetch,
    });
    expect(found.presetId).toBe("google-workspace");
  });

  it("uses the provider's own autoconfig before Mozilla's ISPDB", async () => {
    const urls: string[] = [];
    const fetch: TextFetch = async (url) => {
      urls.push(url);
      return { status: 200, text: async () => GMX_LIKE };
    };
    const found = await detectProvider("anna@example.org", { resolveMx: async () => [], fetch });
    expect(found.source).toBe("autoconfig");
    expect(urls[0]).toBe("https://autoconfig.example.org/mail/config-v1.1.xml?emailaddress=anna%40example.org");
  });

  it("falls back to a clearly marked guess", async () => {
    const found = await detectProvider("info@kleine-firma.at", noNetwork);
    expect(found).toMatchObject({ source: "guess", imap: { host: "imap.kleine-firma.at" } });
    expect(found.notes[0].de).toMatch(/geraten/);
  });

  it("rejects input that is not an address", async () => {
    await expect(detectProvider("no-at-sign", noNetwork)).rejects.toThrow(/not a valid email/);
  });

  it("keeps preset data consistent with the TLS policy", () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.imap.security === "implicit").toBe(p.imap.port === 993);
      expect(p.smtp.security === "implicit").toBe(p.smtp.port === 465);
    }
  });
});

describe("withDetectedEndpoints (env-only mode)", () => {
  it("fills hosts and ports when only the email is given", async () => {
    const env = await withDetectedEndpoints({ IMAP_MCP_EMAIL: "max@web.de" }, (e) => detectProvider(e, { network: false }));
    expect(env).toMatchObject({
      IMAP_MCP_IMAP_HOST: "imap.web.de",
      IMAP_MCP_IMAP_PORT: "993",
      IMAP_MCP_SMTP_HOST: "smtp.web.de",
      IMAP_MCP_SMTP_PORT: "587",
    });
  });

  it("never overrides an explicit host and never uses guesses", async () => {
    const explicit = { IMAP_MCP_EMAIL: "max@web.de", IMAP_MCP_IMAP_HOST: "mail.example.com" };
    expect(await withDetectedEndpoints(explicit)).toBe(explicit);
    const guessOnly = { IMAP_MCP_EMAIL: "info@kleine-firma.at" };
    expect(await withDetectedEndpoints(guessOnly, (e) => detectProvider(e, noNetwork))).toBe(guessOnly);
  });
});
