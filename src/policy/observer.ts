import type { AccountRuntime, ToolCallEvent, ToolObserver } from "../context.js";
import type { RiskLevel } from "./engine.js";

const LEVELS = new Set<RiskLevel>(["none", "low", "medium", "high", "critical"]);
const ORDER: Record<RiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

export function isRiskLevel(value: unknown): value is RiskLevel {
  return typeof value === "string" && LEVELS.has(value as RiskLevel);
}

/** Highest of several injection risk levels ("none" for an empty list). */
export function highestRisk(levels: Array<RiskLevel | undefined>): RiskLevel {
  return levels.reduce<RiskLevel>((max, level) => (level && ORDER[level] > ORDER[max] ? level : max), "none");
}

/**
 * Feeds injection findings from read tools (details.injectionRisk) into every account's policy:
 * a manipulated email read through one mailbox must not be able to drive sending from another.
 */
export class InjectionRiskObserver implements ToolObserver {
  constructor(private readonly accounts: { values(): Iterable<Pick<AccountRuntime, "policy">> }) {}

  onToolCall(event: ToolCallEvent): void {
    const risk = event.details.injectionRisk;
    if (!isRiskLevel(risk) || risk === "none") return;
    for (const account of this.accounts.values()) account.policy.noteInjectionRisk(risk);
  }
}
