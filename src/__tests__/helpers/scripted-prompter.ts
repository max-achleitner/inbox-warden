import type { Choice, Prompter } from "../../cli/prompt.js";

/**
 * Prompter that answers from a script. "" means "accept the default".
 * `asked` records every question so tests can assert the dialogue.
 */
export function scriptedPrompter(answers: Array<string | boolean>): Prompter & { output: string[]; asked: string[] } {
  const queue = [...answers];
  const output: string[] = [];
  const asked: string[] = [];
  const next = (question: string) => {
    asked.push(question);
    if (queue.length === 0) throw new Error(`Scripted prompter ran out of answers at: ${question}`);
    return queue.shift()!;
  };
  return {
    output,
    asked,
    async text(question, opts = {}) {
      const answer = String(next(question)) || opts.default || "";
      const problem = opts.validate?.(answer);
      if (problem) throw new Error(`Scripted answer "${answer}" rejected for "${question}": ${problem}`);
      return answer;
    },
    async secret(question) {
      return String(next(question));
    },
    async confirm(question, defaultValue) {
      const answer = next(question);
      return answer === "" ? defaultValue : Boolean(answer);
    },
    async select<T extends string>(question: string, choices: Choice<T>[], defaultValue?: T): Promise<T> {
      const answer = String(next(question)) || defaultValue || choices[0].value;
      const hit = choices.find((c) => c.value === answer);
      if (!hit) throw new Error(`Scripted answer "${answer}" is not a choice of "${question}"`);
      return hit.value;
    },
    print: (line = "") => output.push(line),
    close: () => {},
  };
}
