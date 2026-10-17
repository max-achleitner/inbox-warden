import type { PermissionTier } from "../../config/schema.js";
import { AccountNotFoundError, type AccountRuntime, type AppContext, type ToolCallEvent, type ToolObserver } from "../../context.js";
import { tierAllowed } from "../../policy/engine.js";

/** The authenticated caller of the HTTP endpoint. */
export interface Principal {
  kind: "bearer" | "oauth";
  /** Stable id used for rate limiting and the audit log: "token:<id>" or "oauth:<sub>". */
  id: string;
  tokenId?: string;
  sub?: string;
  email?: string;
  groups: string[];
  scopes: string[];
  clientId?: string;
  /** Seconds since epoch. */
  expiresAt?: number;
}

export interface PrincipalRule {
  match: { sub?: string; email?: string; group?: string; tokenId?: string };
  /** Account ids, or "*" for every configured account. */
  accounts: string[];
}

/** Every key present in `match` must match (AND). */
export function ruleMatches(rule: PrincipalRule, principal: Principal): boolean {
  const m = rule.match;
  if (m.tokenId !== undefined && m.tokenId !== principal.tokenId) return false;
  if (m.sub !== undefined && m.sub !== principal.sub) return false;
  if (m.email !== undefined && m.email.toLowerCase() !== principal.email?.toLowerCase()) return false;
  if (m.group !== undefined && !principal.groups.includes(m.group)) return false;
  return true;
}

/**
 * Account ids this principal may use, in configuration order.
 * No rules configured: bearer tokens get every account (the token is the trust anchor);
 * OAuth principals get none (config validation already requires rules in OAuth mode).
 */
export function allowedAccountIds(
  principal: Principal,
  rules: PrincipalRule[],
  allIds: string[],
): string[] {
  if (rules.length === 0) return principal.kind === "bearer" ? [...allIds] : [];
  const allowed = new Set<string>();
  for (const rule of rules) {
    if (!ruleMatches(rule, principal)) continue;
    for (const id of rule.accounts) {
      if (id === "*") allIds.forEach((a) => allowed.add(a));
      else allowed.add(id);
    }
  }
  return allIds.filter((id) => allowed.has(id));
}

/**
 * A per-request view of the shared AppContext: only the allowed accounts are visible, and every
 * audit event carries the principal. Account runtimes (IMAP connections) stay shared.
 * Other AppContext members are inherited from `app` via the prototype chain.
 */
export function scopeAppContext(app: AppContext, principal: Principal, allowedIds: string[]): AppContext {
  const allowed = new Set(allowedIds);
  const accounts = new Map<string, AccountRuntime>([...app.accounts].filter(([id]) => allowed.has(id)));
  const observers: ToolObserver[] = app.observers.map((observer) => ({
    onToolCall: (event: ToolCallEvent) =>
      observer.onToolCall({
        ...event,
        details: { ...event.details, principal: principal.id, principalKind: principal.kind },
      }),
  }));
  // The configured default if this principal may use it, otherwise its first allowed mailbox.
  const defaultAccountId = allowed.has(app.defaultAccountId) ? app.defaultAccountId : [...accounts.keys()][0];

  const overrides = {
    accounts,
    observers,
    defaultAccountId,
    resolveAccount(id: string | undefined): AccountRuntime {
      const wanted = id?.trim() || defaultAccountId;
      // Same error for "exists but not yours" and "does not exist", listing only this caller's accounts.
      if (!allowed.has(wanted)) throw new AccountNotFoundError(wanted, [...accounts.keys()]);
      return app.resolveAccount(wanted);
    },
    anyAccountAllows(tier: PermissionTier): boolean {
      // Same policy-aware check as Plan 5's createAppContext: a drafts-only mailbox never enables send tools.
      return [...accounts.values()].some((a) => tierAllowed(a.config, tier));
    },
    async shutdown(): Promise<void> {
      // Shared account runtimes are owned by the process, not by one request.
    },
  };
  return Object.assign(Object.create(app) as AppContext, overrides);
}
