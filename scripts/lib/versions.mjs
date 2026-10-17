import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PLUGIN_MANIFEST = "plugin/.claude-plugin/plugin.json";

export function bundleUrl(name, version) {
  return `https://github.com/max-achleitner/inbox-warden/releases/download/v${version}/${name}-${version}.mcpb`;
}

function read(root, file) {
  return JSON.parse(readFileSync(join(root, file), "utf8"));
}

/** Everything that must carry package.json's version on every commit. */
export function versionProblems(root) {
  const pkg = read(root, "package.json");
  const plugin = read(root, PLUGIN_MANIFEST);
  const problems = [];
  if (plugin.version !== pkg.version) {
    problems.push(`${PLUGIN_MANIFEST} version is ${plugin.version}, expected ${pkg.version}`);
  }
  const expectedUrl = bundleUrl(pkg.name, pkg.version);
  if (plugin.mcpServers !== expectedUrl) {
    const shown = String(plugin.mcpServers).match(/\/v([^/]+)\//)?.[1] ?? String(plugin.mcpServers);
    problems.push(`${PLUGIN_MANIFEST} mcpServers points at ${shown}, expected ${expectedUrl}`);
  }
  return problems;
}

export function syncVersions(root) {
  const pkg = read(root, "package.json");
  const plugin = read(root, PLUGIN_MANIFEST);
  plugin.version = pkg.version;
  plugin.mcpServers = bundleUrl(pkg.name, pkg.version);
  writeFileSync(join(root, PLUGIN_MANIFEST), JSON.stringify(plugin, null, 2) + "\n");
}
