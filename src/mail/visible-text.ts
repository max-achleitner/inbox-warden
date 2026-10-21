import { parseDocument, DomUtils } from "htmlparser2";
import { isComment, isDirective, isTag, isText, type ChildNode, type Element, type ParentNode } from "domhandler";
import { PREHEADER_PADDING_GLOBAL } from "../security/patterns.js";

/**
 * What a human sees in a mail: HTML without hidden elements, text without invisible characters.
 * What is removed is returned as `hiddenText` for the injection scan only; it is never shown to the model.
 */

export type HiddenKind =
  | "display-none"
  | "hidden-attribute"
  | "visibility-hidden"
  | "zero-opacity"
  | "zero-size"
  | "off-screen"
  | "tiny-font"
  | "invisible-color"
  | "tag-characters"
  | "invisible-characters";

/** Kinds are always reported in this order. */
export const HIDDEN_KIND_ORDER: readonly HiddenKind[] = [
  "display-none",
  "hidden-attribute",
  "visibility-hidden",
  "zero-opacity",
  "zero-size",
  "off-screen",
  "tiny-font",
  "invisible-color",
  "tag-characters",
  "invisible-characters",
];

export interface HiddenContentRemoved {
  /** Non-whitespace characters of the removed text. */
  chars: number;
  kinds: HiddenKind[];
}

export interface Visible {
  text: string;
  hiddenText: string;
  removed?: HiddenContentRemoved;
}

export interface VisibleHtml {
  html: string;
  hiddenText: string;
  removed?: HiddenContentRemoved;
}

const HIDDEN_FONT_MAX_PX = 1;
const HIDDEN_OPACITY_MAX = 0.1;
const COLOR_DISTANCE_MAX = 16; // per RGB channel
const OFF_SCREEN_PX = -500;
const INVISIBLE_REPORT_MIN = 3;
const MAX_HTML_DEPTH = 500;

export function mergeRemoved(...parts: Array<HiddenContentRemoved | undefined>): HiddenContentRemoved | undefined {
  let chars = 0;
  const kinds = new Set<HiddenKind>();
  for (const part of parts) {
    if (!part) continue;
    chars += part.chars;
    for (const kind of part.kinds) kinds.add(kind);
  }
  if (chars === 0 && kinds.size === 0) return undefined;
  return { chars, kinds: HIDDEN_KIND_ORDER.filter((k) => kinds.has(k)) };
}

// --- invisible characters ----------------------------------------------------------------------------------------

// Alternatives in order: Scotland-style flag tag sequence (kept), ZWJ inside an emoji sequence (kept), tag characters,
// other invisible format characters.
const INVISIBLE =
  /(\u{1F3F4}[\u{E0061}-\u{E007A}]{2,6}\u{E007F})|((?<=\p{Extended_Pictographic}[\u{FE0F}\p{Emoji_Modifier}]?)\u200D(?=\p{Extended_Pictographic}))|([\u{E0000}-\u{E007F}])|([\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{1D173}-\u{1D17A}\u{E0100}-\u{E01EF}])/gu;
/** Format characters that occur in ordinary text (soft hyphen, direction marks) and are removed without a report. */
const COMMON_FORMAT = new Set([0x00ad, 0x200e, 0x200f, 0x061c]);

export function stripInvisible(input: string): Visible {
  const text0 = input.replace(PREHEADER_PADDING_GLOBAL, " ");
  let payload = "";
  let invisible = 0;
  const text = text0.replace(INVISIBLE, (m, flag, zwj, tag, fmt) => {
    if (flag || zwj) return m;
    if (tag) {
      const code = m.codePointAt(0)!;
      if (code >= 0xe0020 && code <= 0xe007e) payload += String.fromCharCode(code - 0xe0000);
      return "";
    }
    if (fmt && !COMMON_FORMAT.has(m.codePointAt(0)!)) invisible++;
    return "";
  });
  const kinds: HiddenKind[] = [];
  const chars = payload.replace(/\s/g, "").length;
  if (chars > 0) kinds.push("tag-characters");
  if (invisible >= INVISIBLE_REPORT_MIN) kinds.push("invisible-characters");
  const result: Visible = { text, hiddenText: payload };
  if (chars > 0 || kinds.length > 0) result.removed = { chars, kinds };
  return result;
}

