import { parseDocument, DomUtils } from "htmlparser2";
import { Text, isTag, type ChildNode, type Element, type ParentNode } from "domhandler";

/**
 * HTML that Claude writes for a draft: no remote content. A remote image reports when a draft is opened and can
 * carry data in its address; scripts, style sheets and frames load or run things the user never sees.
 * The input is written by the model (possibly steered by a malicious email); the safe direction is to remove.
 */

export const LINK_TARGETS_MAX = 50;
/** CSS beyond this size is dropped instead of parsed. */
const CSS_MAX = 64 * 1024;
const MAX_DEPTH = 500;
/** htmlparser2 takes time quadratic in the nesting depth, so absurdly deep input is refused before it is parsed. */
const NESTING_REFUSED = 3000;
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param"]);

export interface OutgoingHtml {
  html: string;
  remoteContentRemoved: number;
  linkTargets: string[];
  linkTargetsOmitted: number;
}

const REMOVED_ELEMENTS = new Set([
  "link", "script", "iframe", "frame", "frameset", "object", "embed", "applet", "base",
  "video", "audio", "source", "track", "portal",
  // raw-text containers: their content is parsed differently by a renderer than by us
  "noscript", "xmp", "noembed", "noframes", "plaintext",
]);
/** SVG elements that load a resource through href / xlink:href. */
const SVG_HREF_ELEMENTS = new Set(["image", "use", "feimage", "mpath", "tref", "pattern", "lineargradient", "radialgradient", "filter"]);
const INTEGRATION_ELEMENTS = new Set(["foreignobject", "desc", "title"]);
/** Elements whose end tag htmlparser2 implies, so they do not nest. */
const IMPLIED_END = new Set(["p", "li", "td", "th", "tr", "option", "dt", "dd"]);
const URL_ATTRIBUTES = ["src", "background", "poster", "lowsrc", "dynsrc"];
/** Functions in CSS that can load a resource or run code; they are replaced as a whole. */
const CSS_FUNCTIONS = ["image-set(", "image(", "cross-fade(", "element(", "expression("];

/** Control characters and spaces anywhere in a URL are ignored by browsers when they read the scheme. */
function schemeForm(value: string): string {
  return value.replace(/[\u0000- ]/g, "").toLowerCase();
}

function isRemote(value: string, allowFragment = false): boolean {
  const v = schemeForm(value);
  if (v === "") return false;
  if (allowFragment && v.startsWith("#")) return false;
  return !(v.startsWith("cid:") || v.startsWith("data:image/"));
}

function isDangerousHref(value: string): boolean {
  const v = schemeForm(value);
  return v.startsWith("javascript:") || v.startsWith("vbscript:") || v.startsWith("data:");
}

function isSingleLocalCandidate(value: string): boolean {
  return /^\s*cid:[^\s,]*(?:\s+\d+(?:\.\d+)?[wx])?\s*$/i.test(value);
}

function matchAt(css: string, i: number, lower: string): boolean {
  if (i + lower.length > css.length) return false;
  for (let k = 0; k < lower.length; k++) {
    let c = css.charCodeAt(i + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== lower.charCodeAt(k)) return false;
  }
  return true;
}

const isNewline = (c: number) => c === 10 || c === 13 || c === 12;

/** End (exclusive) of a quoted string that starts at `i`; a newline ends it as in CSS. */
function skipString(css: string, i: number): number {
  const q = css.charCodeAt(i);
  let j = i + 1;
  while (j < css.length) {
    const c = css.charCodeAt(j);
    if (c === q) return j + 1;
    if (isNewline(c)) return j;
    j++;
  }
  return j;
}

/** End (exclusive) of a parenthesised group whose "(" is at `open`. Linear: every character is visited once. */
function skipGroup(css: string, open: number): number {
  let depth = 0;
  let j = open;
  while (j < css.length) {
    const c = css.charCodeAt(j);
    if (c === 34 || c === 39) {
      j = skipString(css, j);
      continue;
    }
    if (c === 47 && css.charCodeAt(j + 1) === 42) {
      const end = css.indexOf("*/", j + 2);
      j = end < 0 ? css.length : end + 2;
      continue;
    }
    if (c === 40) depth++;
    else if (c === 41 && --depth === 0) return j + 1;
    j++;
  }
  return j;
}

