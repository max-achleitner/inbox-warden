// Pure helpers for building the Claude Desktop extension (.mcpb). No I/O here.

export function bundleFileName(name, version) {
  return `${name}-${version}.mcpb`;
}

/** Manifest tool entries are display-only: first sentence of the description, or the title. */
export function toolSummaries(tools) {
  return tools.map((tool) => {
    const description = (tool.description ?? "").trim();
    const firstSentence = description.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? description;
    return { name: tool.name, description: (firstSentence || tool.title || tool.name).slice(0, 200) };
  });
}

const USER_CONFIG_REF = /\$\{user_config\.([A-Za-z0-9_]+)\}/g;
const ENV_NAME = /^IMAP_MCP_[A-Z0-9_]+$/;

export function renderManifest(template, pkg, tools) {
  const manifest = structuredClone(template);
  if (manifest.name !== pkg.name) {
    throw new Error(`manifest name "${manifest.name}" differs from package name "${pkg.name}"`);
  }
  manifest.version = pkg.version;

  const declared = Object.keys(manifest.user_config ?? {});
  const referenced = new Set(
    [...JSON.stringify(manifest.server.mcp_config).matchAll(USER_CONFIG_REF)].map((match) => match[1]),
  );
  for (const key of referenced) {
    if (!declared.includes(key)) throw new Error(`mcp_config references undeclared user_config "${key}"`);
  }
  for (const key of declared) {
    if (!referenced.has(key)) throw new Error(`user_config "${key}" is declared but never passed to the server`);
    if (manifest.user_config[key].sensitive && manifest.user_config[key].default !== undefined) {
      throw new Error(`sensitive user_config "${key}" must not have a default`);
    }
  }
  for (const key of Object.keys(manifest.server.mcp_config.env ?? {})) {
    if (!ENV_NAME.test(key)) throw new Error(`unexpected environment variable "${key}" in manifest`);
  }

  if (tools.length === 0) throw new Error("the server reported no tools");
  const seen = new Set();
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`duplicate tool "${tool.name}"`);
    seen.add(tool.name);
  }
  manifest.tools = tools;
  return manifest;
}

/** One bundle serves macOS and Windows only while it contains no compiled (.node) modules. */
export function nativeBinaries(files) {
  return files.filter((file) => file.endsWith(".node"));
}
