/**
 * In-memory stand-in for the subset of ImapFlow the tools use.
 *
 * It mirrors imapflow's *soft failure* semantics on purpose: search, messageMove,
 * messageCopy, messageFlagsAdd/Remove and status resolve to `false` when the
 * server refuses, instead of throwing. Tests use failOn() to inject that.
 */
import { Readable } from "node:stream";
import type { ImapFlow } from "imapflow";
import addressparser from "nodemailer/lib/addressparser/index.js";
import { mimeTree } from "./mime-tree.js";

export type FakeMethod =
  | "search"
  | "messageMove"
  | "messageCopy"
  | "messageFlagsAdd"
  | "messageFlagsRemove"
  | "messageDelete"
  | "append"
  | "status"
  | "getMailboxLock";

export type FailureMode = "false" | "throw";

export interface FakeMessage {
  uid: number;
  raw: Buffer;
  flags: Set<string>;
  internalDate: Date;
  /** Gmail X-GM-THRID equivalent for thread tests */
  threadId?: string;
}

export interface FakeFolder {
  path: string;
  specialUse?: string;
  flags: Set<string>;
  permanentFlags: Set<string>;
  uidValidity: bigint;
  uidNext: number;
  messages: FakeMessage[];
}

export interface AddFolderOptions {
  specialUse?: string;
  /** Defaults to the standard flags plus "\\*" (custom keywords allowed). */
  permanentFlags?: string[];
  /** LIST flags, e.g. ["\\Noselect"]. */
  flags?: string[];
}

export interface SelectedMailbox {
  path: string;
  uidValidity: bigint;
  exists: number;
  permanentFlags: Set<string>;
  flags: Set<string>;
}

const DEFAULT_PERMANENT_FLAGS = ["\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft", "\\*"];

export class FakeImap {
  usable = true;
  capabilities = new Map<string, boolean | number>([
    ["IMAP4rev1", true],
    ["UIDPLUS", true],
    ["MOVE", true],
    ["SPECIAL-USE", true],
  ]);
  mailbox: SelectedMailbox | false = false;
  /** What getQuota() resolves to; false = server without QUOTA support. */
  quota: unknown = false;
  /** Personal namespace from NAMESPACE; like imapflow, CREATE and RENAME targets get its prefix. */
  namespace: { prefix: string; delimiter: string } | undefined = undefined;
  readonly folders = new Map<string, FakeFolder>();
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private readonly failures = new Map<FakeMethod, FailureMode>();

  constructor() {
    this.addFolder("INBOX");
  }

  /** The next call of `method` resolves to false (imapflow soft failure) or throws. */
  failOn(method: FakeMethod, mode: FailureMode): this {
    this.failures.set(method, mode);
    return this;
  }

  addFolder(path: string, opts: AddFolderOptions = {}): FakeFolder {
    const folder: FakeFolder = {
      path,
      specialUse: opts.specialUse,
      flags: new Set(opts.flags ?? []),
      permanentFlags: new Set(opts.permanentFlags ?? DEFAULT_PERMANENT_FLAGS),
      uidValidity: 1000n + BigInt(this.folders.size),
      uidNext: 1,
      messages: [],
    };
    this.folders.set(path, folder);
    return folder;
  }

