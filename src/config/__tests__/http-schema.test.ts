import { describe, it, expect } from "vitest";
import { HttpAuthSchema, HttpSchema, checkHttpDeployment } from "../http-schema.js";

const sha = "a".repeat(64);

describe("HttpSchema", () => {
  it("defaults to loopback, port 8787, no proxy trust, 4 MiB bodies", () => {
    expect(HttpSchema.parse({})).toMatchObject({
      host: "127.0.0.1",
      port: 8787,
      trustProxy: false,
      maxBodyBytes: 4 * 1024 * 1024,
      ipAllowlist: [],
      rateLimit: { perMinute: 120, burst: 30, authFailuresPerMinute: 30 },
    });
  });

  it.each(["https://mail.example.com/mcp", "mail.example.com", "https://mail.example.com?x=1", "ftp://mail.example.com"])(
    "rejects publicUrl %s",
    (publicUrl) => {
      expect(HttpSchema.safeParse({ publicUrl }).success).toBe(false);
    },
  );

  it("accepts an origin with or without trailing slash", () => {
    expect(HttpSchema.parse({ publicUrl: "https://mail.example.com" }).publicUrl).toBe("https://mail.example.com");
    expect(HttpSchema.safeParse({ publicUrl: "https://mail.example.com:8443/" }).success).toBe(true);
  });
});

describe("HttpAuthSchema", () => {
  it("parses bearer mode with hashed tokens only", () => {
    expect(HttpAuthSchema.parse({ mode: "bearer", tokens: [{ id: "laptop", sha256: sha }] })).toEqual({
      mode: "bearer",
      tokens: [{ id: "laptop", sha256: sha }],
      principals: [],
    });
    expect(HttpAuthSchema.safeParse({ mode: "bearer", tokens: [{ id: "laptop", token: "imcp_plain" }] }).success).toBe(false);
  });

  it("normalises a single audience and requires principals in OAuth mode", () => {
    const parsed = HttpAuthSchema.parse({
      mode: "oauth",
      issuer: "https://login.microsoftonline.com/tid/v2.0",
      audience: "api://imap-mcp",
      principals: [{ match: { group: "g-mail" }, accounts: ["office"] }],
    });
    expect(parsed).toMatchObject({ audience: ["api://imap-mcp"], clockToleranceSec: 60, algorithms: ["RS256", "PS256", "ES256"] });
    expect(HttpAuthSchema.safeParse({ mode: "oauth", issuer: "https://idp.example", audience: "x", principals: [] }).success).toBe(false);
  });

  it("rejects an http issuer and an empty match", () => {
    expect(HttpAuthSchema.safeParse({ mode: "oauth", issuer: "http://idp.example", audience: "x", principals: [{ match: { group: "g" }, accounts: ["a"] }] }).success).toBe(false);
    expect(HttpAuthSchema.safeParse({ mode: "bearer", principals: [{ match: {}, accounts: ["a"] }] }).success).toBe(false);
  });
});

describe("checkHttpDeployment", () => {
  const http = (over: Record<string, unknown> = {}) => HttpSchema.parse(over);

  it("refuses to start without authentication, even on loopback", () => {
    expect(checkHttpDeployment({ http: http(), httpAuth: undefined, accountIds: ["main"] }).errors[0]).toMatch(/requires "httpAuth"/);
  });

  it("refuses bearer mode without tokens", () => {
    const httpAuth = HttpAuthSchema.parse({ mode: "bearer" });
    expect(checkHttpDeployment({ http: http(), httpAuth, accountIds: ["main"] }).errors[0]).toMatch(/No bearer tokens/);
  });

  it("requires an https publicUrl for OAuth", () => {
    const httpAuth = HttpAuthSchema.parse({ mode: "oauth", issuer: "https://idp.example", audience: "a", principals: [{ match: { sub: "u" }, accounts: ["main"] }] });
    expect(checkHttpDeployment({ http: http({ host: "0.0.0.0", trustProxy: 1 }), httpAuth, accountIds: ["main"] }).errors.join(" ")).toMatch(/publicUrl/);
    expect(checkHttpDeployment({ http: http({ host: "0.0.0.0", trustProxy: 1, publicUrl: "http://mail.example.com" }), httpAuth, accountIds: ["main"] }).errors.join(" ")).toMatch(/https/);
    expect(checkHttpDeployment({ http: http({ host: "0.0.0.0", trustProxy: 1, publicUrl: "https://mail.example.com" }), httpAuth, accountIds: ["main"] }).errors).toEqual([]);
  });

  it("rejects principal rules for unknown accounts and warns about open bearer tokens", () => {
    const httpAuth = HttpAuthSchema.parse({ mode: "bearer", tokens: [{ id: "a", sha256: sha }], principals: [{ match: { tokenId: "a" }, accounts: ["ghost"] }] });
    expect(checkHttpDeployment({ http: http(), httpAuth, accountIds: ["main", "shop"] }).errors[0]).toMatch(/unknown account "ghost"/);
    const open = HttpAuthSchema.parse({ mode: "bearer", tokens: [{ id: "a", sha256: sha }] });
    expect(checkHttpDeployment({ http: http(), httpAuth: open, accountIds: ["main", "shop"] }).warnings[0]).toMatch(/every mailbox/);
  });

  it("warns that confirm-mode accounts refuse sends from 2025-era HTTP clients", () => {
    const httpAuth = HttpAuthSchema.parse({ mode: "bearer", tokens: [{ id: "a", sha256: sha }] });
    const check = checkHttpDeployment({ http: http(), httpAuth, accountIds: ["main"], confirmSendAccounts: ["main"] });
    expect(check.warnings.join(" ")).toMatch(/"main".*confirm.*2026-07-28/);
    expect(checkHttpDeployment({ http: http(), httpAuth, accountIds: ["main"], confirmSendAccounts: [] }).warnings).toEqual([]);
  });

  it("warns when saved attachments land in a folder every mailbox may attach files from", () => {
    const httpAuth = HttpAuthSchema.parse({
      mode: "bearer",
      tokens: [{ id: "a", sha256: sha }, { id: "b", sha256: sha.replace("a", "b") }],
      principals: [{ match: { tokenId: "a" }, accounts: ["main"] }, { match: { tokenId: "b" }, accounts: ["shop"] }],
    });
    const check = (files: { attachmentDirs: string[]; downloadDir?: string }, accountIds = ["main", "shop"]) =>
      checkHttpDeployment({ http: http(), httpAuth, accountIds, files }).warnings.join(" ");
    expect(check({ attachmentDirs: ["/files"], downloadDir: "/files/eingang" })).toMatch(/downloadDir.*attachmentDirs/);
    expect(check({ attachmentDirs: ["/files/eingang"], downloadDir: "/files/eingang/" })).toMatch(/downloadDir.*attachmentDirs/);
    expect(check({ attachmentDirs: ["/files/angebote"], downloadDir: "/files/eingang" })).not.toMatch(/downloadDir/);
    expect(check({ attachmentDirs: ["/files"], downloadDir: "/files/eingang" }, ["main"])).not.toMatch(/downloadDir/);
  });

  it("requires a Host allowlist when bound to a public interface", () => {
    const httpAuth = HttpAuthSchema.parse({ mode: "bearer", tokens: [{ id: "a", sha256: sha }] });
    expect(checkHttpDeployment({ http: http({ host: "0.0.0.0" }), httpAuth, accountIds: ["main"] }).errors[0]).toMatch(/allowedHosts/);
  });
});
