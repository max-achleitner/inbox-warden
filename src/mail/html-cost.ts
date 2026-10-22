/**
 * What parsing a piece of HTML costs htmlparser2 (10.x), estimated in one linear pass before it is parsed.
 *
 * htmlparser2 keeps its open elements in an array with the innermost element first: every opened element is added with
 * `unshift` (which moves the whole stack) and every closing tag looks its element up with `indexOf` (which compares
 * the whole stack when nothing matches). Deep nesting and closing tags without an open element therefore take time
 * quadratic in their number: a few hundred kilobytes of `<div></b>` keep the parser busy for seconds, a few megabytes
 * for minutes. svg, math and their HTML integration points (`foreignObject`, `desc`, `title`, ...) are also added to a
 * second array, which only their own closing tags shrink.
 *
 * This module follows htmlparser2's tokenizer and tree building (tag names lower-cased, void elements, raw-text
 * elements, `/>` only in svg and math, implied end tags, comments, CDATA and declarations) closely enough to count
 * exactly what those arrays cost; `src/mail/__tests__/html-cost.test.ts` compares the count with htmlparser2's own.
 */

export interface HtmlParseCost {
  /** Deepest nesting htmlparser2 reaches. */
  depth: number;
  /**
   * Array elements htmlparser2 moves (unshift) or compares (indexOf) while it builds the tree; comparing two tag names
   * of the same length counts as many units as they have characters.
   */
  work: number;
}

/**
 * HTML that costs more is not parsed. Measured on Node 24 (2026 laptop): up to 1.6 ns per unit, linear overhead of a
 * multi-megabyte input included, so whatever passes parses in at most about 160 ms (the cleaned copy html-to-text
 * parses again passes the same gate). A newsletter of 4 MB with layout tables nested 40 levels deep (170 elements)
 * costs 8.4 million; 14,000 unclosed elements cost 100 million.
 */
export const MAX_PARSE_WORK = 100_000_000;

const VOID_ELEMENTS = new Set([
  "area", "base", "basefont", "br", "col", "command", "embed", "frame", "hr", "img", "input", "isindex", "keygen", "link",
  "meta", "param", "source", "track", "wbr",
]);
const FOREIGN_ELEMENTS = new Set(["math", "svg"]);
const INTEGRATION_ELEMENTS = new Set(["mi", "mo", "mn", "ms", "mtext", "annotation-xml", "foreignobject", "desc", "title"]);

const P = new Set(["p"]);
const FORM = new Set(["input", "option", "optgroup", "select", "button", "datalist", "textarea"]);
const TABLE_SECTIONS = new Set(["thead", "tbody"]);
const DD_DT = new Set(["dd", "dt"]);
const RT_RP = new Set(["rt", "rp"]);
/** Elements whose start tag closes the listed elements while one of them is the innermost open element. */
const IMPLIES_CLOSE = new Map<string, Set<string>>([
  ["tr", new Set(["tr", "th", "td"])],
  ["th", new Set(["th"])],
  ["td", new Set(["thead", "th", "td"])],
  ["body", new Set(["head", "link", "script"])],
  ["li", new Set(["li"])],
  ...["p", "h1", "h2", "h3", "h4", "h5", "h6"].map((n): [string, Set<string>] => [n, P]),
  ...["select", "input", "output", "button", "datalist", "textarea"].map((n): [string, Set<string>] => [n, FORM]),
  ["option", new Set(["option"])],
  ["optgroup", new Set(["optgroup", "option"])],
  ["dd", DD_DT],
  ["dt", DD_DT],
  ...[
    "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer",
    "form", "header", "hr", "main", "nav", "ol", "pre", "section", "table", "ul",
  ].map((n): [string, Set<string>] => [n, P]),
  ["rt", RT_RP],
  ["rp", RT_RP],
  ["tbody", TABLE_SECTIONS],
  ["tfoot", TABLE_SECTIONS],
]);

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const EQUALS = 0x3d;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const DASH = 0x2d;
const LBRACKET = 0x5b;

