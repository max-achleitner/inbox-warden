import { domainToASCII } from "node:url";

/** Lowercase ASCII (punycode) form of a domain, or null when it is not a plausible domain. */
export function normalizeDomain(domain: string): string | null {
  const trimmed = domain.trim().replace(/\.$/, "").toLowerCase();
  if (!trimmed) return null;
  const ascii = domainToASCII(trimmed);
  if (!ascii || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(ascii)) return null;
  return ascii;
}

/** "Example.COM" → "example.com", "*.Müller.de" → "*.xn--mller-kva.de"; null when invalid. */
export function normalizeDomainPattern(pattern: string): string | null {
  const trimmed = pattern.trim().toLowerCase();
  if (trimmed.startsWith("*.")) {
    const domain = normalizeDomain(trimmed.slice(2));
    return domain ? `*.${domain}` : null;
  }
  return normalizeDomain(trimmed);
}

export function domainOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  return normalizeDomain(address.slice(at + 1));
}

/** "*.example.com" matches example.com and every subdomain; "example.com" matches only itself. */
export function domainMatches(domain: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return domain === base || domain.endsWith(`.${base}`);
  }
  return domain === pattern;
}

export interface RecipientRules {
  /** Normalised patterns; when set, only these domains (plus own domains) may receive mail. */
  allowedDomains?: string[];
  /** Normalised patterns that may never receive mail. */
  blockedDomains: string[];
  maxRecipients: number;
  /** Domains of the account's own addresses — always allowed unless explicitly blocked. */
  ownDomains: string[];
}

export type RecipientVerdict =
  | { ok: true; recipients: string[] }
  | { ok: false; rule: string; reason: string };

export function evaluateRecipients(addresses: string[], rules: RecipientRules): RecipientVerdict {
  const recipients = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a !== ""))];
  if (recipients.length === 0) {
    return { ok: false, rule: "send.recipients", reason: "The email has no recipients. Nothing was sent." };
  }
  if (recipients.length > rules.maxRecipients) {
    return {
      ok: false,
      rule: "send.maxRecipients",
      reason: `This email has ${recipients.length} recipients; your policy allows at most ${rules.maxRecipients} per email. Nothing was sent.`,
    };
  }
  for (const address of recipients) {
    const domain = domainOf(address);
    if (!domain) {
      return { ok: false, rule: "send.recipients", reason: `"${address}" is not a valid email address. Nothing was sent.` };
    }
    if (rules.blockedDomains.some((p) => domainMatches(domain, p))) {
      return {
        ok: false,
        rule: "send.blockedRecipientDomains",
        reason: `Sending to ${domain} is blocked by your administrator's policy. Nothing was sent.`,
      };
    }
    const own = rules.ownDomains.includes(domain);
    if (rules.allowedDomains && !own && !rules.allowedDomains.some((p) => domainMatches(domain, p))) {
      return {
        ok: false,
        rule: "send.allowedRecipientDomains",
        reason: `${domain} is not on the list of domains you may send to (${rules.allowedDomains.join(", ")}). Nothing was sent.`,
      };
    }
  }
  return { ok: true, recipients };
}
