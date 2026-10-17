import type { Logger } from "imapflow";
import * as log from "./logger.js";
import { redactImapLine } from "./redact.js";

/**
 * imapflow protocol logger, enabled only with IMAP_MCP_PROTOCOL_LOG=1 (troubleshooting).
 * Credentials are redacted before anything is written; message bodies appear in FETCH
 * responses, so this must stay off in normal operation.
 */
export function createProtocolLogger(env: NodeJS.ProcessEnv = process.env): Logger | false {
  if (env.IMAP_MCP_PROTOCOL_LOG !== "1") return false;
  const emit = (entry: unknown) => {
    const obj = (entry ?? {}) as { src?: unknown; msg?: unknown; cid?: unknown };
    const src = typeof obj.src === "string" ? obj.src : undefined;
    log.info("imap.protocol", {
      src,
      msg: typeof obj.msg === "string" ? redactImapLine(src, obj.msg) : undefined,
      cid: typeof obj.cid === "string" ? obj.cid : undefined,
    });
  };
  return { debug: emit, info: emit, warn: emit, error: emit };
}