  addMessage(
    path: string,
    raw: string | Buffer,
    opts: { flags?: string[]; internalDate?: Date; uid?: number; threadId?: string } = {},
  ): number {
    const folder = this.requireFolder(path);
    const uid = opts.uid ?? folder.uidNext;
    folder.uidNext = Math.max(folder.uidNext, uid + 1);
    folder.messages.push({
      uid,
      raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw),
      flags: new Set(opts.flags ?? []),
      internalDate: opts.internalDate ?? new Date("2026-01-15T10:00:00Z"),
      threadId: opts.threadId,
    });
    return uid;
  }

  uidsIn(path: string): number[] {
    return this.requireFolder(path).messages.map((m) => m.uid).sort((a, b) => a - b);
  }

  message(path: string, uid: number): FakeMessage | undefined {
    return this.folders.get(path)?.messages.find((m) => m.uid === uid);
  }

  callsTo(method: string): unknown[][] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  asClient(): ImapFlow {
    return this as unknown as ImapFlow;
  }

  // ─── imapflow surface ──────────────────────────────────────────────────────

  async getMailboxLock(path: string, _opts?: { readOnly?: boolean }) {
    this.record("getMailboxLock", [path]);
    if (this.takeFailure("getMailboxLock")) throw new Error(`Mailbox doesn't exist: ${path}`);
    const folder = this.folders.get(path);
    if (!folder || folder.flags.has("\\Noselect")) throw new Error(`Mailbox doesn't exist: ${path}`);
    this.mailbox = {
      path: folder.path,
      uidValidity: folder.uidValidity,
      exists: folder.messages.length,
      permanentFlags: folder.permanentFlags,
      flags: folder.flags,
    };
    return { path: folder.path, release: () => {} };
  }

  async search(query: Record<string, unknown>, _opts?: { uid?: boolean }): Promise<number[] | false> {
    this.record("search", [query]);
    const failure = this.takeFailure("search");
    if (failure === "throw") throw new Error("search failed");
    if (failure === "false") return false;
    return this.selected()
      .messages.filter((m) => matches(m, query))
      .map((m) => m.uid)
      .sort((a, b) => a - b);
  }

  async *fetch(range: string | number[], query: Record<string, unknown>, _opts?: { uid?: boolean }) {
    this.record("fetch", [range, query]);
    const r = toRange(range);
    for (const m of this.selected().messages.filter((x) => inRange(x.uid, r))) {
      yield toFetchMessage(m, query);
    }
  }

  async fetchOne(range: string, query: Record<string, unknown>, opts?: { uid?: boolean }) {
    for await (const msg of this.fetch(range, query, opts)) return msg;
    return false;
  }

  async download(range: string, _part?: string, _opts?: { uid?: boolean }) {
    this.record("download", [range]);
    const m = this.selected().messages.find((x) => inRange(x.uid, String(range)));
    if (!m) return {}; // imapflow returns {} when the message does not exist
    return { meta: { expectedSize: m.raw.length }, content: Readable.from([m.raw]) };
  }

  async messageMove(range: string | number[], destination: string, opts?: { uid?: boolean }) {
    if (!this.capabilities.has("MOVE")) {
      // imapflow's fallback without MOVE: COPY, then messageDelete (plain EXPUNGE without UIDPLUS)
      this.record("messageMove", [range, destination]);
      const copied = await this.messageCopy(range, destination, opts);
      if (!copied) return copied;
      return (await this.messageDelete(range, opts)) ? copied : false;
    }
    return this.transfer("messageMove", range, destination, true);
  }

  async messageCopy(range: string | number[], destination: string, _opts?: { uid?: boolean }) {
    return this.transfer("messageCopy", range, destination, false);
  }

  async messageFlagsAdd(range: string | number[], flags: string[], _opts?: { uid?: boolean }) {
    return this.store("messageFlagsAdd", range, flags, "add");
  }

  async messageFlagsRemove(range: string | number[], flags: string[], _opts?: { uid?: boolean }) {
    return this.store("messageFlagsRemove", range, flags, "remove");
  }

  async messageDelete(range: string | number[], opts?: { uid?: boolean }) {
    this.record("messageDelete", [range]);
    const failure = this.takeFailure("messageDelete");
    if (failure === "throw") throw new Error("delete failed");
    if (failure === "false") return false;
    const folder = this.selected();
    const r = toRange(range);
    for (const m of folder.messages) if (inRange(m.uid, r)) m.flags.add("\\Deleted");
    // Without UIDPLUS imapflow issues a plain EXPUNGE, which removes EVERY \Deleted message.
    const byUid = opts?.uid === true && this.capabilities.has("UIDPLUS");
    folder.messages = folder.messages.filter(
      (m) => !(m.flags.has("\\Deleted") && (!byUid || inRange(m.uid, r))),
    );
    return true;
  }

  async append(path: string, content: string | Buffer, flags: string[] = [], idate?: Date) {
    this.record("append", [path, flags]);
    const failure = this.takeFailure("append");
    if (failure === "throw") throw new Error("append failed");
    if (failure === "false") return false;
    const folder = this.folders.get(path);
    if (!folder) throw new Error(`Mailbox doesn't exist: ${path}`);
    const uid = this.addMessage(path, content, { flags, internalDate: idate ?? new Date() });
    return { destination: path, uid, uidValidity: folder.uidValidity };
  }

  async list() {
    this.record("list", []);
    return [...this.folders.values()].map((f) => ({
      path: f.path,
      name: f.path.split("/").pop() ?? f.path,
      delimiter: "/",
      flags: new Set(f.flags),
      specialUse: f.specialUse,
      listed: true,
      subscribed: true,
    }));
  }

  async listTree() {
    this.record("listTree", []);
    type Node = { path: string; name: string; delimiter: string; flags: Set<string>; specialUse?: string; folders: Node[] };
    const root: { root: true; folders: Node[] } = { root: true, folders: [] };
    const nodes = new Map<string, Node>();
    for (const f of [...this.folders.values()].sort((a, b) => a.path.localeCompare(b.path))) {
      const node: Node = {
        path: f.path,
        name: f.path.split("/").pop() ?? f.path,
        delimiter: "/",
        flags: new Set(f.flags),
        specialUse: f.specialUse,
        folders: [],
      };
      nodes.set(f.path, node);
      const parentPath = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : null;
      const parent = parentPath ? nodes.get(parentPath) : undefined;
      (parent ? parent.folders : root.folders).push(node);
    }
    return root;
  }

  async status(path: string, _query: Record<string, boolean>) {
    this.record("status", [path]);
    const failure = this.takeFailure("status");
    if (failure === "throw") throw new Error("status failed");
    const folder = this.folders.get(path);
    if (failure === "false" || !folder) return false;
    return {
      path,
      messages: folder.messages.length,
      unseen: folder.messages.filter((m) => !m.flags.has("\\Seen")).length,
      uidValidity: folder.uidValidity,
      uidNext: folder.uidNext,
    };
  }

  async mailboxCreate(requested: string) {
    this.record("mailboxCreate", [requested]);
    const path = this.normalizePath(requested);
    if (this.folders.has(path)) throw new Error(`Mailbox already exists: ${path}`);
    this.addFolder(path);
    return { path, created: true };
  }

  /** IMAP RENAME also moves every folder below the renamed one. */
  async mailboxRename(requestedPath: string, requestedNewPath: string) {
    this.record("mailboxRename", [requestedPath, requestedNewPath]);
    const path = this.normalizePath(requestedPath);
    const newPath = this.normalizePath(requestedNewPath);
    if (!this.folders.has(path)) throw new Error(`Mailbox doesn't exist: ${path}`);
    if (this.folders.has(newPath)) throw new Error(`Mailbox already exists: ${newPath}`);
    for (const [key, folder] of [...this.folders]) {
      if (key !== path && !key.startsWith(path + "/")) continue;
      this.folders.delete(key);
      folder.path = newPath + key.slice(path.length);
      this.folders.set(folder.path, folder);
    }
    return { path, newPath };
  }

  async getQuota(path?: string) {
    this.record("getQuota", [path]);
    return this.quota;
  }

  async noop() {}
  async logout() {}
  close() {}

  // ─── internals ─────────────────────────────────────────────────────────────

  private record(method: string, args: unknown[]) {
    this.calls.push({ method, args });
  }

  /** imapflow's normalizePath(): adds the namespace prefix unless the path is INBOX or already has it. */
  private normalizePath(path: string): string {
    if (path.toUpperCase() === "INBOX") return "INBOX";
    const prefix = this.namespace?.prefix;
    return prefix && !path.startsWith(prefix) ? prefix + path : path;
  }

  private takeFailure(method: FakeMethod): FailureMode | undefined {
    const mode = this.failures.get(method);
    this.failures.delete(method);
    return mode;
  }

  private requireFolder(path: string): FakeFolder {
    const folder = this.folders.get(path);
    if (!folder) throw new Error(`FakeImap: no folder "${path}"`);
    return folder;
  }

  private selected(): FakeFolder {
    if (!this.mailbox) throw new Error("FakeImap: no mailbox selected");
    return this.requireFolder(this.mailbox.path);
  }

  private transfer(method: FakeMethod, range: string | number[], destination: string, remove: boolean) {
    this.record(method, [range, destination]);
    const failure = this.takeFailure(method);
    if (failure === "throw") throw new Error(`${method} failed`);
    if (failure === "false") return false;
    const src = this.selected();
    const dst = this.folders.get(destination);
    if (!dst || dst.flags.has("\\Noselect")) return false; // server says NO [TRYCREATE]
    const r = toRange(range);
    const uidMap = new Map<number, number>();
    for (const m of src.messages.filter((x) => inRange(x.uid, r))) {
      const newUid = dst.uidNext++;
      dst.messages.push({ ...m, uid: newUid, flags: new Set(m.flags) });
      uidMap.set(m.uid, newUid);
    }
    if (remove) src.messages = src.messages.filter((x) => !uidMap.has(x.uid));
    return { path: src.path, destination: dst.path, uidValidity: dst.uidValidity, uidMap };
  }

  private store(method: FakeMethod, range: string | number[], flags: string[], op: "add" | "remove") {
    this.record(method, [range, flags]);
    const failure = this.takeFailure(method);
    if (failure === "throw") throw new Error(`${method} failed`);
    if (failure === "false") return false;
    const folder = this.selected();
    // imapflow silently drops flags the mailbox cannot store and returns false if none remain
    const usable =
      op === "remove"
        ? flags
        : flags.filter((f) => folder.permanentFlags.has("\\*") || folder.permanentFlags.has(f));
    if (usable.length === 0) return false;
    const r = toRange(range);
    for (const m of folder.messages.filter((x) => inRange(x.uid, r))) {
      for (const f of usable) {
        if (op === "add") m.flags.add(f);
        else m.flags.delete(f);
      }
    }
    return true;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function toRange(range: string | number[]): string {
  return Array.isArray(range) ? range.join(",") : String(range);
}

function inRange(uid: number, range: string): boolean {
  return range.split(",").some((part) => {
    const [a, b] = part.split(":");
    if (b === undefined) return a === "*" || Number(a) === uid;
    const lo = Number(a);
    const hi = b === "*" ? Number.POSITIVE_INFINITY : Number(b);
    return uid >= Math.min(lo, hi) && uid <= Math.max(lo, hi);
  });
}

function splitRaw(raw: Buffer): { head: string; body: string } {
  const s = raw.toString("utf8");
  const idx = s.search(/\r?\n\r?\n/);
  return idx >= 0 ? { head: s.slice(0, idx), body: s.slice(idx).replace(/^\r?\n\r?\n/, "") } : { head: s, body: "" };
}

function headerValue(raw: Buffer, name: string): string {
  const unfolded = splitRaw(raw).head.replace(/\r?\n[ \t]+/g, " ");
  const line = unfolded.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));
  return line ? line.slice(name.length + 1).trim() : "";
}

