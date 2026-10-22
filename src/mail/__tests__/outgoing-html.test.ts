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
});