export function visibleString<T extends string | undefined>(text: T): T {
  return (text === undefined ? text : stripInvisible(text).text) as T;
}

// --- colours -----------------------------------------------------------------------------------------------------

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

// CSS Color 4 named colours
const NAMED_COLORS = new Map<string, string>(
  (
    "aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000," +
    "blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00," +
    "chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b," +
    "darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b," +
    "darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a," +
    "darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1," +
    "darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff," +
    "firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff," +
    "gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0," +
    "hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5," +
    "lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff," +
    "lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1," +
    "lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899," +
    "lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000," +
    "mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371," +
    "mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585," +
    "midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080," +
    "oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa," +
    "palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f," +
    "pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f," +
    "royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee," +
    "sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa," +
    "springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0," +
    "violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32"
  )
    .split(",")
    .map((p) => p.split(":") as [string, string]),
);

function parseHex(hex: string): Rgba | undefined {
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) return undefined;
  const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
}

/** undefined = not a colour this module understands (hsl(), var(), currentcolor, ...). */
function parseColor(value: string): Rgba | undefined {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (v.startsWith("#")) return parseHex(v.slice(1));
  const fn = /^rgba?\(([^)]*)\)$/.exec(v);
  if (fn) {
    const parts = fn[1]!.trim().split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return undefined;
    const channel = (s: string) => (s.endsWith("%") ? parseFloat(s) * 2.55 : parseFloat(s));
    const [r, g, b] = [channel(parts[0]!), channel(parts[1]!), channel(parts[2]!)];
    const a = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    if ([r, g, b, a].some((x) => Number.isNaN(x))) return undefined;
    return { r: r!, g: g!, b: b!, a };
  }
  const named = NAMED_COLORS.get(v);
  return named ? parseHex(named) : undefined;
}

// --- CSS ---------------------------------------------------------------------------------------------------------

type Decls = Map<string, string>;

