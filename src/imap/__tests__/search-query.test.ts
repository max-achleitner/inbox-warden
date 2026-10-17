import { describe, it, expect } from "vitest";
import { z } from "zod";
import { UnsupportedFilterError, compileSearch, searchFilterShape } from "../search-query.js";

const mailbox = (permanent: string[]) =>
  ({ permanentFlags: new Set(permanent), flags: new Set<string>() }) as any;

describe("compileSearch", () => {
  it("returns { all: true } only when no filter is given", () => {
    expect(compileSearch({}, mailbox(["\\*"])).query).toEqual({ all: true });
  });

  it("echoes every applied filter", () => {
    const compiled = compileSearch({ from: "anna@example.com", since: "2026-01-01", unread: true }, mailbox(["\\*"]));
    expect(compiled.query).toEqual({ from: "anna@example.com", since: "2026-01-01", seen: false });
    expect(compiled.applied).toEqual({ from: "anna@example.com", since: "2026-01-01", unread: true });
  });

  it("refuses a keyword the folder cannot store instead of silently dropping it", () => {
    expect(() => compileSearch({ keyword: "$Done" }, mailbox(["\\Seen", "\\Flagged"]))).toThrow(UnsupportedFilterError);
  });

  it("rejects an inverted date range", () => {
    expect(() => compileSearch({ since: "2026-03-01", before: "2026-01-01" }, mailbox(["\\*"]))).toThrow(/earlier/);
  });

  it("keeps hasAttachment=false for client-side filtering", () => {
    expect(compileSearch({ hasAttachment: false }, mailbox(["\\*"])).hasAttachment).toBe(false);
  });
});

describe("searchFilterShape date validation", () => {
  const schema = z.object(searchFilterShape);
  it.each(["last week", "2026-02-30", "14.10.2026", "2026-1-5"])("rejects %s", (value) => {
    expect(schema.safeParse({ since: value }).success).toBe(false);
  });
  it("accepts a real date", () => {
    expect(schema.safeParse({ since: "2026-02-28" }).success).toBe(true);
  });
});

describe("searchFilterShape header filter", () => {
  const schema = z.object(searchFilterShape);
  it("rejects empty header names and values, which would match every message carrying the header", () => {
    expect(schema.safeParse({ header: { From: "" } }).success).toBe(false);
    expect(schema.safeParse({ header: { "": "x" } }).success).toBe(false);
    expect(schema.safeParse({ header: { "List-Id": "newsletter" } }).success).toBe(true);
  });
});
