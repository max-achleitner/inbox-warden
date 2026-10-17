# Safety-Critical Fixes & Test Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every existing tool fail closed instead of silently succeeding or widening its selection, fix the reported email-correctness bugs (search fallback, Sent copies, Reply-To and quoting, RFC 2231 filenames, Message-ID), close the STARTTLS downgrade, and put IMAP/SMTP behaviour under automated test.

**Architecture:** Two new layers sit between the tools and the libraries: `src/imap/` (fail-closed wrappers around imapflow, folder resolution, a search compiler that refuses unsupported criteria, flag normalisation) and `src/mail/` (nodemailer `MailComposer` for composition, byte-preserving header edits, reply logic, a `deliver()` pipeline that transmits raw bytes and files a Sent copy). Tools are rewritten on top of these layers but keep their names, registration signatures and existing parameters. Tests drive the real MCP surface through an in-memory client against a `FakeImap` that reproduces imapflow's soft-failure semantics; a GreenMail suite covers the real protocol in CI.

**Tech Stack:** TypeScript 5.9 (ESM, Node16 resolution) · `@modelcontextprotocol/sdk` 1.27 (unchanged here; Plan 2 migrates to v2) · `imapflow` 1.2 · `nodemailer` 6.10 (`MailComposer`, `addressparser`) · `mailparser` 3.9 · `vitest` 2.1 · GreenMail 2.1.14 (Docker) for integration tests · GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-14-production-readiness-design.md` — §3.1 defects B1–B12, decisions D2, D3, D4, D10, contracts §9.1.

> **Validation note:** every file in this plan was implemented and run before the plan was written: 170 unit tests pass, `tsc` build and test typecheck are clean, and the new tool tests were confirmed to fail against the pre-plan code. The GreenMail suite was typechecked but only runs where Docker is available (CI).

## Global Constraints

- No new runtime dependencies. `MailComposer` and `addressparser` ship inside `nodemailer`.
- No dependency upgrades in this plan; SDK v2, zod 4, imapflow 2 and nodemailer 10 are Plan 2.
- ESM imports with `.js` suffix, 2-space indentation, double quotes — match the existing code.
- Tool names, registration signatures (`register(server, getClient[, …])`) and existing parameters stay compatible; new parameters are optional with defaults. Exceptions, both intentional: `send_email`/`send_draft` registration now takes `SendDeps` (Task 8).
- Every tool returns `{ content: [{ type: "text", text }] }`; errors set `isError: true`; use `jsonResult`/`errorResult` from `src/tools/shared/result.ts` in every file you touch.
- stdout is reserved for MCP; logs go to stderr only.
- Unit tests run without network or Docker. Integration tests are skipped unless `IMAP_IT_HOST` is set.
- Error texts are plain English and state whether anything was changed.
- Use the Write tool (not shell heredocs) for files that contain backslashes such as `"\\Seen"` — heredocs in Git Bash collapse `\\` to `\`.
- On Windows the repo checks out with CRLF (`core.autocrlf=true`); new files may be LF — git normalises on commit. Do not reformat untouched files.
- Commit after each task with the message given; every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A destination folder that exists but is `\Noselect`** (a parent such as `Projects`) — `move_email` must fail without calling MOVE, not report success. Pinned by Task 5 test "refuses a \Noselect parent folder".
2. **Umlauts in a search on a server that rejects `CHARSET UTF-8`** — the search must fail with a hint; it must neither return 0 hits nor all mail. Pinned by Task 4 test "adds a hint when a non-ASCII search is rejected".
3. **A Thunderbird draft with a folded, multi-line `Bcc:` header and `X-Mozilla-Draft-Info`** — sending must remove every Bcc line and the bookkeeping header. Pinned by Task 6 test "removes a folded Bcc header completely" and Task 8 test "send_draft sends the stored draft as reviewed".
4. **Reply-To with a display name containing a comma** (`"Müller, Hans" <hans@…>`) — must stay one recipient. Pinned by Task 7 test "uses Reply-To instead of a noreply From".
5. **A server without UIDPLUS** (older Courier, hMailServer, some hosters) — permanent delete and draft clean-up must never expunge other `\Deleted` messages. Pinned by Task 2 `safeExpunge` tests, Task 5 test "permanently deleting from Trash never expunges other \Deleted messages without UIDPLUS" and Task 8 test "send_draft keeps the draft when the server lacks UIDPLUS…".

---

### Task 1: Repository hygiene and test foundation

**Files:**
- Delete: `imap_debug.log`, `imap_debug2.log`, `stderr.log`, `stderr_debug.log`, `stderr_keychain.log`, `stderr_list.log`, `stderr_multi.log`, `stderr_search2.log`, `stderr_since.log`, `bash.exe.stackdump` (untracked)
- Modify: `.gitignore`, `package.json` (scripts)
- Create: `vitest.config.ts`, `vitest.integration.config.ts`, `tsconfig.test.json`
- Create: `src/__tests__/helpers/fake-imap.ts`, `src/__tests__/helpers/messages.ts`, `src/__tests__/helpers/mcp-harness.ts`, `src/__tests__/helpers/capture-transport.ts`
- Test: `src/__tests__/helpers/fake-imap.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by every later task and plan):
  - `class FakeImap` — imapflow subset (`getMailboxLock`, `search`, `fetch`, `download`, `messageMove`, `messageCopy`, `messageFlagsAdd`, `messageFlagsRemove`, `messageDelete`, `append`, `list`, `listTree`, `status`, `mailboxCreate`, `capabilities`, `mailbox`, `usable`) plus test controls `failOn(method: FakeMethod, mode: "false" | "throw")`, `addFolder(path, { specialUse?, permanentFlags?, flags? })`, `addMessage(path, raw, { flags?, internalDate?, uid? }): number`, `uidsIn(path): number[]`, `message(path, uid): FakeMessage | undefined`, `callsTo(method): unknown[][]`, `asClient(): ImapFlow`.
  - `connectHarness(register: (server: McpServer) => void): Promise<Harness>` with `Harness = { call(name, args?): Promise<{ isError: boolean; text: string; json: any }>; listTools(): Promise<string[]>; annotations(name): Promise<Record<string, unknown> | undefined>; close(): Promise<void> }`.
  - `buildRaw(opts: Mail.Options): Promise<Buffer>`, `headerLines(raw): string[]`, `header(raw, name): string | undefined`.
  - `createCaptureTransport(): { transport: Transporter; sent: CapturedMail[]; failNext(err: Error): void }` with `CapturedMail = { envelope: { from: string; to: string[] }; raw: Buffer }`.

- [ ] **Step 1: Delete the stray debug logs**

These files are untracked and contain IMAP protocol traces including the `AUTHENTICATE PLAIN …` line. The SASL PLAIN payload is the base64 of `\0user\0password`.

```bash
rm -f imap_debug.log imap_debug2.log stderr.log stderr_debug.log stderr_keychain.log stderr_list.log stderr_multi.log stderr_search2.log stderr_since.log bash.exe.stackdump
git status --short
```

Expected: no `*.log` or `*.stackdump` entries remain. **Then tell the owner to change the password of the mailbox used in these traces** (and in any copies/backups of the folder) — it must be treated as exposed.

- [ ] **Step 2: Ignore local debug output**

Append to `.gitignore`:

```gitignore

# Local debug output (may contain protocol traces)
*.log
*.stackdump
coverage/
```

- [ ] **Step 3: Add test configuration and scripts**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    exclude: ["src/**/__tests__/integration/**"],
    testTimeout: 10_000,
  },
});
```

Create `vitest.integration.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/__tests__/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
```

Create `tsconfig.test.json` (typechecks tests, which the build excludes):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "rootDir": "."
  },
  "include": ["src/**/*", "vitest.config.ts", "vitest.integration.config.ts"],
  "exclude": ["node_modules", "dist"]
}
```

In `package.json` add two scripts next to `"test"`:

```json
    "typecheck": "tsc -p tsconfig.test.json",
    "test:integration": "vitest run --config vitest.integration.config.ts"
```

- [ ] **Step 4: Write the failing self-test for the fake server**

Create `src/__tests__/helpers/fake-imap.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FakeImap } from "./fake-imap.js";
import { buildRaw } from "./messages.js";

describe("FakeImap", () => {
  it("searches by from/since and returns sorted UIDs", async () => {
    const imap = new FakeImap();
    imap.addMessage("INBOX", await buildRaw({ from: "a@x.com", to: "me@x.com", subject: "one" }), {
      internalDate: new Date("2026-01-01"),
    });
    imap.addMessage("INBOX", await buildRaw({ from: "b@x.com", to: "me@x.com", subject: "two" }), {
      internalDate: new Date("2026-03-01"),
    });
    await imap.getMailboxLock("INBOX");
    expect(await imap.search({ from: "a@x.com" })).toEqual([1]);
    expect(await imap.search({ since: "2026-02-01" })).toEqual([2]);
    expect(await imap.search({ all: true })).toEqual([1, 2]);
  });

  it("returns false from move when the destination does not exist (imapflow soft failure)", async () => {
    const imap = new FakeImap();
    imap.addMessage("INBOX", "Subject: x\r\n\r\nbody");
    await imap.getMailboxLock("INBOX");
    expect(await imap.messageMove("1", "Nope", { uid: true })).toBe(false);
    expect(imap.uidsIn("INBOX")).toEqual([1]);
  });

  it("drops keywords the mailbox cannot store and returns false", async () => {
    const imap = new FakeImap();
    imap.folders.get("INBOX")!.permanentFlags = new Set(["\\Seen", "\\Flagged"]);
    imap.addMessage("INBOX", "Subject: x\r\n\r\nbody");
    await imap.getMailboxLock("INBOX");
    expect(await imap.messageFlagsAdd("1", ["$Done"], { uid: true })).toBe(false);
    expect(imap.message("INBOX", 1)!.flags.has("$Done")).toBe(false);
  });

  it("expunges every \\Deleted message when UIDPLUS is missing", async () => {
    const imap = new FakeImap();
    imap.capabilities.delete("UIDPLUS");
    imap.addMessage("INBOX", "Subject: a\r\n\r\n", { flags: ["\\Deleted"] });
    imap.addMessage("INBOX", "Subject: b\r\n\r\n");
    await imap.getMailboxLock("INBOX");
    await imap.messageDelete("2", { uid: true });
    expect(imap.uidsIn("INBOX")).toEqual([]);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run src/__tests__/helpers/fake-imap.test.ts`
Expected: FAIL — `Failed to resolve import "./fake-imap.js"`.

- [ ] **Step 6: Implement the test helpers**

