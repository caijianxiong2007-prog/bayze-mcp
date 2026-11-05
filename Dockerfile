# Bayze MCP Server — multi-stage build for minimal image
# Usage: docker build -t bayze-mcp .
# Run:   docker run -i --rm bayze-mcp  (MCP stdio mode)
# Or:    docker run -p 3470:3470 -e BAYZE_SERVE_TOKEN=... bayze-mcp serve

# ── Stage 1: Build ──
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY tests/ ./tests/
RUN npm run build && npm test

# ── Stage 2: Runtime (minimal) ──
FROM node:22-alpine
LABEL org.opencontainers.image.title="bayze-mcp"
LABEL org.opencontainers.image.description="Local-first AI model-routing core with structured cross-vendor review"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/caijianxiong2007-prog/bayze-mcp"

# Security: run as non-root
RUN addgroup -S bayze && adduser -S bayze -G bayze
WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Copy examples for reference
COPY --from=builder /app/dist/src/cli.js ./dist/src/cli.js

# Switch to non-root user
USER bayze

# Default: MCP stdio mode (stdin/stdout JSON-RPC)
# Override with: docker run bayze-mcp serve --port 3470
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["mcp"]

# For serve mode, expose port (only used when CMD is overridden to "serve")
EXPOSE 3470

# Health check (for serve mode; stdio mode will just exit)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1
