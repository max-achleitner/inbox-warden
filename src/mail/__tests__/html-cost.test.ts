import { describe, it, expect } from "vitest";
import { Parser } from "htmlparser2";
import { htmlParseCost, MAX_PARSE_WORK, rawTextElement, type HtmlParseCost, type TreeWatch } from "../html-cost.js";
import { nestedNewsletter } from "../../__tests__/helpers/newsletter.js";

/**
 * What htmlparser2 really spends on its open-element stacks, counted in the estimator's units: every `unshift` costs the
 * length it moves, every `indexOf` the elements it compares (a name of the same length per character). Reads its
 * internals, so an htmlparser2 update that changes how it builds the tree fails here instead of slipping past the gate.
 */
function measured(html: string): HtmlParseCost {
  let work = 0;
  let depth = 0;
  const parser = new Parser({});
  const { stack, foreignContext } = parser as unknown as { stack: string[]; foreignContext: boolean[] };
  stack.unshift = function (this: string[], ...items: string[]) {
    work += this.length;
    const length = Array.prototype.unshift.apply(this, items);
    depth = Math.max(depth, length);
    return length;
  };
  stack.indexOf = function (this: string[], name: string) {
    const index = Array.prototype.indexOf.call(this, name);
    const compared = index < 0 ? this.length : index + 1;
    for (let k = 0; k < compared; k++) work += this[k]!.length === name.length ? name.length : 1;
    return index;
  };
  foreignContext.unshift = function (this: boolean[], ...items: boolean[]) {
    work += this.length;
    return Array.prototype.unshift.apply(this, items);
  };
  parser.end(html);
  return { depth, work };
}

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "<div>", "</div>", "<DIV>", "</Div >", "<b>", "</b>", "<p>", "</p>", "<p/>", "<span>", "</span>", "<br>", "</br>", "<img/>",
  "</img>", "<li>", "</li>", "<ul>", "<dt>", "<dd>", "<tr>", "<td>", "<th>", "</td>", "<table>", "</table>", "<tbody>", "<thead>",
  "<tfoot>", "<option>", "<optgroup>", "<select>", "<input>", "<rp>", "<rt>", "<h1>", "<body>", "<head>", "<svg>", "</svg>",
  "<svg/>", "<math>", "</math>", "<path/>", "<g/>", "<g>", "<mi>", "</mi>", "<desc>", "</desc>", "<foreignObject>",
  "</foreignobject>", "<annotation-xml>", "<title>", "</title>", "<TITLE>", "<script>", "</script>", "</SCRIPT>", "<script/>",
  "<style>", "</style>", "<textarea>", "</textarea>", "<xmp>", "</xmp>", "<tmp>", "<xitle>", "</scriptx>", "</script ",
  "\u{1C}\u{0F}script>", "\u{1C}/style>", "<!--", "-->", "--!>", "<!-->", "<!->", "<!>", "<![CDATA[", "]]>", "<!DOCTYPE html>",
  "<?xml?>", "<?", "</ >", "</>", "</ div>", "</1>", "<", ">", "/", "/>", "=", '"', "'", " ", "\n", "a", "x", "&amp;", "&", "&lt",
  '<a href="x>y">', "<a href=x/>", "<a b/>", "<a b = 'c'/>", "<div / >", "<div//>", "<i\u{130}>", "</i\u{130}>", "<a<b>", "</a/>",
];

