import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { bundleFileName, nativeBinaries, renderManifest, toolSummaries } from "../lib/mcpb.mjs";

const template = JSON.parse(readFileSync(new URL("../../mcpb/manifest.json", import.meta.url), "utf8"));
const pkg = { name: "inbox-warden", version: "1.2.3" };
const tools = [{ name: "search_emails", description: "Search emails." }];

const D5_KEYS = [
  "email", "password", "display_name", "allow_send", "allow_delete", "locked_folders",
  "attachment_dirs", "download_dir", "imap_host", "smtp_host", "username", "skip_server_lookup",
];
const D5_TITLES = [
  "Email address (leave empty for mailboxes from setup)",
  "Password (Gmail: app password)",
  "Your name (optional)",
  "Claude may send email",
  "Claude may move email to Trash",
  "Locked folders (comma-separated)",
  "Attachment folders (optional)",
  "Download folder (optional)",
  "Advanced: incoming server (IMAP)",
  "Advanced: outgoing server (SMTP)",
  "Advanced: login name, if different",
  "Advanced: don't look up servers online",
];

describe("mcpb/manifest.json", () => {
  it("passes configuration only through the agreed env-only variables", () => {
    expect(Object.keys(template.server.mcp_config.env).sort()).toEqual([
      "IMAP_MCP_ALLOW_DELETE",
      "IMAP_MCP_ALLOW_SEND",
      "IMAP_MCP_DENY_FOLDERS",
      "IMAP_MCP_DISPLAY_NAME",
      "IMAP_MCP_DOWNLOAD_DIR",
      "IMAP_MCP_EMAIL",
      "IMAP_MCP_IMAP_HOST",
      "IMAP_MCP_NO_AUTOCONFIG",
      "IMAP_MCP_PASSWORD",
      "IMAP_MCP_SMTP_HOST",
      "IMAP_MCP_USERNAME",
    ]);
  });

  it("ships safe defaults: Claude drafts, the human sends; nothing is deleted", () => {
    for (const key of ["allow_send", "allow_delete", "skip_server_lookup"]) {
      expect(template.user_config[key]).toMatchObject({ type: "boolean", default: false });
    }
  });

  it("asks only for what most people need, in this order", () => {
    expect(Object.keys(template.user_config)).toEqual(D5_KEYS);
  });

  it("titles explain themselves (Claude Code shows titles only)", () => {
    expect(Object.values(template.user_config).map((field) => field.title)).toEqual(D5_TITLES);
    for (const field of Object.values(template.user_config)) expect(field.title).not.toContain("/");
  });

  it("leaves the address optional: empty means the mailboxes set up with the command-line version", () => {
    expect(template.user_config.email).toMatchObject({ type: "string", required: false });
    expect(template.user_config.email.default).toBeUndefined();
    expect(template.user_config.email.description).toMatch(/[Ll]eave it empty.*inbox-warden setup.*switches set the most Claude may do in any mailbox.*own setting.*locked in every mailbox/s);
    expect(template.long_description).toMatch(/[Ss]everal mailboxes.*leave the email address empty/s);
  });

  it("passes the switches, not the old choice fields", () => {
    const env = template.server.mcp_config.env;
    expect(env.IMAP_MCP_ALLOW_SEND).toBe("${user_config.allow_send}");
    expect(env.IMAP_MCP_ALLOW_DELETE).toBe("${user_config.allow_delete}");
    for (const dropped of [
      "IMAP_MCP_AUTH", "IMAP_MCP_OAUTH_CLIENT_ID", "IMAP_MCP_OAUTH_TENANT", "IMAP_MCP_OAUTH_CLIENT_SECRET",
      "IMAP_MCP_IMAP_PORT", "IMAP_MCP_SMTP_PORT", "IMAP_MCP_PERMISSIONS", "IMAP_MCP_SEND_MODE", "IMAP_MCP_LOCALE", "IMAP_MCP_LANG",
    ]) {
      expect(env).not.toHaveProperty(dropped);
    }
  });

  it("carries an icon", () => {
    expect(template.icon).toBe("icon.png");
    const png = readFileSync(new URL("../../mcpb/icon.png", import.meta.url));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
  });

  it("masks the password, never requires it and gives it no default", () => {
    expect(template.user_config.password).toMatchObject({ sensitive: true, required: false });
    expect(template.user_config.password.default).toBeUndefined();
  });

  it("lets the user lock folders away from Claude; empty locks nothing", () => {
    expect(template.user_config.locked_folders).toMatchObject({ type: "string", required: false });
    expect(template.user_config.locked_folders.sensitive).toBeUndefined();
    // Like the other optional fields: no default, so an empty field arrives as the placeholder that applyBundleEnv drops
    expect(template.user_config.locked_folders.default).toBeUndefined();
    expect(template.user_config.locked_folders.description).toMatch(/commas.*[Ss]ubfolders.*_NDA_\*/s);
    expect(template.server.mcp_config.env.IMAP_MCP_DENY_FOLDERS).toBe("${user_config.locked_folders}");
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
    broken.server.mcp_config.env.IMAP_MCP_DOWNLOAD_DIR = "${user_config.langauge}";
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
