import { createHmac, randomBytes } from "node:crypto";
import { domainSuffixes, normalizeDomain, relatedDomains } from "./recipients.js";

/** "mail-content-not-tracked": the store overflowed (see ProvenanceStore), so any recipient that is no correspondent may come from mail content. */
export type RecipientWarningReason = "only-in-mail-content" | "domain-only-in-mail-content" | "mail-content-not-tracked";

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
/** Unique addresses (and link hosts) one noteSeen call stores per kind; more makes the store overflow. */
export const PROVENANCE_MAX_PER_CALL = 5_000;

/** Domains many unrelated people share: a link or address on them says nothing about other addresses there. */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.de", "outlook.at", "hotmail.com", "hotmail.de", "hotmail.co.uk",
  "live.com", "live.de", "live.at", "msn.com", "yahoo.com", "yahoo.de", "yahoo.co.uk", "ymail.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "gmx.at", "gmx.de", "gmx.net", "gmx.ch", "gmx.com", "gmx.org", "web.de", "t-online.de",
  "freenet.de", "arcor.de", "posteo.de", "posteo.net", "mailbox.org", "tutanota.com", "tutanota.de", "tuta.io",
  "proton.me", "protonmail.com", "protonmail.ch", "proton.ch", "pm.me", "mail.com", "yandex.com", "zoho.com", "zoho.eu",
  "fastmail.com", "aon.at", "a1.net",
]);

const MAX_LOCAL = 64;
const MAX_DOMAIN = 253;
const MAX_HOST_RUN = 300;

const SPACE = /\s/;

/**
 * Removes whitespace and the given characters from both ends. A loop, because a trailing [...]+$ regex
 * is quadratic on long runs of the trimmed characters.
 */
function trimChars(s: string, leading: string, trailing: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && (leading.includes(s[start]) || SPACE.test(s[start]))) start++;
  while (end > start && (trailing.includes(s[end - 1]) || SPACE.test(s[end - 1]))) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

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
  s = trimChars(s, `<>"'([`, `<>"')].,;:`);
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

/**
 * Candidate addresses in free text, in one pass with bounded work per "@" (mail text can be megabytes).
 * `emit` returns false to stop scanning.
 */
function addressesIn(text: string, emit: (candidate: string) => boolean): void {
  let at = text.indexOf("@");
  while (at !== -1) {
    let start = at;
    while (start > 0 && at - start < MAX_LOCAL && isLocalChar(text, start - 1)) start--;
    let end = at + 1;
    while (end < text.length && end - at <= MAX_DOMAIN && isDomainChar(text, end)) end++;
    // a domain needs a dot: cheap rejection of "x@x@x@…" before any normalising
    if (start < at && end > at + 1 && text.slice(at + 1, end).includes(".")) {
      if (!emit(trimChars(text.slice(start, end), ".'-", ""))) return;
    }
    at = text.indexOf("@", at + 1);
  }
}

/**
 * Characters of "user:password@host:port" as links write them: letters and digits (any script), "." "-" "_" "~" "%"
 * ":" "@". Anything else (a comma or quote after the link, a path) ends the host.
 */
function isHostRunChar(text: string, i: number): boolean {
  const c = text.charCodeAt(i);
  // . - _ ~ % : @
  return c === 46 || c === 45 || c === 95 || c === 126 || c === 37 || c === 58 || c === 64 || isWord(c, text[i]);
}

function hostFrom(run: string): string | null {
  // user:password@host:port
  let host = run.slice(run.lastIndexOf("@") + 1);
  const colon = host.lastIndexOf(":");
  if (colon >= 0) {
    let k = colon + 1;
    while (k < host.length && host.charCodeAt(k) >= 48 && host.charCodeAt(k) <= 57) k++;
    if (k === host.length) host = host.slice(0, colon);
  }
  host = trimChars(host, ".", ".");
  // cheap rejection before IDNA: a host needs a dot
  return host.includes(".") ? normalizeDomain(host) : null;
}

/**
 * Hosts of http(s):// and www. links in free text. Each search resumes after the run it just read, so overlapping
 * markers ("www.www.www.…") cost nothing extra; a host inside a run is a suffix of the run's host anyway.
 */
function linkHostsIn(text: string, emit: (host: string) => boolean): void {
  const lower = text.toLowerCase();
  for (const marker of ["http://", "https://", "www."]) {
    let from = lower.indexOf(marker);
    while (from !== -1) {
      const start = from + (marker === "www." ? 0 : marker.length);
      let end = start;
      while (end < lower.length && end - start < MAX_HOST_RUN && isHostRunChar(lower, end)) end++;
      const host = hostFrom(lower.slice(start, end));
      if (host && !emit(host)) return;
      from = lower.indexOf(marker, Math.max(end, from + marker.length));
    }
  }
}

