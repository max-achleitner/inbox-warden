import { describe, it, expect } from "vitest";
import { extractReleaseNotes } from "../lib/release-notes.mjs";

const changelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [1.0.0] - 2026-11-02",
  "",
  "### Added",
  "- Claude Desktop extension",
  "",
  "## [1.0.0-rc.1] - 2026-10-30",
  "- Release candidate",
  "",
  "## [0.6.0] - 2026-10-20",
  "- Governance",
  "",
].join("\n");

describe("extractReleaseNotes", () => {
  it("returns the body of exactly the requested version", () => {
    expect(extractReleaseNotes(changelog, "1.0.0")).toBe("### Added\n- Claude Desktop extension");
  });

  it("does not confuse a pre-release with the final version", () => {
    expect(extractReleaseNotes(changelog, "1.0.0-rc.1")).toBe("- Release candidate");
  });

  it("matches the version literally, not as a regular expression", () => {
    expect(() => extractReleaseNotes(changelog, "2.0.0|1.0.0")).toThrow(/no section for 2\.0\.0\|1\.0\.0/);
    expect(() => extractReleaseNotes(changelog, "1.0.(0)")).toThrow(/no section/);
    expect(() => extractReleaseNotes(changelog, "1.0.0\\")).toThrow(/no section/);
  });

  it("refuses to release without notes", () => {
    expect(() => extractReleaseNotes(changelog, "2.0.0")).toThrow(/no section for 2\.0\.0/);
    expect(() => extractReleaseNotes(changelog, "Unreleased")).toThrow(/is empty/);
  });
});
