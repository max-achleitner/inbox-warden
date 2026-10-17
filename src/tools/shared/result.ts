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