/** Compatibility forms that can spell an address or host: fullwidth and small forms, the one-dot leader. */
const COMPATIBILITY_FORM = /[\u{2024}\u{FE50}-\u{FE6F}\u{FF00}-\u{FFEF}]/u;
const COMPATIBILITY_FORMS = new RegExp(COMPATIBILITY_FORM.source, "gu");
const compatibilityForm = new Map<string, string>();

/**
 * NFKC for the compatibility forms, so a fullwidth or small at sign (U+FF20, U+FE6B) counts as "@" and a fullwidth
 * full stop (U+FF0E) as ".". Character by character and only when such a form occurs: NFKC on the whole text
 * could make it up to 18 times longer (U+FDFA).
 */
function withCompatibilityForms(text: string): string {
  if (!COMPATIBILITY_FORM.test(text)) return text;
  return text.replace(COMPATIBILITY_FORMS, (ch) => {
    let mapped = compatibilityForm.get(ch);
    if (mapped === undefined) compatibilityForm.set(ch, (mapped = ch.normalize("NFKC")));
    return mapped;
  });
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
  #overflowUntil = 0;

  constructor(options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? PROVENANCE_TTL_MS;
    this.#maxEntries = options.maxEntries ?? PROVENANCE_MAX_ENTRIES;
  }

  noteSeen(...seen: SeenMail[]): void {
    const now = this.#now();
    for (const set of this.#sets()) this.#prune(set, now);

    // Unique candidates per kind, capped per call: a flood fills the cap, it never pushes older evidence out.
    let over = false;
    const correspondents = new Set<string>();
    const named = new Set<string>();
    const hosts = new Set<string>();
    const take = (sink: Set<string>, value: string): boolean => {
      if (sink.has(value)) return true;
      if (sink.size >= PROVENANCE_MAX_PER_CALL) {
        over = true;
        return false;
      }
      sink.add(value);
      return true;
    };
    const rawSeen = new Set<string>();
    let addressesFull = false;
    let hostsFull = false;
    for (const s of seen) {
      for (const raw of s.correspondents ?? []) {
        const address = normalizeAddress(raw);
        if (address) take(correspondents, address);
      }
      for (const raw of s.named ?? []) {
        const address = normalizeAddress(raw);
        if (address) take(named, address);
      }
      for (const original of s.texts ?? []) {
        if (!original) continue;
        const text = withCompatibilityForms(original);
        if (!addressesFull) {
          addressesIn(text, (raw) => {
            if (rawSeen.has(raw)) return true;
            const address = normalizeAddress(raw);
            if (!address) return true;
            if (rawSeen.size >= 4 * PROVENANCE_MAX_PER_CALL) {
              over = true;
              addressesFull = true;
              return false;
            }
            rawSeen.add(raw);
            return take(named, address) || ((addressesFull = true), false);
          });
        }
        if (!hostsFull) linkHostsIn(text, (host) => take(hosts, host) || ((hostsFull = true), false));
      }
    }

    for (const address of correspondents) this.#addAddress(address, this.#correspondentAddresses, this.#correspondentDomains, now, false);
    for (const address of named) this.#addAddress(address, this.#contentAddresses, this.#contentDomains, now, true);
    for (const host of hosts) for (const d of domainSuffixes(host)) this.#add(this.#contentDomains, d, now, true);
    if (over) this.#overflowUntil = now + this.#ttlMs;
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
    // Overflow: some mail content was not remembered, so anyone who is not a known correspondent may come from it
    if (now < this.#overflowUntil) {
      const warned = new Set(out.map((w) => w.address));
      for (const address of done) {
        if (!warned.has(address) && !this.#has(this.#correspondentAddresses, address, now)) {
          out.push({ address, reason: "mail-content-not-tracked" });
        }
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

  #addAddress(address: string, addresses: HashSet, domains: HashSet, now: number, content: boolean): void {
    this.#add(addresses, address, now, content);
    for (const d of domainSuffixes(address.slice(address.lastIndexOf("@") + 1))) this.#add(domains, d, now, content);
  }

  #add(set: HashSet, value: string, now: number, content: boolean): void {
    const key = this.#hash(value);
    set.delete(key); // a new sighting moves the entry to the back
    set.set(key, now);
    if (set.size <= this.#maxEntries) return;
    // Drop a batch at once (down to 90 %), in one linear pass, so a full set costs O(1) per entry on average
    let drop = set.size - Math.max(1, Math.floor(this.#maxEntries * 0.9));
    for (const oldest of set.keys()) {
      if (drop-- <= 0) break;
      set.delete(oldest);
    }
    if (content) this.#overflowUntil = now + this.#ttlMs;
  }

  /** For tests: what the store holds. Keys are hashes; timestamps are the only values. */
  snapshotForTests(): { keys: string[]; values: number[] } {
    const entries = this.#sets().flatMap((set) => [...set]);
    return { keys: entries.map(([k]) => k), values: entries.map(([, v]) => v) };
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
