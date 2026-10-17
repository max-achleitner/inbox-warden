import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { bundleFileName, nativeBinaries, renderManifest, toolSummaries } from "../lib/mcpb.mjs";

const template = JSON.parse(readFileSync(new URL("../../mcpb/manifest.json", import.meta.url), "utf8"));
const pkg = { name: "inbox-warden", version: "1.2.3" };
const tools = [{ name: "search_emails", description: "Search emails." }];

describe("mcpb/manifest.json", () => {
  it("passes configuration only through the agreed env-only variables", () => {
    expect(Object.keys(template.server.mcp_config.env).sort()).toEqual([
      "IMAP_MCP_AUTH",
      "IMAP_MCP_DISPLAY_NAME",
      "IMAP_MCP_DOWNLOAD_DIR",
      "IMAP_MCP_EMAIL",
      "IMAP_MCP_IMAP_HOST",
      "IMAP_MCP_IMAP_PORT",
      "IMAP_MCP_LANG",
      "IMAP_MCP_LOCALE",
      "IMAP_MCP_NO_AUTOCONFIG",
      "IMAP_MCP_OAUTH_CLIENT_ID",
      "IMAP_MCP_OAUTH_CLIENT_SECRET",
      "IMAP_MCP_OAUTH_TENANT",
      "IMAP_MCP_PASSWORD",
      "IMAP_MCP_PERMISSIONS",
      "IMAP_MCP_SEND_MODE",
      "IMAP_MCP_SMTP_HOST",
      "IMAP_MCP_SMTP_PORT",
      "IMAP_MCP_USERNAME",
    ]);
  });

  it("ships safe defaults: Claude drafts, the human sends; nothing is deleted", () => {
    expect(template.user_config.permissions.default).toBe("read,write");
    expect(template.user_config.send_mode.default).toBe("confirm");
  });

  it("offers password, Microsoft 365 and Google sign-in, password by default", () => {
    expect(template.user_config.auth_method.default).toBe("password");
    expect(template.user_config.auth_method.description).toMatch(/password.*microsoft.*google/s);
    expect(template.user_config.skip_server_lookup.default).toBe(false);
  });

  it("masks every secret, never requires the password and gives secrets no default", () => {
    for (const key of ["password", "oauth_client_secret"]) {
      expect(template.user_config[key]).toMatchObject({ sensitive: true, required: false });
      expect(template.user_config[key].default).toBeUndefined();
    }
  });

  it("passes several attachment folders as arguments (mcpb expands lists only there)", () => {
    expect(template.user_config.attachment_dirs).toMatchObject({ type: "directory", multiple: true, required: false });
    expect(template.user_config.download_dir).toMatchObject({ type: "directory", required: false });
    expect(JSON.stringify(template.server.mcp_config.env)).not.toContain("attachment_dirs");
  });

  it("starts through the preflight shim with Claude Desktop's Node.js", () => {
    expect(template.server).toMatchObject({
      type: "node",
      entry_point: "server/preflight.cjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/preflight.cjs", "serve", "--attachment-dirs", "${user_config.attachment_dirs}"],
      },
    });
  });
});

describe("renderManifest", () => {
  it("stamps the package version and tool list without touching the template", () => {
    const manifest = renderManifest(template, pkg, tools);
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.tools).toEqual(tools);
    expect(template.version).toBe("0.0.0");
  });

  it("rejects a reference to an undeclared field", () => {
    const broken = structuredClone(template);
    broken.server.mcp_config.env.IMAP_MCP_LOCALE = "${user_config.langauge}";
    expect(() => renderManifest(broken, pkg, tools)).toThrow(/undeclared user_config "langauge"/);
  });

  it("rejects a field that is never passed to the server", () => {
    const broken = structuredClone(template);
    broken.user_config.unused = { type: "string", title: "x", description: "x" };
    expect(() => renderManifest(broken, pkg, tools)).toThrow(/"unused" is declared but never passed/);
  });

  it("rejects a default on a sensitive field", () => {
    const broken = structuredClone(template);
    broken.user_config.password.default = "secret";
    expect(() => renderManifest(broken, pkg, tools)).toThrow(/must not have a default/);
  });

  it("rejects an environment variable outside the IMAP_MCP_ namespace", () => {
    const broken = structuredClone(template);
    broken.server.mcp_config.env.NODE_OPTIONS = "--inspect";
    expect(() => renderManifest(broken, pkg, tools)).toThrow(/unexpected environment variable "NODE_OPTIONS"/);
  });

  it("refuses an empty or duplicated tool list", () => {
    expect(() => renderManifest(template, pkg, [])).toThrow(/no tools/);
    expect(() => renderManifest(template, pkg, [...tools, ...tools])).toThrow(/duplicate tool "search_emails"/);
  });

  it("refuses a manifest name that differs from the package", () => {
    expect(() => renderManifest(template, { name: "other", version: "1.0.0" }, tools)).toThrow(/differs/);
  });
});

describe("toolSummaries", () => {
  it("uses the first sentence of each description", () => {
    expect(
      toolSummaries([{ name: "a", description: "Search emails. Combine filters freely." }, { name: "b", title: "Read" }]),
    ).toEqual([
      { name: "a", description: "Search emails." },
      { name: "b", description: "Read" },
    ]);
  });
});

describe("bundle helpers", () => {
  it("finds native binaries that would tie the bundle to one platform", () => {
    expect(
      nativeBinaries(["imapflow/lib/index.js", "keytar/build/Release/keytar.node", "@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node"]),
    ).toEqual(["keytar/build/Release/keytar.node", "@napi-rs/keyring-win32-x64-msvc/keyring.win32-x64-msvc.node"]);
  });

  it("names the bundle after package and version", () => {
    expect(bundleFileName("inbox-warden", "1.0.0")).toBe("inbox-warden-1.0.0.mcpb");
  });
});
