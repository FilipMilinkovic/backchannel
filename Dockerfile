# Backchannel hub. No npm dependencies: the image is Node plus the source.
FROM node:24-alpine

# su-exec drops from root to "node" after the entrypoint fixes volume ownership.
RUN apk add --no-cache su-exec

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    LOG_FORMAT=json

WORKDIR /app
COPY package.json hub.js cli.js client.js agent.js responder.js session.js service.js tools.js worktree.js launch.js backends.js safety.js mcp.js setup.js AGENT_INSTRUCTIONS.md LICENSE docker-entrypoint.sh ./
COPY bin ./bin
COPY hooks ./hooks
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown node:node /data && chmod +x docker-entrypoint.sh

# Mount persistent storage at /data (docker run -v, a Fly or Railway volume). No VOLUME line: Railway rejects it.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/readyz >/dev/null || exit 1

# Exec form all the way down: the hub receives SIGTERM directly and shuts down gracefully.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "hub.js"]
