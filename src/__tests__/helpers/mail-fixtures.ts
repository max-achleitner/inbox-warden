import { readFileSync } from "node:fs";

export type MailFixtureName = "woopayments-newsletter" | "world4you-renewal" | "gmail-reply";

/** Synthetic newsletter/reply fixtures (HTML and text/plain part) from src/__tests__/fixtures/mail. */
export function mailFixture(name: MailFixtureName): { html: string; text: string } {
  const read = (ext: string) => readFileSync(new URL(`../fixtures/mail/${name}.${ext}`, import.meta.url), "utf8");
  return { html: read("html"), text: read("txt") };
}
