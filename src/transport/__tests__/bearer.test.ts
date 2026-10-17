import { describe, it, expect } from "vitest";
import { generateBearerToken, hashToken, matchBearerToken, parseBearerHeader } from "../auth/bearer.js";

describe("bearer tokens", () => {
  it("generates a prefixed 256-bit token and returns only its hash for storage", () => {
    const { token, sha256 } = generateBearerToken();
    expect(token).toMatch(/^imcp_[A-Za-z0-9_-]{43}$/);
    expect(sha256).toBe(hashToken(token));
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the presented token against stored hashes", () => {
    const a = generateBearerToken();
    const b = generateBearerToken();
    const entries = [
      { id: "laptop", sha256: a.sha256 },
      { id: "routine", sha256: b.sha256 },
    ];
    expect(matchBearerToken(b.token, entries)).toBe("routine");
    expect(matchBearerToken("imcp_wrong", entries)).toBeNull();
  });

  it("ignores malformed stored hashes instead of throwing", () => {
    expect(matchBearerToken("x", [{ id: "bad", sha256: "abc" }])).toBeNull();
  });

  it.each([
    ["Bearer imcp_abc", "imcp_abc"],
    ["bearer   imcp_abc", "imcp_abc"],
    ["Basic dXNlcjpwYXNz", null],
    ["Bearer", null],
    ["Bearer a b", null],
    [null, null],
  ])("parses %s", (header, expected) => {
    expect(parseBearerHeader(header)).toBe(expected);
  });
});