/** Splits on `sep` outside parentheses and quotes. */
function splitOutside(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

/** Declarations of one block: lower-cased values plus the names that carry `!important`. */
interface Parsed {
  values: Decls;
  important: Set<string>;
}

const emptyParsed = (): Parsed => ({ values: new Map(), important: new Set() });

function parseDecls(css: string): Parsed {
  const parsed = emptyParsed();
  for (const part of splitOutside(css.replace(CSS_COMMENT, ""), ";")) {
    const colon = part.indexOf(":");
    if (colon < 1) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim().toLowerCase();
    const important = /\s*!\s*important$/.test(value);
    if (important) value = value.replace(/\s*!\s*important$/, "").trim();
    if (!name || !value) continue;
    parsed.values.set(name, value);
    if (important) parsed.important.add(name);
    else parsed.important.delete(name);
  }
  return parsed;
}

/** Overlays `source` onto `target`: a later declaration wins unless the earlier one is `!important` and it is not. */
function overlay(target: Parsed, source: Parsed): void {
  for (const [name, value] of source.values) {
    const important = source.important.has(name);
    if (target.important.has(name) && !important) continue;
    target.values.set(name, value);
    if (important) target.important.add(name);
    else target.important.delete(name);
  }
}

interface CssRule {
  order: number;
  specificity: number;
  tag?: string;
  decls: Parsed;
}

// tag, .class, #id, tag.class, tag#id
const SIMPLE_SELECTOR = /^([a-z][a-z0-9]*)?(?:([.#])([-\w]+))?$/i;
const MEDIA_ALL = /^@media\s+(?:all|screen|only\s+screen)$/i;

/**
 * Simple selector rules from every <style>, indexed by `tag`, `.class` or `#id`. @media all/screen/only screen count as
 * top level; every other @-block is skipped.
 */
function parseRules(cssTexts: string[]): Map<string, CssRule[]> {
  const rules = new Map<string, CssRule[]>();
  let order = 0;
  const scan = (css: string, allowMedia: boolean): void => {
    let depth = 0;
    let prelude = "";
    let bodyStart = 0;
    for (let i = 0; i < css.length; i++) {
      const c = css[i]!;
      if (c === "{") {
        if (depth === 0) bodyStart = i + 1;
        depth++;
      } else if (c === "}") {
        if (depth === 0) continue;
        depth--;
        if (depth > 0) continue;
        const selectors = prelude.slice(prelude.lastIndexOf(";") + 1).trim();
        prelude = "";
        const body = css.slice(bodyStart, i);
        if (selectors.startsWith("@")) {
          if (allowMedia && MEDIA_ALL.test(selectors)) scan(body, false);
          continue;
        }
        const decls = parseDecls(body);
        for (const selector of selectors.split(",")) {
          const m = SIMPLE_SELECTOR.exec(selector.trim());
          if (!m || (!m[1] && !m[2])) continue;
          const tag = m[1]?.toLowerCase();
          const key = m[2] ? `${m[2]}${m[3]!.toLowerCase()}` : tag!;
          const specificity = (tag ? 1 : 0) + (m[2] === "." ? 10 : m[2] === "#" ? 100 : 0);
          const list = rules.get(key) ?? [];
          list.push({ order: order++, specificity, tag: m[2] ? tag : undefined, decls });
          rules.set(key, list);
        }
      } else if (depth === 0) prelude += c;
    }
  };
  for (const raw of cssTexts) scan(raw.replace(CSS_COMMENT, ""), true);
  return rules;
}

/** Number with unit to px; undefined when it is not a plain length. `base` is the reference for em and %. */
function toPx(value: string, base: number): number | undefined {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))(px|pt|em|rem|%|)$/.exec(value.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]!);
  switch (m[2]) {
    case "pt":
      return (n * 4) / 3;
    case "em":
      return n * base;
    case "rem":
      return n * 16;
    case "%":
      return (n * base) / 100;
    default:
      return n; // px or unitless
  }
}

const FONT_KEYWORDS: Record<string, number> = {
  "xx-small": 9,
  "x-small": 10,
  small: 13,
  medium: 16,
  large: 18,
  "x-large": 24,
  "xx-large": 32,
};

function fontSizePx(value: string, parent: number): number {
  const keyword = FONT_KEYWORDS[value];
  if (keyword !== undefined) return keyword;
  if (value === "smaller") return parent / 1.2;
  if (value === "larger") return parent * 1.2;
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return parseFloat(value) === 0 ? 0 : parent; // unitless is invalid CSS
  return toPx(value, parent) ?? parent;
}

// --- visible HTML ------------------------------------------------------------------------------------------------

interface State {
  visibilityHidden: boolean;
  fontPx: number;
  /** undefined = not declared (black), "unknown" = declared but not understood */
  color: Rgba | "unknown" | undefined;
  /** undefined = not declared (white page), "unknown" = image or not understood */
  background: Rgba | "unknown" | undefined;
}

interface Frame {
  src: ChildNode[];
  i: number;
  state: State;
  depth: number;
  /** Kept nodes; the array of the enclosing frame when this frame unwraps an over-deep element. */
  kept: ChildNode[];
  owner?: ParentNode;
}

const REMOVED_SILENTLY = new Set(["script", "template", "title", "style"]);

/** Collects text (and comment text) of a subtree without recursion, skipping style and script content. */
function subtreeText(root: ChildNode): string {
  const parts: string[] = [];
  const stack: ChildNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (isText(node) || isComment(node)) parts.push(node.data);
    else if (isTag(node)) {
      if (node.name === "style" || node.name === "script") continue;
      for (let k = node.children.length - 1; k >= 0; k--) stack.push(node.children[k]!);
    }
  }
  return parts.join(" ");
}

function cssTexts(root: ParentNode): string[] {
  const texts: string[] = [];
  const stack: ChildNode[] = [...root.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (!isTag(node)) continue;
    if (node.name === "style") {
      texts.push(node.children.map((c) => (isText(c) ? c.data : "")).join(""));
      continue;
    }
    for (let k = node.children.length - 1; k >= 0; k--) stack.push(node.children[k]!);
  }
  return texts;
}

