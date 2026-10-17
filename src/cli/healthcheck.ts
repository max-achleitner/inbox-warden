// Docker HEALTHCHECK helper: distroless images have no curl/wget.
const port = Number(process.env.IMAP_MCP_HTTP_PORT ?? "8787");

fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) })
  .then((res) => process.exit(res.status === 200 ? 0 : 1))
  .catch(() => process.exit(1));