function includesCI(haystack: string, needle: unknown): boolean {
  return typeof needle === "string" && haystack.toLowerCase().includes(needle.toLowerCase());
}

function ymd(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function matches(m: FakeMessage, q: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(q)) {
    switch (key) {
      case "all":
        break;
      case "uid":
        if (!inRange(m.uid, String(value))) return false;
        break;
      case "seen":
      case "flagged":
      case "answered":
      case "deleted":
      case "draft": {
        const flag = "\\" + key[0].toUpperCase() + key.slice(1);
        if (m.flags.has(flag) !== value) return false;
        break;
      }
      case "threadId":
        if (m.threadId !== value) return false;
        break;
      case "keyword":
        if (!m.flags.has(String(value))) return false;
        break;
      case "unKeyword":
        if (m.flags.has(String(value))) return false;
        break;
      case "from":
      case "to":
      case "cc":
      case "bcc":
      case "subject":
        if (!includesCI(headerValue(m.raw, key), value)) return false;
        break;
      case "body":
        if (!includesCI(splitRaw(m.raw).body, value)) return false;
        break;
      case "text":
      case "gmraw": // stand-in for Gmail's X-GM-RAW: full-text match
        if (!includesCI(m.raw.toString("utf8"), value)) return false;
        break;
      case "since":
        if (ymd(m.internalDate) < ymd(value)) return false;
        break;
      case "before":
        if (ymd(m.internalDate) >= ymd(value)) return false;
        break;
      case "larger":
        if (m.raw.length <= Number(value)) return false;
        break;
      case "smaller":
        if (m.raw.length >= Number(value)) return false;
        break;
      case "header":
        for (const [h, v] of Object.entries(value as Record<string, string | boolean>)) {
          const hv = headerValue(m.raw, h);
          if (v === true ? hv === "" : !includesCI(hv, v)) return false;
        }
        break;
      case "or":
        if (!(value as Array<Record<string, unknown>>).some((sub) => matches(m, sub))) return false;
        break;
      case "not":
        if (matches(m, value as Record<string, unknown>)) return false;
        break;
      default:
        throw new Error(`FakeImap: unsupported search key "${key}"`);
    }
  }
  return true;
}

