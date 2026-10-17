import { describe, it, expect } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { markOriginalAnswered } from "../answered.js";

describe("markOriginalAnswered", () => {
  it("flags the original found by Message-ID", async () => {
    const imap = new FakeImap();
    imap.addFolder("Kunden");
    imap.addMessage("Kunden", await buildRaw({ from: "k@x.com", to: "me@x.com", subject: "q", text: "?", messageId: "<q-1@x.com>" }));
    expect(await markOriginalAnswered(imap.asClient(), "<q-1@x.com>", ["INBOX", "Kunden"])).toEqual({ folder: "Kunden", uid: 1 });
    expect(imap.message("Kunden", 1)!.flags.has("\\Answered")).toBe(true);
  });

  it("returns false when nothing matches or there is no In-Reply-To", async () => {
    const imap = new FakeImap();
    expect(await markOriginalAnswered(imap.asClient(), "<nope@x.com>", ["INBOX", "Missing"])).toBe(false);
    expect(await markOriginalAnswered(imap.asClient(), undefined, ["INBOX"])).toBe(false);
  });
});