describe("htmlParseCost", () => {
  it("counts a stray closing tag at the full depth, as htmlparser2 searches its whole stack", () => {
    // opens at depths 0..3, strays at depths 1..4
    expect(htmlParseCost("<div></b>".repeat(4))).toEqual({ depth: 4, work: 0 + 1 + 2 + 3 + (1 + 2 + 3 + 4) });
    expect(htmlParseCost("<div></b>".repeat(2_000)).work).toBeGreaterThan(2_000 * 1_999);
  });

  it("counts an unmatched </p> twice: htmlparser2 also opens and closes an empty paragraph there", () => {
    expect(htmlParseCost("<div><div></p>")).toEqual({ depth: 3, work: 0 + 1 + 2 + 2 });
  });

  it("keeps matched closing tags cheap", () => {
    // comparing "div" with "div" counts its 3 characters
    expect(htmlParseCost("<div></div>".repeat(1_000))).toEqual({ depth: 1, work: 3_000 });
    // </div> compares b and span in one step each, then div
    expect(htmlParseCost("<div><span><b>x</div>")).toEqual({ depth: 3, work: 0 + 1 + 2 + (1 + 1 + 3) });
  });

  it("counts names of the same length by their characters, as indexOf compares them character by character", () => {
    const a = "a".repeat(64);
    const b = "a".repeat(63) + "b";
    expect(htmlParseCost(`<${a}><${a}><div></${b}>`).work).toBe(0 + 1 + 2 + (3 + 2 * 63));
    // a name of another length is told apart at once
    expect(htmlParseCost(`<${a}><${a}><div></q>`).work).toBe(0 + 1 + 2 + 3);
  });

  it("matches tag names case-insensitively", () => {
    expect(htmlParseCost("<DIV><Div><div></dIV></DIV></div>").work).toBe(0 + 1 + 2 + 3 * 3);
  });

  it("never nests void elements", () => {
    expect(htmlParseCost("<br><img src=x><hr><input><meta><link>".repeat(1_000))).toEqual({ depth: 0, work: 0 });
  });

  it.each([
    ["paragraphs", "<p>x".repeat(3_100), 1],
    ["list items", "<ul>" + "<li>x".repeat(3_100) + "</ul>", 2],
    ["table rows", "<table>" + "<tr><td>x".repeat(5_000), 3],
    ["table cells", "<table><tr>" + "<td>x<th>y".repeat(3_000), 4],
    ["definitions", "<dl>" + "<dt>a<dd>b".repeat(3_000), 2],
    ["options", "<select>" + "<optgroup><option>a<option>b".repeat(3_000), 3],
    ["ruby", "<ruby>" + "<rp>(<rt>x".repeat(3_000), 2],
    ["table sections", "<table>" + "<thead>x<tbody>y".repeat(3_000), 3],
    ["headings after paragraphs", "<p>x<h1>y</h1>".repeat(3_000), 1],
  ])("closes %s implicitly, so they stay flat", (_name, html, depth) => {
    const cost = htmlParseCost(html);
    expect(cost.depth).toBe(depth);
    expect(cost.work).toBeLessThan(5 * html.length);
  });

  it.each(["script", "style", "title", "textarea", "xmp"])("ignores tags inside <%s>", (tag) => {
    const html = `<${tag}>${"<div></b>".repeat(5_000)}</${tag.toUpperCase()}>` + "<div></div>";
    const cost = htmlParseCost(html);
    expect(cost).toEqual(measured(html));
    expect(cost.depth).toBe(1);
    expect(cost.work).toBeLessThan(20);
  });

  it("ends raw text only where htmlparser2 does", () => {
    // "</scriptx" does not end a script, "</script " does
    expect(htmlParseCost("<script></scriptx><div><div></script ><div>").depth).toBe(1);
    // a self-closed script is no raw-text element: htmlparser2 keeps it open and reads markup inside it
    expect(htmlParseCost("<script/>" + "<div>".repeat(100)).depth).toBe(101);
    // htmlparser2 compares (c | 0x20), so a control character can stand in for "<"
    expect(htmlParseCost("<script>\u{1C}\u{0F}script><div><div>").depth).toBe(2);
  });

  it("self-closes elements with /> only in svg and math", () => {
    expect(htmlParseCost("<svg>" + "<path/>".repeat(3_100) + "</svg>").depth).toBe(2);
    expect(htmlParseCost("<math>" + "<mrow/>".repeat(3_100) + "</math>").depth).toBe(2);
    expect(htmlParseCost("<div/>".repeat(1_000)).depth).toBe(1_000);
    // foreignObject and the other integration points switch back to HTML rules
    expect(htmlParseCost("<svg><foreignObject>" + "<div/>".repeat(1_000)).depth).toBe(1_002);
  });

  it("counts svg contexts that htmlparser2 keeps after their element was closed", () => {
    // </div> closes the svg, but htmlparser2's list of svg contexts keeps growing
    const cost = htmlParseCost("<div><svg></div>".repeat(2_000));
    expect(cost.depth).toBe(2);
    expect(cost.work).toBeGreaterThan(2_000 * 1_999 / 2);
  });

  it("skips comments, CDATA, declarations and processing instructions", () => {
    expect(htmlParseCost(`<!DOCTYPE html><!--${"<div>".repeat(1_000)}--><![CDATA[${"<div>".repeat(1_000)}]]><?php echo 1 ?>`)).toEqual({ depth: 0, work: 0 });
  });

  it("reads attribute values in quotes, where > does not end the tag", () => {
    expect(htmlParseCost('<div title="a>b"><span alt=\'>\'>x</span></div>')).toEqual({ depth: 2, work: 0 + 1 + 4 + 3 });
  });

  it("follows htmlparser2 exactly on random markup", () => {
    const next = random(20261022);
    for (let doc = 0; doc < 3_000; doc++) {
      let html = "";
      const pieces = Math.floor(next() * 120);
      for (let k = 0; k < pieces; k++) html += PIECES[Math.floor(next() * PIECES.length)];
      expect(htmlParseCost(html), JSON.stringify(html)).toEqual(measured(html));
    }
  });

  it("follows htmlparser2 exactly on the hostile shapes", () => {
    for (const html of [
      "<div></b>".repeat(500),
      "<svg></p>".repeat(500),
      "<div><svg></div>".repeat(500),
      "<svg/>".repeat(500),
      "<div><mi></div>".repeat(500),
      "<div>".repeat(500) + "</b>".repeat(500),
      nestedNewsletter({ bytes: 64 * 1024, tableDepth: 30 }),
    ]) {
      expect(htmlParseCost(html)).toEqual(measured(html));
    }
  });

  it("lets a 1 MB newsletter with tables nested 40 levels deep pass", () => {
    const html = nestedNewsletter({ bytes: 1024 * 1024, tableDepth: 40 });
    expect(html.length).toBeGreaterThan(1024 * 1024);
    expect(htmlParseCost(html).work).toBeLessThan(MAX_PARSE_WORK / 4);
  });

  it.each([
    ["stray closing tags", () => "<div></b>".repeat(40_000)],
    ["stray paragraph ends in svg", () => "<svg></p>".repeat(40_000)],
    ["svg contexts", () => "<div><svg></div>".repeat(40_000)],
    ["nesting", () => "<div>".repeat(200_000)],
    ["nested spans", () => "<span>".repeat(100_000)],
  ])("refuses %s", (_name, build) => {
    expect(htmlParseCost(build()).work).toBeGreaterThan(MAX_PARSE_WORK);
  });

  it("takes linear time", () => {
    const start = performance.now();
    htmlParseCost("<div></b>".repeat(500_000));
    htmlParseCost("<a ".repeat(500_000));
    htmlParseCost("<script>" + "</scrip".repeat(500_000));
    expect(performance.now() - start).toBeLessThan(1_000);
  });
});

