import { describe, it, expect } from "vitest";
import { createTestApp } from "../../__tests__/helpers/test-app.js";
import * as healthCheck from "../health-check.js";

describe("health_check", () => {
  it("never reports a negative IMAP uptime when the check itself opens the connection", async () => {
    const t = createTestApp();
    const account = t.app.accounts.get("main")!;
    const stats = { connected: false, lastActivity: null, connectedSince: null as Date | null, reconnectCount: 0, server: "imap.test" };
    const getClient = account.getClient.bind(account);
    account.connectionStats = () => stats;
    account.getClient = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20)); // connecting takes a moment
      stats.connected = true;
      stats.connectedSince = new Date();
      return getClient();
    };
    const h = await t.connect(healthCheck.register);
    const res = await h.call("health_check");
    expect(res.json.accounts[0].imap.uptime).toBeGreaterThanOrEqual(0);
    await h.close();
  });

  it("tells a configured SMTP server apart from the permission to send", async () => {
    const t = createTestApp([{ permissions: { read: true, write: true, send: false, delete: false } }]);
    const h = await t.connect(healthCheck.register);
    const res = await h.call("health_check");
    expect(res.json.accounts[0].smtp).toEqual({ configured: true, sendAllowed: false });
    await h.close();
  });
});
