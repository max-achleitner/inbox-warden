import * as path from "node:path";
import type { AccountConfig, PermissionTier } from "../config/schema.js";
import { errorMessage } from "../errors.js";
import { sanitizeFilename } from "../files/sandbox.js";
import * as log from "../logging/logger.js";
import type { Policy } from "./schema.js";
import type { FolderInfo } from "../imap/folders.js";
import type { MessageScope } from "../imap/strict.js";
import { folderAllowed } from "./folder-rules.js";
import { LabelLock } from "./label-lock.js";
import { domainOf, evaluateRecipients } from "./recipients.js";
import { SendCounter } from "./rate-limit.js";
import { SERVER_NAME } from "../version.js";

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";
export type BulkAction = "move" | "mark" | "flag" | "delete";

const RISK_ORDER: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
/** How long a suspicious email keeps outbound actions under mandatory confirmation. */
export const INJECTION_WINDOW_MS = 60 * 60 * 1000;

/**
 * File types that run code when opened on Windows/macOS/Android: programs, scripts, shortcuts,
 * disk images and Office documents with macros. The one list for every attachment safety check.
 */
const EXECUTABLE_EXTENSIONS = new Set([
  "exe", "com", "scr", "pif", "cpl", "dll", "msi", "msp", "msix", "msixbundle", "appx", "appxbundle", "appinstaller", "application",
  "app", "command", "dmg", "pkg", "apk", "jar", "msc", "chm", "xll",
  "bat", "cmd", "ps1", "psm1", "psd1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "sh", "reg", "lnk", "url",
  "iso", "img", "vhd", "vhdx",
  "docm", "dotm", "xlsm", "xltm", "xlam", "xlsb", "pptm", "potm", "ppam", "ppsm", "sldm", "one",
]);

/** A request the administrator's policy does not allow. Reported to the AI as outcome "denied". */
export class PolicyDeniedError extends Error {
  constructor(message: string, readonly rule: string) {
    super(message);
    this.name = "PolicyDeniedError";
  }
}

