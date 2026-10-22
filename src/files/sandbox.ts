import { access, mkdir, realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Resolve a file the AI wants to attach. Relative paths are looked up in each allowed folder;
 * the real path (symlinks/junctions resolved) must stay inside one of them.
 */
export async function resolveInside(roots: string[], requested: string): Promise<string> {
  if (roots.length === 0) {
    throw new SandboxError(
      "Attaching local files is not enabled. Ask your administrator to add a folder to files.attachmentDirs in the configuration. Nothing was attached.",
    );
  }
  const realRoots: string[] = [];
  for (const root of roots) {
    try {
      realRoots.push(await realpath(expandHome(root)));
    } catch {
      // a configured folder that does not exist is simply skipped
    }
  }
  const expanded = expandHome(requested);
  const candidates = path.isAbsolute(expanded) ? [path.resolve(expanded)] : realRoots.map((root) => path.join(root, expanded));
  const textRoots = [...roots.map((root) => path.resolve(expandHome(root))), ...realRoots];
  const outside = () =>
    new SandboxError(`"${requested}" is outside the folders allowed for attachments (${roots.join(", ")}). Nothing was attached.`);
  for (const candidate of candidates) {
    // Touch the file system only for paths that lie inside an allowed folder by their text: on
    // Windows, merely resolving "\\host\share\x" logs in to that host with the user's credentials
    if (!textRoots.some((root) => isInside(root, candidate))) throw outside();
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      continue;
    }
    if (realRoots.some((root) => isInside(root, real))) return real;
    throw outside();
  }
  throw new SandboxError(`File "${requested}" was not found in the allowed attachment folders (${roots.join(", ")}). Nothing was attached.`);
}

/** A safe single path segment: no separators, control or reserved characters, no Windows device names. */
export function sanitizeFilename(input: string): string {
  let name = input.split(/[/\\]/).pop() ?? "";
  name = name
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_")
    .replace(/^[.\s]+/, "");
  let end = name.length;
  while (end > 0 && /[.\s]/.test(name[end - 1]!)) end--;
  name = name.slice(0, end);
  if (!name) name = "attachment";
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name.length > 180) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 180 - ext.length) + ext;
  }
  return name;
}

/** Path for a new file in the download folder; never overwrites (appends " (1)", " (2)", …). */
export async function resolveDownloadTarget(downloadDir: string | undefined, filename: string): Promise<string> {
  if (!downloadDir) {
    throw new SandboxError(
      "Saving attachments is not enabled. Ask your administrator to set files.downloadDir in the configuration. Nothing was saved.",
    );
  }
  const root = expandHome(downloadDir);
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const safe = sanitizeFilename(filename);
  const { name, ext } = path.parse(safe);
  for (let i = 0; i < 1000; i++) {
    const candidate = path.join(realRoot, i === 0 ? safe : `${name} (${i})${ext}`);
    try {
      await access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new SandboxError(`Could not find a free file name for "${safe}" in ${realRoot}. Nothing was saved.`);
}