/**
 * Replaces remote url(...), @import rules and loading functions; returns the new CSS and how many were replaced.
 * CSS with a backslash (escapes can spell "url") or beyond the size cap is dropped whole.
 */
export function cleanCss(css: string): { css: string; removed: number } {
  if (css.length > CSS_MAX || css.includes("\\")) return { css: "", removed: css.trim() === "" ? 0 : 1 };
  let out = "";
  let removed = 0;
  let last = 0;
  let i = 0;
  const flush = (to: number) => {
    out += css.slice(last, to);
  };
  while (i < css.length) {
    const c = css.charCodeAt(i);
    if (c === 34 || c === 39) {
      i = skipString(css, i);
      continue;
    }
    if (c === 47 && css.charCodeAt(i + 1) === 42) {
      const end = css.indexOf("*/", i + 2);
      i = end < 0 ? css.length : end + 2;
      continue;
    }
    if (c === 64 && matchAt(css, i, "@import")) {
      // the rule runs to the next ";" outside a string, or to the end
      let j = i + 7;
      while (j < css.length) {
        const d = css.charCodeAt(j);
        if (d === 34 || d === 39) j = skipString(css, j);
        else if (d === 40) j = skipGroup(css, j);
        else if (d === 59) {
          j++;
          break;
        } else j++;
      }
      flush(i);
      last = i = j;
      removed++;
      continue;
    }
    if (matchAt(css, i, "url(")) {
      const close = skipGroup(css, i + 3);
      let k = i + 4;
      while (k < close && css.charCodeAt(k) <= 32) k++;
      let value: string;
      if (css.charCodeAt(k) === 34 || css.charCodeAt(k) === 39) value = css.slice(k + 1, skipString(css, k) - 1);
      else value = css.slice(k, css.charCodeAt(close - 1) === 41 ? close - 1 : close);
      if (isRemote(value)) {
        flush(i);
        out += "none";
        last = i = close;
        removed++;
      } else i = close;
      continue;
    }
    let fn = false;
    for (const name of CSS_FUNCTIONS) {
      if (matchAt(css, i, name)) {
        const close = skipGroup(css, i + name.length - 1);
        flush(i);
        out += "none";
        last = i = close;
        removed++;
        fn = true;
        break;
      }
    }
    if (!fn) i++;
  }
  flush(css.length);
  return { css: out, removed };
}

/**
 * Rough peak nesting of the markup in one linear pass, following htmlparser2's rules: "/>" closes only inside
 * svg/math, some elements are closed implicitly. Comments over-count a little. Underestimates are harmless
 * beyond time; the 500-level cut after parsing still applies.
 */
function peakNesting(html: string): number {
  let depth = 0;
  let peak = 0;
  const foreign: boolean[] = [];
  let gt = -1;
  let i = html.indexOf("<");
  while (i >= 0) {
    const c = html.charCodeAt(i + 1);
    const closing = c === 47;
    const start = closing ? i + 2 : i + 1;
    const first = html.charCodeAt(start);
    if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      let j = start;
      while (j < html.length && j - start <= 14 && /[A-Za-z0-9]/.test(html[j])) j++;
      const name = html.slice(start, j).toLowerCase();
      if (closing) {
        depth = Math.max(0, depth - 1);
        if (name === "svg" || name === "math" || INTEGRATION_ELEMENTS.has(name)) foreign.shift();
      } else {
        if (gt < i) gt = html.indexOf(">", i);
        const selfClosed = gt > 0 && html.charCodeAt(gt - 1) === 47;
        const special = name === "svg" || name === "math" || INTEGRATION_ELEMENTS.has(name);
        const inForeign = foreign[0] === true;
        if (VOID_ELEMENTS.has(name) || IMPLIED_END.has(name)) {
          // no nesting
        } else if (selfClosed && (inForeign || special)) {
          // closed at once (an svg element that closes itself pushes no context)
        } else {
          depth++;
          if (depth > peak) peak = depth;
          if (special) foreign.unshift(name === "svg" || name === "math");
        }
      }
    } else if (closing) depth = Math.max(0, depth - 1);
    i = html.indexOf("<", i + 1);
  }
  return peak;
}

