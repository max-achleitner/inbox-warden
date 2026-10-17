/**
 * ISO string for an ENVELOPE date. imapflow passes an unparseable Date header (common in spam)
 * through as the raw string, where `new Date(raw).toISOString()` would throw and fail the whole
 * listing; such dates are left out instead.
 */
export function envelopeDate(value: Date | string | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
