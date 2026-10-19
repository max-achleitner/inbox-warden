# ADR 0001 — Node.js runtime for the Claude Desktop extension

**Date:** pending · **Status:** Proposed — waiting for the manual spike (Plan 6, Task 6)

## Context

Claude Desktop runs MCPB bundles of `server.type: "node"` with a Node.js it ships itself. Its version
is not documented. `inbox-warden` and its dependencies (MCP SDK v2, imapflow 2, nodemailer 10)
require Node.js ≥ 20. The bundle starts through `server/preflight.cjs`, which refuses older runtimes
with a clear message, and the `server.starting` log line records `node`, `platform` and `arch`.

## How to run the spike

1. `npm run build && npm run build:mcpb` → `build/inbox-warden-<version>.mcpb`.
2. On Windows and on macOS: double-click the bundle, install, enter a **test** mailbox (email + password),
   leave every other field empty, enable the extension.
3. New chat: "Run the email health check and show me the raw JSON result." Note `server.nodeVersion`
   and `server.platform`.
4. Open the newest `mcp*inbox-warden*.log` (Windows `%APPDATA%\Claude\logs\`, macOS `~/Library/Logs/Claude/`)
   and note `node`, `platform`, `arch` from the `server.starting` line.
5. Ask "Search my inbox for the newest email." to confirm that empty optional fields do not break the configuration.
6. Note the Claude Desktop version (Help → About), fill in the table and pick one decision branch.

## Observed

| | Windows | macOS |
|---|---|---|
| Claude Desktop version | 2.42304 (Microsoft Store package); its `app\version` says Electron 44.7.2 and its own `main.log` reports `nodeVersion: '24.21.0'` (2026-10-18, before the bundle was installed) | |
| `server.nodeVersion` / `server.platform` from health_check | | |
| `node` / `platform` / `arch` from server.starting log | | |
| Search in a real mailbox works with empty optional fields | | |

## Decision

To be recorded after the spike — copy exactly one branch:

- **A — Node ≥ 20.19 on both platforms:** keep `engines.node` `>=20.19.0`, manifest `compatibility.runtimes.node` `>=20.19.0` and `REQUIRED_MAJOR = 20` / `REQUIRED_MINOR = 19` in `preflight.cjs`. Re-check this ADR when Claude Desktop changes major version.
- **B — Node 20.x below 20.19 on at least one platform:** set `engines.node` and `compatibility.runtimes.node` to `>=<lowest observed version>`, run `npx -y node@<lowest observed version> node_modules/vitest/vitest.mjs run` and keep the change only if the suite passes; otherwise treat as C.
- **C — Node < 20 on at least one platform:** do not publish the `.mcpb` for that platform. Ship a Node single-executable (`server.type: "binary"`) built per platform with `node --experimental-sea-config sea-config.json` and `npx postject`, written as a separate plan before 1.0.0. npm and plugin channels are unaffected.

## Consequences

The release workflow builds the bundle with the floor recorded here; `preflight.cjs` reports an older host runtime to the user instead of crashing. Until this ADR is accepted, the bundle assumes branch A.
