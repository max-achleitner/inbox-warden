import { spawn } from "node:child_process";

/**
 * Command that opens a URL in the default browser without going through a shell, so characters
 * such as "&" in the query string are never interpreted ("cmd /c start" would split at "&").
 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/** Opens only https URLs. Resolves false when no browser could be started (the caller prints the URL anyway). */
export async function openBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (new URL(url).protocol !== "https:") return false;
  const { command, args } = browserCommand(url, platform);
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true, shell: false });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
