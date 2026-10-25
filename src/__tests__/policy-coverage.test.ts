import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tools");

function toolSources(): Array<{ file: string; source: string }> {
  const out: Array<{ file: string; source: string }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
      } else if (entry.name.endsWith(".ts")) {
        out.push({ file: path.relative(TOOLS_DIR, full).replace(/\\/g, "/"), source: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(TOOLS_DIR);
  return out;
}

/** Tool files that match `uses` but not `requires` (minus exemptions). */
function offenders(uses: RegExp, requires: RegExp, exempt: string[] = []): string[] {
  return toolSources()
    .filter(({ file, source }) => uses.test(source) && !requires.test(source) && !exempt.includes(file))
    .map(({ file }) => file);
}

describe("policy coverage of tool sources", () => {
  it("no tool resolves folders without the account policy", () => {
    expect(toolSources().filter(({ source }) => /\bresolveFolder\(|\bmatchFolder\(/.test(source)).map(({ file }) => file)).toEqual([]);
  });

  it("no tool parses mail without parseMail", () => {
    expect(toolSources().filter(({ source }) => /\bsimpleParser\(/.test(source)).map(({ file }) => file)).toEqual([]);
  });

  it("every tool that enumerates folders applies the folder policy", () => {
    expect(offenders(/\blistTree\(|\blistFolderInfo\(/, /\bvisibleFolders\(|\bfolderAllowed\(|\bresolvePolicyFolder\(/)).toEqual([]);
  });

  it("every tool that reads folder status applies the folder policy", () => {
    expect(offenders(/\bstrictStatus\(|\.status\(/, /\bresolvePolicyFolder\(|\bfolderAllowed\(/)).toEqual([]);
  });

  it("get_thread only searches folders the policy allows", () => {
    expect(offenders(/name: "get_thread"/, /\bfolderAllowed\(/)).toEqual([]);
  });

  it("every bulk mutation checks the policy cap", () => {
    // send-draft.ts only removes the one draft it just sent; organize-by-filter.ts mutates only inside commitBulk (next rule)
    expect(
      offenders(/\bstrictMove\(|\bstrictStoreFlags\(|\bsafeExpunge\(/, /\.checkBulk\(/, ["send-draft.ts", "organize-by-filter.ts"]),
    ).toEqual([]);
  });

  it("filter-based bulk operations are capped in previewBulk and commitBulk", () => {
    const run = fs.readFileSync(path.join(TOOLS_DIR, "..", "bulk", "run.ts"), "utf8");
    expect(run.match(/\.checkBulk\(/g)).toHaveLength(2);
  });

  it("folder rename/delete checks protected folders, folder creation checks the scope", () => {
    expect(offenders(/\bmailboxRename\(|\bmailboxDelete\(/, /\.checkProtectedFolder\(/)).toEqual([]);
    expect(offenders(/\bmailboxCreate\(|\bmailboxRename\(/, /\.checkFolder\(/)).toEqual([]);
  });

  it("attachment downloads and saves check the attachment policy", () => {
    const attachmentTools = toolSources().filter(({ file }) => file === "download-attachment.ts" || file === "save-attachment.ts");
    expect(attachmentTools.length).toBeGreaterThan(0);
    for (const { file, source } of attachmentTools) expect(source, file).toMatch(/\.checkAttachment\(/);
  });

  it("every tool that sends mail passes the outbound guard", () => {
    expect(offenders(/\bdeliver\(/, /\bguardOutbound\(/)).toEqual([]);
  });

  it("every send reserves its rate-limit slot before SMTP (atomic, nothing to fail after a send)", () => {
    expect(offenders(/\bdeliver\(/, /\.reserveSend\(/)).toEqual([]);
  });

  it("every tool that asks for a quota resolves the folder through the policy", () => {
    expect(offenders(/\.getQuota\(/, /\bresolvePolicyFolder\(/)).toEqual([]);
  });

  it("no tool deletes mail permanently (deleting only moves it into Trash)", () => {
    const users = (uses: RegExp) => toolSources().filter(({ source }) => uses.test(source)).map(({ file }) => file);
    // send-draft.ts removes only the draft it has just sent; strictMove's MOVE fallback lives in src/imap/strict.ts
    expect(users(/\bsafeExpunge\(/)).toEqual(["send-draft.ts"]);
    expect(users(/\.messageDelete\(|\.mailboxClose\(|\.messageFlagsSet\(/)).toEqual([]);
    // imapflow deselects with CLOSE (an implicit expunge) before RENAME/DELETE on servers without UNSELECT
    expect(offenders(/\bmailboxRename\(|\bmailboxDelete\(/, /\bwithoutImplicitExpunge\(/)).toEqual([]);
  });

  it("every move checks whether it goes into Trash (that is a delete)", () => {
    // delete-email.ts is the delete tier itself; send-draft.ts moves only the draft it has just sent
    expect(offenders(/\bstrictMove\(/, /\bmovesIntoTrash\(/, ["delete-email.ts", "send-draft.ts"])).toEqual([]);
  });

  it("every tool that scans for injection records the risk for the policy", () => {
    expect(offenders(/\bscanForInjection\(|\bscanSubjectOnly\(/, /injectionRisk/)).toEqual([]);
  });

  it("every tool that returns mail content feeds the provenance store", () => {
    // send-draft.ts and save-attachment.ts return no mail content to the AI
    expect(offenders(/\bdownloadMessage\(|\bpreviewFor\(|\bsummarizeSenders\(/, /\.noteSeen\(/, ["send-draft.ts", "save-attachment.ts"])).toEqual([]);
    expect(fs.readFileSync(path.join(TOOLS_DIR, "..", "bulk", "run.ts"), "utf8")).toMatch(/\.noteSeen\(/);
  });

  describe("Gmail label lock: a message with a hidden label is not reachable on any path", () => {
    const source = (file: string) => fs.readFileSync(path.join(TOOLS_DIR, "..", file), "utf8");

    it("every tool that reads or changes messages by UID or filter passes the account's message scope", () => {
      // downloadMessage, existingUids and selectByFilter take the scope as a required parameter
      expect(offenders(/\bdownloadMessage\(|\bexistingUids\(|\bselectByFilter\(/, /\.messageScope\(/)).toEqual([]);
      expect(offenders(/\bpreviewBulk\(|\bcommitBulk\(/, /\bfolders\b/)).toEqual([]);
    });

    it("no tool reads message data around the scoped helpers", () => {
      const users = (uses: RegExp) => toolSources().filter(({ source }) => uses.test(source)).map(({ file }) => file);
      expect(users(/\.download\(|\.downloadMany\(|\.fetchAll\(/)).toEqual([]);
      // search_emails fetches only the UIDs selectByFilter returned; get_thread only those visibleUids returned
      expect(offenders(/\.fetch\(|\.fetchOne\(/, /\bselectByFilter\(|\bvisibleUids\(/)).toEqual([]);
      expect(offenders(/\bstrictSearch\(/, /\bvisibleUids\(/)).toEqual([]);
    });

    it("the bulk runner, the new-recipient check and the answered marker use the scope", () => {
      expect(source("bulk/run.ts").match(/\.messageScope\(/g)).toHaveLength(2);
      expect(source("policy/outbound.ts")).toMatch(/visibleUids\(client, hits/);
      expect(source("policy/outbound.ts")).toMatch(/findNewRecipients\(await inv\.account\.getClient\(\), recipients, policy\.messageScope\(\)[,)]/);
      expect(source("policy/outbound.ts")).toMatch(/findNewRecipients\(client, unknown, policy\.messageScope\(\)[,)]/);
      expect(source("mail/answered.ts")).toMatch(/visibleUids\(client, await strictSearch/);
    });

    it("counts do not come from STATUS alone where labels hide messages", () => {
      expect(offenders(/\bstrictStatus\(/, /\blabelLockApplies\(/)).toEqual([]);
    });
  });
});

describe("server start-up", () => {
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

  it("both servers load their configuration with loadServeConfig, so the form's limits apply", () => {
    for (const file of ["serve.ts", "cli/serve-http.ts"]) {
      const source = fs.readFileSync(path.join(SRC, file), "utf8");
      expect(source, file).toMatch(/\bloadServeConfig\(/);
      expect(source, file).not.toMatch(/\bloadConfig\(/);
    }
  });
});
