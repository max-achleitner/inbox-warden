import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { ConfigSchema, type IdentitySchema, type PermissionsSchema } from "../../config/schema.js";
import { createAppContext, type AppContext } from "../../context.js";
import type { SecretStore } from "../../secrets/store.js";
import { createCaptureTransport, type CaptureTransport } from "./capture-transport.js";
import { FakeImap } from "./fake-imap.js";
import { connectHarness, type Harness, type HarnessOptions } from "./mcp-harness.js";

export interface TestAccountOptions {
  id?: string;
  email?: string;
  permissions?: Partial<z.input<typeof PermissionsSchema>>;
  identities?: z.input<typeof IdentitySchema>[];
  policy?: Record<string, unknown>;
  imap?: FakeImap;
  imapHost?: string;
  /** Set to false to configure the account without an SMTP server. */
  smtp?: boolean;
  locale?: "de" | "en";
}

export interface TestApp {
  app: AppContext;
  /** Where the policy engine keeps its send counters. */
  stateDir: string;
  imap(id?: string): FakeImap;
  capture(id?: string): CaptureTransport;
  connect(...registers: Array<(server: McpServer, app: AppContext) => void>): Promise<Harness>;
  /** Like connect(), with client options such as an elicitation responder. */
  connectWith(options: HarnessOptions, ...registers: Array<(server: McpServer, app: AppContext) => void>): Promise<Harness>;
}

/** FakeImap with INBOX plus Drafts, Sent and Trash advertised via SPECIAL-USE. */
export function standardFakeImap(): FakeImap {
  const imap = new FakeImap();
  imap.addFolder("Drafts", { specialUse: "\\Drafts" });
  imap.addFolder("Sent", { specialUse: "\\Sent" });
  imap.addFolder("Trash", { specialUse: "\\Trash" });
  return imap;
}

const testSecrets: SecretStore = {
  get: async () => "secret",
  set: async () => {},
  delete: async () => {},
};

/** An AppContext backed by FakeImap and capture transports, with every permission tier enabled by default. */
export function createTestApp(accounts: TestAccountOptions[] = [{}], config: Record<string, unknown> = {}): TestApp {
  const imaps = new Map<string, FakeImap>();
  const captures = new Map<string, CaptureTransport>();

  const accountConfigs = accounts.map((a, index) => {
    const id = a.id ?? (index === 0 ? "main" : `account-${index + 1}`);
    imaps.set(id, a.imap ?? standardFakeImap());
    captures.set(id, createCaptureTransport());
    const host = a.imapHost ?? "mail.firma.example";
    return {
      id,
      email: a.email ?? "max@firma.example",
      imap: { host, port: 993 },
      ...(a.smtp === false ? {} : { smtp: { host, port: 465 } }),
      permissions: { read: true, write: true, send: true, delete: true, ...a.permissions },
      identities: a.identities ?? [],
      policy: a.policy ?? {},
      ...(a.locale ? { locale: a.locale } : {}),
    };
  });

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-mcp-state-"));
  const parsed = ConfigSchema.parse({ version: 2, accounts: accountConfigs, ...config });
  const app = createAppContext(parsed, testSecrets, {
    connectImap: (account) => async () => imaps.get(account.id)!.asClient(),
    createTransport: (account) => captures.get(account.id)!.transport,
    sentProbe: { attempts: 1, delayMs: 0 },
    stateDir,
  });

  return {
    app,
    stateDir,
    imap: (id = app.defaultAccountId) => imaps.get(id)!,
    capture: (id = app.defaultAccountId) => captures.get(id)!,
    connect: (...registers) => connectHarness((server) => registers.forEach((register) => register(server, app))),
    connectWith: (options, ...registers) =>
      connectHarness((server) => registers.forEach((register) => register(server, app)), options),
  };
}