function textOf(el: Element): string {
  let s = "";
  for (const child of el.children) if (child.type === "text") s += (child as Text).data;
  return s;
}

export function withoutRemoteContent(html: string): OutgoingHtml {
  if (peakNesting(html) > NESTING_REFUSED) {
    throw new Error("The html is nested too deeply to be checked for remote content. Nothing was saved or sent.");
  }
  const doc = parseDocument(html);
  let removedCount = 0;
  const seen = new Set<string>();
  const linkTargets: string[] = [];
  let omitted = 0;

  const stack: Array<{ node: ChildNode; depth: number }> = [];
  for (let i = doc.children.length - 1; i >= 0; i--) stack.push({ node: doc.children[i], depth: 1 });

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (!isTag(node)) {
      // comments (conditional ones are read by Outlook, VML can fetch images), CDATA and directives other than the doctype
      const droppable = node.type === "comment" || node.type === "cdata" || (node.type === "directive" && !/^!doctype/i.test((node as { name?: string }).name ?? ""));
      if (droppable) {
        if (node.type === "comment" && /^\s*\[if|\[endif\]/i.test((node as unknown as { data: string }).data)) removedCount++;
        DomUtils.removeElement(node);
      }
      continue;
    }
    const name = node.name.toLowerCase();
    const attrs = node.attribs;
    const drop = () => {
      DomUtils.removeElement(node);
      removedCount++;
    };

    if (depth > MAX_DEPTH) {
      drop();
      continue;
    }
    if (REMOVED_ELEMENTS.has(name)) {
      drop();
      continue;
    }
    if (name === "meta" && /refresh/i.test(attrs["http-equiv"] ?? "")) {
      drop();
      continue;
    }
    if (SVG_HREF_ELEMENTS.has(name) && [attrs.href, attrs["xlink:href"]].some((v) => v !== undefined && isRemote(v, true))) {
      drop();
      continue;
    }
    if (name === "img" && attrs.src !== undefined && isRemote(attrs.src)) {
      const alt = attrs.alt?.trim();
      if (alt) DomUtils.replaceElement(node, new Text(alt));
      else DomUtils.removeElement(node);
      removedCount++;
      continue;
    }

    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      const k = key.toLowerCase();
      let bad = false;
      if (k.startsWith("on") || k === "ping") bad = true;
      else if (URL_ATTRIBUTES.includes(k)) bad = isRemote(value);
      else if (k === "srcset") bad = value.trim() !== "" && !isSingleLocalCandidate(value);
      else if (k === "href" || k === "xlink:href" || k === "action" || k === "formaction") bad = isDangerousHref(value);
      else if (k === "style") {
        const cleaned = cleanCss(value);
        removedCount += cleaned.removed;
        if (cleaned.css === "") delete attrs[key];
        else attrs[key] = cleaned.css;
      }
      if (bad) {
        delete attrs[key];
        removedCount++;
      }
    }

    if (name === "style") {
      const cleaned = cleanCss(textOf(node));
      removedCount += cleaned.removed;
      for (const child of [...node.children]) DomUtils.removeElement(child);
      if (cleaned.css !== "") DomUtils.appendChild(node, new Text(cleaned.css));
      continue;
    }

    const targets: Array<string | undefined> = [];
    if (name === "a" || name === "area") targets.push(attrs.href);
    if (name === "form") targets.push(attrs.action);
    targets.push(attrs.formaction);
    for (const raw of targets) {
      const href = raw?.trim();
      if (href && !seen.has(href)) {
        seen.add(href);
        if (linkTargets.length < LINK_TARGETS_MAX) linkTargets.push(href);
        else omitted++;
      }
    }

    const children = (node as ParentNode).children;
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], depth: depth + 1 });
  }

  return {
    html: DomUtils.getOuterHTML(doc, { encodeEntities: true }),
    remoteContentRemoved: removedCount,
    linkTargets,
    linkTargetsOmitted: omitted,
  };
}
