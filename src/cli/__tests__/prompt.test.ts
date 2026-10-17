import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { applySecretInput, createTerminalPrompter } from "../prompt.js";
import { detectLocale, t } from "../messages.js";

const empty = { value: "", done: false, cancelled: false };

describe("applySecretInput (hidden password entry)", () => {
  it("echoes stars, never the characters", () => {
    const r = applySecretInput(empty, "s3cr3t");
    expect(r.state.value).toBe("s3cr3t");
    expect(r.echo).toBe("******");
  });

  it("handles backspace, Enter and pasted text with a trailing newline", () => {
    let r = applySecretInput(empty, "abc\u007f");
    expect(r.state.value).toBe("ab");
    r = applySecretInput(r.state, "Pässwörd!\r");
    expect(r.state).toEqual({ value: "abPässwörd!", done: true, cancelled: false });
  });

  it("cancels on Ctrl+C and drops what was typed", () => {
    expect(applySecretInput({ ...empty, value: "abc" }, "\u0003").state).toEqual({ value: "", done: false, cancelled: true });
  });

  it("ignores arrow keys", () => {
    expect(applySecretInput({ ...empty, value: "x" }, "\u001b[A").state.value).toBe("x");
  });
});

describe("terminal prompter with piped input", () => {
  it("reads consecutive answers, applies defaults and validation", async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream;
    const output = new PassThrough() as unknown as NodeJS.WriteStream;
    (input as unknown as PassThrough).end("\nnot-a-port\n587\nj\n2\n");
    const p = createTerminalPrompter("de", input, output);
    expect(await p.text("Host", { default: "imap.web.de" })).toBe("imap.web.de");
    expect(await p.text("Port", { validate: (v) => (/^\d+$/.test(v) ? undefined : "Zahl!") })).toBe("587");
    expect(await p.confirm("Weiter?", false)).toBe(true);
    expect(await p.select("Wahl", [{ value: "a", label: "A" }, { value: "b", label: "B" }])).toBe("b");
    p.close();
  });
});

describe("messages", () => {
  it("interpolates and localises", () => {
    expect(t("de", "detected", { name: "GMX" })).toBe("Erkannt: GMX");
    expect(t("en", "detected", { name: "GMX" })).toBe("Detected: GMX");
  });

  it("detects the locale from IMAP_MCP_LANG, then LANG", () => {
    expect(detectLocale({ IMAP_MCP_LANG: "en", LANG: "de_AT.UTF-8" })).toBe("en");
    expect(detectLocale({ LANG: "de_AT.UTF-8" })).toBe("de");
    expect(detectLocale({ LANG: "en_US.UTF-8" })).toBe("en");
  });
});