Create `src/__tests__/helpers/fake-imap.ts` (reproduces imapflow's soft failures on purpose — `search`, `messageMove`, `messageCopy`, `messageFlagsAdd/Remove`, `status` resolve to `false`; unstorable keywords are dropped; plain EXPUNGE without UIDPLUS removes every `\Deleted` message):

```ts
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
    opts: { flags?: string[]; internalDate?: Date; uid?: number } = {},
  ): number {
    const folder = this.requireFolder(path);
    const uid = opts.uid ?? folder.uidNext;
    folder.uidNext = Math.max(folder.uidNext, uid + 1);
    folder.messages.push({
      uid,
      raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw),
      flags: new Set(opts.flags ?? []),
      internalDate: opts.internalDate ?? new Date("2026-01-15T10:00:00Z"),
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

  async download(range: string, _part?: string, _opts?: { uid?: boolean }) {
    this.record("download", [range]);
    const m = this.selected().messages.find((x) => inRange(x.uid, String(range)));
    if (!m) return {}; // imapflow returns {} when the message does not exist
    return { meta: { expectedSize: m.raw.length }, content: Readable.from([m.raw]) };
  }

  async messageMove(range: string | number[], destination: string, _opts?: { uid?: boolean }) {
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

  async mailboxCreate(path: string) {
    this.record("mailboxCreate", [path]);
    if (this.folders.has(path)) throw new Error(`Mailbox already exists: ${path}`);
    this.addFolder(path);
    return { path, created: true };
  }

  async noop() {}
  async logout() {}
  close() {}

  // ─── internals ─────────────────────────────────────────────────────────────

  private record(method: string, args: unknown[]) {
    this.calls.push({ method, args });
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
    out.envelope = {
      subject: headerValue(m.raw, "subject"),
      from: envelopeAddresses(headerValue(m.raw, "from")),
      to: envelopeAddresses(headerValue(m.raw, "to")),
      cc: envelopeAddresses(headerValue(m.raw, "cc")),
      date: date ? new Date(date) : m.internalDate,
      messageId: headerValue(m.raw, "message-id") || undefined,
      inReplyTo: headerValue(m.raw, "in-reply-to") || undefined,
    };
  }
  if (query.bodyStructure) {
    out.bodyStructure = /^Content-Disposition:\s*attachment/im.test(m.raw.toString("utf8"))
      ? {
          type: "multipart/mixed",
          childNodes: [
            { part: "1", type: "text/plain" },
            { part: "2", type: "application/octet-stream", disposition: "attachment" },
          ],
        }
      : { part: "1", type: "text/plain", encoding: "7bit", parameters: { charset: "utf-8" } };
  }
  return out;
}
```

Create `src/__tests__/helpers/messages.ts`:

```ts
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";

/** Build an RFC 822 message for fixtures. Bcc is kept so Sent/Draft fixtures look realistic. */
export async function buildRaw(opts: Mail.Options): Promise<Buffer> {
  const node = new MailComposer({ date: new Date("2026-01-15T10:00:00Z"), ...opts }).compile();
  node.keepBcc = true;
  return node.build();
}

/** Split a raw message into its header block (unfolded lines) and body. */
export function headerLines(raw: Buffer | string): string[] {
  const s = raw.toString();
  const head = s.slice(0, s.search(/\r?\n\r?\n/));
  return head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/);
}

export function header(raw: Buffer | string, name: string): string | undefined {
  const line = headerLines(raw).find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));
  return line?.slice(name.length + 1).trim();
}
```

Create `src/__tests__/helpers/mcp-harness.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export interface ToolCallResult {
  isError: boolean;
  text: string;
  /** Parsed JSON body when the tool returned JSON, otherwise undefined. */
  json: any;
}

export interface Harness {
  call(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  listTools(): Promise<string[]>;
  annotations(name: string): Promise<Record<string, unknown> | undefined>;
  close(): Promise<void>;
}

/** Spin up an McpServer with the given registrations and talk to it over an in-memory transport. */
export async function connectHarness(register: (server: McpServer) => void): Promise<Harness> {
  const server = new McpServer({ name: "test-server", version: "0.0.0" });
  register(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    async call(name, args = {}) {
      try {
        const res = await client.callTool({ name, arguments: args });
        const content = res.content as Array<{ type: string; text?: string }>;
        const text = content[0]?.text ?? "";
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        return { isError: res.isError === true, text, json };
      } catch (err) {
        // Older SDKs reject on input-validation errors instead of returning isError
        return { isError: true, text: err instanceof Error ? err.message : String(err), json: undefined };
      }
    },
    async listTools() {
      const res = await client.listTools();
      return res.tools.map((t) => t.name).sort();
    },
    async annotations(name) {
      const res = await client.listTools();
      return res.tools.find((t) => t.name === name)?.annotations as Record<string, unknown> | undefined;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
```

Create `src/__tests__/helpers/capture-transport.ts` (nodemailer's stream/json transports keep the Bcc header, so they cannot test Bcc handling):

```ts
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export interface CapturedMail {
  envelope: { from: string; to: string[] };
  raw: Buffer;
}

export interface CaptureTransport {
  transport: Transporter;
  sent: CapturedMail[];
  /** Make the next sendMail() fail with this error. */
  failNext(err: Error): void;
}

/**
 * A nodemailer transport that behaves like the SMTP transport (Bcc header is stripped,
 * explicit envelope wins) but records messages instead of delivering them.
 * nodemailer's streamTransport/jsonTransport keep Bcc, so they cannot be used to test Bcc handling.
 */
export function createCaptureTransport(): CaptureTransport {
  const sent: CapturedMail[] = [];
  let nextError: Error | null = null;
  const transport = nodemailer.createTransport({
    name: "capture",
    version: "1.0.0",
    send(mail: any, callback: (err: Error | null, info?: unknown) => void) {
      if (nextError) {
        const err = nextError;
        nextError = null;
        callback(err);
        return;
      }
      const envelope = mail.data.envelope || mail.message.getEnvelope();
      const messageId = mail.message.messageId();
      mail.message.build((err: Error | null, raw: Buffer) => {
        if (err) return callback(err);
        sent.push({ envelope, raw });
        callback(null, { envelope, messageId, accepted: envelope.to, rejected: [], response: "250 OK" });
      });
    },
  } as any);
  return { transport, sent, failNext: (err) => { nextError = err; } };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/helpers/fake-imap.test.ts`
Expected: PASS — 4 tests.

Run: `npm test`
Expected: PASS — 2 files, 62 tests (58 existing injection tests + 4).

- [ ] **Step 8: Typecheck tests**

Run: `npm run typecheck`
Expected: exits 0 with no output. (Deprecation hints for `server.tool` in editors are expected until Plan 2.)

- [ ] **Step 9: Commit**

```bash
git add .gitignore package.json vitest.config.ts vitest.integration.config.ts tsconfig.test.json src/__tests__/helpers
git commit -m "test: add fake IMAP server, MCP test harness and test configuration

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Fail-closed IMAP operations

**Files:**
- Create: `src/imap/strict.ts`, `src/imap/flags.ts`
- Test: `src/imap/__tests__/strict.test.ts`, `src/imap/__tests__/flags.test.ts`

**Interfaces:**
- Consumes: `FakeImap` (Task 1).
- Produces:
  - `class ImapOperationError extends Error { readonly operation: string }`
  - `class MessageNotFoundError extends Error { readonly uid: number; readonly folder: string }`
  - `strictSearch(client: ImapFlow, query: SearchObject): Promise<number[]>`
  - `existingUids(client: ImapFlow, uids: number[]): Promise<number[]>`
  - `strictMove(client: ImapFlow, uids: number[], destination: string): Promise<Map<number, number>>`
  - `strictStoreFlags(client: ImapFlow, uids: number[], flags: string[], action: "add" | "remove"): Promise<void>`
  - `unsupportedFlags(mailbox: MailboxObject | false, flags: string[]): string[]`
  - `strictAppend(client: ImapFlow, path: string, raw: Buffer, flags: string[]): Promise<{ uid?: number }>`
  - `safeExpunge(client: ImapFlow, uids: number[]): Promise<void>`
  - `downloadMessage(client: ImapFlow, uid: number, folder: string): Promise<Buffer>`
  - `normalizeFlag(input: string): string`, `uniqueUids(uids: number[]): number[]`

- [ ] **Step 1: Write the failing tests**

Create `src/imap/__tests__/strict.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import {
  ImapOperationError,
  MessageNotFoundError,
  downloadMessage,
  existingUids,
  safeExpunge,
  strictMove,
  strictSearch,
  strictStoreFlags,
  unsupportedFlags,
} from "../strict.js";

describe("strict IMAP operations", () => {
  let imap: FakeImap;

  beforeEach(async () => {
    imap = new FakeImap();
    imap.addFolder("Archive");
    imap.addMessage("INBOX", "Subject: a\r\n\r\nbody");
    imap.addMessage("INBOX", "Subject: b\r\n\r\nbody");
    await imap.getMailboxLock("INBOX");
  });

  it("strictSearch throws instead of returning false", async () => {
    imap.failOn("search", "false");
    await expect(strictSearch(imap.asClient(), { from: "x" })).rejects.toBeInstanceOf(ImapOperationError);
  });

  it("existingUids reports only UIDs present in the folder", async () => {
    expect(await existingUids(imap.asClient(), [1, 2, 99])).toEqual([1, 2]);
  });

  it("strictMove throws when the server refuses (imapflow returns false)", async () => {
    await expect(strictMove(imap.asClient(), [1], "DoesNotExist")).rejects.toThrow(/Nothing was moved/);
    expect(imap.uidsIn("INBOX")).toEqual([1, 2]);
  });

  it("strictMove returns the UID map on success", async () => {
    const map = await strictMove(imap.asClient(), [2], "Archive");
    expect(map.get(2)).toBe(1);
  });

  it("strictStoreFlags throws when no flag could be stored", async () => {
    imap.failOn("messageFlagsAdd", "false");
    await expect(strictStoreFlags(imap.asClient(), [1], ["\\Seen"], "add")).rejects.toThrow(/Nothing was changed/);
  });

  it("unsupportedFlags lists keywords the mailbox cannot keep", () => {
    const mailbox = { permanentFlags: new Set(["\\Seen", "\\Flagged"]) } as any;
    expect(unsupportedFlags(mailbox, ["\\Seen", "$Done"])).toEqual(["$Done"]);
    expect(unsupportedFlags({ permanentFlags: new Set(["\\*"]) } as any, ["$Done"])).toEqual([]);
  });

  it("safeExpunge refuses without UIDPLUS when other messages are already \\Deleted", async () => {
    imap.capabilities.delete("UIDPLUS");
    imap.message("INBOX", 1)!.flags.add("\\Deleted");
    await expect(safeExpunge(imap.asClient(), [2])).rejects.toThrow(/would also erase 1 other/);
    expect(imap.uidsIn("INBOX")).toEqual([1, 2]);
  });

  it("safeExpunge removes exactly the requested UID with UIDPLUS", async () => {
    imap.message("INBOX", 1)!.flags.add("\\Deleted");
    await safeExpunge(imap.asClient(), [2]);
    expect(imap.uidsIn("INBOX")).toEqual([1]);
  });

  it("downloadMessage throws MessageNotFoundError for an unknown UID", async () => {
    await expect(downloadMessage(imap.asClient(), 42, "INBOX")).rejects.toBeInstanceOf(MessageNotFoundError);
  });
});
```

Create `src/imap/__tests__/flags.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeFlag, uniqueUids } from "../flags.js";

describe("normalizeFlag", () => {
  it.each([
    ["flagged", "\\Flagged"],
    ["\\flagged", "\\Flagged"],
    ["\\Seen", "\\Seen"],
    ["Answered", "\\Answered"],
    ["$Done", "$Done"],
    ["$Erledigt", "$Erledigt"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeFlag(input)).toBe(expected);
  });

  it.each(["\\Recent", "to do", 'say"hi"', "a]b", "back\\slash"])("rejects %s", (input) => {
    expect(() => normalizeFlag(input)).toThrow();
  });
});

describe("uniqueUids", () => {
  it("removes duplicates and keeps order", () => {
    expect(uniqueUids([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/imap/__tests__/strict.test.ts src/imap/__tests__/flags.test.ts`
Expected: FAIL — `Failed to resolve import "../strict.js"` and `"../flags.js"`.

- [ ] **Step 3: Implement**

Create `src/imap/strict.ts`:

```ts
/**
 * Fail-closed wrappers around imapflow.
 *
 * imapflow reports many server refusals by resolving to `false` instead of throwing
 * (search, messageMove, messageCopy, messageFlagsAdd/Remove, messageDelete, status).
 * Every tool must go through these helpers so a refusal becomes an error the AI sees,
 * never a silent "success" or a silently widened result set.
 */
import type { ImapFlow, MailboxObject, SearchObject } from "imapflow";

export class ImapOperationError extends Error {
  constructor(message: string, readonly operation: string) {
    super(message);
    this.name = "ImapOperationError";
  }
}

export class MessageNotFoundError extends Error {
  constructor(readonly uid: number, readonly folder: string) {
    super(`No message with UID ${uid} exists in "${folder}". It may have been moved or deleted; search again to get current UIDs.`);
    this.name = "MessageNotFoundError";
  }
}

function uidSet(uids: number[]): string {
  return uids.join(",");
}

export async function strictSearch(client: ImapFlow, query: SearchObject): Promise<number[]> {
  const result = await client.search(query, { uid: true });
  if (result === false) {
    throw new ImapOperationError(
      "The mail server rejected the search. No messages were matched and nothing was changed.",
      "search",
    );
  }
  return result;
}

/** Which of `uids` currently exist in the selected mailbox. */
export async function existingUids(client: ImapFlow, uids: number[]): Promise<number[]> {
  if (uids.length === 0) return [];
  return strictSearch(client, { uid: uidSet(uids) });
}

export async function strictMove(client: ImapFlow, uids: number[], destination: string): Promise<Map<number, number>> {
  const result = await client.messageMove(uidSet(uids), destination, { uid: true });
  if (result === false) {
    throw new ImapOperationError(
      `The mail server refused to move the messages to "${destination}". Nothing was moved.`,
      "move",
    );
  }
  return result.uidMap ?? new Map();
}

export async function strictStoreFlags(
  client: ImapFlow,
  uids: number[],
  flags: string[],
  action: "add" | "remove",
): Promise<void> {
  const ok =
    action === "add"
      ? await client.messageFlagsAdd(uidSet(uids), flags, { uid: true })
      : await client.messageFlagsRemove(uidSet(uids), flags, { uid: true });
  if (!ok) {
    throw new ImapOperationError(
      `The mail server refused to ${action} the flags ${flags.join(", ")}. Nothing was changed.`,
      "store",
    );
  }
}

/** Flags the selected mailbox cannot store permanently (imapflow would drop them silently). */
export function unsupportedFlags(mailbox: MailboxObject | false, flags: string[]): string[] {
  const permanent = mailbox ? mailbox.permanentFlags : undefined;
  if (!permanent || permanent.has("\\*")) return [];
  return flags.filter((f) => !permanent.has(f));
}

export async function strictAppend(
  client: ImapFlow,
  path: string,
  raw: Buffer,
  flags: string[],
): Promise<{ uid?: number }> {
  const result = await client.append(path, raw, flags);
  if (!result) {
    throw new ImapOperationError(`The mail server refused to store the message in "${path}".`, "append");
  }
  return { uid: result.uid };
}

/**
 * Permanently remove exactly `uids` from the selected mailbox.
 * Without UIDPLUS, EXPUNGE would also erase every other message already flagged \Deleted,
 * so we refuse in that case instead of deleting more than asked.
 */
export async function safeExpunge(client: ImapFlow, uids: number[]): Promise<void> {
  if (!client.capabilities.has("UIDPLUS")) {
    const target = new Set(uids);
    const others = (await strictSearch(client, { deleted: true })).filter((u) => !target.has(u));
    if (others.length > 0) {
      throw new ImapOperationError(
        `This server does not support UIDPLUS, so a permanent delete would also erase ${others.length} other message(s) already marked as deleted in this folder. Nothing was deleted.`,
        "expunge",
      );
    }
  }
  const ok = await client.messageDelete(uidSet(uids), { uid: true });
  if (!ok) {
    throw new ImapOperationError("The mail server refused to delete the messages. Nothing was deleted.", "expunge");
  }
}

/** Download the full source of one message from the selected mailbox. */
export async function downloadMessage(client: ImapFlow, uid: number, folder: string): Promise<Buffer> {
  const result = await client.download(String(uid), undefined, { uid: true });
  if (!result?.content) throw new MessageNotFoundError(uid, folder);
  const chunks: Buffer[] = [];
  for await (const chunk of result.content) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
```

Create `src/imap/flags.ts`:

```ts
const SYSTEM_FLAGS: Record<string, string> = {
  seen: "\\Seen",
  answered: "\\Answered",
  flagged: "\\Flagged",
  deleted: "\\Deleted",
  draft: "\\Draft",
};

/** IMAP atom: no spaces, controls, parentheses, braces, wildcards, quotes, backslashes or "]". */
const KEYWORD_ATOM = /^[^\s(){%*"\\\]\x00-\x1f\x7f]+$/;

/**
 * Normalise a flag supplied by the AI: "flagged", "\\flagged" and "\\Flagged" all become "\\Flagged";
 * anything else must be a valid custom keyword such as "$Done".
 */
export function normalizeFlag(input: string): string {
  const trimmed = input.trim();
  const bare = trimmed.replace(/^\\+/, "").toLowerCase();
  const system = SYSTEM_FLAGS[bare];
  if (system) return system;
  if (trimmed.startsWith("\\")) {
    throw new Error(`"${input}" is not a flag that can be set. Use \\Seen, \\Answered, \\Flagged, \\Draft or a custom keyword.`);
  }
  if (!KEYWORD_ATOM.test(trimmed)) {
    throw new Error(`"${input}" is not a valid keyword (no spaces, quotes, brackets or backslashes allowed).`);
  }
  return trimmed;
}

export function uniqueUids(uids: number[]): number[] {
  return [...new Set(uids)];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/imap/__tests__/strict.test.ts src/imap/__tests__/flags.test.ts`
Expected: PASS — 21 tests.

- [ ] **Step 5: Commit**

```bash
git add src/imap
git commit -m "feat(imap): add fail-closed wrappers for imapflow soft failures

imapflow resolves server refusals to false instead of throwing. These
helpers turn that into errors, refuse unsafe EXPUNGE without UIDPLUS
and report missing messages clearly.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Folder resolution

**Files:**
- Create: `src/imap/folders.ts`
- Test: `src/imap/__tests__/folders.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `type SpecialUse = "\\Drafts" | "\\Sent" | "\\Trash" | "\\Junk"`
  - `interface FolderInfo { path: string; name: string; delimiter: string; specialUse?: string; selectable: boolean }`
  - `class FolderNotFoundError extends Error { readonly requested: string; readonly suggestions: string[] }`
  - `listFolderInfo(client): Promise<FolderInfo[]>`, `matchFolder(folders, requested): string`, `resolveFolder(client, requested): Promise<string>`
  - `pickSpecialFolder(folders, use): string | null`, `findSpecialFolder(client, use): Promise<string | null>`, `requireSpecialFolder(client, use): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `src/imap/__tests__/folders.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { FolderNotFoundError, matchFolder, pickSpecialFolder, type FolderInfo } from "../folders.js";

function folder(path: string, extra: Partial<FolderInfo> = {}): FolderInfo {
  const delimiter = path.includes(".") ? "." : "/";
  return { path, name: path.split(delimiter).pop()!, delimiter, selectable: true, ...extra };
}

describe("matchFolder", () => {
  const folders = [
    folder("INBOX"),
    folder("INBOX.Archive"),
    folder("INBOX.Kunden"),
    folder("INBOX.Kunden.Müller"),
    folder("Projects", { selectable: false }),
  ];

  it("normalises INBOX case", () => {
    expect(matchFolder(folders, "inbox")).toBe("INBOX");
  });

  it("matches case-insensitively", () => {
    expect(matchFolder(folders, "inbox.archive")).toBe("INBOX.Archive");
  });

  it("matches across delimiters", () => {
    expect(matchFolder(folders, "INBOX/Kunden/Müller")).toBe("INBOX.Kunden.Müller");
  });

  it("matches a unique leaf name", () => {
    expect(matchFolder(folders, "Archive")).toBe("INBOX.Archive");
  });

  it("never resolves to a \\Noselect folder", () => {
    expect(() => matchFolder(folders, "Projects")).toThrow(FolderNotFoundError);
  });

  it("throws with suggestions for unknown folders", () => {
    try {
      matchFolder(folders, "Kunde");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(FolderNotFoundError);
      expect((err as Error).message).toContain('"INBOX.Kunden"');
    }
  });
});

describe("pickSpecialFolder", () => {
  it("prefers the SPECIAL-USE flag", () => {
    const folders = [folder("Sent"), folder("Gesendete Elemente", { specialUse: "\\Sent" })];
    expect(pickSpecialFolder(folders, "\\Sent")).toBe("Gesendete Elemente");
  });

  it("falls back to well-known German names", () => {
    expect(pickSpecialFolder([folder("INBOX"), folder("Papierkorb")], "\\Trash")).toBe("Papierkorb");
  });

  it("does not match a same-named subfolder", () => {
    expect(pickSpecialFolder([folder("Kunde A/Sent")], "\\Sent")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/imap/__tests__/folders.test.ts`
Expected: FAIL — `Failed to resolve import "../folders.js"`.

- [ ] **Step 3: Implement**

Create `src/imap/folders.ts`:

```ts
import type { ImapFlow } from "imapflow";

export type SpecialUse = "\\Drafts" | "\\Sent" | "\\Trash" | "\\Junk";

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  selectable: boolean;
}

/** Well-known names (lowercase, full path) used when the server does not advertise SPECIAL-USE. */
const FALLBACK_PATHS: Record<SpecialUse, string[]> = {
  "\\Drafts": [
    "drafts", "draft", "entwürfe", "[gmail]/drafts", "[google mail]/entwürfe", "inbox.drafts", "inbox/drafts",
  ],
  "\\Sent": [
    "sent", "sent items", "sent messages", "sent mail", "gesendet", "gesendete elemente", "gesendete objekte",
    "[gmail]/sent mail", "[google mail]/gesendet", "inbox.sent", "inbox/sent",
  ],
  "\\Trash": [
    "trash", "deleted items", "deleted messages", "papierkorb", "gelöschte elemente", "gelöschte objekte",
    "[gmail]/trash", "[google mail]/papierkorb", "inbox.trash", "inbox/trash",
  ],
  "\\Junk": ["junk", "spam", "junk e-mail", "junk-e-mail", "[gmail]/spam", "inbox.junk", "inbox.spam"],
};

export class FolderNotFoundError extends Error {
  constructor(readonly requested: string, readonly suggestions: string[]) {
    super(
      `Folder "${requested}" does not exist.` +
        (suggestions.length > 0
          ? ` Did you mean: ${suggestions.map((s) => `"${s}"`).join(", ")}?`
          : " Use list_folders to see the available folders."),
    );
    this.name = "FolderNotFoundError";
  }
}

export async function listFolderInfo(client: ImapFlow): Promise<FolderInfo[]> {
  const list = await client.list();
  return list.map((f) => ({
    path: f.path,
    name: f.name,
    delimiter: f.delimiter,
    specialUse: f.specialUse,
    selectable: !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"),
  }));
}

function delimiterAgnostic(path: string): string {
  return path.toLowerCase().replace(/[./]/g, "/");
}

/** Pure matcher behind resolveFolder: exact → case-insensitive → delimiter-agnostic → unique leaf name. */
export function matchFolder(folders: FolderInfo[], requested: string): string {
  const wanted = requested.trim();
  const selectable = folders.filter((f) => f.selectable);
  if (wanted.toUpperCase() === "INBOX") {
    const inbox = selectable.find((f) => f.path.toUpperCase() === "INBOX");
    if (inbox) return inbox.path;
  }
  const exact = selectable.find((f) => f.path === wanted);
  if (exact) return exact.path;

  const lower = wanted.toLowerCase();
  const steps: Array<(f: FolderInfo) => boolean> = [
    (f) => f.path.toLowerCase() === lower,
    (f) => delimiterAgnostic(f.path) === delimiterAgnostic(wanted),
    (f) => f.name.toLowerCase() === lower,
  ];
  for (const step of steps) {
    const hits = selectable.filter(step);
    if (hits.length === 1) return hits[0].path;
  }

  const suggestions = selectable
    .filter((f) => f.path.toLowerCase().includes(lower) || lower.includes(f.name.toLowerCase()))
    .map((f) => f.path)
    .slice(0, 5);
  throw new FolderNotFoundError(requested, suggestions);
}

/** Resolve a folder name supplied by the AI to the server's exact, selectable path — or throw. */
export async function resolveFolder(client: ImapFlow, requested: string): Promise<string> {
  return matchFolder(await listFolderInfo(client), requested);
}

export function pickSpecialFolder(folders: FolderInfo[], use: SpecialUse): string | null {
  const selectable = folders.filter((f) => f.selectable);
  const flagged = selectable.find((f) => f.specialUse === use);
  if (flagged) return flagged.path;
  for (const candidate of FALLBACK_PATHS[use]) {
    const hit = selectable.find((f) => f.path.toLowerCase() === candidate);
    if (hit) return hit.path;
  }
  return null;
}

export async function findSpecialFolder(client: ImapFlow, use: SpecialUse): Promise<string | null> {
  return pickSpecialFolder(await listFolderInfo(client), use);
}

export async function requireSpecialFolder(client: ImapFlow, use: SpecialUse): Promise<string> {
  const path = await findSpecialFolder(client, use);
  if (!path) {
    throw new Error(`Could not find the ${use.slice(1)} folder on this mail server. Use list_folders to check the folder names.`);
  }
  return path;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/imap/__tests__/folders.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/imap/folders.ts src/imap/__tests__/folders.test.ts
git commit -m "feat(imap): resolve folder names safely and find special folders

Matches exact, case-insensitive, delimiter-agnostic and unique leaf
names, never resolves to \\Noselect folders and suggests alternatives.
Special folders use SPECIAL-USE, then English and German names.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Search never widens

**Files:**
- Create: `src/imap/search-query.ts`, `src/tools/shared/result.ts`
- Modify (replace whole file): `src/tools/search-emails.ts`
- Test: `src/imap/__tests__/search-query.test.ts`, `src/tools/__tests__/search-emails.test.ts`

**Interfaces:**
- Consumes: `strictSearch` (Task 2), `resolveFolder` (Task 3), `FakeImap`, `connectHarness`, `buildRaw` (Task 1).
- Produces:
  - `searchFilterShape` (zod raw shape: `query, subject, from, to, cc, since, before, unread, flagged, answered, keyword, hasAttachment, largerThan, smallerThan, header`), `type SearchFilters`
  - `class UnsupportedFilterError extends Error`
  - `interface CompiledSearch { query: SearchObject; applied: Record<string, unknown>; hasAttachment?: boolean }`
  - `compileSearch(filters: SearchFilters, mailbox: MailboxObject | false): CompiledSearch`, `hasNonAsciiText(filters): boolean`
  - `toJson(data): string`, `jsonResult(data)`, `errorResult(prefix, error)`
  - `search_emails` response adds `folder` (resolved), `uidValidity` (string), `appliedFilters`, optional `attachmentScanLimited`, per message `messageId`. New filter `keyword`; `hasAttachment: false` now works.

- [ ] **Step 1: Write the failing tests**

Create `src/imap/__tests__/search-query.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { UnsupportedFilterError, compileSearch, searchFilterShape } from "../search-query.js";

const mailbox = (permanent: string[]) =>
  ({ permanentFlags: new Set(permanent), flags: new Set<string>() }) as any;

describe("compileSearch", () => {
  it("returns { all: true } only when no filter is given", () => {
    expect(compileSearch({}, mailbox(["\\*"])).query).toEqual({ all: true });
  });

  it("echoes every applied filter", () => {
    const compiled = compileSearch({ from: "anna@example.com", since: "2026-01-01", unread: true }, mailbox(["\\*"]));
    expect(compiled.query).toEqual({ from: "anna@example.com", since: "2026-01-01", seen: false });
    expect(compiled.applied).toEqual({ from: "anna@example.com", since: "2026-01-01", unread: true });
  });

  it("refuses a keyword the folder cannot store instead of silently dropping it", () => {
    expect(() => compileSearch({ keyword: "$Done" }, mailbox(["\\Seen", "\\Flagged"]))).toThrow(UnsupportedFilterError);
  });

  it("rejects an inverted date range", () => {
    expect(() => compileSearch({ since: "2026-03-01", before: "2026-01-01" }, mailbox(["\\*"]))).toThrow(/earlier/);
  });

  it("keeps hasAttachment=false for client-side filtering", () => {
    expect(compileSearch({ hasAttachment: false }, mailbox(["\\*"])).hasAttachment).toBe(false);
  });
});

describe("searchFilterShape date validation", () => {
  const schema = z.object(searchFilterShape);
  it.each(["last week", "2026-02-30", "14.10.2026", "2026-1-5"])("rejects %s", (value) => {
    expect(schema.safeParse({ since: value }).success).toBe(false);
  });
  it("accepts a real date", () => {
    expect(schema.safeParse({ since: "2026-02-28" }).success).toBe(true);
  });
});
```

Create `src/tools/__tests__/search-emails.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { connectHarness, type Harness } from "../../__tests__/helpers/mcp-harness.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as searchEmails from "../search-emails.js";

describe("search_emails", () => {
  let imap: FakeImap;
  let h: Harness;

  beforeEach(async () => {
    imap = new FakeImap();
    imap.addMessage("INBOX", await buildRaw({ from: "anna@example.com", to: "me@example.com", subject: "Angebot" }), {
      internalDate: new Date("2026-01-10T09:00:00Z"),
    });
    imap.addMessage("INBOX", await buildRaw({ from: "bob@example.com", to: "me@example.com", subject: "Rechnung" }), {
      internalDate: new Date("2026-02-10T09:00:00Z"),
    });
    imap.addMessage("INBOX", await buildRaw({ from: "anna@example.com", to: "me@example.com", subject: "Termin" }), {
      internalDate: new Date("2026-03-10T09:00:00Z"),
    });
    h = await connectHarness((server) => searchEmails.register(server, async () => imap.asClient()));
  });

  afterEach(async () => {
    await h.close();
  });

  it("returns only matching messages and echoes the applied filters", async () => {
    const res = await h.call("search_emails", { from: "anna@example.com" });
    expect(res.isError).toBe(false);
    expect(res.json.totalMatches).toBe(2);
    expect(res.json.appliedFilters).toEqual({ from: "anna@example.com" });
    expect(res.json.messages.map((m: any) => m.uid)).toEqual([3, 1]);
  });

  it("fails instead of returning every email when the server rejects the search", async () => {
    imap.failOn("search", "false");
    const res = await h.call("search_emails", { from: "anna@example.com" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/rejected the search/);
    expect(res.json).toBeUndefined();
  });

  it("fails instead of falling back to all emails when search throws", async () => {
    imap.failOn("search", "throw");
    const res = await h.call("search_emails", { subject: "Angebot" });
    expect(res.isError).toBe(true);
    expect(res.text).not.toMatch(/"messages"/);
  });

  it("adds a hint when a non-ASCII search is rejected", async () => {
    imap.failOn("search", "false");
    const res = await h.call("search_emails", { subject: "Größe" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/non-ASCII/);
  });

  it("rejects a natural-language date instead of ignoring it", async () => {
    const res = await h.call("search_emails", { since: "last week" });
    expect(res.isError).toBe(true);
    expect(imap.callsTo("search")).toHaveLength(0);
  });

  it("refuses a keyword search on a server without custom keywords", async () => {
    imap.folders.get("INBOX")!.permanentFlags = new Set(["\\Seen", "\\Flagged", "\\Deleted"]);
    const res = await h.call("search_emails", { keyword: "$Erledigt" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not support the custom keyword/);
  });

  it("reports an unknown folder with suggestions instead of searching elsewhere", async () => {
    imap.addFolder("Archiv");
    const res = await h.call("search_emails", { folder: "Archive" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not exist/);
  });

  it("returns uidValidity as a string", async () => {
    const res = await h.call("search_emails", {});
    expect(typeof res.json.uidValidity).toBe("string");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/imap/__tests__/search-query.test.ts src/tools/__tests__/search-emails.test.ts`
Expected: FAIL — `search-query.test.ts` cannot resolve `"../search-query.js"`; all 8 `search_emails` tests fail against the current tool (no `appliedFilters`, the fallback returns messages, `since: "last week"` is passed to the server, `folder: "Archive"` is opened without resolution).

- [ ] **Step 3: Implement the search compiler and result helpers**

Create `src/imap/search-query.ts`:

```ts
import { z } from "zod";
import type { MailboxObject, SearchObject } from "imapflow";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date format YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Not a valid calendar date");

/** Filter fields shared by every tool that selects messages by criteria. */
export const searchFilterShape = {
  query: z.string().min(1).optional().describe("Text that must appear in the subject or body"),
  subject: z.string().min(1).optional().describe("Text that must appear in the subject line"),
  from: z.string().min(1).optional().describe("Sender address or name (substring match)"),
  to: z.string().min(1).optional().describe("To: recipient address or name (substring match)"),
  cc: z.string().min(1).optional().describe("Cc: recipient address or name (substring match)"),
  since: isoDate.optional().describe("Only emails received on or after this date (YYYY-MM-DD)"),
  before: isoDate.optional().describe("Only emails received before this date, exclusive (YYYY-MM-DD)"),
  unread: z.boolean().optional().describe("true = only unread, false = only read"),
  flagged: z.boolean().optional().describe("true = only flagged/starred, false = only unflagged"),
  answered: z.boolean().optional().describe("true = only replied-to, false = only unreplied"),
  keyword: z.string().min(1).optional().describe("Only emails carrying this custom keyword, e.g. $Done"),
  hasAttachment: z.boolean().optional().describe("true = only with attachments, false = only without"),
  largerThan: z.number().int().positive().optional().describe("Only emails larger than this many bytes"),
  smallerThan: z.number().int().positive().optional().describe("Only emails smaller than this many bytes"),
  header: z.record(z.string()).optional().describe('Header substring matches, e.g. {"List-Id": "newsletter"}'),
};

const searchFilterSchema = z.object(searchFilterShape);
export type SearchFilters = z.infer<typeof searchFilterSchema>;

export class UnsupportedFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFilterError";
  }
}

export interface CompiledSearch {
  /** Query for client.search(); `{ all: true }` only when no filter was given. */
  query: SearchObject;
  /** Filters that were actually applied — echoed back so the AI can verify its selection. */
  applied: Record<string, unknown>;
  /** IMAP has no attachment criterion; this one is evaluated client-side from BODYSTRUCTURE. */
  hasAttachment?: boolean;
}

function canUseKeyword(mailbox: MailboxObject | false, keyword: string): boolean {
  if (!mailbox) return false;
  const permanent = mailbox.permanentFlags;
  return !permanent || permanent.has("\\*") || permanent.has(keyword) || mailbox.flags.has(keyword);
}

/**
 * Translate filters into an imapflow SearchObject. Throws instead of dropping a criterion,
 * because a dropped criterion widens the match — up to the whole folder.
 */
export function compileSearch(filters: SearchFilters, mailbox: MailboxObject | false): CompiledSearch {
  const query: SearchObject = {};
  const applied: Record<string, unknown> = {};

  if (filters.query) {
    query.or = [{ subject: filters.query }, { body: filters.query }];
    applied.query = filters.query;
  }
  for (const key of ["subject", "from", "to", "cc"] as const) {
    const value = filters[key];
    if (value) {
      query[key] = value;
      applied[key] = value;
    }
  }
  if (filters.since) {
    query.since = filters.since;
    applied.since = filters.since;
  }
  if (filters.before) {
    query.before = filters.before;
    applied.before = filters.before;
  }
  if (filters.since && filters.before && filters.since >= filters.before) {
    throw new UnsupportedFilterError(`"since" (${filters.since}) must be earlier than "before" (${filters.before}).`);
  }
  if (filters.unread !== undefined) {
    query.seen = !filters.unread;
    applied.unread = filters.unread;
  }
  if (filters.flagged !== undefined) {
    query.flagged = filters.flagged;
    applied.flagged = filters.flagged;
  }
  if (filters.answered !== undefined) {
    query.answered = filters.answered;
    applied.answered = filters.answered;
  }
  if (filters.keyword) {
    if (!canUseKeyword(mailbox, filters.keyword)) {
      throw new UnsupportedFilterError(
        `This folder does not support the custom keyword "${filters.keyword}" (common on Microsoft Exchange), so no message can carry it. Not searching.`,
      );
    }
    query.keyword = filters.keyword;
    applied.keyword = filters.keyword;
  }
  if (filters.largerThan !== undefined) {
    query.larger = filters.largerThan;
    applied.largerThan = filters.largerThan;
  }
  if (filters.smallerThan !== undefined) {
    query.smaller = filters.smallerThan;
    applied.smallerThan = filters.smallerThan;
  }
  if (filters.header && Object.keys(filters.header).length > 0) {
    query.header = filters.header;
    applied.header = filters.header;
  }
  if (filters.hasAttachment !== undefined) applied.hasAttachment = filters.hasAttachment;

  if (Object.keys(query).length === 0) query.all = true;
  return { query, applied, hasAttachment: filters.hasAttachment };
}

/** True when any text filter contains non-ASCII characters (some servers reject CHARSET UTF-8). */
export function hasNonAsciiText(filters: SearchFilters): boolean {
  const texts = [filters.query, filters.subject, filters.from, filters.to, filters.cc, ...Object.values(filters.header ?? {})];
  return texts.some((t) => typeof t === "string" && /[^\x00-\x7F]/.test(t));
}
```

Create `src/tools/shared/result.ts`:

```ts
import { errorMessage } from "../../errors.js";

/** JSON.stringify that turns bigint values (e.g. UIDVALIDITY) into strings. */
export function toJson(data: unknown): string {
  return JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2);
}

export function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: toJson(data) }] };
}

export function errorResult(prefix: string, error: unknown) {
  return { content: [{ type: "text" as const, text: `${prefix}: ${errorMessage(error)}` }], isError: true };
}
```

- [ ] **Step 4: Rewrite the tool**

Replace `src/tools/search-emails.ts` with:

```ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { scanSubjectOnly } from "../security/injection-detector.js";
import { resolveFolder } from "../imap/folders.js";
import { strictSearch } from "../imap/strict.js";
import { compileSearch, hasNonAsciiText, searchFilterShape } from "../imap/search-query.js";
import { errorResult, jsonResult } from "./shared/result.js";

/** Cap for the client-side attachment scan (IMAP has no attachment search criterion). */
const ATTACHMENT_SCAN_LIMIT = 5000;

/** Safely extract address from an envelope address object */
function parseEnvelopeAddress(a: any): { name: string; address: string } {
  return {
    name: a.name || "",
    address: a.address || (a.mailbox && a.host ? `${a.mailbox}@${a.host}` : ""),
  };
}

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "search_emails",
    "Search emails with filters similar to Gmail/Outlook. Combine any filters freely. " +
      "The response echoes appliedFilters; if the server cannot apply a filter the call fails — it never falls back to returning all emails.",
    {
      folder: z.string().default("INBOX").describe("Mailbox folder path (e.g., INBOX, Sent, Drafts)"),
      ...searchFilterShape,
      maxResults: z.number().int().min(1).max(50).default(20).describe("Maximum results to return"),
      offset: z.number().int().min(0).default(0).describe("Skip this many results (for pagination)"),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ folder, maxResults, offset, ...filters }) => {
      try {
        const client = await getClient();
        const path = await resolveFolder(client, folder);
        const lock = await client.getMailboxLock(path);
        try {
          const compiled = compileSearch(filters, client.mailbox);
          let uids: number[];
          try {
            uids = await strictSearch(client, compiled.query);
          } catch (searchError) {
            const hint = hasNonAsciiText(filters)
              ? " The server may not support searching for non-ASCII text (umlauts etc.); try an ASCII-only search term."
              : "";
            return errorResult("Error searching emails", `${(searchError as Error).message}${hint}`);
          }

          let attachmentScanLimited = false;
          if (compiled.hasAttachment !== undefined && uids.length > 0) {
            const candidates = uids.slice(-ATTACHMENT_SCAN_LIMIT);
            attachmentScanLimited = candidates.length < uids.length;
            const keep: number[] = [];
            for await (const msg of client.fetch(candidates, { uid: true, bodyStructure: true }, { uid: true })) {
              if (hasAttachmentPart(msg.bodyStructure) === compiled.hasAttachment) keep.push(msg.uid);
            }
            uids = keep.sort((a, b) => a - b);
          }

          // Paginate: most recent first
          const totalMatches = uids.length;
          const pageUids = uids.slice().reverse().slice(offset, offset + maxResults);
          const base = {
            folder: path,
            uidValidity: client.mailbox ? client.mailbox.uidValidity : undefined,
            appliedFilters: compiled.applied,
            totalMatches,
            offset,
            ...(attachmentScanLimited ? { attachmentScanLimited: true } : {}),
          };

          if (pageUids.length === 0) {
            return jsonResult({ ...base, count: 0, messages: [] });
          }

          const messages: any[] = [];
          for await (const msg of client.fetch(pageUids, {
            uid: true,
            envelope: true,
            flags: true,
            bodyStructure: true,
            size: true,
          }, { uid: true })) {
            const subject = msg.envelope?.subject;
            const _injectionScan = subject ? scanSubjectOnly(subject) : undefined;
            messages.push({
              uid: msg.uid,
              messageId: msg.envelope?.messageId,
              subject,
              from: msg.envelope?.from?.map(parseEnvelopeAddress),
              to: msg.envelope?.to?.map(parseEnvelopeAddress),
              date: msg.envelope?.date?.toISOString(),
              flags: Array.from(msg.flags || []),
              hasAttachment: hasAttachmentPart(msg.bodyStructure),
              size: msg.size,
              ...(_injectionScan?.hasInjection ? { _injectionScan } : {}),
            });
          }

          // Sort by UID descending (most recent first) since IMAP fetch order is unspecified
          messages.sort((a, b) => b.uid - a.uid);
          return jsonResult({ ...base, count: messages.length, messages });
        } finally {
          try { lock.release(); } catch { /* connection may already be dead */ }
        }
      } catch (error) {
        return errorResult("Error searching emails", error);
      }
    }
  );
}

/** Check if a MIME body structure contains attachment parts */
function hasAttachmentPart(structure: any): boolean {
  if (!structure) return false;
  if (structure.disposition === "attachment") return true;
  if (structure.childNodes) {
    return structure.childNodes.some(hasAttachmentPart);
  }
  return false;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/imap/__tests__/search-query.test.ts src/tools/__tests__/search-emails.test.ts`
Expected: PASS — 18 tests.

Run: `npm run build && npm test`
Expected: build succeeds; all test files pass.

- [ ] **Step 6: Commit**

```bash
git add src/imap/search-query.ts src/imap/__tests__/search-query.test.ts src/tools/shared/result.ts src/tools/search-emails.ts src/tools/__tests__/search-emails.test.ts
git commit -m "fix(search): never fall back to all mail when a filter fails

A failed or rejected search used to return every message in the folder
(or silently 0 hits); invalid dates and unsupported keywords were
dropped by imapflow, widening the match. The search now fails with a
clear error, validates dates, echoes appliedFilters and uidValidity.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Organising tools fail closed

**Files:**
- Modify (replace whole file): `src/tools/move-email.ts`, `src/tools/flag-email.ts`, `src/tools/mark-as-read.ts`, `src/tools/delete-email.ts`
- Modify: `src/tools/read-email.ts`, `src/tools/download-attachment.ts`
- Test: `src/tools/__tests__/organize-tools.test.ts`, `src/tools/__tests__/read-tools.test.ts`

**Interfaces:**
- Consumes: `resolveFolder`, `requireSpecialFolder` (Task 3); `existingUids`, `strictMove`, `strictStoreFlags`, `unsupportedFlags`, `safeExpunge`, `downloadMessage`, `normalizeFlag`, `uniqueUids` (Task 2); `jsonResult`, `errorResult` (Task 4).
- Produces: responses now carry the resolved folder paths, the UIDs actually affected and `missingUids` when some requested UIDs did not exist. `uids` arrays are limited to 1000 (500 for `delete_email`). `flag_email` refuses `\Deleted` and unsupported keywords.

- [ ] **Step 1: Write the failing tests**

Create `src/tools/__tests__/organize-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { connectHarness, type Harness } from "../../__tests__/helpers/mcp-harness.js";
import * as moveEmail from "../move-email.js";
import * as flagEmail from "../flag-email.js";
import * as markAsRead from "../mark-as-read.js";
import * as deleteEmail from "../delete-email.js";

describe("organizing tools", () => {
  let imap: FakeImap;
  let h: Harness;

  beforeEach(async () => {
    imap = new FakeImap();
    imap.addFolder("Archive");
    imap.addFolder("Trash", { specialUse: "\\Trash" });
    imap.addFolder("Projects", { flags: ["\\Noselect"] });
    for (const s of ["a", "b", "c"]) imap.addMessage("INBOX", `Subject: ${s}\r\n\r\nbody`);
    h = await connectHarness((server) => {
      const getClient = async () => imap.asClient();
      moveEmail.register(server, getClient);
      flagEmail.register(server, getClient);
      markAsRead.register(server, getClient);
      deleteEmail.register(server, getClient);
    });
  });

  afterEach(async () => {
    await h.close();
  });

  describe("move_email", () => {
    it("moves only existing UIDs and reports missing ones", async () => {
      const res = await h.call("move_email", { uids: [1, 99], destination: "archive" });
      expect(res.isError).toBe(false);
      expect(res.json).toMatchObject({ to: "Archive", moved: 1, missingUids: [99] });
      expect(imap.uidsIn("INBOX")).toEqual([2, 3]);
    });

    it("refuses a destination that does not exist", async () => {
      const res = await h.call("move_email", { uids: [1], destination: "Archiv 2025" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/does not exist/);
      expect(imap.uidsIn("INBOX")).toEqual([1, 2, 3]);
    });

    it("refuses a \\Noselect parent folder", async () => {
      const res = await h.call("move_email", { uids: [1], destination: "Projects" });
      expect(res.isError).toBe(true);
      expect(imap.callsTo("messageMove")).toHaveLength(0);
    });

    it("reports a server refusal as an error, not success", async () => {
      imap.failOn("messageMove", "false");
      const res = await h.call("move_email", { uids: [1], destination: "Archive" });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/Nothing was moved/);
    });
  });

  describe("flag_email", () => {
    it("normalises flag spelling", async () => {
      const res = await h.call("flag_email", { uids: [1], action: "add", flags: ["flagged"] });
      expect(res.isError).toBe(false);
      expect(imap.message("INBOX", 1)!.flags.has("\\Flagged")).toBe(true);
    });

    it("refuses custom keywords on servers that cannot store them", async () => {
      imap.folders.get("INBOX")!.permanentFlags = new Set(["\\Seen", "\\Flagged", "\\Deleted", "\\Answered", "\\Draft"]);
      const res = await h.call("flag_email", { uids: [1], action: "add", flags: ["$Erledigt"] });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/does not support the keyword/);
      expect(imap.callsTo("messageFlagsAdd")).toHaveLength(0);
    });

    it("cannot be used to delete (\\Deleted is reserved for delete_email)", async () => {
      const res = await h.call("flag_email", { uids: [1], action: "add", flags: ["\\Deleted"] });
      expect(res.isError).toBe(true);
      expect(imap.message("INBOX", 1)!.flags.has("\\Deleted")).toBe(false);
    });

    it("rejects keywords with spaces", async () => {
      const res = await h.call("flag_email", { uids: [1], action: "add", flags: ["to do"] });
      expect(res.isError).toBe(true);
    });
  });

  describe("mark_as_read", () => {
    it("reports a server refusal as an error", async () => {
      imap.failOn("messageFlagsAdd", "false");
      const res = await h.call("mark_as_read", { uids: [1] });
      expect(res.isError).toBe(true);
    });

    it("marks existing messages and lists missing UIDs", async () => {
      const res = await h.call("mark_as_read", { uids: [2, 7] });
      expect(res.json).toMatchObject({ uids: [2], missingUids: [7], markedAs: "read" });
      expect(imap.message("INBOX", 2)!.flags.has("\\Seen")).toBe(true);
    });
  });

  describe("delete_email", () => {
    it("moves to Trash", async () => {
      const res = await h.call("delete_email", { uids: [1] });
      expect(res.json).toMatchObject({ action: "moved_to_trash", trashFolder: "Trash" });
      expect(imap.uidsIn("Trash")).toEqual([1]);
    });

    it("permanently deleting from Trash never expunges other \\Deleted messages without UIDPLUS", async () => {
      imap.capabilities.delete("UIDPLUS");
      imap.addMessage("Trash", "Subject: old\r\n\r\n", { flags: ["\\Deleted"] });
      imap.addMessage("Trash", "Subject: target\r\n\r\n");
      const res = await h.call("delete_email", { folder: "Trash", uids: [2] });
      expect(res.isError).toBe(true);
      expect(imap.uidsIn("Trash")).toEqual([1, 2]);
    });

    it("reports a failed move to Trash as an error", async () => {
      imap.failOn("messageMove", "false");
      const res = await h.call("delete_email", { uids: [1] });
      expect(res.isError).toBe(true);
      expect(imap.uidsIn("INBOX")).toEqual([1, 2, 3]);
    });
  });
});
```

Create `src/tools/__tests__/read-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { connectHarness, type Harness } from "../../__tests__/helpers/mcp-harness.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as readEmail from "../read-email.js";
import * as downloadAttachment from "../download-attachment.js";

describe("read tools", () => {
  let imap: FakeImap;
  let h: Harness;

  beforeEach(async () => {
    imap = new FakeImap();
    imap.addMessage("INBOX", await buildRaw({ from: "a@example.com", to: "me@example.com", subject: "Hallo", text: "Inhalt" }));
    h = await connectHarness((server) => {
      readEmail.register(server, async () => imap.asClient());
      downloadAttachment.register(server, async () => imap.asClient());
    });
  });

  afterEach(async () => {
    await h.close();
  });

  it("read_email resolves the folder name case-insensitively", async () => {
    const res = await h.call("read_email", { folder: "inbox", uid: 1 });
    expect(res.isError).toBe(false);
    expect(res.json.subject).toBe("Hallo");
  });

  it("read_email explains a missing UID instead of a parser error", async () => {
    const res = await h.call("read_email", { uid: 42 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/No message with UID 42 exists in "INBOX"/);
  });

  it("download_attachment reports an unknown folder", async () => {
    const res = await h.call("download_attachment", { folder: "Rechnungen", uid: 1, attachmentIndex: 0 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Folder "Rechnungen" does not exist/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/tools/__tests__/organize-tools.test.ts src/tools/__tests__/read-tools.test.ts`
Expected: FAIL — 15 of 16 tests fail against the current tools (e.g. `move_email` to `"Archiv 2025"` reports `success: true`; `flag_email` accepts `\Deleted`; `read_email` with `folder: "inbox"` cannot open the mailbox). Only "delete_email > moves to Trash" passes.

- [ ] **Step 3: Rewrite `move_email`**

Replace `src/tools/move-email.ts` with:

```ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { resolveFolder } from "../imap/folders.js";
import { existingUids, strictMove } from "../imap/strict.js";
import { uniqueUids } from "../imap/flags.js";
import { errorResult, jsonResult } from "./shared/result.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "move_email",
    "Move emails from one folder to another. The destination folder must already exist.",
    {
      folder: z.string().default("INBOX").describe("Source folder path"),
      uids: z.array(z.number().int().positive()).min(1).max(1000).describe("Email UIDs to move"),
      destination: z.string().describe("Destination folder path (e.g., Archive, Trash)"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ folder, uids, destination }) => {
      try {
        const client = await getClient();
        const source = await resolveFolder(client, folder);
        const target = await resolveFolder(client, destination);
        if (source === target) {
          return errorResult("Error moving emails", `Source and destination are the same folder ("${source}"). Nothing was moved.`);
        }

        const lock = await client.getMailboxLock(source);
        try {
          const requested = uniqueUids(uids);
          const present = await existingUids(client, requested);
          const missingUids = requested.filter((u) => !present.includes(u));
          if (present.length === 0) {
            return errorResult("Error moving emails", `None of the UIDs exist in "${source}". Nothing was moved.`);
          }

          const uidMap = await strictMove(client, present, target);
          return jsonResult({
            success: true,
            from: source,
            to: target,
            moved: present.length,
            uids: present,
            ...(missingUids.length > 0 ? { missingUids } : {}),
            ...(uidMap.size > 0 ? { uidMapping: Object.fromEntries(uidMap) } : {}),
          });
        } finally {
          try { lock.release(); } catch { /* connection may already be dead */ }
        }
      } catch (error) {
        return errorResult("Error moving emails", error);
      }
    }
  );
}
```

- [ ] **Step 4: Rewrite `flag_email`**

Replace `src/tools/flag-email.ts` with:

```ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { resolveFolder } from "../imap/folders.js";
import { existingUids, strictStoreFlags, unsupportedFlags } from "../imap/strict.js";
import { normalizeFlag, uniqueUids } from "../imap/flags.js";
import { errorResult, jsonResult } from "./shared/result.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "flag_email",
    "Add or remove flags on emails: \\Seen, \\Answered, \\Flagged, \\Draft, or custom keywords like $Done. " +
      "Custom keywords fail with an error on servers that do not support them (e.g. Microsoft Exchange). " +
      "Deleting is not possible here; use delete_email.",
    {
      folder: z.string().default("INBOX").describe("Mailbox folder path"),
      uids: z.array(z.number().int().positive()).min(1).max(1000).describe("Email UIDs to modify"),
      action: z.enum(["add", "remove"]).describe("Whether to add or remove the flags"),
      flags: z.array(z.string()).min(1).describe('Flags to set, e.g. ["\\\\Flagged", "$Done"]'),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ folder, uids, action, flags }) => {
      try {
        const normalized = [...new Set(flags.map(normalizeFlag))];
        if (action === "add" && normalized.includes("\\Deleted")) {
          return errorResult(
            "Error flagging emails",
            "flag_email cannot mark messages as deleted. Use delete_email, which requires the delete permission.",
          );
        }

        const client = await getClient();
        const path = await resolveFolder(client, folder);
        const lock = await client.getMailboxLock(path);
        try {
          if (action === "add") {
            const unsupported = unsupportedFlags(client.mailbox, normalized);
            if (unsupported.length > 0) {
              return errorResult(
                "Error flagging emails",
                `This mail server does not support the keyword(s) ${unsupported.join(", ")} in "${path}" (common on Microsoft Exchange). ` +
                  "Use \\Flagged or move the emails into a folder instead. Nothing was changed.",
              );
            }
          }

          const requested = uniqueUids(uids);
          const present = await existingUids(client, requested);
          const missingUids = requested.filter((u) => !present.includes(u));
          if (present.length === 0) {
            return errorResult("Error flagging emails", `None of the UIDs exist in "${path}". Nothing was changed.`);
          }

          await strictStoreFlags(client, present, normalized, action);
          return jsonResult({
            success: true,
            folder: path,
            uids: present,
            action,
            flags: normalized,
            ...(missingUids.length > 0 ? { missingUids } : {}),
          });
        } finally {
          try { lock.release(); } catch { /* connection may already be dead */ }
        }
      } catch (error) {
        return errorResult("Error flagging emails", error);
      }
    }
  );
}
```

- [ ] **Step 5: Rewrite `mark_as_read`**

Replace `src/tools/mark-as-read.ts` with:

```ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { resolveFolder } from "../imap/folders.js";
import { existingUids, strictStoreFlags } from "../imap/strict.js";
import { uniqueUids } from "../imap/flags.js";
import { errorResult, jsonResult } from "./shared/result.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "mark_as_read",
    "Mark one or more emails as read/unread by UID",
    {
      folder: z.string().default("INBOX").describe("Mailbox folder path"),
      uids: z.array(z.number().int().positive()).min(1).max(1000).describe("Email UIDs to mark"),
      read: z.boolean().default(true).describe("true = mark read, false = mark unread"),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ folder, uids, read }) => {
      try {
        const client = await getClient();
        const path = await resolveFolder(client, folder);
        const lock = await client.getMailboxLock(path);

        try {
          const requested = uniqueUids(uids);
          const present = await existingUids(client, requested);
          const missingUids = requested.filter((u) => !present.includes(u));
          if (present.length === 0) {
            return errorResult("Error marking emails", `None of the UIDs exist in "${path}". Nothing was changed.`);
          }

          await strictStoreFlags(client, present, ["\\Seen"], read ? "add" : "remove");
          return jsonResult({
            success: true,
            folder: path,
            uids: present,
            markedAs: read ? "read" : "unread",
            ...(missingUids.length > 0 ? { missingUids } : {}),
          });
        } finally {
          try { lock.release(); } catch { /* connection may already be dead */ }
        }
      } catch (error) {
        return errorResult("Error marking emails", error);
      }
    }
  );
}
```

- [ ] **Step 6: Rewrite `delete_email`**

Replace `src/tools/delete-email.ts` with:

```ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { requireSpecialFolder, resolveFolder } from "../imap/folders.js";
import { existingUids, safeExpunge, strictMove } from "../imap/strict.js";
import { uniqueUids } from "../imap/flags.js";
import { errorResult, jsonResult } from "./shared/result.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>) {
  server.tool(
    "delete_email",
    "Delete emails by moving them to Trash (or permanently remove them if they are already in Trash)",
    {
      folder: z.string().default("INBOX").describe("Folder containing the emails"),
      uids: z.array(z.number().int().positive()).min(1).max(500).describe("Email UIDs to delete"),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ folder, uids }) => {
      try {
        const client = await getClient();
        const path = await resolveFolder(client, folder);
        const trashFolder = await requireSpecialFolder(client, "\\Trash");
        const lock = await client.getMailboxLock(path);

        try {
          const requested = uniqueUids(uids);
          const present = await existingUids(client, requested);
          const missingUids = requested.filter((u) => !present.includes(u));
          if (present.length === 0) {
            return errorResult("Error deleting emails", `None of the UIDs exist in "${path}". Nothing was deleted.`);
          }
          const missing = missingUids.length > 0 ? { missingUids } : {};

          if (path === trashFolder) {
            await safeExpunge(client, present);
            return jsonResult({ success: true, action: "expunged", folder: path, uids: present, ...missing });
          }

          await strictMove(client, present, trashFolder);
          return jsonResult({ success: true, action: "moved_to_trash", from: path, trashFolder, uids: present, ...missing });
        } finally {
          try { lock.release(); } catch { /* connection may already be dead */ }
        }
      } catch (error) {
        return errorResult("Error deleting emails", error);
      }
    }
  );
}
```

- [ ] **Step 7: Route the read tools through folder resolution and `downloadMessage`**

In `src/tools/read-email.ts`, add below `import { recordScan } from "./health-check.js";`:

```ts
import { resolveFolder } from "../imap/folders.js";
import { downloadMessage } from "../imap/strict.js";
```

and replace

```ts
        const lock = await client.getMailboxLock(folder);
```

with

```ts
        const path = await resolveFolder(client, folder);
        const lock = await client.getMailboxLock(path);
```

and replace

```ts
          const raw = await client.download(uid.toString(), undefined, { uid: true });
          const parsed = await simpleParser(raw.content);
```

with

```ts
          const parsed = await simpleParser(await downloadMessage(client, uid, path));
```

In `src/tools/download-attachment.ts`, add below `import { scanForInjection } from "../security/injection-detector.js";` the same two imports, and apply the same two replacements (the `getMailboxLock(folder)` line and the `client.download` + `simpleParser(raw.content)` pair).

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/tools/__tests__/organize-tools.test.ts src/tools/__tests__/read-tools.test.ts`
Expected: PASS — 16 tests.

Run: `npm run build && npm test && npm run typecheck`
Expected: all succeed.

- [ ] **Step 9: Commit**

```bash
git add src/tools/move-email.ts src/tools/flag-email.ts src/tools/mark-as-read.ts src/tools/delete-email.ts src/tools/read-email.ts src/tools/download-attachment.ts src/tools/__tests__/organize-tools.test.ts src/tools/__tests__/read-tools.test.ts
git commit -m "fix(tools): report server refusals instead of false success

move/flag/mark/delete now resolve folders (destination must exist and
be selectable), act only on existing UIDs, report missingUids and fail
when the server refuses. flag_email checks PERMANENTFLAGS before custom
keywords and can no longer set \\Deleted (write tier cannot delete).
Permanent delete refuses plain EXPUNGE without UIDPLUS when other
messages are marked deleted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Standards-compliant message composition

**Files:**
- Create: `src/mail/headers.ts`, `src/mail/compose.ts`
- Modify (replace whole file): `src/tools/create-draft.ts`
- Modify (bridge, rewritten later in Tasks 7–8): `src/tools/reply-draft.ts`, `src/tools/send-draft.ts`
- Test: `src/mail/__tests__/headers.test.ts`, `src/mail/__tests__/compose.test.ts`, `src/tools/__tests__/create-draft.test.ts`

**Interfaces:**
- Consumes: `requireSpecialFolder` (Task 3), `strictAppend` (Task 2), `jsonResult`/`errorResult` (Task 4).
- Produces:
  - `removeHeaders(raw: Buffer, names: string[]): Buffer`, `getHeader(raw: Buffer, name: string): string | undefined`, `setHeader(raw: Buffer, name: string, value: string): Buffer`, `rfc5322Date(date: Date): string`
  - `interface OutgoingAttachment { filename: string; content: string; contentType: string }`
  - `interface ComposeInput { from; to; cc?; bcc?; replyTo?; subject: string; text: string; html?; inReplyTo?; references?; attachments?: OutgoingAttachment[]; date?: Date }`
  - `interface ComposedMessage { raw: Buffer; messageId: string; envelope: { from: string; to: string[] } }`, `composeMessage(input: ComposeInput): Promise<ComposedMessage>`
  - `create-draft.ts` exports `type DraftAttachment`, `attachmentSchema`, `validateAttachments`, `register`. `buildRfc822Message` and `findDraftsFolder` are removed. `create_draft` now returns `uid` and `messageId`.

- [ ] **Step 1: Write the failing tests**

Create `src/mail/__tests__/headers.test.ts`:

```ts
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
```

Create `src/mail/__tests__/compose.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { simpleParser } from "mailparser";
import { composeMessage } from "../compose.js";
import { getHeader } from "../headers.js";

function headerBlocks(raw: Buffer): string[] {
  // every MIME header block: top-level and per part
  return raw
    .toString("latin1")
    .split(/\r\n--[^\r\n]+\r\n/)
    .map((chunk) => chunk.split("\r\n\r\n")[0]);
}

describe("composeMessage", () => {
  const base = {
    from: { name: "Maximilian Achleitner", address: "max@firma.example" },
    to: "kunde@example.com",
    subject: "Angebot",
    text: "Hallo",
  };

  it("encodes non-ASCII attachment filenames per RFC 2231 and keeps all headers 7-bit", async () => {
    const { raw } = await composeMessage({
      ...base,
      attachments: [{ filename: "Angebot_Größe.pdf", content: Buffer.from("%PDF").toString("base64"), contentType: "application/pdf" }],
    });
    for (const block of headerBlocks(raw)) expect(block).toMatch(/^[\x00-\x7F]*$/);
    expect(raw.toString()).toMatch(/filename\*0?\*=utf-8''Angebot_Gr%C3%B6%C3%9Fe\.pdf/);
    const parsed = await simpleParser(raw);
    expect(parsed.attachments[0].filename).toBe("Angebot_Größe.pdf");
  });

  it("generates a Message-ID on the sender's domain (not @draft)", async () => {
    const { raw, messageId } = await composeMessage(base);
    expect(messageId).toMatch(/^<[^@\s]+@firma.example>$/);
    expect(getHeader(raw, "message-id")).toBe(messageId);
  });

  it("formats the From header with the display name", async () => {
    const { raw } = await composeMessage(base);
    expect(getHeader(raw, "from")).toBe("Maximilian Achleitner <max@firma.example>");
  });

  it("neutralises CRLF header injection in the subject", async () => {
    const { raw } = await composeMessage({ ...base, subject: "Hi\r\nBcc: evil@attacker.com" });
    expect(raw.toString()).not.toMatch(/^Bcc: evil/m);
  });

  it("keeps Bcc in the stored copy and puts Bcc recipients into the envelope", async () => {
    const { raw, envelope } = await composeMessage({ ...base, bcc: "chef@example.com" });
    expect(getHeader(raw, "bcc")).toBe("chef@example.com");
    expect(envelope.to).toEqual(["kunde@example.com", "chef@example.com"]);
  });

  it("never emits lines longer than 998 characters", async () => {
    const { raw } = await composeMessage({ ...base, text: "x".repeat(5000), html: `<p>${"y".repeat(5000)}</p>` });
    for (const line of raw.toString().split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
  });
});
```

Create `src/tools/__tests__/create-draft.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { simpleParser } from "mailparser";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { connectHarness, type Harness } from "../../__tests__/helpers/mcp-harness.js";
import { header } from "../../__tests__/helpers/messages.js";
import * as createDraft from "../create-draft.js";

const ME = "max@firma.example";

describe("create_draft", () => {
  let imap: FakeImap;
  let h: Harness;

  beforeEach(async () => {
    imap = new FakeImap();
    imap.addFolder("Drafts", { specialUse: "\\Drafts" });
    h = await connectHarness((server) => createDraft.register(server, async () => imap.asClient(), ME));
  });

  afterEach(async () => {
    await h.close();
  });

  it("stores an RFC-compliant draft and returns its uid", async () => {
    const res = await h.call("create_draft", {
      to: "kunde@example.com",
      subject: "Angebot",
      body: "Anbei das Angebot.",
      attachments: [{ filename: "Angebot_Größe.pdf", content: Buffer.from("%PDF").toString("base64"), contentType: "application/pdf" }],
    });
    expect(res.isError).toBe(false);
    expect(res.json.uid).toBe(1);
    const draft = imap.message("Drafts", 1)!;
    expect(draft.flags.has("\\Draft")).toBe(true);
    expect(header(draft.raw, "message-id")).toMatch(/@firma.example>$/);
    const parsed = await simpleParser(draft.raw);
    expect(parsed.attachments[0].filename).toBe("Angebot_Größe.pdf");
  });

  it("finds a German-named Drafts folder without SPECIAL-USE", async () => {
    imap.folders.delete("Drafts");
    imap.addFolder("Entwürfe");
    const res = await h.call("create_draft", { to: "a@example.com", subject: "s", body: "b" });
    expect(res.isError).toBe(false);
    expect(res.json.folder).toBe("Entwürfe");
  });

  it("reports a refused APPEND as an error", async () => {
    imap.failOn("append", "false");
    const res = await h.call("create_draft", { to: "a@example.com", subject: "s", body: "b" });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/mail/__tests__/headers.test.ts src/mail/__tests__/compose.test.ts src/tools/__tests__/create-draft.test.ts`
Expected: FAIL — `headers.js`/`compose.js` cannot be resolved; all 3 `create_draft` tests fail against the current tool (no `uid` in the result, `Message-ID` ends in `@draft`, the `Entwürfe` folder is not found).

- [ ] **Step 3: Implement header utilities and the composer**

Create `src/mail/headers.ts`:

```ts
/**
 * Byte-preserving edits on the header block of a raw RFC 5322 message.
 * The header block is handled as latin1 so 8-bit bytes round-trip unchanged.
 */

interface SplitMessage {
  lines: string[];
  eol: string;
  body: Buffer;
}

function split(raw: Buffer): SplitMessage {
  const text = raw.toString("latin1");
  const crlf = text.indexOf("\r\n\r\n");
  const lf = text.indexOf("\n\n");
  let end: number;
  let eol: string;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) {
    end = crlf;
    eol = "\r\n";
  } else if (lf >= 0) {
    end = lf;
    eol = "\n";
  } else {
    return { lines: text.split(/\r?\n/).filter((l) => l !== ""), eol: "\r\n", body: Buffer.alloc(0) };
  }
  const head = text.slice(0, end);
  const body = raw.subarray(end + eol.length * 2);
  return { lines: head.split(eol), eol, body };
}

function join({ lines, eol, body }: SplitMessage): Buffer {
  return Buffer.concat([Buffer.from(lines.join(eol) + eol + eol, "latin1"), body]);
}

function fieldName(line: string): string {
  const colon = line.indexOf(":");
  return colon > 0 ? line.slice(0, colon).trim().toLowerCase() : "";
}

/** Remove every occurrence of the named header fields, including folded continuation lines. */
export function removeHeaders(raw: Buffer, names: string[]): Buffer {
  const parts = split(raw);
  const drop = new Set(names.map((n) => n.toLowerCase()));
  const kept: string[] = [];
  let skipping = false;
  for (const line of parts.lines) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = drop.has(fieldName(line));
    if (!skipping) kept.push(line);
  }
  return join({ ...parts, lines: kept });
}

/** Unfolded value of the first occurrence of a header field. */
export function getHeader(raw: Buffer, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const { lines } = split(raw);
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]/.test(lines[i]) || fieldName(lines[i]) !== wanted) continue;
    let value = lines[i].slice(lines[i].indexOf(":") + 1);
    while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1])) value += " " + lines[++i].trim();
    return value.trim();
  }
  return undefined;
}

/** Replace all occurrences of a header field with one new value (prepended when absent). */
export function setHeader(raw: Buffer, name: string, value: string): Buffer {
  const safeValue = value.replace(/[\r\n]+/g, " ");
  const without = removeHeaders(raw, [name]);
  const parts = split(without);
  return join({ ...parts, lines: [`${name}: ${safeValue}`, ...parts.lines] });
}

/** RFC 5322 date-time in UTC, e.g. "Wed, 14 Oct 2026 19:00:00 +0000". */
export function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, "+0000");
}
```

Create `src/mail/compose.ts`:

```ts
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";

export interface OutgoingAttachment {
  filename: string;
  /** base64-encoded file content */
  content: string;
  contentType: string;
}

export interface ComposeInput {
  from: string | Mail.Address;
  to: string | Array<string | Mail.Address>;
  cc?: string | Array<string | Mail.Address>;
  bcc?: string | Array<string | Mail.Address>;
  replyTo?: string | Mail.Address;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string | string[];
  attachments?: OutgoingAttachment[];
  date?: Date;
}

export interface ComposedMessage {
  /** Complete message including the Bcc header — what Drafts and Sent must contain. */
  raw: Buffer;
  messageId: string;
  /** SMTP envelope; `to` already contains Cc and Bcc recipients. */
  envelope: { from: string; to: string[] };
}

/**
 * Build an RFC 5322 message with nodemailer's MailComposer. It takes care of RFC 2047 headers,
 * RFC 2231 attachment filenames (e.g. "Angebot_Größe.pdf"), header-injection-safe values,
 * quoted-printable for long lines and a Message-ID on the sender's domain.
 */
export async function composeMessage(input: ComposeInput): Promise<ComposedMessage> {
  const node = new MailComposer({
    from: input.from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    replyTo: input.replyTo,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    date: input.date ?? new Date(),
    attachments: input.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      encoding: "base64",
      contentType: a.contentType,
    })),
  }).compile();
  node.keepBcc = true;
  const messageId = node.messageId();
  const envelope = node.getEnvelope();
  const raw = await node.build();
  return { raw, messageId, envelope: { from: envelope.from || "", to: envelope.to } };
}
```

- [ ] **Step 4: Rewrite `create_draft`**

Replace `src/tools/create-draft.ts` with:

```ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { requireSpecialFolder } from "../imap/folders.js";
import { strictAppend } from "../imap/strict.js";
import { composeMessage, type OutgoingAttachment } from "../mail/compose.js";
import { errorResult, jsonResult } from "./shared/result.js";

export type DraftAttachment = OutgoingAttachment;

export const attachmentSchema = z
  .array(
    z.object({
      filename: z.string().describe("Attachment filename"),
      content: z.string().describe("Base64-encoded file content"),
      contentType: z.string().describe("MIME type, e.g. application/pdf"),
    }),
  )
  .optional()
  .describe("File attachments (base64-encoded)");

const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024; // 25MB

export function validateAttachments(attachments: DraftAttachment[]): string | null {
  let totalBytes = 0;
  for (const att of attachments) {
    // Check filename for path traversal
    if (/[/\\]|\.\./.test(att.filename)) {
      return `Error: Invalid attachment filename "${att.filename}" — must not contain /, \\, or ..`;
    }
    // Check valid base64
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(att.content.replace(/\s/g, ""))) {
      return `Error: Attachment "${att.filename}" contains invalid base64 content`;
    }
    // Accumulate size (base64 is ~4/3 of original)
    totalBytes += Math.ceil(att.content.replace(/\s/g, "").length * 3 / 4);
  }
  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    const mb = (totalBytes / (1024 * 1024)).toFixed(1);
    return `Error: Total attachment size ${mb}MB exceeds 25MB limit`;
  }
  return null;
}

export function register(server: McpServer, getClient: () => Promise<ImapFlow>, fromAddress: string) {
  server.tool(
    "create_draft",
    "Create a draft email and save it to the Drafts folder for review before sending. Returns the draft's uid for send_draft.",
    {
      to: z.string().describe("Recipient email address(es), comma-separated"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
      cc: z.string().optional().describe("CC recipients, comma-separated"),
      bcc: z.string().optional().describe("BCC recipients, comma-separated"),
      html: z.string().optional().describe("HTML body (optional, plain text is always included)"),
      attachments: attachmentSchema,
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ to, subject, body, cc, bcc, html, attachments }) => {
      try {
        if (attachments) {
          const validationError = validateAttachments(attachments);
          if (validationError) return errorResult("Error creating draft", validationError);
        }

        const client = await getClient();
        const draftsFolder = await requireSpecialFolder(client, "\\Drafts");
        const message = await composeMessage({ from: fromAddress, to, cc, bcc, subject, text: body, html, attachments });
        const { uid } = await strictAppend(client, draftsFolder, message.raw, ["\\Draft", "\\Seen"]);

        return jsonResult({ success: true, folder: draftsFolder, uid, messageId: message.messageId, to, subject });
      } catch (error) {
        return errorResult("Error creating draft", error);
      }
    }
  );
}
```

- [ ] **Step 5: Bridge the two remaining importers**

`reply-draft.ts` and `send-draft.ts` imported the removed helpers. Keep the build green until Tasks 7 and 8 rewrite them.

In `src/tools/reply-draft.ts` replace

```ts
import { buildRfc822Message, findDraftsFolder, validateAttachments } from "./create-draft.js";
```

with

```ts
import { validateAttachments } from "./create-draft.js";
import { requireSpecialFolder } from "../imap/folders.js";
import { strictAppend } from "../imap/strict.js";
import { composeMessage } from "../mail/compose.js";
```

then replace

```ts
        const draftsFolder = await findDraftsFolder(client);

        const rawMessage = buildRfc822Message({
          from: fromAddress,
          to: replyTo,
          subject,
          body,
```

with

```ts
        const draftsFolder = await requireSpecialFolder(client, "\\Drafts");

        const message = await composeMessage({
          from: fromAddress,
          to: replyTo,
          subject,
          text: body,
```

and replace

```ts
        await client.append(draftsFolder, rawMessage, ["\\Draft", "\\Seen"]);
```

with

```ts
        await strictAppend(client, draftsFolder, message.raw, ["\\Draft", "\\Seen"]);
```

In `src/tools/send-draft.ts` replace

```ts
import { findDraftsFolder } from "./create-draft.js";
```

with

```ts
import { requireSpecialFolder } from "../imap/folders.js";
```

and replace

```ts
        const draftsFolder = await findDraftsFolder(client);
```

with

```ts
        const draftsFolder = await requireSpecialFolder(client, "\\Drafts");
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/mail/__tests__/headers.test.ts src/mail/__tests__/compose.test.ts src/tools/__tests__/create-draft.test.ts`
Expected: PASS — 15 tests.

Run: `npm run build && npm test && npm run typecheck`
Expected: all succeed (141 tests at this point).

- [ ] **Step 7: Commit**

```bash
git add src/mail src/tools/create-draft.ts src/tools/reply-draft.ts src/tools/send-draft.ts src/tools/__tests__/create-draft.test.ts
git commit -m "fix(drafts): compose messages with nodemailer MailComposer

Fixes broken non-ASCII attachment filenames (RFC 2231), the invalid
@draft Message-ID, unencoded long lines and hand-rolled header code.
create_draft now returns the draft uid and Message-ID and finds
localized Drafts folders.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Replies honour Reply-To and quote the original

**Files:**
- Create: `src/mail/reply.ts`
- Modify (replace whole file): `src/tools/reply-draft.ts`
- Test: `src/mail/__tests__/reply.test.ts`, `src/tools/__tests__/reply-draft.test.ts`

**Interfaces:**
- Consumes: `composeMessage` (Task 6), `attachmentSchema`, `validateAttachments` (Task 6), `resolveFolder`, `requireSpecialFolder` (Task 3), `downloadMessage`, `strictAppend` (Task 2).
- Produces:
  - `interface Mailbox { name: string; address: string }`, `interface OriginalMessage { from?; replyTo?; to?; cc?; subject?; date?; text?; html? }`, `type QuoteLanguage = "en" | "de"`
  - `flattenAddresses(field): Mailbox[]`, `replyRecipients(original, ownAddresses: string[], replyAll: boolean): { to: Mailbox[]; cc: Mailbox[] }`, `replySubject(subject): string`, `quotePlain(original, language, timeZone?): string`, `quoteHtml(original, language, timeZone?): string`, `formatAddressList(list: Mailbox[]): string`
  - `reply_draft` gains `quoteOriginal` (default `true`) and `language` (`"en"` | `"de"`, default `"en"`); returns `uid`, `messageId`, formatted `to`/`cc`.

- [ ] **Step 1: Write the failing tests**

Create `src/mail/__tests__/reply.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { simpleParser } from "mailparser";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { quotePlain, replyRecipients, replySubject } from "../reply.js";

async function parse(opts: Parameters<typeof buildRaw>[0]) {
  return simpleParser(await buildRaw(opts));
}

describe("replyRecipients", () => {
  it("uses Reply-To instead of a noreply From", async () => {
    const original = await parse({
      from: "Kontaktformular <noreply@shop.example>",
      replyTo: '"Müller, Hans" <hans.mueller@example.com>',
      to: "max@firma.example",
      subject: "Anfrage",
      text: "Hallo",
    });
    const { to, cc } = replyRecipients(original, ["max@firma.example"], false);
    expect(to).toEqual([{ name: "Müller, Hans", address: "hans.mueller@example.com" }]);
    expect(cc).toEqual([]);
  });

  it("reply-all removes own addresses case-insensitively and de-duplicates", async () => {
    const original = await parse({
      from: "anna@example.com",
      to: "MAX@firma.example, bob@example.com",
      cc: "anna@example.com, Carl <carl@example.com>",
      subject: "x",
      text: "y",
    });
    const { to, cc } = replyRecipients(original, ["max@firma.example"], true);
    expect(to.map((m) => m.address)).toEqual(["anna@example.com"]);
    expect(cc.map((m) => m.address)).toEqual(["bob@example.com", "carl@example.com"]);
  });

  it("replying to our own sent message goes to its recipients", async () => {
    const original = await parse({ from: "max@firma.example", to: "kunde@example.com", subject: "x", text: "y" });
    expect(replyRecipients(original, ["max@firma.example"], false).to.map((m) => m.address)).toEqual(["kunde@example.com"]);
  });
});

describe("replySubject", () => {
  it.each([
    ["Angebot", "Re: Angebot"],
    ["RE: Angebot", "RE: Angebot"],
    ["AW: Angebot", "AW: Angebot"],
    ["Re[2]: Angebot", "Re[2]: Angebot"],
    ["WG: Angebot", "Re: WG: Angebot"],
    ["", "Re: "],
  ])("%s → %s", (input, expected) => {
    expect(replySubject(input)).toBe(expected);
  });
});

describe("quotePlain", () => {
  it("quotes the original with a German attribution line", async () => {
    const original = await parse({
      from: "Anna Muster <anna@example.com>",
      to: "max@firma.example",
      subject: "x",
      text: "Zeile 1\n> alt",
      date: new Date("2026-01-15T10:00:00Z"),
    });
    const quote = quotePlain(original, "de", "UTC");
    const [first, ...rest] = quote.split("\n");
    expect(first).toMatch(/^Am .*2026.* schrieb Anna Muster <anna@example\.com>:$/);
    expect(rest).toEqual(["> Zeile 1", ">> alt"]);
  });

  it("falls back to the HTML body converted to text", async () => {
    const original = await parse({ from: "a@example.com", to: "b@example.com", subject: "x", html: "<p>Hallo <b>Welt</b></p>" });
    expect(quotePlain(original, "en", "UTC")).toContain("> Hallo Welt");
  });
});
```

Create `src/tools/__tests__/reply-draft.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { simpleParser } from "mailparser";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { connectHarness, type Harness } from "../../__tests__/helpers/mcp-harness.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import * as replyDraft from "../reply-draft.js";

const ME = "max@firma.example";

describe("reply_draft", () => {
  let imap: FakeImap;
  let h: Harness;

  beforeEach(async () => {
    imap = new FakeImap();
    imap.addFolder("Drafts", { specialUse: "\\Drafts" });
    h = await connectHarness((server) => replyDraft.register(server, async () => imap.asClient(), ME));
  });

  afterEach(async () => {
    await h.close();
  });

  it("answers the Reply-To address, threads and quotes", async () => {
    imap.addMessage(
      "INBOX",
      await buildRaw({
        from: "Webformular <noreply@shop.example>",
        replyTo: "Hans Müller <hans@example.com>",
        to: ME,
        subject: "Anfrage Lieferzeit",
        text: "Wann kommt die Ware?",
        messageId: "<orig-1@shop.example>",
      }),
    );

    const res = await h.call("reply_draft", { uid: 1, body: "Nächste Woche.", language: "de" });
    expect(res.isError).toBe(false);
    expect(res.json).toMatchObject({ to: "Hans Müller <hans@example.com>", subject: "Re: Anfrage Lieferzeit" });

    const draft = await simpleParser(imap.message("Drafts", res.json.uid)!.raw);
    expect(draft.inReplyTo).toBe("<orig-1@shop.example>");
    expect(draft.references).toBe("<orig-1@shop.example>");
    expect(draft.text).toContain("Nächste Woche.");
    expect(draft.text).toContain("> Wann kommt die Ware?");
  });

  it("can skip the quote", async () => {
    imap.addMessage("INBOX", await buildRaw({ from: "a@example.com", to: ME, subject: "x", text: "original" }));
    const res = await h.call("reply_draft", { uid: 1, body: "kurz", quoteOriginal: false });
    const draft = await simpleParser(imap.message("Drafts", res.json.uid)!.raw);
    expect(draft.text?.trim()).toBe("kurz");
  });

  it("returns a clear error for an unknown UID", async () => {
    const res = await h.call("reply_draft", { uid: 99, body: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/No message with UID 99/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/mail/__tests__/reply.test.ts src/tools/__tests__/reply-draft.test.ts`
Expected: FAIL — `"../reply.js"` cannot be resolved; the 3 `reply_draft` tests fail against the bridged tool (reply goes to `noreply@shop.example`, no quote, unknown UID gives a parser error instead of "No message with UID 99").

- [ ] **Step 3: Implement the reply logic**

Create `src/mail/reply.ts`:

```ts
import type { AddressObject, EmailAddress } from "mailparser";
import { convert } from "html-to-text";

export interface Mailbox {
  name: string;
  address: string;
}

export interface OriginalMessage {
  from?: AddressObject;
  replyTo?: AddressObject;
  to?: AddressObject | AddressObject[];
  cc?: AddressObject | AddressObject[];
  subject?: string;
  date?: Date;
  text?: string;
  html?: string | false;
}

export type QuoteLanguage = "en" | "de";

/** Upper bound for quoted text so a reply to a huge newsletter stays a sane size. */
const MAX_QUOTED_CHARS = 20_000;

function walk(entry: EmailAddress): Mailbox[] {
  if (entry.group) return entry.group.flatMap(walk);
  return entry.address ? [{ name: entry.name ?? "", address: entry.address }] : [];
}

export function flattenAddresses(field: AddressObject | AddressObject[] | undefined): Mailbox[] {
  if (!field) return [];
  return (Array.isArray(field) ? field : [field]).flatMap((f) => f.value.flatMap(walk));
}

/**
 * Who a reply goes to. Reply-To wins over From (contact forms, mailing lists); reply-all adds the
 * original To/Cc. Own addresses and duplicates are removed case-insensitively. Replying to a message
 * we sent ourselves goes to its original recipients.
 */
export function replyRecipients(
  original: OriginalMessage,
  ownAddresses: string[],
  replyAll: boolean,
): { to: Mailbox[]; cc: Mailbox[] } {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase()));
  const seen = new Set<string>();
  const take = (list: Mailbox[]) =>
    list.filter((m) => {
      const key = m.address.toLowerCase();
      if (own.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  const replyTo = flattenAddresses(original.replyTo);
  let to = take(replyTo.length > 0 ? replyTo : flattenAddresses(original.from));
  if (to.length === 0) to = take(flattenAddresses(original.to));
  const cc = replyAll ? take([...flattenAddresses(original.to), ...flattenAddresses(original.cc)]) : [];
  return { to, cc };
}

/** "Re: " unless the subject already carries a reply prefix (Re, AW, Antw, SV, VS). */
export function replySubject(subject: string | undefined): string {
  const s = (subject ?? "").trim();
  return /^(re|aw|antw|sv|vs)(\[\d+\])?\s*:/i.test(s) ? s : `Re: ${s}`;
}

function formatMailbox(m: Mailbox | undefined): string {
  if (!m) return "unknown sender";
  return m.name ? `${m.name} <${m.address}>` : m.address;
}

function formatDate(date: Date, language: QuoteLanguage, timeZone?: string): string {
  return date.toLocaleString(language === "de" ? "de-AT" : "en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
}

function attribution(original: OriginalMessage, language: QuoteLanguage, timeZone?: string): string {
  const who = formatMailbox(flattenAddresses(original.from)[0]);
  if (!original.date) return language === "de" ? `${who} schrieb:` : `${who} wrote:`;
  const when = formatDate(original.date, language, timeZone);
  return language === "de" ? `Am ${when} schrieb ${who}:` : `On ${when}, ${who} wrote:`;
}

function originalText(original: OriginalMessage): string {
  if (original.text) return original.text;
  if (original.html) return convert(original.html, { wordwrap: 100, selectors: [{ selector: "img", format: "skip" }] });
  return "";
}

/** Plain-text quote block: attribution line followed by "> "-prefixed original text. */
export function quotePlain(original: OriginalMessage, language: QuoteLanguage, timeZone?: string): string {
  let text = originalText(original).replace(/\r\n/g, "\n").trimEnd();
  if (text.length > MAX_QUOTED_CHARS) text = text.slice(0, MAX_QUOTED_CHARS) + "\n[…]";
  const quoted = text
    .split("\n")
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`))
    .join("\n");
  return `${attribution(original, language, timeZone)}\n${quoted}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** HTML quote block for replies that carry an HTML body. */
export function quoteHtml(original: OriginalMessage, language: QuoteLanguage, timeZone?: string): string {
  const inner = original.html
    ? original.html
    : `<pre style="white-space:pre-wrap">${escapeHtml(originalText(original).slice(0, MAX_QUOTED_CHARS))}</pre>`;
  return (
    `<div>${escapeHtml(attribution(original, language, timeZone))}</div>` +
    `<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${inner}</blockquote>`
  );
}

export function formatAddressList(list: Mailbox[]): string {
  return list.map((m) => formatMailbox(m)).join(", ");
}
```

- [ ] **Step 4: Rewrite `reply_draft`**

Replace `src/tools/reply-draft.ts` with:

```ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { requireSpecialFolder, resolveFolder } from "../imap/folders.js";
import { downloadMessage, strictAppend } from "../imap/strict.js";
import { composeMessage } from "../mail/compose.js";
import { formatAddressList, quoteHtml, quotePlain, replyRecipients, replySubject } from "../mail/reply.js";
import { attachmentSchema, validateAttachments } from "./create-draft.js";
import { errorResult, jsonResult } from "./shared/result.js";

export function register(server: McpServer, getClient: () => Promise<ImapFlow>, fromAddress: string) {
  server.tool(
    "reply_draft",
    "Create a reply draft to an existing email with threading headers (In-Reply-To, References). " +
      "Honors the Reply-To header and quotes the original message below your text. Saves to Drafts.",
    {
      folder: z.string().default("INBOX").describe("Folder containing the original email"),
      uid: z.number().int().positive().describe("UID of the email to reply to"),
      body: z.string().describe("Reply body (plain text), written above the quoted original"),
      replyAll: z.boolean().default(false).describe("Also reply to everyone in To/Cc of the original"),
      quoteOriginal: z.boolean().default(true).describe("Quote the original message below the reply"),
      language: z.enum(["en", "de"]).default("en").describe('Language of the quote line ("On … wrote:" / "Am … schrieb …:")'),
      html: z.string().optional().describe("HTML reply body (optional)"),
      attachments: attachmentSchema,
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ folder, uid, body, replyAll, quoteOriginal, language, html, attachments }) => {
      try {
        if (attachments) {
          const validationError = validateAttachments(attachments);
          if (validationError) return errorResult("Error creating reply draft", validationError);
        }

        const client = await getClient();
        const path = await resolveFolder(client, folder);
        const lock = await client.getMailboxLock(path);
        let original;
        try {
          original = await simpleParser(await downloadMessage(client, uid, path));
        } finally {
          try { lock.release(); } catch { /* connection may already be dead */ }
        }

        const { to, cc } = replyRecipients(original, [fromAddress], replyAll);
        if (to.length === 0) {
          return errorResult("Error creating reply draft", "The original email has no sender or Reply-To address to reply to.");
        }

        const originalReferences = original.references
          ? (Array.isArray(original.references) ? original.references : [original.references])
          : [];
        const references = original.messageId ? [...originalReferences, original.messageId] : originalReferences;
        const subject = replySubject(original.subject);
        const text = quoteOriginal ? `${body}\n\n${quotePlain(original, language)}` : body;
        const htmlBody = html && quoteOriginal ? `${html}<br>${quoteHtml(original, language)}` : html;

        const draftsFolder = await requireSpecialFolder(client, "\\Drafts");
        const message = await composeMessage({
          from: fromAddress,
          to,
          cc: cc.length > 0 ? cc : undefined,
          subject,
          text,
          html: htmlBody,
          inReplyTo: original.messageId,
          references: references.length > 0 ? references : undefined,
          attachments,
        });
        const { uid: draftUid } = await strictAppend(client, draftsFolder, message.raw, ["\\Draft", "\\Seen"]);

        return jsonResult({
          success: true,
          folder: draftsFolder,
          uid: draftUid,
          messageId: message.messageId,
          to: formatAddressList(to),
          ...(cc.length > 0 ? { cc: formatAddressList(cc) } : {}),
          subject,
          replyAll,
          inReplyTo: original.messageId,
        });
      } catch (error) {
        return errorResult("Error creating reply draft", error);
      }
    }
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/mail/__tests__/reply.test.ts src/tools/__tests__/reply-draft.test.ts`
Expected: PASS — 14 tests.

Run: `npm run build && npm test`
Expected: all succeed.

- [ ] **Step 6: Commit**

```bash
git add src/mail/reply.ts src/mail/__tests__/reply.test.ts src/tools/reply-draft.ts src/tools/__tests__/reply-draft.test.ts
git commit -m "fix(reply): honour Reply-To, quote the original, clean reply-all

Replies to contact forms and mailing lists now reach the person in
Reply-To instead of noreply. Reply-all removes own addresses
case-insensitively and de-duplicates; AW:/Antw:/SV: prefixes are kept;
the original is quoted (en/de attribution line).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Sending stores a Sent copy and sends exactly the reviewed draft

**Files:**
- Create: `src/mail/send.ts`
- Modify (replace whole file): `src/tools/send-email.ts`, `src/tools/send-draft.ts`
- Modify: `src/credentials.ts`, `src/index.ts`
- Test: `src/mail/__tests__/send.test.ts`, `src/tools/__tests__/send-tools.test.ts`

**Interfaces:**
- Consumes: `composeMessage`, `removeHeaders`, `getHeader`, `setHeader`, `rfc5322Date` (Task 6); `flattenAddresses`, `formatAddressList` (Task 7); `findSpecialFolder`, `requireSpecialFolder` (Task 3); `strictSearch`, `strictAppend`, `downloadMessage`, `safeExpunge` (Task 2); `createCaptureTransport` (Task 1).
- Produces:
  - `type SentCopyMode = "auto" | "always" | "never"`
  - `interface SendDeps { transport: Transporter; getClient: () => Promise<ImapFlow>; imapHost: string; sentCopy: SentCopyMode; sentProbeCache: Map<string, boolean>; sentProbe?: { attempts: number; delayMs: number } }`
  - `interface OutgoingMessage { archiveRaw: Buffer; envelope: { from: string; to: string[] }; messageId: string }`
  - `interface SentCopyResult { saved: boolean; folder?: string; uid?: number; reason: string }`, `interface DeliveryResult { messageId: string; accepted: string[]; rejected: string[]; sentCopy: SentCopyResult }`
  - `providerFilesSentMail(client, imapHost): boolean`, `deliver(deps: SendDeps, msg: OutgoingMessage): Promise<DeliveryResult>`
  - `sendEmail.register(server, deps: SendDeps, fromAddress)`, `sendDraft.register(server, getClient, deps: SendDeps, fromAddress)`
  - `Config.sentCopy?: SentCopyMode` and `Credentials.sentCopy` (validated, default `"auto"`).

- [ ] **Step 1: Write the failing tests**

Create `src/mail/__tests__/send.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { createCaptureTransport, type CaptureTransport } from "../../__tests__/helpers/capture-transport.js";
import { header } from "../../__tests__/helpers/messages.js";
import { composeMessage } from "../compose.js";
import { deliver, type SendDeps } from "../send.js";

describe("deliver", () => {
  let imap: FakeImap;
  let capture: CaptureTransport;
  let deps: SendDeps;

  beforeEach(() => {
    imap = new FakeImap();
    imap.addFolder("Sent", { specialUse: "\\Sent" });
    capture = createCaptureTransport();
    deps = {
      transport: capture.transport,
      getClient: async () => imap.asClient(),
      imapHost: "mail.example.com",
      sentCopy: "auto",
      sentProbeCache: new Map(),
      sentProbe: { attempts: 1, delayMs: 0 },
    };
  });

  async function message() {
    return composeMessage({ from: "max@example.com", to: "kunde@example.com", bcc: "chef@example.com", subject: "Hi", text: "Hallo" });
  }

  it("transmits without Bcc header but to all envelope recipients, and archives with Bcc", async () => {
    const m = await message();
    const result = await deliver(deps, { archiveRaw: m.raw, envelope: m.envelope, messageId: m.messageId });

    expect(capture.sent).toHaveLength(1);
    expect(header(capture.sent[0].raw, "bcc")).toBeUndefined();
    expect(capture.sent[0].envelope.to).toEqual(["kunde@example.com", "chef@example.com"]);

    expect(result.sentCopy).toMatchObject({ saved: true, folder: "Sent" });
    const stored = imap.message("Sent", result.sentCopy.uid!)!;
    expect(header(stored.raw, "bcc")).toBe("chef@example.com");
    expect(stored.flags.has("\\Seen")).toBe(true);
  });

  it("does not append for Gmail (server files sent mail itself)", async () => {
    imap.capabilities.set("X-GM-EXT-1", true);
    const m = await message();
    const result = await deliver(deps, { archiveRaw: m.raw, envelope: m.envelope, messageId: m.messageId });
    expect(result.sentCopy.saved).toBe(false);
    expect(imap.uidsIn("Sent")).toEqual([]);
  });

  it("does not append for Microsoft 365", async () => {
    const m = await message();
    const result = await deliver({ ...deps, imapHost: "outlook.office365.com" }, { archiveRaw: m.raw, envelope: m.envelope, messageId: m.messageId });
    expect(result.sentCopy.saved).toBe(false);
  });

  it("remembers when an unknown server files the copy itself", async () => {
    const m = await message();
    imap.addMessage("Sent", m.raw); // the server already filed it
    const first = await deliver(deps, { archiveRaw: m.raw, envelope: m.envelope, messageId: m.messageId });
    expect(first.sentCopy.saved).toBe(false);
    expect(deps.sentProbeCache.get("mail.example.com")).toBe(true);
    expect(imap.uidsIn("Sent")).toHaveLength(1);
  });

  it("reports a failed Sent copy without failing the send", async () => {
    imap.failOn("append", "throw");
    const m = await message();
    const result = await deliver({ ...deps, sentCopy: "always" }, { archiveRaw: m.raw, envelope: m.envelope, messageId: m.messageId });
    expect(capture.sent).toHaveLength(1);
    expect(result.sentCopy.saved).toBe(false);
    expect(result.sentCopy.reason).toMatch(/WAS sent/);
  });

  it("propagates SMTP failures and stores nothing", async () => {
    capture.failNext(new Error("550 relay denied"));
    const m = await message();
    await expect(deliver(deps, { archiveRaw: m.raw, envelope: m.envelope, messageId: m.messageId })).rejects.toThrow(/relay denied/);
    expect(imap.uidsIn("Sent")).toEqual([]);
  });
});
```

Create `src/tools/__tests__/send-tools.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { connectHarness, type Harness } from "../../__tests__/helpers/mcp-harness.js";
import { createCaptureTransport, type CaptureTransport } from "../../__tests__/helpers/capture-transport.js";
import { buildRaw, header } from "../../__tests__/helpers/messages.js";
import type { SendDeps } from "../../mail/send.js";
import * as sendEmail from "../send-email.js";
import * as sendDraft from "../send-draft.js";

const ME = "max@firma.example";

describe("send_email and send_draft", () => {
  let imap: FakeImap;
  let capture: CaptureTransport;
  let h: Harness;

  beforeEach(async () => {
    imap = new FakeImap();
    imap.addFolder("Drafts", { specialUse: "\\Drafts" });
    imap.addFolder("Sent", { specialUse: "\\Sent" });
    capture = createCaptureTransport();
    const getClient = async () => imap.asClient();
    const deps: SendDeps = {
      transport: capture.transport,
      getClient,
      imapHost: "mail.firma.example",
      sentCopy: "auto",
      sentProbeCache: new Map(),
      sentProbe: { attempts: 1, delayMs: 0 },
    };
    h = await connectHarness((server) => {
      sendEmail.register(server, deps, ME);
      sendDraft.register(server, getClient, deps, ME);
    });
  });

  afterEach(async () => {
    await h.close();
  });

  it("send_email files a copy in Sent and never transmits the Bcc header", async () => {
    const res = await h.call("send_email", { to: "kunde@example.com", bcc: "chef@example.com", subject: "Hallo", body: "Text" });
    expect(res.isError).toBe(false);
    expect(res.json.sentCopy).toMatchObject({ saved: true, folder: "Sent" });
    expect(header(capture.sent[0].raw, "bcc")).toBeUndefined();
    expect(capture.sent[0].envelope.to).toContain("chef@example.com");
    expect(header(imap.message("Sent", 1)!.raw, "bcc")).toBe("chef@example.com");
  });

  it("send_draft sends the stored draft as reviewed (minus Bcc and client headers) and deletes it", async () => {
    const draftRaw = await buildRaw({
      from: { name: "Maximilian Achleitner", address: ME },
      to: '"Müller, Hans" <hans@example.com>',
      bcc: "archiv@firma.example",
      subject: "Angebot",
      text: "Bitte prüfen.",
      headers: { "X-Mozilla-Draft-Info": "internal/draft; vcard=0" },
    });
    imap.addMessage("Drafts", draftRaw, { flags: ["\\Draft"] });

    const res = await h.call("send_draft", { uid: 1 });
    expect(res.isError).toBe(false);
    const sent = capture.sent[0].raw;
    expect(header(sent, "from")).toBe("Maximilian Achleitner <max@firma.example>");
    expect(header(sent, "bcc")).toBeUndefined();
    expect(header(sent, "x-mozilla-draft-info")).toBeUndefined();
    expect(capture.sent[0].envelope.to.sort()).toEqual(["archiv@firma.example", "hans@example.com"]);
    expect(header(sent, "message-id")).toBe(header(draftRaw, "message-id"));
    expect(res.json.draftDeleted).toBe(true);
    expect(imap.uidsIn("Drafts")).toEqual([]);
    expect(imap.uidsIn("Sent")).toHaveLength(1);
  });

  it("send_draft refuses a draft whose From is not this account", async () => {
    imap.addMessage("Drafts", await buildRaw({ from: "ceo@other.example", to: "x@example.com", subject: "s", text: "t" }));
    const res = await h.call("send_draft", { uid: 1 });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Refusing to send/);
    expect(capture.sent).toHaveLength(0);
  });

  it("send_draft keeps the draft when the server lacks UIDPLUS and other drafts are marked deleted", async () => {
    imap.capabilities.delete("UIDPLUS");
    imap.addMessage("Drafts", "Subject: old\r\n\r\n", { flags: ["\\Deleted"] });
    imap.addMessage("Drafts", await buildRaw({ from: ME, to: "x@example.com", subject: "s", text: "t" }));
    const res = await h.call("send_draft", { uid: 2 });
    expect(res.isError).toBe(false);
    expect(res.json.draftDeleted).toBe(false);
    expect(res.json.draftNote).toMatch(/was sent/);
    expect(imap.uidsIn("Drafts")).toEqual([1, 2]);
  });

  it("send tools are annotated as destructive and open-world so clients ask before sending", async () => {
    for (const name of ["send_email", "send_draft"]) {
      expect(await h.annotations(name)).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/mail/__tests__/send.test.ts src/tools/__tests__/send-tools.test.ts`
Expected: FAIL — both files cannot resolve the new module (`"../send.js"` / `"../../mail/send.js"`). Against the old tools the same assertions would fail too: no Sent copy, the draft is rebuilt (display name lost) and the From check is missing.

- [ ] **Step 3: Implement the delivery pipeline**

Create `src/mail/send.ts`:

```ts
import type { ImapFlow } from "imapflow";
import type { Transporter } from "nodemailer";
import { errorMessage } from "../errors.js";
import { findSpecialFolder } from "../imap/folders.js";
import { strictAppend, strictSearch } from "../imap/strict.js";
import { removeHeaders } from "./headers.js";

/**
 * auto   = skip for providers that file SMTP-sent mail themselves (Gmail, Microsoft 365), otherwise
 *          check the Sent folder once per server and append a copy when the server does not.
 * always = always append a copy.  never = never append.
 */
export type SentCopyMode = "auto" | "always" | "never";

export interface SendDeps {
  transport: Transporter;
  getClient: () => Promise<ImapFlow>;
  imapHost: string;
  sentCopy: SentCopyMode;
  /** Per IMAP host: does the server file sent mail itself? Filled by the first "auto" send. */
  sentProbeCache: Map<string, boolean>;
  /** How long to look for a server-filed copy before appending our own. */
  sentProbe?: { attempts: number; delayMs: number };
}

export interface OutgoingMessage {
  /** Exact bytes for the Sent folder, Bcc header included. */
  archiveRaw: Buffer;
  /** SMTP envelope; `to` contains every recipient including Bcc. */
  envelope: { from: string; to: string[] };
  messageId: string;
}

export interface SentCopyResult {
  saved: boolean;
  folder?: string;
  uid?: number;
  reason: string;
}

export interface DeliveryResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  sentCopy: SentCopyResult;
}

const MICROSOFT_IMAP_HOSTS = ["outlook.office365.com", "imap-mail.outlook.com", "outlook.office.com"];

/** Providers documented to store SMTP-submitted mail in Sent by themselves. */
export function providerFilesSentMail(client: ImapFlow, imapHost: string): boolean {
  if (client.capabilities.has("X-GM-EXT-1")) return true; // Gmail / Google Workspace
  return MICROSOFT_IMAP_HOSTS.includes(imapHost.toLowerCase());
}

function addresses(list: unknown[] | undefined): string[] {
  return (list ?? []).map((a) => (typeof a === "string" ? a : (a as { address: string }).address));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function sentFolderHasMessage(
  client: ImapFlow,
  folder: string,
  messageId: string,
  probe: { attempts: number; delayMs: number },
): Promise<boolean> {
  for (let attempt = 0; attempt < probe.attempts; attempt++) {
    if (attempt > 0) await sleep(probe.delayMs);
    const lock = await client.getMailboxLock(folder);
    try {
      if ((await strictSearch(client, { header: { "message-id": messageId } })).length > 0) return true;
    } finally {
      try { lock.release(); } catch { /* connection may already be dead */ }
    }
  }
  return false;
}

async function storeSentCopy(deps: SendDeps, msg: OutgoingMessage): Promise<SentCopyResult> {
  if (deps.sentCopy === "never") {
    return { saved: false, reason: "Saving a copy to the Sent folder is disabled in the configuration." };
  }
  const client = await deps.getClient();
  if (deps.sentCopy === "auto" && providerFilesSentMail(client, deps.imapHost)) {
    return { saved: false, reason: "The mail provider files sent mail into the Sent folder itself." };
  }
  const folder = await findSpecialFolder(client, "\\Sent");
  if (!folder) return { saved: false, reason: "No Sent folder was found, so no copy was stored." };

  if (deps.sentCopy === "auto") {
    let serverFiles = deps.sentProbeCache.get(deps.imapHost);
    if (serverFiles === undefined) {
      serverFiles = await sentFolderHasMessage(client, folder, msg.messageId, deps.sentProbe ?? { attempts: 2, delayMs: 1500 });
      deps.sentProbeCache.set(deps.imapHost, serverFiles);
    }
    if (serverFiles) {
      return { saved: false, folder, reason: "The mail server files sent mail into the Sent folder itself." };
    }
  }

  const { uid } = await strictAppend(client, folder, msg.archiveRaw, ["\\Seen"]);
  return { saved: true, folder, uid, reason: "A copy was stored in the Sent folder." };
}

/**
 * Transmit exactly the archived bytes minus the Bcc header, then file the copy in Sent.
 * A failure to store the copy never turns a successful send into an error (that would invite a resend).
 */
export async function deliver(deps: SendDeps, msg: OutgoingMessage): Promise<DeliveryResult> {
  const info = await deps.transport.sendMail({
    envelope: msg.envelope,
    raw: removeHeaders(msg.archiveRaw, ["bcc"]),
  });
  let sentCopy: SentCopyResult;
  try {
    sentCopy = await storeSentCopy(deps, msg);
  } catch (err) {
    sentCopy = { saved: false, reason: `The email WAS sent, but storing a copy in the Sent folder failed: ${errorMessage(err)}` };
  }
  return {
    messageId: msg.messageId,
    accepted: addresses(info.accepted),
    rejected: addresses(info.rejected),
    sentCopy,
  };
}
```

- [ ] **Step 4: Rewrite `send_email`**

Replace `src/tools/send-email.ts` with:

```ts
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as log from "../logging/logger.js";
import { composeMessage } from "../mail/compose.js";
import { deliver, type SendDeps } from "../mail/send.js";
import { errorResult, jsonResult } from "./shared/result.js";

export function register(server: McpServer, deps: SendDeps, fromAddress: string) {
  server.tool(
    "send_email",
    "Send an email via SMTP. A copy is filed in the Sent folder (unless the provider does that itself).",
    {
      to: z.string().describe("Recipient email address(es), comma-separated"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body (plain text)"),
      cc: z.string().optional().describe("CC recipients, comma-separated"),
      bcc: z.string().optional().describe("BCC recipients, comma-separated"),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async ({ to, subject, body, cc, bcc }) => {
      try {
        const message = await composeMessage({ from: fromAddress, to, cc, bcc, subject, text: body });
        const result = await deliver(deps, { archiveRaw: message.raw, envelope: message.envelope, messageId: message.messageId });
        log.info("email.sent", { to, subject, messageId: result.messageId });
        return jsonResult({ success: true, to, subject, ...result });
      } catch (error) {
        return errorResult("Error sending email", error);
      }
    }
  );
}
```

- [ ] **Step 5: Rewrite `send_draft`**

Replace `src/tools/send-draft.ts` with:

```ts
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { errorMessage } from "../errors.js";
import * as log from "../logging/logger.js";
import { requireSpecialFolder } from "../imap/folders.js";
import { downloadMessage, safeExpunge } from "../imap/strict.js";
import { getHeader, removeHeaders, rfc5322Date, setHeader } from "../mail/headers.js";
import { flattenAddresses, formatAddressList } from "../mail/reply.js";
import { deliver, type SendDeps } from "../mail/send.js";
import { errorResult, jsonResult } from "./shared/result.js";

/** Client bookkeeping headers that must not leave the mailbox. Bcc is stripped later by deliver(). */
const DRAFT_ONLY_HEADERS = [
  "x-mozilla-draft-info",
  "x-uniform-type-identifier",
  "x-universally-unique-identifier",
  "x-apple-mail-remote-attachments",
  "x-apple-base-url",
];

export function register(
  server: McpServer,
  getClient: () => Promise<ImapFlow>,
  deps: SendDeps,
  fromAddress: string,
) {
  server.tool(
    "send_draft",
    "Send an existing draft exactly as it is stored in the Drafts folder (what you review is what is sent). " +
      "Supports the create_draft → review → send_draft workflow. A copy is filed in Sent.",
    {
      uid: z.number().int().positive().describe("UID of the draft in the Drafts folder"),
      deleteAfterSend: z.boolean().default(true).describe("Delete the draft after sending (default: true)"),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async ({ uid, deleteAfterSend }) => {
      try {
        const client = await getClient();
        const draftsFolder = await requireSpecialFolder(client, "\\Drafts");

        const lock = await client.getMailboxLock(draftsFolder);
        let draftRaw: Buffer;
        try {
          draftRaw = await downloadMessage(client, uid, draftsFolder);
        } finally {
          try { lock.release(); } catch { /* connection may already be dead */ }
        }

        const parsed = await simpleParser(draftRaw);
        const sender = flattenAddresses(parsed.from)[0]?.address ?? "";
        if (sender.toLowerCase() !== fromAddress.toLowerCase()) {
          return errorResult(
            "Error sending draft",
            `The draft's From address "${sender || "(none)"}" is not this account's address "${fromAddress}". Refusing to send.`,
          );
        }
        const recipients = [
          ...new Set(
            [...flattenAddresses(parsed.to), ...flattenAddresses(parsed.cc), ...flattenAddresses(parsed.bcc)].map((m) => m.address),
          ),
        ];
        if (recipients.length === 0) {
          return errorResult("Error sending draft", "Draft has no recipients — cannot send");
        }

        let archiveRaw = setHeader(removeHeaders(draftRaw, DRAFT_ONLY_HEADERS), "Date", rfc5322Date(new Date()));
        let messageId = getHeader(archiveRaw, "message-id");
        if (!messageId) {
          messageId = `<${randomUUID()}@${fromAddress.split("@")[1]}>`;
          archiveRaw = setHeader(archiveRaw, "Message-ID", messageId);
        }

        const result = await deliver(deps, { archiveRaw, envelope: { from: fromAddress, to: recipients }, messageId });
        const to = formatAddressList(flattenAddresses(parsed.to));
        log.info("email.sent_draft", { to, subject: parsed.subject, messageId });

        let draftDeleted = false;
        let draftNote: string | undefined;
        if (deleteAfterSend) {
          try {
            const deleteLock = await client.getMailboxLock(draftsFolder);
            try {
              await safeExpunge(client, [uid]);
              draftDeleted = true;
            } finally {
              try { deleteLock.release(); } catch { /* ignore */ }
            }
          } catch (err) {
            // Non-fatal: the email was sent
            draftNote = `The email was sent, but the draft was not deleted: ${errorMessage(err)}`;
          }
        }

        return jsonResult({
          success: true,
          to,
          subject: parsed.subject,
          sentAt: new Date().toISOString(),
          ...result,
          draftDeleted,
          ...(draftNote ? { draftNote } : {}),
        });
      } catch (error) {
        return errorResult("Error sending draft", error);
      }
    }
  );
}
```

- [ ] **Step 6: Add `sentCopy` to the configuration**

In `src/credentials.ts`:

1. Below `import keytar from "keytar";` add:

```ts
import type { SentCopyMode } from "./mail/send.js";
```

2. In `interface Config`, after `permissions?: Permissions;` add:

```ts
  /** Whether sent mail is also appended to the Sent folder (default "auto"). */
  sentCopy?: SentCopyMode;
```

3. Directly above the line `  // Resolve password: env var > keychain > legacy file > error` insert:

```ts
  const sentCopy: SentCopyMode = parsed.sentCopy ?? "auto";
  if (!["auto", "always", "never"].includes(sentCopy)) {
    throw new Error(`Invalid config: "sentCopy" must be "auto", "always" or "never".`);
  }

```

4. In the `creds` object returned by `loadCredentials`, after the `permissions: …` line add `    sentCopy,`.
5. In `saveCredentials`, after `    permissions: creds.permissions,` add `    sentCopy: creds.sentCopy,`.

- [ ] **Step 7: Wire `SendDeps` in the entry point**

In `src/index.ts`, below `import { createSmtpTransport } from "./smtp-client.js";` add:

```ts
import type { SendDeps } from "./mail/send.js";
```

and replace

```ts
    const smtpTransport = createSmtpTransport(creds);
    sendEmail.register(server, smtpTransport, creds.user);
    sendDraft.register(server, getClient, smtpTransport, creds.user);
```

with

```ts
    const sendDeps: SendDeps = {
      transport: createSmtpTransport(creds),
      getClient,
      imapHost: creds.imapHost,
      sentCopy: creds.sentCopy ?? "auto",
      sentProbeCache: new Map(),
    };
    sendEmail.register(server, sendDeps, creds.user);
    sendDraft.register(server, getClient, sendDeps, creds.user);
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/mail/__tests__/send.test.ts src/tools/__tests__/send-tools.test.ts`
Expected: PASS — 11 tests.

Run: `npm run build && npm test && npm run typecheck`
Expected: all succeed.

- [ ] **Step 9: Commit**

```bash
git add src/mail/send.ts src/mail/__tests__/send.test.ts src/tools/send-email.ts src/tools/send-draft.ts src/tools/__tests__/send-tools.test.ts src/credentials.ts src/index.ts
git commit -m "fix(send): store Sent copies and send drafts exactly as reviewed

send_email and send_draft transmit the composed/stored bytes minus Bcc
and file a copy in Sent (skipped for Gmail and Microsoft 365, probed
once for other servers; sentCopy config override). send_draft keeps
display names, Reply-To and attachments, refuses drafts whose From is
not the account and deletes the draft without unsafe EXPUNGE. Send
tools are annotated destructive/open-world so clients ask first.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Mandatory STARTTLS and TLS 1.2 floor

**Files:**
- Create: `src/connection-security.ts`
- Modify: `src/imap-client.ts`, `src/smtp-client.ts`
- Test: `src/__tests__/connection-security.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `isLoopback(host): boolean`, `imapSecurityOptions(host, port): { secure: boolean; doSTARTTLS?: true; tls: ConnectionOptions }`, `smtpSecurityOptions(host, port): { secure: boolean; requireTLS: boolean; tls: ConnectionOptions }`.

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/connection-security.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { imapSecurityOptions, smtpSecurityOptions } from "../connection-security.js";

describe("connection security", () => {
  it("uses implicit TLS on 993 without STARTTLS", () => {
    expect(imapSecurityOptions("imap.example.com", 993)).toEqual({ secure: true, tls: { minVersion: "TLSv1.2" } });
  });

  it("requires STARTTLS on 143 so it cannot be downgraded to plaintext", () => {
    expect(imapSecurityOptions("mail.example.com", 143)).toMatchObject({ secure: false, doSTARTTLS: true });
  });

  it("allows opportunistic STARTTLS for loopback bridges", () => {
    expect(imapSecurityOptions("127.0.0.1", 1143).doSTARTTLS).toBeUndefined();
  });

  it("requires TLS for SMTP submission on 587", () => {
    expect(smtpSecurityOptions("smtp.office365.com", 587)).toMatchObject({ secure: false, requireTLS: true });
    expect(smtpSecurityOptions("smtp.example.com", 465)).toMatchObject({ secure: true, requireTLS: false });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/connection-security.test.ts`
Expected: FAIL — `Failed to resolve import "../connection-security.js"`.

- [ ] **Step 3: Implement the TLS policy**

Create `src/connection-security.ts` (imapflow's `doSTARTTLS: true` fails the connection when STARTTLS is unavailable; it must not be combined with `secure: true`):

```ts
import type { ConnectionOptions } from "node:tls";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Local bridges (Proton Mail Bridge, DavMail) listen on loopback and may not offer STARTTLS. */
export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

const TLS_FLOOR: ConnectionOptions = { minVersion: "TLSv1.2" };

/**
 * Implicit TLS on 993; on every other port STARTTLS is mandatory so a network attacker cannot
 * strip it and read the password. Loopback hosts keep imapflow's opportunistic default.
 */
export function imapSecurityOptions(host: string, port: number): { secure: boolean; doSTARTTLS?: true; tls: ConnectionOptions } {
  const secure = port === 993;
  return {
    secure,
    ...(secure || isLoopback(host) ? {} : { doSTARTTLS: true as const }),
    tls: { ...TLS_FLOOR },
  };
}

/** Implicit TLS on 465; STARTTLS required everywhere else except loopback. */
export function smtpSecurityOptions(host: string, port: number): { secure: boolean; requireTLS: boolean; tls: ConnectionOptions } {
  const secure = port === 465;
  return { secure, requireTLS: !secure && !isLoopback(host), tls: { ...TLS_FLOOR } };
}
```

- [ ] **Step 4: Use it for IMAP and SMTP**

In `src/imap-client.ts`, below `import { ImapConnectionError } from "./errors.js";` add:

```ts
import { imapSecurityOptions } from "./connection-security.js";
```

and replace

```ts
          port: this.creds.imapPort,
          secure: this.creds.imapPort === 993,
```

with

```ts
          port: this.creds.imapPort,
          ...imapSecurityOptions(this.creds.imapHost, this.creds.imapPort),
```

In `src/smtp-client.ts`, below `import type { Credentials } from "./credentials.js";` add:

```ts
import { smtpSecurityOptions } from "./connection-security.js";
```

and replace

```ts
    port: creds.smtpPort,
    secure: creds.smtpPort === 465,
```

with

```ts
    port: creds.smtpPort,
    ...smtpSecurityOptions(creds.smtpHost, creds.smtpPort),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/__tests__/connection-security.test.ts`
Expected: PASS — 4 tests.

Run: `npm run build && npm test`
Expected: all succeed.

- [ ] **Step 6: Manual check against the owner's Dovecot server (port 143 + STARTTLS)**

Run: `npm run build && npm start` with the existing config, call `health_check` from Claude Desktop or the MCP Inspector (`npx @modelcontextprotocol/inspector node dist/index.js`).
Expected: `imap.connected: true`. If the server were reachable only without STARTTLS, the log now shows `Server does not support STARTTLS` instead of connecting in plaintext.

- [ ] **Step 7: Commit**

```bash
git add src/connection-security.ts src/__tests__/connection-security.test.ts src/imap-client.ts src/smtp-client.ts
git commit -m "fix(security): require STARTTLS outside implicit-TLS ports

Connections on ports other than 993/465 silently stayed plaintext when
STARTTLS was missing or stripped, exposing the password. STARTTLS is
now mandatory (loopback bridges excepted) and TLS 1.2 is the floor.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Integration tests, CI and documentation

**Files:**
- Create: `test/docker-compose.greenmail.yml`, `src/__tests__/integration/greenmail.test.ts`, `.github/workflows/ci.yml`
- Modify: `CLAUDE.md` (replace whole file), `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `npm run test:integration` against GreenMail; CI on Node 20/22/24.

- [ ] **Step 1: Add the GreenMail test server definition**

Create `test/docker-compose.greenmail.yml`:

```yaml
# Local IMAP/SMTP test server for `npm run test:integration`.
# Any username/password is accepted (auth.disabled); users are created on first login.
services:
  greenmail:
    image: greenmail/standalone:2.1.14
    environment:
      GREENMAIL_OPTS: "-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled"
    ports:
      - "3025:3025" # SMTP
      - "3143:3143" # IMAP
```

- [ ] **Step 2: Write the integration tests**

Create `src/__tests__/integration/greenmail.test.ts` (uses GreenMail's plaintext port on localhost only — never disable certificate verification against real servers):

```ts
/**
 * End-to-end tests against a real IMAP/SMTP server (GreenMail in Docker).
 *   docker compose -f test/docker-compose.greenmail.yml up -d
 *   IMAP_IT_HOST=localhost npm run test:integration
 * Skipped when IMAP_IT_HOST is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { connectHarness, type Harness } from "../helpers/mcp-harness.js";
import { header } from "../helpers/messages.js";
import type { SendDeps } from "../../mail/send.js";
import * as searchEmails from "../../tools/search-emails.js";
import * as moveEmail from "../../tools/move-email.js";
import * as createDraft from "../../tools/create-draft.js";
import * as sendEmail from "../../tools/send-email.js";

const HOST = process.env.IMAP_IT_HOST;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(user: string): Promise<ImapFlow> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    const client = new ImapFlow({
      host: HOST!,
      port: 3143,
      secure: false,
      doSTARTTLS: false, // throwaway local test server; no real credentials involved
      auth: { user, pass: "secret" },
      logger: false,
    });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      await sleep(1000);
    }
  }
  throw lastError;
}

async function waitForMessages(client: ImapFlow, folder: string, count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const status = await client.status(folder, { messages: true });
    if ((status.messages ?? 0) >= count) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${count} messages in ${folder}`);
}

describe.skipIf(!HOST)("GreenMail integration", () => {
  const user = `it-${Date.now()}@example.com`;
  const smtp = nodemailer.createTransport({ host: HOST, port: 3025, secure: false, ignoreTLS: true });
  let client: ImapFlow;
  let h: Harness;

  beforeAll(async () => {
    client = await connect(user);
    for (const folder of ["Archive", "Drafts", "Sent"]) await client.mailboxCreate(folder);
    await smtp.sendMail({ from: "anna@example.com", to: user, subject: "Seed A", text: "a" });
    await smtp.sendMail({ from: "bob@example.com", to: user, subject: "Seed B", text: "b" });
    await waitForMessages(client, "INBOX", 2);

    const getClient = async () => client;
    const deps: SendDeps = {
      transport: smtp,
      getClient,
      imapHost: HOST!,
      sentCopy: "auto",
      sentProbeCache: new Map(),
      sentProbe: { attempts: 1, delayMs: 0 },
    };
    h = await connectHarness((server) => {
      searchEmails.register(server, getClient);
      moveEmail.register(server, getClient);
      createDraft.register(server, getClient, user);
      sendEmail.register(server, deps, user);
    });
  });

  afterAll(async () => {
    await h?.close();
    await client?.logout();
  });

  it("search_emails applies the sender filter on a real server", async () => {
    const res = await h.call("search_emails", { from: "anna@example.com" });
    expect(res.isError).toBe(false);
    expect(res.json.totalMatches).toBe(1);
    expect(res.json.messages[0].subject).toBe("Seed A");
  });

  it("move_email to a missing folder fails and leaves the inbox untouched", async () => {
    const search = await h.call("search_emails", {});
    const uids = search.json.messages.map((m: any) => m.uid);
    const res = await h.call("move_email", { uids, destination: "Does/Not/Exist" });
    expect(res.isError).toBe(true);
    const after = await h.call("search_emails", {});
    expect(after.json.totalMatches).toBe(uids.length);
  });

  it("create_draft round-trips an umlaut attachment filename through the server", async () => {
    const res = await h.call("create_draft", {
      to: "kunde@example.com",
      subject: "Größe",
      body: "Anbei.",
      attachments: [{ filename: "Angebot_Größe.pdf", content: Buffer.from("%PDF").toString("base64"), contentType: "application/pdf" }],
    });
    expect(res.isError).toBe(false);
    const lock = await client.getMailboxLock("Drafts");
    try {
      const msg = await client.fetchOne(String(res.json.uid), { source: true }, { uid: true });
      const parsed = await simpleParser(msg && msg.source ? msg.source : Buffer.alloc(0));
      expect(parsed.subject).toBe("Größe");
      expect(parsed.attachments[0].filename).toBe("Angebot_Größe.pdf");
    } finally {
      lock.release();
    }
  });

  it("send_email delivers without Bcc header and files a copy in Sent", async () => {
    const res = await h.call("send_email", { to: user, bcc: "hidden@example.com", subject: "Self test", body: "hi" });
    expect(res.isError).toBe(false);
    expect(res.json.sentCopy.saved).toBe(true);
    await waitForMessages(client, "INBOX", 3);
    const lock = await client.getMailboxLock("INBOX");
    try {
      const [uid] = (await client.search({ subject: "Self test" }, { uid: true })) || [];
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      expect(header(msg && msg.source ? msg.source : Buffer.alloc(0), "bcc")).toBeUndefined();
    } finally {
      lock.release();
    }
  });
});
```

- [ ] **Step 3: Run them**

Without Docker: `npm run test:integration`
Expected: `1 skipped` (4 tests skipped) — the suite only runs with `IMAP_IT_HOST`.

With Docker:

```bash
docker compose -f test/docker-compose.greenmail.yml up -d
IMAP_IT_HOST=localhost npm run test:integration
docker compose -f test/docker-compose.greenmail.yml down
```

Expected: PASS — 4 tests. If GreenMail rejects `mailboxCreate` for an existing folder or does not deliver within 5 s, increase the wait loop in `waitForMessages` rather than weakening assertions.

- [ ] **Step 4: Add CI**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [master]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22, 24]
    services:
      greenmail:
        image: greenmail/standalone:2.1.14
        env:
          GREENMAIL_OPTS: "-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled"
        ports:
          - 3025:3025
          - 3143:3143
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      # keytar compiles from source on newer Node versions (removed in a later plan)
      - run: sudo apt-get update && sudo apt-get install -y libsecret-1-dev
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npm test
      - run: npm run test:integration
        env:
          IMAP_IT_HOST: localhost
```

- [ ] **Step 5: Update CLAUDE.md**

Replace `CLAUDE.md` with:

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An MCP (Model Context Protocol) server that exposes IMAP/SMTP email operations as tools for AI clients. Built with TypeScript (ES modules), uses `@modelcontextprotocol/sdk` for the MCP layer, `imapflow` for IMAP, `nodemailer` for SMTP and message composition, and `mailparser` for parsing emails. Includes a prompt injection detection layer that scans all email content before returning it to the AI consumer.

Production-readiness work is specified in `docs/superpowers/specs/2026-10-14-production-readiness-design.md` and executed through the plans in `docs/superpowers/plans/`.

## Commands

- **Build:** `npm run build` (runs `tsc`)
- **Dev:** `npm run dev` (runs `tsc --watch`)
- **Start:** `npm start` (runs `node dist/index.js`)
- **Setup:** `npm run setup` (interactive credential + permissions wizard)
- **Test:** `npm test` (unit tests, no network)
- **Typecheck incl. tests:** `npm run typecheck`
- **Integration tests:** `docker compose -f test/docker-compose.greenmail.yml up -d` then `IMAP_IT_HOST=localhost npm run test:integration` (skipped when `IMAP_IT_HOST` is unset)
- **Test watch:** `npm run test:watch`
- **Clean:** `npm run clean` (removes `dist/`)

To run a single test file: `npx vitest run src/tools/__tests__/search-emails.test.ts`

## Architecture

**Entry points:**
- `src/index.ts` — MCP server setup, permission-gated tool registration, stdio transport. IMAP client is lazy-initialized on first tool use with a mutex to prevent concurrent connection races. SMTP transport and `SendDeps` are only created when `send` permission is enabled.
- `src/setup.ts` — Interactive CLI for configuring credentials and permissions.

**Infrastructure modules:**
- `src/credentials.ts` — Loads config from `~/.imap-mcp/config.json` (file mode 0o600) and password from OS keychain via `keytar`. Auto-migrates legacy `credentials.json` files. Falls back to `IMAP_PASSWORD` env var. Validates required fields and `sentCopy` (`auto` | `always` | `never`, default `auto`).
- `src/imap-client.ts` — `ImapConnectionManager` with auto-reconnect (exponential backoff, max 5 retries), keep-alive (NOOP every 5 min), connection mutex. TLS options come from `connection-security.ts`.
- `src/smtp-client.ts` — Factory for the nodemailer transport; TLS options from `connection-security.ts`.
- `src/connection-security.ts` — Implicit TLS on 993/465, **mandatory STARTTLS** on every other port (no plaintext fallback), TLS ≥ 1.2; loopback hosts (local bridges) keep opportunistic STARTTLS.
- `src/errors.ts` — `errorMessage()` helper that safely extracts error messages without leaking stack traces.
- `src/logging/logger.ts` — Structured JSON logging to stderr (stdout reserved for MCP stdio transport).

**IMAP layer (`src/imap/`):**
- `strict.ts` — Fail-closed wrappers. imapflow resolves many server refusals to `false` instead of throwing (search, move, copy, flag store, delete, status); these helpers turn that into `ImapOperationError`. Also `existingUids`, `safeExpunge` (refuses plain EXPUNGE without UIDPLUS when other `\Deleted` mail exists), `downloadMessage` (throws `MessageNotFoundError`).
- `folders.ts` — `resolveFolder` (exact → case-insensitive → delimiter-agnostic → unique leaf name; never `\Noselect`; errors with suggestions) and `findSpecialFolder`/`requireSpecialFolder` (SPECIAL-USE first, then English/German well-known names).
- `search-query.ts` — Shared filter schema (`searchFilterShape`, strict `YYYY-MM-DD` dates) and `compileSearch`, which throws instead of dropping a criterion and returns `appliedFilters`.
- `flags.ts` — `normalizeFlag` (system flags in any spelling, validated custom keywords), `uniqueUids`.

**Mail layer (`src/mail/`):**
- `compose.ts` — `composeMessage` via nodemailer `MailComposer`: RFC 2047 headers, RFC 2231 attachment filenames, CRLF-safe header values, quoted-printable for long lines, Message-ID on the sender's domain. Keeps Bcc in the stored copy; envelope contains all recipients.
- `headers.ts` — Byte-preserving header edits on raw messages (`removeHeaders`, `getHeader`, `setHeader`, `rfc5322Date`).
- `reply.ts` — Reply recipients (Reply-To over From, reply-all, own addresses removed case-insensitively), `replySubject` (Re/AW/Antw/SV/VS aware), plain/HTML quoting (`en`/`de`).
- `send.ts` — `deliver()` sends the archived bytes minus Bcc via `sendMail({ envelope, raw })`, then stores a Sent copy per `sentCopy` (auto: skipped for Gmail `X-GM-EXT-1` and Microsoft hosts; otherwise probes Sent once per server for the Message-ID). A failed Sent copy never turns a successful send into an error.

**Permission system:** Tools are grouped into four tiers. Each tier can be enabled/disabled in `~/.imap-mcp/config.json` under the `permissions` key. Tools in disabled tiers are never registered with the MCP server.

| Tier | Default | Tools |
|------|---------|-------|
| `read` | on | list_folders, search_emails, read_email, get_email_count, download_attachment, get_quota |
| `write` | on | mark_as_read, move_email, flag_email, create_draft, reply_draft, create/delete/rename_folder |
| `send` | off | send_email, send_draft |
| `delete` | off | delete_email |

`flag_email` refuses to add `\Deleted`, so the write tier cannot delete.

**Tools (src/tools/):** Each file exports a `register()` function. All tools have MCP annotations (`readOnlyHint`, `destructiveHint`; send tools also `openWorldHint`). Results use `jsonResult`/`errorResult` from `tools/shared/result.ts` (bigint-safe JSON).

- `list-folders.ts` — `list_folders`: Lists all mailboxes via `client.listTree()`. Skips synthetic root node.
- `search-emails.ts` — `search_emails`: filters from `searchFilterShape`; resolves the folder; never falls back to "all mail"; echoes `appliedFilters`, `uidValidity`; `hasAttachment` true/false filtered client-side (capped scan, `attachmentScanLimited`); subject-only `_injectionScan` per message.
- `read-email.ts` — `read_email`: resolves folder, downloads via `downloadMessage`, full injection scan.
- `get-email-count.ts` — `get_email_count`: Returns total/unread counts for one or all folders.
- `download-attachment.ts` — `download_attachment`: text as UTF-8, binary as base64; scans text content for injection.
- `get-quota.ts` — `get_quota`: storage quota; handles servers without QUOTA.
- `mark-as-read.ts`, `flag-email.ts`, `move-email.ts` — resolve folders, act only on existing UIDs, report `missingUids`, fail on server refusal; `flag_email` checks `PERMANENTFLAGS` before setting custom keywords; `move_email` requires an existing, selectable destination.
- `create-draft.ts` — `create_draft`: composes via `composeMessage`, appends to Drafts with `\Draft \Seen`, returns the draft `uid`. Exports `validateAttachments` and `attachmentSchema`.
- `reply-draft.ts` — `reply_draft`: Reply-To aware, threaded (`In-Reply-To`/`References`), quotes the original (`quoteOriginal`, `language`).
- `manage-folders.ts` — `create_folder`, `delete_folder`, `rename_folder`.
- `send-email.ts` — `send_email`: compose + `deliver()`.
- `send-draft.ts` — `send_draft`: sends the stored draft bytes (WYSIWYG) after removing client bookkeeping headers, refreshing `Date` and ensuring a Message-ID; refuses drafts whose From is not the account; deletes the draft with `safeExpunge` (non-fatal).
- `delete-email.ts` — `delete_email`: moves to Trash, or `safeExpunge` when already in Trash.
- `health-check.ts` — `health_check`: connection state, SMTP config, scan stats, uptime. Always registered.

**Security layer (src/security/):**
- `patterns.ts` — All regex patterns and keyword lists organized by detection category. Pre-compiled at module load. Confidence scores per pattern. `computeRiskLevel()` for compound scoring.
- `unicode-normalizer.ts` — `normalizeToASCII()` converts trick Unicode to ASCII for detection only. `hasNonAscii()` for fast-path bypass.
- `injection-detector.ts` — `scanForInjection(input)` and `scanSubjectOnly(subject)` across 7 detection categories, early exit on critical, multi-vector compound finding.

**Key patterns:**
- Never call imapflow's `search`, `messageMove`, `messageCopy`, `messageFlagsAdd/Remove`, `messageDelete`, `append` or `download` directly from a tool — use `src/imap/strict.ts`.
- Never pass a folder name from tool input straight to imapflow — use `resolveFolder` / `requireSpecialFolder`.
- A tool must never select more messages than requested: unsupported criteria are errors, and responses echo what was applied.
- Build messages only with `composeMessage`; send only with `deliver()`.
- IMAP operations that read mailboxes acquire a lock via `getMailboxLock()` and release in a `finally` block.
- Zod schemas define tool input validation.
- Logging goes to stderr (stdout is reserved for MCP stdio transport).
- Error messages use `errorMessage()`/`errorResult()` and say whether anything was changed.
- Injection scan metadata (`_injectionScan`) is attached to responses — original email content is never modified.

**Testing:**
- Unit tests live next to the code in `src/**/__tests__/`. Tool behaviour is tested through a real MCP client: `connectHarness()` (`src/__tests__/helpers/mcp-harness.ts`) wires an `McpServer` to a `Client` over `InMemoryTransport`.
- `FakeImap` (`src/__tests__/helpers/fake-imap.ts`) mimics imapflow including its soft failures; use `failOn(method, "false" | "throw")` to simulate server refusals.
- `createCaptureTransport()` behaves like the SMTP transport (Bcc stripped) but records messages; nodemailer's stream/json transports keep Bcc and must not be used for Bcc tests.
- `buildRaw()` builds fixture messages; `header()` reads a header from raw bytes.
- Integration tests (`src/__tests__/integration/`) run against GreenMail; CI runs them on every push.
```

- [ ] **Step 6: Update README.md**

1. In "Quick Start", delete the two lines

```bash
# Install
npm install -g imap-mcp-server
```

(the npm name `imap-mcp-server` belongs to a different author — installing it would run someone else's code; Plan 6 publishes under a new name), and change the Claude Desktop example that uses `"command": "imap-mcp-server"` so that only the "running from source" variant remains.

2. In the "Send Tier" table replace the `send_draft` description with: `Send an existing draft exactly as stored in Drafts (create_draft → review → send_draft); a copy is filed in Sent`.

3. Below the "### Credentials" section add:

```markdown
### Transport security

Connections use implicit TLS on ports 993 (IMAP) and 465 (SMTP). On any other port the server requires STARTTLS and refuses to continue in plaintext, so a network attacker cannot downgrade the connection and read your password. Plaintext is only allowed to local bridges on `localhost`. TLS 1.2 is the minimum.

### Sent folder

Mail sent through the server is filed in your Sent folder. Gmail and Microsoft 365 do this themselves; for other servers the MCP server checks once and stores a copy when needed. To override, set `"sentCopy": "always"` or `"never"` in `~/.imap-mcp/config.json`.

### Fail-closed behaviour

If the mail server cannot apply a search filter, refuses a move, or does not support a custom keyword, the tool returns an error instead of guessing. Searches never fall back to "all messages", and every response lists the filters that were applied and any UIDs that no longer exist.
```

- [ ] **Step 7: Final verification**

Run: `npm run build && npm run typecheck && npm test`
Expected: build succeeds, typecheck exits 0, `Test Files 17 passed (17)`, `Tests 170 passed (170)`.

- [ ] **Step 8: Commit**

```bash
git add test/docker-compose.greenmail.yml src/__tests__/integration .github/workflows/ci.yml CLAUDE.md README.md
git commit -m "test: add GreenMail integration suite, CI and updated docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Release note**

Bump `version` in `package.json` and `VERSION` in `src/index.ts` to `0.2.0`, then:

```bash
git add package.json src/index.ts
git commit -m "chore: release 0.2.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