function envelopeAddresses(value: string) {
  if (!value) return undefined;
  return addressparser(value, { flatten: true }).map((a) => ({ name: a.name, address: a.address }));
}

function toFetchMessage(m: FakeMessage, query: Record<string, unknown>) {
  const out: Record<string, unknown> = { uid: m.uid, seq: m.uid };
  if (query.flags) out.flags = new Set(m.flags);
  if (query.size) out.size = m.raw.length;
  if (query.internalDate) out.internalDate = m.internalDate;
  if (query.source) out.source = m.raw;
  if (query.envelope) {
    const date = headerValue(m.raw, "date");
    const parsedDate = new Date(date);
    out.envelope = {
      subject: headerValue(m.raw, "subject"),
      from: envelopeAddresses(headerValue(m.raw, "from")),
      to: envelopeAddresses(headerValue(m.raw, "to")),
      cc: envelopeAddresses(headerValue(m.raw, "cc")),
      bcc: envelopeAddresses(headerValue(m.raw, "bcc")),
      // like imapflow: an unparseable Date header comes through as the raw string
      date: !date ? m.internalDate : Number.isNaN(parsedDate.getTime()) ? date : parsedDate,
      messageId: headerValue(m.raw, "message-id") || undefined,
      inReplyTo: headerValue(m.raw, "in-reply-to") || undefined,
    };
  }
  if (query.threadId) out.threadId = m.threadId;
  if (query.bodyStructure || query.bodyParts) {
    const tree = mimeTree(m.raw);
    if (query.bodyStructure) out.bodyStructure = tree.structure;
    if (Array.isArray(query.bodyParts)) {
      const bodyParts = new Map<string, Buffer>();
      for (const spec of query.bodyParts as Array<string | { key: string; start?: number; maxLength?: number }>) {
        const { key, start = 0, maxLength } = typeof spec === "string" ? { key: spec, start: 0, maxLength: undefined } : spec;
        const content = tree.parts.get(key);
        // imapflow lower-cases response keys and strips the <start> suffix
        if (content) bodyParts.set(key.toLowerCase(), content.subarray(start, maxLength === undefined ? undefined : start + maxLength));
      }
      out.bodyParts = bodyParts;
    }
  }
  return out;
}
