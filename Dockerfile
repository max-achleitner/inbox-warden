# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && mkdir -p /data

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
ENV NODE_ENV=production \
    IMAP_MCP_CONTAINER=1 \
    IMAP_MCP_HOME=/data \
    IMAP_MCP_HTTP_HOST=0.0.0.0 \
    IMAP_MCP_HTTP_PORT=8787
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build --chown=65532:65532 /data /data
USER 65532:65532
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/dist/cli/healthcheck.js"]
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/bin.js"]
CMD ["serve", "--http"]
