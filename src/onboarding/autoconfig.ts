import { Resolver } from "node:dns/promises";
import {
  MX_RULES,
  PROVIDER_PRESETS,
  presetById,
  type AuthKind,
  type LocalizedText,
  type ProviderPreset,
  type ServerSetting,
} from "./presets.js";

export interface DetectedProvider {
  presetId?: string;
  name: string;
  imap: ServerSetting;
  smtp: ServerSetting;
  auth: AuthKind;
  usernameStyle: "address" | "localpart";
  tenant?: string;
  helpUrl?: string;
  notes: LocalizedText[];
  source: "domain" | "mx" | "autoconfig" | "guess";
}

export type MxResolver = (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
export type TextFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface DetectDeps {
  resolveMx?: MxResolver;
  fetch?: TextFetch;
  timeoutMs?: number;
  /** false = only the built-in domain table (no DNS, no autoconfig requests). */
  network?: boolean;
}

function fromPreset(p: ProviderPreset, source: DetectedProvider["source"]): DetectedProvider {
  return {
    presetId: p.id,
    name: p.name,
    imap: p.imap,
    smtp: p.smtp,
    auth: p.auth,
    usernameStyle: p.usernameStyle ?? "address",
    tenant: p.tenant,
    helpUrl: p.helpUrl,
    notes: p.notes,
    source,
  };
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function tag(block: string, name: string): string | undefined {
  return block.match(new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i"))?.[1];
}

function fill(value: string, email: string): string {
  const [local, domain] = email.split("@");
  return value.replace(/%EMAILADDRESS%/g, email).replace(/%EMAILLOCALPART%/g, local).replace(/%EMAILDOMAIN%/g, domain);
}

/** First usable server of a type: TLS only, and implicit TLS only on the standard port. */
function pickServer(xml: string, kind: "incomingServer" | "outgoingServer", type: "imap" | "smtp", email: string) {
  const blocks = [...xml.matchAll(new RegExp(`<${kind}\\s+type="${type}"\\s*>([\\s\\S]*?)</${kind}>`, "gi"))].map((m) => m[1]);
  const implicitPort = type === "imap" ? 993 : 465;
  const candidates = blocks
    .map((b) => {
      const host = fill(tag(b, "hostname") ?? "", email).toLowerCase();
      const port = Number(tag(b, "port"));
      const socketType = (tag(b, "socketType") ?? "").toUpperCase();
      const username = tag(b, "username") ?? "%EMAILADDRESS%";
      if (!HOSTNAME.test(host) || !Number.isInteger(port)) return undefined;
      if (socketType === "SSL" && port === implicitPort) return { host, port, security: "implicit" as const, username };
      if (socketType === "STARTTLS" && port !== implicitPort && port !== 25) return { host, port, security: "starttls" as const, username };
      return undefined; // plaintext or unusual combinations are never auto-configured
    })
    .filter((c): c is NonNullable<typeof c> => c !== undefined);
  return candidates.find((c) => c.security === "implicit") ?? candidates[0];
}

/** Parse a Mozilla autoconfig (ISPDB / config-v1.1.xml) document. */
export function parseAutoconfig(xml: string, email: string): DetectedProvider | undefined {
  const imap = pickServer(xml, "incomingServer", "imap", email);
  const smtp = pickServer(xml, "outgoingServer", "smtp", email);
  if (!imap || !smtp) return undefined;
  return {
    name: tag(xml, "displayName") ?? email.split("@")[1],
    imap: { host: imap.host, port: imap.port, security: imap.security },
    smtp: { host: smtp.host, port: smtp.port, security: smtp.security },
    auth: "password",
    usernameStyle: imap.username === "%EMAILLOCALPART%" ? "localpart" : "address",
    notes: [],
    source: "autoconfig",
  };
}

async function fetchAutoconfig(email: string, domain: string, deps: DetectDeps): Promise<DetectedProvider | undefined> {
  const doFetch = deps.fetch ?? (fetch as unknown as TextFetch);
  const urls = [
    // the provider's own autoconfig (Mailcow and many hosters publish one) …
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    // … then Mozilla's ISPDB
    `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}`,
  ];
  for (const url of urls) {
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 5000) });
      if (res.status !== 200) continue;
      const found = parseAutoconfig(await res.text(), email);
      if (found) return found;
    } catch {
      // unreachable or not configured: try the next source
    }
  }
  return undefined;
}

async function lookupMx(domain: string, deps: DetectDeps): Promise<string[]> {
  const resolve: MxResolver =
    deps.resolveMx ??
    ((d) => {
      const resolver = new Resolver({ timeout: deps.timeoutMs ?? 3000, tries: 2 });
      return resolver.resolveMx(d);
    });
  try {
    const records = await resolve(domain);
    return records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase());
  } catch {
    return [];
  }
}

/** Find IMAP/SMTP settings for an address: built-in table → MX records → autoconfig → guess. */
export async function detectProvider(email: string, deps: DetectDeps = {}): Promise<DetectedProvider> {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain || !HOSTNAME.test(domain)) throw new Error(`"${email}" is not a valid email address.`);

  const known = PROVIDER_PRESETS.find((p) => p.domains.includes(domain));
  if (known) return fromPreset(known, "domain");

  if (deps.network !== false) {
    for (const exchange of await lookupMx(domain, deps)) {
      const rule = MX_RULES.find((r) => r.pattern.test(exchange));
      const preset = rule && presetById(rule.presetId);
      if (preset) return fromPreset(preset, "mx");
    }
    const auto = await fetchAutoconfig(email.trim(), domain, deps);
    if (auto) return auto;
  }

  return {
    name: domain,
    imap: { host: `imap.${domain}`, port: 993, security: "implicit" },
    smtp: { host: `smtp.${domain}`, port: 465, security: "implicit" },
    auth: "password",
    usernameStyle: "address",
    notes: [
      {
        de: "Die Servernamen wurden geraten. Bitte mit den Angaben Ihres Anbieters vergleichen.",
        en: "The server names were guessed. Please compare them with your provider's instructions.",
      },
    ],
    source: "guess",
  };
}

/**
 * Env-only mode (MCPB bundle, containers): fill IMAP_MCP_IMAP_HOST/PORT and IMAP_MCP_SMTP_HOST/PORT
 * from detection when only IMAP_MCP_EMAIL is given. Guessed hosts are never used here because
 * nobody can confirm them before the password is sent. IMAP_MCP_NO_AUTOCONFIG=1 switches off the
 * network lookups only; the built-in provider table still applies.
 */
export async function withDetectedEndpoints(
  env: NodeJS.ProcessEnv,
  detect: (email: string) => Promise<DetectedProvider> = (e) => detectProvider(e, { network: env.IMAP_MCP_NO_AUTOCONFIG !== "1" }),
): Promise<NodeJS.ProcessEnv> {
  const email = env.IMAP_MCP_EMAIL?.trim();
  if (!email || env.IMAP_MCP_IMAP_HOST?.trim()) return env;
  try {
    const found = await detect(email);
    if (found.source === "guess") return env;
    return {
      ...env,
      IMAP_MCP_IMAP_HOST: found.imap.host,
      IMAP_MCP_IMAP_PORT: env.IMAP_MCP_IMAP_PORT?.trim() || String(found.imap.port),
      IMAP_MCP_SMTP_HOST: env.IMAP_MCP_SMTP_HOST?.trim() || found.smtp.host,
      IMAP_MCP_SMTP_PORT: env.IMAP_MCP_SMTP_PORT?.trim() || String(found.smtp.port),
    };
  } catch {
    return env;
  }
}
