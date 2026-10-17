import { describe, it, expect } from "vitest";
import { FakeImap } from "../../__tests__/helpers/fake-imap.js";
import { buildRaw } from "../../__tests__/helpers/messages.js";
import { threadIds, threadQuery } from "../thread.js";

describe("threadIds", () => {
  it("collects ancestors without the message itself", () => {
    expect(threadIds({ messageId: "<c@x>", inReplyTo: "<b@x>", references: ["<a@x>", "<b@x>"] })).toEqual({
      own: "<c@x>",
      ancestors: ["<a@x>", "<b@x>"],
      root: "<a@x>",
    });
  });

  it("accepts a space-separated References string", () => {
    expect(threadIds({ messageId: "<c@x>", references: "<a@x> <b@x>" }).ancestors).toEqual(["<a@x>", "<b@x>"]);
  });

  it("returns a null query for a message without any IDs", () => {
    expect(threadQuery(threadIds({}))).toBeNull();
  });
});

describe("threadQuery against FakeImap", () => {
  it("finds ancestors and replies in a folder, but not unrelated mail", async () => {
    const imap = new FakeImap();
    imap.addMessage("INBOX", await buildRaw({ from: "k@x.com", to: "me@x.com", subject: "A", text: "a", messageId: "<a@x>" }));
    imap.addMessage(
      "INBOX",
      await buildRaw({ from: "k@x.com", to: "me@x.com", subject: "Re: A", text: "c", messageId: "<c@x>", inReplyTo: "<b@x>", references: ["<a@x>", "<b@x>"] }),
    );
    imap.addMessage("INBOX", await buildRaw({ from: "z@x.com", to: "me@x.com", subject: "other", text: "z", messageId: "<z@x>" }));
    imap.addMessage(
      "INBOX",
      await buildRaw({ from: "k@x.com", to: "me@x.com", subject: "Re: A", text: "d", messageId: "<d@x>", inReplyTo: "<c@x>", references: ["<a@x>", "<b@x>", "<c@x>"] }),
    );
    await imap.getMailboxLock("INBOX");
    const query = threadQuery(threadIds({ messageId: "<c@x>", inReplyTo: "<b@x>", references: ["<a@x>", "<b@x>"] }))!;
    expect(await imap.asClient().search(query, { uid: true })).toEqual([1, 2, 4]);
  });
});
