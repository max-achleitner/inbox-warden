/** Larger moves report only the count: hundreds of old→new UID pairs cost many tokens and are rarely used. */
export const UID_MAPPING_LIMIT = 50;

/** Response fields describing the new UIDs after a move (COPYUID), shortened for large moves. */
export function uidMappingFields(uidMap: Map<number, number>, destination: string): Record<string, unknown> {
  if (uidMap.size === 0) return {};
  if (uidMap.size <= UID_MAPPING_LIMIT) return { uidMapping: Object.fromEntries(uidMap) };
  return { uidMappingOmitted: `${uidMap.size} new UIDs are not listed; search "${destination}" to work with the moved emails.` };
}