export function visibleHtml(html: string): VisibleHtml {
  const doc = parseDocument(html);
  const styles = cssTexts(doc);
  const hasStyle = styles.some((s) => s.replace(CSS_COMMENT, "").trim() !== "");
  const cssRules = parseRules(styles);

  const hidden: string[] = [];
  const removals: HiddenContentRemoved[] = [];
  const remove = (kind: HiddenKind, raw: string) => {
    const { text, hiddenText } = stripInvisible(raw);
    const chars = text.replace(/\s/g, "").length;
    if (text.trim()) hidden.push(text);
    if (hiddenText) hidden.push(hiddenText);
    if (chars > 0) removals.push({ chars, kinds: [kind] });
  };

  const declsOf = (el: Element): Decls => {
    const keys = [el.name, ...(el.attribs.class ?? "").toLowerCase().split(/\s+/).filter(Boolean).map((c) => "." + c)];
    if (el.attribs.id) keys.push("#" + el.attribs.id.toLowerCase());
    const applicable: CssRule[] = [];
    for (const key of keys) {
      for (const rule of cssRules.get(key) ?? []) if (!rule.tag || rule.tag === el.name) applicable.push(rule);
    }
    applicable.sort((x, y) => x.specificity - y.specificity || x.order - y.order);
    const merged = emptyParsed();
    for (const rule of applicable) overlay(merged, rule.decls);
    overlay(merged, parseDecls(el.attribs.style ?? ""));
    return merged.values;
  };

  const lengthPx = (d: Decls, prop: string): number | undefined => {
    const v = d.get(prop);
    return v === undefined ? undefined : toPx(v, 16);
  };

  const elementReason = (el: Element, d: Decls): HiddenKind | undefined => {
    if (d.get("display") === "none") return "display-none";
    if ("hidden" in el.attribs) return "hidden-attribute";
    const opacity = d.get("opacity");
    if (opacity !== undefined) {
      const o = opacity.endsWith("%") ? parseFloat(opacity) / 100 : parseFloat(opacity);
      if (o <= HIDDEN_OPACITY_MAX) return "zero-opacity";
    }
    const clipped = ["overflow", "overflow-x", "overflow-y"].some((p) => /^(hidden|clip)$/.test(d.get(p) ?? ""));
    if (clipped && ["height", "max-height", "width", "max-width"].some((p) => (lengthPx(d, p) ?? 1) <= 0)) {
      return "zero-size";
    }
    if ((lengthPx(d, "text-indent") ?? 0) <= OFF_SCREEN_PX) return "off-screen";
    if (/^(absolute|fixed)$/.test(d.get("position") ?? "")) {
      if (["left", "top"].some((p) => (lengthPx(d, p) ?? 0) <= OFF_SCREEN_PX)) return "off-screen";
    }
    return undefined;
  };

  const nextState = (el: Element, d: Decls, parent: State): State => {
    const s: State = { ...parent };
    const visibility = d.get("visibility");
    if (visibility === "hidden" || visibility === "collapse") s.visibilityHidden = true;
    else if (visibility === "visible") s.visibilityHidden = false;
    const size = d.get("font-size");
    if (size !== undefined) s.fontPx = fontSizePx(size, parent.fontPx);

    const legacy = (raw: string | undefined) => {
      const v = raw?.trim().toLowerCase();
      return v !== undefined && /^[0-9a-f]{6}$/.test(v) ? "#" + v : v;
    };
    const colorValue =
      d.get("color") ?? legacy(el.name === "font" ? el.attribs.color : el.name === "body" ? el.attribs.text : undefined);
    if (colorValue !== undefined) s.color = parseColor(colorValue) ?? "unknown";
    else if (el.name === "a") s.color = "unknown"; // links are blue by default

    let image = el.attribs.background !== undefined && el.attribs.background !== "";
    if (el.attribs.bgcolor) {
      const c = parseColor(legacy(el.attribs.bgcolor)!);
      if (c === undefined) s.background = "unknown";
      else if (c.a > 0) s.background = c;
    }
    const bgImage = d.get("background-image");
    if (bgImage !== undefined && bgImage !== "none") image = true;
    const bgShort = d.get("background");
    if (bgShort?.includes("url(")) image = true;
    let bgValue = d.get("background-color");
    if (bgValue === undefined && bgShort !== undefined) {
      bgValue = splitOutside(bgShort, " ")
        .map((t) => t.trim())
        .find((t) => t && parseColor(t) !== undefined);
    }
    if (bgValue === undefined && bgShort !== undefined && bgShort !== "none") image = true; // gradient, var(), ...
    if (bgValue !== undefined) {
      const c = parseColor(bgValue);
      if (c === undefined) s.background = "unknown";
      else if (c.a > 0) s.background = c;
    }
    if (image) s.background = "unknown";
    return s;
  };

  const textReason = (s: State): HiddenKind | undefined => {
    if (s.visibilityHidden) return "visibility-hidden";
    if (s.fontPx <= HIDDEN_FONT_MAX_PX) return "tiny-font";
    if (s.color !== undefined && s.color !== "unknown" && s.color.a <= HIDDEN_OPACITY_MAX) return "invisible-color";
    if (s.color === "unknown" || s.background === "unknown") return undefined;
    if ((s.color === undefined || s.background === undefined) && hasStyle) return undefined;
    const fg = s.color ?? { r: 0, g: 0, b: 0, a: 1 };
    const bg = s.background ?? { r: 255, g: 255, b: 255, a: 1 };
    const near = (x: number, y: number) => Math.abs(x - y) <= COLOR_DISTANCE_MAX;
    return near(fg.r, bg.r) && near(fg.g, bg.g) && near(fg.b, bg.b) ? "invisible-color" : undefined;
  };

  const initial: State = { visibilityHidden: false, fontPx: 16, color: undefined, background: undefined };
  const stack: Frame[] = [{ src: [...doc.children], i: 0, state: initial, depth: 0, kept: [], owner: doc }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.i >= frame.src.length) {
      stack.pop();
      if (frame.owner) {
        frame.owner.children = frame.kept;
        for (const child of frame.kept) child.parent = frame.owner;
      }
      continue;
    }
    const node = frame.src[frame.i++]!;

    if (isComment(node)) {
      if (node.data.trim()) hidden.push(node.data);
      continue;
    }
    if (isText(node)) {
      const stripped = stripInvisible(node.data);
      if (stripped.hiddenText) hidden.push(stripped.hiddenText);
      if (stripped.removed) removals.push(stripped.removed);
      node.data = stripped.text;
      const reason = stripped.text.trim() ? textReason(frame.state) : undefined;
      if (reason) remove(reason, stripped.text);
      else frame.kept.push(node);
      continue;
    }
    if (isDirective(node)) {
      if (node.data.trim()) hidden.push(node.data);
      continue;
    }
    if (!isTag(node)) {
      if ("children" in node) {
        // CDATA and similar containers: unwrap
        stack.push({ src: [...(node as ParentNode).children], i: 0, state: frame.state, depth: frame.depth, kept: frame.kept });
      } else frame.kept.push(node);
      continue;
    }

    if (node.name === "noscript") {
      const inner = stripInvisible(subtreeText(node));
      if (inner.text.trim()) hidden.push(inner.text);
      if (inner.hiddenText) hidden.push(inner.hiddenText);
      continue;
    }
    if (REMOVED_SILENTLY.has(node.name)) continue;
    const decls = declsOf(node);
    const reason = elementReason(node, decls);
    if (reason) {
      remove(reason, subtreeText(node));
      continue;
    }
    const state = nextState(node, decls, frame.state);
    const depth = frame.depth + 1;
    const src = [...node.children];
    if (depth > MAX_HTML_DEPTH) {
      // Too deep for the serialiser and html-to-text: the children move up into the enclosing kept element.
      stack.push({ src, i: 0, state, depth, kept: frame.kept });
    } else {
      frame.kept.push(node);
      stack.push({ src, i: 0, state, depth, kept: [], owner: node });
    }
  }

  const removed = mergeRemoved(...removals);
  const result: VisibleHtml = {
    html: DomUtils.getOuterHTML(doc, { encodeEntities: "utf8" }),
    hiddenText: hidden.join("\n"),
  };
  if (removed) result.removed = removed;
  return result;
}
