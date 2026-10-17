import { describe, it, expect } from "vitest";
import { mintConfirmationState, operationDigest, redeemConfirmationState, verifyConfirmationState } from "../confirm-state.js";
import { CONFIRM_KEY, requireConfirmation } from "../confirm.js";

describe("confirmation state", () => {
  const digest = operationDigest({ to: ["a@example.com"], subject: "Angebot" });

  it("is stable for the same operation regardless of key order", () => {
    expect(operationDigest({ subject: "Angebot", to: ["a@example.com"] })).toBe(digest);
  });

  it("verifies for the same digest", () => {
    expect(verifyConfirmationState(mintConfirmationState(digest), digest)).toBe(true);
  });

  it("rejects a different operation", () => {
    const other = operationDigest({ to: ["evil@example.com"], subject: "Angebot" });
    expect(verifyConfirmationState(mintConfirmationState(digest), other)).toBe(false);
  });

  it("rejects tampering and expiry", () => {
    const state = mintConfirmationState(digest, 0);
    const [payload, mac] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ d: digest, e: Number.MAX_SAFE_INTEGER })).toString("base64url");
    expect(verifyConfirmationState(`${forged}.${mac}`, digest, 1)).toBe(false);
    expect(verifyConfirmationState(`${payload}.${mac}`, digest, 16 * 60 * 1000)).toBe(false);
    expect(verifyConfirmationState("garbage", digest)).toBe(false);
  });

  it("redeems a confirmation only once", () => {
    const state = mintConfirmationState(digest);
    expect(redeemConfirmationState(state, digest)).toBe(true);
    expect(redeemConfirmationState(state, digest)).toBe(false);
  });

  it("does not use up a confirmation on a mismatching operation", () => {
    const state = mintConfirmationState(digest);
    expect(redeemConfirmationState(state, operationDigest({ to: ["evil@example.com"] }))).toBe(false);
    expect(redeemConfirmationState(state, digest)).toBe(true);
  });

  it("refuses a retried request that replays an accepted confirmation", () => {
    const state = mintConfirmationState(digest);
    const inv = {
      sdk: {
        mcpReq: {
          inputResponses: { [CONFIRM_KEY]: { action: "accept", content: { confirm: true } } },
          requestState: () => state,
        },
      } as never,
      clientCapabilities: () => ({ elicitation: { form: {} } }),
    };
    const request = { message: "Send?", digest, required: true };
    expect(requireConfirmation(inv, request).status).toBe("confirmed");
    const replay = requireConfirmation(inv, request);
    expect(replay.status).toBe("refused");
  });
});
