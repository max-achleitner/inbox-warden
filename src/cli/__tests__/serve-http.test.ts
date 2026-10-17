import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { generateBearerToken } from "../../transport/auth/bearer.js";
import { startServeHttp, type ServeHttpHandle } from "../serve-http.js";

describe("serve --http start-up", () => {
  let home: string;
  let handle: ServeHttpHandle | number | undefined;
  const token = generateBearerToken();

  function writeConfig(extra: Record<string, unknown>): NodeJS.ProcessEnv {
    const config = {
      version: 2,
      accounts: [{ id: "main", email: "max@firma.example", imap: { host: "127.0.0.1", port: 993 } }],
      audit: { path: path.join(home, "audit"), includeReads: true },
      ...extra,
    };
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
    return {
      IMAP_MCP_HOME: home,
      IMAP_MCP_CONFIG: path.join(home, "config.json"),
      IMAP_MCP_NO_AUTOCONFIG: "1",
      IMAP_MCP_PASSWORD_MAIN: "not-used",
    };
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "imcp-serve-"));
  });

  afterEach(async () => {
    if (handle && typeof handle !== "number") await handle.close();
    handle = undefined;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("refuses to start without httpAuth (exit code 2) and creates no audit trail", async () => {
    handle = await startServeHttp([], writeConfig({ http: { port: 0 } }));
    expect(handle).toBe(2);
    expect(fs.existsSync(path.join(home, "audit"))).toBe(false);
  });

  it("writes an audit record with the caller for a tool call over HTTP", async () => {
    handle = await startServeHttp(
      ["--port", "0"],
      writeConfig({ httpAuth: { mode: "bearer", tokens: [{ id: "ops", sha256: token.sha256 }] } }),
    );
    if (typeof handle === "number") throw new Error(`refused with exit code ${handle}`);

    const client = new Client({ name: "serve-http-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token.token}` } } }),
    );
    const result = await client.callTool({ name: "list_accounts", arguments: {} });
    await client.close();
    expect(result.isError).toBeFalsy();

    const auditDir = path.join(home, "audit");
    const lines = fs
      .readdirSync(auditDir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => fs.readFileSync(path.join(auditDir, f), "utf8").trim().split("\n"))
      .map((line) => JSON.parse(line));
    expect(lines.find((r) => r.tool === "list_accounts")?.details).toMatchObject({ principal: "token:ops", principalKind: "bearer" });
  });
});
