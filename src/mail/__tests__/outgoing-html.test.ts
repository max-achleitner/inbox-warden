import { describe, it, expect } from "vitest";
import { withoutRemoteContent } from "../outgoing-html.js";

describe("withoutRemoteContent", () => {
  it("replaces a remote image by its alt text", () => {
    const r = withoutRemoteContent('<p>Hi</p><img src="https://evil.example/p.gif?d=secret" alt="Logo">');
    expect(r.html).not.toContain("evil.example");
    expect(r.html).toContain("Logo");
    expect(r.remoteContentRemoved).toBe(1);
  });
  it("keeps cid: and data:image images", () => {
    const html = '<img src="cid:logo@firma"><img src="data:image/png;base64,iVBORw0KGgo=">';
    expect(withoutRemoteContent(html)).toMatchObject({ remoteContentRemoved: 0 });
    expect(withoutRemoteContent(html).html).toContain("cid:logo@firma");
  });
  it.each([
    '<IMG SRC="&#104;ttps://evil.example/x.gif">', '<img srcset="https://evil.example/a.png 1x">',
    '<table><tr><td background="//evil.example/bg.png">x</td></tr></table>', `<div style="background:url( 'https://evil.example/x' )">x</div>`,
    "<style>@import url(https://evil.example/a.css); .a{background-image:url(//evil.example/b)}</style>",
    '<svg><image href="https://evil.example/s.png"/></svg>', '<link rel="stylesheet" href="https://evil.example/c.css">',
    '<iframe src="https://evil.example/f"></iframe>', '<video poster="https://evil.example/p.jpg"></video>', '<img src="data:text/html,x">',
    '<div style="background:URL(&quot;//evil.example/x&quot;)">x</div>',
    "<div style=\"background:image-set('https://evil.example/x.png' 1x)\">x</div>",
    "<style>a{content:'x\n}b{background:url(//evil.example/x)}</style>",
    '<style>@import "https://evil.example/a.css";</style>',
    "<style>a{background:u\\72l(https://evil.example/x)}</style>",
    '<img src="https://evil.example/x" srcset="cid:a 1x, https://evil.example/y 2x">',
  ])("removes %s", (html) => {
    const r = withoutRemoteContent(`<p>Text</p>${html}`);
    expect(r.html).not.toMatch(/evil\.example|data:text/);
    expect(r.remoteContentRemoved).toBeGreaterThan(0);
  });
  it("removes scripts, event handlers and javascript links", () => {
    const r = withoutRemoteContent('<a href="javascript:alert(1)">x</a><b onclick="x()">y</b><script>z()</script>');
    expect(r.html).not.toMatch(/javascript:|onclick|<script/);
    expect(r.remoteContentRemoved).toBe(3);
  });
  it("removes javascript links with hidden control characters", () => {
    const r = withoutRemoteContent('<a href="java&#9;script:alert(1)">x</a>');
    expect(r.html).not.toMatch(/script:/);
  });
  it("keeps local CSS and harmless styles", () => {
    const r = withoutRemoteContent('<p style="color:red;background:url(data:image/png;base64,AAAA)">x</p>');
    expect(r.remoteContentRemoved).toBe(0);
    expect(r.html).toContain("color:red");
  });
  it("lists link targets once, in order, and keeps the links", () => {
    const r = withoutRemoteContent('<a href="https://shop.example/a">a</a><a href="mailto:x@y.example">b</a><a href="https://shop.example/a">c</a>');
    expect(r.linkTargets).toEqual(["https://shop.example/a", "mailto:x@y.example"]);
    expect(r.html).toContain('href="https://shop.example/a"');
  });
  it("caps link targets at 50", () => {
    const r = withoutRemoteContent(Array.from({ length: 60 }, (_, i) => `<a href="https://shop.example/${i}">${i}</a>`).join(""));
    expect(r).toMatchObject({ linkTargetsOmitted: 10 });
    expect(r.linkTargets).toHaveLength(50);
  });
  it("refuses absurdly deep nesting quickly and removes elements beyond 500 levels", () => {
    const start = performance.now();
    expect(() => withoutRemoteContent("<div>".repeat(200_000))).toThrow(/nested too deeply/);
    expect(performance.now() - start).toBeLessThan(500);
    const r = withoutRemoteContent("<div>".repeat(600) + "deep" + "</div>".repeat(600));
    expect(r.remoteContentRemoved).toBe(1);
  });
  it("drops comments, counting conditional ones", () => {
    const r = withoutRemoteContent('<p>a</p><!--[if mso]><v:fill src="https://h.example/x"/><img src="https://h.example/x"><![endif]--><!-- note -->');
    expect(r.html).not.toMatch(/h\.example|<!--/);
    expect(r.remoteContentRemoved).toBe(1);
  });
  it("counts a conditional comment that opens without [endif]", () => {
    const r = withoutRemoteContent("<!--[if !mso]><!--><p>x</p><!--<![endif]-->");
    expect(r.html).toBe("<p>x</p>");
    expect(r.remoteContentRemoved).toBe(2);
  });
  it("keeps quotes, apostrophes and non-ASCII text as they are", () => {
    const html = "<p>it's \"q\" ä 漢字 😀 &amp; &lt;b&gt;</p>";
    expect(withoutRemoteContent(html).html).toBe(html);
  });
  it("escapes markup in attributes without &apos;", () => {
    const r = withoutRemoteContent("<p title=\"a<b>'c&quot;\">x</p>");
    expect(r.html).toContain("&lt;");
    expect(r.html).toContain("&gt;");
    expect(r.html).toContain("&quot;");
    expect(r.html).not.toContain("&apos;");
    expect(r.html).not.toMatch(/title="[^"]*[<>]/);
  });
  it("lists link targets as they are written, not escaped", () => {
    const r = withoutRemoteContent('<a href="https://shop.example/a?x=1&amp;y=2">a</a>');
    expect(r.linkTargets).toEqual(["https://shop.example/a?x=1&y=2"]);
    expect(r.html).toContain("x=1&amp;y=2");
  });
  it("keeps alt text escaped and removes SVG animations", () => {
    const r = withoutRemoteContent('<img src="https://h.example/x" alt="a<b>&amp;"><svg><a><animate attributeName="href" to="https://h.example/y"/></a></svg>');
    expect(r.html).toContain("a&lt;b&gt;&amp;");
    expect(r.html).not.toContain("h.example");
    expect(r.remoteContentRemoved).toBe(2);
  });
  it("removes noscript and similar raw-text containers and escapes markup in attributes", () => {
    const r = withoutRemoteContent('<noscript><p title="</noscript><img src=//h.example/x>"></noscript><xmp>x</xmp><p title="a<b>c">t</p>');
    expect(r.html).not.toMatch(/h\.example|noscript|xmp/);
    expect(r.remoteContentRemoved).toBe(2);
    expect(r.html).not.toMatch(/title="[^"]*[<>]/);
  });
  it.each([
    ["self-closing svg paths", "<svg>" + "<path/>".repeat(3100) + "</svg>"],
    ["unclosed paragraphs", "<p>x".repeat(3100)],
    ["unclosed list items", "<ul>" + "<li>x".repeat(3100) + "</ul>"],
    ["unclosed table rows", "<table>" + "<tr><td>x".repeat(5000) + "</table>"],
    ["1,000 nested table cells", "<td><table>".repeat(1000)],
  ])("accepts a flat document of %s", (_n, html) => {
    expect(() => withoutRemoteContent(html)).not.toThrow();
  });
  it.each(["<div>", "<div/>", "<span>"])("still refuses 200k nested %s quickly", (tag) => {
    const start = performance.now();
    expect(() => withoutRemoteContent(tag.repeat(200_000))).toThrow(/nested too deeply/);
    expect(performance.now() - start).toBeLessThan(500);
  });
  it.each([
    ["stray closing tags", "<div></b>"],
    ["stray paragraph ends in svg", "<svg></p>"],
    ["svg contexts closed by their parent", "<div><svg></div>"],
  ])("refuses 160k %s quickly, which htmlparser2 would need minutes for", (_n, piece) => {
    const start = performance.now();
    expect(() => withoutRemoteContent(piece.repeat(160_000))).toThrow(/nested too deeply.*Nothing was saved or sent/);
    expect(performance.now() - start).toBeLessThan(1000);
  });
  it("removes SVG elements with a remote href, ping attributes, and lists form targets", () => {
    const r = withoutRemoteContent('<svg><feImage href="https://evil.example/a"/><mpath xlink:href="//evil.example/b"/></svg><a href="/x" ping="https://evil.example/p">x</a><form action="https://shop.example/f"><button formaction="https://shop.example/g">go</button></form>');
    expect(r.html).not.toContain("evil.example");
    expect(r.remoteContentRemoved).toBe(3);
    expect(r.linkTargets).toEqual(["/x", "https://shop.example/f", "https://shop.example/g"]);
  });
  it("does not list links inside removed elements", () => {
    expect(withoutRemoteContent('<iframe><a href="https://x.example/">x</a></iframe>').linkTargets).toEqual([]);
  });
  it.each([
    ["url(", '<div style="background:' + "url(".repeat(250_000) + '">x</div>'],
    ["@import", "<style>" + "@import ".repeat(120_000) + "</style>"],
    ["unclosed comments", "<style>" + "/*".repeat(500_000) + "</style>"],
    ["links", Array.from({ length: 30_000 }, (_, i) => `<a href="https://s.example/${i}">x</a>`).join("")],
  ])("handles about 1 MB of %s quickly", (_n, html) => {
    const start = performance.now();
    withoutRemoteContent(html);
    expect(performance.now() - start).toBeLessThan(500);
  });
  it.each([
    '<svg><style><img src="https://h.example/x?d=secret"></style></svg>',
    "<math><style><img src=//h.example/x></style></math>",
    '<math><mtext><table><mglyph><style><img src="https://h.example/x"></style></mglyph></table></mtext></math>',
    '<svg><style>a{}</style><style><img src="https://h.example/x?d=secret"></style></svg>',
    "<svg><style><![CDATA[</style><img src=//h.example/x>]]></style></svg>",
  ])("drops style text with markup, which svg and math parse as elements: %s", (html) => {
    const r = withoutRemoteContent(html);
    expect(r.html).not.toContain("h.example");
    expect(r.html).not.toMatch(/<img|<!\[CDATA/i);
    expect(r.remoteContentRemoved).toBeGreaterThan(0);
  });
  it.each([
    "<svg><style>a{background:u&#114;l(https://h.example/x)}</style></svg>",
    '<svg><style>&#64;import "https://h.example/a.css";</style></svg>',
  ])("drops style text with character references, which svg and math decode: %s", (html) => {
    const r = withoutRemoteContent(html);
    expect(r.html).not.toContain("h.example");
    expect(r.remoteContentRemoved).toBe(1);
  });
  it.each([
    "<a>x</a><svg><p><style><b></style></p></svg>{}*{background:url(https://h.example/x)}",
    "<a>x</a><svg><p><style></style></p></svg>{}*{background:url(https://h.example/x)}",
  ])("never writes a self-closed style, which a browser may leave open: %s", (html) => {
    // after <p> a browser leaves svg and ignores "/>", so the rest of the document would become CSS
    expect(withoutRemoteContent(html).html).not.toMatch(/<style/i);
  });
  it("keeps plain style sheets", () => {
    const r = withoutRemoteContent("<style>p{color:red}</style><svg><style>.a{fill:blue}</style></svg>");
    expect(r.remoteContentRemoved).toBe(0);
    expect(r.html).toBe("<style>p{color:red}</style><svg><style>.a{fill:blue}</style></svg>");
  });
  it.each([
    ["fill", '<svg><rect fill="url(https://h.example/p.svg#g)" width="9" height="9"/></svg>'],
    ["mask", '<svg><rect mask="url(https://h.example/m.svg#m)"/></svg>'],
    ["filter", '<svg><rect filter="url(//h.example/f.svg#f)"/></svg>'],
    ["clip-path", "<svg><rect clip-path=\"url('https://h.example/c.svg#c')\"/></svg>"],
    ["stroke", '<svg><path stroke="URL(https://h.example/s.svg#s)"/></svg>'],
    ["marker-start", '<svg><path marker-start="url(https://h.example/k.svg#k)"/></svg>'],
    ["marker-mid", '<svg><path marker-mid="url(https://h.example/k.svg#k)"/></svg>'],
    ["marker-end", '<svg><path marker-end="url(https://h.example/k.svg#k)"/></svg>'],
    ["cursor", '<svg><rect cursor="url(https://h.example/c.cur), auto"/></svg>'],
  ])("removes a remote url() from the SVG %s attribute", (_name, html) => {
    const r = withoutRemoteContent(html);
    expect(r.html).not.toContain("h.example");
    expect(r.remoteContentRemoved).toBe(1);
  });
  it("keeps local url(#id) references in SVG presentation attributes", () => {
    const html = '<svg><rect fill="url(#g)" mask="url( #m )" stroke="red"/></svg>';
    const r = withoutRemoteContent(html);
    expect(r.remoteContentRemoved).toBe(0);
    expect(r.html).toContain('fill="url(#g)"');
    expect(r.html).toContain('mask="url( #m )"');
    expect(r.html).toContain('stroke="red"');
  });
  it("lists link targets with invisible characters percent-encoded", () => {
    const r = withoutRemoteContent('<a href="https://pay\u{200B}pal.example/login">PayPal</a>');
    expect(r.linkTargets).toEqual(["https://pay%E2%80%8Bpal.example/login"]);
  });
  it.each([
    ["300,000 unclosed tag starts", () => "<a".repeat(300_000)],
    ["80,000 comments", () => "<!---->".repeat(80_000)],
    ["80,000 remote images", () => "<img src=//e>".repeat(80_000)],
    ["80,000 remote images with alt text", () => "<img src=//e alt=a>".repeat(80_000)],
    ["80,000 scripts", () => "<script></script>".repeat(80_000)],
    ["80,000 style sheets with markup", () => "<style><b></style>".repeat(80_000)],
  ])("handles %s quickly", (_n, build) => {
    const html = build();
    const start = performance.now();
    try {
      withoutRemoteContent(html);
    } catch {
      // refusing is fine, as long as it is quick
    }
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
