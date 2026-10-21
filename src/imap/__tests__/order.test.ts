import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { newestFirst } from "../order.js";

async function setup() {
  const t = createTestApp();
  const imap = t.imap();
  const raw = await buildRaw({ from: "a@example.com", to: "me@example.com", subject: "x" });
  imap.addMessage("INBOX", raw, { internalDate: new Date("2021-05-01T10:00:00Z") }); // uid 1
  imap.addMessage("INBOX", raw, { internalDate: new Date("2024-05-01T10:00:00Z") }); // uid 2
  imap.addMessage("INBOX", raw, { internalDate: new Date("2022-05-01T10:00:00Z") }); // uid 3
  imap.addMessage("INBOX", raw, { internalDate: new Date("2024-05-01T10:00:00Z") }); // uid 4, same date as 2
  const client: any = await (await t.app.accounts.get("main")!.getClient());
  return client;
}

describe("newestFirst", () => {
  it("orders by arrival date, the higher UID first on equal dates", async () => {
    const client = await setup();
    const lock = await client.getMailboxLock("INBOX");
    try {
      expect(await newestFirst(client, [1, 2, 3, 4])).toEqual({ uids: [4, 2, 3, 1], sortedBy: "date" });
    } finally {
      lock.release();
    }
  });

  it("keeps the order by UID above the limit", async () => {
    const client = await setup();
    const lock = await client.getMailboxLock("INBOX");
    try {
      expect(await newestFirst(client, [1, 2, 3, 4], 3)).toEqual({ uids: [4, 3, 2, 1], sortedBy: "uid" });
    } finally {
      lock.release();
    }
  });
});
