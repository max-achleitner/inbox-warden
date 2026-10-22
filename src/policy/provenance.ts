import { createHmac, randomBytes } from "node:crypto";
import { domainSuffixes, normalizeDomain, relatedDomains } from "./recipients.js";

export type RecipientWarningReason = "only-in-mail-content" | "domain-only-in-mail-content";

export interface SeenMail {
  /** Returned text, subjects, display names, file names: addresses and link hosts in them count as mail content. */
  texts?: string[];
  /** From, To, Cc, Reply-To on a related domain. */
  correspondents?: string[];
  /** Reply-To on an unrelated domain: mail content. */
  named?: string[];
}

export interface ContentOnlyRecipient {
  address: string;
  reason: RecipientWarningReason;
}

export interface ProvenanceChannel {
  noteSeen(...seen: SeenMail[]): void;
  contentOnly(recipients: string[]): ContentOnlyRecipient[];
}

/** Fits imapflow envelope entries and reply.ts Mailbox. */
export interface AddressLike {
  name?: string;
  address?: string;
}

export const PROVENANCE_TTL_MS = 24 * 60 * 60 * 1000;
/** Per set. */
export const PROVENANCE_MAX_ENTRIES = 50_000;

/** Domains many unrelated people share: a link or address on them says nothing about other addresses there. */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com",
  "me.com", "mac.com", "aol.com", "gmx.at", "gmx.de", "gmx.net", "gmx.ch", "web.de", "t-online.de", "proton.me",
  "protonmail.com", "mail.com", "yandex.com", "zoho.com", "aon.at", "a1.net",
]);

const MAX_LOCAL = 64;
const MAX_DOMAIN = 253;
const MAX_HOST_RUN = 300;

/**
 * Lower-case form of an address as it appears in mail: "mailto:" prefix, "?subject=…", angle brackets,
 * quotes and trailing punctuation are removed, the domain becomes punycode. Null when it is no address.
 */