/** Tier permission after policy: an account in "drafts-only" mode never gets the send tier. */
export function tierAllowed(account: AccountConfig, tier: PermissionTier): boolean {
  if (!account.permissions[tier]) return false;
  if (tier === "send" && account.policy.send.mode === "drafts-only") return false;
  return true;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

/** Plain-language reason for a tier refusal. */
export function tierDenialMessage(account: AccountConfig, tier: PermissionTier): string {
  if (tier === "send" && account.permissions.send) {
    return `Sending is switched off for the mail account "${account.id}" (drafts-only policy). Nothing was sent. Create a draft instead; a person sends it from the mail program.`;
  }
  return `The mail account "${account.id}" does not allow ${tier} actions. Nothing was changed. An administrator can enable the "${tier}" permission.`;
}

export function isExecutableFilename(filename: string): boolean {
  // Checked on the name as it will be written: the sanitizer drops trailing dots and spaces ("invoice.exe." → "invoice.exe")
  return EXECUTABLE_EXTENSIONS.has(path.extname(sanitizeFilename(filename)).slice(1).toLowerCase());
}

export interface PolicyEngineOptions {
  /** Folder for persisted counters (CONFIG_DIR/state in production). */
  stateDir: string;
  now?: () => number;
}

/** Per-account policy decisions. All check* methods throw PolicyDeniedError. */
export class PolicyEngine {
  private readonly counter: SendCounter;
  private readonly now: () => number;
  private readonly ownDomains: string[];
  private injection: { level: RiskLevel; at: number } | null = null;

  constructor(
    readonly accountId: string,
    readonly policy: Policy,
    ownAddresses: string[],
    options: PolicyEngineOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.counter = new SendCounter(path.join(options.stateDir, `send-counter-${accountId}.json`), this.now);
    this.ownDomains = [...new Set(ownAddresses.map(domainOf).filter((d): d is string => d !== null))];
  }

  get sendMode(): Policy["send"]["mode"] {
    return this.policy.send.mode;
  }

  /** Validates recipients; returns them unique and lowercased. */
  checkRecipients(addresses: string[]): string[] {
    const verdict = evaluateRecipients(addresses, {
      allowedDomains: this.policy.send.allowedRecipientDomains,
      blockedDomains: this.policy.send.blockedRecipientDomains,
      maxRecipients: this.policy.send.maxRecipients,
      ownDomains: this.ownDomains,
    });
    if (!verdict.ok) throw new PolicyDeniedError(verdict.reason, verdict.rule);
    return verdict.recipients;
  }

  private rateDenial(exceeded: "hour" | "day"): PolicyDeniedError {
    const { maxPerHour, maxPerDay } = this.policy.send;
    return exceeded === "hour"
      ? new PolicyDeniedError(
          `The limit of ${maxPerHour} sent emails per hour for this mailbox is reached. Nothing was sent; try again later or ask your administrator.`,
          "send.maxPerHour",
        )
      : new PolicyDeniedError(
          `The limit of ${maxPerDay} sent emails per day for this mailbox is reached. Nothing was sent; try again tomorrow or ask your administrator.`,
          "send.maxPerDay",
        );
  }

  /** Early check (before asking the user to confirm); reserveSend() decides atomically right before SMTP. */
  checkRate(): void {
    let counts: { lastHour: number; lastDay: number };
    try {
      counts = this.counter.counts();
    } catch (err) {
      throw new PolicyDeniedError(`${errorMessage(err)} Nothing was sent.`, "send.rate");
    }
    if (counts.lastHour >= this.policy.send.maxPerHour) throw this.rateDenial("hour");
    if (counts.lastDay >= this.policy.send.maxPerDay) throw this.rateDenial("day");
  }

  /**
   * Count this send against the limits in one locked step, before SMTP transmits — so parallel
   * sends cannot overshoot and no counter failure can follow a successful send. Call release()
   * when delivery fails.
   */
  reserveSend(): { release(): void } {
    const { maxPerHour, maxPerDay } = this.policy.send;
    let reservation: ReturnType<SendCounter["reserve"]>;
    try {
      reservation = this.counter.reserve({ maxPerHour, maxPerDay });
    } catch (err) {
      throw new PolicyDeniedError(`${errorMessage(err)} Nothing was sent.`, "send.rate");
    }
    if (!reservation.ok) throw this.rateDenial(reservation.exceeded);
    const at = reservation.at;
    return {
      release: () => {
        try {
          this.counter.release(at);
        } catch (err) {
          // Counting a send that did not happen is the safe direction
          log.warn("policy.send_counter_release_failed", { account: this.accountId, error: errorMessage(err) });
        }
      },
    };
  }

  folderAllowed(folderPath: string, delimiter?: string, aggregate?: boolean): boolean {
    return folderAllowed(folderPath, delimiter, this.policy.folders, aggregate);
  }

  /**
   * Which messages of a selected folder the AI may see: on Gmail, none that carries a label the
   * deny patterns hide (src/policy/label-lock.ts). Pass `folders` when the caller already listed them.
   */
  messageScope(folders?: FolderInfo[]): MessageScope {
    return new LabelLock(this.policy.folders, folders);
  }

  checkFolder(folderPath: string, delimiter?: string): void {
    if (!this.folderAllowed(folderPath, delimiter)) {
      throw new PolicyDeniedError(
        `Access to the folder "${folderPath}" is locked in this mailbox's settings. Nothing was changed.`,
        "folders",
      );
    }
  }

  checkBulk(count: number, action: BulkAction): void {
    const limit = action === "delete" ? this.policy.bulk.maxDelete : this.policy.bulk.maxMessages;
    if (count > limit) {
      throw new PolicyDeniedError(
        `${count} messages match, more than the limit of ${limit} per operation` +
          `${action === "delete" ? " for deleting" : ""} set by your administrator's policy. Nothing was changed. ` +
          "Do not split the same change into smaller batches. Choose a narrower selection only if that is what the user actually wants " +
          "(one sender or one topic), or let the mailbox owner raise the limit with " +
          `"${SERVER_NAME} accounts edit <account> ${action === "delete" ? "--max-delete" : "--max-messages"} <n>".`,
        "bulk",
      );
    }
  }

  /** INBOX and special-use folders (Drafts, Sent, Trash, Junk, Archive …) cannot be renamed or deleted. */
  checkProtectedFolder(folderPath: string, isSpecialUse: boolean): void {
    if (this.policy.protectedFolders && (folderPath.toUpperCase() === "INBOX" || isSpecialUse)) {
      throw new PolicyDeniedError(`"${folderPath}" is a system folder and is protected from being renamed or deleted.`, "protectedFolders");
    }
  }

  checkAttachment(filename: string, size: number, savingToDisk: boolean): void {
    const max = this.policy.attachments.maxDownloadBytes;
    if (size > max) {
      throw new PolicyDeniedError(
        `The attachment "${filename}" is ${formatSize(size)}; your policy allows at most ${formatSize(max)}. Nothing was returned or saved.`,
        "attachments.maxDownloadBytes",
      );
    }
    if (savingToDisk && this.policy.attachments.blockExecutables && isExecutableFilename(filename)) {
      throw new PolicyDeniedError(
        `"${filename}" is a program or script file (or an Office document with macros) and is not saved for safety reasons ` +
          "(your administrator's policy). Nothing was saved.",
        "attachments.blockExecutables",
      );
    }
  }

  noteInjectionRisk(level: RiskLevel): void {
    if (RISK_ORDER[level] === 0) return;
    const active = this.activeInjectionRisk();
    if (!active || RISK_ORDER[level] >= RISK_ORDER[active]) this.injection = { level, at: this.now() };
  }

  activeInjectionRisk(): RiskLevel | null {
    if (!this.injection) return null;
    if (this.now() - this.injection.at > INJECTION_WINDOW_MS) {
      this.injection = null;
      return null;
    }
    return this.injection.level;
  }

  /** The risk level that currently forces confirmation for outbound actions, if any. */
  injectionEscalation(): RiskLevel | null {
    const threshold = this.policy.send.confirmAfterInjectionRisk;
    if (threshold === "never") return null;
    const active = this.activeInjectionRisk();
    return active && RISK_ORDER[active] >= RISK_ORDER[threshold] ? active : null;
  }
}
