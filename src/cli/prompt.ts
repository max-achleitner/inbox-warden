import * as readline from "node:readline";
import type { Locale } from "./messages.js";

export interface Choice<T extends string> {
  value: T;
  label: string;
}

export interface Prompter {
  text(question: string, opts?: { default?: string; validate?: (value: string) => string | undefined }): Promise<string>;
  secret(question: string): Promise<string>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  select<T extends string>(question: string, choices: Choice<T>[], defaultValue?: T): Promise<T>;
  print(line?: string): void;
  close(): void;
}

export class PromptCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "PromptCancelledError";
  }
}

export interface SecretInputState {
  value: string;
  done: boolean;
  cancelled: boolean;
}

/**
 * Keystroke handling for hidden input (pure, so it can be tested without a terminal).
 * Each typed character is echoed as "*"; Backspace removes one; Enter finishes; Ctrl+C cancels;
 * escape sequences (arrow keys) are ignored.
 */
export function applySecretInput(state: SecretInputState, chunk: string): { state: SecretInputState; echo: string } {
  if (chunk.startsWith("\u001b")) return { state, echo: "" };
  let value = state.value;
  let echo = "";
  for (const ch of chunk) {
    if (ch === "\r" || ch === "\n") return { state: { value, done: true, cancelled: false }, echo: echo + "\n" };
    if (ch === "\u0003") return { state: { value: "", done: false, cancelled: true }, echo: echo + "\n" };
    if (ch === "\u007f" || ch === "\b") {
      if (value.length > 0) {
        value = Array.from(value).slice(0, -1).join("");
        echo += "\b \b";
      }
      continue;
    }
    if (ch < " ") continue;
    value += ch;
    echo += "*";
  }
  return { state: { value, done: false, cancelled: false }, echo };
}

const YES = new Set(["y", "yes", "j", "ja"]);
const NO = new Set(["n", "no", "nein"]);

export function createTerminalPrompter(
  locale: Locale,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Prompter {
  const interactive = input.isTTY === true;
  let shared: readline.Interface | undefined;
  let lines: AsyncIterator<string> | undefined;

  async function line(question: string): Promise<string> {
    if (!interactive) {
      // Piped input (scripts, CI): one shared reader so buffered lines are not lost.
      output.write(question);
      shared ??= readline.createInterface({ input, terminal: false });
      lines ??= shared[Symbol.asyncIterator]();
      const next = await lines.next();
      output.write("\n");
      if (next.done) throw new PromptCancelledError();
      return next.value;
    }
    const rl = readline.createInterface({ input, output, terminal: true });
    try {
      return await new Promise<string>((resolve, reject) => {
        rl.once("SIGINT", () => reject(new PromptCancelledError()));
        rl.question(question, resolve);
      });
    } finally {
      rl.close();
    }
  }

  async function hidden(question: string): Promise<string> {
    if (!interactive) return line(question);
    output.write(question);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    return new Promise<string>((resolve, reject) => {
      let state: SecretInputState = { value: "", done: false, cancelled: false };
      const onData = (chunk: string) => {
        const next = applySecretInput(state, chunk);
        state = next.state;
        output.write(next.echo);
        if (!state.done && !state.cancelled) return;
        input.off("data", onData);
        input.setRawMode(false);
        input.pause();
        if (state.cancelled) reject(new PromptCancelledError());
        else resolve(state.value);
      };
      input.on("data", onData);
    });
  }

  return {
    async text(question, opts = {}) {
      for (;;) {
        const suffix = opts.default ? ` [${opts.default}]` : "";
        const answer = (await line(`${question}${suffix}: `)).trim() || opts.default || "";
        const problem = opts.validate?.(answer);
        if (!problem) return answer;
        output.write(`  ${problem}\n`);
      }
    },
    secret: (question) => hidden(`${question}: `),
    async confirm(question, defaultValue) {
      const hint = locale === "de" ? (defaultValue ? "J/n" : "j/N") : defaultValue ? "Y/n" : "y/N";
      for (;;) {
        const answer = (await line(`${question} (${hint}): `)).trim().toLowerCase();
        if (answer === "") return defaultValue;
        if (YES.has(answer)) return true;
        if (NO.has(answer)) return false;
      }
    },
    async select(question, choices, defaultValue) {
      output.write(`${question}\n`);
      choices.forEach((c, i) => output.write(`  ${i + 1}) ${c.label}\n`));
      const defaultIndex = Math.max(0, choices.findIndex((c) => c.value === defaultValue));
      for (;;) {
        const answer = (await line(`> [${defaultIndex + 1}] `)).trim();
        if (answer === "") return choices[defaultIndex].value;
        const n = Number(answer);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
      }
    },
    print: (text = "") => output.write(`${text}\n`),
    close: () => shared?.close(),
  };
}