export function normalizeAddress(raw: string): string | null {
  let s = raw.trim();
  if (s.length > MAX_LOCAL + MAX_DOMAIN + 2) return null;
  if (s.slice(0, 7).toLowerCase() === "mailto:") s = s.slice(7);
  const query = s.indexOf("?");
  if (query >= 0) s = s.slice(0, query);
  s = s.replace(/^[\s<>"'(\[]+/, "").replace(/[\s<>"')\]\.,;:]+$/, "");
  const at = s.lastIndexOf("@");
  if (at <= 0 || at > MAX_LOCAL) return null;
  const local = s.slice(0, at);
  if (/[\s<>"(),;:\\@\[\]]/.test(local)) return null;
  const domain = normalizeDomain(s.slice(at + 1));
  return domain ? `${local.toLowerCase()}@${domain}` : null;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

function isWord(code: number, ch: string): boolean {
  if (code < 128) return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return WORD_CHAR.test(ch);
}

function isLocalChar(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  // . _ % + - '
  return c === 46 || c === 95 || c === 37 || c === 43 || c === 45 || c === 39 || isWord(c, text[i]);
}

function isDomainChar(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  return c === 46 || c === 45 || isWord(c, text[i]);
}

/** Addresses in free text, in one pass with bounded work per "@" (mail text can be megabytes). */
function addressesIn(text: string): string[] {
  const found: string[] = [];
  let at = text.indexOf("@");
  while (at !== -1) {
    let start = at;
    while (start > 0 && at - start < MAX_LOCAL && isLocalChar(text, start - 1)) start--;
    let end = at + 1;
    while (end < text.length && end - at <= MAX_DOMAIN && isDomainChar(text, end)) end++;
    if (start < at && end > at + 1) {
      const address = normalizeAddress(text.slice(start, end).replace(/^[.'\-]+/, ""));
      if (address) found.push(address);
    }
    at = text.indexOf("@", at + 1);
  }
  return found;
}

const HOST_END = /[\s\/?#<>"'\\)\]]/;

function hostFrom(run: string): string | null {
  // user:password@host:port
  const afterUser = run.slice(run.lastIndexOf("@") + 1);
  return normalizeDomain(afterUser.replace(/:\d*$/, "").replace(/^\.+/, "").replace(/\.+$/, ""));
}

/** Hosts of http(s):// and www. links in free text. */
function linkHostsIn(text: string): string[] {
  const lower = text.toLowerCase();
  const hosts: string[] = [];
  for (const marker of ["http://", "https://", "www."]) {
    let from = lower.indexOf(marker);
    while (from !== -1) {
      const start = from + (marker === "www." ? 0 : marker.length);
      let end = start;
      while (end < lower.length && end - start < MAX_HOST_RUN && !HOST_END.test(lower[end])) end++;
      const host = hostFrom(lower.slice(start, end));
      if (host) hosts.push(host);
      from = lower.indexOf(marker, from + marker.length);
    }
  }
  return hosts;
}

/** The headers of one message, split into who the mail came from and what it merely names. */
export function headerSeen(h: { from?: AddressLike[]; replyTo?: AddressLike[]; to?: AddressLike[]; cc?: AddressLike[] }): SeenMail {
  const clean = (list: AddressLike[] | undefined) =>
    (list ?? []).map((a) => (a.address ? normalizeAddress(a.address) : null)).filter((a): a is string => a !== null);
  const from = clean(h.from);
  const fromDomains = from.map((a) => a.slice(a.lastIndexOf("@") + 1));
  const correspondents = [...from, ...clean(h.to), ...clean(h.cc)];
  const named: string[] = [];
  for (const address of clean(h.replyTo)) {
    const domain = address.slice(address.lastIndexOf("@") + 1);
    (fromDomains.some((d) => relatedDomains(d, domain)) ? correspondents : named).push(address);
  }
  return { correspondents, named };
}

type HashSet = Map<string, number>;

/**
 * Which addresses and domains appeared in mail Claude read, and in what role. In memory only, keyed
 * hashes only (HMAC-SHA256 with a random key per process): nothing here can be turned back into an address.
 */
export class ProvenanceStore implements ProvenanceChannel {
  readonly #key = randomBytes(32);
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #correspondentAddresses: HashSet = new Map();
  readonly #correspondentDomains: HashSet = new Map();
  readonly #contentAddresses: HashSet = new Map();
  readonly #contentDomains: HashSet = new Map();

  constructor(options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? PROVENANCE_TTL_MS;
    this.#maxEntries = options.maxEntries ?? PROVENANCE_MAX_ENTRIES;
  }

  noteSeen(...seen: SeenMail[]): void {
    const now = this.#now();
    for (const set of this.#sets()) this.#prune(set, now);
    for (const s of seen) {
      for (const raw of s.correspondents ?? []) {
        const address = normalizeAddress(raw);
        if (address) this.#addAddress(address, this.#correspondentAddresses, this.#correspondentDomains, now);
      }
      for (const raw of s.named ?? []) {
        const address = normalizeAddress(raw);
        if (address) this.#addAddress(address, this.#contentAddresses, this.#contentDomains, now);
      }
      for (const text of s.texts ?? []) {
        if (!text) continue;
        for (const address of addressesIn(text)) this.#addAddress(address, this.#contentAddresses, this.#contentDomains, now);
        for (const host of linkHostsIn(text)) for (const d of domainSuffixes(host)) this.#add(this.#contentDomains, d, now);
      }
    }
  }

  contentOnly(recipients: string[]): ContentOnlyRecipient[] {
    const now = this.#now();
    const out: ContentOnlyRecipient[] = [];
    const done = new Set<string>();
    for (const raw of recipients) {
      const address = normalizeAddress(raw);
      if (!address || done.has(address)) continue;
      done.add(address);
      if (this.#has(this.#correspondentAddresses, address, now)) continue;
      if (this.#has(this.#contentAddresses, address, now)) {
        out.push({ address, reason: "only-in-mail-content" });
        continue;
      }
      const domain = address.slice(address.lastIndexOf("@") + 1);
      if (
        this.#has(this.#contentDomains, domain, now) &&
        !this.#has(this.#correspondentDomains, domain, now) &&
        !FREEMAIL_DOMAINS.has(domain)
      ) {
        out.push({ address, reason: "domain-only-in-mail-content" });
      }
    }
    return out;
  }

  #sets(): HashSet[] {
    return [this.#correspondentAddresses, this.#correspondentDomains, this.#contentAddresses, this.#contentDomains];
  }

  #hash(value: string): string {
    return createHmac("sha256", this.#key).update(value).digest("hex");
  }

  #addAddress(address: string, addresses: HashSet, domains: HashSet, now: number): void {
    this.#add(addresses, address, now);
    for (const d of domainSuffixes(address.slice(address.lastIndexOf("@") + 1))) this.#add(domains, d, now);
  }

  #add(set: HashSet, value: string, now: number): void {
    const key = this.#hash(value);
    set.delete(key); // a new sighting moves the entry to the back
    set.set(key, now);
    while (set.size > this.#maxEntries) set.delete(set.keys().next().value as string);
  }

  #has(set: HashSet, value: string, now: number): boolean {
    const key = this.#hash(value);
    const seen = set.get(key);
    if (seen === undefined) return false;
    if (now - seen > this.#ttlMs) {
      set.delete(key);
      return false;
    }
    return true;
  }

  /** Entries are ordered by last sighting, so the expired ones are at the front. */
  #prune(set: HashSet, now: number): void {
    for (const [key, seen] of set) {
      if (now - seen <= this.#ttlMs) break;
      set.delete(key);
    }
  }
}
