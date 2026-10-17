import { describe, it, expect } from "vitest";
import { relativeLinks } from "../lib/links.mjs";

describe("relativeLinks", () => {
  it("returns local targets without anchors and decodes them", () => {
    const markdown = [
      "See [guide](docs/guide/de/README.md#start) and [privacy](PRIVACY.md 'title').",
      "[web](https://example.com) [anchor](#top) [mail](mailto:a@example.com)",
      "[Umlaut](docs/Gr%C3%B6%C3%9Fe.md)",
    ].join("\n");
    expect(relativeLinks(markdown)).toEqual(["docs/guide/de/README.md", "PRIVACY.md", "docs/Größe.md"]);
  });

  it("ignores links inside code", () => {
    const markdown = "`[x](inline/code.md)`\n```\n[y](fenced/code.md)\n```\n[z](real.md)";
    expect(relativeLinks(markdown)).toEqual(["real.md"]);
  });
});