/**
 * htmlparser2's stack as events: "+name" for every element it pushes (with the attributes of its start tag, values as
 * written), "-" for every element it takes off. Attributes are left out where htmlparser2 reports none (a start tag
 * cut off by the end of the input).
 */
function parserEvents(html: string): Array<{ event: string; attributes?: string }> {
  const events: Array<{ event: string; attributes?: string }> = [];
  let pushed = false;
  let pending = -1;
  const parser = new Parser(
    {
      // called right after the push of a non-void element; a void element is never pushed
      onopentagname() {
        pending = pushed ? events.length - 1 : -1;
        pushed = false;
      },
      onopentag(_name, attribs) {
        if (pending >= 0) events[pending]!.attributes = JSON.stringify(Object.entries(attribs));
        pending = -1;
      },
    },
    { decodeEntities: false },
  );
  const { stack } = parser as unknown as { stack: string[] };
  stack.unshift = function (this: string[], ...items: string[]) {
    events.push({ event: "+" + items[0] });
    pushed = true;
    return Array.prototype.unshift.apply(this, items);
  };
  stack.shift = function (this: string[]) {
    events.push({ event: "-" });
    return Array.prototype.shift.call(this);
  };
  parser.end(html);
  return events;
}

/** The same events as the estimator's TreeWatch reports them (htmlparser2 keeps the first of repeated attributes). */
function watchedEvents(html: string): Array<{ event: string; attributes?: string }> {
  const events: Array<{ event: string; attributes?: string }> = [];
  const watch: TreeWatch = {
    open(name, attributes) {
      const first = new Map<string, string>();
      for (const [key, value] of attributes()) if (!first.has(key)) first.set(key, value);
      events.push({ event: "+" + name, attributes: JSON.stringify([...first]) });
      return true;
    },
    pop() {
      events.push({ event: "-" });
    },
  };
  htmlParseCost(html, Infinity, watch);
  return events;
}

