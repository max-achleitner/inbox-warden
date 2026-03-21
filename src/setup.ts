import * as readline from "node:readline";
import { saveCredentials, loadCredentials, credentialsExist, DEFAULT_PERMISSIONS } from "./credentials.js";
import type { Credentials, Permissions } from "./credentials.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function parsePort(value: string): number {
  const port = parseInt(value, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port number: "${value}". Must be between 1 and 65535.`);
  }
  return port;
}

function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

async function main() {
  console.log("\n=== IMAP MCP Server Setup ===\n");

  let defaults: Partial<Credentials> = {};
  if (credentialsExist()) {
    console.log("Existing configuration found. Press Enter to keep current values.\n");
    try {
      defaults = loadCredentials();
    } catch {
      // ignore
    }
  }

  const user = await ask("Email address", defaults.user);
  const imapHost = await ask("IMAP server", defaults.imapHost);
  const imapPort = parsePort(await ask("IMAP port", String(defaults.imapPort || 993)));
  const smtpHost = await ask("SMTP server", defaults.smtpHost);
  const smtpPort = parsePort(await ask("SMTP port", String(defaults.smtpPort || 465)));
  const password = await ask("Password");

  // Permissions
  console.log("\n--- Permissions ---");
  console.log("Control what the MCP server is allowed to do.");
  console.log("  read  = list/search/read emails (default: yes)");
  console.log("  write = mark read, move, draft, manage folders (default: yes)");
  console.log("  send  = send emails via SMTP (default: no)");
  console.log("  delete = permanently delete emails (default: no)\n");

  const existingPerms = defaults.permissions || DEFAULT_PERMISSIONS;

  async function askBool(question: string, defaultVal: boolean): Promise<boolean> {
    const answer = await ask(question, defaultVal ? "yes" : "no");
    return answer.toLowerCase().startsWith("y");
  }

  const permissions: Permissions = {
    read: await askBool("Enable read?", existingPerms.read),
    write: await askBool("Enable write?", existingPerms.write),
    send: await askBool("Enable send?", existingPerms.send),
    delete: await askBool("Enable delete?", existingPerms.delete),
  };

  saveCredentials({
    user,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
    password: password || defaults.password || "",
    permissions,
  });

  console.log("\nCredentials saved to ~/.imap-mcp/credentials.json");
  console.log(`Permissions: read=${permissions.read}, write=${permissions.write}, send=${permissions.send}, delete=${permissions.delete}`);
  console.log("You can now start the server with: npm start\n");

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