const isWhitespace = (c: number) => c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0c || c === 0x0d;
const isAlpha = (c: number) => (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
/** Ends a start tag's name or an attribute name. */
const endsName = (c: number) => c === SLASH || c === GT || isWhitespace(c);

/**
 * The end sequence (`</script` ...) of a raw-text element, when htmlparser2's tokenizer opens one for the start tag name
 * `html[start, end)`. It checks the first letter loosely (t or x for title, textarea and xmp) and the others with
 * `(c | 0x20)`, so `<tmp>` is read as raw text up to `</xmp`.
 */
function rawTextSequence(html: string, start: number, end: number): string | undefined {
  const first = html.charCodeAt(start) | 0x20;
  const second = html.charCodeAt(start + 1) | 0x20;
  let sequence: string | undefined;
  if (first === 0x73) sequence = second === 0x63 ? "</script" : second === 0x74 ? "</style" : undefined;
  else if (first === 0x74 || first === 0x78) {
    sequence = second === 0x69 ? "</title" : second === 0x65 ? "</textarea" : second === 0x6d ? "</xmp" : undefined;
  }
  if (sequence === undefined || end - start !== sequence.length - 2) return undefined;
  for (let k = 4; k < sequence.length; k++) {
    if ((html.charCodeAt(start + k - 2) | 0x20) !== sequence.charCodeAt(k)) return undefined;
  }
  return sequence;
}

/**
 * Index of the character (">" or whitespace) after the end sequence that closes raw text starting at `from`, or -1 when
 * the raw text runs to the end. A step-by-step copy of htmlparser2's `stateInSpecialTag`, quirks included: characters
 * are compared as `(c | 0x20)`, and outside `<title>` the search skips ahead to the next "<".
 */
function rawTextEnd(html: string, from: number, sequence: string): number {
  const title = sequence === "</title";
  let k = 0;
  for (let i = from; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (k === sequence.length) {
      if (c === GT || isWhitespace(c)) return i;
      k = 0;
    }
    if ((c | 0x20) === sequence.charCodeAt(k)) k++;
    else if (k === 0) {
      if (!title) {
        const lt = html.indexOf("<", i + 1);
        if (lt < 0) return -1;
        i = lt;
        k = 1;
      }
    } else k = c === LT ? 1 : 0;
  }
  return -1;
}

/** Attribute states of htmlparser2's tokenizer between a start tag's name and its ">". */
const enum Attr {
  BeforeName,
  SelfClosing,
  Name,
  AfterName,
  BeforeValue,
  Unquoted,
}

/**
 * The ">" that ends the start tag whose name ends at `from`, and whether it is written "/>"; `undefined` when the input
 * ends first. Quotes count only around attribute values, as in htmlparser2.
 */
function startTagEnd(html: string, from: number): { gt: number; selfClosing: boolean } | undefined {
  let state = Attr.BeforeName;
  for (let i = from; i < html.length; i++) {
    const c = html.charCodeAt(i);
    switch (state) {
      case Attr.BeforeName:
        if (c === GT) return { gt: i, selfClosing: false };
        if (c === SLASH) state = Attr.SelfClosing;
        else if (!isWhitespace(c)) state = Attr.Name;
        break;
      case Attr.SelfClosing:
        if (c === GT) return { gt: i, selfClosing: true };
        if (!isWhitespace(c)) {
          state = Attr.BeforeName;
          i--;
        }
        break;
      case Attr.Name:
        if (c === EQUALS || endsName(c)) {
          state = Attr.AfterName;
          i--;
        }
        break;
      case Attr.AfterName:
        if (c === EQUALS) state = Attr.BeforeValue;
        else if (c === SLASH || c === GT) {
          state = Attr.BeforeName;
          i--;
        } else if (!isWhitespace(c)) state = Attr.Name;
        break;
      case Attr.BeforeValue:
        if (c === DQUOTE || c === SQUOTE) {
          const close = html.indexOf(c === DQUOTE ? '"' : "'", i + 1);
          if (close < 0) return undefined;
          i = close;
          state = Attr.BeforeName;
        } else if (!isWhitespace(c)) {
          state = Attr.Unquoted;
          i--;
        }
        break;
      case Attr.Unquoted:
        if (c === GT || isWhitespace(c)) {
          state = Attr.BeforeName;
          i--;
        }
        break;
    }
  }
  return undefined;
}

/**
 * One linear pass over `html` that counts what htmlparser2's tree building will cost (see the module comment). With a
 * `limit` it stops as soon as `work` exceeds it (the result then only says that it did).
 */
export function htmlParseCost(html: string, limit = Infinity): HtmlParseCost {
  const n = html.length;
  // innermost element last (htmlparser2 keeps it first, which is what makes it slow)
  const stack: string[] = [];
  const openCount = new Map<string, number>();
  /** Open elements per name length: indexOf compares names of equal length character by character. */
  const openOfLength = new Map<number, number>();
  const foreign: boolean[] = [false];
  let work = 0;
  let depth = 0;

  const pop = (): string => {
    const name = stack.pop()!;
    const count = openCount.get(name)! - 1;
    if (count === 0) openCount.delete(name);
    else openCount.set(name, count);
    openOfLength.set(name.length, openOfLength.get(name.length)! - 1);
    return name;
  };
  const open = (name: string): void => {
    const closes = IMPLIES_CLOSE.get(name);
    if (closes) while (stack.length > 0 && closes.has(stack[stack.length - 1]!)) pop();
    if (VOID_ELEMENTS.has(name)) return;
    work += stack.length;
    stack.push(name);
    openCount.set(name, (openCount.get(name) ?? 0) + 1);
    openOfLength.set(name.length, (openOfLength.get(name.length) ?? 0) + 1);
    if (stack.length > depth) depth = stack.length;
    if (FOREIGN_ELEMENTS.has(name) || INTEGRATION_ELEMENTS.has(name)) {
      work += foreign.length;
      foreign.push(FOREIGN_ELEMENTS.has(name));
    }
  };
  const close = (name: string): void => {
    if (FOREIGN_ELEMENTS.has(name) || INTEGRATION_ELEMENTS.has(name)) foreign.pop();
    if (VOID_ELEMENTS.has(name)) return;
    // indexOf compares an element of another length in one step, one of the same length per character
    if (openCount.has(name)) {
      // it stops at the innermost match; everything up to it is closed
      let top: string;
      do {
        top = pop();
        work += top.length === name.length ? name.length : 1;
      } while (top !== name);
    } else {
      work += stack.length + (openOfLength.get(name.length) ?? 0) * (name.length - 1);
      // htmlparser2 answers a stray </p> with an empty paragraph: one more unshift
      if (name === "p") {
        work += stack.length;
        if (stack.length + 1 > depth) depth = stack.length + 1;
      }
    }
  };

  let i = 0;
  while (i < n && work <= limit) {
    const lt = html.indexOf("<", i);
    if (lt < 0 || lt + 1 >= n) break;
    const c = html.charCodeAt(lt + 1);

    if (isAlpha(c)) {
      let nameEnd = lt + 2;
      while (nameEnd < n && !endsName(html.charCodeAt(nameEnd))) nameEnd++;
      if (nameEnd >= n) break; // a tag name cut off by the end of the input is dropped
      const name = html.slice(lt + 1, nameEnd).toLowerCase();
      open(name);
      const end = startTagEnd(html, nameEnd);
      if (end === undefined) break;
      if (end.selfClosing) {
        // "/>" closes the element in svg and math only, and never starts raw text
        if (foreign[foreign.length - 1] === true && stack[stack.length - 1] === name) pop();
        i = end.gt + 1;
        continue;
      }
      const sequence = rawTextSequence(html, lt + 1, nameEnd);
      if (sequence === undefined) {
        i = end.gt + 1;
        continue;
      }
      const textEnd = rawTextEnd(html, end.gt + 1, sequence);
      if (textEnd < 0) break;
      close(sequence.slice(2));
      if (html.charCodeAt(textEnd) === GT) i = textEnd + 1;
      else {
        const gt = html.indexOf(">", textEnd + 1);
        if (gt < 0) break;
        i = gt + 1;
      }
      continue;
    }

    if (c === SLASH) {
      let k = lt + 2;
      while (k < n && isWhitespace(html.charCodeAt(k))) k++;
      if (k >= n) break;
      const first = html.charCodeAt(k);
      if (first === GT) {
        i = k + 1;
        continue;
      }
      if (!isAlpha(first)) {
        // "</1...>" is a bogus comment
        const gt = html.indexOf(">", k + 1);
        if (gt < 0) break;
        i = gt + 1;
        continue;
      }
      let nameEnd = k + 1;
      while (nameEnd < n && html.charCodeAt(nameEnd) !== GT && !isWhitespace(html.charCodeAt(nameEnd))) nameEnd++;
      if (nameEnd >= n) break;
      close(html.slice(k, nameEnd).toLowerCase());
      const gt = html.charCodeAt(nameEnd) === GT ? nameEnd : html.indexOf(">", nameEnd + 1);
      if (gt < 0) break;
      i = gt + 1;
      continue;
    }

    if (c === BANG) {
      const kind = html.charCodeAt(lt + 2);
      let end: number;
      if (kind === DASH && html.charCodeAt(lt + 3) === DASH) {
        // a comment; "<!-->" and "<!--->" are complete ones
        const close = html.indexOf("-->", lt + 2);
        if (close < 0) break;
        i = close + 3;
        continue;
      }
      if (kind === LBRACKET && html.startsWith("CDATA[", lt + 3)) {
        const close = html.indexOf("]]>", lt + 9);
        if (close < 0) break;
        i = close + 3;
        continue;
      }
      if (kind === LBRACKET) {
        // a declaration from the first character that breaks "CDATA["
        let k = 0;
        while (k < 6 && html.charCodeAt(lt + 3 + k) === "CDATA[".charCodeAt(k)) k++;
        end = html.indexOf(">", lt + 3 + k);
      } else if (kind === DASH) {
        // "<!-x": htmlparser2 skips the character after the dash before it looks for ">"
        end = html.indexOf(">", lt + 4);
      } else {
        end = html.indexOf(">", lt + 3);
      }
      if (end < 0) break;
      i = end + 1;
      continue;
    }

    if (c === QUESTION) {
      const end = html.indexOf(">", lt + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }

    // "<" before anything else is text; the next character may start a tag itself
    i = lt + 1;
  }
  return { depth, work };
}