const LIST_PIECES = [
  "<ol type=I start=5>", '<li value="3">', "<ol START='9' type=a>", "<li value=1 value=2>", "<ol type>", "<ol start=&#53;>",
  "<ol =x>", '<ol type="i"start="2">', "<li value = 7 / >", "<ol start=1/>", "</ol>", "</li>",
];

describe("TreeWatch", () => {
  it("reports the elements htmlparser2 pushes and pops, and their attributes, exactly", () => {
    const pieces = [...PIECES, ...LIST_PIECES];
    const next = random(20261023);
    for (let doc = 0; doc < 3_000; doc++) {
      let html = "";
      const count = Math.floor(next() * 120);
      for (let k = 0; k < count; k++) html += pieces[Math.floor(next() * pieces.length)];
      const expected = parserEvents(html);
      const actual = watchedEvents(html);
      expect(actual.map((e) => e.event), JSON.stringify(html)).toEqual(expected.map((e) => e.event));
      for (const [k, e] of expected.entries()) {
        if (e.attributes !== undefined) expect(actual[k]!.attributes, JSON.stringify(html)).toBe(e.attributes);
      }
    }
  });

  it("opens and closes the empty paragraph htmlparser2 answers a stray </p> with", () => {
    expect(watchedEvents("<div></p>").map((e) => e.event)).toEqual(["+div", "+p", "-"]);
  });

  it("stops the pass when open returns false", () => {
    let opened = 0;
    const cost = htmlParseCost("<div>".repeat(1_000), Infinity, { open: () => ++opened < 10, pop: () => {} });
    expect(opened).toBe(10);
    expect(cost.depth).toBe(10);
  });
});

describe("rawTextElement", () => {
  it.each([
    ["script", "script"],
    ["style", "style"],
    ["title", "title"],
    ["textarea", "textarea"],
    ["xmp", "xmp"],
    // htmlparser2 checks the first letter loosely: these read raw text up to another element's end tag
    ["tmp", "xmp"],
    ["xitle", "title"],
    ["xextarea", "textarea"],
  ])("<%s> starts raw text up to </%s>", (name, end) => expect(rawTextElement(name)).toBe(end));

  it.each(["div", "pre", "plaintext", "noscript", "xm", "scripts", "textpath", "s", ""])("<%s> does not", (name) =>
    expect(rawTextElement(name)).toBeUndefined());
});
