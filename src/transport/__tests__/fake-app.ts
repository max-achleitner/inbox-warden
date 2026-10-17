import type { AppContext, ToolCallEvent } from "../../context.js";

/**
 * A minimal AppContext for transport tests: accounts expose only `id`, `config.permissions` and
 * `config.policy.send.mode` (read by Plan 5's tierAllowed), which is all the HTTP layer touches.
 * The account id "drafts" gets the drafts-only send policy. Cast because the real AccountRuntime has many more members.
 */
export function fakeApp(ids: string[], events: ToolCallEvent[] = [], defaultAccount?: string): AppContext {
  const accounts = new Map(
    ids.map((id) => [
      id,
      {
        id,
        config: {
          id,
          email: `${id}@firma.example`,
          permissions: { read: true, write: true, send: id === "office" || id === "drafts", delete: false },
          policy: { send: { mode: id === "drafts" ? "drafts-only" : "confirm" } },
        },
      },
    ]),
  );
  const defaultAccountId = defaultAccount ?? ids[0];
  return {
    config: { defaultAccount, accounts: [...accounts.values()].map((a) => a.config) },
    defaultAccountId,
    accounts,
    observers: [{ onToolCall: (event: ToolCallEvent) => void events.push(event) }],
    resolveAccount(id: string | undefined) {
      const account = accounts.get(id ?? defaultAccountId);
      if (!account) throw new Error(`Unknown account "${id}"`);
      return account;
    },
    anyAccountAllows: (tier: "read" | "write" | "send" | "delete") =>
      [...accounts.values()].some((a) => a.config.permissions[tier] && !(tier === "send" && a.config.policy.send.mode === "drafts-only")),
    shutdown: async () => {},
  } as unknown as AppContext;
}
