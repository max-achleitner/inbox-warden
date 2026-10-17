const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

export function stripCode(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

/** Relative link targets (no scheme, no pure anchors), anchor removed, percent-decoded. */
export function relativeLinks(markdown) {
  return [...stripCode(markdown).matchAll(LINK)]
    .map((match) => match[1])
    .filter((href) => !/^([a-z][a-z0-9+.-]*:|#)/i.test(href))
    .map((href) => decodeURI(href.split("#")[0]))
    .filter((href) => href.length > 0);
}
